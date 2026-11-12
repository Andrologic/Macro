//! Exact JSON values for the Argentic core (D15 2.c.1).
//!
//! Rust counterpart of `src/services/agsdlExecution/exact.ts` and of the
//! vendored scanners and value helpers it relies on. A number keeps its
//! authored lexeme (`NumberToken`); mathematical equality is a separate
//! operation. Objects keep an explicit member order, so each JS ordering rule
//! is applied where the TS code applies it rather than by a map type.
//! Every traversal, including drop, is iterative: nesting depth is limited by
//! memory, not by the native stack.
pub(crate) mod bigint;
pub(crate) mod scan;
pub(crate) mod values;

pub(crate) use bigint::BigInteger;
pub(crate) use scan::parse_shared;
pub(crate) use values::{equal, stringify};

use super::error::{fail, Failure};
use std::mem;

/// An authored JSON number lexeme. Constructed only from text matching the
/// JSON number grammar, the same domain the TS scanners produce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NumberToken {
    raw: String,
}

impl NumberToken {
    /// Accepts exactly one JSON number lexeme, without surrounding whitespace.
    pub(crate) fn lexeme(raw: &str) -> Option<Self> {
        (scan::number_end(raw.as_bytes(), 0) == Some(raw.len())).then(|| Self {
            raw: raw.to_owned(),
        })
    }

    pub(super) fn from_scanned(raw: String) -> Self {
        Self { raw }
    }

    pub(crate) fn raw(&self) -> &str {
        &self.raw
    }
}

/// JSON value tree. No `Clone`, `PartialEq` or `Debug` derive: those would
/// recurse. Use [`clone`], [`equal`] and [`stringify`].
pub(crate) enum Value {
    Null,
    Bool(bool),
    String(String),
    Number(NumberToken),
    Array(Vec<Value>),
    Object(Object),
}

/// Object members in their current order. Keys are unique.
#[derive(Default)]
pub(crate) struct Object {
    entries: Vec<(String, Value)>,
}

impl Object {
    /// Ordinary JS object construction: the last value wins without moving an
    /// existing key; array-index keys precede named keys. Scanned v030 objects
    /// keep using their separate insertion-order constructor.
    pub(crate) fn from_entries(entries: impl IntoIterator<Item = (String, Value)>) -> Self {
        let mut object = Self::default();
        for (key, value) in entries {
            object.set(key, value);
        }
        object
    }

    /// JS property assignment, including replacement without reinsertion.
    pub(crate) fn set(&mut self, key: String, value: Value) {
        if let Some((_, previous)) = self.entries.iter_mut().find(|(name, _)| name == &key) {
            *previous = value;
        } else {
            self.entries.push((key, value));
            self.entries = scan::js_object_order(mem::take(&mut self.entries));
        }
    }

    /// Caller guarantees unique keys.
    pub(super) fn from_unique_entries(entries: Vec<(String, Value)>) -> Self {
        Self { entries }
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    pub(crate) fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(name, _)| name == key)
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn iter(
        &self,
    ) -> impl DoubleEndedIterator<Item = (&str, &Value)> + ExactSizeIterator {
        self.entries
            .iter()
            .map(|(name, value)| (name.as_str(), value))
    }
}

impl Drop for Value {
    fn drop(&mut self) {
        fn detach(value: &mut Value, pending: &mut Vec<Value>) {
            match value {
                Value::Array(items) => pending.append(items),
                Value::Object(object) => {
                    pending.extend(mem::take(&mut object.entries).into_iter().map(|(_, v)| v))
                }
                _ => {}
            }
        }
        let mut pending = Vec::new();
        detach(self, &mut pending);
        while let Some(mut value) = pending.pop() {
            detach(&mut value, &mut pending);
        }
    }
}

impl Value {
    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    pub(crate) fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub(crate) fn as_number(&self) -> Option<&NumberToken> {
        match self {
            Value::Number(token) => Some(token),
            _ => None,
        }
    }
}

/// `JSON.stringify` of a string: short escapes for `"`, `\` and the five
/// usual controls, lowercase `\u00xx` for the other controls, every other
/// scalar unchanged (U+2028, U+2029 and DEL included). Rust strings cannot
/// hold the unpaired surrogates that JS would escape.
pub(crate) fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

const PARSE_MESSAGE: &str = "Invalid or unsupported exact JSON.";

