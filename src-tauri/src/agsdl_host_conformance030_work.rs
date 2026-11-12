//! Comparison and replay of the actual work mailbox jobs, only in the test pump.
//! Captured identities and opaque strings are never normalized or substituted.
use super::{BunHost, Fixture};
use crate::{
    argentic_core::{
        native::{JsonDecoder, Text},
        work,
    },
    argentic_runtime::native_json::Decoder,
};
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
    let job = Decoder
        .parse(&Text::from(raw_job))
        .map_err(|e| format!("Captured JSON refused: {e:?}"))?;
    let actual = work::evaluate_host(job.get("input"), &Decoder)
        .map_err(|e| format!("Rust work refused captured input: {e:?}; job={raw_job}"))?;
    for field in ["stateJson", "receiptJson"] {
        let expected = expected[field]
            .as_str()
            .ok_or_else(|| format!("TS work omitted {field}"))?;
        if !actual.get(field).eq_str(expected) {
            return Err(format!(
                "Captured work {field} differs; job={raw_job}; expected={expected}; actual={}",
                actual.stringify()
            ));
        }
    }
    Ok(())
}
pub(super) async fn replay(f: &Fixture, bun: &mut BunHost, name: &str) -> Value {
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
            let job: Value = serde_json::from_str(&capture.raw_job).unwrap();
            let output = bun.request(json!({"kind":"work","job":job})).await;
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
        cases.push(json!({"ordinal":ordinal,"rawJobSha256":frozen,"stateSha256":sha(capture.output["stateJson"].as_str().unwrap()),"receiptSha256":sha(capture.output["receiptJson"].as_str().unwrap()),"replays":2}));
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
