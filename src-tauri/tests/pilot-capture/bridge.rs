//! Test-only JSON-lines boundary for TypeScript runtime tests against production Git captures.
#![allow(dead_code)]
#[path = "../../src/commands/git/pilot_capture/core.rs"]
mod core;
#[path = "../../src/commands/git/pilot_capture/verdict.rs"]
mod verdict;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
fn run(
    input: &Value,
    runtime: &tokio::runtime::Runtime,
    pool: &sqlx::SqlitePool,
) -> Result<Value, String> {
    let args = &input["args"];
    let id = args["snapshotId"].as_str().unwrap_or_default().to_string();
    match input["command"].as_str().unwrap_or_default() {
        "db_get_app_setting" => runtime.block_on(async {
            let value: Option<String> = sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key=?").bind(args["key"].as_str()).fetch_optional(pool).await.map_err(|_| "unavailable")?;
            Ok(value.map(|value| json!({"value_json":value})).unwrap_or(Value::Null))
        }),
        "db_compare_and_swap_app_setting" => runtime.block_on(async {
            let mut tx = pool.begin().await.map_err(|_| "unavailable")?;
            let value: Option<String> = sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key=?").bind(args["key"].as_str()).fetch_optional(&mut *tx).await.map_err(|_| "unavailable")?;
            let applied = value.as_deref() == args["expectedValueJson"].as_str();
            if applied {
                sqlx::query("INSERT INTO app_settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").bind(args["key"].as_str()).bind(args["valueJson"].as_str()).bind("now").execute(&mut *tx).await.map_err(|_| "unavailable")?;
            }
            tx.commit().await.map_err(|_| "unavailable")?;
            Ok(json!({"applied":applied}))
        }),
        "pilot_review_commit" => {
            let commit: verdict::VerdictCommit = serde_json::from_value(args["input"].clone()).map_err(|_| "validation_failed")?;
            let repo = git2::Repository::open(core::capture_path(&commit.snapshot_id)?).map_err(|_| "content_unavailable")?;
            runtime.block_on(verdict::commit(pool, &repo, commit, || Ok(()))).map(|applied| json!(applied))
        },
        "pilot_review_capture" => {
            let path = std::path::PathBuf::from(args["repoPath"].as_str().ok_or("content_unavailable")?);
            let repo = git2::Repository::open(&path).map_err(|_| "content_unavailable")?;
            let request = serde_json::from_value(args["request"].clone()).map_err(|_| "validation_failed")?;
            serde_json::to_value(core::create(&repo, path, request)?).map_err(|_| "content_unavailable".into())
        }
        "pilot_review_files" => serde_json::to_value(core::pilot_review_files(id, args["cursor"].as_str().map(String::from))?).map_err(|_| "content_unavailable".into()),
        "pilot_review_read" => serde_json::to_value(core::pilot_review_read(id, args["fileId"].as_str().unwrap_or_default().into(), args["offsetBytes"].as_u64().unwrap_or(0) as usize)?).map_err(|_| "content_unavailable".into()),
        "pilot_review_fresh" => {
            let path = core::capture_path(&id)?;
            let repo = git2::Repository::open(path).map_err(|_| "content_unavailable")?;
            let request = serde_json::from_value(args["request"].clone()).map_err(|_| "validation_failed")?;
            Ok(json!(core::fresh(&repo, &id, &request)?))
        }
        "pilot_review_release" => { core::pilot_review_release(id)?; Ok(Value::Null) }
        _ => Err("validation_failed".into()),
    }
}
fn main() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let pool = runtime.block_on(async {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL)").execute(&pool).await.unwrap();
        pool
    });
    for line in std::io::stdin().lock().lines() {
        let response = match line
            .ok()
            .and_then(|line| serde_json::from_str::<Value>(&line).ok())
        {
            Some(value) => match run(&value, &runtime, &pool) {
                Ok(result) => json!({"result":result}),
                Err(code) => json!({"error":code}),
            },
            None => json!({"error":"validation_failed"}),
        };
        println!("{response}");
        let _ = std::io::stdout().flush();
    }
}
