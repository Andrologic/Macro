pub(crate) mod approvals;
pub(crate) mod diagnostics;
pub(crate) mod discovery;
// Shared transactional primitives for the native 0.3 repositories.
// Native flow authorities own admission and epochs.
pub(crate) mod call_protocol030;
pub(crate) mod card_associations;
pub(crate) mod discovery030;
pub mod dto;
#[path = "v030/flow.rs"]
pub(crate) mod flow030;
pub(crate) mod flow_store030;
pub(crate) mod flow_work_protocol030;
pub(crate) mod intents;
pub(crate) mod json_lexemes030;
pub(crate) mod public;
pub(crate) mod public030;
#[path = "v030/replay_verify030.rs"]
pub(crate) mod replay_verify030;
#[path = "v030/runtime_projection.rs"]
pub(crate) mod runtime_projection030;
pub(crate) mod start030;
pub(crate) mod work_dto030;
use dto::*;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, Sqlite, SqliteConnection, SqlitePool, Transaction};
use std::collections::BTreeMap;

pub(crate) type Result<T> = std::result::Result<T, EngineFailure>;
impl From<sqlx::Error> for EngineFailure {
    fn from(_: sqlx::Error) -> Self {
        failure("STORAGE", "", "Execution storage operation failed")
    }
}
impl From<serde_json::Error> for EngineFailure {
    fn from(_: serde_json::Error) -> Self {
        failure("CORRELATION", "", "Invalid execution data")
    }
}
pub(crate) fn failure(code: &str, pointer: &str, message: &str) -> EngineFailure {
    EngineFailure {
        code: code.into(),
        pointer: pointer.into(),
        message: message.into(),
        work: None,
    }
}
fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(failure("CORRELATION", "", message))
    }
}
fn opaque(value: &str) -> Result<()> {
    require(
        !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control),
        "Invalid execution identity",
    )
}
fn decimal(value: &str) -> Result<()> {
    require(
        !value.is_empty()
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
        "Invalid decimal sequence",
    )
}
fn order(a: &str, b: &str) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}
fn next(value: &str) -> String {
    let mut bytes = value.as_bytes().to_vec();
    for b in bytes.iter_mut().rev() {
        if *b < b'9' {
            *b += 1;
            return String::from_utf8(bytes).expect("decimal");
        }
        *b = b'0';
    }
    bytes.insert(0, b'1');
    String::from_utf8(bytes).expect("decimal")
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
pub(crate) fn validate_json(value: &str) -> Result<()> {
    super::exact_json::validate(value)?;
    Ok(())
}

async fn durable(db: &mut SqliteConnection) -> Result<Transaction<'_, Sqlite>> {
    sqlx::query("PRAGMA synchronous = FULL")
        .execute(&mut *db)
        .await?;
    Ok(db.begin_with("BEGIN IMMEDIATE").await?)
}
