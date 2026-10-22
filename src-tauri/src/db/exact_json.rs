//! Exact structural equality for durable receipts. Retain the first authored text.
use serde::{
    de::{self, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{value::RawValue, Value};
use std::{collections::BTreeMap, fmt};

struct Fields(BTreeMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Object;
        impl<'de> Visitor<'de> for Object {
            type Value = Fields;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON object with unique keys")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Fields, M::Error> {
                let mut fields = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if fields.insert(key, value).is_some() {
                        return Err(de::Error::custom("Duplicate JSON key"));
                    }
                }
                Ok(Fields(fields))
            }
        }
        deserializer.deserialize_map(Object)
    }
}
#[derive(PartialEq, Eq)]
enum Exact {
    Null,
    Bool(bool),
    String(String),
    Number(String),
    Array(Vec<Exact>),
    Object(BTreeMap<String, Exact>),
}
const MAX_JSON_DEPTH: usize = 128;
fn parse(text: &str) -> serde_json::Result<Exact> {
    parse_at_depth(text, 0)
}
fn parse_at_depth(text: &str, depth: usize) -> serde_json::Result<Exact> {
    if depth >= MAX_JSON_DEPTH {
        return Err(<serde_json::Error as de::Error>::custom(
            "JSON nesting limit exceeded",
        ));
    }
    let raw: Box<RawValue> = serde_json::from_str(text)?;
    let text = raw.get();
    Ok(match text.as_bytes()[0] {
        b'{' => Exact::Object(
            serde_json::from_str::<Fields>(text)?
                .0
                .into_iter()
                .map(|(key, value)| Ok((key, parse_at_depth(value.get(), depth + 1)?)))
                .collect::<serde_json::Result<_>>()?,
        ),
        b'[' => Exact::Array(
            serde_json::from_str::<Vec<Box<RawValue>>>(text)?
                .into_iter()
                .map(|value| parse_at_depth(value.get(), depth + 1))
                .collect::<serde_json::Result<_>>()?,
        ),
        b'"' => Exact::String(serde_json::from_str(text)?),
        b'n' => Exact::Null,
        b't' => Exact::Bool(true),
        b'f' => Exact::Bool(false),
        _ => Exact::Number(number(text)),
    })
}
// Canonical coefficient/exponent, never f64 and never expansion by the exponent.
fn number(text: &str) -> String {
    let (negative, text) = text.strip_prefix('-').map_or((false, text), |t| (true, t));
    let (coefficient, exponent) = text.split_once(['e', 'E']).unwrap_or((text, "0"));
    let fractional = coefficient
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len());
    let digits = coefficient.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return "0".into();
    }
    let significant = digits.trim_end_matches('0');
    let shift = (digits.len() - significant.len()) as i128 - fractional as i128;
    let exponent = signed_add(exponent, shift);
    format!(
        "{}{}e{}",
        if negative { "-" } else { "" },
        significant,
        exponent
    )
}
fn magnitude(value: &str) -> &str {
    let value = value.trim_start_matches('0');
    if value.is_empty() {
        "0"
    } else {
        value
    }
}
fn add(a: &str, b: &str) -> String {
    let mut result = Vec::new();
    let mut carry = 0;
    let mut a = a.bytes().rev();
    let mut b = b.bytes().rev();
    loop {
        let x = a.next();
        let y = b.next();
        if x.is_none() && y.is_none() && carry == 0 {
            break;
        }
        let sum = x.map_or(0, |v| v - b'0') + y.map_or(0, |v| v - b'0') + carry;
        result.push(b'0' + sum % 10);
        carry = sum / 10;
    }
    result.reverse();
    String::from_utf8(result).expect("decimal")
}
fn subtract(a: &str, b: &str) -> String {
    let mut result = Vec::new();
    let mut borrow: i16 = 0;
    let mut b = b.bytes().rev();
    for x in a.bytes().rev() {
        let mut digit = (x - b'0') as i16 - b.next().map_or(0, |v| (v - b'0') as i16) - borrow;
        borrow = i16::from(digit < 0);
        if digit < 0 {
            digit += 10;
        }
        result.push(b'0' + digit as u8);
    }
    result.reverse();
    magnitude(&String::from_utf8(result).expect("decimal")).to_owned()
}
fn signed_add(exponent: &str, shift: i128) -> String {
    let negative = exponent.starts_with('-');
    let a = magnitude(exponent.trim_start_matches(['-', '+']));
    let shift_text = shift.to_string();
    let b = magnitude(shift_text.trim_start_matches('-'));
    let (negative, result) = if negative == (shift < 0) {
        (negative, add(a, b))
    } else {
        match a.len().cmp(&b.len()).then_with(|| a.cmp(b)) {
            std::cmp::Ordering::Less => (shift < 0, subtract(b, a)),
            _ => (negative, subtract(a, b)),
        }
    };
    format!(
        "{}{}",
        if negative && result != "0" { "-" } else { "" },
        result
    )
}
/// Decode metadata without treating user object keys as serde_json internal tokens.
/// Use RawValue/at_path instead when retaining data for exact comparisons.
pub(crate) fn value(text: &str) -> serde_json::Result<Value> {
    fn at_depth(text: &str, depth: usize) -> serde_json::Result<Value> {
        if depth >= MAX_JSON_DEPTH {
            return Err(<serde_json::Error as de::Error>::custom(
                "JSON nesting limit exceeded",
            ));
        }
        let raw: Box<RawValue> = serde_json::from_str(text)?;
        let text = raw.get();
        match text.as_bytes()[0] {
            b'{' => Ok(Value::Object(
                serde_json::from_str::<Fields>(text)?
                    .0
                    .into_iter()
                    .map(|(key, raw)| Ok((key, at_depth(raw.get(), depth + 1)?)))
                    .collect::<serde_json::Result<_>>()?,
            )),
            b'[' => Ok(Value::Array(
                serde_json::from_str::<Vec<Box<RawValue>>>(text)?
                    .into_iter()
                    .map(|raw| at_depth(raw.get(), depth + 1))
                    .collect::<serde_json::Result<_>>()?,
            )),
            _ => serde_json::from_str(text),
        }
    }
    at_depth(text, 0)
}
/// Select object members without interpreting serde_json's private Value tokens.
/// Embedded values retain their authored JSON until the exact comparator reads them.
pub(crate) fn at_path(text: &str, path: &[&str]) -> serde_json::Result<Option<Box<RawValue>>> {
    let mut raw: Box<RawValue> = serde_json::from_str(text)?;
    for key in path {
        if !raw.get().starts_with('{') {
            return Ok(None);
        }
        let Some(value) = serde_json::from_str::<Fields>(raw.get())?.0.remove(*key) else {
            return Ok(None);
        };
        raw = value;
    }
    Ok(Some(raw))
}
pub(crate) fn validate(text: &str) -> serde_json::Result<()> {
    parse(text).map(|_| ())
}
pub(crate) fn equal(a: &str, b: &str) -> serde_json::Result<bool> {
    Ok(parse(a)? == parse(b)?)
}
pub(crate) fn equal_optional(a: Option<&str>, b: Option<&str>) -> serde_json::Result<bool> {
    match (a, b) {
        (Some(a), Some(b)) => equal(a, b),
        (None, None) => Ok(true),
        _ => Ok(false),
    }
}
// DTO contracts identify embedded exact values with their Json suffix. Identity and
// ordinary text fields remain byte-for-byte comparisons, including authoredSource.
pub(crate) fn record_equal<T: Serialize>(a: &T, b: &T) -> serde_json::Result<bool> {
    fn compare(a: &Value, b: &Value) -> serde_json::Result<bool> {
        match (a, b) {
            (Value::Object(a), Value::Object(b)) => {
                if a.len() != b.len() {
                    return Ok(false);
                }
                for (key, a) in a {
                    let Some(b) = b.get(key) else {
                        return Ok(false);
                    };
                    let matches = if key.ends_with("Json") {
                        match (a, b) {
                            (Value::String(a), Value::String(b)) => equal(a, b)?,
                            _ => compare(a, b)?,
                        }
                    } else {
                        compare(a, b)?
                    };
                    if !matches {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            (Value::Array(a), Value::Array(b)) => {
                if a.len() != b.len() {
                    return Ok(false);
                }
                for (a, b) in a.iter().zip(b) {
                    if !compare(a, b)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            _ => Ok(a == b),
        }
    }
    compare(&serde_json::to_value(a)?, &serde_json::to_value(b)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deep_input_is_rejected_before_native_stack_exhaustion() {
        let nested = format!(
            "{}0{}",
            "[".repeat(MAX_JSON_DEPTH + 1),
            "]".repeat(MAX_JSON_DEPTH + 1)
        );
        assert!(validate(&nested).is_err());
        assert!(equal(&nested, &nested).is_err());
        assert!(value(&nested).is_err());
        let bounded = format!("{}0{}", "[".repeat(32), "]".repeat(32));
        assert!(equal(&bounded, &bounded).unwrap());
    }
    #[test]
    fn member_selection_preserves_public_private_token_keys_and_exact_numbers() {
        let source = r#"{"flow":{"steps":{"a":{"type":"prepare","message":{"resources":{"value":{"value":{"$serde_json::private::Number":"1"}}}}}}},"bindings":{"b":{"schema":{"$serde_json::private::RawValue":"[true]"}}},"data":1e9999}"#;
        for (path, expected) in [
            (
                vec![
                    "flow",
                    "steps",
                    "a",
                    "message",
                    "resources",
                    "value",
                    "value",
                ],
                r#"{"$serde_json::private::Number":"1"}"#,
            ),
            (
                vec!["bindings", "b", "schema"],
                r#"{"$serde_json::private::RawValue":"[true]"}"#,
            ),
            (vec!["data"], "1e9999"),
        ] {
            assert_eq!(at_path(source, &path).unwrap().unwrap().get(), expected);
        }
        assert!(at_path(source, &["missing"]).unwrap().is_none());
        assert!(at_path(source, &["data", "missing"]).unwrap().is_none());
        assert!(at_path(r#"{"a":1,"a":2}"#, &["a"]).is_err());
        for raw in [
            r#"{"$serde_json::private::Number":"not a number"}"#,
            r#"{"$serde_json::private::RawValue":"not JSON"}"#,
        ] {
            assert!(value(raw).unwrap().is_object());
            assert!(equal(raw, &serde_json::to_string(&value(raw).unwrap()).unwrap()).unwrap());
        }
    }
    #[test]
    fn equality_is_mathematical_and_lossless() {
        for (a, b) in [
            ("1", "1e0"),
            ("-0.00", "0"),
            ("100e-2", "1"),
            (r#"{"a":1,"b":[true,null]}"#, r#"{"b":[true,null],"a":1.0}"#),
            (
                "10e9999999999999999999999999999",
                "1e10000000000000000000000000000",
            ),
        ] {
            assert!(equal(a, b).unwrap(), "{a} != {b}");
        }
        for (a, b) in [
            ("true", "1"),
            ("9007199254740992", "9007199254740993"),
            ("1e9999", "2e9999"),
            ("[1,2]", "[2,1]"),
        ] {
            assert!(!equal(a, b).unwrap());
        }
        assert!(validate(r#"{"x":1,"x":2}"#).is_err());
        assert!(validate("1e9999").is_ok());
    }
}

/// Materialize a bounded positive native counter without passing through f64.
pub(crate) fn positive_integer(token: &str) -> Option<String> {
    let Exact::Number(canonical) = parse(token).ok()? else {
        return None;
    };
    let (digits, exponent) = canonical.split_once('e')?;
    if digits.starts_with('-') {
        return None;
    }
    let exponent: usize = exponent.parse().ok()?;
    if digits.len().checked_add(exponent)? > 4096 {
        return None;
    }
    Some(format!("{}{}", digits, "0".repeat(exponent)))
}

#[cfg(test)]
mod counter_tests {
    #[test]
    fn positive_counter_is_exact_and_bounded() {
        for (token, expected) in [
            ("1e20", "100000000000000000000"),
            ("9007199254740993", "9007199254740993"),
            ("1.20e2", "120"),
        ] {
            assert_eq!(super::positive_integer(token).as_deref(), Some(expected));
        }
        for token in [
            "0",
            "-1",
            "0.1",
            "1e999999999999999999999",
            "1e4096",
            "\"3\"",
        ] {
            assert!(super::positive_integer(token).is_none());
        }
    }
}
