use super::env_secrets::resolve_env_secrets;
use super::ids::{build_mcp_tool_id, is_canonical_mcp_server_id, normalize_identifier};
use super::protocol::{initialize, read_response, write_message};
use super::result_format::format_tool_call_result;
use super::types::{McpCallToolResponse, McpServerDto, McpToolDto, McpTransportDto};
use crate::commands::{command_error, CommandResult};
use crate::core::process::{background_tokio_command, ContainedBackgroundProcess};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

const DEFAULT_MCP_TIMEOUT_MS: u64 = 15_000;
const MAX_STDERR_CHARS: usize = 4_000;
const MAX_STDERR_BYTES: u64 = 64 * 1024;
const MAX_TOOLS_LIST_PAGES: usize = 100;
const MAX_TOOLS_CATALOG_BYTES: usize = 16 * 1024 * 1024;

fn accumulate_catalog_size(current: usize, page_bytes: usize) -> CommandResult<usize> {
    let total = current
        .checked_add(page_bytes)
        .ok_or_else(|| command_error("MCP tools catalog size overflowed its cumulative budget."))?;
    if total > MAX_TOOLS_CATALOG_BYTES {
        return Err(command_error(format!(
            "MCP tools catalog exceeds the cumulative limit of {} bytes.",
            MAX_TOOLS_CATALOG_BYTES
        )));
    }
    Ok(total)
}

fn server_enabled(server: &McpServerDto) -> bool {
    server
        .config
        .as_ref()
        .and_then(|config| config.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true)
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

fn stderr_excerpt(stderr: &str) -> String {
    let trimmed = stderr.trim();
    let mut excerpt = trimmed.chars().take(MAX_STDERR_CHARS).collect::<String>();
    if trimmed.chars().count() > MAX_STDERR_CHARS {
        excerpt.push_str("...");
    }
    excerpt
}

async fn with_stdio_client<T, F, Fut>(
    server: &McpServerDto,
    timeout_ms: Option<u64>,
    operation: F,
) -> CommandResult<T>
where
    F: FnOnce(tokio::process::ChildStdin, BufReader<tokio::process::ChildStdout>) -> Fut,
    Fut: std::future::Future<Output = CommandResult<T>>,
{
    let (command, args, env) = resolve_stdio_transport(server)?;
    let mut child_command = background_tokio_command(command);
    child_command
        .args(args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ContainedBackgroundProcess::spawn(child_command).map_err(|error| {
        command_error(format!(
            "Failed to start MCP server '{}': {}",
            server.name, error
        ))
    })?;

    let stdin = child
        .take_stdin()
        .ok_or_else(|| command_error("Failed to open MCP server stdin."))?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| command_error("Failed to open MCP server stdout."))?;
    let stderr = child.take_stderr();
    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_task = stderr.map(|stderr| {
        let stderr_buffer = stderr_buffer.clone();
        tokio::spawn(async move {
            let mut text = String::new();
            let _ = stderr
                .take(MAX_STDERR_BYTES)
                .read_to_string(&mut text)
                .await;
            *stderr_buffer.lock().await = text;
        })
    });

    let duration = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_MCP_TIMEOUT_MS));
    let result = match timeout(duration, operation(stdin, BufReader::new(stdout))).await {
        Ok(result) => result,
        Err(_) => Err(command_error(format!(
            "MCP server '{}' timed out.",
            server.name
        ))),
    };

    let _ = child.terminate_with_grace(Duration::ZERO).await;
    if let Some(stderr_task) = stderr_task {
        let _ = stderr_task.await;
    }

    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let stderr = stderr_excerpt(&stderr_buffer.lock().await);
            if stderr.is_empty() {
                Err(error)
            } else {
                Err(command_error(format!(
                    "{} Stderr: {}",
                    error.message, stderr
                )))
            }
        }
    }
}

pub(crate) async fn discover_stdio_tools(
    server: &McpServerDto,
    timeout_ms: Option<u64>,
) -> CommandResult<Vec<McpToolDto>> {
    with_stdio_client(server, timeout_ms, |mut writer, mut reader| async move {
        initialize(&mut writer, &mut reader).await?;
        let mut tools = Vec::new();
        let mut catalog_bytes = 0;
        let mut cursor: Option<String> = None;
        for page in 0..MAX_TOOLS_LIST_PAGES {
            let request_id = 2 + page as i64;
            let params = match cursor.as_deref() {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            write_message(
                &mut writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "tools/list",
                    "params": params
                }),
            )
            .await?;
            let result = read_response(&mut writer, &mut reader, request_id).await?;
            let page_tools = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| command_error("MCP tools/list response is missing tools array."))?;
            let page_bytes = serde_json::to_vec(page_tools)
                .map_err(|error| command_error(format!("Failed to size MCP tools page: {error}")))?
                .len();
            catalog_bytes = accumulate_catalog_size(catalog_bytes, page_bytes)?;
            tools.extend(page_tools.iter().cloned());
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        if cursor.is_some() {
            return Err(command_error(
                "MCP server exceeded the tools/list pagination limit.",
            ));
        }

        let server_id = normalize_identifier(&server.id, "server");
        Ok(tools
            .iter()
            .filter_map(|tool| {
                let name = tool.get("name")?.as_str()?.to_string();
                Some(McpToolDto {
                    id: build_mcp_tool_id(&server_id, &name),
                    server_id: server_id.clone(),
                    name,
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    input_schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    enabled: true,
                })
            })
            .collect())
    })
    .await
}

