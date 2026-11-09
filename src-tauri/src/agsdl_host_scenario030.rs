//! Native, pinned conformance inputs for the debug example adapter.
//! Fixture provenance and license remain in dev/agsdl/fixtures/v0.3.
use crate::db::agsdl_execution::{failure, json_lexemes030::document_tokens_equal, Result};
use serde::Deserialize;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const SCENARIOS: &[(&str, &str)] = &[
    (
        "error-route",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/error-route.json"),
    ),
    (
        "join-all",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/join-all.json"),
    ),
    (
        "flow-error",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/flow-error.json"),
    ),
    (
        "mission-priority",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/mission-priority.json"),
    ),
    (
        "parallel-no-join",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/parallel-no-join.json"),
    ),
    (
        "visit-limit",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/visit-limit.json"),
    ),
    (
        "fanout-empty",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/fanout-empty.json"),
    ),
    (
        "fanout-keep",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/fanout-keep.json"),
    ),
    (
        "fanout-limit",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/fanout-limit.json"),
    ),
    (
        "fanout-missions",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/fanout-missions.json"),
    ),
    (
        "wait-group-closes",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/wait-group-closes.json"),
    ),
    (
        "fanout-one-at-a-time",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/fanout-one-at-a-time.json"),
    ),
    (
        "join-group-closes",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/join-group-closes.json"),
    ),
    (
        "join-branch-failed",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/join-branch-failed.json"),
    ),
    (
        "fanout-max-failures",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/fanout-max-failures.json"),
    ),
    (
        "quorum-unreachable",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/quorum-unreachable.json"),
    ),
    (
        "sequence-loop",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/sequence-loop.json"),
    ),
    (
        "quorum-reached",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/quorum-reached.json"),
    ),
    (
        "quorum-wait",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/quorum-wait.json"),
    ),
    (
        "quorum-finish",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/quorum-finish.json"),
    ),
    (
        "finish-branch-goes-on",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/finish-branch-goes-on.json"),
    ),
    (
        "command-outcome",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/command-outcome.json"),
    ),
    (
        "command-json-invalid",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/command-json-invalid.json"),
    ),
    (
        "command-lines",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/command-lines.json"),
    ),
    (
        "fanout-operand",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/fanout-operand.json"),
    ),
    (
        "quorum-missed",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/quorum-missed.json"),
    ),
    (
        "composition",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/composition.json"),
    ),
    (
        "delivery-queue",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/delivery-queue.json"),
    ),
    (
        "delivery-steer",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/delivery-steer.json"),
    ),
    (
        "join-branch-steer",
        include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/join-branch-steer.json"),
    ),
];

const SCENARIO_PINS: &[(&str, &str)] = &[
    (
        "quorum-unreachable",
        "b01ed57ae25c2ebbbd1039ad45b682e47eecfa689bdb197dad4b9faf8c7c52fc",
    ),
    (
        "sequence-loop",
        "0be291e5e08a2c8014e7a79a3a61e94886473a99fec75f8d1708737c62853492",
    ),
    (
        "quorum-reached",
        "3ebf931fd00937d07ceb80d709f179bb07a8add1fa93a20e6b77a2c7fe402116",
    ),
    (
        "quorum-wait",
        "1da961c08147ec8bc62fe28f03971935943bfc0bad24b6acf3abf5a7fae681ab",
    ),
    (
        "quorum-finish",
        "49ae35767301569041700883370fc6ada49717200348103a5bd2025114e4f6eb",
    ),
    (
        "finish-branch-goes-on",
        "d09dbb6ba3e4eb7268a0d84fbe935c37ac2ea5d0faa236d99a7eb3cf487c8779",
    ),
    (
        "command-outcome",
        "ceab028542ef93ceed4c567eab27f72103b2568ab9568796917dd58a46878984",
    ),
    (
        "command-json-invalid",
        "c4b29ec6d9809bcae401b54748eb8482ca662186fd23bc15eb8db5c568cefb47",
    ),
    (
        "command-lines",
        "34433121b4940af3ed94355b0446514c9ad5bee61de7e2daac0669ab5ea541f7",
    ),
    (
        "fanout-operand",
        "4f897247c05dbe3372a87812d0689ab8e03ba37a0f7c2a704a1cd6d58abdbe9f",
    ),
    (
        "quorum-missed",
        "6c476d29ae9a21abe555c4c20aee29593fd31006174412dd3f8c81bb21272c82",
    ),
    (
        "composition",
        "92a9cf5728f38de3176426c833972fd2c6bf103e2f0a8a314d65d0b3d4cfad3d",
    ),
    (
        "delivery-queue",
        "b562c8cdd9954ee183adc3e624ee3bbf292be8cfa18f327db506b2de221b1d2a",
    ),
    (
        "delivery-steer",
        "5b364684f9dea58a020b8801fa0534869afaeeb9b0a59d40b253072f9b2db2fe",
    ),
    (
        "join-branch-steer",
        "c66096b2d8a6a4b50bd6457827914f8b6aa2bbe67399aaba50b4f50c71261ca9",
    ),
];
fn verify_fixture_pin(name: &str, raw: &str) -> Result<()> {
    if let Some((_, expected)) = SCENARIO_PINS.iter().find(|(n, _)| *n == name) {
        if format!("{:x}", Sha256::digest(raw.as_bytes())) != *expected {
            return Err(bad());
        }
    }
    Ok(())
}

