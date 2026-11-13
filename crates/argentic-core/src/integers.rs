//! Exact work integers of `src/services/agsdlExecution/workIntegers030.ts`.
//!
//! An `Integer030` is an authored JSON integer lexeme, exponent notation
//! included. Comparisons use coefficient and power of ten; conversion happens
//! only after an explicit bound check. JS `bigint` operands are `BigInteger`.
//! A JS caller could pass a non-string or a fractional slice; the Rust types
//! leave those cases out.
use super::error::{fail, Failure};
use super::exact::{decode, values::decimal, BigInteger, NumberToken, Value};
use std::cmp::Ordering;

/// Upper bound of a single timer slice, and its default.
pub(crate) const MAX_SLICE_MS: i64 = 2_147_483_647;

fn correlation<T>(message: &str) -> Result<T, Failure> {
    fail("CORRELATION", "", message)
}

/// `integer030(raw, positive)`: returns the lexeme as decoded, without the
/// whitespace `decode` accepts around it. `-0` is a nonnegative integer.
pub(crate) fn integer030(raw: &str, positive: bool) -> Result<String, Failure> {
    let value = decode(raw)?;
    let Value::Number(token) = &value else {
        return correlation("Expected an exact JSON integer.");
    };
    let d = decimal(token);
    if d.negative || d.exponent.is_negative() || (positive && d.digits == "0") {
        return correlation("Expected a nonnegative integer, positive when required.");
    }
    Ok(token.raw().to_owned())
}

fn validated(raw: &str) -> Result<NumberToken, Failure> {
    let lexeme = integer030(raw, false)?;
    NumberToken::lexeme(&lexeme).map_or_else(|| correlation("Expected an exact JSON integer."), Ok)
}

/// `compareIntegers030(left, right)`, validating `left` first.
pub(crate) fn compare_integers030(left: &str, right: &str) -> Result<Ordering, Failure> {
    let a = decimal(&validated(left)?);
    let b = decimal(&validated(right)?);
    if a.digits == "0" || b.digits == "0" {
        return Ok(match (a.digits == "0", b.digits == "0") {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Less,
            _ => Ordering::Greater,
        });
    }
    let al = BigInteger::from_usize(a.digits.len()).add(&a.exponent);
    let bl = BigInteger::from_usize(b.digits.len()).add(&b.exponent);
    if al != bl {
        return Ok(al.cmp(&bl));
    }
    let (x, y) = (a.digits.as_bytes(), b.digits.as_bytes());
    for i in 0..x.len().max(y.len()) {
        let (p, q) = (
            x.get(i).copied().unwrap_or(b'0'),
            y.get(i).copied().unwrap_or(b'0'),
        );
        if p != q {
            return Ok(p.cmp(&q));
        }
    }
    Ok(Ordering::Equal)
}

/// `monotoneMs030(value)`: canonical nonnegative decimal milliseconds.
pub(crate) fn monotone_ms030(value: &str) -> Result<BigInteger, Failure> {
    BigInteger::from_canonical_unsigned(value).map_or_else(
        || correlation("Expected canonical monotone milliseconds."),
        Ok,
    )
}

/// `boundedInteger030(value, bound)`: the integer as a `BigInteger`, after
/// proving it does not exceed `bound`.
pub(crate) fn bounded_integer030(value: &str, bound: &BigInteger) -> Result<BigInteger, Failure> {
    if compare_integers030(value, &bound.to_js_string())? == Ordering::Greater {
        return correlation("Exact integer exceeds the supplied bound.");
    }
    let d = decimal(&validated(value)?);
    if d.digits == "0" {
        return Ok(BigInteger::zero());
    }
    // value <= bound, so the exponent is at most the bound's digit count.
    let Some(zeros) = d.exponent.to_usize() else {
        return correlation("Exact integer exceeds the supplied bound.");
    };
    let digits = format!("{}{}", d.digits, "0".repeat(zeros));
    BigInteger::from_canonical_unsigned(&digits).map_or_else(
        || correlation("Exact integer exceeds the supplied bound."),
        Ok,
    )
}

