//! Preserve authored JSON number tokens during 0.3 capture.
use super::{validate_json, Result};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

/// Compare decoded structure and string values while retaining each number's
/// original token. Both inputs are first checked for duplicate keys and depth.
pub(crate) fn document_tokens_equal(a: &str, b: &str) -> Result<bool> {
    fn compare(a: &str, b: &str) -> serde_json::Result<bool> {
        let a: Box<RawValue> = serde_json::from_str(a)?;
        let b: Box<RawValue> = serde_json::from_str(b)?;
        let (a, b) = (a.get(), b.get());
        match (a.as_bytes()[0], b.as_bytes()[0]) {
            (b'{', b'{') => {
                let a: BTreeMap<String, Box<RawValue>> = serde_json::from_str(a)?;
                let b: BTreeMap<String, Box<RawValue>> = serde_json::from_str(b)?;
                if a.len() != b.len() {
                    return Ok(false);
                }
                for (key, value) in &a {
                    let Some(other) = b.get(key) else {
                        return Ok(false);
                    };
                    if !compare(value.get(), other.get())? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            (b'[', b'[') => {
                let a: Vec<Box<RawValue>> = serde_json::from_str(a)?;
                let b: Vec<Box<RawValue>> = serde_json::from_str(b)?;
                if a.len() != b.len() {
                    return Ok(false);
                }
                for (left, right) in a.iter().zip(&b) {
                    if !compare(left.get(), right.get())? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            (b'"', b'"') => {
                Ok(serde_json::from_str::<String>(a)? == serde_json::from_str::<String>(b)?)
            }
            _ => Ok(a == b),
        }
    }
    validate_json(a)?;
    validate_json(b)?;
    Ok(compare(a, b)?)
}
