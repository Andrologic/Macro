//! Test-only recording and replay of actual native work-adapter inputs.
//! Captured identities and opaque strings are never normalized or substituted.
use super::{BunHost, Fixture};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub(super) struct Capture {
    pub(super) raw_job: String,
    pub(super) output: Value,
    pub(super) difference: Option<String>,
}
fn sha(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
pub(super) fn compare(raw_job: &str, expected: &Value) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    struct CapturedJob {
        input: Box<serde_json::value::RawValue>,
    }
    let job: CapturedJob = serde_json::from_str(raw_job).map_err(|e| e.to_string())?;
    let raw = crate::calculation::work(job.input.get())
        .map_err(|e| format!("Rust work refused captured input: {e:?}; job={raw_job}"))?;
    let actual: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    for field in ["stateJson", "receiptJson"] {
        let expected = expected[field]
            .as_str()
            .ok_or_else(|| format!("TS work omitted {field}"))?;
        if actual[field].as_str() != Some(expected) {
            return Err(format!(
                "Captured work {field} differs; job={raw_job}; expected={expected}; actual={}",
                actual.to_string()
            ));
        }
    }
    Ok(())
}
pub(super) async fn replay(f: &Fixture, mut bun: Option<&mut BunHost>, name: &str) -> Value {
    let captures = f.work_captures.lock().unwrap().clone();
    let mut cases = vec![];
    let mut raw_lines = String::new();
    for (ordinal, capture) in captures.iter().enumerate() {
        assert!(
            capture.difference.is_none(),
            "{}",
            capture.difference.as_deref().unwrap_or("")
        );
        let frozen = sha(&capture.raw_job);
        for _ in 0..2 {
            // The entire frozen job is sent again. Parsing a transport object
            // does not change the exact strings in its input or its identity.
            let output = if let Some(bun) = bun.as_deref_mut() {
                bun.request_text(&format!(
                    "{{\"kind\":\"work\",\"job\":{}}}",
                    capture.raw_job
                ))
                .await
                .0
            } else {
                capture.output.clone()
            };
            for field in ["stateJson", "receiptJson"] {
                assert_eq!(
                    output[field].as_str(),
                    capture.output[field].as_str(),
                    "frozen TS replay {name}/{ordinal}/{field}"
                );
            }
            compare(&capture.raw_job, &output).unwrap_or_else(|e| panic!("{name}/{ordinal}: {e}"));
            assert_eq!(
                sha(&capture.raw_job),
                frozen,
                "capture mutated during replay"
            );
        }
        let row = json!({"scenario":name,"ordinal":ordinal,"rawJob":capture.raw_job,"output":capture.output});
        raw_lines.push_str(&row.to_string());
        raw_lines.push('\n');
        cases.push(json!({"ordinal":ordinal,"rawJobSha256":frozen,"stateSha256":sha(capture.output["stateJson"].as_str().unwrap()),"receiptSha256":sha(capture.output["receiptJson"].as_str().unwrap()),"rustReplays":2,"tsReplays":if bun.is_some() {2} else {0}}));
    }
    if let Some(directory) = std::env::var_os("ARGENTIC_WORK_CAPTURE_DIR") {
        let directory = std::path::Path::new(&directory);
        std::fs::create_dir_all(directory).unwrap();
        let file = directory.join(format!("{name}.jsonl"));
        std::fs::write(&file, raw_lines.as_bytes()).unwrap();
    }
    let manifest = json!({"scenario":name,"calls":captures.len(),"zeroWork":captures.is_empty(),"captureSha256":sha(&raw_lines),"cases":cases});
    eprintln!("ARGENTIC_WORK_CAPTURE {manifest}");
    manifest
}
