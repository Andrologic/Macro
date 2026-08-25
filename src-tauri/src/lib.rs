mod app_quit_state;
pub mod commands;
pub mod config;
pub mod core;
mod db;
mod dev_overrides;
#[cfg(target_os = "macos")]
mod macos_traffic_lights;
#[cfg(target_os = "macos")]
mod macos_window_menu;
mod secrets;
mod speech;
mod state_manager;

// Placeholder modules for critical manual implementation
mod fs;
pub mod git;
pub mod lsp;

mod ai;
mod project_icon;
pub mod project_path;
mod tool_host;
pub mod workspace;

use ai::AiState;
use app_quit_state::AppQuitState;
use commands::DbPool;
use core::{
    apply_runtime_workspace, finalize_desktop_workspace_path, init_logging,
    init_process_environment, load_config,
};
use fs::watcher::init_watcher;
use git::GitState;
use serde::Serialize;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::utils::config::Color;
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tokio::sync::RwLock;

pub type WorkspaceRoot = Arc<RwLock<std::path::PathBuf>>;

fn shutdown_mcp_runtime(app_handle: &tauri::AppHandle) {
    let runtime = app_handle.state::<commands::mcp::McpRuntimeManager>();
    let result = tauri::async_runtime::block_on(tokio::time::timeout(
        std::time::Duration::from_secs(12),
        runtime.shutdown_all(),
    ));
    if result.is_err() {
        tracing::warn!("MCP runtime shutdown exceeded its 12-second budget");
    }
}

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

const FRONTEND_LOG_MESSAGE_LIMIT: usize = 8_000;
const FRONTEND_LOG_SCOPE_LIMIT: usize = 120;

fn truncate_for_frontend_log(value: &str, max_chars: usize) -> String {
    let mut truncated: String = value.chars().take(max_chars).collect();
    if value.chars().count() > max_chars {
        truncated.push_str("...");
    }
    truncated
}

fn normalize_frontend_log_level(level: &str) -> &'static str {
    match level.trim().to_ascii_lowercase().as_str() {
        "debug" => "debug",
        "info" => "info",
        "warn" | "warning" => "warn",
        "error" => "error",
        _ => "warn",
    }
}

// Command to show the main window explicitly from frontend
#[tauri::command]
async fn show_main_window(window: tauri::WebviewWindow) -> Result<(), String> {
    let app_quit_state = window.state::<AppQuitState>();
    if app_quit_state.is_quitting() {
        tracing::info!(
            window = %window.label(),
            "Ignoring show_main_window because app quit is in progress"
        );
        return Ok(());
    }

    window.show().map_err(|error| error.to_string())
}

#[tauri::command]
async fn frontend_log(level: String, scope: String, message: String) -> Result<(), String> {
    let normalized_level = normalize_frontend_log_level(&level);
    let normalized_scope = truncate_for_frontend_log(scope.trim(), FRONTEND_LOG_SCOPE_LIMIT);
    let normalized_message = truncate_for_frontend_log(message.trim(), FRONTEND_LOG_MESSAGE_LIMIT);

    match normalized_level {
        "debug" => tracing::debug!(
            scope = %normalized_scope,
            "{}",
            normalized_message
        ),
        "info" => tracing::info!(
            scope = %normalized_scope,
            "{}",
            normalized_message
        ),
        "error" => tracing::error!(
            scope = %normalized_scope,
            "{}",
            normalized_message
        ),
        _ => tracing::warn!(
            scope = %normalized_scope,
            "{}",
            normalized_message
        ),
    }

    Ok(())
}

