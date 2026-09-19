//! Development-only benchmark compiling the actual private database modules.
//! No Tauri app, global config manager, secrets initialization or provider calls.
#![allow(dead_code, unused_imports)]
#[path = "../src/db/mod.rs"]
mod db;
#[path = "../src/ai/macro_ai.rs"]
pub mod macro_ai;
mod ai {
    pub use crate::macro_ai;
}
#[path = "../src/secrets/mod.rs"]
mod secrets;
pub use macro_lib::config;

use db::models::{CreateConversationInput, CreateMessageInput, ImportMessageInput};
use db::repository;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::time::Instant;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const WARMUP: usize = 10;
const SAMPLES: usize = 100;
const CONTENT: &str = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

fn summary(mut samples: Vec<f64>) -> Value {
    assert!(!samples.is_empty());
    assert!(samples.iter().all(|n| n.is_finite() && *n >= 0.0));
    samples.sort_by(f64::total_cmp);
    let percentile = |p: f64| samples[(p * samples.len() as f64).ceil() as usize - 1];
    json!({"unit":"ms", "count":samples.len(), "p50":percentile(0.5),
        "p95":percentile(0.95), "max":samples.last().unwrap()})
}

async fn assert_path(pool: &SqlitePool, expected: &Path) -> Result<()> {
    let rows = sqlx::query("PRAGMA database_list").fetch_all(pool).await?;
    let main = rows
        .iter()
        .find(|row| row.get::<String, _>("name") == "main")
        .ok_or("No main database")?;
    let opened = std::fs::canonicalize(main.get::<String, _>("file"))?;
    if opened != std::fs::canonicalize(expected)? {
        return Err("Unexpected database path".into());
    }
    Ok(())
}

async fn verify(pool: &SqlitePool, conversation_id: &str, expected: usize) -> Result<()> {
    let messages = repository::list_messages(pool, conversation_id).await?;
    if messages.len() != expected
        || messages.iter().any(|message| {
            let expected = message
                .id
                .strip_prefix("append-")
                .and_then(|id| id.parse::<usize>().ok())
                .map(append_content)
                .unwrap_or_else(|| CONTENT.to_owned());
            message.content != expected
        })
    {
        return Err("Persisted message count/content mismatch".into());
    }
    let conversation = repository::get_conversation(pool, conversation_id)
        .await?
        .ok_or("Missing conversation")?;
    if conversation.message_count as usize != expected
        || conversation.last_message
            != messages
                .last()
                .map(|message| format!("{}...", &message.content[..100]))
        || conversation.updated_at != messages.last().ok_or("Empty fixture")?.created_at
    {
        return Err("Persisted conversation metadata mismatch".into());
    }
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await?;
    if integrity != "ok"
        || !sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(pool)
            .await?
            .is_empty()
    {
        return Err("SQLite integrity failure".into());
    }
    Ok(())
}

fn append_content(i: usize) -> String {
    format!("{:<256}", format!("synthetic append {i:06}"))
}

async fn run_case(size: usize) -> Result<Value> {
    let directory = tempfile::Builder::new()
        .prefix("macro-native-perf-")
        .tempdir()?;
    let path = directory.path().join("fixture.db");
    if path.exists() {
        return Err("Fixture must be new".into());
    }
    let started = Instant::now();
    let pool = db::create_pool(&path).await?;
    let migration_ms = started.elapsed().as_secs_f64() * 1000.0;
    let outcome = measure_case(&pool, &path, size, migration_ms).await;
    finish_case(pool, directory, outcome).await
}

async fn finish_case(
    pool: SqlitePool,
    directory: tempfile::TempDir,
    outcome: Result<Value>,
) -> Result<Value> {
    pool.close().await;
    let owned_path = directory.path().to_owned();
    directory.close()?;
    if owned_path.exists() {
        return Err("Fixture cleanup failed".into());
    }
    outcome
}

