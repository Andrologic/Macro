use super::*;
use crate::fs::operations::{
    content_revision, install_write_before_revalidation_hook, EXPECTED_REVISION_ABSENT,
};
use crate::git::operations::{GitFileStatus, GitStatusDto};
use serde_json::{json, Value};
#[cfg(unix)]
use std::collections::BTreeMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::sync::Barrier;

async fn execute_readonly_workspace_tool(
    workspace: &Path,
    tool_id: &str,
    args: serde_json::Value,
) -> String {
    execute_workspace_tool(
        workspace.to_path_buf(),
        workspace.to_path_buf(),
        GitState::new(),
        "Implement".to_string(),
        tool_id.to_string(),
        args,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("execute read-only workspace tool")
}

#[cfg(unix)]
#[tokio::test]
async fn controlled_write_rejects_a_registered_root_replaced_by_symlink() {
    use std::os::unix::fs::symlink;

    let container = TempDir::new().expect("container");
    let workspace = container.path().join("workspace");
    let original = container.path().join("workspace-original");
    let outside = TempDir::new().expect("outside workspace");
    fs::create_dir(&workspace).expect("create registered workspace");
    let identity = crate::fs::operations::workspace_root_identity(&workspace)
        .expect("workspace root identity");
    let expected_roots = Arc::new(BTreeMap::from([(workspace.clone(), identity)]));

    fs::rename(&workspace, &original).expect("move registered workspace");
    symlink(outside.path(), &workspace).expect("replace workspace with external symlink");

    let error = execute_workspace_tool_controlled_with_options(
        workspace.clone(),
        workspace.clone(),
        GitState::new(),
        "Implement".to_string(),
        "write".to_string(),
        json!({ "path": "escaped.txt", "content": "must not escape" }),
        Some(workspace.to_string_lossy().into_owned()),
        None,
        None,
        Some(false),
        None,
        None,
        WorkspaceToolExecutionOptions {
            expected_workspace_roots: Some(expected_roots),
            ..WorkspaceToolExecutionOptions::default()
        },
    )
    .await
    .expect_err("replaced registered root must be rejected");

    assert!(error.message.contains("changed after server validation"));
    assert!(!outside.path().join("escaped.txt").exists());
    assert!(!original.join("escaped.txt").exists());
}

#[test]
fn command_error_serializes_revision_conflicts_with_a_stable_code() {
    let error =
        command_error("Failed to edit guarded.txt: Revision conflict: stale content".to_string());
    assert_eq!(
        serde_json::to_value(error).expect("serialize command error"),
        json!({
            "code": "REVISION_CONFLICT",
            "message": "Failed to edit guarded.txt: Revision conflict: stale content"
        })
    );
}

#[test]
fn command_error_serializes_tool_interruptions_with_stable_codes() {
    assert_eq!(
        serde_json::to_value(command_error("ordinary rejection")).expect("serialize error"),
        json!({"message": "ordinary rejection"}),
    );
    let cancelled = command_error("Tool execution cancelled: grep.");
    assert_eq!(cancelled.code(), Some("TOOL_EXECUTION_CANCELLED"));
    let timed_out =
        command_error("Tool execution timed out after 30 seconds: grep. Narrow the query.");
    assert_eq!(timed_out.code(), Some("TOOL_EXECUTION_TIMEOUT"));
}

#[tokio::test]
async fn confined_git_repo_rejects_a_wsl_path_from_a_native_workspace() {
    let workspace = TempDir::new().expect("workspace");
    let error = resolve_confined_wsl_repo_path_for_workspace(
        workspace.path(),
        r"\\wsl$\Ubuntu\home\user\repo",
    )
    .await
    .expect_err("native workspace must not route agent Git into WSL");

    assert!(error.message.contains("outside the selected workspace"));
}

#[tokio::test]
async fn confined_git_repo_rejects_a_different_wsl_distribution_before_io() {
    let workspace = Path::new(r"\\wsl$\Ubuntu\home\user\workspace");
    let error =
        resolve_confined_wsl_repo_path_for_workspace(workspace, r"\\wsl$\Debian\home\user\repo")
            .await
            .expect_err("agent Git must stay in the selected WSL distribution");

    assert!(error.message.contains("escapes WSL workspace"));
}

#[test]
fn agent_git_repo_validation_rejects_absolute_and_linked_external_directories() {
    let temp = TempDir::new().expect("temp dir");
    let workspace = temp.path().join("workspace");
    let inside = workspace.join("inside");
    let outside = temp.path().join("workspace-sibling");
    fs::create_dir_all(&inside).expect("create inside repo directory");
    fs::create_dir_all(&outside).expect("create outside repo directory");

    let validated = validate_agent_git_repo_path("inside", &workspace)
        .expect("relative repo inside selected workspace");
    assert_eq!(validated, inside.canonicalize().expect("canonical inside"));

    let absolute_error =
        validate_agent_git_repo_path(outside.to_string_lossy().as_ref(), &workspace)
            .expect_err("absolute sibling must be rejected for agent Git");
    assert!(absolute_error.message.contains("outside workspace"));

    let linked = workspace.join("linked");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &linked).expect("create directory symlink");
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(&outside, &linked).is_err() {
        return;
    }
    let linked_error = validate_agent_git_repo_path("linked", &workspace)
        .expect_err("linked external repo must be rejected for agent Git");
    assert!(linked_error.message.contains("outside workspace"));
}

#[tokio::test]
async fn tool_execution_cancellation_reaches_the_registered_backend_work() {
    let execution_id = "workspace-tool-cancellation-test";
    let (cancellation, guard) =
        register_tool_execution(Some(execution_id)).expect("register cancellation");
    assert!(tool_cancel_workspace(execution_id.to_string()));
    tokio::time::timeout(Duration::from_millis(100), cancellation.cancelled())
        .await
        .expect("cancellation notification");
    drop(guard);
    assert!(!super::TOOL_EXECUTION_CANCELLATION_REGISTRY
        .lock()
        .expect("tool cancellation registry")
        .active
        .contains_key(execution_id));
}

#[tokio::test]
async fn tool_execution_cancellation_before_registration_is_not_lost() {
    let execution_id = "workspace-tool-pre-registration-cancellation-test";
    assert!(!tool_cancel_workspace(execution_id.to_string()));

    let (cancellation, guard) =
        register_tool_execution(Some(execution_id)).expect("register cancelled execution");
    tokio::time::timeout(Duration::from_millis(100), cancellation.cancelled())
        .await
        .expect("pre-registration cancellation notification");
    assert!(cancellation.is_cancelled());
    drop(guard);
}

#[test]
fn search_tools_have_hard_backend_deadlines() {
    assert_eq!(tool_execution_timeout("glob"), Some(Duration::from_secs(5)));
    assert_eq!(
        tool_execution_timeout("grep"),
        Some(Duration::from_secs(30))
    );
    assert_eq!(
        tool_execution_timeout("ast_grep"),
        Some(Duration::from_secs(30))
    );
    assert_eq!(tool_execution_timeout("git_diff"), None);
}

