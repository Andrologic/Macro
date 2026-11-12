//! Independent decimal and binary corpora. Midpoints are computed as exact
//! integers and powers of five, never by converting the text under test first.
use crate::argentic_core::exact::BigInteger;
use serde_json::{json, Value};
pub(super) const SEED: u64 = 0x2c3a_0303_5eed;
pub(super) const MINIMUMS: &[(&str, usize)] = &[
    ("bits-boundary", 60000),
    ("bits-generated", 15000),
    ("decimal-exponent", 4005),
    ("decimal-integer", 400),
    ("decimal-generated", 10000),
    ("decimal-exact-and-tie", 2000),
    ("json-structure", 20),
    ("json-utf16", 500),
    ("json-key-order", 500),
];
fn next(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}
fn binary(bits: u64) -> (u64, i32) {
    let exponent = ((bits >> 52) & 2047) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    if exponent == 0 {
        (fraction, -1074)
    } else {
        ((1u64 << 52) | fraction, exponent - 1075)
    }
}
fn decimal(mantissa: u64, power: i32) -> String {
    let mut n = BigInteger::parse(&mantissa.to_string()).unwrap();
    for _ in 0..power.max(0) {
        n = n.add(&n);
    }
    for _ in 0..(-power).max(0) {
        let twice = n.add(&n);
        n = twice.add(&twice).add(&n);
    }
    format!("{}e{}", n.to_js_string(), power.min(0))
}
pub(super) fn corpus() -> Vec<(&'static str, Value)> {
    let mut cases = vec![];
    let mut add = |family, q| cases.push((family, q));
    for exponent in 0..2048u64 {
        for fraction in [0, 1, (1u64 << 51) - 1, 1u64 << 51, (1u64 << 52) - 1] {
            let center = (exponent << 52) | fraction;
            for delta in [-1i64, 0, 1] {
                let Some(bits) = center.checked_add_signed(delta) else {
                    continue;
                };
                if bits >= 1u64 << 63 {
                    continue;
                }
                for sign in [0, 1u64 << 63] {
                    add(
                        "bits-boundary",
                        json!({"op":"bits","hex":format!("{:016x}",bits|sign)}),
                    );
                }
            }
        }
    }
    let mut seed = SEED;
    for _ in 0..15000 {
        add(
            "bits-generated",
            json!({"op":"bits","hex":format!("{:016x}",next(&mut seed))}),
        );
    }
    for exponent in -400..=400 {
        for coefficient in [
            "1",
            "-1",
            "1.0000000000000001",
            "2.2250738585072014",
            "9.999999999999999",
        ] {
            add(
                "decimal-exponent",
                json!({"op":"decimal","raw":format!("{coefficient}e{exponent}")}),
            );
        }
    }
    for center in [
        1u128 << 53,
        1u128 << 54,
        1u128 << 63,
        10u128.pow(21),
        10u128.pow(23),
    ] {
        for delta in -40..=40i128 {
            add(
                "decimal-integer",
                json!({"op":"decimal","raw":(center as i128+delta).to_string()}),
            );
        }
    }
    for _ in 0..10000 {
        let length = (next(&mut seed) % 90 + 1) as usize;
        let mut raw = String::new();
        if next(&mut seed) % 2 == 0 {
            raw.push('-');
        }
        raw.push(char::from(b'1' + (next(&mut seed) % 9) as u8));
        for _ in 1..length {
            raw.push(char::from(b'0' + (next(&mut seed) % 10) as u8));
        }
        raw.push_str(&format!("e{}", next(&mut seed) % 800));
        if next(&mut seed) % 2 == 0 {
            let e = raw.rfind('e').unwrap();
            raw.insert(e + 1, '-');
        }
        add("decimal-generated", json!({"op":"decimal","raw":raw}));
    }
    for _ in 0..1000 {
        let bits = next(&mut seed) % 0x7fef_ffff_ffff_fffe + 1;
        let (m, p) = binary(bits);
        let (n, q) = binary(bits + 1);
        let exponent = p.min(q);
        let sum = (m << ((p - exponent) as u32)) + (n << ((q - exponent) as u32));
        add(
            "decimal-exact-and-tie",
            json!({"op":"decimal","raw":decimal(m,p)}),
        );
        add(
            "decimal-exact-and-tie",
            json!({"op":"decimal","raw":decimal(sum,exponent-1)}),
        );
    }
    for raw in [
        "null",
        "true",
        "-0",
        "1e400",
        r#"{"b":1,"2":2,"1":3,"b":4,"01":5,"4294967295":6}"#,
        r#"{"\ud800":1e400,"x":2}"#,
        r#"["\ud800","\udc00","\ud800\udc00","é𝄞\u2028"]"#,
        r#"{"__proto__":1,"a":[-0,1e400,9007199254740993]}"#,
        "{",
        "[1,]",
        r#"{"a":1,}"#,
        "01",
        "[01]",
        "NaN",
        r#"{"a":1,"a":2}"#,
        r#""\ud800x""#,
        "[1e999999999999999999999,-1e-9999999999999999999]",
    ] {
        add("json-structure", json!({"op":"parse","json":raw}));
    }
    for depth in [10, 100, 500, 1500, 2500] {
        add(
            "json-structure",
            json!({"op":"parse","json":format!("{}\"\\ud800\"{}","[".repeat(depth),"]".repeat(depth))}),
        );
    }
    for _ in 0..500 {
        let mut text = String::from("\"");
        for _ in 0..next(&mut seed) % 20 {
            text.push_str(&format!("\\u{:04x}", next(&mut seed) % 65536));
        }
        text.push('"');
        add("json-utf16", json!({"op":"parse","json":text}));
        add(
            "json-key-order",
            json!({"op":"parse","json":format!("{{{text}:1,\"2\":2,\"1\":3,{text}:4}}",text=text)}),
        );
    }
    cases
}