/// `exact.decode`: the shared scanner (JS member order) over the UTF-8 bytes.
/// The TS surrogate pre-check has no Rust counterpart, `&str` holds none.
pub(crate) fn decode(text: &str) -> Result<Value, Failure> {
    match parse_shared(text.as_bytes()) {
        Ok(parsed) => Ok(parsed.tree),
        Err(_) => fail("PARSE", "", PARSE_MESSAGE),
    }
}

/// `exact.encode`: the shared serializer.
pub(crate) fn encode(value: &Value) -> String {
    stringify(value)
}

/// `exactValues.equal`: decode the left text, then the right, then compare.
pub(crate) fn equal_texts(left: &str, right: &str) -> Result<bool, Failure> {
    let left = decode(left)?;
    let right = decode(right)?;
    Ok(equal(&left, &right))
}

pub(crate) fn record<'a>(value: Option<&'a Value>, pointer: &str) -> Result<&'a Object, Failure> {
    match value {
        Some(Value::Object(object)) => Ok(object),
        _ => fail("INVALID_RECORD", pointer, "Expected an object."),
    }
}

pub(crate) fn list<'a>(value: Option<&'a Value>, pointer: &str) -> Result<&'a [Value], Failure> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        _ => fail("INVALID_RECORD", pointer, "Expected an array."),
    }
}

pub(crate) fn text<'a>(value: Option<&'a Value>, pointer: &str) -> Result<&'a str, Failure> {
    match value {
        Some(Value::String(text)) => Ok(text),
        _ => fail("INVALID_RECORD", pointer, "Expected a string."),
    }
}

/// `exact.at`: escape `~` first, then `/`.
pub(crate) fn at(pointer: &str, key: &str) -> String {
    format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"))
}

pub(crate) fn has(object: &Object, key: &str) -> bool {
    object.contains_key(key)
}

#[cfg(test)]
mod tests {
    use super::values::clone;
    use super::*;

    #[test]
    fn exact_ts_vectors_round_trip_and_reject() {
        // src/services/agsdlExecution/exact.test.ts
        let raw =
            r#"{"large":9007199254740993,"exponent":1e999999,"negativeZero":-0,"text":"é\n𝄞"}"#;
        let value = decode(raw).unwrap();
        assert_eq!(encode(&value), raw);
        assert_eq!(encode(&clone(&value)), raw);
        for bad in [r#"{"a":1,"a":2}"#, r#""\uD800""#, "[01]", "1e"] {
            assert_eq!(
                decode(bad).err().unwrap(),
                Failure::new("PARSE", "", PARSE_MESSAGE)
            );
        }
        assert_eq!(
            parse_shared("{\"é\":0,\"é\":1}".as_bytes())
                .err()
                .unwrap()
                .byte,
            8
        );
        assert_eq!(at("/a", "b/~c"), "/a/b~1~0c");
        assert_eq!(
            record(Some(&Value::Null), "/x").err().unwrap(),
            Failure::new("INVALID_RECORD", "/x", "Expected an object.")
        );
        assert!(equal_texts("[1.0,{\"a\":-0}]", "[1e0,{\"a\":0}]").unwrap());
        assert_eq!(equal_texts("1", "x").err().unwrap().code, "PARSE");
    }

    #[test]
    fn quote_follows_json_stringify() {
        assert_eq!(
            quote("a\"\\\u{8}\u{c}\n\r\t\u{1}\u{1f}\u{7f}\u{2028}é𝄞/"),
            "\"a\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}\u{2028}é𝄞/\""
        );
    }

    #[test]
    fn deep_values_drop_clone_compare_and_print_without_native_recursion() {
        let depth = 1_000_000;
        let text = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        let value = decode(&text).unwrap();
        let copy = clone(&value);
        assert!(equal(&value, &copy));
        assert_eq!(encode(&copy).len(), text.len());
        drop(value);
        drop(copy);
    }

    #[test]
    fn number_tokens_accept_only_json_lexemes() {
        for raw in ["0", "-0", "1.0", "1e400", "-1E+2", "12.50e-7"] {
            assert_eq!(NumberToken::lexeme(raw).unwrap().raw(), raw);
        }
        for raw in ["", "01", "1.", ".5", "+1", "1e", " 1", "1 ", "--1", "NaN"] {
            assert!(NumberToken::lexeme(raw).is_none(), "{raw}");
        }
    }
}
