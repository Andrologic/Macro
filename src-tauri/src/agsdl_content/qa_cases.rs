//! Physical content regressions; compiled only in the native debug QA binary.
use super::*;
use crate::agsdl_permissions::{normalize_requested, PathContext, RequestedPermissions};
use serde_json::json;
use std::fs;
use std::path::Path;
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

async fn nested_skill_resource_rejects_replaced_root_with_same_parent() {
    let temp = TempDir::new().unwrap();
    let skill = temp.path().join("skills/review");
    let parent = skill.join("references");
    fs::create_dir_all(&parent).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Review changes.\n---\nRead carefully.\n",
    )
    .unwrap();
    fs::write(parent.join("note.md"), "original").unwrap();
    let origin = Url::from_file_path(temp.path().join("document.json"))
        .unwrap()
        .to_string();
    let document = r#"{"agents":{"worker":{"skills":["review"]}},"skills":{"review":{"uri":"skills/review/SKILL.md"}}}"#;
    let ctx = context(temp.path(), document, Some(&origin), "full");
    let descriptors = discover_skills(&ctx).await.unwrap();
    let loaded = load_skill(&ctx, &descriptors[0].handle).await.unwrap();
    let stable = read_skill_resource(&ctx, &loaded, "references/note.md", None)
        .await
        .unwrap();
    assert!(matches!(stable.payload, ContentPayload::Text { text } if text == "original"));
    let root_before = crate::fs::operations::workspace_root_identity(&skill).unwrap();
    let parent_before = crate::fs::operations::workspace_root_identity(&parent).unwrap();
    let target = fs::canonicalize(parent.join("note.md")).unwrap();
    let reached = Arc::new(tokio::sync::Barrier::new(2));
    let release = Arc::new(tokio::sync::Barrier::new(2));
    crate::fs::operations::install_content_before_open_hook(
        target.clone(),
        reached.clone(),
        release.clone(),
    );
    let task = tokio::spawn(async move {
        read_skill_resource(&ctx, &loaded, "references/note.md", None).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), reached.wait())
        .await
        .unwrap();
    let old_root = temp.path().join("skills/original");
    fs::rename(&skill, &old_root).unwrap();
    fs::create_dir(&skill).unwrap();
    fs::rename(old_root.join("references"), &parent).unwrap();
    assert_ne!(
        crate::fs::operations::workspace_root_identity(&skill).unwrap(),
        root_before
    );
    assert_eq!(
        crate::fs::operations::workspace_root_identity(&parent).unwrap(),
        parent_before
    );
    assert_eq!(fs::canonicalize(parent.join("note.md")).unwrap(), target);
    release.wait().await;
    let result = task.await.unwrap();
    let error = result
        .err()
        .expect("changed skill root was accepted through the unchanged parent");
    assert_eq!(error.code, "CORRELATION");
    assert_eq!(
        error.message,
        "Activated skill root changed during resource read."
    );
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

