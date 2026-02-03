mod commands;
mod db;
mod secrets;

use commands::DbPool;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_main_window,
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
            commands::db_list_provider_models,
            commands::db_upsert_provider_models,
            commands::db_set_provider_model_enabled,
            commands::db_set_all_provider_models_enabled,
            commands::db_get_provider_settings,
            commands::db_update_provider_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
