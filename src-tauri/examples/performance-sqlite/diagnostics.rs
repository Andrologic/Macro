//! Separate diagnostic replay. No production timers or provider initialization.
//! SQL literals are taken from the compiled repository source, not historical SQL.
use super::{append_content, db, repository, summary, Result, SAMPLES, WARMUP};
use db::models::Message;
use libsqlite3_sys as ffi;
use serde_json::{json, Value};
use sqlx::{Connection, Row, SqlitePool};
use std::{ffi::CString, time::Instant};

fn sql(function: &str, index: usize) -> Result<&'static str> {
    let source = include_str!("../../src/db/repository.rs");
    let (_, body) = source
        .split_once(&format!("fn {function}("))
        .ok_or("Diagnostic function missing")?;
    let body = body
        .split_once("\n}")
        .ok_or("Diagnostic function boundary missing")?
        .0;
    body.split("r#\"")
        .skip(1)
        .nth(index)
        .and_then(|s| s.split_once("\"#").map(|(sql, _)| sql))
        .ok_or_else(|| "Diagnostic SQL literal missing".into())
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn keep(series: &mut Vec<f64>, i: usize, start: Instant) {
    let elapsed = ms(start);
    if i >= WARMUP {
        series.push(elapsed);
    }
}

// Finalize even on an error, before the SQLx handle lock can be released.
struct Statement(*mut ffi::sqlite3_stmt);
impl Drop for Statement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                ffi::sqlite3_finalize(self.0);
            }
        }
    }
}
fn check(code: i32, expected: i32) -> Result<()> {
    if code != expected {
        return Err(format!("SQLite diagnostic code {code}, expected {expected}").into());
    }
    Ok(())
}

async fn engine_read(pool: &SqlitePool, id: &str, expected: usize) -> Result<Value> {
    let mut connection = pool.acquire().await?;
    let mut handle = connection.lock_handle().await?;
    let query = CString::new(sql("list_messages_with_connection", 0)?)?;
    let id = CString::new(id)?;
    let mut timings = Vec::new();
    let mut steps = Vec::new();
    for i in 0..WARMUP + SAMPLES {
        let start = Instant::now();
        // SAFETY: handle excludes SQLx's worker for this entire scope. CStrings
        // stay alive until statement finalization. All return codes are checked.
        let (count, vm_steps) = unsafe {
            let mut raw = std::ptr::null_mut();
            let code = ffi::sqlite3_prepare_v2(
                handle.as_raw_handle().as_ptr(),
                query.as_ptr(),
                -1,
                &mut raw,
                std::ptr::null_mut(),
            );
            let mut statement = Statement(raw);
            check(code, ffi::SQLITE_OK)?;
            check(
                ffi::sqlite3_bind_text(statement.0, 1, id.as_ptr(), -1, ffi::SQLITE_STATIC()),
                ffi::SQLITE_OK,
            )?;
            if ffi::sqlite3_column_count(statement.0) != 14 {
                return Err("Diagnostic projection changed".into());
            }
            let mut count = 0;
            loop {
                let code = ffi::sqlite3_step(statement.0);
                if code == ffi::SQLITE_DONE {
                    break;
                }
                check(code, ffi::SQLITE_ROW)?;
                count += 1;
            }
            let steps = ffi::sqlite3_stmt_status(statement.0, ffi::SQLITE_STMTSTATUS_VM_STEP, 0);
            // Finalize is included. No text copies or model construction here.
            let finalized = ffi::sqlite3_finalize(statement.0);
            statement.0 = std::ptr::null_mut();
            check(finalized, ffi::SQLITE_OK)?;
            drop(statement);
            (count, steps)
        };
        keep(&mut timings, i, start);
        if count != expected {
            return Err("Engine row count mismatch".into());
        }
        if i >= WARMUP {
            steps.push(vm_steps);
        }
    }
    Ok(
        json!({"prepare_bind_step_finalize":summary(timings), "rows_each":expected,
        "vm_steps_each":steps, "boundary":"same SQLite library and file via locked SQLx handle; no SQLx rows or Rust text/model copies; prepare included, lock/acquire excluded"}),
    )
}

pub(super) async fn reads(pool: &SqlitePool, id: &str, expected: usize) -> Result<Value> {
    let query = sql("list_messages_with_connection", 0)?;
    let mut acquire = Vec::new();
    let mut fetch = Vec::new();
    let mut convert = Vec::new();
    for i in 0..WARMUP + SAMPLES {
        let start = Instant::now();
        let mut connection = pool.acquire().await?;
        keep(&mut acquire, i, start);
        let start = Instant::now();
        let rows = sqlx::query(query)
            .bind(id)
            .fetch_all(&mut *connection)
            .await?;
        keep(&mut fetch, i, start);
        let start = Instant::now();
        let messages: Vec<_> = rows
            .into_iter()
            .map(|row| repository::map_list_message_row(&row))
            .collect();
        keep(&mut convert, i, start);
        if messages.len() != expected {
            return Err("Diagnostic read count mismatch".into());
        }
        // Validate every field/order outside timing against the actual repository.
        let actual = repository::list_messages(pool, id).await?;
        if serde_json::to_value(&messages)? != serde_json::to_value(actual)? {
            return Err("Diagnostic read differs from repository".into());
        }
        std::hint::black_box(messages);
    }
    Ok(
        json!({"acquire_pool":summary(acquire), "query_fetch_all":summary(fetch),
        "rows_to_messages":summary(convert), "rows_each":expected,
        "boundary":"separate diagnostic replay, includes SQLx row materialization in fetch; not additive percentiles or pure engine time"}),
    )
}

