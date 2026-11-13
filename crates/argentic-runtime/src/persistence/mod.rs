//! Engine SQLite repositories and native transaction contracts.
pub use argentic_core::flow as flow030;
pub mod dto;
pub mod flow_store030;
pub mod start030;
pub(crate) mod json_lexemes030 {
    pub(crate) use argentic_core::durable_json::document_tokens_equal;
}
use dto::*;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, Sqlite, SqliteConnection, SqlitePool, Transaction};
use std::collections::BTreeMap;

pub type Result<T> = std::result::Result<T, EngineFailure>;
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
pub fn failure(code: &str, pointer: &str, message: &str) -> EngineFailure {
    EngineFailure {
        code: code.into(),
        pointer: pointer.into(),
        message: message.into(),
        work: None,
    }
}
#[doc(hidden)]
pub fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(failure("CORRELATION", "", message))
    }
}
#[doc(hidden)]
pub fn opaque(value: &str) -> Result<()> {
    require(
        !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control),
        "Invalid execution identity",
    )
}
#[doc(hidden)]
pub fn decimal(value: &str) -> Result<()> {
    require(
        !value.is_empty()
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
        "Invalid decimal sequence",
    )
}
#[doc(hidden)]
pub fn order(a: &str, b: &str) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}
#[doc(hidden)]
pub fn next(value: &str) -> String {
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
#[doc(hidden)]
pub fn encode<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
pub fn validate_json(value: &str) -> Result<()> {
    argentic_core::durable_json::validate(value)?;
    Ok(())
}

#[doc(hidden)]
pub async fn durable(db: &mut SqliteConnection) -> Result<Transaction<'_, Sqlite>> {
    sqlx::query("PRAGMA synchronous = FULL")
        .execute(&mut *db)
        .await?;
    Ok(db.begin_with("BEGIN IMMEDIATE").await?)
}