#[tauri::command]
fn updater_target() -> Result<String, String> {
    tauri_plugin_updater::target()
        .ok_or_else(|| "Automatic updates are not supported on this platform.".to_string())
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

#[tauri::command]
async fn window_set_traffic_light_position(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_traffic_lights::set_traffic_light_position(window, x, y).await
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, x, y);
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_process_environment();

    // Initialize logging
    init_logging();

    // Load configuration
    let config = load_config().expect("Failed to load configuration");

    tracing::info!("Starting Macro application");
    tracing::info!("Configured workspace path: {:?}", config.workspace_path);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppQuitState::default())
        .manage(DbPool::default())
        .manage(AiState::default())
        .manage(GitState::new())
        .manage(commands::mcp::McpRuntimeManager::production())
        .manage(commands::workspace::ProjectOperationStore::default())
        .manage(commands::terminal::TerminalSessionStore::default())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app_quit_state = window.state::<AppQuitState>();
                app_quit_state.mark_quitting("main-window-close-requested");
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_decorations(true)?;
                    window.set_title_bar_style(TitleBarStyle::Overlay)?;
                    window.set_background_color(Some(Color::from((9, 9, 11, 255))))?;
                    macos_traffic_lights::install_fullscreen_recovery(&window)?;
                }

                let app_handle = app.handle().clone();
                if let Err(error) = app_handle.run_on_main_thread(|| {
                    if let Err(error) = macos_window_menu::rebind_visible_windows_menu() {
                        tracing::warn!("Failed to rebind macOS Window menu: {}", error);
                    }
                }) {
                    tracing::warn!("Failed to schedule macOS Window menu rebinding: {}", error);
                }
            }

            let mut config = config;
            let app_handle = app.handle().clone();
            let pool_state = app.state::<DbPool>().inner().clone();
            let app_data_dir = app_handle.path().app_data_dir()?;
            let state_manager =
                state_manager::StateManager::initialize(&app_data_dir).map_err(|error| {
                    std::io::Error::other(format!(
                        "Failed to initialize Macro state storage: {error}"
                    ))
                })?;
            app.manage(state_manager);
            let app_config_dir = app_handle.path().app_config_dir()?;
            let config_root = config::resolve_config_root(&app_config_dir).map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to resolve Macro configuration directory: {}",
                    error.message
                ))
            })?;
            let config_manager = tauri::async_runtime::block_on(config::ConfigManager::initialize(
                config_root.clone(),
            ))
            .map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to initialize Macro configuration: {}",
                    error.message
                ))
            })?;
            let config_snapshot = tauri::async_runtime::block_on(config_manager.get_snapshot(&[]))
                .map_err(|error| {
                    std::io::Error::other(format!(
                        "Failed to read Macro runtime configuration: {}",
                        error.message
                    ))
                })?;
            if let Some(runtime) = config_snapshot.effective.get("runtime") {
                apply_runtime_workspace(&mut config, runtime).map_err(|error| {
                    std::io::Error::other(format!(
                        "Failed to apply Macro runtime configuration: {error}"
                    ))
                })?;
            }
            config::install_runtime_config_manager(config_manager.clone()).map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to install Macro configuration manager: {}",
                    error.message
                ))
            })?;
            let config_watcher = config::ConfigWatcher::start(
                config_root,
                config_manager.clone(),
                app_handle.clone(),
            )
            .map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to initialize Macro configuration watcher: {error}"
                ))
            })?;
            app.manage(config_manager);
            app.manage(config_watcher);
            secrets::init(&app_data_dir).map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to initialize provider secret storage: {}",
                    error
                ))
            })?;
            finalize_desktop_workspace_path(&mut config, &app_data_dir).map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to resolve desktop workspace path: {}",
                    error
                ))
            })?;

            // Store workspace paths in app state
            // - WorkspaceMetadataRoot: stable root used for workspace metadata CRUD
            // - WorkspaceRoot: runtime root used by file tools/debug execution context
            let workspace_path = config.workspace_path.clone();
            if config.workspace_path_source.is_default() && !cfg!(debug_assertions) {
                std::fs::create_dir_all(&workspace_path).map_err(|error| {
                    std::io::Error::other(format!(
                        "Failed to create default workspace directory {}: {}",
                        workspace_path.display(),
                        error
                    ))
                })?;
            }
            tracing::info!(
                "Resolved workspace path: {:?} ({:?})",
                workspace_path,
                config.workspace_path_source
            );
            let workspace_metadata_root =
                WorkspaceMetadataRoot(Arc::new(RwLock::new(workspace_path.clone())));
            let workspace_runtime_root: WorkspaceRoot =
                Arc::new(RwLock::new(workspace_path.clone()));
            app.manage(workspace_metadata_root.clone());
            app.manage(workspace_runtime_root);

            let tool_host_config = tool_host::start(
                workspace_metadata_root.clone(),
                app.state::<GitState>().inner().clone(),
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
                        pool_state.set_ready(pool);
                        tracing::info!("Database initialized successfully");
                    }
                    Err(e) => {
                        pool_state.set_failed(e.to_string());
                        tracing::error!("Failed to initialize database: {}", e);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Database commands
            commands::db_get_initialization_status,
            commands::db_retry_initialize,
            config::config_get_snapshot,
            config::config_get_document,
            config::config_get_schema,
            config::config_validate_document,
            config::config_apply_patch,
            config::config_reset_path,
            config::config_reload,
            config::config_open_directory,
            config::config_accept_pending_change,
            config::config_reject_pending_change,
            config::config_list_pending_changes,
            config::config_list_orphan_secrets,
            config::config_delete_orphan_secret,
            config::config_list,
            config::config_get,
            config::config_validate,
            config::config_patch,
            state_manager::state_get_snapshot,
            state_manager::state_set_value,
            state_manager::state_delete_value,
            state_manager::state_clear,
            updater_target,
            frontend_log,
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
            window_set_traffic_light_position,
            commands::db_list_conversations,
            commands::db_get_chat_snapshot,
            commands::db_get_chat_bootstrap_snapshot,
            commands::db_get_conversation,
            commands::db_create_conversation,
            commands::db_rename_conversation,
            commands::db_update_conversation_details,
            commands::db_update_conversation_scope,
            commands::db_update_conversation_ai_selection,
            commands::db_delete_conversation_by_id,
            commands::db_delete_conversations_by_ids,
            commands::db_toggle_pin_conversation,
            commands::db_list_messages,
            commands::db_create_message,
            commands::db_import_messages,
            commands::db_update_message,
            commands::db_delete_messages_after,
            commands::db_trim_conversation_replay,
            commands::db_prepare_conversation_replay,
            commands::db_restore_conversation_replay,
            commands::db_complete_conversation_replay,
            commands::db_mark_conversation_replay_launched,
            commands::db_finalize_conversation_replay,
            commands::db_list_conversation_citations,
            commands::db_get_conversation_citation_content,
            commands::db_upsert_conversation_citation,
            commands::db_delete_conversation_citation,
            commands::db_delete_conversation_citations,
            commands::db_get_conversation_toolbox_state,
            commands::db_upsert_conversation_toolbox_state,
            commands::db_delete_conversation_toolbox_state,
            commands::db_get_architect_plan_conversation_sync,
            commands::db_get_architect_plan_conversation_sync_for_plan,
            commands::db_upsert_architect_plan_conversation_sync,
            commands::db_delete_architect_plan_conversation_sync,
            commands::db_list_provider_configs,
            commands::db_get_provider_config,
            commands::db_reveal_provider_api_key,
            commands::db_update_provider_config,
            commands::db_create_provider_config,
            commands::db_delete_provider_config,
            commands::speech::speech_list_provider_configs,
            commands::speech::speech_create_provider_config,
            commands::speech::speech_update_provider_config,
            commands::speech::speech_delete_provider_config,
            commands::speech::speech_transcribe,
            commands::ai_get_dev_provider_overrides,
            commands::ai::ai_start_chatgpt_auth,
            commands::ai::ai_provision_macro_ai,
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
            commands::ai::ai_submit_tool_result,
            // Git metadata commands
            commands::db_upsert_git_repository,
            commands::db_upsert_git_worktree,
            commands::db_list_git_worktrees,
            // Workspace commands
            commands::workspace::workspace_get_bootstrap,
            commands::workspace::workspace_resolve_project_icons,
            commands::workspace::workspace_list_projects,
            commands::workspace::workspace_list_tasks,
            commands::workspace::workspace_get_metadata,
            commands::workspace::workspace_get_project_registry_diagnostics,
            commands::workspace::workspace_recover_missing_metadata,
            commands::workspace::workspace_discover_recoverable_projects,
            commands::workspace::workspace_reconcile_project_registry_from_hints,
            commands::workspace::workspace_get_active_root,
            commands::workspace::workspace_architect_list_plans,
            commands::workspace::workspace_architect_activate_plan_head,
            commands::workspace::workspace_architect_activate_plan_chat,
            commands::workspace::workspace_architect_invalidate,
            commands::workspace::workspace_preview_project_git_setup,
            commands::workspace::workspace_cancel_project_operation,
            commands::workspace::workspace_set_active_root,
            commands::workspace::workspace_create_project,
            commands::workspace::workspace_create_project_with_git_setup,
            commands::workspace::workspace_create_new_project_repo,
            commands::workspace::workspace_import_git_repo,
            commands::workspace::workspace_rename_project_group,
            commands::workspace::workspace_create_project_group,
            commands::workspace::workspace_move_project_to_group,
            commands::workspace::workspace_rename_project,
            commands::workspace::workspace_update_project_git_flow,
            commands::workspace::workspace_update_project_git_flow_with_setup,
            commands::workspace::workspace_preview_project_access_change,
            commands::workspace::workspace_update_project_access,
            commands::workspace::workspace_archive_project_group,
            commands::workspace::workspace_archive_project,
            commands::workspace::workspace_remove_project_group,
            commands::workspace::workspace_remove_project,
            commands::workspace::workspace_close_project,
            commands::workspace::workspace_debug_reset_project,
            commands::workspace::workspace_create_manual_feature_draft,
            commands::workspace::workspace_finalize_manual_feature,
            commands::workspace::workspace_revert_manual_feature_to_draft,
            commands::workspace::workspace_delete_manual_feature_draft,
            commands::workspace::workspace_rename_manual_feature,
            commands::workspace::workspace_archive_manual_feature,
            commands::workspace::workspace_restore_manual_feature,
            commands::workspace::workspace_delete_manual_feature,
            commands::workspace::workspace_update_standalone_task_status,
            commands::workspace::workspace_update_manual_feature_merge_workflow,
            // Tool policy validation command
            commands::tool_get_mode_policy,
            commands::tool_validate_execution,
            commands::tool_execute_workspace,
            commands::tool_cancel_workspace,
            commands::mcp::mcp_discover_tools,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_store_env_secret,
            commands::mcp::mcp_delete_env_secret,
            commands::mcp::mcp_store_oauth_client_secret,
            commands::mcp::mcp_delete_oauth_client_secret,
            commands::mcp::mcp_oauth_authorize,
            commands::mcp::mcp_oauth_logout,
            commands::mcp::mcp_runtime_get_snapshot,
            commands::mcp::mcp_runtime_connect,
            commands::mcp::mcp_runtime_disconnect,
            commands::mcp::mcp_runtime_refresh_catalog,
            commands::mcp::mcp_runtime_call_tool,
            commands::mcp::mcp_runtime_cancel_operation,
            commands::web_search::web_search_get_secret_status,
            commands::web_search::web_search_set_secret,
            commands::web_search::web_search_execute,
            commands::web_search::web_fetch_execute,
            commands::skills::skills_list,
            commands::skills::skills_get,
            commands::skills::skills_install_from_local_path,
            commands::skills::skills_create_template,
            commands::skills::skills_open_location,
            commands::skills::skills_read_resource,
            commands::skills::skills_run_script,
            commands::list_external_apps,
            commands::open_external_target,
            commands::terminal::terminal_list_tabs,
            commands::terminal::terminal_create_tab,
            commands::terminal::terminal_start_command_tab,
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
            commands::fs::fs_search_files,
            commands::fs::fs_stat,
            commands::fs::fs_exists,
            commands::fs::fs_delete,
            commands::fs::fs_create_dir,
            commands::fs::fs_copy,
            commands::fs::fs_move,
            // Git commands
            commands::git::git_status,
            commands::git::git_fetch,
            commands::git::git_log,
            commands::git::git_log_page,
            commands::git::git_branch_list,
            commands::git::git_branch_create,
            commands::git::git_branch_delete,
            commands::git::git_branch_delete_remote,
            commands::git::git_checkout,
            commands::git::git_merge_check,
            commands::git::git_merge,
            commands::git::git_start_merge_resolution,
            commands::git::git_fast_forward,
            commands::git::git_rebase_check,
            commands::git::git_rebase_branch,
            commands::git::git_commit,
            commands::git::git_add,
            commands::git::git_restore_paths,
            commands::git::git_reset,
            commands::git::git_abort_merge,
            commands::git::git_stash,
            commands::git::git_diff,
            commands::git::git_read_file_pair,
            commands::git::git_review_snapshot,
            commands::git::git_review_file,
            commands::git::direct_checkpoint_ensure,
            commands::git::direct_checkpoint_resolve_id,
            commands::git::direct_checkpoint_remove,
            commands::git::direct_review_snapshot,
            commands::git::direct_review_file,
            commands::git::direct_stage_paths,
            commands::git::direct_unstage_paths,
            commands::git::direct_restore_worktree_paths,
            commands::git::direct_accept_changes,
            commands::git::git_read_conflict_file,
            commands::git::git_write_conflict_resolution,
            commands::git::git_accept_conflict_side,
            commands::git::git_complete_merge,
            commands::git::git_get_tree,
            commands::git::git_branch_worktree_inspect,
            commands::git::git_branch_worktree_create,
            commands::git::git_branch_worktree_remove,
            commands::git::git_worktree_inspect,
            commands::git::git_task_start_points,
            commands::git::git_worktree_create,
            commands::git::git_worktree_remove,
            commands::git::git_push,
            commands::git::git_remote_add_origin,
            commands::git::git_pull,
            commands::git::macro_branch_ensure,
            commands::git::macro_branch_status,
            commands::git::macro_branch_commit_if_dirty,
            commands::git::macro_branch_push,
            commands::git::macro_branch_pull,
            commands::db_list_provider_models,
            commands::db_upsert_provider_models,
            commands::db_get_conversation_compaction_state,
            commands::db_upsert_conversation_compaction_state,
            commands::db_insert_conversation_compaction_event,
            commands::db_delete_conversation_compaction_state,
            commands::db_set_provider_model_enabled,
            commands::db_set_all_provider_models_enabled,
            commands::db_register_manual_model,
            commands::db_update_manual_model,
            commands::db_delete_manual_model,
            commands::db_get_provider_settings,
            commands::db_update_provider_settings,
            commands::db_get_setting,
            commands::db_set_setting,
            commands::db_get_app_setting,
            commands::db_set_app_setting,
            commands::db_delete_app_setting,
            commands::db_compare_and_swap_app_setting,
            commands::db_get_project_context_state,
            commands::db_upsert_project_context_state,
            commands::db_delete_project_context_state,
            commands::db_get_session_context_state,
            commands::db_upsert_session_context_state,
            commands::db_reconcile_project_registry,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            let app_quit_state = app_handle.state::<AppQuitState>();
            app_quit_state.mark_quitting("exit-requested");
            shutdown_mcp_runtime(app_handle);
        }
        tauri::RunEvent::Exit => {
            let app_quit_state = app_handle.state::<AppQuitState>();
            app_quit_state.mark_quitting("exit");
            shutdown_mcp_runtime(app_handle);
        }
        _ => {}
    });
}

