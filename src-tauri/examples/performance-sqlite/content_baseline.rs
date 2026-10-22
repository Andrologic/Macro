//! Additional real repository cells. Fixtures, validation and resets are untimed.
use super::{assert_path, db, finish_case, repository, summary, Result};
use db::models::{
    ConversationContentAnchor, ConversationContentMetadataInput, ConversationContentMetadataPage,
    ConversationContentToken, ConversationContentWindow, ConversationContentWindowInput,
    CreateConversationInput, ImportMessageInput, Message,
};
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
    "content-v3-native:mixed-256;assistant-14-fields;receipt-v2;update-latest-marker-256+64*i;batch100;tail100;schema13;metadata100;after50;window50";

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
    Ok(())
}
async fn row_count(pool: &SqlitePool, id: &str) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE conversation_id=?")
            .bind(id)
            .fetch_one(pool)
            .await?,
    )
}
async fn expect_count(pool: &SqlitePool, id: &str, expected: i64) -> Result<i64> {
    let actual = row_count(pool, id).await?;
    if actual != expected {
        return Err(format!("Observed row count {actual}, expected {expected}").into());
    }
    Ok(actual)
}
async fn assert_fts(pool: &SqlitePool, term: &str, expected: &[String]) -> Result<()> {
    let actual:Vec<Option<String>>=sqlx::query_scalar("SELECT m.id FROM message_search LEFT JOIN messages m ON m.rowid=message_search.rowid WHERE message_search MATCH ? ORDER BY m.id")
        .bind(term).fetch_all(pool).await?;
    let expected: Vec<_> = expected.iter().cloned().map(Some).collect();
    if actual != expected {
        return Err(format!("FTS mismatch for {term}, including orphan index entries").into());
    }
    Ok(())
}
fn marked_tail(marker: &str) -> Vec<ImportMessageInput> {
    let mut inputs = batch("tail", 100, "2026-01-02T00:00:00Z");
    for m in &mut inputs {
        m.content = marker.into();
    }
    inputs
}

