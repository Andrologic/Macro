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
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture030 {
    description: String,
    document: Box<RawValue>,
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
    if !fields.is_empty() {
        return Err(bad());
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
        for &(_, raw) in SCENARIOS {
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
    fn all_fifteen_vendor_scenarios_bind_exact_document_entry_and_timeline() {
        assert_eq!(SCENARIOS.len(), 15);
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
        let raw =
            include_str!("../../dev/agsdl/fixtures/v0.3/conformance/runs/delivery-queue.json");
        let fixture: Fixture030 = serde_json::from_str(raw).unwrap();
        assert!(!PinnedScenario030::recognizes_document(fixture.document.get()).unwrap());
        assert!(
            PinnedScenario030::from_capture(fixture.document.get(), fixture.entry.get()).is_err()
        );
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