pub(super) async fn measure(pool: &SqlitePool, id: &str, size: usize) -> Result<Value> {
    let read_sql = sql("list_messages_with_connection", 0)?;
    let insert_sql = sql("create_message", 0)?;
    let latest_sql = sql("refresh_conversation_metadata_with_connection", 0)?;
    let update_sql = sql("refresh_conversation_metadata_with_connection", 1)?;
    const COUNT: &str = "SELECT COUNT(*) FROM messages WHERE conversation_id = ?";
    if !include_str!("../../src/db/repository.rs").contains(COUNT) {
        return Err("Count SQL changed".into());
    }
    let mut plans = Vec::new();
    for query in [read_sql, COUNT, latest_sql] {
        let explain = format!("EXPLAIN QUERY PLAN {query}");
        let rows = sqlx::query(sqlx::AssertSqlSafe(explain))
            .bind(id)
            .fetch_all(pool)
            .await?;
        plans.push(json!({"sql":query, "details":rows.iter().map(|r|r.get::<String,_>("detail")).collect::<Vec<_>>()}));
    }
    let engine = engine_read(pool, id, size).await?;
    let read = reads(pool, id, size).await?;
    // Exploratory bounded-channel tuning, separate from the production pool.
    // Clone every current option and change only the row-channel capacity.
    let options = pool.connect_options().as_ref().clone().row_buffer_size(512);
    let buffered = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
    let buffered_read = reads(&buffered, id, size).await;
    buffered.close().await;
    let buffered_read = buffered_read?;
    // Replay create_message's stages, with identical statements and transaction
    // mode, on this separate diagnostic fixture. Actual operation stays uninstrumented.
    let mut series: Vec<Vec<f64>> = vec![Vec::new(); 9];
    for i in 0..WARMUP + SAMPLES {
        let message_id = format!("append-{i:06}");
        let content = append_content(i);
        let now = chrono::Utc::now().to_rfc3339();
        let start = Instant::now();
        let mut connection = pool.acquire().await?;
        keep(&mut series[0], i, start);
        let start = Instant::now();
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        keep(&mut series[1], i, start);
        let start = Instant::now();
        sqlx::query(insert_sql)
            .bind(&message_id)
            .bind(id)
            .bind(None::<String>)
            .bind("assistant")
            .bind(&content)
            .bind(&now)
            .bind(None::<i32>)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(None::<String>)
            .execute(&mut *tx)
            .await?;
        keep(&mut series[2], i, start);
        let start = Instant::now();
        let count: i32 = sqlx::query_scalar(COUNT)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        keep(&mut series[3], i, start);
        let start = Instant::now();
        let latest = sqlx::query(latest_sql)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        keep(&mut series[4], i, start);
        let start = Instant::now();
        let last_message = latest.as_ref().map(|r| {
            let text: String = r.get("content");
            let mut truncated: String = text.chars().take(100).collect();
            if text.chars().count() > 100 {
                truncated.push_str("...");
            }
            truncated
        });
        // Same fallback allocation as product, even with override present.
        std::hint::black_box(chrono::Utc::now().to_rfc3339());
        let updated_at = now.clone();
        keep(&mut series[5], i, start);
        let start = Instant::now();
        sqlx::query(update_sql)
            .bind(last_message.as_deref())
            .bind(count)
            .bind(&updated_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        keep(&mut series[6], i, start);
        let start = Instant::now();
        tx.commit().await?;
        keep(&mut series[7], i, start);
        let start = Instant::now();
        let message = Message {
            id: message_id,
            conversation_id: id.into(),
            turn_id: None,
            role: "assistant".into(),
            content,
            created_at: now,
            token_count: None,
            tool_traces_json: None,
            hidden_context: None,
            provider_input_items_json: None,
            provider_turn_state_json: None,
            context_refs_json: None,
            completion_reason: None,
            generation_attempts_json: None,
        };
        keep(&mut series[8], i, start);
        if count as usize != size + i + 1 {
            return Err("Diagnostic write count mismatch".into());
        }
        if serde_json::to_value(&message)?
            != serde_json::to_value(
                repository::get_message(pool, &message.id)
                    .await?
                    .ok_or("Missing diagnostic append")?,
            )?
        {
            return Err("Diagnostic append differs from stored message".into());
        }
    }
    let names = [
        "acquire_pool",
        "begin_immediate",
        "insert_with_fts",
        "count_query",
        "latest_query",
        "metadata_row_conversion",
        "metadata_update",
        "commit",
        "message_construction",
    ];
    let mut writes = serde_json::Map::new();
    for (name, values) in names.into_iter().zip(series) {
        writes.insert(name.into(), summary(values));
    }
    let schema:Vec<String> = sqlx::query_scalar("SELECT type || ':' || name || ':' || COALESCE(sql,'') FROM sqlite_master ORDER BY type,name")
        .fetch_all(pool).await?;
    use sha2::{Digest, Sha256};
    let schema_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&schema)?));
    Ok(
        json!({"read":read,"exploratory_row_buffer_512":buffered_read,"engine_read":engine,"write":writes,"plans":plans,
        "schema_sha256":schema_hash,"schema_objects":schema.len(),
        "boundary":"diagnostic replay, statements extracted from current source; no pure-engine write timing; SQLx execution includes dispatch, materialization and scheduling"}),
    )
}
