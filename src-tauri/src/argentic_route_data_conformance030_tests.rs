//! Direct strict oracle and deterministic corpus. All IO is confined to tests.
use crate::{
    argentic_core::{
        calls_data::{self as c, Error},
        messages::captured::{CapturedOccurrences, CapturedReceipts},
        native::{self, o, s, JsonDecoder, Text, Value},
        route::{
            data,
            preparation::{self, Content},
        },
    },
    argentic_runtime::native_json::DECODER,
    argentic_values_conformance030_tests::Oracle,
};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::time::Duration;
fn failure(error: Error) -> Value {
    match error {
        Error::Failure(e) => o([
            ("status", s("failure")),
            ("code", s(e.code)),
            ("pointer", s(e.pointer)),
            ("message", s(e.message)),
        ]),
        Error::Exception { name, message } => o([
            (
                "status",
                s(if name.eq_str("RangeError") {
                    "resourceLimit"
                } else {
                    "exception"
                }),
            ),
            ("name", s(name)),
            ("message", s(message)),
        ]),
    }
}
fn eval(op: &str, i: &Value) -> c::Result<Value> {
    Ok(match op {
        "prepareCall" => c::prepare_call(i.get("stepJson"), i.get("source"))?,
        "command" => c::command_output(i.get("prepared"), i.get("receipt"))?,
        "mcp" => c::mcp_output(i.get("receipt"))?,
        "callData" => c::evaluate_call_data(i)?,
        "content" => CapturedReceipts::new(i.get("identity"), i.get("receipts")).resolve(
            i.get("sourceJson"),
            i.get("use").get("usage"),
            i.get("use").get("pointer"),
        )?,
        "occurrence" => CapturedOccurrences::new(i.get("cache"))?.resolve(
            i.get("ordinal"),
            i.get("index"),
            i.get("sourceJson"),
            i.get("use").get("usage"),
            i.get("use").get("pointer"),
        )?,
        "route" => {
            let mut shared = CapturedReceipts::new(
                i.get("shared").get("identity"),
                i.get("shared").get("receipts"),
            );
            let mut occurrences = if i.has("cache") {
                Some(CapturedOccurrences::new(i.get("cache"))?)
            } else {
                None
            };
            let mut content = if let Some(c) = &mut occurrences {
                Content::Occurrences(c)
            } else if i.has("shared") {
                Content::Shared(&mut shared)
            } else {
                Content::None
            };
            preparation::prepare_flow_route(i, &mut content, &DECODER)?
        }
        "broker" => {
            let generation = if i.get("generation").is_nullish() {
                s("generation")
            } else {
                i.get("generation").clone()
            };
            if !native::equal(&generation, i.get("job").get("generation")) {
                return c::exception("Error", "Route mailbox generation changed.");
            }
            data::evaluate(c::text(i.get("job").get("inputJson"))?, &DECODER)?
        }
        _ => panic!("unknown operation"),
    })
}
pub(crate) fn evaluate(op: &str, raw: &str) -> String {
    let result = (|| {
        let i = DECODER.parse(&Text::from(raw))?;
        eval(op, &i)
    })();
    match result {
        Ok(v) => o([("status", s("ok")), ("json", s(v.stringify()))]),
        Err(e) => failure(e),
    }
    .stringify()
}
fn sha(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
#[tokio::test]
async fn route_data_differential() {
    let mut oracle = Oracle::start();
    let corpus = oracle
        .request_kind(
            "routeDataCorpus",
            &Json::Null,
            "route-data:corpus",
            Duration::from_secs(45),
            "ARGENTIC_ROUTE_DATA_RESOURCE",
        )
        .await;
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    let mut manifest = vec![];
    let mut failures = vec![];
    let mut distinct = std::collections::HashSet::new();
    for (index, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        assert!(
            distinct.insert(case["request"].to_string()),
            "duplicate route-data request {case}"
        );
        let id = format!("route-data:{index}");
        let output = oracle
            .request_kind(
                "routeDataPure",
                &case["request"],
                &id,
                Duration::from_secs(30),
                "ARGENTIC_ROUTE_DATA_RESOURCE",
            )
            .await;
        let expected = output["json"].as_str().unwrap();
        let actual = evaluate(
            case["request"]["op"].as_str().unwrap(),
            case["request"]["json"].as_str().unwrap(),
        );
        if actual != expected {
            failures.push(json!({"id":id,"input":case,"expected":expected,"actual":actual}));
        }
        *counts
            .entry(case["family"].as_str().unwrap().into())
            .or_default() += 1;
        manifest.push(json!({"id":case["id"],"family":case["family"],"inputSha256":sha(&case["request"].to_string()),"outputSha256":sha(&expected.to_owned())}));
    }
    oracle.close().await;
    for (family, min) in corpus["minimums"].as_object().unwrap() {
        assert!(
            counts.get(family).copied().unwrap_or(0) >= min.as_u64().unwrap() as usize,
            "missing {family}"
        );
    }
    for failure in &failures {
        eprintln!("ARGENTIC_ROUTE_DATA_MISMATCH {failure}");
    }
    eprintln!(
        "ARGENTIC_ROUTE_DATA_MANIFEST {}",
        json!({"seed":corpus["seed"],"families":counts,"files":corpus["files"],"cases":manifest})
    );
    assert!(
        failures.is_empty(),
        "{} route-data differences",
        failures.len()
    );
}
#[test]
fn clock_fields_are_evaluated_before_route_content() {
    for raw in [
        r#"{"operation":"humanClock"}"#,
        r#"{"operation":"humanClock","input":null,"contentReceipts":false}"#,
    ] {
        let result = data::evaluate(&Text::from(raw), &DECODER).unwrap();
        assert_eq!(
            result.stringify(),
            r#"{"kind":"failed","code":"ROUTE_PREPARATION_FAILED","pointer":""}"#
        );
    }
}
