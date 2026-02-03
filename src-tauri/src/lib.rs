mod commands;
mod core;
mod db;

// Placeholder modules for critical manual implementation
mod fs;
mod git;

mod ai;
mod index;
mod workspace;

use core::{init_logging, load_config};
use db::init_db;
use fs::watcher::init_watcher;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

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
        .setup(move |app| {
            use tauri::Manager;

            // Initialize database
            let db_path = std::path::PathBuf::from(&config.db_path);
            let db_pool = tauri::async_runtime::block_on(init_db(&db_path))?;

            // Store database pool in app state
            app.manage(db_pool);

            // Store workspace path in app state
            let workspace_path = config.workspace_path.clone();
            app.manage(workspace_path.clone());

            // Initialize file system watcher
            if let Err(e) = init_watcher(app, workspace_path) {
                tracing::warn!("Failed to initialize file system watcher: {}", e);
            }

            tracing::info!("Database initialized successfully");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Database commands
            commands::db::db_list_conversations,
            commands::db::db_list_messages,
            commands::db::db_save_message,
            commands::db::db_create_conversation,
            commands::db::db_mark_conversation_read,
            commands::db::db_get_setting,
            commands::db::db_set_setting,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
