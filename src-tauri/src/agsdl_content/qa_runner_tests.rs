//! libtest only orchestrates a separately initialized, hash-pinned QA image.
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

fn validate_binary(path: Option<&str>, expected: Option<&str>) -> Result<PathBuf, String> {
    let path = Path::new(path.ok_or("MACRO_AGSDL_CONTENT_QA_BIN is required")?);
    let expected = expected.ok_or("MACRO_AGSDL_CONTENT_QA_SHA256 is required")?;
    if !path.is_absolute()
        || expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("QA binary path or SHA256 is invalid".into());
    }
    let mut file = std::fs::File::open(path).map_err(|e| format!("QA binary unavailable: {e}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != expected {
        return Err("QA binary SHA256 mismatch".into());
    }
    Ok(path.to_owned())
}

fn validate_report(bytes: &[u8]) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid QA report: {e}"))?;
    let object = value.as_object().ok_or("QA report is not an object")?;
    if object.len() != 2
        || object.get("format").and_then(|v| v.as_str()) != Some("macro-agsdl-content-qa/1")
    {
        return Err("QA report format differs".into());
    }
    let cases = object
        .get("cases")
        .and_then(|v| v.as_array())
        .ok_or("QA report has no cases")?;
    let mut seen = BTreeSet::new();
    for case in cases {
        let entry = case.as_object().ok_or("Invalid case entry")?;
        let name = entry
            .get("case")
            .and_then(|v| v.as_str())
            .ok_or("Missing case name")?;
        if entry.len() != 2
            || entry.get("success").and_then(|v| v.as_bool()) != Some(true)
            || !seen.insert(name)
        {
            return Err("Invalid or duplicated QA result".into());
        }
    }
    let expected: BTreeSet<_> = super::qa_cases::CASE_NAMES.iter().copied().collect();
    if seen != expected {
        return Err("QA case set is incomplete".into());
    }
    Ok(())
}

#[test]
fn missing_binary_and_incomplete_report_are_errors() {
    assert!(validate_binary(None, None).is_err());
    assert!(validate_binary(
        Some("/nonexistent/agsdl-content-helper-qa"),
        Some(&"0".repeat(64))
    )
    .is_err());
    assert!(validate_report(br#"{"format":"macro-agsdl-content-qa/1","cases":[]}"#).is_err());
}

#[test]
fn content_physical_cases_run_in_initialized_hash_pinned_image() {
    let path = std::env::var("MACRO_AGSDL_CONTENT_QA_BIN").ok();
    let expected = std::env::var("MACRO_AGSDL_CONTENT_QA_SHA256").ok();
    let binary = validate_binary(path.as_deref(), expected.as_deref())
        .expect("QA binary and trusted hash must be supplied");
    let output = crate::core::process::background_command(binary)
        .arg("--run-agsdl-content-cases")
        .arg("all")
        .output()
        .expect("QA binary could not be started");
    assert!(
        output.status.success(),
        "QA binary failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    validate_report(&output.stdout).expect("QA binary did not return all real-reader cases");
}
