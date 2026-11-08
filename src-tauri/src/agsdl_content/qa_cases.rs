//! Physical content regressions; compiled only in the native debug QA binary.
use super::*;
use crate::agsdl_permissions::{normalize_requested, PathContext, RequestedPermissions};
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

async fn file_reads_preserve_bytes_json_and_literal_data() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("data.json"), b"{\"n\":9007199254740993}\n").unwrap();
    fs::write(temp.path().join("image.png"), [0, 1, 2, 255]).unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let ctx = context(
        temp.path(),
        r#"{"agents":{"worker":{}}}"#,
        Some(&origin),
        "read-only",
    );
    let json = resolve_content(
        &ctx,
        use_source(
            r#"{"uri":"data.json","mediaType":"application/json"}"#,
            ContentUsage::Prompt,
        ),
    )
    .await
    .unwrap();
    assert!(
        matches!(json.payload, ContentPayload::Json { ref json } if json == "{\"n\":9007199254740993}\n")
    );
    assert_eq!(
        json.provenance.sha256,
        digest(b"{\"n\":9007199254740993}\n")
    );
    let image = resolve_content(
        &ctx,
        use_source(
            r#"{"uri":"image.png","mediaType":"image/png"}"#,
            ContentUsage::Resource,
        ),
    )
    .await
    .unwrap();
    assert!(matches!(image.payload, ContentPayload::Media { ref base64 } if base64 == "AAEC/w=="));
    assert_eq!(image.provenance.size_bytes, "4");
    let image_uri = Url::from_file_path(temp.path().join("image.png"))
        .unwrap()
        .to_string();
    let artifact = capture_result_file(&ctx, "diagram", &image_uri, "image/png")
        .await
        .unwrap();
    assert_eq!(artifact.provenance.sha256, digest(&[0, 1, 2, 255]));
    assert_eq!(artifact.provenance.pointer, "/results/diagram");
    assert!(
        matches!(artifact.payload, ContentPayload::Media { ref base64 } if base64 == "AAEC/w==")
    );
    assert!(
        capture_result_file(&ctx, "diagram", "image.png", "image/png")
            .await
            .is_err()
    );
    assert!(
        capture_result_file(&ctx, "diagram", &image_uri, "application/json")
            .await
            .is_err()
    );
    let literal = resolve_content(
        &ctx,
        use_source(
            r#"{"value":{"uri":"file:///forbidden","ref":"x","n":9007199254740993}}"#,
            ContentUsage::Resource,
        ),
    )
    .await
    .unwrap();
    assert!(
        matches!(literal.payload, ContentPayload::Json { ref json } if json.contains("9007199254740993"))
    );
    assert!(literal.provenance.final_uri.is_none());
    let missing = context(
        temp.path(),
        r#"{"agents":{"worker":{}}}"#,
        None,
        "read-only",
    );
    assert_eq!(
        resolve_content(
            &missing,
            use_source(r#"{"uri":"data.json"}"#, ContentUsage::Prompt)
        )
        .await
        .unwrap_err()
        .code,
        "CONTENT_ORIGIN"
    );
}

async fn skill_metadata_activation_resources_and_denials_use_real_files() {
    let temp = TempDir::new().unwrap();
    let skill = temp.path().join("skills/review");
    fs::create_dir_all(skill.join("references")).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Review changes.\n---\nRead carefully.\n",
    )
    .unwrap();
    fs::write(skill.join("references/note.md"), "Information\n").unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{"skills":["review"]}},"skills":{"review":{"uri":"skills/review/SKILL.md"}}}"#;
    let ctx = context(temp.path(), document, Some(&origin), "read-only");
    let descriptors = discover_skills(&ctx).await.unwrap();
    assert_eq!(descriptors[0].name, "review");
    assert_eq!(descriptors[0].description, "Review changes.");
    let loaded = load_skill(&ctx, &descriptors[0].handle).await.unwrap();
    assert_eq!(loaded.instructions, "Read carefully.\n");
    let resource = read_skill_resource(&ctx, &loaded, "references/note.md", Some("text/plain"))
        .await
        .unwrap();
    assert!(
        matches!(resource.payload, ContentPayload::Text { ref text } if text == "Information\n")
    );
    assert!(read_skill_resource(&ctx, &loaded, "../outside", None)
        .await
        .is_err());
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Changed.\n---\nChanged.\n",
    )
    .unwrap();
    assert!(load_skill(&ctx, &descriptors[0].handle).await.is_err());
    let denied = context(temp.path(), document, Some(&origin), "workspace");
    let result = resolve_content(
        &denied,
        use_source(
            r#"{"uri":"https://example.com/file"}"#,
            ContentUsage::Prompt,
        ),
    )
    .await;
    assert_eq!(result.unwrap_err().code, "PERMISSION");
}

