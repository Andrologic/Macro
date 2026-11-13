//! Native scalar conversion; authored number tokens never enter this module.
#[derive(Debug)]
pub(crate) struct Error(pub(crate) String);
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
pub(crate) fn decimal_bits(raw: &str) -> Result<u64, Error> {
    raw.parse::<f64>()
        .map(f64::to_bits)
        .map_err(|e| Error(e.to_string()))
}
pub(crate) fn bits_text(bits: u64) -> String {
    number_text(f64::from_bits(bits))
}

pub(crate) fn normalize(raw: &str) -> Result<String, String> {
    let value = raw.parse::<f64>().map_err(|e| e.to_string())?;
    Ok(if value.is_nan() {
        "NaN".into()
    } else if value == f64::INFINITY {
        "Infinity".into()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".into()
    } else if value == 0.0 && value.is_sign_negative() {
        "-0".into()
    } else {
        number_text(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locked_native_rounding_and_presentation_are_preserved() {
        for (raw, expected) in [
            ("9007199254740993", "9007199254740992"),
            ("-0", "-0"),
            ("1e309", "Infinity"),
            ("-1e309", "-Infinity"),
            ("1e-7", "1e-7"),
            ("1e-6", "0.000001"),
            ("1e21", "1e+21"),
        ] {
            assert_eq!(normalize(raw).unwrap(), expected, "{raw}");
        }
    }
}
