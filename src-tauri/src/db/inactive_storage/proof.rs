//! Synthetic, explicitly invoked experiment. Not a source capture or normalizer.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Write},
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
fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}
fn hash_file(path: &Path) -> String {
    let mut source = File::open(path).unwrap();
    let mut buffer = [0; 8192];
    let mut hash = Sha256::new();
    loop {
        let n = source.read(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    format!("{:x}", hash.finalize())
}
async fn put_record(source: &SqlitePool, ordinal: u64, kind: RecordKind, bytes: &[u8]) {
    let header = RecordHeader {
        ordinal,
        entry: kind,
        bytes: bytes.len() as u64,
        sha256: digest(bytes),
    };
    sqlx::query("INSERT INTO proof_records VALUES(?,?,?)")
        .bind(ordinal as i64)
        .bind(json(&header).unwrap())
        .bind(bytes.len() as i64)
        .execute(source)
        .await
        .unwrap();
    assert!(bytes.len() <= FRAGMENT_BYTES);
    sqlx::query("INSERT INTO proof_fragments VALUES(?,?,?)")
        .bind(ordinal as i64)
        .bind(0i64)
        .bind(bytes)
        .execute(source)
        .await
        .unwrap();
}
async fn source_index(source: &SqlitePool, path: &Path, count: usize) -> (u64, u64, usize) {
    sqlx::raw_sql("CREATE TABLE proof_records(ordinal INTEGER PRIMARY KEY,header TEXT CHECK(length(CAST(header AS BLOB))<=4096),bytes INTEGER); CREATE TABLE proof_fragments(ordinal INTEGER,offset INTEGER,data BLOB CHECK(length(data)<=4093),PRIMARY KEY(ordinal,offset));").execute(source).await.unwrap();
    let mut input = BufReader::with_capacity(8192, File::open(path).unwrap());
    let mut line = Vec::with_capacity(8193);
    let mut max_line = 0;
    let mut messages = 0;
    let mut active = None;
    let mut asset = Vec::new();
    loop {
        line.clear();
        let n = Read::by_ref(&mut input)
            .take(8193)
            .read_until(b'\n', &mut line)
            .unwrap();
        if n == 0 {
            break;
        }
        assert!(
            n <= 8192 && line.last() == Some(&b'\n'),
            "bounded fixture line required"
        );
        line.pop();
        max_line = max_line.max(line.len());
        let value: Value = serde_json::from_slice(&line).unwrap();
        match value["kind"].as_str().unwrap() {
            "dependencies" => {
                assert_eq!(messages, 0);
                assert!(active.is_none());
                put_record(
                    source,
                    0,
                    RecordKind::HistoricalText {
                        purpose: TextPurpose::Fact,
                    },
                    &line,
                )
                .await;
                asset = STANDARD
                    .decode(value["asset"]["data"].as_str().unwrap())
                    .unwrap();
                assert!(asset.len() <= FRAGMENT_BYTES);
                assert_eq!(digest(&asset), value["asset"]["sha256"]);
            }
            "message" => {
                assert!(active.is_none());
                assert_eq!(value["position"], messages);
                let meta = 3 * messages as u64 + 1;
                let ordinal = meta + 1;
                put_record(
                    source,
                    meta,
                    RecordKind::HistoricalText {
                        purpose: TextPurpose::SourceIdentity,
                    },
                    &line,
                )
                .await;
                put_record(
                    source,
                    ordinal + 1,
                    RecordKind::Association {
                        from: ordinal,
                        to: meta,
                        position: 0,
                        relation: Relation::DataForMessage,
                    },
                    &[],
                )
                .await;
                let role = match value["role"].as_str().unwrap() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    _ => panic!("fixture role"),
                };
                sqlx::query("INSERT INTO proof_records VALUES(?,NULL,0)")
                    .bind(ordinal as i64)
                    .execute(source)
                    .await
                    .unwrap();
                active = Some((
                    ordinal,
                    value["id"].as_str().unwrap().to_string(),
                    role,
                    0u64,
                    Sha256::new(),
                ));
            }
            "block" => {
                let (ordinal, id, _, offset, hash) = active.as_mut().unwrap();
                assert_eq!(value["id"], id.as_str());
                assert_eq!(value["offset"], *offset);
                let encoded = value["data"].as_str().unwrap();
                assert!(encoded.len() <= FRAGMENT_BYTES.div_ceil(3) * 4);
                let bytes = STANDARD.decode(encoded).unwrap();
                assert!(!bytes.is_empty() && bytes.len() <= FRAGMENT_BYTES);
                sqlx::query("INSERT INTO proof_fragments VALUES(?,?,?)")
                    .bind(*ordinal as i64)
                    .bind(*offset as i64)
                    .bind(&bytes)
                    .execute(source)
                    .await
                    .unwrap();
                hash.update(&bytes);
                *offset += bytes.len() as u64;
            }
            "end" => {
                let (ordinal, id, role, bytes, hash) = active.take().unwrap();
                let sha256 = format!("{:x}", hash.finalize());
                assert_eq!(value["id"], id);
                assert_eq!(value["bytes"], bytes);
                assert_eq!(value["sha256"], sha256);
                let header = RecordHeader {
                    ordinal,
                    entry: RecordKind::Message { role },
                    bytes,
                    sha256,
                };
                sqlx::query("UPDATE proof_records SET header=?,bytes=? WHERE ordinal=?")
                    .bind(json(&header).unwrap())
                    .bind(bytes as i64)
                    .bind(ordinal as i64)
                    .execute(source)
                    .await
                    .unwrap();
                messages += 1;
            }
            _ => panic!("fixture entry"),
        }
    }
    assert!(active.is_none());
    assert_eq!(messages, count);
    assert!(!asset.is_empty());
    let ordinal = 3 * count as u64 + 1;
    put_record(
        source,
        ordinal,
        RecordKind::Asset {
            mime: Mime::TextPlain,
        },
        &asset,
    )
    .await;
    put_record(
        source,
        ordinal + 1,
        RecordKind::Association {
            from: 2,
            to: ordinal,
            position: 0,
            relation: Relation::AssetForMessage,
        },
        &[],
    )
    .await;
    let (records, bytes): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*),SUM(bytes) FROM proof_records WHERE header IS NOT NULL")
            .fetch_one(source)
            .await
            .unwrap();
    assert_eq!(records, 3 * count as i64 + 3);
    (records as u64, bytes as u64, max_line)
}
async fn index_intent(source: &SqlitePool, records: u64, bytes: u64) -> Begin {
    let mut begin = Begin {
        version: 1,
        identity: identity(),
        bindings: bindings(),
        profile: Profile::SyntheticHistoryV1,
        records,
        bytes,
        manifest_sha256: "0".repeat(64),
    };
    let mut manifest = Manifest::new(&begin).unwrap();
    let mut ordinal = 0;
    while ordinal < records {
        let page:Vec<String>=sqlx::query_scalar("SELECT header FROM proof_records WHERE ordinal>=? AND length(CAST(header AS BLOB))<=4096 ORDER BY ordinal LIMIT 32").bind(ordinal as i64).fetch_all(source).await.unwrap();
        assert!(!page.is_empty());
        for header in page {
            let header: RecordHeader = parse(header.as_bytes()).unwrap();
            assert_eq!(header.ordinal, ordinal);
            manifest.record(&header).unwrap();
            ordinal += 1;
        }
    }
    begin.manifest_sha256 = manifest.finish();
    begin
}
struct Archive {
    file: Option<BufWriter<File>>,
    hash: Sha256,
    bytes: u64,
}
impl Write for Archive {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if let Some(file) = &mut self.file {
            file.write_all(bytes)?;
        }
        self.hash.update(bytes);
        self.bytes += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(file) = &mut self.file {
            file.flush()?;
        }
        Ok(())
    }
}
#[derive(Serialize)]
struct Block<'a> {
    kind: &'a str,
    id: &'a str,
    offset: u64,
    data: String,
}
// Independent fixture semantics, after storage sealing. The asset bytes come
// from its actual record, not from a redundant copy in historical metadata.
async fn read_dependencies(store: &InactiveStorage, key: &str, records: u64) -> Result<Value> {
    let first = store.readback(key, None, 1).await?;
    let dependency = first.fragments.first().ok_or("missing_dependencies")?;
    if dependency.record.ordinal != 0 || dependency.record.bytes != dependency.bytes.len() as u64 {
        return Err("missing_dependencies".into());
    }
    let mut value: Value =
        serde_json::from_slice(&dependency.bytes).map_err(|_| "invalid_dependencies")?;
    let asset_ordinal = records.checked_sub(2).ok_or("missing_asset")?;
    let tail = store
        .readback(
            key,
            Some(Cursor {
                ordinal: asset_ordinal - 1,
                offset: i64::MAX as u64,
            }),
            2,
        )
        .await?;
    let asset = tail.fragments.first().ok_or("missing_asset")?;
    let association = tail.fragments.get(1).ok_or("missing_asset")?;
    let first_message = store
        .readback(
            key,
            Some(Cursor {
                ordinal: 1,
                offset: i64::MAX as u64,
            }),
            1,
        )
        .await?;
    let message = first_message.fragments.first().ok_or("missing_asset")?;
    if asset.record.ordinal != asset_ordinal
        || !matches!(
            asset.record.entry,
            RecordKind::Asset {
                mime: Mime::TextPlain
            }
        )
        || asset.record.bytes != asset.bytes.len() as u64
        || digest(&asset.bytes) != asset.record.sha256
        || value["asset"]["sha256"] != digest(&asset.bytes)
        || !matches!(association.record.entry,RecordKind::Association{from:2,to,position:0,relation:Relation::AssetForMessage} if to==asset_ordinal)
        || message.record.ordinal != 2
        || !matches!(message.record.entry, RecordKind::Message { .. })
        || asset.target_uuid.is_none()
        || message.target_uuid.is_none()
        || asset.target_uuid == message.target_uuid
        || association.target_uuid.is_some()
    {
        return Err("missing_asset".into());
    }
    value["asset"]["data"] = Value::String(STANDARD.encode(&asset.bytes));
    Ok(value)
}
async fn read_archive(
    store: &InactiveStorage,
    key: &str,
    path: Option<&Path>,
) -> (String, u64, usize, usize, Value) {
    let authority = store.authorize().await.unwrap();
    let mut lease = store.lease().await.unwrap();
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let begin = store.load(&mut tx, key, &authority).await.unwrap().begin;
    tx.commit().await.unwrap();
    lease.committed = true;
    drop(lease);
    drop(authority);
    let dependencies = read_dependencies(store, key, begin.records).await.unwrap();
    let mut output = Archive {
        file: path.map(|p| BufWriter::with_capacity(32768, private_file(p))),
        hash: Sha256::new(),
        bytes: 0,
    };
    let mut cursor = None;
    let mut current_id = String::new();
    let mut max_page = 0;
    let mut fragments = 0;
    let mut read_capacity_total = 0u64;
    let mut max_read_capacity = 0;
    let mut base64_strings = 0;
    let mut base64_capacity_total = 0u64;
    let mut max_base64_capacity = 0;
    let mut record_hash = Sha256::new();
    let mut offset = 0u64;
    let mut expected_ordinal = 0;
    let mut total = 0;
    let mut pending = None;
    let mut manifest = Manifest::new(&begin).unwrap();
    serde_json::to_writer(&mut output, &dependencies).unwrap();
    writeln!(output).unwrap();
    loop {
        let page = store.readback(key, cursor, PAGE_FRAGMENTS).await.unwrap();
        max_page = max_page.max(
            page.fragments
                .iter()
                .map(|f| f.bytes.len() + json(&f.record).unwrap().len())
                .sum::<usize>(),
        );
        for fragment in page.fragments {
            fragments += 1;
            read_capacity_total += fragment.bytes.capacity() as u64;
            max_read_capacity = max_read_capacity.max(fragment.bytes.capacity());
            if fragment.offset == 0 {
                assert!(pending.is_none());
                assert_eq!(fragment.record.ordinal, expected_ordinal);
                pending = Some(fragment.record.clone());
                record_hash = Sha256::new();
                offset = 0;
            }
            assert_eq!(pending.as_ref(), Some(&fragment.record));
            assert_eq!(fragment.offset, offset);
            record_hash.update(&fragment.bytes);
            offset += fragment.bytes.len() as u64;
            total += fragment.bytes.len() as u64;
            if offset == fragment.record.bytes {
                assert_eq!(
                    format!("{:x}", record_hash.clone().finalize()),
                    fragment.record.sha256
                );
                manifest.record(&fragment.record).unwrap();
                expected_ordinal += 1;
                pending = None;
            }
            match fragment.record.entry {
                RecordKind::HistoricalText {
                    purpose: TextPurpose::Fact,
                } => {}
                RecordKind::HistoricalText {
                    purpose: TextPurpose::SourceIdentity,
                } => {
                    assert_eq!(fragment.offset, 0);
                    let metadata: Value = serde_json::from_slice(&fragment.bytes).unwrap();
                    current_id = metadata["id"].as_str().unwrap().into();
                    output.write_all(&fragment.bytes).unwrap();
                    writeln!(output).unwrap();
                }
                RecordKind::Message { .. } => {
                    let encoded = STANDARD.encode(&fragment.bytes);
                    base64_strings += 1;
                    base64_capacity_total += encoded.capacity() as u64;
                    max_base64_capacity = max_base64_capacity.max(encoded.capacity());
                    serde_json::to_writer(
                        &mut output,
                        &Block {
                            kind: "block",
                            id: &current_id,
                            offset: fragment.offset,
                            data: encoded,
                        },
                    )
                    .unwrap();
                    writeln!(output).unwrap();
                    if offset == fragment.record.bytes {
                        serde_json::to_writer(&mut output,&json!({"kind":"end","id":current_id,"bytes":offset,"sha256":fragment.record.sha256})).unwrap();
                        writeln!(output).unwrap();
                    }
                }
                RecordKind::Asset { .. } | RecordKind::Association { .. } => {}
                _ => panic!("fixture record kind"),
            }
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert!(pending.is_none());
    assert_eq!(expected_ordinal, begin.records);
    assert_eq!(total, begin.bytes);
    assert_eq!(manifest.finish(), begin.manifest_sha256);
    output.flush().unwrap();
    (
        format!("{:x}", output.hash.finalize()),
        output.bytes,
        max_page,
        fragments,
        json!({"returned_raw_vec_objects":fragments,"returned_raw_capacity_bytes_total":read_capacity_total,"max_single_raw_vec_capacity":max_read_capacity,"message_base64_strings":base64_strings,"message_base64_capacity_bytes_total":base64_capacity_total,"max_message_base64_capacity":max_base64_capacity,"full_record_materialized":false,"sqlx_sqlite_internal_copies_counted":false}),
    )
}

#[tokio::test]
#[ignore = "requires hashed fd6 archives in MACRO_PORTABLE_HISTORY_SOURCE_DIR and a private MACRO_INACTIVE_STORAGE_PROOF_DIR"]
async fn inactive_storage_portable_history_experiment() {
    let input = PathBuf::from(
        std::env::var_os("MACRO_PORTABLE_HISTORY_SOURCE_DIR").expect("fd6 fixture directory"),
    );
    let output = PathBuf::from(
        std::env::var_os("MACRO_INACTIVE_STORAGE_PROOF_DIR").expect("private output directory"),
    );
    let fixtures = [
        (
            300,
            "36499dddf85551db56f9b8d7b38e3372d4e1932642c9cd60d4605d5923811722",
        ),
        (
            600,
            "a9aae50ceee6eb7c9fe106f1c106402bc3255498a9c69078aec6faeeb737ab4d",
        ),
        (
            1200,
            "36aa3a618d511a6d01e0f5b103d93cd588589f101b35724aaa022173d94f7eaa",
        ),
    ];
    let mut measures = vec![];
    for (count, expected_hash) in fixtures {
        let archive = input.join(format!("archive-{count}.ndjson"));
        assert_eq!(hash_file(&archive), expected_hash);
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.db");
        let target_path = dir.path().join("target.db");
        let source = create_pool(&source_path).await.unwrap();
        let target = create_pool(&target_path).await.unwrap();
        let started = Instant::now();
        let (records, bytes, max_line) = source_index(&source, &archive, count).await;
        let fixture_ms = started.elapsed().as_millis();
        let begin = index_intent(&source, records, bytes).await;
        let store = active(target, Arc::new(AtomicI64::new(100)));
        let started = Instant::now();
        let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
        let mut appends = 0;
        let mut max_control = 0;
        let mut max_fragment = 0;
        let mut source_capacity_total = 0u64;
        let mut source_max_capacity = 0;
        let mut control_capacity_total = 0u64;
        let mut max_control_capacity = 0;
        let mut wal_sample_max = 0;
        for ordinal in 0..records {
            let header:String=sqlx::query_scalar("SELECT header FROM proof_records WHERE ordinal=? AND length(CAST(header AS BLOB))<=4096").bind(ordinal as i64).fetch_one(&source).await.unwrap();
            let record: RecordHeader = parse(header.as_bytes()).unwrap();
            let mut offset = 0;
            loop {
                let fragment:Vec<u8>=sqlx::query_scalar("SELECT data FROM proof_fragments WHERE ordinal=? AND offset=? AND length(data)<=4093").bind(ordinal as i64).bind(offset as i64).fetch_one(&source).await.unwrap();
                let control = json(&Append {
                    record: record.clone(),
                    offset,
                    sha256: digest(&fragment),
                })
                .unwrap();
                source_capacity_total += fragment.capacity() as u64;
                source_max_capacity = source_max_capacity.max(fragment.capacity());
                control_capacity_total += control.capacity() as u64;
                max_control_capacity = max_control_capacity.max(control.capacity());
                max_control = max_control.max(control.len());
                max_fragment = max_fragment.max(fragment.len());
                let ack = store
                    .append(&receipt.key, control.as_bytes(), &fragment)
                    .await
                    .unwrap();
                offset = ack.next_offset;
                appends += 1;
                if appends % 128 == 0 {
                    wal_sample_max =
                        wal_sample_max.max(file_bytes(&dir.path().join("target.db-wal")));
                }
                if offset == record.bytes {
                    break;
                }
            }
        }
        let receive_ms = started.elapsed().as_millis();
        let started = Instant::now();
        let sealed = store.seal_storage(&receipt.key).await.unwrap();
        let seal_ms = started.elapsed().as_millis();
        assert_charge(&store, &receipt.key).await;
        wal_sample_max = wal_sample_max.max(file_bytes(&dir.path().join("target.db-wal")));
        let target_db_bytes = file_bytes(&target_path);
        let target_wal_bytes = file_bytes(&dir.path().join("target.db-wal"));
        let retained_bytes = retained(&store).await;
        store.pool.close().await;
        drop(store);
        let reopened = create_pool(&target_path).await.unwrap();
        assert_eq!(
            InactiveStorage::closed(reopened.clone())
                .status(&receipt.key)
                .await
                .unwrap_err(),
            "inactive_storage_disabled"
        );
        let store = active(reopened, Arc::new(AtomicI64::new(100)));
        assert_eq!(store.status(&receipt.key).await.unwrap(), sealed.receipt);
        let readback = output.join(format!("archive-{count}.ndjson"));
        let started = Instant::now();
        let (hash, archive_bytes, max_readback_page_bytes, read_fragments, readback_buffers) =
            read_archive(
                &store,
                &receipt.key,
                if count == 300 { Some(&readback) } else { None },
            )
            .await;
        let readback_ms = started.elapsed().as_millis();
        assert_eq!(hash, expected_hash);
        assert_eq!(archive_bytes, file_bytes(&archive));
        if count == 300 {
            assert_eq!(hash_file(&readback), expected_hash);
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversation_content_versions")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            0
        );
        assert!(max_control <= CONTROL_BYTES && max_fragment <= FRAGMENT_BYTES);
        measures.push(json!({"messages":count,"records":records,"raw_owned_payload_bytes":bytes,"append_calls":appends,"source_fragment_vec_objects":appends,"source_fragment_capacity_bytes_total":source_capacity_total,"source_fragment_max_capacity":source_max_capacity,"append_control_strings":appends,"append_control_capacity_bytes_total":control_capacity_total,"max_append_control_capacity":max_control_capacity,"known_raw_boundary_value_bytes":2*bytes,"readback_buffers":readback_buffers,"readback_fragments":read_fragments,"max_fixture_line_bytes":max_line,"max_append_control_bytes":max_control,"max_fragment_bytes":max_fragment,"max_readback_page_payload_and_headers_bytes":max_readback_page_bytes,"logical_e_charge_bytes":sealed.receipt.charge_bytes,"logical_domain_retained_bytes":retained_bytes,"source_index_db_bytes":file_bytes(&source_path),"source_index_wal_bytes_at_end":file_bytes(&dir.path().join("source.db-wal")),"target_db_bytes_before_close":target_db_bytes,"target_wal_bytes_before_close":target_wal_bytes,"target_wal_max_sampled_every_128_appends":wal_sample_max,"archive_serialized_bytes":archive_bytes,"archive_sha256":hash,"readback_archive_retained":count==300,"fixture_index_ms":fixture_ms,"receive_ms":receive_ms,"seal_ms":seal_ms,"readback_ms":readback_ms}));
        if count == 300 {
            negative_dependencies(&store, &receipt.key, records, &output).await;
        }
    }
    serde_json::to_writer_pretty(
        private_file(&output.join("storage-measures.json")),
        &measures,
    )
    .unwrap();
    checkpoint_provenance(&input, &output).await;
}

async fn negative_dependencies(store: &InactiveStorage, key: &str, records: u64, output: &Path) {
    let original = store
        .readback(key, None, 1)
        .await
        .unwrap()
        .fragments
        .remove(0)
        .bytes;
    let changed = String::from_utf8(original.clone())
        .unwrap()
        .replace("alloy=ALPHA-47", "alloy=OMEGA-00")
        .into_bytes();
    assert_ne!(changed, original);
    // Deliberate SQL corruption in an ephemeral fixture, never an owner API.
    // Recompute only the fragment digest to reach the independent semantic
    // checker; the full manifest checker would also reject this changed record.
    sqlx::query("UPDATE e_inactive_fragments SET data=?,sha256=? WHERE ordinal=0")
        .bind(&changed)
        .bind(Sha256::digest(&changed).as_slice())
        .execute(&store.pool)
        .await
        .unwrap();
    let probe = read_dependencies(store, key, records).await.unwrap();
    serde_json::to_writer(
        private_file(&output.join("negative-fact-dependencies.json")),
        &probe,
    )
    .unwrap();
    sqlx::query("UPDATE e_inactive_fragments SET data=?,sha256=? WHERE ordinal=0")
        .bind(&original)
        .bind(Sha256::digest(&original).as_slice())
        .execute(&store.pool)
        .await
        .unwrap();
    let ordinal = (records - 2) as i64;
    let asset: Vec<u8> =
        sqlx::query_scalar("SELECT data FROM e_inactive_fragments WHERE ordinal=?")
            .bind(ordinal)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let mut corrupt = asset.clone();
    corrupt[0] ^= 1;
    sqlx::query("UPDATE e_inactive_fragments SET data=? WHERE ordinal=?")
        .bind(corrupt)
        .bind(ordinal)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        read_dependencies(store, key, records).await.unwrap_err(),
        "integrity_failed"
    );
    sqlx::query("UPDATE e_inactive_fragments SET data=? WHERE ordinal=?")
        .bind(asset)
        .bind(ordinal)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM e_inactive_records WHERE ordinal=?")
        .bind(ordinal)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        read_dependencies(store, key, records).await.unwrap_err(),
        "missing_asset"
    );
    serde_json::to_writer_pretty(private_file(&output.join("storage-negative-controls.json")),&json!({"fact_mutation_read_from_target":true,"fact_semantic_check":"Bun dependency validator must reject negative-fact-dependencies.json","corrupt_asset_refused":true,"removed_asset_refused":true,"asset_association_and_target_uuids_checked":true,"fault_injection":"direct SQL on discarded synthetic target only"})).unwrap();
}

