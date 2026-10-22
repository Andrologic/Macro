//! Private raw native source snapshots. Normal composition remains closed.
#![allow(dead_code)]
mod version;
pub(super) use version::validate_schema;
#[cfg(test)]
pub(crate) mod tests;

mod allowlist;
mod blob;
mod owner;
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