// Expected projections use fixture inputs and independent legacy/SQL observations,
// never a second call to the native port under measurement.
struct NativeExpected {
    token: ConversationContentToken,
    opening: Value,
    descriptors: Vec<Value>,
    window_items: Vec<Value>,
    open: ConversationContentMetadataInput,
    after: ConversationContentMetadataInput,
    window: ConversationContentWindowInput,
}
impl NativeExpected {
    async fn new(pool: &SqlitePool, id: &str, rows: &[Message], receipt: &str) -> Result<Self> {
        let (incarnation, revision): (String, i64) = sqlx::query_as(
            "SELECT incarnation, revision FROM conversation_content_versions WHERE conversation_id=?",
        ).bind(id).fetch_one(pool).await?;
        let token = ConversationContentToken {
            version: 1,
            incarnation,
            revision: revision.to_string(),
        };
        let conversation = repository::get_conversation(pool, id)
            .await?
            .ok_or("Missing native conversation")?;
        let metadata = metadata(pool)
            .await?
            .into_iter()
            .find(|m| m.conversation_id == id)
            .ok_or("Missing native metadata")?;
        if metadata.archived
            || metadata.pending_tool
            || metadata.provider_failed
            || metadata.question_message_id.is_some()
            || metadata.read_revision != 0
            || metadata.response_revision <= 0
            || metadata.preview_message_id.as_deref()
                != rows
                    .iter()
                    .rev()
                    .find(|m| m.role == "user")
                    .map(|m| m.id.as_str())
        {
            return Err("Native opening metadata state mismatch".into());
        }
        let opening = json!({"total_raw":rows.len().to_string(),"total_exportable":rows.len().to_string(),
            "conversation":conversation,"metadata":{"conversation_id":id,"revision":metadata.revision.to_string(),
            "response_revision":metadata.response_revision.to_string(),"read_revision":metadata.read_revision.to_string(),
            "archived":metadata.archived,"pending_tool":metadata.pending_tool,"provider_failed":metadata.provider_failed,
            "question_message_id":metadata.question_message_id,"preview_message_id":metadata.preview_message_id}});
        let descriptors = rows
            .iter()
            .map(
                |m| json!({"id":m.id,"conversation_id":id,"role":m.role,"created_at":m.created_at}),
            )
            .collect();
        let tail = &rows[rows.len() - 50..];
        let ids: Vec<_> = tail.iter().map(|m| m.id.clone()).collect();
        let revisions: BTreeMap<String,i64> = sqlx::query_as::<_,(String,i64)>(
            "SELECT message_id,revision FROM conversation_response_versions WHERE conversation_id=? AND message_id IN (SELECT value FROM json_each(?))",
        ).bind(id).bind(serde_json::to_string(&ids)?).fetch_all(pool).await?.into_iter().collect();
        for row in tail {
            if (row.role == "assistant" && !revisions.get(&row.id).is_some_and(|n| *n > 0))
                || (row.role == "user" && revisions.contains_key(&row.id))
            {
                return Err("Native expected response revision missing or unexpected".into());
            }
        }
        let receipt_id = rows
            .iter()
            .rev()
            .find(|m| m.id.starts_with("seed-"))
            .ok_or("Missing seed receipt owner")?
            .id
            .as_str();
        let window_items = tail.iter().map(|m| json!({"id":m.id,"conversation_id":id,"role":m.role,
            "content":m.content,"created_at":m.created_at,"completion_reason":m.completion_reason,
            "provider_turn_state_json":m.provider_turn_state_json,"tool_traces_json":m.tool_traces_json,
            "provenance_json":if m.id == receipt_id {Some(receipt)} else {None},
            "response_revision_decimal":revisions.get(&m.id).map(|n|n.to_string())})).collect();
        Ok(Self {
            open: ConversationContentMetadataInput {
                conversation_id: id.into(),
                expected_token: None,
                after: None,
                limit: 100,
            },
            after: ConversationContentMetadataInput {
                conversation_id: id.into(),
                expected_token: Some(token.clone()),
                after: Some(ConversationContentAnchor {
                    created_at: rows[49].created_at.clone(),
                    id: rows[49].id.clone(),
                }),
                limit: 100,
            },
            window: ConversationContentWindowInput {
                conversation_id: id.into(),
                expected_token: token.clone(),
                ids,
            },
            token,
            opening,
            descriptors,
            window_items,
        })
    }
    fn metadata(&self, page: &ConversationContentMetadataPage, offset: usize) -> Result<usize> {
        let end = (offset + 100).min(self.descriptors.len());
        let next = (end < self.descriptors.len()).then(|| json!({"id":self.descriptors[end-1]["id"],"created_at":self.descriptors[end-1]["created_at"]}));
        if page.token != self.token
            || serde_json::to_value(&page.items)? != json!(self.descriptors[offset..end])
            || serde_json::to_value(&page.next_after)? != json!(next)
            || serde_json::to_value(&page.opening)?
                != if offset == 0 {
                    self.opening.clone()
                } else {
                    Value::Null
                }
        {
            return Err("Native metadata fields/positions/token changed".into());
        }
        admitted_bytes(page, page.admission_estimate_bytes)
    }
    fn window(&self, window: &ConversationContentWindow) -> Result<usize> {
        if window.token != self.token
            || window.consumed_count != 50
            || serde_json::to_value(&window.items)? != json!(self.window_items)
        {
            return Err("Native window fields/positions/receipt/revision changed".into());
        }
        admitted_bytes(window, window.admission_estimate_bytes)
    }
}
fn admitted_bytes(value: &impl Serialize, estimate: u64) -> Result<usize> {
    let bytes = serde_json::to_vec(value)?.len();
    if estimate > 4_194_304 || bytes as u64 > estimate {
        return Err("Native admission estimate violated".into());
    }
    Ok(bytes)
}
async fn native_reads(
    pool: &SqlitePool,
    expected: &NativeExpected,
    cells: &mut BTreeMap<&'static str, Cell>,
    i: usize,
    warmup: usize,
) -> Result<()> {
    let start = Instant::now();
    let token =
        repository::conversation_content_version(pool, &expected.open.conversation_id).await?;
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    if token != expected.token {
        return Err("Native version changed".into());
    }
    keep(
        cells,
        "native_version",
        i,
        warmup,
        elapsed,
        json!({"outcome":"ok","token":token}),
        "actual conversation_content_version; SQLx transaction and commit; no serde or capture",
    );
    for (name, input, offset) in [
        ("native_metadata_open100", &expected.open, 0),
        ("native_metadata_after50", &expected.after, 50),
    ] {
        let start = Instant::now();
        let page = repository::conversation_content_metadata(pool, input).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let bytes = expected.metadata(&page, offset)?;
        keep(cells,name,i,warmup,elapsed,json!({"outcome":"ok","rows":page.items.len(),"offset":offset,"opening":page.opening.is_some(),"has_more":page.next_after.is_some(),"serialized_bytes":bytes,"admission_estimate_bytes":page.admission_estimate_bytes}),"actual conversation_content_metadata page; admission, opening when requested, descriptor fetch, mapping and commit; no serde or capture");
    }
    let start = Instant::now();
    let window = repository::conversation_content_window(pool, &expected.window).await?;
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    let bytes = expected.window(&window)?;
    keep(cells,"native_window50",i,warmup,elapsed,json!({"outcome":"ok","rows":window.items.len(),"consumed_count":window.consumed_count,"start_position":expected.descriptors.len()-50,"serialized_bytes":bytes,"admission_estimate_bytes":window.admission_estimate_bytes}),"actual conversation_content_window for final 50 IDs; admission, joined bodies/receipts/revisions, SQLx mapping and commit; no serde or capture");
    Ok(())
}
async fn validate_native(
    pool: &SqlitePool,
    id: &str,
    rows: &[Message],
    receipt: &str,
    previous: Option<&ConversationContentToken>,
) -> Result<ConversationContentToken> {
    let expected = NativeExpected::new(pool, id, rows, receipt).await?;
    if let Some(old) = previous {
        if old.incarnation != expected.token.incarnation
            || old.revision.parse::<i64>()? >= expected.token.revision.parse::<i64>()?
        {
            return Err("Native mutation did not advance the content token".into());
        }
    }
    // These calls validate each committed state before reset; their observations are not retained.
    native_reads(pool, &expected, &mut BTreeMap::new(), 0, 1).await?;
    Ok(expected.token)
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
    if versions != [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
        || journal != "wal"
        || sync != 1
        || fk != 1
    {
        return Err("Content baseline requires exact schema13/WAL/NORMAL/FK runtime".into());
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
    let assistant_id = format!("seed-{:06}", size - 1);
    let assistant = assistant_id.as_str();
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
    // Raw fixture seeding changed the latest content. Establish its metadata before timing.
    sqlx::query("UPDATE conversations SET last_message=? WHERE id=?")
        .bind(ANSWER)
        .bind(id)
        .execute(pool)
        .await?;
    let receipt_golden = repository::get_app_setting(pool, &key)
        .await?
        .ok_or("Missing seeded receipt")?;
    let mut golden = expected_rows(id, batch("seed", size, "2026-01-01T00:00:00Z"));
    let special = &mut golden[size - 1];
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
    let native_expected = NativeExpected::new(pool, id, &golden, &previous).await?;
    let mut native_token = validate_native(pool, id, &golden, &previous, None).await?;
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
        let raw_receipt = repository::get_app_setting(pool, &key).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        keep(
            &mut cells,
            "provenance_get",
            i,
            warmup,
            elapsed,
            json!({"rows":usize::from(raw_receipt.is_some()),"outcome":"ok"}),
            "actual get_app_setting receipt row; SQLx fetch/mapping, no parse, validation or serde",
        );
        if serde_json::to_value(&raw_receipt)? != serde_json::to_value(Some(&receipt_golden))? {
            return Err("Raw receipt output changed".into());
        }
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
        native_reads(pool, &native_expected, &mut cells, i, warmup).await?;
    }
    // Writes have separate series and deterministic states. Each commit includes production metadata/FTS.
    let anchor = golden.last().ok_or("Empty fixture")?.id.clone();
    let mut previous_stream_marker: Option<String> = None;
    for i in 0..warmup + samples {
        let stream_marker = format!("syntheticstream{i}");
        let content = format!("{ANSWER} {stream_marker} {}", "x".repeat(256 + 64 * i));
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
        let start_rows = expect_count(pool, id, size as i64).await?;
        let start = Instant::now();
        repository::update_message_content(pool, update).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let end_rows = expect_count(pool, id, size as i64).await?;
        keep(&mut cells,"update_stream_commit",i,warmup,elapsed,json!({"start_rows":start_rows,"end_rows":end_rows,"content_bytes":content.len()}),"actual update_message_content; BEGIN IMMEDIATE, FTS, metadata and commit; input construction excluded");
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
        validate(pool, id, &golden).await?;
        native_token = validate_native(pool, id, &golden, &previous, Some(&native_token)).await?;
        assert_fts(pool, &stream_marker, &[assistant.to_owned()]).await?;
        if let Some(ref marker) = previous_stream_marker {
            assert_fts(pool, marker, &[]).await?;
        }
        previous_stream_marker = Some(stream_marker);
        let start_rows = expect_count(pool, id, size as i64).await?;
        let start = Instant::now();
        let cas =
            repository::compare_and_swap_app_setting(pool, &key, Some(&previous), &next).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let end_rows = expect_count(pool, id, size as i64).await?;
        keep(&mut cells,"provenance_cas",i,warmup,elapsed,json!({"applied":cas.applied,"start_rows":start_rows,"end_rows":end_rows}),"actual provenance app_setting CAS including autocommit; fingerprint construction excluded");
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
        native_token = validate_native(pool, id, &golden, &previous, Some(&native_token)).await?;
        let inputs = marked_tail("syntheticbatchtoken");
        let expected_tail = expected_rows(id, inputs.clone());
        let start_rows = expect_count(pool, id, size as i64).await?;
        let start = Instant::now();
        let inserted = repository::import_messages(pool, id, inputs).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let end_rows = expect_count(pool, id, size as i64 + 100).await?;
        keep(&mut cells,"import100_commit",i,warmup,elapsed,json!({"start_rows":start_rows,"end_rows":end_rows,"inserted":inserted.len()}),"actual import_messages batch100, metadata and commit; inputs/reset/counts/checks excluded");
        if serde_json::to_value(&inserted)? != serde_json::to_value(&expected_tail)? {
            return Err("Import output mismatch".into());
        }
        let tail_ids: Vec<_> = expected_tail.iter().map(|m| m.id.clone()).collect();
        let mut expected_all = golden.clone();
        expected_all.extend(expected_tail);
        validate(pool, id, &expected_all).await?;
        assert_fts(pool, "syntheticbatchtoken", &tail_ids).await?;
        native_token =
            validate_native(pool, id, &expected_all, &previous, Some(&native_token)).await?;
        // This reset cannot mask the checks above: it runs only after they pass.
        repository::delete_messages_after(pool, id, &anchor).await?;
        validate(pool, id, &golden).await?;
        assert_fts(pool, "syntheticbatchtoken", &[]).await?;
        native_token = validate_native(pool, id, &golden, &previous, Some(&native_token)).await?;
        let inputs = marked_tail("syntheticdeletetoken");
        let expected_tail = expected_rows(id, inputs.clone());
        let prepared = repository::import_messages(pool, id, inputs).await?;
        if serde_json::to_value(prepared)? != serde_json::to_value(&expected_tail)? {
            return Err("Delete preparation mismatch".into());
        }
        let mut expected_all = golden.clone();
        expected_all.extend(expected_tail);
        validate(pool, id, &expected_all).await?;
        assert_fts(pool, "syntheticdeletetoken", &tail_ids).await?;
        native_token =
            validate_native(pool, id, &expected_all, &previous, Some(&native_token)).await?;
        let start_rows = expect_count(pool, id, size as i64 + 100).await?;
        let start = Instant::now();
        repository::delete_messages_after(pool, id, &anchor).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let end_rows = expect_count(pool, id, size as i64).await?;
        keep(&mut cells,"delete100_commit",i,warmup,elapsed,json!({"start_rows":start_rows,"end_rows":end_rows,"deleted":start_rows-end_rows}),"actual delete_messages_after tail100, FTS, metadata and commit; preparation/counts/checks excluded");
        validate(pool, id, &golden).await?;
        assert_fts(pool, "syntheticdeletetoken", &[]).await?;
        native_token = validate_native(pool, id, &golden, &previous, Some(&native_token)).await?;
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
        if validate_native(&reopened, id, &golden, &previous, None).await? != native_token {
            return Err("Native token changed after reopen".into());
        }
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
        "checks":{"exact_14_fields":true,"missing":true,"writes_and_resets":true,"metadata_fts":true,"reopen":true,"integrity":true,"cleanup":true,
        "native_fields_positions_tokens":true,"native_mutations_before_reset":true,"native_admission_bytes":true,"native_reopen":true}}),
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
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('small',?,'user','short','2026-01-01')").bind(id).execute(&pool).await?;
        let token=repository::conversation_content_version(&pool,id).await?;
        let input=ConversationContentWindowInput {conversation_id:id.into(),expected_token:token.clone(),ids:vec!["large".into()]};
        if !matches!(repository::conversation_content_window(&pool,&input).await,Err(db::DbError::Validation(ref code)) if code=="resource_limit") {
            return Err("Native oversized receipt admitted".into());
        }
        let mut prefix=input.clone();prefix.ids=vec!["small".into(),"large".into()];
        let page=repository::conversation_content_window(&pool,&prefix).await?;
        if page.token!=token || page.consumed_count!=1 || page.items.len()!=1 || page.items[0].id!="small" || page.items[0].content!="short" {
            return Err("Native admitted prefix changed".into());
        }
        admitted_bytes(&page,page.admission_estimate_bytes)?;
        let mut missing=input.clone();missing.ids.push("missing".into());
        if !matches!(repository::conversation_content_window(&pool,&missing).await,Err(db::DbError::Validation(ref code)) if code=="validation_failed") {
            return Err("Native invalid suffix accepted".into());
        }
        if repository::compare_and_swap_app_setting(&pool,&receipt_key,Some("wrong"),"{}").await?.applied {
            return Err("CAS conflict accepted".into());
        }
        if repository::get_app_setting(&pool,&receipt_key).await?.ok_or("Missing huge receipt")?.value_json!=huge_receipt {
            return Err("Huge receipt not preserved".into());
        }
        repository::delete_app_setting(&pool,&receipt_key).await?;
        if !matches!(repository::conversation_content_window(&pool,&input).await,Err(db::DbError::Validation(ref code)) if code=="stale_revision") {
            return Err("Native stale receipt token accepted".into());
        }
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
        Ok(json!({"seven_payload_fields_refused":true,"sql_rejection_before_fetch":true,"fetch_probe_negative_control":true,"legacy_receipt_not_projected":true,"cas_conflict_refused":true,
        "native_large_receipt_refused":true,"native_prefix_exact":true,"native_missing_suffix_refused":true,"native_stale_token_refused":true}))
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
        json!({"schema":4,"mode":"content-baseline","pilot":pilot,"reference_eligible":!pilot,
        "warmup":warmup,"samples":samples,"percentile":"nearest-rank","raw_observation_order":"execution order, warmup excluded",
        "fixture_sha256":format!("{:x}",Sha256::digest([FIXTURE.as_bytes(),include_str!("content_baseline.rs").as_bytes()].concat())),"fixture":FIXTURE,
        "boundary":"real Rust repository/SQLx/on-disk SQLite; no IPC, transport, capture, app or provider",
        "omissions":["capture/IPC/transport/UI not measured","RSS/heap/allocation not measured","IPC/wire bytes not measured","A4 not exercised","no causal isolation of trigger overhead"],
        "refusal_hypothesis":"bounded SQL admission scan cost as N grows; expected resource_limit has its own outcome, no serde of absent result",
        "contract_checks":contract_checks,"admission_controls":admission_controls,"cases":cases}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_oracle_rejects_changed_fields_positions_and_unadvanced_mutation() -> Result<()>
    {
        let directory = tempfile::tempdir()?;
        let pool = db::create_pool(&directory.path().join("native-oracle.db")).await?;
        let result: Result<()> = async {
            let id = "oracle";
            sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,'Synthetic','2026-01-01','2026-01-01')").bind(id).execute(&pool).await?;
            let inputs = batch("seed",100,"2026-01-01T00:00:00Z");
            repository::import_messages(&pool,id,inputs.clone()).await?;
            let rows = expected_rows(id,inputs);
            let last = rows.last().unwrap();
            let raw_receipt = receipt(&last.id,&last.content)?;
            let key = format!("{PREFIX}{}",last.id);
            assert!(repository::compare_and_swap_app_setting(&pool,&key,None,&raw_receipt).await?.applied);
            let expected = NativeExpected::new(&pool,id,&rows,&raw_receipt).await?;
            let mut page = repository::conversation_content_metadata(&pool,&expected.open).await?;
            expected.metadata(&page,0)?;
            page.items.swap(0,1);
            assert!(expected.metadata(&page,0).is_err());
            page.items.swap(0,1);
            page.opening.as_mut().unwrap().total_raw="99".into();
            assert!(expected.metadata(&page,0).is_err());
            let mut window = repository::conversation_content_window(&pool,&expected.window).await?;
            expected.window(&window)?;
            window.items.last_mut().unwrap().provenance_json=None;
            assert!(expected.window(&window).is_err());
            let mut window = repository::conversation_content_window(&pool,&expected.window).await?;
            window.items.last_mut().unwrap().response_revision_decimal=Some("9007199254740993".into());
            assert!(expected.window(&window).is_err());
            let before=validate_native(&pool,id,&rows,&raw_receipt,None).await?;
            assert!(validate_native(&pool,id,&rows,&raw_receipt,Some(&before)).await.is_err());
            let next=format!("{raw_receipt} ");
            assert!(repository::compare_and_swap_app_setting(&pool,&key,Some(&raw_receipt),&next).await?.applied);
            validate_native(&pool,id,&rows,&next,Some(&before)).await?;
            assert!(admitted_bytes(&"more than one byte",1).is_err());
            Ok(())
        }.await;
        finish_case(pool, directory, result.map(|()| Value::Null))
            .await
            .map(|_| ())
    }
}
