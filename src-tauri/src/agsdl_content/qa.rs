//! Dedicated native debug QA, never an IPC entry point or a production grant.
use super::*;
use crate::agsdl_permissions::{normalize_requested, PathContext, RequestedPermissions};
use serde_json::json;
use std::path::Path;

/// Strictly named real-reader regressions for the dedicated native QA binary.
pub(crate) async fn run_cases(selection: &str) -> Result<String, String> {
    super::qa_cases::run_selected(selection).await
}

fn context(root: &Path, document: &str, deny: bool) -> Result<ContentContext, String> {
    let paths = PathContext {
        workspace: root.into(),
        home: root.into(),
    };
    let request = if deny {
        json!({"preset":"read-only", "rules":[{"action":"read","match":"secret.txt","effect":"deny"}]})
    } else {
        json!("read-only")
    };
    let policy = || -> Result<_, String> {
        let request: RequestedPermissions =
            serde_json::from_value(request.clone()).map_err(|e| e.to_string())?;
        normalize_requested(request, paths.clone()).map_err(|e| e.detail)
    };
    let location = url::Url::from_file_path(root.join("document.json"))
        .map_err(|_| "Invalid QA origin".to_string())?
        .to_string();
    ContentContext::capture(
        "native-content-qa".into(),
        digest(document.as_bytes()),
        document.into(),
        Some(&location),
        "worker".into(),
        EffectivePolicy::new(policy()?, policy()?, policy()?),
        ExecutionPurpose::Agent,
        CancellationToken::new(),
        Arc::new(|_| Box::pin(async { Err(error("PERMISSION", "No QA approval")) })),
    )
    .map_err(|e| format!("{}: {}", e.code, e.message))
}

fn source(json: &str, usage: ContentUsage, pointer: &str) -> ContentUse {
    ContentUse {
        source_json: json.into(),
        usage,
        pointer: pointer.into(),
    }
}