#[test]
fn git_status_pages_are_bounded_and_bound_to_the_status_revision() {
    let build_status = || GitStatusDto {
        branch: "develop".to_string(),
        head_commit: None,
        staged_files: vec![GitFileStatus {
            path: "a.rs".to_string(),
            status: "modified".to_string(),
            old_path: None,
        }],
        unstaged_files: vec![GitFileStatus {
            path: "b.rs".to_string(),
            status: "modified".to_string(),
            old_path: None,
        }],
        untracked_files: vec![GitFileStatus {
            path: "c.rs".to_string(),
            status: "untracked".to_string(),
            old_path: None,
        }],
        conflicted_files: Vec::new(),
        merge_in_progress: false,
        is_clean: false,
        has_origin: true,
        has_upstream: true,
        ahead: 1,
        behind: 0,
    };

    let first: serde_json::Value = serde_json::from_str(
        &format_bounded_git_status(".", build_status(), &json!({ "limit": 2 }))
            .expect("first status page"),
    )
    .expect("first status JSON");
    assert_eq!(first["total_count"], 3);
    assert_eq!(first["truncated"], true);
    assert_eq!(first["staged_files"].as_array().unwrap().len(), 1);
    assert_eq!(first["unstaged_files"].as_array().unwrap().len(), 1);

    let second: serde_json::Value = serde_json::from_str(
        &format_bounded_git_status(
            ".",
            build_status(),
            &json!({ "limit": 2, "cursor": first["next_cursor"] }),
        )
        .expect("second status page"),
    )
    .expect("second status JSON");
    assert_eq!(second["offset"], 2);
    assert_eq!(second["untracked_files"].as_array().unwrap().len(), 1);
    assert_eq!(second["truncated"], false);

    let mut changed = build_status();
    changed.untracked_files.push(GitFileStatus {
        path: "d.rs".to_string(),
        status: "untracked".to_string(),
        old_path: None,
    });
    let stale = format_bounded_git_status(
        ".",
        changed,
        &json!({ "limit": 2, "cursor": first["next_cursor"] }),
    )
    .expect_err("changed status must invalidate the cursor");
    assert!(stale.message.contains("does not belong"));
}

#[test]
fn git_tree_cursor_scope_rejects_a_changed_tree_revision() {
    let first_scope = "git_get_tree\0.\0HEAD\0commit-a:status-a";
    let cursor = super::tool_output::create_tool_cursor(first_scope, 2);
    let changed_scope = "git_get_tree\0.\0HEAD\0commit-a:status-b";

    let error = super::tool_output::resolve_tool_page(
        &json!({ "cursor": cursor, "limit": 2 }),
        changed_scope,
        super::tool_output::GIT_TREE_DEFAULT_LIMIT,
        super::tool_output::GIT_TREE_MAX_LIMIT,
    )
    .expect_err("changed tree status must invalidate the cursor");

    assert!(error.message.contains("does not belong"));
}

#[test]
fn exact_edit_requires_one_match_unless_replace_all_is_enabled() {
    assert_eq!(exact_edit_match_error("src/app.ts", 1, false), None);
    assert_eq!(exact_edit_match_error("src/app.ts", 2, true), None);
    assert_eq!(
        exact_edit_match_error("src/app.ts", 0, false),
        Some("No match found for old_text in src/app.ts.".to_string())
    );
    assert!(exact_edit_match_error("src/app.ts", 2, false)
        .expect("ambiguous match")
        .contains("old_text matched 2 locations"));
}

#[test]
fn resolve_requested_workspace_uses_metadata_root_for_relative_paths() {
    let default_workspace = TempDir::new().expect("default workspace");
    let metadata_workspace = TempDir::new().expect("metadata workspace");
    let project_dir = metadata_workspace
        .path()
        .join("projects")
        .join("smartcards");
    fs::create_dir_all(&project_dir).expect("create project dir");

    let resolved = resolve_requested_workspace(
        default_workspace.path(),
        metadata_workspace.path(),
        Some("projects/smartcards"),
    )
    .expect("resolve requested workspace");

    assert_eq!(
        resolved,
        project_dir.canonicalize().expect("canonical project dir")
    );
}

#[tokio::test]
async fn resolve_workspace_for_tool_path_falls_back_to_dot_macro_when_workspace_is_not_git() {
    let workspace = TempDir::new().expect("workspace");

    let resolved =
        resolve_workspace_for_tool_path(workspace.path(), &GitState::new(), None, Some("metadata"))
            .await
            .expect("resolve metadata workspace");

    assert_eq!(resolved, workspace.path().join(".macro"));
}

#[test]
fn parse_apply_patch_supports_add_update_delete_sections() {
    let parsed = parse_apply_patch(
        [
            "*** Begin Patch",
            "*** Update File: src/app.ts",
            "@@",
            "-before",
            "+after",
            "*** Add File: notes.md",
            "+hello",
            "*** Delete File: old.md",
            "*** End Patch",
        ]
        .join("\n")
        .as_str(),
    )
    .expect("parse apply_patch");

    assert_eq!(parsed.len(), 3);
    match &parsed[0] {
        ParsedPatchOperation::Update { path, hunks } => {
            assert_eq!(path, "src/app.ts");
            assert_eq!(hunks.len(), 1);
        }
        _ => panic!("expected update operation"),
    }
    match &parsed[1] {
        ParsedPatchOperation::Add { path, lines } => {
            assert_eq!(path, "notes.md");
            assert_eq!(lines, &vec!["hello".to_string()]);
        }
        _ => panic!("expected add operation"),
    }
    match &parsed[2] {
        ParsedPatchOperation::Delete { path } => {
            assert_eq!(path, "old.md");
        }
        _ => panic!("expected delete operation"),
    }
}

#[test]
fn apply_patch_hunks_to_content_updates_expected_lines() {
    let parsed = parse_apply_patch(
        [
            "*** Begin Patch",
            "*** Update File: src/app.ts",
            "@@",
            " export const value = 1;",
            "-console.log(value);",
            "+console.info(value);",
            "*** End Patch",
        ]
        .join("\n")
        .as_str(),
    )
    .expect("parse apply_patch");

    let ParsedPatchOperation::Update { path, hunks } = &parsed[0] else {
        panic!("expected update operation");
    };

    let updated = apply_patch_hunks_to_content(
        path,
        "export const value = 1;\nconsole.log(value);\n",
        hunks,
    )
    .expect("apply patch");

    assert_eq!(updated, "export const value = 1;\nconsole.info(value);\n");
}

#[test]
fn apply_patch_rejects_malformed_sections_before_execution() {
    for (patch, expected) in [
        ("*** Begin Patch\n*** Add File: notes.md\n+hello", "footer"),
        (
            "*** Begin Patch\n*** Add File: notes.md\nhello\n*** End Patch",
            "expected '+' prefix",
        ),
        (
            "*** Begin Patch\n*** Update File: notes.md\n@@\n?old\n*** End Patch",
            "expected ' ', '+', or '-'",
        ),
    ] {
        let error = parse_apply_patch(patch).expect_err("malformed patch must fail");
        assert!(
            error.message.contains(expected),
            "unexpected error: {}",
            error.message
        );
    }
}

#[test]
fn apply_patch_hunks_advance_past_the_first_repeated_block() {
    let parsed = parse_apply_patch(
        "*** Begin Patch\n*** Update File: repeated.txt\n@@\n-old\n+first\n@@\n-old\n+second\n*** End Patch",
    )
    .expect("parse repeated-block patch");
    let ParsedPatchOperation::Update { path, hunks } = &parsed[0] else {
        panic!("expected update operation");
    };
    let updated = apply_patch_hunks_to_content(path, "old\nbetween\nold\n", hunks)
        .expect("apply ordered hunks");
    assert_eq!(updated, "first\nbetween\nsecond\n");
}

