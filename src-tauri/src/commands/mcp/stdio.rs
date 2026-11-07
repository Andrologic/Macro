use super::env_secrets::resolve_env_secrets;
use super::ids::is_canonical_mcp_server_id;
use super::types::{McpServerDto, McpTransportDto};
use crate::commands::{command_error, CommandResult};
use serde_json::Value;
use std::collections::HashMap;

fn server_enabled(server: &McpServerDto) -> bool {
    server
        .config
        .as_ref()
        .and_then(|config| config.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true)
}

pub(crate) async fn resolve_stdio_transport_async(
    server: &McpServerDto,
) -> CommandResult<(String, Vec<String>, HashMap<String, String>)> {
    let server = server.clone();
    secrets_blocking(move || resolve_stdio_transport(&server)).await
}

async fn secrets_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    crate::secrets::blocking::run(operation)
        .await
        .map_err(|error| command_error(error.to_string()))?
}

pub(crate) fn resolve_stdio_transport(
    server: &McpServerDto,
) -> CommandResult<(String, Vec<String>, HashMap<String, String>)> {
    if !is_canonical_mcp_server_id(&server.id) {
        return Err(command_error(format!(
            "MCP server id '{}' is not canonical.",
            server.id
        )));
    }
    if !server_enabled(server) {
        return Err(command_error(format!(
            "MCP server '{}' is disabled.",
            server.name
        )));
    }

    match server.transport.as_ref() {
        Some(McpTransportDto::Stdio { command, args, env }) if !command.trim().is_empty() => Ok((
            command.trim().to_string(),
            args.clone(),
            resolve_env_secrets(server, env)?,
        )),
        Some(McpTransportDto::Sse { .. }) | Some(McpTransportDto::StreamableHttp { .. }) => Err(
            command_error("Only stdio MCP servers are supported by this Macro build."),
        ),
        _ => Err(command_error(format!(
            "MCP server '{}' is missing a stdio command.",
            server.name
        ))),
    }
}
