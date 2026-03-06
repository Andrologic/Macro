#[path = "commands.rs"]
pub mod commands;
pub mod core;
mod db;
mod secrets;

// Placeholder modules for critical manual implementation
mod fs;
pub mod git;

mod ai;
mod index;
pub mod workspace;

use commands::DbPool;
use core::{init_logging, load_config};
use fs::watcher::init_watcher;
use git::GitState;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

pub type WorkspaceRoot = Arc<RwLock<std::path::PathBuf>>;

#[derive(Clone)]
pub struct WorkspaceMetadataRoot(pub Arc<RwLock<std::path::PathBuf>>);

// Command to show the main window explicitly from frontend
#[tauri::command]
async fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging
    init_logging();

    // Load configuration
    let config = load_config().expect("Failed to load configuration");

    tracing::info!("Starting Macro application");
    tracing::info!("Workspace path: {:?}", config.workspace_path);
    tracing::info!("Database path: {:?}", config.db_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Arc::new(Mutex::new(None)) as DbPool)
        .manage(GitState::new())
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
            app.manage(workspace_metadata_root);
            app.manage(workspace_runtime_root);

            // Initialize file system watcher
            if let Err(e) = init_watcher(app, workspace_path) {
                tracing::warn!("Failed to initialize file system watcher: {}", e);
            }

            // Initialize database asynchronously
            tauri::async_runtime::spawn(async move {
                match db::init_db(&app_handle).await {
                    Ok(pool) => {
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
            commands::db_list_conversations,
            commands::db_get_conversation,
            commands::db_create_conversation,
            commands::db_rename_conversation,
            commands::db_update_conversation_details,
            commands::db_delete_conversation_by_id,
            commands::db_toggle_pin_conversation,
            commands::db_list_messages,
            commands::db_create_message,
            commands::db_update_message,
            commands::db_delete_messages_after,
            commands::db_list_provider_configs,
            commands::db_get_provider_config,
            commands::db_update_provider_config,
            commands::db_create_provider_config,
            commands::db_delete_provider_config,
            // Git metadata commands
            commands::db_upsert_git_repository,
            commands::db_upsert_git_worktree,
            commands::db_list_git_worktrees,
            // Workspace commands
            commands::workspace::workspace_get_bootstrap,
            commands::workspace::workspace_list_projects,
            commands::workspace::workspace_list_tasks,
            commands::workspace::workspace_get_metadata,
            commands::workspace::workspace_get_active_root,
            commands::workspace::workspace_set_active_root,
            commands::workspace::workspace_create_project,
            commands::workspace::workspace_import_git_repo,
            commands::workspace::workspace_rename_project_group,
            commands::workspace::workspace_rename_project,
            commands::workspace::workspace_archive_project_group,
            commands::workspace::workspace_archive_project,
            commands::workspace::workspace_close_project,
            // Tool policy validation command
            commands::tool_get_mode_policy,
            commands::tool_validate_execution,
            commands::tool_execute_workspace,
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
            commands::git::git_checkout,
            commands::git::git_commit,
            commands::git::git_add,
            commands::git::git_reset,
            commands::git::git_stash,
            commands::git::git_diff,
            commands::git::git_get_tree,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