#[tokio::test]
async fn apply_patch_rejects_stale_context_without_partial_writes() {
    let workspace = TempDir::new().expect("workspace");
    let target = workspace.path().join("target.txt");
    fs::write(&target, "current\n").expect("seed target");

    let error = execute_workspace_tool(
        workspace.path().to_path_buf(),
        workspace.path().to_path_buf(),
        GitState::new(),
        "Implement".into(),
        "apply_patch".into(),
        json!({"patch_text": "*** Begin Patch\n*** Add File: created.txt\n+new\n*** Update File: target.txt\n@@\n-old\n+updated\n*** End Patch"}),
        None, None, None, None, None,
    )
    .await
    .expect_err("stale context must reject the whole patch");

    assert!(error.message.contains("could not be applied cleanly"));
    assert_eq!(
        fs::read_to_string(target).expect("read target"),
        "current\n"
    );
    assert!(!workspace.path().join("created.txt").exists());
}

#[tokio::test]
async fn execute_workspace_read_returns_a_resumable_bounded_page() {
    let workspace = TempDir::new().expect("workspace");
    fs::write(workspace.path().join("notes.txt"), "one\ntwo\nthree\nfour").expect("write file");

    let first = execute_readonly_workspace_tool(
        workspace.path(),
        "read",
        json!({ "path": "notes.txt", "max_lines": 2 }),
    )
    .await;
    assert!(first.contains("LINES: 1-2"));
    assert!(first.contains("TOTAL_LINES: 4"));
    assert!(first.contains("TRUNCATED: true"));
    let cursor = first
        .lines()
        .find_map(|line| line.strip_prefix("NEXT_CURSOR: "))
        .expect("next cursor");

    let second = execute_readonly_workspace_tool(
        workspace.path(),
        "read",
        json!({ "path": "notes.txt", "max_lines": 2, "cursor": cursor }),
    )
    .await;
    assert!(second.contains("LINES: 3-4"));
    assert!(second.contains("TRUNCATED: false"));
    assert!(second.contains("   3 | three"));

    fs::write(
        workspace.path().join("notes.txt"),
        "changed\ntwo\nthree\nfour",
    )
    .expect("change file after first page");
    let stale_cursor = execute_workspace_tool(
        workspace.path().to_path_buf(),
        workspace.path().to_path_buf(),
        GitState::new(),
        "Implement".to_string(),
        "read".to_string(),
        json!({ "path": "notes.txt", "max_lines": 2, "cursor": cursor }),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("read cursor must be bound to the file revision");
    assert!(stale_cursor
        .message
        .contains("does not belong to this tool request"));
}

#[tokio::test]
async fn execute_workspace_list_and_glob_return_sorted_pages() {
    let workspace = TempDir::new().expect("workspace");
    fs::write(workspace.path().join("b.ts"), "b").expect("write b");
    fs::write(workspace.path().join("a.ts"), "a").expect("write a");
    fs::write(workspace.path().join("c.txt"), "c").expect("write c");

    let list = execute_readonly_workspace_tool(
        workspace.path(),
        "list",
        json!({ "path": ".", "limit": 2 }),
    )
    .await;
    let list: serde_json::Value = serde_json::from_str(&list).expect("list json");
    assert_eq!(list["count"], 2);
    assert_eq!(list["total_count"], 3);
    assert_eq!(list["truncated"], true);
    assert_eq!(list["entries"][0]["relative_path"], "a.ts");
    assert!(list["next_cursor"].as_str().is_some());

    let glob = execute_readonly_workspace_tool(
        workspace.path(),
        "glob",
        json!({ "pattern": "*.ts", "limit": 1 }),
    )
    .await;
    let glob: serde_json::Value = serde_json::from_str(&glob).expect("glob json");
    assert_eq!(glob["paths"][0], "a.ts");
    assert_eq!(glob["total_count"], 2);
    assert_eq!(glob["truncated"], true);
}

#[tokio::test]
async fn git_branch_cursor_is_invalidated_when_refs_change() {
    let workspace = TempDir::new().expect("workspace");
    let repo = git2::Repository::init(workspace.path()).expect("init repository");
    fs::write(workspace.path().join("seed.txt"), "seed\n").expect("seed file");
    let mut index = repo.index().expect("open index");
    index.add_path(Path::new("seed.txt")).expect("add seed");
    let tree_id = index.write_tree().expect("write tree");
    let tree = repo.find_tree(tree_id).expect("find tree");
    let signature =
        git2::Signature::now("Macro Test", "macro@example.test").expect("test signature");
    let commit_id = repo
        .commit(Some("HEAD"), &signature, &signature, "seed", &tree, &[])
        .expect("initial commit");
    let commit = repo.find_commit(commit_id).expect("find commit");
    repo.branch("alpha", &commit, false).expect("alpha branch");
    repo.branch("beta", &commit, false).expect("beta branch");

    let first = execute_readonly_workspace_tool(
        workspace.path(),
        "git_branch_list",
        json!({ "repo_path": ".", "limit": 1 }),
    )
    .await;
    let first: Value = serde_json::from_str(&first).expect("branch page");
    let cursor = first["next_cursor"].as_str().expect("next cursor");

    repo.branch("gamma", &commit, false).expect("gamma branch");
    let error = execute_workspace_tool(
        workspace.path().to_path_buf(),
        workspace.path().to_path_buf(),
        GitState::new(),
        "Implement".to_string(),
        "git_branch_list".to_string(),
        json!({ "repo_path": ".", "limit": 1, "cursor": cursor }),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("branch cursor must be bound to the ref snapshot");
    assert!(error
        .message
        .contains("does not belong to this tool request"));
}

#[cfg(unix)]
#[tokio::test]
async fn execute_workspace_local_files_searches_keep_files_beside_dangling_alias() {
    let workspace = TempDir::new().unwrap();
    for name in ["a.ts", "z.ts"] {
        fs::write(workspace.path().join(name), "console.log(value);").unwrap();
    }
    std::os::unix::fs::symlink("missing.ts", workspace.path().join("alias.ts")).unwrap();
    for (tool, args) in [
        ("glob", json!({"pattern": "**/*.ts"})),
        ("grep", json!({"query": "console.log"})),
        ("ast_grep", json!({"pattern": "console.log($ARG)"})),
    ] {
        let result = execute_readonly_workspace_tool(workspace.path(), tool, args).await;
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["count"], 2, "{tool}: {result}");
    }
}

#[tokio::test]
async fn execute_workspace_grep_stale_offset_and_mixed_files() {
    let workspace = TempDir::new().unwrap();
    fs::write(workspace.path().join("good.txt"), "needle été\n".repeat(4)).unwrap();
    fs::write(
        workspace.path().join("vector.svg"),
        "<svg><title>needle</title></svg>",
    )
    .unwrap();
    fs::write(workspace.path().join("sample.data"), [0xff, 0xfe]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("missing", workspace.path().join("alias")).unwrap();
    let first = execute_readonly_workspace_tool(
        workspace.path(),
        "grep",
        json!({"query": "needle", "limit": 3}),
    )
    .await;
    let first: serde_json::Value = serde_json::from_str(&first).unwrap();
    let cursor = first["next_cursor"].as_str().unwrap();
    fs::write(workspace.path().join("good.txt"), "needle été").unwrap();
    let complete =
        execute_readonly_workspace_tool(workspace.path(), "grep", json!({"query": "needle"})).await;
    let complete: serde_json::Value = serde_json::from_str(&complete).unwrap();
    assert_eq!(complete["total_count"], 2);
    assert_eq!(complete["skipped_files"]["binary"], 1);
    let stale = execute_readonly_workspace_tool(
        workspace.path(),
        "grep",
        json!({"query": "needle", "cursor": cursor}),
    )
    .await;
    let stale: serde_json::Value = serde_json::from_str(&stale).unwrap();
    assert_eq!(stale["count"], 0);
    assert_eq!(stale["total_count"], 2);
    assert_eq!(stale["total_is_exact"], true);
}

#[tokio::test]
async fn execute_workspace_grep_bounds_matches_and_reports_skipped_files() {
    let workspace = TempDir::new().expect("workspace");
    fs::write(
        workspace.path().join("a.txt"),
        format!("needle {}\n", "x".repeat(1_000)),
    )
    .expect("write match");
    fs::write(workspace.path().join("b.txt"), "needle second\n").expect("write match");
    fs::write(workspace.path().join("0-binary.bin"), b"needle\0binary").expect("write binary");
    fs::write(
        workspace.path().join("1-large.txt"),
        vec![b'x'; 4 * 1024 * 1024 + 1],
    )
    .expect("write oversized file");

    let grep = execute_readonly_workspace_tool(
        workspace.path(),
        "grep",
        json!({ "query": "needle", "limit": 1 }),
    )
    .await;
    let grep: serde_json::Value = serde_json::from_str(&grep).expect("grep json");
    assert_eq!(grep["count"], 1);
    assert_eq!(grep["truncated"], true);
    assert_eq!(grep["results"][0]["path"], "a.txt");
    assert_eq!(grep["results"][0]["text_truncated"], true);
    assert_eq!(grep["skipped_files"]["binary"], 1);
    assert_eq!(grep["skipped_files"]["too_large"], 1);
    assert!(grep["next_cursor"].as_str().is_some());
}

#[tokio::test]
async fn execute_workspace_ast_grep_returns_structural_resumable_matches() {
    let workspace = TempDir::new().expect("workspace");
    fs::write(
        workspace.path().join("a.ts"),
        "console.log(first);\nconsole.log(second);\n",
    )
    .expect("write first source");
    fs::write(
        workspace.path().join("b.ts"),
        "const untouched = true;\nconsole.log(last);\n",
    )
    .expect("write second source");
    fs::write(workspace.path().join("notes.txt"), "console.log(notCode)")
        .expect("write unsupported source");

    let first = execute_readonly_workspace_tool(
        workspace.path(),
        "ast_grep",
        json!({
            "pattern": "console.log($ARG)",
            "include_meta": true,
            "limit": 2
        }),
    )
    .await;
    let first: serde_json::Value = serde_json::from_str(&first).expect("ast grep json");
    assert_eq!(first["count"], 2);
    assert_eq!(first["truncated"], true);
    assert_eq!(first["matches"][0]["path"], "a.ts");
    assert_eq!(first["matches"][0]["start_line"], 1);
    assert_eq!(first["matches"][1]["meta_variables"]["ARG"], "second");
    assert_eq!(first["skipped_files"]["unsupported_language"], 0);
    let cursor = first["next_cursor"].as_str().expect("ast next cursor");

    let mismatched_cursor = execute_workspace_tool(
        workspace.path().to_path_buf(),
        workspace.path().to_path_buf(),
        GitState::new(),
        "Implement".to_string(),
        "ast_grep".to_string(),
        json!({
            "pattern": "console.error($ARG)",
            "limit": 2,
            "cursor": cursor
        }),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("ast cursor must be bound to the structural query");
    assert!(mismatched_cursor
        .message
        .contains("does not belong to this tool request"));

    let second = execute_readonly_workspace_tool(
        workspace.path(),
        "ast_grep",
        json!({
            "pattern": "console.log($ARG)",
            "include_meta": true,
            "limit": 2,
            "cursor": cursor
        }),
    )
    .await;
    let second: serde_json::Value = serde_json::from_str(&second).expect("ast page json");
    assert_eq!(second["count"], 1);
    assert_eq!(second["matches"][0]["path"], "b.ts");
    assert_eq!(second["matches"][0]["meta_variables"]["ARG"], "last");
    assert_eq!(second["truncated"], false);
    assert_eq!(second["total_count"], 3);
    assert_eq!(second["total_is_exact"], true);
    assert_eq!(second["skipped_files"]["unsupported_language"], 1);
}

#[tokio::test]
async fn execute_workspace_tool_delete_returns_structured_deleted_file_response() {
    let workspace = TempDir::new().expect("workspace");
    fs::write(workspace.path().join("delete-me.txt"), "line 1\nline 2\n").expect("write file");

    let result = execute_workspace_tool(
        workspace.path().to_path_buf(),
        workspace.path().to_path_buf(),
        GitState::new(),
        "Implement".to_string(),
        "delete".to_string(),
        json!({ "path": "delete-me.txt" }),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("execute delete");

    let parsed: serde_json::Value = serde_json::from_str(&result).expect("parse delete response");
    assert_eq!(
        parsed.get("ok").and_then(serde_json::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        parsed
            .get("files")
            .and_then(serde_json::Value::as_array)
            .and_then(|files| files.first())
            .and_then(|file| file.get("status"))
            .and_then(serde_json::Value::as_str),
        Some("deleted")
    );
    assert_eq!(
        parsed
            .get("files")
            .and_then(serde_json::Value::as_array)
            .and_then(|files| files.first())
            .and_then(|file| file.get("validation"))
            .and_then(|validation| validation.get("exists"))
            .and_then(serde_json::Value::as_bool),
        Some(false)
    );
    assert!(!workspace.path().join("delete-me.txt").exists());
}

#[tokio::test]
async fn execute_workspace_tool_edit_rejects_a_stale_revision() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("guarded.txt");
    fs::write(&path, "value = 1\n").expect("seed guarded file");

    let error = execute_workspace_tool(
        workspace.path().to_path_buf(),
        workspace.path().to_path_buf(),
        GitState::new(),
        "Implement".to_string(),
        "edit".to_string(),
        json!({
            "path": "guarded.txt",
            "old_text": "value = 1",
            "new_text": "value = 2",
            "expected_revision": "stale-revision"
        }),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("stale edit must fail");

    assert!(error.message.contains("Stale content"));
    assert_eq!(
        fs::read_to_string(path).expect("read guarded file"),
        "value = 1\n"
    );
}

#[cfg(any(windows, target_os = "macos"))]
#[tokio::test]
async fn content_mutation_keys_fold_case_on_case_insensitive_desktop_platforms() {
    let workspace = TempDir::new().expect("workspace");
    let upper = super::native_content_mutation_key(&workspace.path().join("Guarded.txt")).await;
    let lower = super::native_content_mutation_key(&workspace.path().join("guarded.txt")).await;

    assert_eq!(upper, lower);
}

#[tokio::test]
async fn concurrent_absent_revision_writes_allow_exactly_one_winner() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("new.txt");
    let change = |content: &str| PendingFileChange {
        display_path: "new.txt".to_string(),
        effective_workspace: workspace.path().to_path_buf(),
        effective_path: "new.txt".to_string(),
        absolute_path: path.clone(),
        status: "created".to_string(),
        new_content: Some(content.to_string()),
        created: true,
        bytes_written: content.len() as u64,
        additions: 1,
        deletions: 0,
        expected_revision: Some("absent".to_string()),
        requested_unix_mode: None,
    };
    let first = vec![change("first\n")];
    let second = vec![change("second\n")];

    let (first_result, second_result) = tokio::join!(
        commit_and_validate_pending_file_changes(first.clone(), Default::default()),
        commit_and_validate_pending_file_changes(second.clone(), Default::default()),
    );

    assert_eq!(
        usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
        1
    );
    let failure = first_result.err().or_else(|| second_result.err()).unwrap();
    assert_eq!(failure.code(), Some("REVISION_CONFLICT"));
    let content = fs::read_to_string(path).expect("read winning content");
    assert!(content == "first\n" || content == "second\n");
}

#[tokio::test]
async fn concurrent_matching_revision_writes_allow_exactly_one_winner() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("shared.txt");
    fs::write(&path, "original\n").expect("seed shared file");
    let revision = content_revision(b"original\n");
    let change = |content: &str| PendingFileChange {
        display_path: "shared.txt".to_string(),
        effective_workspace: workspace.path().to_path_buf(),
        effective_path: "shared.txt".to_string(),
        absolute_path: path.clone(),
        status: "updated".to_string(),
        new_content: Some(content.to_string()),
        created: false,
        bytes_written: content.len() as u64,
        additions: 1,
        deletions: 1,
        expected_revision: Some(revision.clone()),
        requested_unix_mode: None,
    };
    let first = vec![change("first\n")];
    let second = vec![change("second\n")];

    let (first_result, second_result) = tokio::join!(
        commit_and_validate_pending_file_changes(first.clone(), Default::default()),
        commit_and_validate_pending_file_changes(second.clone(), Default::default()),
    );

    assert_eq!(
        usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
        1
    );
    let failure = first_result.err().or_else(|| second_result.err()).unwrap();
    assert_eq!(failure.code(), Some("REVISION_CONFLICT"));
    let content = fs::read_to_string(path).expect("read winning content");
    assert!(content == "first\n" || content == "second\n");
}

#[tokio::test]
async fn guarded_batch_revalidates_after_preparing_the_atomic_replacement() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("shared.txt");
    fs::write(&path, "original\n").expect("seed shared file");
    let reached = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    install_write_before_revalidation_hook(
        path.canonicalize().expect("canonical shared path"),
        reached.clone(),
        release.clone(),
    );
    let change = PendingFileChange {
        display_path: "shared.txt".to_string(),
        effective_workspace: workspace.path().to_path_buf(),
        effective_path: "shared.txt".to_string(),
        absolute_path: path.clone(),
        status: "updated".to_string(),
        new_content: Some("macro\n".to_string()),
        created: false,
        bytes_written: 6,
        additions: 1,
        deletions: 1,
        expected_revision: Some(content_revision(b"original\n")),
        requested_unix_mode: None,
    };

    let task = tokio::spawn(commit_and_validate_pending_file_changes(
        vec![change],
        Default::default(),
    ));
    reached.wait().await;
    fs::write(&path, "external\n").expect("external writer wins before rename");
    release.wait().await;

    let error = task
        .await
        .expect("batch task")
        .expect_err("second CAS must reject the stale replacement");
    assert_eq!(error.code(), Some("REVISION_CONFLICT"));
    assert_eq!(
        fs::read_to_string(path).expect("read external winner"),
        "external\n"
    );
}

#[tokio::test]
async fn commit_pending_file_changes_checks_all_revisions_before_writing() {
    let workspace = TempDir::new().expect("workspace");
    let first_path = workspace.path().join("first.txt");
    let second_path = workspace.path().join("second.txt");
    fs::write(&first_path, "first-original\n").expect("write first");
    fs::write(&second_path, "second-original\n").expect("write second");

    let changes = vec![
        PendingFileChange {
            display_path: "first.txt".to_string(),
            effective_workspace: workspace.path().to_path_buf(),
            effective_path: "first.txt".to_string(),
            absolute_path: first_path.clone(),
            status: "updated".to_string(),
            new_content: Some("first-updated\n".to_string()),
            created: false,
            bytes_written: 14,
            additions: 1,
            deletions: 1,
            expected_revision: Some(content_revision(b"first-original\n")),
            requested_unix_mode: None,
        },
        PendingFileChange {
            display_path: "second.txt".to_string(),
            effective_workspace: workspace.path().to_path_buf(),
            effective_path: "second.txt".to_string(),
            absolute_path: second_path.clone(),
            status: "updated".to_string(),
            new_content: Some("second-updated\n".to_string()),
            created: false,
            bytes_written: 15,
            additions: 1,
            deletions: 1,
            expected_revision: Some("stale-revision".to_string()),
            requested_unix_mode: None,
        },
    ];

    let error = commit_and_validate_pending_file_changes(changes, Default::default())
        .await
        .expect_err("stale batch must fail before writing");

    assert!(error.message.contains("Stale content for 'second.txt'"));
    assert_eq!(
        fs::read_to_string(first_path).expect("read first"),
        "first-original\n"
    );
    assert_eq!(
        fs::read_to_string(second_path).expect("read second"),
        "second-original\n"
    );
}

#[tokio::test]
async fn commit_pending_file_changes_rolls_back_a_late_revision_conflict() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("shared.txt");
    fs::write(&path, "original\n").expect("write original");
    let original_revision = content_revision(b"original\n");
    let change = |content: &str| PendingFileChange {
        display_path: "shared.txt".to_string(),
        effective_workspace: workspace.path().to_path_buf(),
        effective_path: "shared.txt".to_string(),
        absolute_path: path.clone(),
        status: "updated".to_string(),
        new_content: Some(content.to_string()),
        created: false,
        bytes_written: content.len() as u64,
        additions: 1,
        deletions: 1,
        expected_revision: Some(original_revision.clone()),
        requested_unix_mode: None,
    };

    let error = commit_and_validate_pending_file_changes(
        vec![change("first mutation\n"), change("second mutation\n")],
        Default::default(),
    )
    .await
    .expect_err("the second mutation must observe the first revision change");

    assert!(error.message.contains("Stale content for 'shared.txt'"));
    assert_eq!(
        fs::read_to_string(path).expect("read rolled back file"),
        "original\n"
    );
}

#[tokio::test]
async fn commit_pending_file_changes_rolls_back_first_write_when_later_operation_fails() {
    let workspace = TempDir::new().expect("workspace");
    let first_path = workspace.path().join("first.txt");
    let missing_delete_path = workspace.path().join("missing.txt");
    fs::write(&first_path, "original\n").expect("write original");

    let changes = vec![
        PendingFileChange {
            display_path: "first.txt".to_string(),
            effective_workspace: workspace.path().to_path_buf(),
            effective_path: "first.txt".to_string(),
            absolute_path: first_path.clone(),
            status: "updated".to_string(),
            new_content: Some("updated\n".to_string()),
            created: false,
            bytes_written: 8,
            additions: 1,
            deletions: 1,
            expected_revision: None,
            requested_unix_mode: None,
        },
        PendingFileChange {
            display_path: "missing.txt".to_string(),
            effective_workspace: workspace.path().to_path_buf(),
            effective_path: "missing.txt".to_string(),
            absolute_path: missing_delete_path,
            status: "deleted".to_string(),
            new_content: None,
            created: false,
            bytes_written: 0,
            additions: 0,
            deletions: 0,
            expected_revision: None,
            requested_unix_mode: None,
        },
    ];

    let error = commit_and_validate_pending_file_changes(changes, Default::default())
        .await
        .expect_err("second operation should fail");

    assert!(error.message.contains("Failed to delete missing.txt"));
    assert_eq!(
        fs::read_to_string(first_path).expect("read restored file"),
        "original\n"
    );
}

#[tokio::test]
async fn rollback_preserves_an_external_edit_after_macro_applied_its_write() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("shared.txt");
    fs::write(&path, "macro mutation\n").expect("write Macro mutation");
    let change = PendingFileChange {
        display_path: "shared.txt".to_string(),
        effective_workspace: workspace.path().to_path_buf(),
        effective_path: "shared.txt".to_string(),
        absolute_path: path.clone(),
        status: "updated".to_string(),
        new_content: Some("macro mutation\n".to_string()),
        created: false,
        bytes_written: 15,
        additions: 1,
        deletions: 1,
        expected_revision: None,
        requested_unix_mode: None,
    };
    let backups = vec![(path.clone(), Some(b"original\n".to_vec()), None)];

    fs::write(&path, "external edit\n").expect("simulate external edit");
    let errors = rollback_pending_file_changes(&backups, &[change]).await;

    assert!(errors
        .iter()
        .any(|error| error.contains("Rollback conflict for shared.txt")));
    assert_eq!(
        fs::read_to_string(path).expect("read preserved external edit"),
        "external edit\n"
    );
}

