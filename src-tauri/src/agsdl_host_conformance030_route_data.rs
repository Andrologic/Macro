//! Actual native shared-adapter inputs and Rust results. Oracle replay is
//! separate and never provides a result to the native protocol.
use super::{BunHost, Fixture};
use crate::argentic_core::{
    native::{JsonDecoder, Text},
    route::data,
};
use crate::argentic_runtime::native_json::Decoder;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub(super) struct Capture {
    pub raw_job: String,
    pub raw_output: String,
    pub operation: String,
    pub difference: Option<String>,
}
fn sha(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
pub(super) fn operation(raw_job: &str) -> String {
    let job = Decoder.parse(&Text::from(raw_job)).unwrap();
    let input = Decoder.parse(job.get("inputJson").text().unwrap()).unwrap();
    match input
        .get("operation")
        .text()
        .and_then(|t| t.utf8())
        .as_deref()
    {
        Some("humanClock") => "humanClock".into(),
        Some("prepare") => {
            let step = crate::argentic_core::calls_data::decode(input.get("stepJson")).unwrap();
            format!(
                "prepare.{}",
                if step.as_object().unwrap().contains_key("command") {
                    "command"
                } else {
                    "mcp"
                }
            )
        }
        Some("normalize") => format!(
            "normalize.{}",
            input
                .get("prepared")
                .get("kind")
                .text()
                .unwrap()
                .utf8()
                .unwrap()
        ),
        _ => "route".into(),
    }
}
pub(super) fn compare(raw_job: &str, raw_output: &str) -> Result<(), String> {
    let job = Decoder
        .parse(&Text::from(raw_job))
        .map_err(|e| format!("Captured job JSON: {e:?}"))?;
    let input_json = job.get("inputJson").text().ok_or("inputJson absent")?;
    let input_utf8 = input_json.utf8().ok_or("Native inputJson is not UTF-8")?;
    if !job
        .get("inputDigest")
        .eq_str(&format!("sha256:{}", sha(&input_utf8)))
    {
        return Err("Captured native input digest differs".into());
    }
    let result = data::evaluate(
        job.get("inputJson").text().ok_or("inputJson absent")?,
        &Decoder,
    )
    .map_err(|e| format!("Rust refused: {e:?}"))?;
    if result.stringify() != raw_output {
        return Err(format!(
            "job={raw_job}; expected={raw_output}; actual={}",
            result.stringify()
        ));
    }
    Ok(())
}
pub(super) async fn replay(f: &Fixture, mut bun: Option<&mut BunHost>, name: &str) -> Value {
    let captures = f.route_captures.lock().unwrap().clone();
    let mut rows = String::new();
    let mut cases = vec![];
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    let mut clock_events = std::collections::BTreeMap::<String, usize>::new();
    for (ordinal, capture) in captures.iter().enumerate() {
        assert!(
            capture.difference.is_none(),
            "{}",
            capture.difference.as_deref().unwrap_or("")
        );
        let frozen = sha(&capture.raw_job);
        let output_frozen = sha(&capture.raw_output);
        for _ in 0..2 {
            let output = if let Some(bun) = bun.as_deref_mut() {
                bun.request_text(&format!(
                    "{{\"kind\":\"route\",\"job\":{}}}",
                    capture.raw_job
                ))
                .await
                .1
            } else {
                capture.raw_output.clone()
            };
            assert_eq!(
                output, capture.raw_output,
                "TS frozen route replay {name}/{ordinal}"
            );
            compare(&capture.raw_job, &output).unwrap_or_else(|e| panic!("{name}/{ordinal}: {e}"));
            assert_eq!(sha(&capture.raw_job), frozen);
            assert_eq!(sha(&capture.raw_output), output_frozen);
        }
        *counts.entry(capture.operation.clone()).or_default() += 1;
        if capture.operation == "humanClock" {
            let job: Value = serde_json::from_str(&capture.raw_job).unwrap();
            let input: Value = serde_json::from_str(job["inputJson"].as_str().unwrap()).unwrap();
            let event: Value =
                serde_json::from_str(input["input"]["eventJson"].as_str().unwrap()).unwrap();
            *clock_events
                .entry(event["event"]["kind"].as_str().unwrap().into())
                .or_default() += 1;
        }
        let comparison = if bun.is_some() {
            "strict-rust-ts"
        } else {
            "rust-production"
        };
        let row = json!({"scenario":name,"ordinal":ordinal,"operation":capture.operation,"rawJob":capture.raw_job,"rawOutput":capture.raw_output,"comparison":comparison});
        rows.push_str(&row.to_string());
        rows.push('\n');
        cases.push(json!({"ordinal":ordinal,"operation":capture.operation,"rawJobSha256":frozen,"outputSha256":output_frozen,"comparison":comparison,"tsReplays":if bun.is_some() {2} else {0},"rustReplays":2}));
    }
    if let Some(dir) = std::env::var_os("ARGENTIC_ROUTE_DATA_CAPTURE_DIR") {
        let dir = std::path::Path::new(&dir);
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("{name}.jsonl")), &rows).unwrap();
    }
    let manifest = json!({"scenario":name,"calls":captures.len(),"zeroRouteJobs":captures.is_empty(),"clockCalls":counts.get("humanClock").copied().unwrap_or(0),"zeroClockJobs":!counts.contains_key("humanClock"),"clockEvents":clock_events,"operations":counts,"captureSha256":sha(&rows),"cases":cases});
    eprintln!("ARGENTIC_ROUTE_DATA_CAPTURE {manifest}");
    manifest
}
pub(super) fn finish(scenarios: &[Value], native: usize, scripted: usize, compare_ts: bool) {
    assert_eq!(scenarios.len(), 37);
    let names = scenarios
        .iter()
        .map(|v| v["scenario"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(names.len(), 37);
    let mut counts = std::collections::BTreeMap::<String, u64>::new();
    let mut clock_events = std::collections::BTreeMap::<String, u64>::new();
    for scenario in scenarios {
        for (event, count) in scenario["clockEvents"].as_object().unwrap() {
            *clock_events.entry(event.clone()).or_default() += count.as_u64().unwrap();
        }
        for (op, count) in scenario["operations"].as_object().unwrap() {
            *counts.entry(op.clone()).or_default() += count.as_u64().unwrap();
        }
    }
    for operation in [
        "route",
        "prepare.command",
        "prepare.mcp",
        "normalize.command",
        "normalize.mcp",
        "humanClock",
    ] {
        assert!(
            counts.get(operation).copied().unwrap_or(0) > 0,
            "Expected operation absent: {operation}"
        );
    }
    let manifest = json!({"scenarios":scenarios,"operations":counts,"N":native,"M":scripted,"K":0,"humanClockRust":if compare_ts {"strict-rust-ts"} else {"rust-production"},"clockEvents":clock_events});
    eprintln!("ARGENTIC_ROUTE_DATA_CAPTURE_MANIFEST {manifest}");
    if let Some(dir) = std::env::var_os("ARGENTIC_ROUTE_DATA_CAPTURE_DIR") {
        std::fs::write(
            std::path::Path::new(&dir).join("manifest.json"),
            manifest.to_string(),
        )
        .unwrap();
    }
}