// These cases exercise the same Swift/Rust bridge and the same image that is
// currently executing the dedicated QA binary, not a standalone fixture.
fn qa_reap_without_abandoning_owner(
    launch: &mut super::macos_launcher::Launch,
) -> Result<super::macos_launcher::Exit, String> {
    use std::time::Duration;
    let mut late = false;
    loop {
        match launch.wait(Duration::from_secs(5)) {
            Ok(Some(status)) if !late => return Ok(status),
            Ok(Some(_)) => return Err("Helper reaped only after the QA deadline".into()),
            Ok(None) => {
                if !late {
                    eprintln!("content QA: helper termination remains uncertain; retaining handle");
                    late = true;
                }
            }
            Err(error) => {
                if !late {
                    eprintln!("content QA: wait failed; retaining handle: {error}");
                    late = true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

async fn authenticated_image_substitution_is_rejected_at_launch() {
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let image = root.join("image");
    let attacker = root.join("attacker");
    let marker = root.join("attacker-marker");
    fs::write(root.join("data.txt"), b"authenticated").unwrap();
    fs::copy(std::env::current_exe().unwrap(), &image).unwrap();
    fs::set_permissions(&image, fs::Permissions::from_mode(0o700)).unwrap();
    let directory = fs::File::open(root).unwrap();
    let mut positive =
        super::macos_launcher::Launch::start(&image, Path::new("data.txt"), directory.as_raw_fd())
            .unwrap();
    let duplicated = unsafe { libc::fcntl(positive.output.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    assert!(
        duplicated >= 0,
        "cannot duplicate authenticated helper output"
    );
    let mut output = fs::File::from(unsafe { OwnedFd::from_raw_fd(duplicated) });
    let mut bytes = Vec::new();
    output.read_to_end(&mut bytes).unwrap();
    let status = qa_reap_without_abandoning_owner(&mut positive)
        .expect("authenticated helper termination was uncertain");
    assert!(
        !status.signal && status.status == 0,
        "authenticated image was refused"
    );
    assert_eq!(bytes, b"authenticated");

    let quoted = marker.to_str().unwrap().replace('\'', "'\\''");
    let script = format!("#!/bin/sh\nprintf attacked > '{quoted}'\n");
    fs::write(&attacker, script.as_bytes()).unwrap();
    fs::set_permissions(&attacker, fs::Permissions::from_mode(0o700)).unwrap();
    // Negative control: this exact replacement is capable of writing the marker
    // if launched without the identity requirement.
    let baseline = crate::core::process::background_command(&attacker)
        .args(["--macro-internal-agsdl-content-read", "0", "data.txt"])
        .status()
        .unwrap();
    assert!(
        baseline.success() && marker.is_file(),
        "attacker negative control did not execute"
    );
    fs::remove_file(&marker).unwrap();
    super::macos_launcher::arm_image_swap(&image, &attacker).unwrap();
    let attempt =
        super::macos_launcher::Launch::start(&image, Path::new("data.txt"), directory.as_raw_fd());
    assert!(!attacker.exists(), "QA swap did not occur");
    assert_eq!(
        fs::read(&image).unwrap(),
        script.as_bytes(),
        "wrong replacement image"
    );
    match attempt {
        Err(error) => assert_eq!(
            error.to_string(),
            "Content helper launch failed (4)",
            "launch did not fail at the intended boundary"
        ),
        Ok(mut launch) => {
            let status = qa_reap_without_abandoning_owner(&mut launch)
                .expect("substituted helper termination was uncertain");
            assert!(
                status.signal && status.status == libc::SIGKILL,
                "substituted image was not killed by launch requirement"
            );
        }
    }
    assert!(
        !marker.exists(),
        "substituted image wrote its attacker marker"
    );
}

async fn native_wait_timeout_retains_handle_until_real_reap() {
    use std::os::fd::AsRawFd;
    use std::time::Duration;

    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("bulk.bin"), vec![9u8; 10 * 1024 * 1024]).unwrap();
    let directory = fs::File::open(temp.path()).unwrap();
    let mut launch = super::macos_launcher::Launch::start(
        &std::env::current_exe().unwrap(),
        Path::new("bulk.bin"),
        directory.as_raw_fd(),
    )
    .unwrap();
    let mut poll = libc::pollfd {
        fd: launch.output.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let readable = unsafe { libc::poll(&mut poll, 1, 10_000) };
    let before = launch.qa_handle_identity();
    let writer_open = launch.qa_control_open();
    let pending = launch.wait(Duration::ZERO);
    let after = launch.qa_handle_identity();
    // Release the real helper before making assertions, so failed assertions
    // cannot strand a child merely because the test observed an unexpected state.
    launch.cancel();
    if matches!(&pending, Ok(Some(_))) {
        panic!("helper exited before zero-duration wait could observe it alive");
    }
    let final_status = qa_reap_without_abandoning_owner(&mut launch);
    assert!(readable > 0, "real helper never reached blocked stdout");
    assert!(
        writer_open && before.is_some() && before == after,
        "owner or control changed before timeout"
    );
    assert!(
        matches!(pending, Ok(None)),
        "zero-duration wait did not time out on the living helper"
    );
    let status = final_status.expect("cancelled helper termination was uncertain");
    assert!(
        !status.signal && status.status == 125,
        "helper did not exit through its control monitor"
    );
    let second = match launch.wait(Duration::ZERO) {
        Err(error) => error,
        Ok(_) => panic!("reaped handle was consumed twice"),
    };
    assert_eq!(second.to_string(), "Helper already reaped");
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
    "nested_skill_resource_rejects_replaced_root_with_same_parent",
    "substituted_fifo_must_not_be_opened_after_type_check",
    "authenticated_image_substitution_is_rejected_at_launch",
    "native_wait_timeout_retains_handle_until_real_reap",
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
        "nested_skill_resource_rejects_replaced_root_with_same_parent" => {
            nested_skill_resource_rejects_replaced_root_with_same_parent().await
        }
        "substituted_fifo_must_not_be_opened_after_type_check" => {
            substituted_fifo_must_not_be_opened_after_type_check().await
        }
        "authenticated_image_substitution_is_rejected_at_launch" => {
            authenticated_image_substitution_is_rejected_at_launch().await
        }
        "native_wait_timeout_retains_handle_until_real_reap" => {
            native_wait_timeout_retains_handle_until_real_reap().await
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
