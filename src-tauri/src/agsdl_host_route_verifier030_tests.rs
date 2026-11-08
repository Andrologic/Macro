//! Exact wire tokens are required for 030 source and terminal attestations.
use super::*;

#[test]
fn exact_comparison_preserves_numeric_lexemes() {
    assert!(exact(
        r#"{"results":[1e0,9007199254740993]}"#,
        r#"{"results":[1e0,9007199254740993]}"#
    )
    .unwrap());
    assert!(!exact(r#"{"results":[1]}"#, r#"{"results":[1.0]}"#).unwrap());
    assert!(!exact(r#"{"results":[1]}"#, r#"{"results":[1e0]}"#).unwrap());
}

#[test]
fn accepted_results_keep_exponent_and_large_integer_tokens() {
    let output = json!({"text":"ok", "resultsJson":"{\"x\":1e0,\"n\":9007199254740993}"});
    let encoded = accepted_output_json(&output).unwrap();
    assert!(exact(
        &encoded,
        r#"{"text":"ok","results":{"x":1e0,"n":9007199254740993}}"#
    )
    .unwrap());
    assert!(!exact(
        &encoded,
        r#"{"text":"ok","results":{"x":1.0,"n":9007199254740993}}"#
    )
    .unwrap());
    assert!(!exact(
        &encoded,
        r#"{"text":"ok","results":{"x":1,"n":9007199254740993}}"#
    )
    .unwrap());
}

#[test]
fn native_content_compares_inline_and_expanded_ref_before_number_decoding() {
    let identity = json!({"captureId":"capture","sourceDigest":"source","agent":"worker","policyDigest":"policy"});
    let make = |source: &str, transported: &str| {
        let native: ResolvedContentReceipt = serde_json::from_value(json!({
            "payload":{"kind":"json","json":"1e0"},
            "provenance":{"captureId":"capture","sourceDigest":"source","agent":"worker","usage":"prompt",
                "pointer":"/message/prompt/0","sourceJsonDigest":sha(source.as_bytes()),"requestedUri":null,
                "finalUri":null,"fileParentIdentity":null,"declaredMediaType":null,"observedMediaType":null,
                "mediaType":"application/json","sizeBytes":"3","sha256":sha(b"1e0"),"policyDigest":"policy"}
        })).unwrap();
        let receipt = json!({"sourceJson":transported,"payload":native.payload.clone(),
            "provenance":{"captureId":"capture","sourceDigest":"source","agent":"worker","usage":"prompt",
                "pointer":"/message/prompt/0","requestedUri":null,"mediaType":"application/json",
                "sha256":sha(b"1e0"),"policyDigest":"policy"}});
        (native, receipt)
    };
    let document = r#"{"content":{"sample":{"value":1e0}}}"#;
    for source in [r#"{"ref":"sample"}"#, r#"{"value":1e0}"#] {
        let (native, valid) = make(source, r#"{"value":1e0}"#);
        assert!(verify_native_content(&native, source, &valid, &identity, document).is_ok());
        for altered in [r#"{"value":1}"#, r#"{"value":1.0}"#] {
            let (_, receipt) = make(source, altered);
            assert!(verify_native_content(&native, source, &receipt, &identity, document).is_err());
        }
    }
}
