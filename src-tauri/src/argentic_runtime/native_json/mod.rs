//! Explicit ordinary JSON boundary. Native numeric conversion happens here,
//! outside the pure core, and never touches an authored NumberToken.
use crate::argentic_core::native::{JsonDecoder, Number, SyntaxError, Text, Value};
mod syntax;
use serde::{
    de::{MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::value::RawValue;
use std::fmt;
#[derive(Debug)]
pub(crate) struct Error(pub(crate) String);
struct Bytes(Vec<u8>);
impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Bytes;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("native JSON string")
            }
            fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Bytes, E> {
                Ok(Bytes(v.to_vec()))
            }
            fn visit_byte_buf<E: serde::de::Error>(self, v: Vec<u8>) -> Result<Bytes, E> {
                Ok(Bytes(v))
            }
        }
        d.deserialize_bytes(V)
    }
}
fn text(bytes: &[u8]) -> Text {
    let mut units = vec![];
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let (n, mut scalar) = if b < 128 {
            (1, u32::from(b))
        } else if b < 224 {
            (2, u32::from(b & 31))
        } else if b < 240 {
            (3, u32::from(b & 15))
        } else {
            (4, u32::from(b & 7))
        };
        for k in 1..n {
            scalar = (scalar << 6) | u32::from(bytes[i + k] & 63);
        }
        if scalar <= 65535 {
            units.push(scalar as u16)
        } else {
            let v = scalar - 65536;
            units.push(0xd800 + (v >> 10) as u16);
            units.push(0xdc00 + (v & 1023) as u16);
        }
        i += n;
    }
    Text::from_units(units)
}
struct Members<'a>(Vec<(Text, &'a RawValue)>);
impl<'de> Deserialize<'de> for Members<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Members<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("native JSON object")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut entries = vec![];
                while let Some((key, value)) = map.next_entry::<Bytes, &RawValue>()? {
                    entries.push((text(&key.0), value));
                }
                Ok(Members(entries))
            }
        }
        d.deserialize_map(V)
    }
}
/// Shortest decimal digits from the locked serializer, with JS presentation
/// rules applied explicitly. The digits are not rounded a second time.
pub(crate) fn number_text(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let raw = serde_json::to_string(&value).expect("finite native scalar");
    let negative = raw.starts_with('-');
    let body = raw.trim_start_matches('-');
    let (mantissa, exp) = body
        .split_once(['e', 'E'])
        .map_or((body, 0), |(m, e)| (m, e.parse::<i32>().unwrap()));
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let mut digits = mantissa.replace('.', "");
    let zeros = digits.bytes().take_while(|b| *b == b'0').count();
    digits.drain(..zeros);
    let position = point + exp - zeros as i32;
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    let sign = if negative { "-" } else { "" };
    let len = digits.len() as i32;
    if position > 0 && position <= 21 {
        if position >= len {
            format!("{sign}{digits}{}", "0".repeat((position - len) as usize))
        } else {
            format!(
                "{sign}{}.{}",
                &digits[..position as usize],
                &digits[position as usize..]
            )
        }
    } else if position <= 0 && position > -6 {
        format!("{sign}0.{}{digits}", "0".repeat((-position) as usize))
    } else {
        let exponent = position - 1;
        let significand = if digits.len() == 1 {
            digits
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!(
            "{sign}{significand}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        )
    }
}
pub(crate) fn from_number(value: f64) -> Value {
    let n = if value.is_nan() {
        Number::NaN
    } else if value == f64::INFINITY {
        Number::PositiveInfinity
    } else if value == f64::NEG_INFINITY {
        Number::NegativeInfinity
    } else {
        Number::finite(if value == 0.0 && value.is_sign_negative() {
            "-0".into()
        } else {
            number_text(value)
        })
        .expect("canonical native decimal")
    };
    Value::Number(n)
}
pub(crate) fn decimal_bits(raw: &str) -> Result<u64, Error> {
    raw.parse::<f64>()
        .map(f64::to_bits)
        .map_err(|e| Error(e.to_string()))
}
pub(crate) fn bits_text(bits: u64) -> String {
    number_text(f64::from_bits(bits))
}
pub(crate) fn parse(raw: &str) -> Result<Value, Error> {
    let root: &RawValue = serde_json::from_str(raw).map_err(|e| Error(e.to_string()))?;
    enum Task<'a> {
        Visit(&'a RawValue),
        Array(usize),
        Object(Vec<Text>),
    }
    let mut tasks = vec![Task::Visit(root)];
    let mut values = vec![];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Visit(raw) => {
                let json = raw.get();
                match json.as_bytes()[0] {
                    b'n' => values.push(Value::Null),
                    b't' => values.push(Value::Bool(true)),
                    b'f' => values.push(Value::Bool(false)),
                    b'"' => {
                        let bytes: Bytes =
                            serde_json::from_str(json).map_err(|e| Error(e.to_string()))?;
                        values.push(Value::String(text(&bytes.0)));
                    }
                    b'[' => {
                        let items: Vec<&RawValue> =
                            serde_json::from_str(json).map_err(|e| Error(e.to_string()))?;
                        tasks.push(Task::Array(items.len()));
                        tasks.extend(items.into_iter().rev().map(Task::Visit));
                    }
                    b'{' => {
                        let Members(entries) =
                            serde_json::from_str(json).map_err(|e| Error(e.to_string()))?;
                        tasks.push(Task::Object(
                            entries.iter().map(|(k, _)| k.clone()).collect(),
                        ));
                        tasks.extend(entries.into_iter().rev().map(|(_, v)| Task::Visit(v)));
                    }
                    _ => values.push(from_number(
                        json.parse::<f64>().map_err(|e| Error(e.to_string()))?,
                    )),
                }
            }
            Task::Array(n) => {
                let items = values.split_off(values.len() - n);
                values.push(Value::Array(items));
            }
            Task::Object(keys) => {
                let items = values.split_off(values.len() - keys.len());
                let mut object = Value::Object(vec![]);
                for (k, v) in keys.into_iter().zip(items) {
                    object.set(k, v);
                }
                values.push(object);
            }
        }
    }
    Ok(values.pop().unwrap())
}

/// The integrated codec implements the core's durable, pure decoding port.
pub(crate) struct Decoder;
impl JsonDecoder for Decoder {
    fn parse(&self, raw: &Text) -> Result<Value, SyntaxError> {
        syntax::validate(raw)?;
        // Literal isolated UTF-16 units are legal inside ordinary JSON strings.
        // Escape units before the byte parser, without repairing their value.
        let mut bytes = String::new();
        for &unit in raw.units() {
            if unit < 128 {
                bytes.push(char::from_u32(u32::from(unit)).unwrap());
            } else {
                bytes.push_str(&format!("\\u{unit:04x}"));
            }
        }
        parse(&bytes).map_err(|e| SyntaxError {
            message: Text::from(e.0),
        })
    }
}
