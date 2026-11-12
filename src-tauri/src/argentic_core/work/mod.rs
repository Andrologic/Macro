//! Pure work controller and journal, ported from Macro's 030 work evaluators.
//! Decoding ordinary JSON uses the explicit pure port. This module neither
//! executes effects nor establishes native ownership or physical termination.
mod controller;
mod journal;
mod submission;
use crate::argentic_core::{
    exact,
    native::{self, o, s, Text, Value},
};
pub(crate) use controller::{assemble_visible_text, Controller};
pub(crate) use journal::{evaluate_host, evaluate_journal, EMPTY_JOURNAL};
pub(crate) use submission::{requires_submission, validate_submission};

#[derive(Clone, Debug)]
pub(crate) enum Error {
    Failure(native::Error),
    Exception { name: Text, message: Text },
}
pub(crate) type Result<T> = std::result::Result<T, Error>;
impl From<native::Error> for Error {
    fn from(e: native::Error) -> Self {
        Self::Failure(e)
    }
}
impl From<crate::argentic_core::error::Failure> for Error {
    fn from(e: crate::argentic_core::error::Failure) -> Self {
        Self::Failure(e.into())
    }
}
impl From<native::SyntaxError> for Error {
    fn from(e: native::SyntaxError) -> Self {
        Self::Exception {
            name: Text::from("SyntaxError"),
            message: e.message,
        }
    }
}
pub(crate) fn exception<T>(name: &str, message: impl Into<Text>) -> Result<T> {
    Err(Error::Exception {
        name: Text::from(name),
        message: message.into(),
    })
}
fn plain<T>(message: &str) -> Result<T> {
    exception("Error", message)
}
fn correlation<T>(p: &str, message: &str) -> Result<T> {
    Err(native::Error::new("CORRELATION", p, message).into())
}
fn text(v: &Value) -> Result<&Text> {
    v.text().ok_or_else(|| Error::Exception {
        name: Text::from("TypeError"),
        message: Text::from("Expected text."),
    })
}
fn exact_text(v: &Text) -> Result<exact::Value> {
    let Some(raw) = v.utf8() else {
        return Err(native::Error::new("PARSE", "", "Invalid or unsupported exact JSON.").into());
    };
    Ok(exact::decode(&raw)?)
}
fn native_string(v: &Value) -> Text {
    match v {
        Value::String(t) => t.clone(),
        Value::Undefined => Text::from("undefined"),
        Value::Number(native::Number::PositiveInfinity) => Text::from("Infinity"),
        Value::Number(native::Number::NegativeInfinity) => Text::from("-Infinity"),
        Value::Number(native::Number::NaN) => Text::from("NaN"),
        Value::Object(_) => Text::from("[object Object]"),
        Value::Array(a) => {
            let mut out = Text::default();
            for (i, v) in a.iter().enumerate() {
                if i > 0 {
                    out.push(&Text::from(","));
                }
                if !v.is_nullish() {
                    out.push(&native_string(v));
                }
            }
            out
        }
        _ => Text::from(v.stringify()),
    }
}
fn parse(decoder: &impl native::JsonDecoder, v: &Value) -> Result<Value> {
    Ok(decoder.parse(&native_string(v))?)
}
fn is_true(v: &Value) -> bool {
    matches!(v, Value::Bool(true))
}
fn identity(v: &Value) -> Result<()> {
    if v.text().is_none_or(Text::trimmed_empty) {
        correlation("", "Work identity must be a nonempty string.")
    } else {
        Ok(())
    }
}
fn same(l: &Value, r: &Value) -> bool {
    native::equal(l, r)
}
fn diagnostic(pointer: &str, rule: &str, message: &str) -> Value {
    o([
        ("pointer", s(pointer)),
        ("rule", s(rule)),
        ("message", s(message)),
    ])
}
fn safe_integer(v: &Value) -> bool {
    let Value::Number(native::Number::Finite(raw)) = v else {
        return false;
    };
    let Ok(value) = exact::decode(raw) else {
        return false;
    };
    let Some(n) = value.as_number() else {
        return false;
    };
    let d = exact::values::decimal(n);
    if d.exponent.is_negative() {
        return false;
    }
    let magnitude = raw.trim_start_matches('-');
    crate::argentic_core::integers::compare_integers030(magnitude, "9007199254740991")
        .is_ok_and(|o| o != std::cmp::Ordering::Greater)
}
fn integer_string(v: &Value, positive: bool) -> Result<String> {
    let Some(value) = v.text() else {
        return correlation("", "Expected an exact integer lexeme.");
    };
    let Some(raw) = value.utf8() else {
        return Err(native::Error::new("PARSE", "", "Invalid or unsupported exact JSON.").into());
    };
    Ok(crate::argentic_core::integers::integer030(&raw, positive)?)
}
fn counter_next(counter: &mut exact::BigInteger) -> String {
    *counter = counter.add(&exact::BigInteger::from_usize(1));
    counter.to_js_string()
}
fn instructions(v: Option<&exact::Value>) -> Value {
    match v {
        None => Value::Null,
        Some(exact::Value::String(t)) => s(t.clone()),
        Some(exact::Value::Array(a)) => native::a(a.iter().map(|v| instructions(Some(v)))),
        _ => Value::Null,
    }
}

fn access(value: &Value, expression: &str) -> Result<()> {
    if value.is_nullish() {
        exception(
            "TypeError",
            format!(
                "{} is not an object (evaluating '{expression}')",
                if matches!(value, Value::Null) {
                    "null"
                } else {
                    "undefined"
                }
            ),
        )
    } else {
        Ok(())
    }
}
fn trimmed(value: &Value, expression: &str, optional: bool) -> Result<bool> {
    if !optional {
        access(value, expression)?;
    }
    if let Some(text) = value.text() {
        return Ok(text.trimmed_empty());
    }
    exception(
        "TypeError",
        format!(
            "{expression} is not a function. (In '{expression}()', '{expression}' is undefined)"
        ),
    )
}