pub(crate) async fn call_stdio_tool(
    server: &McpServerDto,
    tool_name: &str,
    arguments: Value,
    timeout_ms: Option<u64>,
) -> CommandResult<McpCallToolResponse> {
    let tool_name = tool_name.to_string();
    with_stdio_client(server, timeout_ms, |mut writer, mut reader| async move {
        initialize(&mut writer, &mut reader).await?;
        write_message(
            &mut writer,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": tool_name,
                    "arguments": arguments
                }
            }),
        )
        .await?;
        let result = read_response(&mut writer, &mut reader, 2).await?;
        let content = format_tool_call_result(&result);
        Ok(McpCallToolResponse {
            content,
            is_error: result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            raw_result: result,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::process::background_command;
    use std::fs;
    use std::path::PathBuf;

    fn python3() -> Option<String> {
        background_command("python3")
            .arg("--version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|_| "python3".to_string())
    }

    #[test]
    fn enforces_cumulative_catalog_budget() {
        assert_eq!(
            accumulate_catalog_size(MAX_TOOLS_CATALOG_BYTES - 1, 1).unwrap(),
            MAX_TOOLS_CATALOG_BYTES
        );
        let error = accumulate_catalog_size(MAX_TOOLS_CATALOG_BYTES, 1)
            .expect_err("catalog over budget must fail");
        assert!(error.message.contains("cumulative limit"));
        assert!(accumulate_catalog_size(usize::MAX, 1).is_err());
    }

    #[test]
    fn stderr_excerpt_is_unicode_safe() {
        let stderr = "é".repeat(MAX_STDERR_CHARS + 1);

        let excerpt = stderr_excerpt(&stderr);

        assert_eq!(excerpt, format!("{}...", "é".repeat(MAX_STDERR_CHARS)));
    }

    fn fake_server_script() -> String {
        r#"
import json, sys

PAGE_ONE = [{'name': 'echo-value', 'description': 'Echo input', 'inputSchema': {'type': 'object', 'properties': {'value': {'type': 'string'}}}}]
PAGE_TWO = [{'name': 'echo-value-two', 'description': 'Echo input again', 'inputSchema': {'type': 'object', 'properties': {'value': {'type': 'string'}}}}]

def read_message():
    line = sys.stdin.buffer.readline()
    if not line:
        raise SystemExit(0)
    return json.loads(line)

def write_message(payload):
    sys.stdout.buffer.write(json.dumps(payload).encode() + b'\n')
    sys.stdout.buffer.flush()

while True:
    message = read_message()
    method = message.get('method')
    if method is None or 'id' not in message:
        continue
    if method == 'initialize':
        write_message({'jsonrpc': '2.0', 'id': message['id'], 'result': {'protocolVersion': message.get('params', {}).get('protocolVersion'), 'capabilities': {}}})
    elif method == 'ping':
        write_message({'jsonrpc': '2.0', 'id': message['id'], 'result': {}})
    elif method == 'tools/list':
        write_message({'jsonrpc': '2.0', 'id': 'macro-fixture-ping', 'method': 'ping'})
        pong = read_message()
        assert pong.get('id') == 'macro-fixture-ping', pong
        assert 'result' in pong, pong
        if message.get('params', {}).get('cursor') == 'page-2':
            write_message({'jsonrpc': '2.0', 'id': message['id'], 'result': {'tools': PAGE_TWO}})
        else:
            write_message({'jsonrpc': '2.0', 'id': message['id'], 'result': {'tools': PAGE_ONE, 'nextCursor': 'page-2'}})
    elif method == 'tools/call':
        args = message.get('params', {}).get('arguments', {})
        write_message({'jsonrpc': '2.0', 'id': message['id'], 'result': {'content': [{'type': 'text', 'text': 'echo:' + args.get('value', '')}]}})
"#
        .to_string()
    }

    fn unsupported_version_server_script() -> String {
        r#"
import json, sys

line = sys.stdin.buffer.readline()
message = json.loads(line)
payload = {'jsonrpc': '2.0', 'id': message['id'], 'result': {'protocolVersion': '2099-01-01', 'capabilities': {}}}
sys.stdout.buffer.write(json.dumps(payload).encode() + b'\n')
sys.stdout.buffer.flush()
"#
        .to_string()
    }

    fn sleeping_server_script() -> String {
        r#"
import time
time.sleep(5)
"#
        .to_string()
    }

    fn write_fake_server() -> Option<(tempfile::TempDir, PathBuf, String)> {
        let python = python3()?;
        let dir = tempfile::tempdir().ok()?;
        let path = dir.path().join("fake_mcp_server.py");
        fs::write(&path, fake_server_script()).ok()?;
        Some((dir, path, python))
    }

    fn write_unsupported_version_server() -> Option<(tempfile::TempDir, PathBuf, String)> {
        let python = python3()?;
        let dir = tempfile::tempdir().ok()?;
        let path = dir.path().join("unsupported_version_mcp_server.py");
        fs::write(&path, unsupported_version_server_script()).ok()?;
        Some((dir, path, python))
    }

    fn write_sleeping_server() -> Option<(tempfile::TempDir, PathBuf, String)> {
        let python = python3()?;
        let dir = tempfile::tempdir().ok()?;
        let path = dir.path().join("sleeping_mcp_server.py");
        fs::write(&path, sleeping_server_script()).ok()?;
        Some((dir, path, python))
    }

    fn test_server(path: PathBuf, python: String) -> McpServerDto {
        McpServerDto {
            id: "test_server".to_string(),
            name: "Test Server".to_string(),
            transport: Some(McpTransportDto::Stdio {
                command: python,
                args: vec![path.to_string_lossy().to_string()],
                env: HashMap::new(),
            }),
            config: Some(json!({ "enabled": true })),
        }
    }

    #[tokio::test]
    async fn discovers_and_calls_stdio_tools() {
        let Some((_dir, script, python)) = write_fake_server() else {
            return;
        };
        let server = test_server(script, python);
        let tools = discover_stdio_tools(&server, Some(5_000))
            .await
            .expect("discover tools");
        let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
        assert_eq!(names, ["echo-value", "echo-value-two"]);
        assert_eq!(tools[0].id, "mcp__test_server__echo-value");
        assert_eq!(tools[1].id, "mcp__test_server__echo-value-two");

        let result = call_stdio_tool(&server, "echo-value", json!({ "value": "ok" }), Some(5_000))
            .await
            .expect("call tool");
        assert_eq!(result.content, "echo:ok");
    }

    #[tokio::test]
    async fn rejects_servers_negotiating_unsupported_protocol_versions() {
        let Some((_dir, script, python)) = write_unsupported_version_server() else {
            return;
        };
        let server = test_server(script, python);

        let error = discover_stdio_tools(&server, Some(5_000))
            .await
            .expect_err("unsupported negotiated version should be rejected");
        assert!(error.message.contains("unsupported protocol version"));
    }

    #[tokio::test]
    async fn rejects_disabled_servers_before_launch() {
        let server = McpServerDto {
            id: "disabled".to_string(),
            name: "Disabled".to_string(),
            transport: Some(McpTransportDto::Stdio {
                command: "should-not-launch".to_string(),
                args: Vec::new(),
                env: HashMap::new(),
            }),
            config: Some(json!({ "enabled": false })),
        };

        let error = discover_stdio_tools(&server, Some(50))
            .await
            .expect_err("disabled server should be rejected");
        assert!(error.message.contains("disabled"));
    }

    #[tokio::test]
    async fn rejects_noncanonical_server_ids_before_launch() {
        let server = McpServerDto {
            id: "GitHub Server".to_string(),
            name: "GitHub Server".to_string(),
            transport: Some(McpTransportDto::Stdio {
                command: "should-not-launch".to_string(),
                args: Vec::new(),
                env: HashMap::new(),
            }),
            config: Some(json!({ "enabled": true })),
        };

        let error = discover_stdio_tools(&server, Some(50))
            .await
            .expect_err("noncanonical server id should be rejected");
        assert!(error.message.contains("not canonical"));
    }

    #[tokio::test]
    async fn times_out_unresponsive_stdio_servers() {
        let Some((_dir, script, python)) = write_sleeping_server() else {
            return;
        };
        let server = test_server(script, python);

        let error = discover_stdio_tools(&server, Some(50))
            .await
            .expect_err("unresponsive server should time out");
        assert!(error.message.contains("timed out"));
    }
}