async fn ask_waits_for_the_correlated_native_decision_before_reading() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("data.txt"), "approved content").unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{}}}"#;
    let path = PathContext {
        workspace: temp.path().into(),
        home: temp.path().into(),
    };
    let ask = normalize_requested(
        serde_json::from_value(json!({"preset":"read-only", "rules":[{"action":"read", "effect":"ask", "match":"data.txt"}]})).unwrap(),
        path.clone(),
    ).unwrap();
    let allow = || {
        normalize_requested(serde_json::from_value(json!("full")).unwrap(), path.clone()).unwrap()
    };
    let (send, receive) = tokio::sync::oneshot::channel::<()>();
    let receiver = Arc::new(std::sync::Mutex::new(Some(receive)));
    let callback = Arc::new(move |admission: ContentAdmission| {
        assert_eq!(admission.capture_id, "capture");
        assert_eq!(admission.agent, "worker");
        assert_eq!(admission.decision.effect, Effect::Ask);
        assert_eq!(admission.effect.pointer, "/test");
        assert!(admission.effect.target_uri.ends_with("/data.txt"));
        assert!(matches!(
            admission.effect.phase,
            ContentEffectPhase::FileRead
        ));
        let receive = receiver.lock().unwrap().take().unwrap();
        Box::pin(async move {
            receive
                .await
                .map_err(|_| error("PERMISSION", "Approval closed."))
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
    let read = resolve_content(
        &ctx,
        use_source(r#"{"uri":"data.txt"}"#, ContentUsage::Prompt),
    );
    tokio::pin!(read);
    assert!(futures::poll!(read.as_mut()).is_pending());
    send.send(()).unwrap();
    assert!(
        matches!(read.await.unwrap().payload, ContentPayload::Text { text } if text == "approved content")
    );
}

async fn ask_does_not_reach_the_open_boundary_until_approved() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("data.txt");
    fs::write(&file, "content").unwrap();
    let document = r#"{"agents":{"worker":{}}}"#;
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let path = PathContext {
        workspace: temp.path().into(),
        home: temp.path().into(),
    };
    let ask = normalize_requested(serde_json::from_value(json!({"preset":"read-only","rules":[{"action":"read","match":"data.txt","effect":"ask"}]})).unwrap(), path.clone()).unwrap();
    let full = || {
        normalize_requested(serde_json::from_value(json!("full")).unwrap(), path.clone()).unwrap()
    };
    let (entered, entered_rx) = tokio::sync::oneshot::channel();
    let (approve, approve_rx) = tokio::sync::oneshot::channel();
    let channels = Arc::new(std::sync::Mutex::new(Some((entered, approve_rx))));
    let callback = Arc::new(move |_: ContentAdmission| {
        let (entered, approve_rx) = channels.lock().unwrap().take().unwrap();
        let _ = entered.send(());
        Box::pin(async move {
            approve_rx
                .await
                .map_err(|_| error("PERMISSION", "Approval closed."))
        }) as Pin<Box<dyn Future<Output = ContentResult<()>> + Send>>
    });
    let ctx = ContentContext::capture(
        "capture".into(),
        digest(document.as_bytes()),
        document.into(),
        Some(&origin),
        "worker".into(),
        EffectivePolicy::new(ask, full(), full()),
        ExecutionPurpose::Agent,
        CancellationToken::new(),
        callback,
    )
    .unwrap();
    let canonical = fs::canonicalize(&file).unwrap();
    let reached = Arc::new(tokio::sync::Barrier::new(2));
    let release = Arc::new(tokio::sync::Barrier::new(2));
    crate::fs::operations::install_content_before_open_hook(
        canonical.clone(),
        reached.clone(),
        release.clone(),
    );
    let task = tokio::spawn(async move {
        resolve_content(
            &ctx,
            use_source(r#"{"uri":"data.txt"}"#, ContentUsage::Prompt),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(crate::fs::operations::content_before_open_hook_pending(
        &canonical, false
    ));
    approve.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), reached.wait())
        .await
        .unwrap();
    assert!(!crate::fs::operations::content_before_open_hook_pending(
        &canonical, false
    ));
    release.wait().await;
    assert!(
        matches!(task.await.unwrap().unwrap().payload, ContentPayload::Text { text } if text == "content")
    );
}

async fn skill_resource_cannot_follow_a_link_outside_the_skill_root() {
    let temp = TempDir::new().unwrap();
    let skill = temp.path().join("skills/review");
    fs::create_dir_all(skill.join("references")).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Review changes.\n---\nRead carefully.\n",
    )
    .unwrap();
    fs::write(temp.path().join("elsewhere.txt"), "outside skill").unwrap();
    std::os::unix::fs::symlink(
        temp.path().join("elsewhere.txt"),
        skill.join("references/link.txt"),
    )
    .unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{"skills":["review"]}},"skills":{"review":{"uri":"skills/review/SKILL.md"}}}"#;
    let ctx = context(temp.path(), document, Some(&origin), "full");
    let descriptors = discover_skills(&ctx).await.unwrap();
    let loaded = load_skill(&ctx, &descriptors[0].handle).await.unwrap();
    assert_eq!(
        read_skill_resource(&ctx, &loaded, "references/link.txt", None)
            .await
            .unwrap_err()
            .code,
        "PERMISSION"
    );
}