#[cfg(test)]
mod frontend_log_tests {
    use super::{
        normalize_frontend_log_level, truncate_for_frontend_log, FRONTEND_LOG_MESSAGE_LIMIT,
    };

    #[test]
    fn frontend_log_normalizes_known_and_unknown_levels() {
        assert_eq!(normalize_frontend_log_level("debug"), "debug");
        assert_eq!(normalize_frontend_log_level("INFO"), "info");
        assert_eq!(normalize_frontend_log_level("warning"), "warn");
        assert_eq!(normalize_frontend_log_level("error"), "error");
        assert_eq!(normalize_frontend_log_level("verbose"), "warn");
    }

    #[test]
    fn frontend_log_truncates_long_messages() {
        let message = "x".repeat(FRONTEND_LOG_MESSAGE_LIMIT + 10);
        let truncated = truncate_for_frontend_log(&message, FRONTEND_LOG_MESSAGE_LIMIT);

        assert_eq!(truncated.chars().count(), FRONTEND_LOG_MESSAGE_LIMIT + 3);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn project_registry_sibling_reconcile_command_is_not_registered() {
        let source = include_str!("lib.rs");
        let removed_command = concat!(
            "workspace_",
            "reconcile_project_registry_from_",
            "known_parent_dirs"
        );

        assert!(!source.contains(removed_command));
    }
}
