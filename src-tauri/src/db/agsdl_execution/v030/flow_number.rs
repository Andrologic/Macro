//! Integer JSON limits without machine-number conversion or exponent expansion.
use std::cmp::Ordering;

pub fn canonical(s: &str) -> bool {
    s == "0" || (!s.is_empty() && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit()))
}
pub fn cmp(a: &str, b: &str) -> Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}
pub fn add(a: &str, b: &str) -> String {
    let mut out = Vec::new();
    let mut ai = a.bytes().rev();
    let mut bi = b.bytes().rev();
    let mut carry = 0;
    loop {
        let x = ai.next();
        let y = bi.next();
        if x.is_none() && y.is_none() && carry == 0 {
            break;
        }
        let n = x.map_or(0, |b| b - b'0') + y.map_or(0, |b| b - b'0') + carry;
        out.push(b'0' + n % 10);
        carry = n / 10;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}
pub fn increment(s: &str) -> String {
    add(s, "1")
}
fn sub(a: &str, b: &str) -> String {
    debug_assert!(cmp(a, b) != Ordering::Less);
    let mut bi = b.bytes().rev();
    let mut borrow = 0i16;
    let mut out = Vec::new();
    for x in a.bytes().rev() {
        let n = (x - b'0') as i16 - bi.next().map_or(0, |b| (b - b'0') as i16) - borrow;
        borrow = i16::from(n < 0);
        out.push(b'0' + n.rem_euclid(10) as u8);
    }
    while out.len() > 1 && out.last() == Some(&b'0') {
        out.pop();
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}
fn trim(s: &str) -> &str {
    let t = s.trim_start_matches('0');
    if t.is_empty() {
        "0"
    } else {
        t
    }
}
#[derive(Debug, Clone)]
pub struct Limit {
    digits: String,
    zeros: String,
}
impl Limit {
    pub fn parse(json: &str) -> Option<Self> {
        let s = json.trim();
        if !serde_json::from_str::<serde_json::Value>(s)
            .ok()?
            .is_number()
            || s.starts_with('-')
        {
            return None;
        }
        let (mantissa, exp) = s.split_once(['e', 'E']).unwrap_or((s, "0"));
        let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let raw = format!("{whole}{fraction}");
        let raw = raw.trim_start_matches('0');
        if raw.is_empty() {
            return None;
        }
        let digits = raw.trim_end_matches('0');
        let trailing = raw.len() - digits.len();
        let exp_negative = exp.starts_with('-');
        let magnitude = trim(exp.trim_start_matches(['-', '+']));
        let positive = add(
            if exp_negative { "0" } else { magnitude },
            &trailing.to_string(),
        );
        let negative = add(
            if exp_negative { magnitude } else { "0" },
            &fraction.len().to_string(),
        );
        if cmp(&positive, &negative) == Ordering::Less {
            return None;
        }
        Some(Self {
            digits: digits.to_string(),
            zeros: sub(&positive, &negative),
        })
    }
    /// Compare an arbitrary canonical nonnegative counter with this positive limit.
    pub fn compare_counter(&self, counter: &str) -> Ordering {
        let length = add(&self.digits.len().to_string(), &self.zeros);
        let order = cmp(&counter.len().to_string(), &length);
        if order != Ordering::Equal {
            return order;
        }
        for (i, b) in counter.bytes().enumerate() {
            let other = self.digits.as_bytes().get(i).copied().unwrap_or(b'0');
            if b != other {
                return b.cmp(&other);
            }
        }
        Ordering::Equal
    }
}
pub fn exceeds(counter: &str, limit: &Option<String>) -> bool {
    limit
        .as_ref()
        .is_some_and(|s| Limit::parse(s).unwrap().compare_counter(counter) == Ordering::Greater)
}
