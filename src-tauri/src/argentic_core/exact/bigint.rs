//! Signed integers of any size held as canonical decimal digit strings.
//! Plays the role of the JS `BigInt` values used by the exact helpers, so that
//! exponents and monotone clocks never pass through a machine number.
//! The digit-string addition and subtraction are adapted from Macro's
//! `db/exact_json.rs` and `db/agsdl_execution/v030/flow_number.rs`.
use std::cmp::Ordering;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BigInteger {
    negative: bool,
    /// Canonical magnitude: ASCII digits without leading zeros, `"0"` for zero.
    magnitude: String,
}

fn canonical(digits: &str) -> String {
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn magnitude_cmp(a: &str, b: &str) -> Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn magnitude_add(a: &str, b: &str) -> String {
    let mut out = Vec::with_capacity(a.len().max(b.len()) + 1);
    let mut left = a.bytes().rev();
    let mut right = b.bytes().rev();
    let mut carry = 0u8;
    loop {
        let x = left.next();
        let y = right.next();
        if x.is_none() && y.is_none() && carry == 0 {
            break;
        }
        let sum = x.map_or(0, |d| d - b'0') + y.map_or(0, |d| d - b'0') + carry;
        out.push(b'0' + sum % 10);
        carry = sum / 10;
    }
    out.reverse();
    canonical(&String::from_utf8_lossy(&out))
}

/// Requires `a >= b` as canonical magnitudes.
fn magnitude_sub(a: &str, b: &str) -> String {
    let mut out = Vec::with_capacity(a.len());
    let mut right = b.bytes().rev();
    let mut borrow = 0i16;
    for x in a.bytes().rev() {
        let mut digit =
            i16::from(x - b'0') - right.next().map_or(0, |d| i16::from(d - b'0')) - borrow;
        borrow = i16::from(digit < 0);
        if digit < 0 {
            digit += 10;
        }
        out.push(b'0' + digit as u8);
    }
    out.reverse();
    canonical(&String::from_utf8_lossy(&out))
}

impl BigInteger {
    pub(crate) fn zero() -> Self {
        Self {
            negative: false,
            magnitude: "0".to_owned(),
        }
    }

    fn from_parts(negative: bool, magnitude: String) -> Self {
        let negative = negative && magnitude != "0";
        Self {
            negative,
            magnitude,
        }
    }

    /// Like `BigInt(text)` for `[+-]?[0-9]+` with any leading zeros.
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let (negative, digits) = match text.as_bytes().first() {
            Some(b'-') => (true, &text[1..]),
            Some(b'+') => (false, &text[1..]),
            _ => (false, text),
        };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(Self::from_parts(negative, canonical(digits)))
    }

    /// Canonical nonnegative decimal text only (`0|[1-9][0-9]*`).
    pub(crate) fn from_canonical_unsigned(text: &str) -> Option<Self> {
        let canonical = text == "0"
            || (!text.is_empty()
                && !text.starts_with('0')
                && text.bytes().all(|b| b.is_ascii_digit()));
        canonical.then(|| Self::from_parts(false, text.to_owned()))
    }

    pub(crate) fn from_usize(value: usize) -> Self {
        Self::from_parts(false, value.to_string())
    }

    pub(crate) fn is_negative(&self) -> bool {
        self.negative
    }

    pub(crate) fn add(&self, other: &Self) -> Self {
        if self.negative == other.negative {
            return Self::from_parts(
                self.negative,
                magnitude_add(&self.magnitude, &other.magnitude),
            );
        }
        match magnitude_cmp(&self.magnitude, &other.magnitude) {
            Ordering::Less => Self::from_parts(
                other.negative,
                magnitude_sub(&other.magnitude, &self.magnitude),
            ),
            _ => Self::from_parts(
                self.negative,
                magnitude_sub(&self.magnitude, &other.magnitude),
            ),
        }
    }

    pub(crate) fn negate(&self) -> Self {
        Self::from_parts(!self.negative, self.magnitude.clone())
    }

    pub(crate) fn sub(&self, other: &Self) -> Self {
        self.add(&other.negate())
    }

    /// Fits only when nonnegative and below the platform size.
    pub(crate) fn to_usize(&self) -> Option<usize> {
        if self.negative {
            return None;
        }
        self.magnitude.parse().ok()
    }

    /// Same text as JS `BigInt.prototype.toString()`.
    pub(crate) fn to_js_string(&self) -> String {
        if self.negative {
            format!("-{}", self.magnitude)
        } else {
            self.magnitude.clone()
        }
    }
}

impl PartialOrd for BigInteger {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for BigInteger {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => magnitude_cmp(&self.magnitude, &other.magnitude),
            (true, true) => magnitude_cmp(&other.magnitude, &self.magnitude),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(text: &str) -> BigInteger {
        BigInteger::parse(text).unwrap()
    }

    #[test]
    fn arithmetic_matches_bigint_text() {
        for (a, b, sum) in [
            ("0", "0", "0"),
            ("-0", "0", "0"),
            ("999", "1", "1000"),
            ("-5", "3", "-2"),
            ("5", "-5", "0"),
            (
                "-999999999999999999999999",
                "1",
                "-999999999999999999999998",
            ),
            ("000123", "-0000124", "-1"),
            ("18446744073709551615", "1", "18446744073709551616"),
        ] {
            assert_eq!(n(a).add(&n(b)).to_js_string(), sum, "{a} + {b}");
            assert_eq!(n(sum).sub(&n(b)), n(a), "{sum} - {b}");
        }
        assert!(n("-1") < n("0") && n("-10") < n("-9") && n("10") > n("9"));
        assert_eq!(BigInteger::parse("+7").unwrap().to_js_string(), "7");
        for bad in ["", "-", "+", "1.0", " 1", "1e2", "--1"] {
            assert!(BigInteger::parse(bad).is_none(), "{bad}");
        }
        assert!(BigInteger::from_canonical_unsigned("01").is_none());
        assert!(BigInteger::from_canonical_unsigned("-1").is_none());
        assert_eq!(
            BigInteger::from_canonical_unsigned("0").unwrap(),
            BigInteger::zero()
        );
    }
}