async fn activated_skill_root_cannot_be_replaced_before_resource_read() {
    let temp = TempDir::new().unwrap();
    let skill = temp.path().join("skills/review");
    fs::create_dir_all(skill.join("references")).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Review changes.\n---\nRead carefully.\n",
    )
    .unwrap();
    fs::write(skill.join("references/note.md"), "original").unwrap();
    let other = temp.path().join("other");
    fs::create_dir_all(other.join("references")).unwrap();
    fs::write(other.join("references/note.md"), "substituted").unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{"skills":["review"]}},"skills":{"review":{"uri":"skills/review/SKILL.md"}}}"#;
    let ctx = context(temp.path(), document, Some(&origin), "full");
    let descriptors = discover_skills(&ctx).await.unwrap();
    let loaded = load_skill(&ctx, &descriptors[0].handle).await.unwrap();
    fs::rename(&skill, temp.path().join("skills/original")).unwrap();
    std::os::unix::fs::symlink(&other, &skill).unwrap();
    let result = read_skill_resource(&ctx, &loaded, "references/note.md", None).await;
    assert_eq!(result.unwrap_err().code, "CORRELATION");
}

async fn activated_skill_root_cannot_be_replaced_during_file_open() {
    let temp = TempDir::new().unwrap();
    let skill = temp.path().join("skills/review");
    fs::create_dir_all(skill.join("references")).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Review changes.\n---\nRead carefully.\n",
    )
    .unwrap();
    fs::write(skill.join("references/note.md"), "original").unwrap();
    let other = temp.path().join("other");
    fs::create_dir_all(other.join("references")).unwrap();
    fs::write(other.join("references/note.md"), "substituted").unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{"skills":["review"]}},"skills":{"review":{"uri":"skills/review/SKILL.md"}}}"#;
    let ctx = context(temp.path(), document, Some(&origin), "full");
    let descriptors = discover_skills(&ctx).await.unwrap();
    let loaded = load_skill(&ctx, &descriptors[0].handle).await.unwrap();
    let reached = Arc::new(tokio::sync::Barrier::new(2));
    let release = Arc::new(tokio::sync::Barrier::new(2));
    let target = fs::canonicalize(skill.join("references/note.md")).unwrap();
    crate::fs::operations::install_content_before_open_hook(
        target,
        reached.clone(),
        release.clone(),
    );
    let task = tokio::spawn(async move {
        read_skill_resource(&ctx, &loaded, "references/note.md", None).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), reached.wait())
        .await
        .unwrap();
    fs::rename(&skill, temp.path().join("skills/original")).unwrap();
    std::os::unix::fs::symlink(&other, &skill).unwrap();
    release.wait().await;
    assert!(task.await.unwrap().is_err());
}

async fn activated_skill_root_cannot_be_replaced_during_approval() {
    let temp = TempDir::new().unwrap();
    let skill = temp.path().join("skills/review");
    fs::create_dir_all(skill.join("references")).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Review changes.\n---\nRead carefully.\n",
    )
    .unwrap();
    fs::write(skill.join("references/note.md"), "original").unwrap();
    let other = temp.path().join("other");
    fs::create_dir_all(other.join("references")).unwrap();
    fs::write(other.join("references/note.md"), "substituted").unwrap();
    let path = PathContext {
        workspace: temp.path().into(),
        home: temp.path().into(),
    };
    let ask = normalize_requested(serde_json::from_value(json!({"preset":"read-only", "rules":[{"action":"read", "effect":"ask", "match":"skills/review/references/note.md"}]})).unwrap(), path.clone()).unwrap();
    let allow = || {
        normalize_requested(serde_json::from_value(json!("full")).unwrap(), path.clone()).unwrap()
    };
    let callback_skill = skill.clone();
    let original = temp.path().join("skills/original");
    let callback = Arc::new(move |_: ContentAdmission| {
        let (skill, original, other) = (callback_skill.clone(), original.clone(), other.clone());
        Box::pin(async move {
            fs::rename(&skill, &original).unwrap();
            std::os::unix::fs::symlink(&other, &skill).unwrap();
            Ok(())
        }) as Pin<Box<dyn Future<Output = ContentResult<()>> + Send>>
    });
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{"skills":["review"]}},"skills":{"review":{"uri":"skills/review/SKILL.md"}}}"#;
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
    let descriptors = discover_skills(&ctx).await.unwrap();
    let loaded = load_skill(&ctx, &descriptors[0].handle).await.unwrap();
    let result = read_skill_resource(&ctx, &loaded, "references/note.md", None).await;
    assert!(result.is_err());
}

