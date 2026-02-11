#[path = "commands.rs"]
mod commands;
mod core;
mod db;
mod secrets;

// Placeholder modules for critical manual implementation
mod fs;
mod git;

mod ai;
mod index;
mod workspace;

use commands::DbPool;
use core::{init_logging, load_config};
use fs::watcher::init_watcher;
use git::GitState;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

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
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Arc::new(Mutex::new(None)) as DbPool)
        .manage(GitState::new())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let pool_state = app.state::<DbPool>().inner().clone();

            // Store workspace path in app state
            let workspace_path = config.workspace_path.clone();
            app.manage(workspace_path.clone());

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
            commands::git::git_checkout,
            commands::git::git_commit,
            commands::git::git_add,
            commands::git::git_reset,
            commands::git::git_stash,
            commands::git::git_diff,
            commands::git::git_get_tree,
            commands::db_list_provider_models,
            commands::db_upsert_provider_models,
            commands::db_set_provider_model_enabled,
            commands::db_set_all_provider_models_enabled,
            commands::db_register_manual_model,
            commands::db_get_provider_settings,
            commands::db_update_provider_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
