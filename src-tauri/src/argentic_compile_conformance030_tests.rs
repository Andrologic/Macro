//! Strict differential of the compilation APIs and explicit native JSON codec.
//! All process/file IO lives in this host test module, outside the engine ports.
use crate::argentic_core::{
    compile::metadata,
    native::{self, a, o, s, Text, Value},
};
use crate::argentic_runtime::native_json as codec;
use crate::argentic_values_conformance030_tests::Oracle;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};
mod numbers;
fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
fn field<'a>(q: &'a Json, k: &str) -> &'a str {
    q[k].as_str().unwrap()
}
fn error(e: native::Error) -> Value {
    o([
        ("status", s("failure")),
        ("code", s(e.code)),
        ("pointer", s(e.pointer)),
        ("message", s(e.message)),
    ])
}
fn native_codec(q: &Json) -> String {
    match field(q, "op") {
        "decimal" => match codec::decimal_bits(field(q, "raw")) {
            Ok(bits) => o([
                ("status", s("ok")),
                ("bits", s(format!("{bits:016x}"))),
                ("text", s(codec::bits_text(bits))),
            ])
            .stringify(),
            Err(_) => o([("status", s("parseError"))]).stringify(),
        },
        "bits" => o([
            ("status", s("ok")),
            (
                "text",
                s(codec::bits_text(
                    u64::from_str_radix(field(q, "hex"), 16).unwrap(),
                )),
            ),
        ])
        .stringify(),
        "parse" => match codec::parse(field(q, "json")) {
            Err(_) => o([("status", s("parseError"))]).stringify(),
            Ok(v) => {
                let capture = metadata::capture_native_json(&v, "/native")
                    .map(|v| o([("status", s("ok")), ("text", s(v.stringify()))]))
                    .unwrap_or_else(error);
                o([
                    ("status", s("ok")),
                    ("text", s(v.stringify())),
                    ("capture", capture),
                ])
                .stringify()
            }
        },
        _ => panic!("unknown native operation"),
    }
}
#[tokio::test]
async fn native_json_differential() {
    let cases = numbers::corpus();
    let mut oracle = Oracle::start();
    let mut manifest = vec![];
    let mut counts = BTreeMap::new();
    for (i, (family, q)) in cases.iter().enumerate() {
        let id = format!("native:{family}:{i}");
        let output = oracle
            .request_kind(
                "nativeJson",
                q,
                &id,
                Duration::from_secs(30),
                "ARGENTIC_NATIVE_JSON_RESOURCE",
            )
            .await;
        let expected = output["json"]
            .as_str()
            .expect("native oracle returns raw JSON text");
        let actual = native_codec(q);
        assert_eq!(actual, expected, "{id} input {q}");
        *counts.entry(*family).or_insert(0usize) += 1;
        manifest.push(json!({"id":id,"family":family,"inputSha256":digest(q.to_string().as_bytes()),"outputSha256":digest(actual.as_bytes())}));
    }
    oracle.close().await;
    for (family, min) in numbers::MINIMUMS {
        assert!(
            counts.get(family).copied().unwrap_or(0) >= *min,
            "missing native family {family}: {counts:?}"
        );
    }
    eprintln!(
        "ARGENTIC_NATIVE_JSON_MANIFEST {}",
        json!({"seed":numbers::SEED,"families":counts,"minimums":numbers::MINIMUMS,"cases":manifest})
    );
}
mod evaluate;
const COMPILE_MINIMUMS: &[(&str, usize)] = &[
    ("official", 576),
    ("runs", 148),
    ("examples", 40),
    ("demo", 60),
    ("registry-mutations", 76),
    ("registry-shape", 84),
    ("receipts", 88),
    ("native-utf16", 42),
    ("native-source-utf16", 21),
    ("native-numbers", 18),
    ("contracts", 104),
    ("contracts-copy", 18),
    ("agent-properties", 48),
    ("generated", 600),
    ("used", 200),
    ("snapshots", 1),
    ("graph-files", 100),
    ("configuration-files", 200),
    ("used-files", 200),
    ("range-proof", 36),
    ("settings", 180),
    ("utf8-limit", 6),
    ("expanded-plan", 1),
    ("native-complete", 4),
    ("native-exact-refusals", 24),
];
#[tokio::test]
async fn compilation_differential() {
    let mut oracle = Oracle::start();
    let corpus = oracle
        .request_kind(
            "compileCorpus",
            &Json::Null,
            "compile-corpus",
            Duration::from_secs(60),
            "ARGENTIC_COMPILE_RESOURCE",
        )
        .await;
    let cases = corpus["cases"].as_array().unwrap();
    let mut counts = BTreeMap::new();
    let mut statuses = BTreeMap::new();
    let mut supported = 0;
    let mut limits = 0;
    let mut manifest = vec![];
    for case in cases {
        let id = field(case, "id");
        let family = field(case, "family");
        let op = field(case, "op");
        let input = field(case, "json");
        let request = json!({"op":op,"json":input});
        let expected = oracle
            .request_kind(
                "compilePure",
                &request,
                id,
                Duration::from_secs(60),
                "ARGENTIC_COMPILE_RESOURCE",
            )
            .await;
        let expected = expected["json"]
            .as_str()
            .expect("compilation oracle returns complete raw JSON text");
        let actual = evaluate::evaluate(op, input);
        assert_eq!(
            actual,
            expected,
            "{id} operation {op} input hash {}",
            digest(input.as_bytes())
        );
        let outer = codec::parse(&actual).unwrap();
        let status = outer.get("status").text().unwrap().utf8().unwrap();
        assert!(
            !["resourceLimit"].contains(&status.as_str()),
            "oracle resource limit is not parity: {id}"
        );
        *statuses.entry(status).or_insert(0usize) += 1;
        *counts.entry(family.to_owned()).or_insert(0usize) += 1;
        if let Some(json) = outer.get("json").text().and_then(Text::utf8) {
            if let Ok(value) = codec::parse(&json) {
                if value.get("runtime").get("supported").truthy() {
                    supported += 1;
                }
                if value
                    .get("runtime")
                    .get("diagnostics")
                    .array()
                    .is_some_and(|a| a.iter().any(|d| d.get("code").eq_str("INPUT_LIMIT")))
                {
                    limits += 1;
                }
            }
        }
        manifest.push(json!({"id":id,"family":family,"op":op,"inputSha256":digest(input.as_bytes()),"outputSha256":digest(actual.as_bytes())}));
    }
    oracle.close().await;
    for (family, min) in COMPILE_MINIMUMS {
        assert!(
            counts.get(*family).copied().unwrap_or(0) >= *min,
            "missing compilation family {family}: {counts:?}"
        );
    }
    assert!(
        supported >= 200,
        "insufficient successful plan coverage: {supported}"
    );
    assert!(
        limits >= 3,
        "missing actual expansion/byte limit refusals: {limits}"
    );
    eprintln!(
        "ARGENTIC_COMPILE_MANIFEST {}",
        json!({"base":"a71adffc1fd110357095fa204ba4639b95d3b4c5","files":corpus["files"],"families":counts,"minimums":COMPILE_MINIMUMS,"statuses":statuses,"supported":supported,"limitRefusals":limits,"cases":manifest})
    );
}
#[test]
fn native_capture_keeps_signed_zero_and_copies_utf16_data() {
    let value = codec::parse(r#"{"\ud800":[-0,"\udc00"]}"#).unwrap();
    let captured = metadata::capture_native_json(&value, "/native").unwrap();
    assert_eq!(captured.stringify(), r#"{"\ud800":[0,"\udc00"]}"#);
    let item = &captured.object().unwrap()[0].1.array().unwrap()[0];
    assert!(matches!(item,Value::Number(native::Number::Finite(raw))if raw=="-0"));
}