#[tokio::test]
async fn via_fs_rollback_restores_native_binary_bytes_in_a_mixed_batch() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("image.bin");
    let original = vec![0, 159, 146, 150, 255];
    fs::write(&path, b"macro mutation").expect("write Macro mutation");
    let change = PendingFileChange {
        display_path: "image.bin".to_string(),
        effective_workspace: workspace.path().to_path_buf(),
        effective_path: "image.bin".to_string(),
        absolute_path: path.clone(),
        status: "updated".to_string(),
        new_content: Some("macro mutation".to_string()),
        created: false,
        bytes_written: 14,
        additions: 1,
        deletions: 1,
        expected_revision: None,
        requested_unix_mode: None,
    };
    let target = crate::fs::operations::open_workspace_capability_target_internal(
        workspace.path(),
        "image.bin".to_string(),
    )
    .await
    .expect("open workspace capability");
    let backups = vec![(
        workspace.path().to_path_buf(),
        "image.bin".to_string(),
        "image.bin".to_string(),
        Some(original.clone()),
        None,
        Some(target),
    )];

    let errors = rollback_pending_file_changes_via_fs(&backups, &[change]).await;

    assert!(errors.is_empty(), "rollback errors: {errors:?}");
    assert_eq!(fs::read(path).expect("read restored binary"), original);
}

