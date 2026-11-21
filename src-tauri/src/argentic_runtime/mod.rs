//! Test adapter for the codec and scalar conversion from the locked Argentic source.
use crate::argentic_core::calculation;
include!(concat!(env!("OUT_DIR"), "/argentic_editor_codec.rs"));

pub(crate) mod native_json {
    use super::{codec, native_numbers};
    use crate::argentic_core::native::Value;

    pub(crate) use native_numbers::{bits_text, decimal_bits};
    pub(crate) const DECODER: codec::Decoder = codec::Decoder(native_numbers::normalize);

    pub(crate) fn parse(raw: &str) -> Result<Value, codec::Error> {
        codec::parse(raw, native_numbers::normalize)
    }
}