fn empty_entry() -> Box<RawValue> {
    RawValue::from_string("{}".into()).expect("empty host message")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture030 {
    description: String,
    document: Box<RawValue>,
    #[serde(default = "empty_entry")]
    entry: Box<RawValue>,
    timeline: Vec<Box<RawValue>>,
    expect: Box<RawValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkKey030 {
    pub(crate) step: Vec<String>,
    pub(crate) item: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum TimelineEvent030 {
    Work {
        key: WorkKey030,
        outcome: ExampleResult030,
    },
    Running(Vec<WorkKey030>),
    Command {
        key: WorkKey030,
        receipt: crate::agsdl_host_calls030::CallEvent030,
    },
}

#[derive(Debug, Clone)]
pub(crate) enum ExampleResult030 {
    Failed(String),
    Returned {
        text: Option<String>,
        submit_json: String,
    },
}

pub(crate) struct PinnedScenario030 {
    pub(crate) name: &'static str,
    pub(crate) fixture_sha256: String,
    pub(crate) timeline: Vec<TimelineEvent030>,
}

fn bad() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "CORRELATION",
        "example",
        "Pinned scenario differs or contains unsupported data",
    )
}

fn key(step: &str, item: Option<&RawValue>) -> Result<WorkKey030> {
    let path = step.split('/').map(str::to_owned).collect::<Vec<_>>();
    if path.is_empty() || path.iter().any(|s| s.is_empty()) {
        return Err(bad());
    }
    let item = item.map(|v| v.get().to_owned());
    if item.as_deref().is_some_and(|v| {
        !(v == "0"
            || (!v.is_empty() && !v.starts_with('0') && v.bytes().all(|b| b.is_ascii_digit())))
    }) {
        return Err(bad());
    }
    Ok(WorkKey030 { step: path, item })
}

fn parse_timeline(raw: &RawValue) -> Result<TimelineEvent030> {
    let mut fields: BTreeMap<String, Box<RawValue>> = serde_json::from_str(raw.get())?;
    if let Some(running) = fields.remove("running") {
        if !fields.is_empty() {
            return Err(bad());
        }
        let rows: Vec<BTreeMap<String, Box<RawValue>>> = serde_json::from_str(running.get())?;
        let mut result = Vec::new();
        for mut row in rows {
            let step: String = serde_json::from_str(row.remove("step").ok_or_else(bad)?.get())?;
            let item = row.remove("item");
            if !row.is_empty() {
                return Err(bad());
            }
            let k = key(&step, item.as_deref())?;
            if result.contains(&k) {
                return Err(bad());
            }
            result.push(k);
        }
        return Ok(TimelineEvent030::Running(result));
    }
    let step: String = serde_json::from_str(fields.remove("work").ok_or_else(bad)?.get())?;
    let item = fields.remove("item");
    let k = key(&step, item.as_deref())?;
    let fails = fields.remove("fails");
    let returns = fields.remove("returns");
    let command = fields.remove("command");
    if !fields.is_empty() {
        return Err(bad());
    }
    if let Some(raw) = command {
        if fails.is_some() || returns.is_some() {
            return Err(bad());
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Command {
            exit_code: i32,
            #[serde(default)]
            stdout: String,
            #[serde(default)]
            stderr: String,
        }
        let command: Command = serde_json::from_str(raw.get())?;
        return Ok(TimelineEvent030::Command {
            key: k,
            receipt: crate::agsdl_host_calls030::CallEvent030::CommandReceipt {
                stdout: command.stdout,
                stderr: command.stderr,
                exit_code: command.exit_code,
            },
        });
    }
    let outcome = match (fails, returns) {
        (Some(code), None) => {
            let code: String = serde_json::from_str(code.get())?;
            if code.is_empty() || !code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') {
                return Err(bad());
            }
            ExampleResult030::Failed(code)
        }
        (None, Some(value)) => {
            let mut result: BTreeMap<String, Box<RawValue>> = serde_json::from_str(value.get())?;
            if result
                .keys()
                .any(|k| !matches!(k.as_str(), "text" | "results" | "choice" | "instructions"))
            {
                return Err(bad());
            }
            let text = result
                .remove("text")
                .map(|v| serde_json::from_str(v.get()))
                .transpose()?;
            ExampleResult030::Returned {
                text,
                submit_json: serde_json::to_string(&result)?,
            }
        }
        _ => return Err(bad()),
    };
    Ok(TimelineEvent030::Work { key: k, outcome })
}

impl PinnedScenario030 {
    pub(crate) fn recognizes_document(document_json: &str) -> Result<bool> {
        for &(name, raw) in SCENARIOS {
            verify_fixture_pin(name, raw)?;
            crate::db::agsdl_execution::validate_json(raw)?;
            let fixture: Fixture030 = serde_json::from_str(raw)?;
            if document_tokens_equal(document_json, fixture.document.get())? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Accept only an exact fixture document and entry from the native capture.
    pub(crate) fn from_capture(document_json: &str, entry_json: &str) -> Result<Self> {
        let mut found = None;
        for &(name, raw) in SCENARIOS {
            verify_fixture_pin(name, raw)?;
            crate::db::agsdl_execution::validate_json(raw)?;
            let fixture: Fixture030 = serde_json::from_str(raw)?;
            if document_tokens_equal(document_json, fixture.document.get())?
                && document_tokens_equal(entry_json, fixture.entry.get())?
            {
                if found.is_some() {
                    return Err(bad());
                }
                let timeline = fixture
                    .timeline
                    .iter()
                    .map(|v| parse_timeline(v))
                    .collect::<Result<Vec<_>>>()?;
                let _ = (fixture.description, fixture.expect);
                found = Some(Self {
                    name,
                    fixture_sha256: format!("{:x}", Sha256::digest(raw.as_bytes())),
                    timeline,
                });
            }
        }
        found.ok_or_else(bad)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_identity_and_timeline_are_bound_to_exact_document_and_entry() {
        let f: Fixture030 = serde_json::from_str(SCENARIOS[1].1).unwrap();
        let scenario = PinnedScenario030::from_capture(f.document.get(), f.entry.get()).unwrap();
        assert_eq!(scenario.name, "join-all");
        assert_eq!(scenario.timeline.len(), 5);
        assert!(PinnedScenario030::from_capture(f.document.get(), "{}").is_err());
    }
    #[test]
    fn all_thirty_vendor_scenarios_bind_exact_document_entry_and_timeline() {
        assert_eq!(SCENARIOS.len(), 30);
        for &(name, raw) in SCENARIOS {
            let fixture: Fixture030 = serde_json::from_str(raw).unwrap();
            assert!(PinnedScenario030::recognizes_document(fixture.document.get()).unwrap());
            let scenario =
                PinnedScenario030::from_capture(fixture.document.get(), fixture.entry.get())
                    .unwrap();
            assert_eq!(scenario.name, name);
            assert_eq!(
                scenario.fixture_sha256,
                format!("{:x}", Sha256::digest(raw.as_bytes()))
            );
            assert_eq!(scenario.timeline.len(), fixture.timeline.len());
            assert!(!scenario.timeline.is_empty());
            assert!(PinnedScenario030::from_capture(fixture.document.get(), "null").is_err());
        }
    }
    #[test]
    fn unqualified_vendor_scenario_is_not_recognized_or_selected() {
        let raw = include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/approval.json");
        let fixture: Fixture030 = serde_json::from_str(raw).unwrap();
        assert!(!PinnedScenario030::recognizes_document(fixture.document.get()).unwrap());
        assert!(
            PinnedScenario030::from_capture(fixture.document.get(), fixture.entry.get()).is_err()
        );
    }

    #[test]
    fn command_receipt_is_typed_exact_and_exclusive() {
        let raw =
            RawValue::from_string(r#"{"work":"tests","command":{"exitCode":1}}"#.into()).unwrap();
        assert!(
            matches!(parse_timeline(&raw).unwrap(), TimelineEvent030::Command { receipt: crate::agsdl_host_calls030::CallEvent030::CommandReceipt { stdout, stderr, exit_code: 1 }, .. } if stdout.is_empty() && stderr.is_empty())
        );
        for value in [
            r#"{"work":"tests","command":{"exitCode":0},"returns":{}}"#,
            r#"{"work":"tests","command":{"exitCode":0},"fails":"CALL_FAILED"}"#,
            r#"{"work":"tests","command":{"exitCode":0,"outcome":"passed"}}"#,
            r#"{"work":"tests","command":{"exitCode":0.5}}"#,
            r#"{"work":"tests","command":{"exitCode":2147483648}}"#,
            r#"{"work":"tests","command":{}}"#,
        ] {
            assert!(
                parse_timeline(&RawValue::from_string(value.into()).unwrap()).is_err(),
                "{value}"
            );
        }
        for &(name, raw) in SCENARIOS {
            verify_fixture_pin(name, raw).unwrap();
            if SCENARIO_PINS.iter().any(|(n, _)| *n == name) {
                assert!(verify_fixture_pin(name, &format!("{raw} ")).is_err());
            }
        }
    }

    #[test]
    fn returned_submission_keeps_number_tokens_and_rejects_extra_keys() {
        let raw = RawValue::from_string(
            r#"{"work":"a","returns":{"text":"ok","results":{"n":1e0}}}"#.into(),
        )
        .unwrap();
        match parse_timeline(&raw).unwrap() {
            TimelineEvent030::Work {
                outcome: ExampleResult030::Returned { text, submit_json },
                ..
            } => {
                assert_eq!(text.as_deref(), Some("ok"));
                assert_eq!(submit_json, r#"{"results":{"n":1e0}}"#);
            }
            _ => panic!("unexpected event"),
        }
        let bad =
            RawValue::from_string(r#"{"work":"a","returns":{"unknown":true}}"#.into()).unwrap();
        assert!(parse_timeline(&bad).is_err());
    }
}
