// SPDX-License-Identifier: Apache-2.0
//! Exact value helpers. Rust translation of `src/vendor/agsdl/shared/values.mjs`
//! and the `uint` helper of `shared/json.mjs` (AgSDL 0.2.0), and of
//! `src/vendor/agsdl/v0.3/values.mjs` (port of AgSDL 0.3.0 schemacheck.py).
//! Provenance and license: `src/vendor/agsdl/NOTICE.md`,
//! `src/vendor/agsdl/LICENSE`, `src/vendor/agsdl/v0.3/LICENSE`.
//!
//! Numbers are compared through a coefficient and a power of ten, with digit
//! strings and `BigInteger` exponents: no machine number and no expansion of an
//! exponent into zeros. The shared and 0.3 helpers stay separate functions
//! because they normalize zero differently.
use super::{quote, scan::js_object_order, BigInteger, NumberToken, Object, Value};
use std::cmp::Ordering;

struct Lexeme<'a> {
    negative: bool,
    integer: &'a str,
    fraction: &'a str,
    exponent: Option<&'a str>,
}

/// Splits a lexeme of the JSON number grammar, the only kind a `NumberToken`
/// holds.
fn split(raw: &str) -> Lexeme<'_> {
    let (negative, rest) = raw
        .strip_prefix('-')
        .map_or((false, raw), |rest| (true, rest));
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], Some(&rest[at + 1..])),
        None => (rest, None),
    };
    let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    Lexeme {
        negative,
        integer,
        fraction,
        exponent,
    }
}

fn exponent_of(lexeme: &Lexeme<'_>) -> BigInteger {
    lexeme
        .exponent
        .and_then(BigInteger::parse)
        .unwrap_or_else(BigInteger::zero)
}

fn fraction_length(lexeme: &Lexeme<'_>) -> BigInteger {
    BigInteger::from_usize(lexeme.fraction.len())
}

/// `[sign, digits, exponent]` of the shared `decimal`. Zero is `['', '0', 0n]`
/// whatever its sign or exponent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SharedDecimal {
    pub(crate) negative: bool,
    pub(crate) digits: String,
    pub(crate) exponent: BigInteger,
}

impl SharedDecimal {
    /// The JS sign element: `'-'` or `''`.
    pub(crate) fn sign(&self) -> &'static str {
        if self.negative {
            "-"
        } else {
            ""
        }
    }
}

/// Shared `decimal(x)`.
pub(crate) fn decimal(token: &NumberToken) -> SharedDecimal {
    let lexeme = split(token.raw());
    let joined = format!("{}{}", lexeme.integer, lexeme.fraction);
    let digits = joined.trim_start_matches('0');
    let exponent = exponent_of(&lexeme).sub(&fraction_length(&lexeme));
    if digits.is_empty() {
        return SharedDecimal {
            negative: false,
            digits: "0".to_owned(),
            exponent: BigInteger::zero(),
        };
    }
    let significant = digits.trim_end_matches('0');
    let tail = BigInteger::from_usize(digits.len() - significant.len());
    SharedDecimal {
        negative: lexeme.negative,
        digits: significant.to_owned(),
        exponent: exponent.add(&tail),
    }
}

/// Shared `integer(x)`: a number whose normalized exponent is not negative.
pub(crate) fn integer(value: &Value) -> bool {
    matches!(value, Value::Number(token) if !decimal(token).exponent.is_negative())
}

/// Shared JSON `uint(v, positive)`: a nonnegative integer at most
/// `Number.MAX_SAFE_INTEGER`, with at most 16 significant positions.
pub(crate) fn uint(value: &Value, positive: bool) -> bool {
    let Value::Number(token) = value else {
        return false;
    };
    let lexeme = split(token.raw());
    let joined = format!("{}{}", lexeme.integer, lexeme.fraction);
    let mut digits = joined.trim_start_matches('0').to_owned();
    if digits.is_empty() {
        return !positive;
    }
    if lexeme.negative {
        return false;
    }
    let power = exponent_of(&lexeme).sub(&fraction_length(&lexeme));
    if !power.is_negative() {
        if BigInteger::from_usize(digits.len()).add(&power) > BigInteger::from_usize(16) {
            return false;
        }
        let Some(zeros) = power.to_usize() else {
            return false;
        };
        digits.push_str(&"0".repeat(zeros));
    } else {
        let Some(count) = power
            .negate()
            .to_usize()
            .filter(|count| *count <= digits.len())
        else {
            return false;
        };
        let keep = digits.len() - count;
        if !digits[keep..].bytes().all(|b| b == b'0') {
            return false;
        }
        digits.truncate(keep);
    }
    let digits = if digits.is_empty() {
        "0"
    } else {
        digits.as_str()
    };
    digits.len() < 16 || (digits.len() == 16 && digits <= "9007199254740991")
}