async fn measure_case(
    pool: &SqlitePool,
    path: &Path,
    size: usize,
    migration_ms: f64,
) -> Result<Value> {
    assert_path(pool, path).await?;
    if assert_path(pool, path.parent().ok_or("Missing fixture parent")?)
        .await
        .is_ok()
    {
        return Err("Path validation failed to reject a mismatch".into());
    }
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(pool)
        .await?;
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(pool)
        .await?;
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(pool)
        .await?;
    let sqlite_version: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(pool)
        .await?;
    let migrations: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(pool)
            .await?;
    if !migrations.contains(&5) || journal != "wal" || synchronous != 1 || foreign_keys != 1 {
        return Err("Unexpected database runtime settings".into());
    }
    let conversation = repository::create_conversation(
        pool,
        CreateConversationInput {
            title: Some("Synthetic native baseline".into()),
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
    let fixture: Vec<_> = (0..size)
        .map(|i| ImportMessageInput {
            id: format!("seed-{i:06}"),
            turn_id: None,
            role: "user".into(),
            content: CONTENT.into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            completion_reason: None,
        })
        .collect();
    if repository::import_messages(pool, &conversation.id, fixture)
        .await?
        .len()
        != size
    {
        return Err("Seed import mismatch".into());
    }
    verify(pool, &conversation.id, size).await?;
    let mut reads = Vec::new();
    for i in 0..WARMUP + SAMPLES {
        let start = Instant::now();
        let messages = repository::list_messages(pool, &conversation.id).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if messages.len() != size {
            return Err("Read fixture changed".into());
        }
        std::hint::black_box(&messages);
        if i >= WARMUP {
            reads.push(elapsed);
        }
    }
    let mut writes = Vec::new();
    for i in 0..WARMUP + SAMPLES {
        let input = CreateMessageInput {
            id: Some(format!("append-{i:06}")),
            conversation_id: conversation.id.clone(),
            turn_id: None,
            role: "assistant".into(),
            content: append_content(i),
            token_count: None,
            tool_traces_json: None,
            hidden_context: None,
            provider_input_items_json: None,
            provider_turn_state_json: None,
            context_refs_json: None,
            completion_reason: None,
        };
        let start = Instant::now();
        let message = repository::create_message(pool, input).await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        std::hint::black_box(message);
        if i >= WARMUP {
            writes.push(elapsed);
        }
    }
    let final_count = size + WARMUP + SAMPLES;
    verify(pool, &conversation.id, final_count).await?;
    pool.close().await;
    let start = Instant::now();
    let reopened = db::create_pool(path).await?;
    let reopen_ms = start.elapsed().as_secs_f64() * 1000.0;
    let reopened_check: Result<()> = async {
        assert_path(&reopened, path).await?;
        verify(&reopened, &conversation.id, final_count).await?;
        let persisted_ids: Vec<String> = repository::list_messages(&reopened, &conversation.id)
            .await?
            .into_iter()
            .map(|message| message.id)
            .collect();
        for i in 0..WARMUP + SAMPLES {
            if !persisted_ids.contains(&format!("append-{i:06}")) {
                return Err("Committed append missing after reopen".into());
            }
        }
        Ok(())
    }
    .await;
    reopened.close().await;
    reopened_check?;
    Ok(
        json!({"initial_messages":size, "message_bytes":CONTENT.len(), "read_messages":size,
        "write_start_messages":size+WARMUP, "final_messages":final_count,
        "read":summary(reads), "create_message_commit":summary(writes),
        "fresh_pool_and_migrations_ms":migration_ms, "reopen_pool_and_migrations_ms":reopen_ms,
        "sqlite_version":sqlite_version, "migrations":migrations,
        "pragmas":{"journal_mode":journal,"synchronous":synchronous,"foreign_keys":foreign_keys},
        "checks":{"opened_path_matches_owned_fixture":true,"content_and_metadata_after_reopen":true,
        "all_appends_after_reopen":true,"integrity":true,"cleanup":true}}),
    )
}

async fn self_test() -> Result<()> {
    let values = summary((1..=100).map(f64::from).collect());
    assert_eq!(values["p50"], 50.0);
    assert_eq!(values["p95"], 95.0);
    let unrelated = tempfile::Builder::new()
        .prefix("macro-native-perf-sentinel-")
        .tempdir()?;
    let sentinel = unrelated.path().join("unrelated");
    std::fs::write(&sentinel, "keep")?;
    let directory = tempfile::Builder::new()
        .prefix("macro-native-perf-failure-")
        .tempdir()?;
    let owned_path = directory.path().to_owned();
    let pool = db::create_pool(&owned_path.join("fixture.db")).await?;
    let failure = finish_case(pool, directory, Err("Synthetic failure".into())).await;
    assert!(failure.is_err());
    assert!(!owned_path.exists());
    assert_eq!(std::fs::read_to_string(&sentinel)?, "keep");
    unrelated.close()?;
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if !args.is_empty() && args != ["--self-test"] {
        return Err("Only --self-test is supported".into());
    }
    self_test().await?;
    let sizes: &[usize] = if args.is_empty() {
        &[100, 1_000, 10_000]
    } else {
        &[3]
    };
    let mut cases = Vec::new();
    for &size in sizes {
        cases.push(run_case(size).await?);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({"schema":1,
        "boundary":"in-process Rust repository -> SQLx -> on-disk SQLite; no transport",
        "build_profile":"debug", "warmup":WARMUP, "samples":SAMPLES, "percentile":"nearest-rank",
        "cold_disk_cache":false, "power_loss_tested":false, "cases":cases}))?
    );
    Ok(())
}