/// `root` must be a nonexistent, absolute path owned by the QA caller.
/// The wrapper must first dispatch/initialize the current executable. It must
/// never expose this function to IPC or enable it in a release build.
pub(crate) async fn run(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("QA root must be absolute".into());
    }
    std::fs::create_dir(root).map_err(|e| e.to_string())?;
    let skill = root.join("skills/review");
    std::fs::create_dir_all(skill.join("references")).map_err(|e| e.to_string())?;
    std::fs::write(root.join("data.json"), b"{\"n\":9007199254740993}\n")
        .map_err(|e| e.to_string())?;
    std::fs::write(root.join("image.png"), [0, 1, 2, 255]).map_err(|e| e.to_string())?;
    std::fs::write(root.join("bulk.bin"), vec![7u8; 10 * 1024 * 1024])
        .map_err(|e| e.to_string())?;
    std::fs::write(root.join("secret.txt"), "secret").map_err(|e| e.to_string())?;
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Review changes.\n---\nRead carefully.\n",
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(skill.join("references/note.md"), "Information\n").map_err(|e| e.to_string())?;
    let document = r#"{"agents":{"worker":{"skills":["review"]}},"skills":{"review":{"uri":"skills/review/SKILL.md"}},"content":{"entry":{"uri":"data.json","mediaType":"application/json"}}}"#;
    let allowed = context(root, document, false)?;
    let denied = context(root, document, true)?;
    file_helper::enable_qa_chain().map_err(|e| e.to_string())?;

    let json_source = r#"{"uri":"data.json","mediaType":"application/json"}"#;
    let json = resolve_content(
        &allowed,
        source(json_source, ContentUsage::Prompt, "/qa/json"),
    )
    .await
    .map_err(|e| format!("json: {}: {}", e.code, e.message))?;
    if !matches!(&json.payload, ContentPayload::Json { json } if json == "{\"n\":9007199254740993}\n")
        || json.provenance.sha256 != digest(b"{\"n\":9007199254740993}\n")
        || json.provenance.source_json_digest != digest(json_source.as_bytes())
        || json.provenance.pointer != "/qa/json"
        || json.provenance.agent != "worker"
        || json.provenance.capture_id != "native-content-qa"
        || json.provenance.source_digest != digest(document.as_bytes())
        || json.provenance.policy_digest != allowed.policy.fingerprint()
    {
        return Err("JSON bytes or native provenance differ".into());
    }
    let reference = r#"{"ref":"entry"}"#;
    let ref_receipt = resolve_content(&allowed, source(reference, ContentUsage::Prompt, "/qa/ref"))
        .await
        .map_err(|e| format!("ref: {}", e.message))?;
    if ref_receipt.provenance.source_json_digest != digest(reference.as_bytes())
        || ref_receipt.provenance.sha256 != digest(b"{\"n\":9007199254740993}\n")
        || ref_receipt.provenance.pointer != "/qa/ref"
    {
        return Err("Original ref or resolved bytes were not correlated".into());
    }
    let media = resolve_content(
        &allowed,
        source(
            r#"{"uri":"image.png","mediaType":"image/png"}"#,
            ContentUsage::Resource,
            "/qa/media",
        ),
    )
    .await
    .map_err(|e| format!("media: {}: {}", e.code, e.message))?;
    if !matches!(&media.payload, ContentPayload::Media { base64 } if base64 == "AAEC/w==")
        || media.provenance.sha256 != digest(&[0, 1, 2, 255])
        || media.provenance.size_bytes != "4"
    {
        return Err("Media bytes or digest differ".into());
    }
    let media_uri = url::Url::from_file_path(root.join("image.png"))
        .map_err(|_| "Invalid QA media URI".to_string())?
        .to_string();
    let artifact = capture_result_file(&allowed, "diagram", &media_uri, "image/png")
        .await
        .map_err(|e| format!("artifact: {}", e.message))?;
    if artifact.provenance.sha256 != digest(&[0, 1, 2, 255])
        || artifact.provenance.pointer != "/results/diagram"
    {
        return Err("Result artifact provenance differs".into());
    }
    let literal = resolve_content(
        &allowed,
        source(
            r#"{"value":{"uri":"file:///forbidden","ref":"x","n":9007199254740993}}"#,
            ContentUsage::Resource,
            "/qa/literal",
        ),
    )
    .await
    .map_err(|e| format!("literal: {}", e.message))?;
    if !matches!(&literal.payload, ContentPayload::Json { json } if json.contains("9007199254740993"))
        || literal.provenance.final_uri.is_some()
    {
        return Err("Literal value was not kept as data".into());
    }
    let descriptors = discover_skills(&allowed)
        .await
        .map_err(|e| format!("discovery: {}", e.message))?;
    if descriptors.len() != 1
        || descriptors[0].name != "review"
        || descriptors[0].description != "Review changes."
    {
        return Err("Skill discovery differs".into());
    }
    let loaded = load_skill(&allowed, &descriptors[0].handle)
        .await
        .map_err(|e| format!("activation: {}", e.message))?;
    if loaded.instructions != "Read carefully.\n" {
        return Err("Skill instructions differ".into());
    }
    let resource = read_skill_resource(&allowed, &loaded, "references/note.md", Some("text/plain"))
        .await
        .map_err(|e| format!("resource: {}", e.message))?;
    if !matches!(&resource.payload, ContentPayload::Text { text } if text == "Information\n") {
        return Err("Skill resource differs".into());
    }
    if read_skill_resource(&allowed, &loaded, "../secret.txt", None)
        .await
        .is_ok()
    {
        return Err("Skill traversal was accepted".into());
    }
    let refusal = resolve_content(
        &denied,
        source(
            r#"{"uri":"secret.txt"}"#,
            ContentUsage::Resource,
            "/qa/denied",
        ),
    )
    .await;
    if !matches!(refusal, Err(ContentError { ref code, .. }) if code == "PERMISSION") {
        return Err("Denied file was not rejected by policy 03".into());
    }
    let cancelled = Arc::new(context(root, document, false)?);
    let cancellation = cancelled.cancel.clone();
    let (ready, release) = super::macos_launcher::pause_next_output().map_err(|e| e.to_string())?;
    let pending = tokio::spawn(async move {
        resolve_content(
            &cancelled,
            source(
                r#"{"uri":"bulk.bin","mediaType":"application/octet-stream"}"#,
                ContentUsage::Resource,
                "/qa/cancel",
            ),
        )
        .await
    });
    tokio::task::spawn_blocking(move || ready.recv_timeout(std::time::Duration::from_secs(10)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "Real helper produced no output before cancellation".to_string())?;
    cancellation.cancel();
    release
        .send(())
        .map_err(|_| "QA cancellation hook closed".to_string())?;
    let cancellation_result = tokio::time::timeout(std::time::Duration::from_secs(10), pending)
        .await
        .map_err(|_| "QA cancellation did not complete".to_string())?
        .map_err(|e| e.to_string())?;
    if !matches!(&cancellation_result, Err(ContentError { code, .. }) if code == "CANCELLED") {
        let detail = match &cancellation_result {
            Ok(_) => "unexpected success".to_string(),
            Err(error) => format!("{}: {}", error.code, error.message),
        };
        return Err(format!(
            "Cancellation did not return after confirmed helper exit: {detail}"
        ));
    }
    Ok(())
}