#[tokio::test]
async fn native_mutation_backup_rejects_oversized_existing_file_before_reading() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("oversized.bin");
    let file = fs::File::create(&path).expect("create sparse file");
    file.set_len(crate::fs::operations::MAX_WRITE_SIZE_BYTES + 1)
        .expect("size sparse file");

    let target = crate::fs::operations::open_workspace_capability_target_internal(
        workspace.path(),
        "oversized.bin".to_string(),
    )
    .await
    .expect("open workspace capability");
    let error = crate::fs::operations::read_file_bytes_with_mode_from_capability_target(&target)
        .await
        .expect_err("oversized backup must be rejected");

    assert!(error
        .to_string()
        .contains("maximum recoverable mutation size"));
}

#[test]
fn wsl_binary_backup_scripts_are_bounded_atomic_and_revision_guarded() {
    let read = wsl_mutation_backup_read_script();
    assert!(read.contains("head -c \"$2\""));
    assert!(read.contains("stat -c '%a'"));

    let write = wsl_mutation_backup_write_script();
    assert!(write.contains("sha256sum -- \"$p\""));
    assert!(write.contains("revision_conflict actual="));
    assert!(write.contains("mktemp \"$dir/.macro-rollback.XXXXXX\""));
    assert!(write.contains("mv -f -- \"$tmp\" \"$p\""));
}