async fn substituted_fifo_must_not_be_opened_after_type_check() {
    use std::os::unix::ffi::OsStrExt;
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("data.txt");
    fs::write(&file, "regular").unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let ctx = context(
        temp.path(),
        r#"{"agents":{"worker":{}}}"#,
        Some(&origin),
        "full",
    );
    let canonical = fs::canonicalize(&file).unwrap();
    let before = Arc::new(tokio::sync::Barrier::new(2));
    let before_release = Arc::new(tokio::sync::Barrier::new(2));
    crate::fs::operations::install_content_before_open_hook(
        canonical.clone(),
        before.clone(),
        before_release.clone(),
    );
    let task = tokio::spawn(async move {
        resolve_content(
            &ctx,
            use_source(r#"{"uri":"data.txt"}"#, ContentUsage::Resource),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), before.wait())
        .await
        .unwrap();
    fs::remove_file(&file).unwrap();
    let path = std::ffi::CString::new(file.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    before_release.wait().await;
    let error = tokio::time::timeout(std::time::Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(
        error.message.contains("Permission denied"),
        "unexpected error: {error:?}"
    );
}

pub(super) const CASE_NAMES: &[&str] = &[
    "file_reads_preserve_bytes_json_and_literal_data",
    "skill_metadata_activation_resources_and_denials_use_real_files",
    "ask_waits_for_the_correlated_native_decision_before_reading",
    "ask_does_not_reach_the_open_boundary_until_approved",
    "skill_resource_cannot_follow_a_link_outside_the_skill_root",
    "activated_skill_root_cannot_be_replaced_before_resource_read",
    "activated_skill_root_cannot_be_replaced_during_file_open",
    "activated_skill_root_cannot_be_replaced_during_approval",
    "substituted_fifo_must_not_be_opened_after_type_check",
];

async fn execute(name: &str) -> Result<(), String> {
    match name {
        "file_reads_preserve_bytes_json_and_literal_data" => {
            file_reads_preserve_bytes_json_and_literal_data().await
        }
        "skill_metadata_activation_resources_and_denials_use_real_files" => {
            skill_metadata_activation_resources_and_denials_use_real_files().await
        }
        "ask_waits_for_the_correlated_native_decision_before_reading" => {
            ask_waits_for_the_correlated_native_decision_before_reading().await
        }
        "ask_does_not_reach_the_open_boundary_until_approved" => {
            ask_does_not_reach_the_open_boundary_until_approved().await
        }
        "skill_resource_cannot_follow_a_link_outside_the_skill_root" => {
            skill_resource_cannot_follow_a_link_outside_the_skill_root().await
        }
        "activated_skill_root_cannot_be_replaced_before_resource_read" => {
            activated_skill_root_cannot_be_replaced_before_resource_read().await
        }
        "activated_skill_root_cannot_be_replaced_during_file_open" => {
            activated_skill_root_cannot_be_replaced_during_file_open().await
        }
        "activated_skill_root_cannot_be_replaced_during_approval" => {
            activated_skill_root_cannot_be_replaced_during_approval().await
        }
        "substituted_fifo_must_not_be_opened_after_type_check" => {
            substituted_fifo_must_not_be_opened_after_type_check().await
        }
        _ => return Err("Unknown native content QA case".into()),
    }
    Ok(())
}

/// The caller must have initialized the executable and must expose this only
/// through the dedicated debug QA binary, never through IPC.
pub(crate) async fn run_selected(selection: &str) -> Result<String, String> {
    let names: &[&str] = if selection == "all" {
        CASE_NAMES
    } else {
        std::slice::from_ref(&selection)
    };
    if names.iter().any(|name| !CASE_NAMES.contains(name)) {
        return Err("Unknown native content QA case".into());
    }
    file_helper::enable_qa_chain().map_err(|error| error.to_string())?;
    let mut results = Vec::with_capacity(names.len());
    for name in names {
        execute(name).await?;
        results.push(json!({"case": name, "success": true}));
    }
    serde_json::to_string(&json!({"format":"macro-agsdl-content-qa/1", "cases":results}))
        .map_err(|error| error.to_string())
}
