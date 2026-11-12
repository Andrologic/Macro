//! The readExactDocument export only, without the editor's size limit.
use crate::argentic_core::{
    exact::{self, Value},
    native::Text,
};
pub(crate) fn read_bytes(bytes: &[u8]) -> Result<Value, String> {
    let parsed =
        exact::scan::parse_v030(bytes).map_err(|e| format!("Invalid JSON at byte {}.", e.byte))?;
    if parsed.tree.as_object().is_none() {
        return Err("An AgSDL document must be a JSON object.".into());
    }
    Ok(parsed.tree)
}
pub(crate) fn read_text(text: &Text) -> Result<Value, String> {
    let Some(text) = text.utf8() else {
        return Err("Invalid JSON: unpaired UTF-16 surrogate.".into());
    };
    read_bytes(text.as_bytes())
}