fn pending_update_change(workspace: &Path, name: &str, new_content: &str) -> PendingFileChange {
    PendingFileChange {
        display_path: name.to_string(),
        effective_workspace: workspace.to_path_buf(),
        effective_path: name.to_string(),
        absolute_path: workspace.join(name),
        status: "updated".to_string(),
        new_content: Some(new_content.to_string()),
        created: false,
        bytes_written: new_content.len() as u64,
        additions: 1,
        deletions: 1,
        expected_revision: None,
        requested_unix_mode: None,
    }
}

#[test]
fn recoverable_mutations_bound_file_count_and_cumulative_snapshot_bytes() {
    assert!(validate_checkpoint_size_values(
        MAX_CHECKPOINT_FILES_PER_MUTATION,
        MAX_CHECKPOINT_TOTAL_BYTES / 2,
        MAX_CHECKPOINT_TOTAL_BYTES / 2,
    )
    .is_ok());
    assert!(
        validate_checkpoint_size_values(MAX_CHECKPOINT_FILES_PER_MUTATION + 1, 0, 0,)
            .expect_err("too many files must fail closed")
            .message
            .contains("at most")
    );
    assert!(
        validate_checkpoint_size_values(1, MAX_CHECKPOINT_TOTAL_BYTES, 1,)
            .expect_err("oversized aggregate snapshots must fail closed")
            .message
            .contains("exceeding")
    );
}

#[tokio::test]
async fn failed_post_mutation_validation_restores_the_previous_file_state() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("shared.txt");
    fs::write(&path, "original\n").expect("seed file");

    let error = commit_with_post_mutation_gate(
        vec![pending_update_change(
            workspace.path(),
            "shared.txt",
            "macro mutation\n",
        )],
        Default::default(),
        true,
        |_| false,
    )
    .await
    .expect_err("injected validation failure must fail the call");

    assert!(error.message.contains("Post-mutation validation failed"));
    assert!(error
        .message
        .contains("Injected post-mutation validation failure for shared.txt"));
    assert_eq!(
        fs::read_to_string(path).expect("read restored file"),
        "original\n"
    );
}

#[tokio::test]
async fn failed_post_mutation_validation_removes_created_files_again() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("created.txt");
    let mut change = pending_update_change(workspace.path(), "created.txt", "new content\n");
    change.status = "created".to_string();
    change.created = true;
    change.expected_revision = Some(EXPECTED_REVISION_ABSENT.to_string());

    let error = commit_with_post_mutation_gate(vec![change], Default::default(), true, |_| false)
        .await
        .expect_err("injected validation failure must fail the call");

    assert!(error
        .message
        .contains("Injected post-mutation validation failure"));
    assert!(!path.exists(), "created file must be removed again");
}

