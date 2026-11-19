//! Work differentials use the actual TS ports. All transport, process and file
//! handling belongs to these host tests, outside the pure evaluator.
use crate::argentic_core::{
    contract,
    native::{a, o, s, JsonDecoder, Text, Value},
    work,
};
use crate::argentic_runtime::native_json::DECODER;
use crate::argentic_values_conformance030_tests::Oracle;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::time::Duration;
fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
fn error(e: work::Error) -> Value {
    match e {
        work::Error::Failure(e) => o([
            ("status", s("failure")),
            ("code", s(e.code)),
            ("pointer", s(e.pointer)),
            ("message", s(e.message)),
        ]),
        work::Error::Exception { name, message } => o([
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
fn ok(v: Value) -> Value {
    o([("status", s("ok")), ("json", s(v.stringify()))])
}
fn contract_for(input: &Value) -> Result<Value, work::Error> {
    if !input.get("contract").is_nullish() {
        return Ok(input.get("contract").clone());
    }
    let default = o([(
        "agentJson",
        if matches!(input.get("agent"), Value::Undefined) {
            s("{}")
        } else {
            input.get("agent").clone()
        },
    )]);
    Ok(contract::create(
        if input.get("contractInput").is_nullish() {
            &default
        } else {
            input.get("contractInput")
        },
    )?)
}
fn assign_fields(target: &mut Value, fields: &Value) {
    if let Some(fields) = fields.object() {
        for (key, value) in fields {
            target.set(key.clone(), value.clone());
        }
    }
}
fn eval(op: &str, input: &Value) -> Result<Value, work::Error> {
    if op == "parse" {
        return Ok(DECODER.parse(input.get("raw").text().unwrap())?);
    }
    if op == "visible" {
        let messages = input
            .get("messages")
            .array()
            .unwrap()
            .iter()
            .map(|a| {
                a.array()
                    .unwrap()
                    .iter()
                    .map(|v| v.text().unwrap().clone())
                    .collect()
            })
            .collect::<Vec<_>>();
        return Ok(s(work::assemble_visible_text(&messages)));
    }
    if op == "host" {
        return work::evaluate_host(input, &DECODER);
    }
    let mut contract = contract_for(input)?;
    if op == "submission" {
        return work::validate_submission(&contract, input.get("raw"));
    }
    if op == "requires" {
        return work::requires_submission(&contract).map(Value::Bool);
    }
    if op == "journal" {
        return work::evaluate_journal(
            input.get("stateJson"),
            input.get("expectedRevision"),
            input.get("eventJson"),
            input.get("owner"),
            &contract,
            input.get("options"),
            &DECODER,
        );
    }
    let mut options = input.get("options").clone();
    let mut controller = work::Controller::new(input.get("owner"), &contract, &options)?;
    assign_fields(&mut contract, input.get("mutateContract"));
    assign_fields(&mut options, input.get("mutateOptions"));
    let mut steps = vec![];
    for step in input.get("steps").array().unwrap() {
        let result = if step.get("kind").eq_str("snapshot") {
            Ok(controller.snapshot())
        } else if step.get("kind").eq_str("allows") {
            Ok(Value::Bool(controller.allows_effect(
                &step.get("effect").text().unwrap().utf8().unwrap(),
            )))
        } else {
            let event = o([
                ("owner", input.get("owner").clone()),
                ("eventId", step.get("id").clone()),
                ("event", step.get("event").clone()),
            ]);
            controller.dispatch(if step.get("input").is_nullish() {
                &event
            } else {
                step.get("input")
            })
        };
        steps.push(match result {
            Ok(mut v) => {
                let encoded = ok(v.clone());
                assign_fields(
                    &mut v,
                    if step.get("kind").eq_str("snapshot") {
                        step.get("mutate")
                    } else {
                        step.get("mutateReceipt")
                    },
                );
                encoded
            }
            Err(e) => error(e),
        });
    }
    Ok(o([
        ("steps", a(steps)),
        ("snapshot", controller.snapshot()),
    ]))
}
pub(crate) fn evaluate(op: &str, raw: &str) -> String {
    let result = match DECODER.parse(&Text::from(raw)) {
        Err(e) => error(e.into()),
        Ok(v) => match eval(op, &v) {
            Ok(v) => ok(v),
            Err(e) => error(e),
        },
    };
    result.stringify()
}
#[tokio::test]
async fn work_differential() {
    let mut oracle = Oracle::start();
    let corpus = oracle
        .request_kind(
            "workCorpus",
            &Json::Null,
            "work:corpus",
            Duration::from_secs(30),
            "ARGENTIC_WORK_RESOURCE",
        )
        .await;
    let cases = corpus["cases"].as_array().expect("work corpus");
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    assert!(!cases.is_empty());
    let mut manifest = vec![];
    let mut failures = vec![];
    for (i, q) in cases.iter().enumerate() {
        *counts
            .entry(q["family"].as_str().unwrap().to_owned())
            .or_default() += 1;
        let id = format!("work:{i}");
        let output = oracle
            .request_kind(
                "workPure",
                &q["request"],
                &id,
                Duration::from_secs(30),
                "ARGENTIC_WORK_RESOURCE",
            )
            .await;
        let expected = output["json"]
            .as_str()
            .expect("work oracle returns raw JSON text");
        let actual = evaluate(
            q["request"]["op"].as_str().unwrap(),
            q["request"]["json"].as_str().unwrap(),
        );
        if actual != expected {
            failures.push(json!({"id":id,"input":q,"actual":actual,"expected":expected}));
        }
        manifest.push(json!({"family":q["family"],"id":id,"inputSha256":digest(q.to_string().as_bytes()),"outputSha256":digest(actual.as_bytes())}));
    }
    oracle.close().await;
    for (family, minimum) in corpus["minimums"].as_object().unwrap() {
        assert!(
            counts.get(family).copied().unwrap_or(0) >= minimum.as_u64().unwrap() as usize,
            "missing work family {family}"
        );
    }
    for failure in &failures {
        eprintln!("ARGENTIC_WORK_MISMATCH {failure}");
    }
    assert!(
        failures.is_empty(),
        "{} strict work mismatches",
        failures.len()
    );
    eprintln!(
        "ARGENTIC_WORK_MANIFEST {}",
        json!({"seed":corpus["seed"],"minimums":corpus["minimums"],"families":counts,"cases":manifest})
    );
}
