mod env_secrets;
mod ids;
mod modern_adapter;
mod protocol;
mod result_format;
mod rmcp_adapter;
mod runtime;
mod runtime_connector;
mod stdio;
mod types;

use self::ids::{
    build_mcp_env_secret_id, build_mcp_env_secret_ref, is_canonical_mcp_server_id,
    is_valid_mcp_env_key,
};
use self::stdio::{call_stdio_tool, discover_stdio_tools};
pub use self::types::{
    McpCallToolResponse, McpCatalogDto, McpDiscoverToolsResponse, McpRuntimeKey,
    McpRuntimeSelector, McpRuntimeServerSnapshot, McpRuntimeSnapshotDto, McpServerDto, McpToolDto,
    McpTransportDto,
};
use crate::commands::{command_error, CommandResult};
use crate::config::ConfigManager;
use crate::secrets;
pub use runtime::{McpRuntimeError, McpRuntimeManager};
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn mcp_discover_tools(
    manager: State<'_, ConfigManager>,
    server: McpServerDto,
) -> CommandResult<McpDiscoverToolsResponse> {
    let _authority = manager.lock_mcp_runtime_configuration().await;
    Ok(McpDiscoverToolsResponse {
        tools: discover_stdio_tools(&server, None).await?,
    })
}

#[tauri::command]
pub async fn mcp_call_tool(
    manager: State<'_, ConfigManager>,
    server: McpServerDto,
    tool_name: String,
    arguments: Value,
    timeout_ms: Option<u64>,
) -> CommandResult<McpCallToolResponse> {
    let _authority = manager.lock_mcp_runtime_configuration().await;
    call_stdio_tool(&server, &tool_name, arguments, timeout_ms).await
}

#[tauri::command]
pub async fn mcp_store_env_secret(
    manager: State<'_, ConfigManager>,
    runtime: State<'_, McpRuntimeManager>,
    server_id: String,
    key: String,
    value: String,
) -> CommandResult<String> {
    let key = key.trim();
    if !is_canonical_mcp_server_id(&server_id) {
        return Err(command_error("MCP server id must be canonical."));
    }
    if !is_valid_mcp_env_key(key) {
        return Err(command_error("MCP env secret key is invalid."));
    }

    let _authority = manager.lock_secret_references().await;
    let secret_id = build_mcp_env_secret_id(&server_id, key);
    secrets::set_api_key(&secret_id, &value)
        .map_err(|error| command_error(format!("Failed to store MCP env secret: {}", error)))?;
    runtime
        .invalidate_server(
            &server_id,
            format!("MCP secrets for server '{server_id}' changed."),
        )
        .await;
    Ok(build_mcp_env_secret_ref(&server_id, key))
}

#[tauri::command]
pub async fn mcp_delete_env_secret(
    manager: State<'_, ConfigManager>,
    runtime: State<'_, McpRuntimeManager>,
    server_id: String,
    key: String,
) -> CommandResult<()> {
    let key = key.trim();
    if !is_canonical_mcp_server_id(&server_id) {
        return Err(command_error("MCP server id must be canonical."));
    }
    if !is_valid_mcp_env_key(key) {
        return Err(command_error("MCP env secret key is invalid."));
    }

    let _authority = manager.lock_secret_references().await;
    let secret_id = build_mcp_env_secret_id(&server_id, key);
    secrets::delete_api_key(&secret_id)
        .map_err(|error| command_error(format!("Failed to delete MCP env secret: {}", error)))?;
    runtime
        .invalidate_server(
            &server_id,
            format!("MCP secrets for server '{server_id}' changed."),
        )
        .await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_runtime_get_snapshot(
    runtime: State<'_, McpRuntimeManager>,
) -> Result<McpRuntimeSnapshotDto, McpRuntimeError> {
    Ok(runtime.snapshot().await)
}

#[tauri::command]
pub async fn mcp_runtime_connect(
    runtime: State<'_, McpRuntimeManager>,
    selector: McpRuntimeSelector,
) -> Result<McpRuntimeServerSnapshot, McpRuntimeError> {
    runtime.connect(selector).await
}

#[tauri::command]
pub async fn mcp_runtime_disconnect(
    runtime: State<'_, McpRuntimeManager>,
    key: McpRuntimeKey,
) -> Result<(), McpRuntimeError> {
    runtime.disconnect(&key).await
}

#[tauri::command]
pub async fn mcp_runtime_refresh_catalog(
    runtime: State<'_, McpRuntimeManager>,
    key: McpRuntimeKey,
) -> Result<McpCatalogDto, McpRuntimeError> {
    runtime.refresh_catalog(&key).await
}

#[tauri::command]
pub async fn mcp_runtime_call_tool(
    runtime: State<'_, McpRuntimeManager>,
    key: McpRuntimeKey,
    tool_name: String,
    arguments: Value,
    operation_id: String,
) -> Result<McpCallToolResponse, McpRuntimeError> {
    runtime
        .call_tool(&key, &tool_name, arguments, operation_id)
        .await
}

#[tauri::command]
pub async fn mcp_runtime_cancel_operation(
    runtime: State<'_, McpRuntimeManager>,
    operation_id: String,
) -> Result<bool, McpRuntimeError> {
    Ok(runtime.cancel_operation(&operation_id).await)
}
