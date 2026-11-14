use super::*;
use crate::permissions::{normalize_requested, PathContext, RequestedPermissions};
use serde_json::json;
use std::fs;
use tempfile::TempDir;
use url::Url;

fn context(
    root: &std::path::Path,
    document: &str,
    origin: Option<&str>,
    preset: &str,
) -> ContentContext {
    let path = PathContext {
        workspace: root.to_path_buf(),
        home: root.to_path_buf(),
    };
    let policy = || {
        normalize_requested(
            serde_json::from_value::<RequestedPermissions>(json!(preset)).unwrap(),
            path.clone(),
        )
        .unwrap()
    };
    ContentContext::capture(
        "capture".into(),
        digest(document.as_bytes()),
        document.into(),
        origin,
        "worker".into(),
        EffectivePolicy::new(policy(), policy(), policy()),
        ExecutionPurpose::Agent,
        CancellationToken::new(),
        Arc::new(|_| Box::pin(async { Err(error("PERMISSION", "No approval ticket.")) })),
    )
    .unwrap()
}
fn use_source(source: &str, usage: ContentUsage) -> ContentUse {
    ContentUse {
        source_json: source.into(),
        usage,
        pointer: "/test".into(),
    }
}

#[test]
fn context_binding_uses_native_policy_and_rejects_revocation() {
    let temp = TempDir::new().unwrap();
    let document = r#"{"agents":{"worker":{}}}"#;
    let context = context(temp.path(), document, None, "read-only");
    let binding = context.binding().unwrap();
    assert_eq!(binding.capture_id, "capture");
    assert_eq!(binding.source_digest, digest(document.as_bytes()));
    assert_eq!(binding.document_json, document);
    assert_eq!(binding.agent, "worker");
    assert_eq!(binding.policy_digest, context.policy.fingerprint());
    let restored = EffectivePolicy::restore_capture(&binding.policy_json, &binding.policy_digest)
        .expect("binding contains the actual native policy");
    assert_eq!(restored.fingerprint(), context.policy.fingerprint());
    context.cancel.cancel();
    assert!(matches!(context.binding(), Err(ContentError { code, .. }) if code == "CANCELLED"));
}

#[tokio::test]
async fn inline_values_and_inline_refs_remain_opaque_without_file_reads() {
    let temp = TempDir::new().unwrap();
    let document = r#"{"agents":{"worker":{}},"content":{"item":{"value":{"uri":"file:///forbidden","ref":"x","n":9007199254740993}}}}"#;
    let ctx = context(temp.path(), document, None, "read-only");
    for input in [
        r#"{"value":{"uri":"file:///forbidden","ref":"x","n":9007199254740993}}"#,
        r#"{"ref":"item"}"#,
    ] {
        let receipt = resolve_content(&ctx, use_source(input, ContentUsage::Resource))
            .await
            .unwrap();
        assert!(
            matches!(receipt.payload, ContentPayload::Json { ref json } if json.contains("9007199254740993") && json.contains("file:///forbidden"))
        );
        assert_eq!(
            receipt.provenance.source_json_digest,
            digest(input.as_bytes())
        );
        assert!(receipt.provenance.final_uri.is_none());
    }
    assert_eq!(
        resolve_content(
            &ctx,
            use_source(r#"{"uri":"data.json"}"#, ContentUsage::Prompt)
        )
        .await
        .unwrap_err()
        .code,
        "CONTENT_ORIGIN"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn denied_symlink_outside_workspace_is_not_read() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    fs::write(temp.path().join("secret"), "secret").unwrap();
    std::os::unix::fs::symlink(temp.path().join("secret"), root.join("link")).unwrap();
    let origin = Url::from_file_path(root.join("document.json"))
        .unwrap()
        .to_string();
    let ctx = context(
        &root,
        r#"{"agents":{"worker":{}}}"#,
        Some(&origin),
        "read-only",
    );
    assert_eq!(
        resolve_content(
            &ctx,
            use_source(r#"{"uri":"link"}"#, ContentUsage::Resource)
        )
        .await
        .unwrap_err()
        .code,
        "PERMISSION"
    );
}

#[tokio::test]
async fn cancellation_while_waiting_for_approval_releases_the_read() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("data.txt"), "content").unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{}}}"#;
    let path = PathContext {
        workspace: temp.path().into(),
        home: temp.path().into(),
    };
    let ask = normalize_requested(serde_json::from_value(json!({"preset":"read-only", "rules":[{"action":"read", "effect":"ask", "match":"data.txt"}]})).unwrap(), path.clone()).unwrap();
    let allow = || {
        normalize_requested(serde_json::from_value(json!("full")).unwrap(), path.clone()).unwrap()
    };
    let cancellation = CancellationToken::new();
    let callback = Arc::new(|_: ContentAdmission| {
        Box::pin(std::future::pending::<ContentResult<()>>())
            as Pin<Box<dyn Future<Output = ContentResult<()>> + Send>>
    });
    let ctx = ContentContext::capture(
        "capture".into(),
        digest(document.as_bytes()),
        document.into(),
        Some(&origin),
        "worker".into(),
        EffectivePolicy::new(ask, allow(), allow()),
        ExecutionPurpose::Agent,
        cancellation.clone(),
        callback,
    )
    .unwrap();
    let read = resolve_content(
        &ctx,
        use_source(r#"{"uri":"data.txt"}"#, ContentUsage::Prompt),
    );
    tokio::pin!(read);
    assert!(futures::poll!(read.as_mut()).is_pending());
    cancellation.cancel();
    assert_eq!(read.await.unwrap_err().code, "CANCELLED");
}

