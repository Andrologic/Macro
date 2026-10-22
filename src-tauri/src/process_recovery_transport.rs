//! Stdio transport for the explicit native process-recovery profile only.
//! Production command handlers and managed state run under Tauri's MockRuntime.
use crate::{commands, db, git::GitState, WorkspaceMetadataRoot, WorkspaceRoot};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Write};
use std::sync::Arc;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tokio::sync::RwLock;

#[test]
#[ignore = "stdio helper for the dedicated native process-recovery runner"]
fn native_transport() {
    let root = std::env::var_os("MACRO_RECOVERY_ROOT")
        .expect("The dedicated recovery runner must supply a disposable root");
    let root = std::path::PathBuf::from(root).canonicalize().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let pool = runtime
        .block_on(db::create_pool(&root.join("macro.db")))
        .unwrap();
    runtime
        .block_on(db::tool_invocations::reconcile_pending_after_restart(&pool))
        .unwrap();
    let managed_pool = commands::DbPool::default();
    managed_pool.set_ready(pool.clone());
    let workspace: WorkspaceRoot = Arc::new(RwLock::new(root.clone()));
    let config_manager = runtime
        .block_on(crate::config::ConfigManager::initialize(
            root.join("config"),
        ))
        .unwrap();
    let state_manager = crate::state_manager::StateManager::initialize(&root.join("data")).unwrap();
    let app = mock_builder()
        .manage(config_manager)
        .manage(state_manager)
        .manage(commands::mcp::McpRuntimeManager::default())
        .manage(workspace)
        .manage(WorkspaceMetadataRoot(Arc::new(RwLock::new(root.clone()))))
        .manage(GitState::new())
        .manage(managed_pool)
        .invoke_handler(tauri::generate_handler![
            crate::config::config_get_snapshot,
            crate::config::config_get_document,
            crate::config::config_list_pending_changes,
            commands::mcp::mcp_runtime_get_snapshot,
            crate::state_manager::state_get_snapshot,
            crate::state_manager::state_set_value,
            commands::tool_get_mode_policy,
            commands::repository_instructions::repository_instructions_load,
            commands::db_get_chat_bootstrap_snapshot,
            commands::db_update_conversation_ai_selection,
            commands::db_update_conversation_details,
            commands::db_list_conversation_citations,
            commands::db_get_conversation_compaction_state,
            commands::db_get_conversation_toolbox_state,
            commands::db_delete_conversation_toolbox_state,
            commands::db_get_app_setting,
            commands::db_set_app_setting,
            commands::db_compare_and_swap_app_setting,
            commands::db_delete_app_setting,
            commands::db_create_conversation,
            commands::db_create_message,
            commands::db_update_message,
            commands::db_list_messages,
            commands::tool_invocations::db_record_tool_invocation,
            commands::tool_invocations::db_complete_tool_invocation,
            commands::tool_invocations::db_mark_tool_invocation_unknown,
            commands::tool_invocations::db_list_unresolved_tool_invocations,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_list_dir,
            commands::fs::fs_delete,
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_merge_check,
            commands::git::git_rebase_check,
            commands::git::git_branch_list,
            commands::git::git_branch_delete,
            commands::git::git_checkout,
            commands::git::git_merge,
            commands::git::git_guarded_merge_state,
            commands::git::git_prepare_guarded_branch_sync,
            commands::git::git_guarded_branch_sync,
            commands::git::git_worktree_inspect,
            commands::git::git_worktree_remove,
            commands::git::git_branch_worktree_inspect,
            commands::git::git_branch_worktree_remove,
            commands::git::macro_branch_ensure,
            commands::git::macro_branch_commit_if_dirty,
            commands::workspace::workspace_get_active_root,
            commands::workspace::workspace_acquire_plan_lifecycle_lock,
            commands::workspace::workspace_renew_plan_lifecycle_lock,
            commands::workspace::workspace_release_plan_lifecycle_lock,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "recovery", Default::default())
        .build()
        .unwrap();
    let mut output = std::io::stdout().lock();
    writeln!(output, "MACRO_RECOVERY:{}", json!({"ready": std::process::id(), "sourceHash": format!("{:x}", Sha256::digest(include_str!("process_recovery_transport.rs")))})).unwrap();
    output.flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let command = request["command"].as_str().unwrap();
        let result = if command == "test_message_write_failure" {
            // Fault injection at the actual SQLite write, without replacing persistence.
            let sql = if request["args"]["enabled"] == true {
                "CREATE TRIGGER recovery_fail_message BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'recovery injected message write failure'); END"
            } else {
                "DROP TRIGGER IF EXISTS recovery_fail_message"
            };
            runtime
                .block_on(sqlx::query(sql).execute(&pool))
                .map(|_| Value::Null)
                .map_err(|error| json!(error.to_string()))
        } else {
            get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::Json(request["args"].clone()),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .map(|body| body.deserialize::<Value>().unwrap())
        };
        let response = match result {
            Ok(value) => json!({"id":request["id"], "value":value}),
            Err(error) => json!({"id":request["id"], "error":error}),
        };
        writeln!(output, "MACRO_RECOVERY:{response}").unwrap();
        output.flush().unwrap();
    }
    runtime.block_on(pool.close());
}
