use super::*;
use crate::core::workspace_execution::execute_workspace_tool_controlled;
use crate::git::GitState;
use tempfile::TempDir;

async fn execute(
    root: &std::path::Path,
    settings: LanguageServerSettings,
    tool: &str,
    args: Value,
    id: Option<String>,
) -> Value {
    let response = TEST_SETTINGS
        .scope(
            settings,
            execute_workspace_tool_controlled(
                root.to_owned(),
                root.to_owned(),
                GitState::new(),
                "Implement".into(),
                tool.into(),
                args,
                None,
                None,
                None,
                None,
                None,
                id,
            ),
        )
        .await
        .expect("real workspace mutation");
    serde_json::from_str(&response).expect("JSON tool response")
}

#[tokio::test]
#[ignore = "Requires explicitly installed TypeScript server via MACRO_LSP_TEST_NODE and MACRO_LSP_TEST_SERVER"]
async fn real_typescript_write_error_then_edit_correction() {
    let root = TempDir::new().unwrap();
    let root = root.path().canonicalize().unwrap();
    std::fs::write(
        root.join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}"#,
    )
    .unwrap();
    let settings = LanguageServerSettings {
        enabled: true,
        executable: std::env::var("MACRO_LSP_TEST_NODE").expect("explicit Node executable"),
        arguments: vec![
            std::env::var("MACRO_LSP_TEST_SERVER").expect("explicit server entrypoint"),
            "--stdio".into(),
        ],
        workspace_roots: vec![root.to_string_lossy().into_owned()],
        wait_ms: 10000,
    };
    let failed = execute(
        &root,
        settings.clone(),
        "write",
        json!({"path":"sample.ts", "content":"export const value: string = 42;\n"}),
        None,
    )
    .await;
    eprintln!("TypeScript write: {}", failed["diagnostics"]);
    assert_eq!(failed["ok"], true);
    assert_eq!(failed["diagnostics"][0]["status"], "ready");
    assert!(failed["diagnostics"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["code"] == 2322));
    let fixed = execute(
        &root,
        settings,
        "edit",
        json!({"path":"sample.ts", "old_text":"= 42", "new_text":"= 'fixed'"}),
        None,
    )
    .await;
    eprintln!("TypeScript correction: {}", fixed["diagnostics"]);
    assert_eq!(fixed["diagnostics"][0]["status"], "ready");
    assert_eq!(fixed["diagnostics"][0]["items"], json!([]));
    assert_ne!(
        fixed["diagnostics"][0]["session"],
        failed["diagnostics"][0]["session"]
    );
    assert_ne!(
        fixed["diagnostics"][0]["revision"],
        failed["diagnostics"][0]["revision"]
    );
}

#[cfg(unix)]
fn fixture(root: &std::path::Path, mode: &str) -> LanguageServerSettings {
    let executable = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|path| path.join("python3"))
        .find(|path| path.is_file())
        .expect("Python 3 for protocol fixture");
    LanguageServerSettings {
        enabled: true,
        executable: executable.to_string_lossy().into_owned(),
        arguments: vec![
            format!(
                "{}/src/core/workspace_execution/post_write_diagnostics/fixture.py",
                env!("CARGO_MANIFEST_DIR")
            ),
            mode.into(),
        ],
        workspace_roots: vec![root.canonicalize().unwrap().to_string_lossy().into_owned()],
        wait_ms: 2000,
    }
}

#[cfg(unix)]
async fn opened(root: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !root.join("lsp-opened").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("server received committed overlay");
}