/// Shared `clone(x)`: objects become ordinary JS objects, so array-index keys
/// move first. Iterative.
pub(crate) fn clone(value: &Value) -> Value {
    enum Work<'a> {
        Visit(&'a Value),
        Array(usize),
        Object(Vec<&'a str>),
    }
    let mut work = vec![Work::Visit(value)];
    let mut done: Vec<Value> = Vec::new();
    while let Some(task) = work.pop() {
        match task {
            Work::Visit(value) => match value {
                Value::Null => done.push(Value::Null),
                Value::Bool(b) => done.push(Value::Bool(*b)),
                Value::String(s) => done.push(Value::String(s.clone())),
                Value::Number(token) => done.push(Value::Number(token.clone())),
                Value::Array(items) => {
                    work.push(Work::Array(items.len()));
                    work.extend(items.iter().rev().map(Work::Visit));
                }
                Value::Object(object) => {
                    work.push(Work::Object(object.iter().map(|(key, _)| key).collect()));
                    work.extend(object.iter().rev().map(|(_, value)| Work::Visit(value)));
                }
            },
            Work::Array(count) => {
                let items = done.split_off(done.len() - count);
                done.push(Value::Array(items));
            }
            Work::Object(keys) => {
                let values = done.split_off(done.len() - keys.len());
                let entries = keys.into_iter().map(str::to_owned).zip(values).collect();
                done.push(Value::Object(Object::from_unique_entries(js_object_order(
                    entries,
                ))));
            }
        }
    }
    done.pop().unwrap_or(Value::Null)
}

/// Shared `equal(a, b)`: structural, numbers by their shared decimal triple.
pub(crate) fn equal(left: &Value, right: &Value) -> bool {
    let mut pending = vec![(left, right)];
    while let Some((a, b)) = pending.pop() {
        match (a, b) {
            (Value::Number(a), Value::Number(b)) => {
                if decimal(a) != decimal(b) {
                    return false;
                }
            }
            (Value::Array(a), Value::Array(b)) => {
                if a.len() != b.len() {
                    return false;
                }
                pending.extend(a.iter().zip(b));
            }
            (Value::Object(a), Value::Object(b)) => {
                if !same_keys(a, b, &mut pending) {
                    return false;
                }
            }
            (Value::Null, Value::Null) => {}
            (Value::Bool(a), Value::Bool(b)) if a == b => {}
            (Value::String(a), Value::String(b)) if a == b => {}
            _ => return false,
        }
    }
    true
}

fn same_keys<'a>(a: &'a Object, b: &'a Object, pending: &mut Vec<(&'a Value, &'a Value)>) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (key, value) in a.iter() {
        let Some(other) = b.get(key) else {
            return false;
        };
        pending.push((value, other));
    }
    true
}

