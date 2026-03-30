#[path = "commands.rs"]
pub mod commands;
pub mod core;
mod db;
mod dev_overrides;
mod secrets;

// Placeholder modules for critical manual implementation
mod fs;
pub mod git;

mod ai;
mod index;
mod tool_host;
pub mod workspace;

use ai::AiState;
use commands::DbPool;
use core::{init_logging, load_config};
use fs::watcher::init_watcher;
use git::GitState;
use serde::Serialize;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

pub type WorkspaceRoot = Arc<RwLock<std::path::PathBuf>>;

#[derive(Clone)]
pub struct WorkspaceMetadataRoot(pub Arc<RwLock<std::path::PathBuf>>);

#[derive(Serialize)]
struct WindowSizePayload {
    width: u32,
    height: u32,
}

#[derive(Serialize)]
struct WindowPositionPayload {
    x: i32,
    y: i32,
}

// Command to show the main window explicitly from frontend
#[tauri::command]
async fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
}

#[tauri::command]
async fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.maximize().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_unmaximize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.unmaximize().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
async fn window_is_maximized(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_set_size(
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_set_position(window: tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    window
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_outer_size(window: tauri::WebviewWindow) -> Result<WindowSizePayload, String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    Ok(WindowSizePayload {
        width: size.width,
        height: size.height,
    })
}

#[tauri::command]
async fn window_outer_position(
    window: tauri::WebviewWindow,
) -> Result<WindowPositionPayload, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    Ok(WindowPositionPayload {
        x: position.x,
        y: position.y,
    })
}

#[tauri::command]
async fn window_scale_factor(window: tauri::WebviewWindow) -> Result<f64, String> {
    window.scale_factor().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    window.set_zoom(scale).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging
    init_logging();

    // Load configuration
    let config = load_config().expect("Failed to load configuration");

    tracing::info!("Starting Macro application");
    tracing::info!("Workspace path: {:?}", config.workspace_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Arc::new(Mutex::new(None)) as DbPool)
        .manage(AiState::default())
        .manage(GitState::new())
        .manage(commands::terminal::TerminalSessionStore::default())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let pool_state = app.state::<DbPool>().inner().clone();

            // Store workspace paths in app state
            // - WorkspaceMetadataRoot: stable root used for workspace metadata CRUD
            // - WorkspaceRoot: runtime root used by file tools/debug execution context
            let workspace_path = config.workspace_path.clone();
            let workspace_metadata_root =
                WorkspaceMetadataRoot(Arc::new(RwLock::new(workspace_path.clone())));
            let workspace_runtime_root: WorkspaceRoot =
                Arc::new(RwLock::new(workspace_path.clone()));
            app.manage(workspace_metadata_root.clone());
            app.manage(workspace_runtime_root);

            let tool_host_config = tool_host::start(
                workspace_metadata_root.clone(),
                app.state::<GitState>().inner().clone(),
                app.state::<commands::terminal::TerminalSessionStore>()
                    .inner()
                    .clone(),
            )?;
            app.manage(tool_host_config);

            // Initialize file system watcher
            if let Err(e) = init_watcher(app, workspace_path) {
                tracing::warn!("Failed to initialize file system watcher: {}", e);
            }

            // Initialize database asynchronously
            tauri::async_runtime::spawn(async move {
                match db::init_db(&app_handle).await {
                    Ok(pool) => {
                        if let Err(error) =
                            ai::chatgpt::migrate_provider_secret(&pool, "chatgpt").await
                        {
                            tracing::warn!("Failed to migrate ChatGPT secret: {}", error);
                        }
                        let mut pool_guard = pool_state.lock().await;
                        *pool_guard = Some(pool);
                        tracing::info!("Database initialized successfully");
                    }
                    Err(e) => {
                        tracing::error!("Failed to initialize database: {}", e);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Database commands
            show_main_window,
            window_close,
            window_minimize,
            window_maximize,
            window_unmaximize,
            window_toggle_maximize,
            window_is_maximized,
            window_set_size,
            window_set_position,
            window_outer_size,
            window_outer_position,
            window_scale_factor,
            window_set_zoom,
            commands::db_list_conversations,
            commands::db_get_chat_snapshot,
            commands::db_get_conversation,
            commands::db_create_conversation,
            commands::db_rename_conversation,
            commands::db_update_conversation_details,
            commands::db_delete_conversation_by_id,
            commands::db_delete_conversations_by_ids,
            commands::db_toggle_pin_conversation,
            commands::db_list_messages,
            commands::db_create_message,
            commands::db_import_messages,
            commands::db_update_message,
            commands::db_delete_messages_after,
            commands::db_list_provider_configs,
            commands::db_get_provider_config,
            commands::db_update_provider_config,
            commands::db_create_provider_config,
            commands::db_delete_provider_config,
            commands::ai_get_dev_provider_overrides,
            commands::ai::ai_start_chatgpt_auth,
            commands::ai::ai_get_copilot_status,
            commands::ai::ai_download_copilot_runtime,
            commands::ai::ai_cancel_copilot_runtime_download,
            commands::ai::ai_start_copilot_auth,
            commands::ai::ai_cancel_copilot_auth,
            commands::ai::ai_cancel_chatgpt_auth,
            commands::ai::ai_disconnect_provider_auth,
            commands::ai::ai_sync_provider_models,
            commands::ai::ai_stream_chat,
            commands::ai::ai_cancel_stream,
            // Git metadata commands
            commands::db_upsert_git_repository,
            commands::db_upsert_git_worktree,
            commands::db_list_git_worktrees,
            // Workspace commands
            commands::workspace::workspace_get_bootstrap,
            commands::workspace::workspace_list_projects,
            commands::workspace::workspace_list_tasks,
            commands::workspace::workspace_get_metadata,
            commands::workspace::workspace_get_project_registry_diagnostics,
            commands::workspace::workspace_get_active_root,
            commands::workspace::workspace_set_active_root,
            commands::workspace::workspace_create_project,
            commands::workspace::workspace_import_git_repo,
            commands::workspace::workspace_rename_project_group,
            commands::workspace::workspace_rename_project,
            commands::workspace::workspace_archive_project_group,
            commands::workspace::workspace_archive_project,
            commands::workspace::workspace_remove_project_group,
            commands::workspace::workspace_remove_project,
            commands::workspace::workspace_close_project,
            commands::workspace::workspace_create_manual_feature_draft,
            commands::workspace::workspace_finalize_manual_feature,
            commands::workspace::workspace_delete_manual_feature_draft,
            commands::workspace::workspace_rename_manual_feature,
            commands::workspace::workspace_archive_manual_feature,
            commands::workspace::workspace_restore_manual_feature,
            commands::workspace::workspace_delete_manual_feature,
            commands::workspace::workspace_update_standalone_task_status,
            // Tool policy validation command
            commands::tool_get_mode_policy,
            commands::tool_validate_execution,
            commands::tool_execute_workspace,
            commands::terminal::terminal_list_tabs,
            commands::terminal::terminal_create_tab,
            commands::terminal::terminal_reconnect_tab,
            commands::terminal::terminal_read_tab,
            commands::terminal::terminal_update_tab_metadata,
            commands::terminal::terminal_write_input,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_execute_command,
            commands::terminal::terminal_interrupt,
            commands::terminal::terminal_clear_tab,
            commands::terminal::terminal_close_tab,
            commands::terminal::terminal_create_session,
            commands::terminal::terminal_run,
            commands::terminal::terminal_read,
            commands::terminal::terminal_kill,
            // File System commands
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_list_dir,
            commands::fs::fs_stat,
            commands::fs::fs_exists,
            commands::fs::fs_delete,
            commands::fs::fs_create_dir,
            commands::fs::fs_copy,
            commands::fs::fs_move,
            // Git commands
            commands::git::git_status,
            commands::git::git_log,
            commands::git::git_branch_list,
            commands::git::git_branch_create,
            commands::git::git_branch_delete,
            commands::git::git_branch_delete_remote,
            commands::git::git_checkout,
            commands::git::git_merge_check,
            commands::git::git_merge,
            commands::git::git_commit,
            commands::git::git_add,
            commands::git::git_reset,
            commands::git::git_stash,
            commands::git::git_diff,
            commands::git::git_get_tree,
            commands::git::git_worktree_inspect,
            commands::git::git_worktree_create,
            commands::git::git_worktree_remove,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::macro_branch_ensure,
            commands::git::macro_branch_status,
            commands::git::macro_branch_commit_if_dirty,
            commands::git::macro_branch_push,
            commands::git::macro_branch_pull,
            commands::db_list_provider_models,
            commands::db_upsert_provider_models,
            commands::db_set_provider_model_enabled,
            commands::db_set_all_provider_models_enabled,
            commands::db_register_manual_model,
            commands::db_get_provider_settings,
            commands::db_update_provider_settings,
            commands::db_get_app_setting,
            commands::db_set_app_setting,
            commands::db_get_project_context_state,
            commands::db_upsert_project_context_state,
            commands::db_delete_project_context_state,
            commands::db_get_session_context_state,
            commands::db_upsert_session_context_state,
            commands::db_reconcile_project_registry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
