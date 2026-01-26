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
            app.manage(config.workspace_path);

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