#[tokio::test]
async fn denied_file_does_not_reach_the_open_boundary() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("secret.txt");
    fs::write(&file, "secret").unwrap();
    let document = r#"{"agents":{"worker":{}}}"#;
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let path = PathContext {
        workspace: temp.path().into(),
        home: temp.path().into(),
    };
    let deny = normalize_requested(serde_json::from_value(json!({"preset":"read-only","rules":[{"action":"read","match":"secret.txt","effect":"deny"}]})).unwrap(), path.clone()).unwrap();
    let full = || {
        normalize_requested(serde_json::from_value(json!("full")).unwrap(), path.clone()).unwrap()
    };
    let ctx = ContentContext::capture(
        "capture".into(),
        digest(document.as_bytes()),
        document.into(),
        Some(&origin),
        "worker".into(),
        EffectivePolicy::new(deny, full(), full()),
        ExecutionPurpose::Agent,
        CancellationToken::new(),
        Arc::new(|_| Box::pin(async { Err(error("PERMISSION", "Unexpected approval.")) })),
    )
    .unwrap();
    let canonical = fs::canonicalize(&file).unwrap();
    let reached = Arc::new(tokio::sync::Barrier::new(2));
    let release = Arc::new(tokio::sync::Barrier::new(2));
    crate::content_io::admitted::install_content_before_open_hook(canonical.clone(), reached, release);
    let result = resolve_content(
        &ctx,
        use_source(r#"{"uri":"secret.txt"}"#, ContentUsage::Resource),
    )
    .await;
    assert_eq!(result.unwrap_err().code, "PERMISSION");
    assert!(crate::content_io::admitted::content_before_open_hook_pending(
        &canonical, true
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn replacing_a_symlink_during_approval_does_not_read_the_new_target() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("first.txt"), "first").unwrap();
    fs::write(temp.path().join("second.txt"), "second").unwrap();
    let link = temp.path().join("link.txt");
    std::os::unix::fs::symlink("first.txt", &link).unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{}}}"#;
    let path = PathContext {
        workspace: temp.path().into(),
        home: temp.path().into(),
    };
    let ask = normalize_requested(serde_json::from_value(json!({"preset":"read-only", "rules":[{"action":"read", "effect":"ask", "match":"link.txt"}]})).unwrap(), path.clone()).unwrap();
    let allow = || {
        normalize_requested(serde_json::from_value(json!("full")).unwrap(), path.clone()).unwrap()
    };
    let callback = Arc::new(move |_: ContentAdmission| {
        let link = link.clone();
        Box::pin(async move {
            fs::remove_file(&link).unwrap();
            std::os::unix::fs::symlink("second.txt", &link).unwrap();
            Ok(())
        }) as Pin<Box<dyn Future<Output = ContentResult<()>> + Send>>
    });
    let ctx = ContentContext::capture(
        "capture".into(),
        digest(document.as_bytes()),
        document.into(),
        Some(&origin),
        "worker".into(),
        EffectivePolicy::new(ask, allow(), allow()),
        ExecutionPurpose::Agent,
        CancellationToken::new(),
        callback,
    )
    .unwrap();
    let result = resolve_content(
        &ctx,
        use_source(r#"{"uri":"link.txt"}"#, ContentUsage::Resource),
    )
    .await;
    assert_eq!(result.unwrap_err().code, "CORRELATION");
}

#[test]
fn network_host_and_actual_ip_are_independent_permission_decisions() {
    let temp = TempDir::new().unwrap();
    let path = PathContext {
        workspace: temp.path().into(),
        home: temp.path().into(),
    };
    let policy = |rules: serde_json::Value| {
        normalize_requested(
            serde_json::from_value(json!({"preset":"workspace", "rules":rules})).unwrap(),
            path.clone(),
        )
        .unwrap()
    };
    let full = || {
        normalize_requested(serde_json::from_value(json!("full")).unwrap(), path.clone()).unwrap()
    };
    let host = ActionRequest::Network {
        host: "example.com".into(),
    };
    let ip = ActionRequest::Network {
        host: "93.184.216.34".into(),
    };
    let limited = EffectivePolicy::new(
        policy(json!([{"action":"network","match":"example.com","effect":"allow"}])),
        full(),
        full(),
    );
    assert_eq!(
        evaluate_effective(&limited, &host, ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Allow
    );
    assert_eq!(
        evaluate_effective(&limited, &ip, ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Deny
    );
    let ask = EffectivePolicy::new(
        policy(
            json!([{"action":"network","match":"example.com","effect":"ask"},{"action":"network","match":"93.184.216.34","effect":"allow"}]),
        ),
        full(),
        full(),
    );
    assert_eq!(
        evaluate_effective(&ask, &host, ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Ask
    );
    assert_eq!(
        evaluate_effective(&ask, &ip, ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Allow
    );
}

#[tokio::test]
#[ignore = "requires public DNS and HTTPS access"]
async fn public_https_resolution_uses_real_dns_permissions_and_transport() {
    let temp = TempDir::new().unwrap();
    let document = r#"{"agents":{"worker":{}}}"#;
    let ctx = context(temp.path(), document, None, "full");
    let receipt = resolve_content(
        &ctx,
        use_source(
            r#"{"uri":"https://example.com/","mediaType":"text/html"}"#,
            ContentUsage::Prompt,
        ),
    )
    .await
    .unwrap();
    assert!(matches!(receipt.payload, ContentPayload::Text { ref text } if !text.is_empty()));
    assert_eq!(
        receipt.provenance.requested_uri.as_deref(),
        Some("https://example.com/")
    );
    assert!(receipt
        .provenance
        .final_uri
        .as_deref()
        .unwrap()
        .starts_with("https://"));
    assert_eq!(receipt.provenance.sha256.len(), 64);
}
