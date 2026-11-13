//! Exact authored-token comparison shared with the standalone core.
pub(crate) fn document_tokens_equal(a: &str, b: &str) -> super::Result<bool> {
    Ok(argentic_core::durable_json::document_tokens_equal(a, b)?)
}
