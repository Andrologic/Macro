//! Direct exported TS oracle and strict clock corpus; IO stays in tests.
use crate::{
    argentic_core::{
        clock::{self, HumanWaitRegistry, WorkClock},
        native::{self, a, o, s, JsonDecoder, Text, Value},
        route::data,
        work::{self, Error, Result},
    },
    argentic_runtime::native_json::Decoder,
    argentic_values_conformance030_tests::Oracle,
    core::process::background_tokio_command,
};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, rc::Rc, time::Duration};
fn ok(v: Value) -> Value {
    o([
        ("status", s("ok")),
        (
            "json",
            if matches!(v, Value::Undefined) {
                Value::Undefined
            } else {
                s(v.stringify())
            },
        ),
    ])
}
fn failure(e: Error) -> Value {
    match e {
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
fn eval(op: &str, i: &Value) -> Result<Value> {
    Ok(match op {
        "host" => clock::evaluate_host(
            i.get("owner"),
            i.get("eventId"),
            i.get("expectedRevision"),
            i.get("stateJson"),
            i.get("eventJson"),
            i.get("options"),
            &Decoder,
        )?,
        "job" => clock::evaluate_job(i, &Decoder)?,
        "broker" => {
            let generation = if i.get("generation").is_nullish() {
                s("generation")
            } else {
                i.get("generation").clone()
            };
            if !native::equal(&generation, i.get("job").get("generation")) {
                return work::exception("Error", "Route mailbox generation changed.");
            }
            data::evaluate(i.get("job").get("inputJson").text().unwrap(), &Decoder).map_err(
                |e| match e {
                    crate::argentic_core::calls_data::Error::Failure(e) => Error::Failure(e),
                    crate::argentic_core::calls_data::Error::Exception { name, message } => {
                        Error::Exception { name, message }
                    }
                },
            )?
        }
        "associate" => clock::associate_mcp_request(
            i.get("serverId"),
            i.get("callsObservable"),
            i.get("works"),
        )?,
        "clock" => {
            let mut clock = WorkClock::new(i.get("timeoutMs"), i.get("nowMs"))?;
            let mut steps = vec![];
            for step in i.get("steps").array().unwrap() {
                let result = (|| -> Result<Value> {
                    let op = step.get("op");
                    if op.eq_str("advance") {
                        clock.advance(step.get("nowMs"))
                    } else if op.eq_str("open") {
                        clock.open_human(step.get("requestId"), step.get("nowMs"))?;
                        Ok(Value::Undefined)
                    } else if op.eq_str("close") {
                        clock.close_human(step.get("requestId"), step.get("nowMs"))?;
                        Ok(Value::Undefined)
                    } else if op.eq_str("detach") {
                        clock.detach_human(step.get("requestId"), step.get("nowMs"))?;
                        Ok(Value::Undefined)
                    } else if op.eq_str("wake") {
                        Ok(clock::delay(clock.next_wake(step.get("maxSliceMs"))?))
                    } else {
                        Ok(clock.snapshot())
                    }
                })()
                .map_or_else(failure, ok);
                steps.push(o([("result", result), ("snapshot", clock.snapshot())]));
            }
            o([
                ("steps", a(steps)),
                ("snapshot", clock.snapshot()),
                (
                    "timeoutMs",
                    clock.timeout.as_ref().map_or(Value::Null, |v| s(v.clone())),
                ),
            ])
        }
        "registry" => {
            let mut registry = HumanWaitRegistry::default();
            let mut clocks: Vec<(Text, clock::SharedClock)> = vec![];
            let mut steps = vec![];
            for step in i.get("steps").array().unwrap() {
                let result = (|| -> Result<Value> {
                    let op = step.get("op");
                    if op.eq_str("create") {
                        let clock = Rc::new(RefCell::new(WorkClock::new(
                            step.get("timeoutMs"),
                            step.get("nowMs"),
                        )?));
                        clock::put(&mut clocks, step.get("label"), clock);
                    } else if op.eq_str("register") {
                        let clock = clocks[clock::find(&clocks, step.get("label")).unwrap()]
                            .1
                            .clone();
                        registry.register_work(
                            step.get("workId"),
                            clock,
                            step.get("answerTimeoutMs"),
                        )?;
                    } else if op.eq_str("open") {
                        return registry.open(step.get("input"));
                    } else if op.eq_str("associate") {
                        return registry.set_request_works(
                            step.get("requestId"),
                            step.get("workIds"),
                            step.get("nowMs"),
                        );
                    } else if op.eq_str("resolve") {
                        return registry.resolve(
                            step.get("requestId"),
                            step.get("answer"),
                            step.get("nowMs"),
                        );
                    } else if op.eq_str("tick") {
                        return registry.tick(step.get("nowMs"));
                    } else if op.eq_str("wake") {
                        return Ok(clock::delay(
                            registry.next_wake(step.get("nowMs"), step.get("maxSliceMs"))?,
                        ));
                    } else if op.eq_str("ack") {
                        registry.acknowledge_resolution(step.get("requestId"))?;
                    } else if op.eq_str("retire") {
                        return registry.unregister_work(step.get("workId"), step.get("nowMs"));
                    } else if op.eq_str("request") {
                        return registry.request(step.get("requestId"));
                    } else if op.eq_str("pending") {
                        return Ok(registry.pending_resolutions());
                    }
                    Ok(Value::Undefined)
                })()
                .map_or_else(failure, ok);
                steps.push(o([
                    ("result", result),
                    (
                        "clocks",
                        a(clocks.iter().map(|(label, c)| {
                            o([
                                ("label", s(label.clone())),
                                ("snapshot", c.borrow().snapshot()),
                            ])
                        })),
                    ),
                    ("pending", registry.pending_resolutions()),
                ]));
            }
            o([("steps", a(steps))])
        }
        _ => panic!("unknown clock operation {op}"),
    })
}
pub(crate) fn evaluate(op: &str, raw: &str) -> String {
    let result = (|| {
        let i = Decoder.parse(&Text::from(raw))?;
        eval(op, &i)
    })();
    result.map_or_else(failure, ok).stringify()
}
fn sha(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
#[tokio::test]
async fn clock_differential() {
    let mut oracle = Oracle::start();
    let corpus = oracle
        .request_kind(
            "clockCorpus",
            &Json::Null,
            "clock:corpus",
            Duration::from_secs(45),
            "ARGENTIC_CLOCK_RESOURCE",
        )
        .await;
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    let mut distinct = std::collections::HashSet::new();
    let mut manifest = vec![];
    let mut failures = vec![];
    for (index, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        assert!(
            distinct.insert(case["request"].to_string()),
            "duplicate clock case {case}"
        );
        let output = oracle
            .request_kind(
                "clockPure",
                &case["request"],
                &format!("clock:{index}"),
                Duration::from_secs(30),
                "ARGENTIC_CLOCK_RESOURCE",
            )
            .await;
        let expected = output["json"].as_str().unwrap();
        let actual = evaluate(
            case["request"]["op"].as_str().unwrap(),
            case["request"]["json"].as_str().unwrap(),
        );
        if actual != expected {
            failures.push(json!({"index":index,"input":case,"expected":expected,"actual":actual}));
        }
        *counts
            .entry(case["family"].as_str().unwrap().into())
            .or_default() += 1;
        manifest.push(json!({"id":case["id"],"family":case["family"],"inputSha256":sha(&case["request"].to_string()),"outputSha256":sha(expected)}));
    }
    oracle.close().await;
    for (family, min) in corpus["minimums"].as_object().unwrap() {
        assert!(
            counts.get(family).copied().unwrap_or(0) >= min.as_u64().unwrap() as usize,
            "missing {family}"
        );
    }
    for failure in &failures {
        eprintln!("ARGENTIC_CLOCK_MISMATCH {failure}");
    }
    eprintln!(
        "ARGENTIC_CLOCK_MANIFEST {}",
        json!({"seed":corpus["seed"],"minimums":corpus["minimums"],"families":counts,"cases":manifest})
    );
    assert!(failures.is_empty(), "{} clock differences", failures.len());
}

#[tokio::test]
async fn clock_oracle_missing_dead_and_silent_are_hard_failures() {
    use futures::FutureExt;
    use std::panic::AssertUnwindSafe;
    assert!(
        std::panic::catch_unwind(|| Oracle::start_command(background_tokio_command(
            "argentic-missing-oracle-030"
        )))
        .is_err()
    );
    for script in ["process.exit(7)", "setInterval(() => {}, 1000)"] {
        let mut command = background_tokio_command("bun");
        command.args(["-e", script]);
        let mut oracle = Oracle::start_command(command);
        let failed = AssertUnwindSafe(oracle.request_kind(
            "clockPure",
            &Json::Null,
            "clock:liveness",
            Duration::from_millis(200),
            "ARGENTIC_CLOCK_EXPECTED_FAILURE",
        ))
        .catch_unwind()
        .await;
        assert!(failed.is_err());
        oracle.terminate().await;
    }
}
