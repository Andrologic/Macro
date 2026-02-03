mod commands;
<<<<<<< HEAD
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
=======
mod db;
mod secrets;

use commands::DbPool;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;
>>>>>>> feature/frontend

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
<<<<<<< HEAD
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
=======
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Arc::new(Mutex::new(None)) as DbPool)
        .setup(|app| {
            let app_handle = app.handle().clone();
            let pool_state = app.state::<DbPool>().inner().clone();

            // Initialize database asynchronously
            tauri::async_runtime::spawn(async move {
                match db::init_db(&app_handle).await {
                    Ok(pool) => {
                        let mut pool_guard = pool_state.lock().await;
                        *pool_guard = Some(pool);
                        println!("Database initialized successfully");
                    }
                    Err(e) => {
                        eprintln!("Failed to initialize database: {}", e);
                    }
                }
            });
>>>>>>> feature/frontend

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
<<<<<<< HEAD
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
=======
            commands::db_list_conversations,
            commands::db_get_conversation,
            commands::db_create_conversation,
            commands::db_rename_conversation,
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
>>>>>>> feature/frontend
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
