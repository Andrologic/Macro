mod env_secrets;
mod ids;
mod protocol;
mod result_format;
mod stdio;
mod types;

use self::ids::{build_mcp_env_secret_id, build_mcp_env_secret_ref};
use self::stdio::{call_stdio_tool, discover_stdio_tools};
pub use self::types::{
    McpCallToolResponse, McpDiscoverToolsResponse, McpServerDto, McpToolDto, McpTransportDto,
};
use crate::commands::{command_error, CommandResult};
use crate::secrets;
use serde_json::Value;

#[tauri::command]
pub async fn mcp_discover_tools(server: McpServerDto) -> CommandResult<McpDiscoverToolsResponse> {
    Ok(McpDiscoverToolsResponse {
        tools: discover_stdio_tools(&server, None).await?,
    })
}

#[tauri::command]
pub async fn mcp_call_tool(
    server: McpServerDto,
    tool_name: String,
    arguments: Value,
    timeout_ms: Option<u64>,
) -> CommandResult<McpCallToolResponse> {
    call_stdio_tool(&server, &tool_name, arguments, timeout_ms).await
}

#[tauri::command]
pub async fn mcp_store_env_secret(
    server_id: String,
    key: String,
    value: String,
) -> CommandResult<String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(command_error("MCP env secret key is required."));
    }

    let secret_id = build_mcp_env_secret_id(&server_id, key);
    secrets::set_api_key(&secret_id, &value)
        .map_err(|error| command_error(format!("Failed to store MCP env secret: {}", error)))?;
    Ok(build_mcp_env_secret_ref(&server_id, key))
}

#[tauri::command]
pub async fn mcp_delete_env_secret(server_id: String, key: String) -> CommandResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(());
    }

    let secret_id = build_mcp_env_secret_id(&server_id, key);
    secrets::delete_api_key(&secret_id)
        .map_err(|error| command_error(format!("Failed to delete MCP env secret: {}", error)))
}