async fn checkpoint_provenance(input: &Path, output: &Path) {
    let source = input.join("checkpoint-proof.json");
    let expected = "cdc3ce0a2682eb193d9ba74c40a3214abb92a174279300e0eaba4d428b42f338";
    assert_eq!(hash_file(&source), expected);
    let (_dir, store, _clock) = fixture().await;
    let bytes = file_bytes(&source);
    let header = RecordHeader {
        ordinal: 0,
        entry: RecordKind::HistoricalText {
            purpose: TextPurpose::Summary,
        },
        bytes,
        sha256: expected.into(),
    };
    let mut begin = Begin {
        version: 1,
        identity: identity(),
        bindings: bindings(),
        profile: Profile::SyntheticHistoryV1,
        records: 1,
        bytes,
        manifest_sha256: "0".repeat(64),
    };
    let mut manifest = Manifest::new(&begin).unwrap();
    manifest.record(&header).unwrap();
    begin.manifest_sha256 = manifest.finish();
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let mut source = File::open(source).unwrap();
    let mut buffer = [0; FRAGMENT_BYTES];
    let mut offset = 0;
    loop {
        let n = source.read(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        store
            .append(
                &receipt.key,
                json(&Append {
                    record: header.clone(),
                    offset,
                    sha256: digest(&buffer[..n]),
                })
                .unwrap()
                .as_bytes(),
                &buffer[..n],
            )
            .await
            .unwrap();
        offset += n as u64;
    }
    store.seal_storage(&receipt.key).await.unwrap();
    let path = output.join("stored-checkpoint-provenance.json");
    let mut file = private_file(&path);
    let mut cursor = None;
    loop {
        let page = store
            .readback(&receipt.key, cursor, PAGE_FRAGMENTS)
            .await
            .unwrap();
        for fragment in page.fragments {
            assert!(matches!(
                fragment.record.entry,
                RecordKind::HistoricalText {
                    purpose: TextPurpose::Summary
                }
            ));
            file.write_all(&fragment.bytes).unwrap();
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    file.flush().unwrap();
    assert_eq!(hash_file(&path), expected);
}

#[tokio::test]
#[ignore = "explicit large-field experiment; requires private MACRO_INACTIVE_STORAGE_PROOF_DIR"]
async fn inactive_storage_single_field_above_four_mib() {
    let output = PathBuf::from(
        std::env::var_os("MACRO_INACTIVE_STORAGE_PROOF_DIR").expect("private output directory"),
    );
    let dir = TempDir::new().unwrap();
    let source = create_pool(&dir.path().join("source.db")).await.unwrap();
    let target = create_pool(&dir.path().join("target.db")).await.unwrap();
    sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('large','Synthetic','now','now')").execute(&source).await.unwrap();
    // Fixture generation is outside extraction measurements. No long field is
    // selected as a Rust string before segmentation or during target readback.
    let seed = "é🙂".repeat(800_000);
    let bytes = seed.len();
    let sha256 = digest(seed.as_bytes());
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('large-message','large','user',?,'now')").bind(&seed).execute(&source).await.unwrap();
    drop(seed);
    assert!(bytes > 4 * 1024 * 1024);
    let version = crate::db::conversation_content::conversation_content_version(&source, "large")
        .await
        .unwrap();
    let token = (version.incarnation, version.revision.parse().unwrap());
    let header = RecordHeader {
        ordinal: 0,
        entry: RecordKind::Message { role: Role::User },
        bytes: bytes as u64,
        sha256: sha256.clone(),
    };
    let mut begin = Begin {
        version: 1,
        identity: identity(),
        bindings: bindings(),
        profile: Profile::SyntheticHistoryV1,
        records: 1,
        bytes: bytes as u64,
        manifest_sha256: "0".repeat(64),
    };
    let mut manifest = Manifest::new(&begin).unwrap();
    manifest.record(&header).unwrap();
    begin.manifest_sha256 = manifest.finish();
    let store = active(target, Arc::new(AtomicI64::new(100)));
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let started = Instant::now();
    let mut offset = 0;
    let mut reads = 0;
    let mut max_read = 0;
    while offset < bytes {
        let (total, fragment) = crate::db::portable_history_proof::segment(
            &source,
            "large-message",
            &token,
            offset as i64,
        )
        .await
        .unwrap();
        assert_eq!(total, bytes as i64);
        max_read = max_read.max(fragment.len());
        store
            .append(
                &receipt.key,
                json(&Append {
                    record: header.clone(),
                    offset: offset as u64,
                    sha256: digest(&fragment),
                })
                .unwrap()
                .as_bytes(),
                &fragment,
            )
            .await
            .unwrap();
        offset += fragment.len();
        reads += 1;
    }
    let sealed = store.seal_storage(&receipt.key).await.unwrap();
    let mut hash = Sha256::new();
    let mut cursor = None;
    let mut recovered = 0;
    loop {
        let page = store
            .readback(&receipt.key, cursor, PAGE_FRAGMENTS)
            .await
            .unwrap();
        for fragment in page.fragments {
            hash.update(&fragment.bytes);
            recovered += fragment.bytes.len();
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(recovered, bytes);
    assert_eq!(format!("{:x}", hash.finalize()), sha256);
    assert!(max_read <= FRAGMENT_BYTES);
    serde_json::to_writer_pretty(private_file(&output.join("storage-large-field.json")),&json!({"raw_payload_bytes":bytes,"native_incremental_blob_reads":reads,"max_native_read_bytes":max_read,"logical_e_charge_bytes":sealed.receipt.charge_bytes,"elapsed_ms":started.elapsed().as_millis(),"source_fixture_seed_materialized_only_before_measurement":true,"global_heap_rss_claim":false})).unwrap();
}