#[tokio::test]
async fn failed_post_mutation_validation_restores_a_deleted_file() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("deleted.txt");
    fs::write(&path, "original\n").expect("seed file");
    let mut change = pending_update_change(workspace.path(), "deleted.txt", "");
    change.status = "deleted".to_string();
    change.new_content = None;
    change.deletions = 1;

    let error = commit_with_post_mutation_gate(vec![change], Default::default(), true, |_| false)
        .await
        .expect_err("injected validation failure must fail the call");

    assert!(error.message.contains("Post-mutation validation failed"));
    assert_eq!(
        fs::read_to_string(path).expect("deleted file must be restored"),
        "original\n"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn failed_deleted_file_validation_restores_its_unix_mode() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("run.sh");
    fs::write(&path, "#!/bin/sh\necho original\n").expect("seed executable");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("set executable mode");
    let mut change = pending_update_change(workspace.path(), "run.sh", "");
    change.status = "deleted".to_string();
    change.new_content = None;
    change.deletions = 2;

    commit_with_post_mutation_gate(vec![change], Default::default(), true, |_| false)
        .await
        .expect_err("injected validation failure must fail the call");

    assert_eq!(
        fs::metadata(&path).expect("restored metadata").mode() & 0o777,
        0o755
    );
}

#[cfg(unix)]
#[tokio::test]
async fn recoverable_checkpoint_payload_contains_content_revisions_and_unix_modes() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("run.sh");
    fs::write(&path, "#!/bin/sh\necho before\n").expect("seed executable");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("set executable mode");
    let mut extra_fields = serde_json::Map::new();
    extra_fields.insert(
        INTERNAL_CHECKPOINT_SNAPSHOTS_FIELD.to_string(),
        Value::Bool(true),
    );

    let response = commit_and_validate_pending_file_changes(
        vec![pending_update_change(
            workspace.path(),
            "run.sh",
            "#!/bin/sh\necho after\n",
        )],
        extra_fields,
    )
    .await
    .expect("checkpointed mutation");
    let parsed: Value = serde_json::from_str(&response).expect("checkpoint response");
    let file = &parsed[INTERNAL_CHECKPOINT_SNAPSHOTS_FIELD]["files"][0];

    assert_eq!(file["before"]["content"], "#!/bin/sh\necho before\n");
    assert_eq!(file["after"]["content"], "#!/bin/sh\necho after\n");
    assert_eq!(file["before"]["unixMode"], 0o755);
    assert_eq!(file["after"]["unixMode"], 0o755);
    assert!(file["before"]["revision"].as_str().is_some());
    assert!(file["after"]["revision"].as_str().is_some());
}

#[tokio::test]
async fn recoverable_checkpoint_rejects_binary_before_applying_the_mutation() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("image.bin");
    let original = vec![0, 159, 146, 150, 255];
    fs::write(&path, &original).expect("seed binary");
    let mut extra_fields = serde_json::Map::new();
    extra_fields.insert(
        INTERNAL_CHECKPOINT_SNAPSHOTS_FIELD.to_string(),
        Value::Bool(true),
    );

    let error = commit_and_validate_pending_file_changes(
        vec![pending_update_change(
            workspace.path(),
            "image.bin",
            "text replacement",
        )],
        extra_fields,
    )
    .await
    .expect_err("binary before-state cannot become a recoverable text checkpoint");

    assert!(error.message.contains("Cannot checkpoint binary file"));
    assert_eq!(
        fs::read(path).expect("binary must remain untouched"),
        original
    );
}

#[tokio::test]
async fn recoverable_checkpoint_rejects_an_oversized_serialized_snapshot_before_mutation() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("escaped.txt");
    let original = "\u{1}".repeat(11 * 1024 * 1024);
    fs::write(&path, &original).expect("seed escaped content");
    let mut extra_fields = serde_json::Map::new();
    extra_fields.insert(
        INTERNAL_CHECKPOINT_SNAPSHOTS_FIELD.to_string(),
        Value::Bool(true),
    );

    let error = commit_and_validate_pending_file_changes(
        vec![pending_update_change(
            workspace.path(),
            "escaped.txt",
            "replacement\n",
        )],
        extra_fields,
    )
    .await
    .expect_err("serialized checkpoint must fit the durable result budget");

    assert!(error.message.contains("serialized checkpoint"));
    assert_eq!(
        fs::read_to_string(path).expect("original preserved"),
        original
    );
}

#[tokio::test]
async fn partial_rollback_continues_past_conflicts_and_preserves_external_edits() {
    let workspace = TempDir::new().expect("workspace");
    let first_path = workspace.path().join("first.txt");
    let second_path = workspace.path().join("second.txt");
    fs::write(&first_path, "first-original\n").expect("write first");
    fs::write(&second_path, "second-original\n").expect("write second");
    let changes = vec![
        pending_update_change(workspace.path(), "first.txt", "first-updated\n"),
        pending_update_change(workspace.path(), "second.txt", "second-updated\n"),
    ];

    let error = commit_with_post_mutation_gate(changes, Default::default(), true, |applied| {
        let second = applied
            .iter()
            .find(|change| change.display_path == "second.txt")
            .expect("second change");
        fs::write(&second.absolute_path, "external edit\n")
            .expect("simulate external writer racing Macro");
        false
    })
    .await
    .expect_err("injected validation failure must fail the call");

    assert!(error.message.contains("Post-mutation validation failed"));
    assert!(error.message.contains("Rollback conflict for second.txt"));
    assert_eq!(
        fs::read_to_string(first_path).expect("restorable target must roll back"),
        "first-original\n"
    );
    assert_eq!(
        fs::read_to_string(second_path).expect("external edit must never be overwritten"),
        "external edit\n"
    );
}

#[tokio::test]
async fn guarded_readback_rejects_and_preserves_an_external_winner() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("shared.txt");
    fs::write(&path, "original\n").expect("seed file");
    let error = commit_with_post_mutation_gate(
        vec![pending_update_change(
            workspace.path(),
            "shared.txt",
            "macro mutation\n",
        )],
        Default::default(),
        true,
        |applied| {
            fs::write(&applied[0].absolute_path, "external edit\n")
                .expect("simulate external writer before readback");
            true
        },
    )
    .await
    .expect_err("divergent readback must fail the call");

    assert!(error.message.contains("External modification detected"));
    assert!(error.message.contains("Rollback conflict for shared.txt"));
    assert_eq!(
        fs::read_to_string(path).expect("external winner must survive"),
        "external edit\n"
    );
}

#[tokio::test]
async fn commit_and_validate_returns_the_standard_response_when_readback_succeeds() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("shared.txt");
    fs::write(&path, "original\n").expect("seed file");
    let mut extra_fields = serde_json::Map::new();
    extra_fields.insert("tool".to_string(), Value::String("write".to_string()));

    let response = commit_and_validate_pending_file_changes(
        vec![pending_update_change(
            workspace.path(),
            "shared.txt",
            "updated\n",
        )],
        extra_fields,
    )
    .await
    .expect("validated batch must succeed");

    let parsed: Value = serde_json::from_str(&response).expect("json response");
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["files"].as_array().map(Vec::len), Some(1));
    assert_eq!(parsed["files"][0]["validation"]["readable"], true);
    assert_eq!(parsed["validation"]["all_files_readable"], true);
    assert_eq!(parsed["errors"].as_array().map(Vec::len), Some(0));
    assert_eq!(
        parsed["files"][0]["validation"]["revision"],
        content_revision(b"updated\n")
    );
    assert_eq!(parsed["tool"], "write");
    assert_eq!(
        fs::read_to_string(path).expect("read mutated file"),
        "updated\n"
    );
}

