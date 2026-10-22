//! Private raw native source snapshots. Normal composition remains closed.
#![allow(dead_code)]
mod version;
pub(super) use version::validate_schema;
#[cfg(test)]
pub(crate) mod tests;
