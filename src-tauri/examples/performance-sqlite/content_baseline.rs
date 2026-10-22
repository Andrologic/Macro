//! Additional real repository cells. Fixtures, validation and resets are untimed.
use super::{assert_path, db, finish_case, repository, summary, Result};
use db::models::{CreateConversationInput, ImportMessageInput, Message};
use repository::UpdateMessageContentInput;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::collections::BTreeMap;
use std::time::Instant;

const ANSWER: &str = "Réponse synthétique é界🙂";
const PREFIX: &str = "chat:assistant-visible-provenance:v1:";
const COUNT: &str =
    "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND role IN ('user','assistant')";
const FIXTURE: &str =
    "content-v1:mixed-256;assistant-14-fields;receipt-v2;update-256+64*i;batch100;tail100;schema12";

#[derive(Default)]
struct Cell {
    boundary: &'static str,
    outcomes: Vec<Value>,
    times: Vec<f64>,
}
impl Cell {
    fn record(
        &mut self,
        name: &str,
        i: usize,
        warmup: usize,
        ms: f64,
        outcome: Value,
        boundary: &'static str,
    ) {
        self.boundary = boundary;
        if i >= warmup {
            eprintln!(
                "{}",
                json!({"content_baseline_raw":{"cell":name,"sample":i-warmup,"ms":ms,"outcome":outcome}})
            );
            self.times.push(ms);
            self.outcomes.push(outcome);
        }
    }
    fn value(self) -> Value {
        json!({"boundary":self.boundary,"summary":summary(self.times.clone()),
            "raw_ms":self.times,"outcomes":self.outcomes})
    }
}
fn keep(
    cells: &mut BTreeMap<&'static str, Cell>,
    name: &'static str,
    i: usize,
    warmup: usize,
    elapsed: f64,
    outcome: Value,
    boundary: &'static str,
) {
    cells
        .entry(name)
        .or_default()
        .record(name, i, warmup, elapsed, outcome, boundary);
}
fn serde_cell<T: Serialize>(
    cells: &mut BTreeMap<&'static str, Cell>,
    name: &'static str,
    value: &T,
    i: usize,
    warmup: usize,
) -> Result<()> {
    let start = Instant::now();
    let bytes = serde_json::to_vec(value)?;
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    cells.entry(name).or_default().record(
        name,
        i,
        warmup,
        elapsed,
        json!({"bytes":bytes.len()}),
        "serde_json::to_vec on preloaded real repository output; loading and destruction excluded",
    );
    std::hint::black_box(bytes);
    Ok(())
}
fn provider_state(content: &str) -> String {
    json!({"provider":"chatgpt","output_items":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":content}]}]}).to_string()
}
fn receipt(id: &str, content: &str) -> Result<String> {
    let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&(id, content))?));
    Ok(
        json!({"version":2,"source":"provider-output","fingerprint":fingerprint,
        "start":0,"end":content.encode_utf16().count()})
        .to_string(),
    )
}
fn batch(prefix: &str, n: usize, time: &str) -> Vec<ImportMessageInput> {
    (0..n)
        .map(|i| ImportMessageInput {
            id: format!("{prefix}-{i:06}"),
            turn_id: Some(prefix.into()),
            role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
            content: format!("{} é界🙂", "x".repeat(256)),
            created_at: time.into(),
            completion_reason: Some("completed".into()),
        })
        .collect()
}
fn expected_rows(conversation_id: &str, inputs: Vec<ImportMessageInput>) -> Vec<Message> {
    inputs
        .into_iter()
        .map(|m| Message {
            id: m.id,
            conversation_id: conversation_id.into(),
            turn_id: m.turn_id,
            role: m.role,
            content: m.content,
            created_at: m.created_at,
            completion_reason: m.completion_reason,
            token_count: None,
            tool_traces_json: None,
            hidden_context: None,
            provider_input_items_json: None,
            provider_turn_state_json: None,
            context_refs_json: None,
            generation_attempts_json: None,
        })
        .collect()
}
async fn count(pool: &SqlitePool, id: &str) -> Result<i64> {
    Ok(sqlx::query_scalar(COUNT).bind(id).fetch_one(pool).await?)
}
async fn metadata(
    pool: &SqlitePool,
) -> Result<Vec<db::conversation_management::ConversationMetadata>> {
    Ok(db::conversation_management::metadata(pool)
        .await
        .map_err(std::io::Error::other)?)
}
async fn validate(pool: &SqlitePool, id: &str, expected: &[Message]) -> Result<()> {
    let actual = repository::list_messages(pool, id).await?;
    if serde_json::to_value(&actual)? != serde_json::to_value(expected)? {
        return Err("Exact 14-field transcript mismatch".into());
    }
    let conversation = repository::get_conversation(pool, id)
        .await?
        .ok_or("Missing conversation")?;
    let latest = actual.last().ok_or("Empty baseline")?;
    let preview = if latest.content.chars().count() > 100 {
        format!(
            "{}...",
            latest.content.chars().take(100).collect::<String>()
        )
    } else {
        latest.content.clone()
    };
    if conversation.message_count as usize != expected.len()
        || conversation.last_message.as_deref() != Some(&preview)
        || conversation.updated_at != latest.created_at
    {
        return Err("Conversation metadata mismatch".into());
    }
    let fts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM message_search WHERE message_search MATCH 'syntheticbatchtoken'",
    )
    .fetch_one(pool)
    .await?;
    if fts != 0 {
        return Err("Deleted batch remains in FTS".into());
    }
    Ok(())
}
async fn check_runtime(pool: &SqlitePool, path: &std::path::Path) -> Result<Value> {
    assert_path(pool, path).await?;
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(pool)
            .await?;
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(pool)
        .await?;
    let sync: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(pool)
        .await?;
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(pool)
        .await?;
    if versions != [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] || journal != "wal" || sync != 1 || fk != 1
    {
        return Err("Content baseline requires exact schema12/WAL/NORMAL/FK runtime".into());
    }
    Ok(
        json!({"migrations":versions,"journal_mode":journal,"synchronous":sync,"foreign_keys":fk,
        "sqlite_version":sqlx::query_scalar::<_,String>("SELECT sqlite_version()").fetch_one(pool).await?}),
    )
}
async fn measure(
    pool: &SqlitePool,
    path: &std::path::Path,
    size: usize,
    warmup: usize,
    samples: usize,
) -> Result<Value> {
    let runtime = check_runtime(pool, path).await?;
    let conversation = repository::create_conversation(
        pool,
        CreateConversationInput {
            title: Some("Synthetic content baseline".into()),
            scope_mode: "Chat".into(),
            task_id: None,
            group_id: None,
            project_id: None,
            provider_id: None,
            model_id: None,
            reasoning_effort: None,
        },
    )
    .await?;
    let id = &conversation.id;
    repository::import_messages(pool, id, batch("seed", size, "2026-01-01T00:00:00Z")).await?;
    let assistant = "seed-000001";
    let state = provider_state(ANSWER);
    sqlx::query("UPDATE messages SET content=?,token_count=37,tool_traces_json='[]',hidden_context='synthetic-hidden',provider_input_items_json='[{\"synthetic\":\"input\"}]',provider_turn_state_json=?,context_refs_json='[{\"synthetic\":\"refs\"}]',generation_attempts_json='[{\"synthetic\":\"attempts\"}]' WHERE id=?")
        .bind(ANSWER).bind(&state).bind(assistant).execute(pool).await?;
    let key = format!("{PREFIX}{assistant}");
    let mut previous = receipt(assistant, ANSWER)?;
    if !repository::compare_and_swap_app_setting(pool, &key, None, &previous)
        .await?
        .applied
    {
        return Err("Receipt seed failed".into());
    }
    let mut golden = expected_rows(id, batch("seed", size, "2026-01-01T00:00:00Z"));
    let special = &mut golden[1];
    special.content = ANSWER.into();
    special.token_count = Some(37);
    special.tool_traces_json = Some("[]".into());
    special.hidden_context = Some("synthetic-hidden".into());
    special.provider_input_items_json = Some(r#"[{"synthetic":"input"}]"#.into());
    special.provider_turn_state_json = Some(state.clone());
    special.context_refs_json = Some(r#"[{"synthetic":"refs"}]"#.into());
    special.generation_attempts_json = Some(r#"[{"synthetic":"attempts"}]"#.into());
    validate(pool, id, &golden).await?;
    let index = golden
        .iter()
        .position(|m| m.id == assistant)
        .ok_or("Missing assistant")?;
    let single = repository::get_message(pool, assistant)
        .await?
        .ok_or("Missing assistant")?;
    if serde_json::to_value(&single)? != serde_json::to_value(&golden[index])? {
        return Err("Single golden mismatch".into());
    }
    let expected_bounded = repository::list_messages_bounded(pool, id).await;
    let admitted = match expected_bounded {
        Ok(ref rows) => {
            if serde_json::to_value(rows)? != serde_json::to_value(&golden)? {
                return Err("Bounded golden mismatch".into());
            }
            true
        }
        Err(db::DbError::Validation(ref code)) if code == "resource_limit" => false,
        Err(error) => return Err(error.into()),
    };
    if repository::get_message(pool, "missing").await?.is_some()
        || !repository::list_messages_bounded(pool, "missing")
            .await?
            .is_empty()
    {
        return Err("Missing checks failed".into());
    }
    let serde_rows = repository::list_messages(pool, id).await?;
    if serde_json::to_value(&serde_rows)? != serde_json::to_value(&golden)? {
        return Err("Preloaded serde output mismatch".into());
    }
    let mut cells = BTreeMap::new();
    for i in 0..warmup + samples {
        let start = Instant::now();
        let value = repository::get_message(pool, assistant).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        keep(
            &mut cells,
            "get_message",
            i,
            warmup,
            elapsed,
            json!({"rows":usize::from(value.is_some()),"outcome":"ok"}),
            "real get_message; transaction, admission, fetch and mapping; no serde",
        );
        if serde_json::to_value(&value)? != serde_json::to_value(Some(&golden[index]))? {
            return Err("Get changed".into());
        }
        let start = Instant::now();
        let rows = repository::list_messages_bounded(pool, id).await;
        // Rejection timing tests the explicit hypothesis that SQL admission scan scales with N.
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let outcome = match rows {
            Ok(ref rows) if admitted => {
                if serde_json::to_value(rows)? != serde_json::to_value(&golden)? {
                    return Err("Bounded changed".into());
                }
                json!({"outcome":"ok","rows":rows.len()})
            }
            Err(db::DbError::Validation(ref code)) if !admitted && code == "resource_limit" => {
                json!({"outcome":"resource_limit","rows_returned":0})
            }
            _ => return Err("Bounded outcome changed".into()),
        };
        cells.entry("list_messages_bounded").or_insert_with(Cell::default).record("list_messages_bounded",i,warmup,elapsed,outcome,"real bounded repository call; accepted and SQL resource_limit outcomes never pooled across fixture sizes");
        let start = Instant::now();
        let n = count(pool, id).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        keep(
            &mut cells,
            "count_exportable",
            i,
            warmup,
            elapsed,
            json!({"rows":n}),
            "SQL COUNT user/assistant, no content models",
        );
        if n != size as i64 {
            return Err("Count changed".into());
        }
        let start = Instant::now();
        let meta = metadata(pool).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        keep(&mut cells,"catalog_metadata",i,warmup,elapsed,json!({"conversations":meta.len()}),"actual conversation_management::metadata over entire one-conversation fixture, including JSON SQL scans");
        if meta.len() != 1
            || meta[0].conversation_id != *id
            || meta[0].archived
            || meta[0].pending_tool
            || meta[0].provider_failed
            || meta[0].question_message_id.is_some()
            || meta[0].preview_message_id.as_deref() != Some(golden[size - 2].id.as_str())
            || meta[0].response_revision != (size / 2 + 1) as i64
        {
            return Err("Metadata changed".into());
        }
        if let Ok(ref accepted) = rows {
            serde_cell(&mut cells, "serde_bounded_messages", accepted, i, warmup)?;
        }
        serde_cell(&mut cells, "serde_get_message", &value, i, warmup)?;
        serde_cell(&mut cells, "serde_all_messages", &serde_rows, i, warmup)?;
        serde_cell(&mut cells, "serde_catalog_metadata", &meta, i, warmup)?;
    }
    // Writes have separate series and deterministic states. Each commit includes production metadata/FTS.
    let anchor = golden.last().ok_or("Empty fixture")?.id.clone();
    for i in 0..warmup + samples {
        let content = format!("{ANSWER} {}", "x".repeat(256 + 64 * i));
        let next = receipt(assistant, &content)?;
        let update = UpdateMessageContentInput {
            id: assistant,
            turn_id: Some("stream".into()),
            content: &content,
            token_count: Some(37),
            tool_traces_json: Some("[]".into()),
            hidden_context: Some("synthetic-hidden".into()),
            provider_input_items_json: Some("[]".into()),
            provider_turn_state_json: Some(provider_state(&content)),
            context_refs_json: Some("[]".into()),
            completion_reason: Some("completed".into()),
            generation_attempts_json: Some("[]".into()),
        };
        let start = Instant::now();
        repository::update_message_content(pool, update).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        keep(&mut cells,"update_stream_commit",i,warmup,elapsed,json!({"start_rows":size,"end_rows":size,"content_bytes":content.len()}),"actual update_message_content; BEGIN IMMEDIATE, FTS, metadata and commit; input construction excluded");
        let expected = &mut golden[index];
        expected.content = content.clone();
        expected.turn_id = Some("stream".into());
        expected.provider_input_items_json = Some("[]".into());
        expected.provider_turn_state_json = Some(provider_state(&content));
        expected.context_refs_json = Some("[]".into());
        expected.generation_attempts_json = Some("[]".into());
        if serde_json::to_value(repository::get_message(pool, assistant).await?)?
            != serde_json::to_value(Some(&*expected))?
        {
            return Err("Update changed one of 14 fields".into());
        }
        let start = Instant::now();
        let cas =
            repository::compare_and_swap_app_setting(pool, &key, Some(&previous), &next).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        keep(&mut cells,"provenance_cas",i,warmup,elapsed,json!({"applied":cas.applied,"start_rows":size,"end_rows":size}),"actual provenance app_setting CAS including autocommit; fingerprint construction excluded");
        if !cas.applied
            || repository::get_app_setting(pool, &key)
                .await?
                .ok_or("Lost receipt")?
                .value_json
                != next
        {
            return Err("CAS mismatch".into());
        }
        previous = next;
        let mut inputs = batch("tail", 100, "2026-01-02T00:00:00Z");
        for m in &mut inputs {
            m.content = "syntheticbatchtoken".into();
        }
        let expected_tail = expected_rows(id, inputs.clone());
        let start = Instant::now();
        let inserted = repository::import_messages(pool, id, inputs).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        keep(
            &mut cells,
            "import100_commit",
            i,
            warmup,
            elapsed,
            json!({"start_rows":size,"end_rows":size+inserted.len(),"inserted":inserted.len()}),
            "actual import_messages batch100, metadata and commit; inputs/reset excluded",
        );
        if inserted.len() != 100 || count(pool, id).await? != size as i64 + 100 {
            return Err("Batch mismatch".into());
        }
        let mut expected_all = golden.clone();
        expected_all.extend(expected_tail);
        if serde_json::to_value(repository::list_messages(pool, id).await?)?
            != serde_json::to_value(expected_all)?
        {
            return Err("Imported fields mismatch".into());
        }
        let matches: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM message_search WHERE message_search MATCH 'syntheticbatchtoken'",
        )
        .fetch_one(pool)
        .await?;
        if matches != 100 {
            return Err("Imported FTS mismatch".into());
        }
        // Reset is untimed; use the same real deletion path that the deletion series measures.
        repository::delete_messages_after(pool, id, &anchor).await?;
        validate(pool, id, &golden).await?;
        repository::import_messages(pool, id, batch("tail", 100, "2026-01-02T00:00:00Z")).await?;
        let start = Instant::now();
        repository::delete_messages_after(pool, id, &anchor).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        keep(
            &mut cells,
            "delete100_commit",
            i,
            warmup,
            elapsed,
            json!({"start_rows":size+100,"end_rows":size,"deleted":100}),
            "actual delete_messages_after tail100, FTS, metadata and commit; preparation excluded",
        );
        validate(pool, id, &golden).await?;
    }
    validate(pool, id, &golden).await?;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await?;
    if integrity != "ok"
        || !sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(pool)
            .await?
            .is_empty()
    {
        return Err("Integrity failure".into());
    }
    pool.close().await;
    let reopened = db::create_pool(path).await?;
    let checks: Result<()> = async {
        check_runtime(&reopened, path).await?;
        validate(&reopened, id, &golden).await?;
        if repository::get_app_setting(&reopened, &key)
            .await?
            .ok_or("Receipt absent after reopen")?
            .value_json
            != previous
        {
            return Err("Receipt changed after reopen".into());
        }
        Ok(())
    }
    .await;
    reopened.close().await;
    checks?;
    Ok(
        json!({"initial_messages":size,"final_messages":size,"bounded_admitted":admitted,"runtime":runtime,
        "cells":cells.into_iter().map(|(key,value)|(key,value.value())).collect::<BTreeMap<_,_>>(),
        "checks":{"exact_14_fields":true,"missing":true,"writes_and_resets":true,"metadata_fts":true,"reopen":true,"integrity":true,"cleanup":true}}),
    )
}

async fn controls() -> Result<Value> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("controls.db");
    let pool = db::create_pool(&path).await?;
    let result:Result<Value>=async {
        let id="control-chat";
        sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES(?,'Synthetic controls','Chat','2026-01-01','2026-01-01')").bind(id).execute(&pool).await?;
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('large',?,'assistant','','2026-01-01')").bind(id).execute(&pool).await?;
        let receipt_key=format!("{PREFIX}large");
        let huge_receipt=json!({"synthetic":"x".repeat(4*1024*1024+1)}).to_string();
        if !repository::compare_and_swap_app_setting(&pool,&receipt_key,None,&huge_receipt).await?.applied {
            return Err("Large receipt seed failed".into());
        }
        // Legacy DTOs do not read receipts; do not claim a receipt bound for these operations.
        if repository::get_message(&pool,"large").await?.is_none() || repository::list_messages_bounded(&pool,id).await?.len()!=1 {
            return Err("Legacy DTO unexpectedly changed with receipt".into());
        }
        if repository::compare_and_swap_app_setting(&pool,&receipt_key,Some("wrong"),"{}").await?.applied {
            return Err("CAS conflict accepted".into());
        }
        if repository::get_app_setting(&pool,&receipt_key).await?.ok_or("Missing huge receipt")?.value_json!=huge_receipt {
            return Err("Huge receipt not preserved".into());
        }
        repository::delete_app_setting(&pool,&receipt_key).await?;
        for column in ["content","hidden_context","tool_traces_json","provider_input_items_json","provider_turn_state_json","context_refs_json","generation_attempts_json"] {
            let sql=format!("UPDATE messages SET {column}=? WHERE id='large'");
            sqlx::query(sqlx::AssertSqlSafe(sql.clone())).bind(json!({"synthetic":"x".repeat(4*1024*1024+1)}).to_string()).execute(&pool).await?;
            for refused in [repository::get_message(&pool,"large").await.map(|_|()),repository::list_messages_bounded(&pool,id).await.map(|_|())] {
                if !matches!(refused,Err(db::DbError::Validation(ref code)) if code=="resource_limit"){return Err(format!("Oversize {column} admitted").into());}
            }
            sqlx::query(sqlx::AssertSqlSafe(sql)).bind("").execute(&pool).await?;
        }
        // Reject before SELECT * is evaluated, not merely after allocating the returned fields.
        sqlx::query("UPDATE messages SET generation_attempts_json=? WHERE id='large'").bind(json!({"synthetic":"x".repeat(4*1024*1024+1)}).to_string()).execute(&pool).await?;
        sqlx::query("ALTER TABLE messages RENAME TO control_messages").execute(&pool).await?;
        sqlx::query("CREATE VIEW messages AS SELECT *,abs(-9223372036854775808) AS fetch_probe FROM control_messages").execute(&pool).await?;
        for refused in [repository::get_message(&pool,"large").await.map(|_|()),repository::list_messages_bounded(&pool,id).await.map(|_|())] {
            if !matches!(refused,Err(db::DbError::Validation(ref code)) if code=="resource_limit"){return Err("Fetch probe reached for oversize".into());}
        }
        sqlx::query("UPDATE control_messages SET generation_attempts_json=NULL WHERE id='large'").execute(&pool).await?;
        for error in [repository::get_message(&pool,"large").await.unwrap_err(),repository::list_messages_bounded(&pool,id).await.unwrap_err()] {
            if !matches!(error,db::DbError::Sqlx(ref source) if source.to_string().contains("integer overflow")){return Err("Fetch probe inactive".into());}
        }
        Ok(json!({"all_counted_large_fields_refused":true,"sql_rejection_before_fetch":true,"fetch_probe_negative_control":true,"legacy_receipt_not_projected":true,"cas_conflict_refused":true}))
    }.await;
    finish_case(pool, directory, result).await
}

pub(super) async fn run(pilot: bool) -> Result<Value> {
    let (warmup, samples) = if pilot { (1, 3) } else { (10, 100) };
    let receipt_golden: Value = serde_json::from_str(&receipt("seed-000001", ANSWER)?)?;
    if receipt_golden["fingerprint"]
        != "c9941461579d70fe06131806e5c2708fe5347a7f33d87fb601221d386c285e61"
        || receipt_golden["end"] != 24
    {
        return Err("Receipt differs from JS SHA256/UTF16 golden".into());
    }
    let contract_checks = super::contracts::run().await?;
    let admission_controls = controls().await?;
    let mut cases = Vec::new();
    for size in [100, 1000, 10000] {
        let directory = tempfile::Builder::new()
            .prefix("macro-content-baseline-")
            .tempdir()?;
        let path = directory.path().join("fixture.db");
        let pool = db::create_pool(&path).await?;
        eprintln!(
            "{}",
            json!({"content_baseline_case_start":{"size":size,"warmup":warmup,"samples":samples}})
        );
        let outcome = measure(&pool, &path, size, warmup, samples).await;
        if let Err(ref error) = outcome {
            eprintln!(
                "{}",
                json!({"content_baseline_case_failure":{"size":size,"error":error.to_string()}})
            );
        }
        cases.push(finish_case(pool, directory, outcome).await?);
    }
    Ok(
        json!({"schema":3,"mode":"content-baseline","pilot":pilot,"reference_eligible":!pilot,
        "warmup":warmup,"samples":samples,"percentile":"nearest-rank","raw_observation_order":"execution order, warmup excluded",
        "fixture_sha256":format!("{:x}",Sha256::digest([FIXTURE.as_bytes(),include_str!("content_baseline.rs").as_bytes()].concat())),"fixture":FIXTURE,
        "boundary":"real Rust repository/SQLx/on-disk SQLite; no IPC, transport, capture, app or provider",
        "omissions":["native windows not implemented","RSS/heap/allocation not measured","IPC/wire bytes not measured","A4 not exercised"],
        "refusal_hypothesis":"bounded SQL admission scan cost as N grows; expected resource_limit has its own outcome, no serde of absent result",
        "contract_checks":contract_checks,"admission_controls":admission_controls,"cases":cases}),
    )
}