#[tokio::test]
async fn post_write_validation_accepts_content_above_the_interactive_read_limit() {
    let workspace = TempDir::new().expect("workspace");
    let content = "x".repeat(10 * 1024 * 1024 + 1);

    let response = commit_and_validate_pending_file_changes(
        vec![pending_update_change(
            workspace.path(),
            "large.txt",
            &content,
        )],
        Default::default(),
    )
    .await
    .expect("an allowed write must not fail the guarded readback");
    let parsed: Value = serde_json::from_str(&response).expect("json response");

    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["files"][0]["validation"]["readable"], true);
    assert_eq!(
        parsed["files"][0]["validation"]["size"],
        content.len() as u64
    );
}

#[tokio::test]
async fn transactional_write_honors_create_dirs_false_at_apply_time() {
    let workspace = TempDir::new().expect("workspace");
    let change = pending_update_change(workspace.path(), "missing/file.txt", "content\n");

    let error = commit_and_validate_pending_file_changes_with_create_dirs(
        vec![change],
        Default::default(),
        false,
    )
    .await
    .expect_err("the transactional apply must not create a missing parent");

    assert!(error.message.contains("Parent directory does not exist"));
    assert!(!workspace.path().join("missing").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn transactional_delete_rejects_a_parent_replaced_by_an_external_symlink() {
    let workspace = TempDir::new().expect("workspace");
    let outside = TempDir::new().expect("outside");
    let parent = workspace.path().join("parent");
    fs::create_dir(&parent).expect("create parent");
    fs::write(parent.join("victim.txt"), "inside\n").expect("seed inside file");
    fs::write(outside.path().join("victim.txt"), "outside\n").expect("seed outside file");
    let change = PendingFileChange {
        display_path: "parent/victim.txt".to_string(),
        effective_workspace: workspace.path().to_path_buf(),
        effective_path: "parent/victim.txt".to_string(),
        absolute_path: parent.join("victim.txt"),
        status: "deleted".to_string(),
        new_content: None,
        created: false,
        bytes_written: 0,
        additions: 0,
        deletions: 1,
        expected_revision: Some(content_revision(b"inside\n")),
        requested_unix_mode: None,
    };
    let backups = prepare_mutation_backups(std::slice::from_ref(&change))
        .await
        .expect("prepare backup");
    let moved_parent = workspace.path().join("moved-parent");
    fs::rename(&parent, &moved_parent).expect("move validated parent");
    std::os::unix::fs::symlink(outside.path(), &parent).expect("replace parent with symlink");

    apply_mutation_backups(&[change], &backups, true)
        .await
        .expect_err("capability-confined delete must reject the swapped parent");

    assert_eq!(
        fs::read_to_string(outside.path().join("victim.txt")).expect("read outside file"),
        "outside\n"
    );
    assert_eq!(
        fs::read_to_string(moved_parent.join("victim.txt")).expect("read original file"),
        "inside\n"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn transactional_write_keeps_the_original_workspace_root_capability() {
    let container = TempDir::new().expect("container");
    let workspace = container.path().join("workspace");
    let moved_workspace = container.path().join("moved-workspace");
    let outside = TempDir::new().expect("outside");
    fs::create_dir(&workspace).expect("create workspace");
    let change = pending_update_change(&workspace, "new.txt", "inside\n");
    let backups = prepare_mutation_backups(std::slice::from_ref(&change))
        .await
        .expect("prepare backup");
    fs::rename(&workspace, &moved_workspace).expect("move workspace root");
    std::os::unix::fs::symlink(outside.path(), &workspace)
        .expect("replace workspace root with symlink");

    apply_mutation_backups(std::slice::from_ref(&change), &backups, true)
        .await
        .expect("write through retained capability");
    let report = validate_post_write_changes(std::slice::from_ref(&change), &backups).await;

    assert!(
        report.errors.is_empty(),
        "validation errors: {:?}",
        report.errors
    );
    assert!(!outside.path().join("new.txt").exists());
    assert_eq!(
        fs::read_to_string(moved_workspace.join("new.txt")).expect("read confined write"),
        "inside\n"
    );
    fs::remove_file(&workspace).expect("remove replacement symlink");
    fs::rename(&moved_workspace, &workspace).expect("restore workspace root");
}

#[tokio::test]
async fn transactional_write_preserves_noop_write_metadata() {
    let workspace = TempDir::new().expect("workspace");
    let path = workspace.path().join("same.txt");
    fs::write(&path, "same\n").expect("seed file");
    let before_modified = fs::metadata(&path)
        .expect("metadata before")
        .modified()
        .expect("modified before");

    let response = commit_and_validate_pending_file_changes(
        vec![pending_update_change(
            workspace.path(),
            "same.txt",
            "same\n",
        )],
        Default::default(),
    )
    .await
    .expect("identical write");
    let parsed: Value = serde_json::from_str(&response).expect("json response");
    let after_modified = fs::metadata(&path)
        .expect("metadata after")
        .modified()
        .expect("modified after");

    assert_eq!(parsed["bytes_written"], 0);
    assert_eq!(parsed["files"][0]["bytes_written"], 0);
    assert_eq!(before_modified, after_modified);
}

#[test]
fn architect_patch_validation_checks_every_target() {
    for forbidden in [
        "*** Add File: src/forbidden.txt\n+new\n",
        "*** Update File: src/forbidden.txt\n@@\n-old\n+new\n",
        "*** Delete File: src/forbidden.txt\n",
    ] {
        let validation = validate_workspace_tool_execution(
            "Architect",
            "apply_patch",
            &json!({
                "path": "branches/allowed.json",
                "patch_text": format!("*** Begin Patch\n*** Add File: branches/allowed.json\n+{{}}\n{forbidden}*** End Patch")
            }),
        ).expect("parse mixed patch");
        assert!(
            !validation.allowed,
            "every patch target must satisfy the mode policy"
        );
    }
}

#[tokio::test]
async fn mixed_mount_patch_rejects_read_only_target_before_any_write() {
    let writable = TempDir::new().expect("writable project");
    let read_only = TempDir::new().expect("read-only project");
    let mounts = vec![
        WorkspaceProjectMount {
            project_id: "editable".into(),
            mount_name: "editable".into(),
            workspace_path: Some(writable.path().to_string_lossy().into_owned()),
            display_name: None,
            is_read_only: false,
        },
        WorkspaceProjectMount {
            project_id: "reference".into(),
            mount_name: "reference".into(),
            workspace_path: Some(read_only.path().to_string_lossy().into_owned()),
            display_name: None,
            is_read_only: true,
        },
    ];
    let response = execute_workspace_tool(
        writable.path().to_path_buf(), writable.path().to_path_buf(), GitState::new(),
        "Implement".into(), "apply_patch".into(),
        json!({"patch_text": "*** Begin Patch\n*** Add File: editable/first.txt\n+allowed\n*** Add File: reference/second.txt\n+forbidden\n*** End Patch"}),
        None, None, Some(mounts), Some(true), None,
    ).await.expect("virtual tool refusal remains a tool response");
    assert_eq!(
        response,
        "Cannot apply patch to read-only project mount reference."
    );
    assert!(!writable.path().join("first.txt").exists());
    assert!(!read_only.path().join("second.txt").exists());
}
