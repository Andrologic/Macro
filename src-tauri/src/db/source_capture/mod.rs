//! Private raw native source snapshots. Normal composition remains closed.
#![allow(dead_code)]
mod version;
pub(super) use version::validate_schema;
#[cfg(test)]
pub(crate) mod tests;

mod allowlist;
mod blob;
mod owner;
pub(crate) use owner::SourceCapture;
pub(crate) use types::{Cursor, RawNativeCapture};
mod types;
use serde::de::DeserializeOwned;
const CONTROL: usize = 4096;
const BLOCK: usize = 4093;
type Result<T> = std::result::Result<T, String>;
fn error<T>(_: T) -> String {
    "database_unavailable".into()
}
fn parse<T: DeserializeOwned>(raw: &[u8]) -> Result<T> {
    if raw.len() > CONTROL {
        return Err("resource_limit".into());
    }
    serde_json::from_slice(raw).map_err(|_| "validation_failed".into())
}
fn add(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b).ok_or_else(|| "resource_limit".into())
}

mod copy;
mod readback;
mod relations;
mod seal;

/// Validate attachment to the already frozen local source. No capture opener,
/// policy capability or network authority is created by this database relation.
pub(in crate::db) async fn transfer_attachment(
    db: &mut sqlx::SqliteConnection,
    capture: &str,
    conversation: &str,
    generation: &str,
    content: &crate::db::models::ConversationContentToken,
) -> crate::db::DbResult<i64> {
    validate_schema(db).await?;
    let row: Option<(i64,String)> = sqlx::query_as("SELECT id,binding_json FROM e_source_captures WHERE capture_id=? AND phase BETWEEN 0 AND 2 AND length(CAST(binding_json AS BLOB))<=4096")
        .bind(capture).fetch_optional(&mut *db).await?;
    let (id, raw) = row.ok_or_else(|| {
        crate::db::DbError::Validation("connect_transfer_capture_unavailable".into())
    })?;
    let binding: types::Binding = serde_json::from_str(&raw).map_err(|_| {
        crate::db::DbError::Validation("connect_transfer_capture_unavailable".into())
    })?;
    if binding.version != 1
        || binding.conversation != conversation
        || binding.generation != generation
        || binding.content != *content
    {
        return Err(crate::db::DbError::Validation(
            "connect_transfer_conflict".into(),
        ));
    }
    Ok(id)
}