/// `timerDelay030(limit, elapsed, maxSliceMs)`: `None` without a limit,
/// otherwise the next wait, at most one slice.
pub(crate) fn timer_delay030(
    limit: Option<&str>,
    elapsed: &BigInteger,
    max_slice_ms: i64,
) -> Result<Option<u32>, Failure> {
    if !(1..=MAX_SLICE_MS).contains(&max_slice_ms) {
        return correlation("Invalid timer slice.");
    }
    let Some(limit) = limit else {
        return Ok(None);
    };
    if compare_integers030(limit, &elapsed.to_js_string())? != Ordering::Greater {
        return Ok(Some(0));
    }
    let slice = BigInteger::parse(&max_slice_ms.to_string()).unwrap_or_else(BigInteger::zero);
    let bound = elapsed.add(&slice);
    if compare_integers030(limit, &bound.to_js_string())? == Ordering::Greater {
        return Ok(Some(max_slice_ms as u32));
    }
    let remaining = bounded_integer030(limit, &bound)?.sub(elapsed);
    remaining
        .to_usize()
        .and_then(|ms| u32::try_from(ms).ok())
        .map_or_else(|| correlation("Invalid timer slice."), |ms| Ok(Some(ms)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big(text: &str) -> BigInteger {
        BigInteger::parse(text).unwrap()
    }

    #[test]
    fn integers_follow_the_ts_vectors() {
        // src/services/agsdlExecution/agentWork030.test.ts
        assert_eq!(
            compare_integers030("1e999999999999999999999", "9007199254740993").unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare_integers030("1.00e2", "100").unwrap(),
            Ordering::Equal
        );
        assert_eq!(
            timer_delay030(Some("1e999999999999999999999"), &big("20"), MAX_SLICE_MS).unwrap(),
            Some(2_147_483_647)
        );
        assert_eq!(
            timer_delay030(Some("1e2"), &big("99"), MAX_SLICE_MS).unwrap(),
            Some(1)
        );
        assert_eq!(
            timer_delay030(None, &big("99"), MAX_SLICE_MS).unwrap(),
            None
        );
        assert_eq!(timer_delay030(Some("5"), &big("9"), 10).unwrap(), Some(0));
        assert_eq!(
            timer_delay030(Some("5"), &big("-9"), 10)
                .unwrap_err()
                .message,
            "Expected a nonnegative integer, positive when required."
        );
        assert_eq!(
            timer_delay030(Some("5"), &big("0"), 0).unwrap_err().message,
            "Invalid timer slice."
        );
    }

    #[test]
    fn failures_keep_code_pointer_and_message() {
        assert_eq!(integer030(" 1e2 ", true).unwrap(), "1e2");
        assert_eq!(integer030("-0", false).unwrap(), "-0");
        assert_eq!(
            integer030("0", true).unwrap_err(),
            Failure::new(
                "CORRELATION",
                "",
                "Expected a nonnegative integer, positive when required."
            )
        );
        assert_eq!(
            integer030("\"1\"", false).unwrap_err(),
            Failure::new("CORRELATION", "", "Expected an exact JSON integer.")
        );
        assert_eq!(
            integer030("01", false).unwrap_err(),
            Failure::new("PARSE", "", "Invalid or unsupported exact JSON.")
        );
        assert_eq!(integer030("1.5", false).unwrap_err().code, "CORRELATION");
        assert_eq!(
            monotone_ms030("012").unwrap_err().message,
            "Expected canonical monotone milliseconds."
        );
        assert_eq!(
            monotone_ms030("12345678901234567890123")
                .unwrap()
                .to_js_string(),
            "12345678901234567890123"
        );
        assert_eq!(
            bounded_integer030("18446744073709551615", &big("18446744073709551615"))
                .unwrap()
                .to_js_string(),
            "18446744073709551615"
        );
        assert_eq!(
            bounded_integer030("1.8446744073709551616e19", &big("18446744073709551615"))
                .unwrap_err()
                .message,
            "Exact integer exceeds the supplied bound."
        );
        assert_eq!(
            bounded_integer030("12e1", &big("-1")).unwrap_err().message,
            "Expected a nonnegative integer, positive when required."
        );
    }
}