#[cfg(unix)]
#[tokio::test]
async fn lsp_statuses_distinguish_absence_failure_wait_and_stale_version() {
    for (mode, expected) in [
        ("ready", "ready"),
        ("pending", "pending"),
        ("wrong_uri", "pending"),
        ("stale", "stale"),
        ("startup_timeout", "timeout"),
        ("startup_failure", "failed"),
        ("exit", "failed"),
    ] {
        let root = TempDir::new().unwrap();
        let start = Instant::now();
        let response = execute(
            root.path(),
            fixture(root.path(), mode),
            "write",
            json!({"path":"sample.ts", "content":"good"}),
            None,
        )
        .await;
        assert_eq!(
            response["diagnostics"][0]["status"], expected,
            "{mode}: {response}"
        );
        assert_eq!(response["diagnostics"][0]["items"], json!([]));
        assert!(start.elapsed() < Duration::from_secs(5), "unbounded {mode}");
    }
    let root = TempDir::new().unwrap();
    let mut settings = fixture(root.path(), "ready");
    settings.executable = root
        .path()
        .join("missing-server")
        .to_string_lossy()
        .into_owned();
    let missing = execute(
        root.path(),
        settings.clone(),
        "write",
        json!({"path":"sample.ts", "content":"good"}),
        None,
    )
    .await;
    assert_eq!(missing["diagnostics"][0]["status"], "unavailable");
    settings.enabled = false;
    let disabled = execute(
        root.path(),
        settings,
        "write",
        json!({"path":"sample.ts", "content":"good"}),
        None,
    )
    .await;
    assert_eq!(disabled["diagnostics"][0]["status"], "disabled");
    assert!(!root.path().join("lsp-opened").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn lsp_later_publication_replaces_errors_and_bounds_server_payload() {
    let root = TempDir::new().unwrap();
    for (mode, count) in [("replacement", 0), ("many", MAX_DIAGNOSTICS)] {
        let response = execute(
            root.path(),
            fixture(root.path(), mode),
            "write",
            json!({"path":"sample.ts", "content":"bad"}),
            None,
        )
        .await;
        let result = &response["diagnostics"][0];
        assert_eq!(result["status"], "ready");
        assert_eq!(result["items"].as_array().unwrap().len(), count);
        if count > 0 {
            assert_eq!(result["truncated"], true);
            assert_eq!(result["items"][0]["message"].as_str().unwrap().len(), 2048);
            assert!(result["items"][0].get("data").is_none());
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn lsp_cancellation_preserves_the_committed_write() {
    let root = TempDir::new().unwrap();
    let settings = fixture(root.path(), "pending");
    let id = uuid::Uuid::new_v4().to_string();
    let mutation = execute(
        root.path(),
        settings,
        "write",
        json!({"path":"sample.ts", "content":"good"}),
        Some(id.clone()),
    );
    let cancel = async {
        opened(root.path()).await;
        assert!(crate::core::workspace_execution::tool_cancel_workspace(id));
    };
    let (response, ()) = tokio::join!(mutation, cancel);
    assert_eq!(response["ok"], true);
    assert_eq!(response["diagnostics"][0]["status"], "cancelled");
    assert_eq!(
        std::fs::read_to_string(root.path().join("sample.ts")).unwrap(),
        "good"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn lsp_concurrent_mutation_and_deletion_invalidate_observations() {
    for delete in [false, true] {
        let root = TempDir::new().unwrap();
        let settings = fixture(root.path(), "delayed");
        let mutation = execute(
            root.path(),
            settings.clone(),
            "write",
            json!({"path":"sample.ts", "content":"bad"}),
            None,
        );
        let change = async {
            opened(root.path()).await;
            if delete {
                std::fs::remove_file(root.path().join("sample.ts")).unwrap();
            } else {
                let mut disabled = settings;
                disabled.enabled = false;
                let response = execute(
                    root.path(),
                    disabled,
                    "edit",
                    json!({"path":"sample.ts", "old_text":"bad", "new_text":"good"}),
                    None,
                )
                .await;
                assert_eq!(response["ok"], true);
            }
        };
        let (response, ()) = tokio::join!(mutation, change);
        assert_eq!(response["diagnostics"][0]["status"], "stale");
        assert_eq!(response["diagnostics"][0]["items"], json!([]));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn lsp_patch_is_scoped_to_authorized_root_and_server_edits_stay_unhandled() {
    let root = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let settings = fixture(root.path(), "apply_edit");
    let patch = "*** Begin Patch\n*** Add File: sample.ts\n+bad\n*** End Patch";
    let response = execute(
        root.path(),
        settings.clone(),
        "apply_patch",
        json!({"patch_text":patch}),
        None,
    )
    .await;
    assert_eq!(response["diagnostics"][0]["status"], "ready");
    let server_reply: Value = serde_json::from_slice(
        &std::fs::read(root.path().join("apply-edit-response.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(server_reply["error"]["code"], -32601);
    let denied = execute(
        other.path(),
        settings,
        "write",
        json!({"path":"sample.ts", "content":"good"}),
        None,
    )
    .await;
    assert_eq!(denied["diagnostics"][0]["status"], "unavailable");
    assert!(!other.path().join("lsp-opened").exists());
    let deleted = execute(
        root.path(),
        fixture(root.path(), "ready"),
        "apply_patch",
        json!({"patch_text":"*** Begin Patch\n*** Delete File: sample.ts\n*** End Patch"}),
        None,
    )
    .await;
    assert_eq!(deleted["diagnostics"][0]["status"], "deleted");
}

#[cfg(unix)]
#[tokio::test]
async fn lsp_worktree_and_explicit_mount_keep_their_captured_root() {
    use crate::core::workspace_execution::WorkspaceProjectMount;
    let container = TempDir::new().unwrap();
    let main = container.path().join("main");
    let tree = container.path().join("worktree");
    let repo = git2::Repository::init(&main).unwrap();
    let tree_id = repo.index().unwrap().write_tree().unwrap();
    let tree_object = repo.find_tree(tree_id).unwrap();
    let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "Initial fixture",
        &tree_object,
        &[],
    )
    .unwrap();
    repo.worktree("task", &tree, None).unwrap();
    let settings = fixture(&tree, "ready");
    let mounts = vec![
        WorkspaceProjectMount {
            project_id: "task".into(),
            mount_name: "task".into(),
            workspace_path: Some(tree.to_string_lossy().into_owned()),
            display_name: None,
            is_read_only: false,
        },
        WorkspaceProjectMount {
            project_id: "main".into(),
            mount_name: "main".into(),
            workspace_path: Some(main.to_string_lossy().into_owned()),
            display_name: None,
            is_read_only: false,
        },
    ];
    let output = TEST_SETTINGS
        .scope(
            settings,
            execute_workspace_tool_controlled(
                main.clone(),
                main.clone(),
                GitState::new(),
                "Implement".into(),
                "write".into(),
                json!({"path": "task/sample.ts", "content": "bad"}),
                None,
                None,
                Some(mounts),
                Some(true),
                Some("main".into()),
                None,
            ),
        )
        .await
        .unwrap();
    let response: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(response["diagnostics"][0]["status"], "ready");
    assert_eq!(
        response["diagnostics"][0]["root"],
        json!(tree.canonicalize().unwrap())
    );
    assert!(tree.join("sample.ts").exists());
    assert!(!main.join("sample.ts").exists());
    assert!(!main.join("lsp-opened").exists());
}

#[test]
fn lsp_configuration_contract_is_sensitive_user_only_and_bounded() {
    use crate::config::{ConfigScope, ConfigSensitivity};
    let root = TempDir::new().unwrap();
    let value = json!({"$schema":"./schemas/v1/tools.schema.json", "schemaVersion": 1, "languageServer": {
        "enabled": true, "executable": root.path().join("server"), "workspaceRoots": [root.path()], "waitMs": 4000
    }});
    assert!(
        crate::config::validate_document(ConfigDocumentKind::Tools, &ConfigScope::User, &value)
            .valid
    );
    assert!(
        !crate::config::validate_document(
            ConfigDocumentKind::Tools,
            &ConfigScope::Project {
                project_id: "project".into()
            },
            &value
        )
        .valid
    );
    assert!(crate::config::descriptors()
        .iter()
        .any(|entry| entry.document == ConfigDocumentKind::Tools
            && entry.json_pointer == "/languageServer"
            && entry.sensitivity == ConfigSensitivity::ApprovalRequired));
    for (field, invalid) in [
        ("waitMs", json!(10001)),
        ("executable", json!("node")),
        ("workspaceRoots", json!(["."])),
    ] {
        let mut invalid_value = value.clone();
        invalid_value["languageServer"][field] = invalid;
        assert!(
            !crate::config::validate_document(
                ConfigDocumentKind::Tools,
                &ConfigScope::User,
                &invalid_value
            )
            .valid,
            "{field}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn lsp_root_replacement_invalidates_even_identical_content() {
    use std::os::unix::fs::symlink;
    let container = TempDir::new().unwrap();
    let root = container.path().join("workspace");
    let moved = container.path().join("moved");
    let outside = container.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("sample.ts"), "bad").unwrap();
    let mutation = execute(
        &root,
        fixture(&root, "delayed"),
        "write",
        json!({"path":"sample.ts", "content":"bad"}),
        None,
    );
    let replace = async {
        opened(&root).await;
        std::fs::rename(&root, &moved).unwrap();
        symlink(&outside, &root).unwrap();
    };
    let (response, ()) = tokio::join!(mutation, replace);
    assert_eq!(response["diagnostics"][0]["status"], "stale");
    assert_eq!(response["diagnostics"][0]["items"], json!([]));
}

#[cfg(unix)]
#[tokio::test]
async fn lsp_batch_limit_is_explicit_and_preserves_all_writes() {
    let root = TempDir::new().unwrap();
    let patch = "*** Begin Patch\n*** Add File: a.ts\n+good\n*** Add File: b.ts\n+good\n*** Add File: c.ts\n+good\n*** Add File: d.ts\n+good\n*** Add File: e.ts\n+good\n*** End Patch";
    let response = execute(
        root.path(),
        fixture(root.path(), "ready"),
        "apply_patch",
        json!({"patch_text":patch}),
        None,
    )
    .await;
    assert_eq!(response["files"].as_array().unwrap().len(), 5);
    assert_eq!(response["diagnostics"][4]["reason"], "document_count_limit");
    assert_eq!(response["diagnostics"][4]["omitted_documents"], 1);
    assert!(root.path().join("e.ts").exists());
}

// The response's identity must survive the IPC boundary: a later read of the
// same bytes at the same path must distinguish a newly installed directory.
#[cfg(unix)]
#[tokio::test]
async fn lsp_observation_identity_matches_reads_and_detects_replacement_after_response() {
    use crate::core::workspace_execution::WorkspaceProjectMount;
    for virtual_root in [false, true] {
        for tool in ["write", "edit", "apply_patch"] {
            let container = TempDir::new().unwrap();
            let root = container.path().join("workspace");
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("sample.ts"), "before").unwrap();
            let path = if virtual_root {
                "web/sample.ts"
            } else {
                "sample.ts"
            };
            let args = match tool {
                "write" => json!({"path":path,"content":"bad"}),
                "edit" => json!({"path":path,"old_text":"before","new_text":"bad"}),
                _ => {
                    json!({"patch_text":format!("*** Begin Patch\n*** Update File: {path}\n@@\n-before\n+bad\n*** End Patch")})
                }
            };
            let output = TEST_SETTINGS
                .scope(
                    fixture(&root, "ready"),
                    execute_workspace_tool_controlled(
                        root.clone(),
                        root.clone(),
                        GitState::new(),
                        "Implement".into(),
                        tool.into(),
                        args,
                        None,
                        None,
                        virtual_root.then(|| {
                            vec![WorkspaceProjectMount {
                                project_id: "web".into(),
                                mount_name: "web".into(),
                                workspace_path: Some(root.to_string_lossy().into_owned()),
                                display_name: None,
                                is_read_only: false,
                            }]
                        }),
                        Some(virtual_root),
                        None,
                        None,
                    ),
                )
                .await
                .unwrap();
            let result: Value = serde_json::from_str(&output).unwrap();
            let observation = &result["diagnostics"][0];
            assert_eq!(
                observation["status"], "ready",
                "{tool}, {virtual_root}: {result}"
            );
            let observed_root = PathBuf::from(observation["workspace_path"].as_str().unwrap());
            let observed_path = observation["document_path"].as_str().unwrap().to_owned();
            let stable = fs::read_file_internal(&observed_root, observed_path.clone(), Some(false))
                .await
                .unwrap();
            assert!(stable.workspace_identity.is_some());
            assert_eq!(
                json!(stable.workspace_identity),
                observation["root_identity"]
            );
            assert_eq!(json!(stable.revision), observation["revision"]);
            // Simulate a completed checkpoint before replacing the directory.
            std::fs::rename(&root, container.path().join("original")).unwrap();
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("sample.ts"), &stable.content).unwrap();
            let replaced =
                fs::read_file_internal(&observed_root, observed_path.clone(), Some(false))
                    .await
                    .unwrap();
            assert_eq!(replaced.revision, stable.revision);
            assert_ne!(replaced.workspace_identity, stable.workspace_identity);
            let unconfined = fs::read_file_internal(&root, observed_path, Some(true))
                .await
                .unwrap();
            assert_eq!(unconfined.workspace_identity, None);
            assert_eq!(
                std::fs::read_to_string(container.path().join("original/sample.ts")).unwrap(),
                stable.content
            );
        }
    }
}