/// Shared `stringify(v)` and 0.3 `stringify(value)`. They print the same text
/// for every `Value`: the 0.3 refusals (non-JSON lexeme, unpaired surrogate,
/// holes, cycles, non-JSON JS values) cannot occur in this type. Iterative.
pub(crate) fn stringify(value: &Value) -> String {
    enum Task<'a> {
        Value(&'a Value),
        Text(&'static str),
        Key(&'a str),
    }
    let mut out = String::new();
    let mut pending = vec![Task::Value(value)];
    while let Some(task) = pending.pop() {
        match task {
            Task::Text(text) => out.push_str(text),
            Task::Key(key) => {
                out.push_str(&quote(key));
                out.push(':');
            }
            Task::Value(value) => match value {
                Value::Null => out.push_str("null"),
                Value::Bool(true) => out.push_str("true"),
                Value::Bool(false) => out.push_str("false"),
                Value::Number(token) => out.push_str(token.raw()),
                Value::String(text) => out.push_str(&quote(text)),
                Value::Array(items) => {
                    out.push('[');
                    pending.push(Task::Text("]"));
                    for (index, item) in items.iter().enumerate().rev() {
                        pending.push(Task::Value(item));
                        if index > 0 {
                            pending.push(Task::Text(","));
                        }
                    }
                }
                Value::Object(object) => {
                    out.push('{');
                    pending.push(Task::Text("}"));
                    for (index, (key, item)) in object.iter().enumerate().rev() {
                        pending.push(Task::Value(item));
                        pending.push(Task::Key(key));
                        if index > 0 {
                            pending.push(Task::Text(","));
                        }
                    }
                }
            },
        }
    }
    out
}

/// A number operand of the 0.3 helpers: an authored token, or an internal JS
/// number, which the callers use only for list lengths, indices and `0`/`1`.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Num<'a> {
    Token(&'a NumberToken),
    Host(usize),
}

impl Num<'_> {
    /// `stringify` of the operand: the lexeme, or `String(n)`.
    pub(crate) fn text(&self) -> String {
        match self {
            Num::Token(token) => token.raw().to_owned(),
            Num::Host(value) => value.to_string(),
        }
    }
}

/// `{ sign, digits, power }` of the 0.3 `decimal`.
struct V030Decimal {
    sign: i8,
    digits: String,
    power: BigInteger,
}

fn decimal_v030(number: Num<'_>) -> V030Decimal {
    let text = number.text();
    let lexeme = split(&text);
    let joined = format!("{}{}", lexeme.integer, lexeme.fraction);
    let digits = joined.trim_start_matches('0');
    if digits.is_empty() {
        return V030Decimal {
            sign: 0,
            digits: "0".to_owned(),
            power: BigInteger::zero(),
        };
    }
    let trimmed = digits.trim_end_matches('0');
    let power = exponent_of(&lexeme)
        .sub(&fraction_length(&lexeme))
        .add(&BigInteger::from_usize(digits.len() - trimmed.len()));
    V030Decimal {
        sign: if lexeme.negative { -1 } else { 1 },
        digits: trimmed.to_owned(),
        power,
    }
}

/// 0.3 `compareNumbers(left, right)`.
pub(crate) fn compare_numbers(left: Num<'_>, right: Num<'_>) -> Ordering {
    let a = decimal_v030(left);
    let b = decimal_v030(right);
    if a.sign != b.sign {
        return a.sign.cmp(&b.sign);
    }
    if a.sign == 0 {
        return Ordering::Equal;
    }
    let directed = |order: Ordering| if a.sign < 0 { order.reverse() } else { order };
    let order_a = BigInteger::from_usize(a.digits.len()).add(&a.power);
    let order_b = BigInteger::from_usize(b.digits.len()).add(&b.power);
    if order_a != order_b {
        return directed(order_a.cmp(&order_b));
    }
    let (x, y) = (a.digits.as_bytes(), b.digits.as_bytes());
    for i in 0..x.len().max(y.len()) {
        let (p, q) = (
            x.get(i).copied().unwrap_or(b'0'),
            y.get(i).copied().unwrap_or(b'0'),
        );
        if p != q {
            return directed(p.cmp(&q));
        }
    }
    Ordering::Equal
}

/// 0.3 `compareNumbers` result as the JS `-1 | 0 | 1`.
pub(crate) fn ordering_number(order: Ordering) -> i8 {
    match order {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

/// 0.3 `isInteger` of a number operand.
pub(crate) fn is_integer_number(number: Num<'_>) -> bool {
    let n = decimal_v030(number);
    n.sign == 0 || !n.power.is_negative()
}

/// 0.3 `isInteger(value)`.
pub(crate) fn is_integer(value: &Value) -> bool {
    matches!(value, Value::Number(token) if is_integer_number(Num::Token(token)))
}

/// 0.3 `json_type_matches(value, name)`.
pub(crate) fn json_type_matches(value: &Value, name: &str) -> bool {
    match name {
        "null" => matches!(value, Value::Null),
        "boolean" => matches!(value, Value::Bool(_)),
        "number" => matches!(value, Value::Number(_)),
        "integer" => is_integer(value),
        "string" => matches!(value, Value::String(_)),
        "array" => matches!(value, Value::Array(_)),
        "object" => matches!(value, Value::Object(_)),
        _ => false,
    }
}

/// 0.3 `equal(left, right)`: structural, numbers by `compareNumbers`.
pub(crate) fn equal_v030(left: &Value, right: &Value) -> bool {
    let mut pending = vec![(left, right)];
    while let Some((a, b)) = pending.pop() {
        match (a, b) {
            (Value::Number(a), Value::Number(b)) => {
                if compare_numbers(Num::Token(a), Num::Token(b)) != Ordering::Equal {
                    return false;
                }
            }
            (Value::Array(a), Value::Array(b)) => {
                if a.len() != b.len() {
                    return false;
                }
                pending.extend(a.iter().zip(b));
            }
            (Value::Object(a), Value::Object(b)) => {
                if !same_keys(a, b, &mut pending) {
                    return false;
                }
            }
            (Value::Null, Value::Null) => {}
            (Value::Bool(a), Value::Bool(b)) if a == b => {}
            (Value::String(a), Value::String(b)) if a == b => {}
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(raw: &str) -> NumberToken {
        NumberToken::lexeme(raw).unwrap()
    }

    #[test]
    fn exact_comparisons_from_the_ts_suite() {
        // src/vendor/agsdl/v0.3/exact.test.ts
        for (a, b, order) in [
            ("9007199254740993", "9007199254740992", 1),
            ("1.00000000000000000001", "1.00000000000000000002", -1),
            ("1", "1.0", 0),
            ("1.0", "1e0", 0),
            ("-0e99999999999", "0", 0),
            (
                "1e999999999999999999999999",
                "9e999999999999999999999998",
                1,
            ),
            (
                "1e-999999999999999999999999",
                "9e-999999999999999999999998",
                -1,
            ),
            ("-2e100000000000000000000", "-1e100000000000000000000", -1),
            ("1200", "12e2", 0),
            ("1.20", "1.20001", -1),
            ("-0.1", "0", -1),
        ] {
            let (x, y) = (n(a), n(b));
            assert_eq!(
                ordering_number(compare_numbers(Num::Token(&x), Num::Token(&y))),
                order,
                "{a} {b}"
            );
            assert_eq!(
                ordering_number(compare_numbers(Num::Token(&y), Num::Token(&x))),
                -order
            );
            assert_eq!(
                equal_v030(&Value::Number(x.clone()), &Value::Number(y.clone())),
                order == 0
            );
            assert_eq!(equal(&Value::Number(x), &Value::Number(y)), order == 0);
        }
        assert_eq!(
            compare_numbers(Num::Token(&n("2e0")), Num::Host(2)),
            Ordering::Equal
        );
        for raw in [
            "0",
            "-0.000e-99999999999999999999",
            "1.00",
            "0.01e2",
            "-42",
            "1e999999999999999999999",
        ] {
            assert!(is_integer(&Value::Number(n(raw))), "{raw}");
        }
        for raw in ["1.01", "1e-99999999999999999999", "1001e-3"] {
            assert!(!is_integer(&Value::Number(n(raw))), "{raw}");
        }
    }

    #[test]
    fn shared_decimal_and_uint() {
        // src/services/agsdlExecution/exact.test.ts
        let d = decimal(&n("1200e-2"));
        assert_eq!(
            (d.sign(), d.digits.as_str(), d.exponent.to_js_string()),
            ("", "12", "0".to_owned())
        );
        let z = decimal(&n("-0.00e999999"));
        assert_eq!(
            (z.sign(), z.digits.as_str(), z.exponent.to_js_string()),
            ("", "0", "0".to_owned())
        );
        let m = decimal(&n("-1.50e-7"));
        assert_eq!(
            (m.sign(), m.digits.as_str(), m.exponent.to_js_string()),
            ("-", "15", "-8".to_owned())
        );
        for (raw, positive, expected) in [
            ("0", false, true),
            ("0", true, false),
            ("-0", false, true),
            ("9007199254740991", true, true),
            ("9007199254740992", true, false),
            ("9.007199254740991e15", true, true),
            ("1e16", true, false),
            ("1e15", true, true),
            ("1.5", true, false),
            ("150e-1", true, true),
            ("1e-1", true, false),
            ("-1", false, false),
        ] {
            assert_eq!(
                uint(&Value::Number(n(raw)), positive),
                expected,
                "{raw} {positive}"
            );
        }
        assert!(!uint(&Value::String("1".into()), false));
    }
}
