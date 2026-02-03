//! MCP Server Process Management
//!
//! Handles spawning MCP server processes and stdio communication.

use crate::mcp::protocol::*;
use crate::mcp::types::*;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum ServerError {
    #[error("Failed to spawn process: {0}")]
    SpawnError(String),
    #[allow(dead_code)]
    #[error("Process not running")]
    NotRunning,
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("Protocol error: {0}")]
    ProtocolError(String),
    #[error("Server error: {code} - {message}")]
    RpcError { code: i32, message: String },
    #[allow(dead_code)]
    #[error("Timeout waiting for response")]
    Timeout,
}

/// A running MCP server process
pub struct McpServerProcess {
    config: McpServerConfig,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    request_id: AtomicU64,
    pub tools: Vec<McpTool>,
    pub resources: Vec<McpResource>,
    logs: Arc<Mutex<Vec<String>>>,
}

impl McpServerProcess {
    /// Spawn a new MCP server process
    pub fn spawn(config: &McpServerConfig) -> Result<Self, ServerError> {
        let command = config.command.as_ref().ok_or_else(|| {
            ServerError::SpawnError("No command specified for stdio transport".to_string())
        })?;

        let mut cmd = Command::new(command);

        // Add arguments
        if let Some(args) = &config.args {
            cmd.args(args);
        }

        // Set environment variables
        if let Some(env) = &config.env {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }

        // Configure stdio
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            ServerError::SpawnError(format!("Failed to spawn '{}': {}", command, e))
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            ServerError::SpawnError("Failed to capture stdin".to_string())
        })?;

        let stdout = child.stdout.take().ok_or_else(|| {
            ServerError::SpawnError("Failed to capture stdout".to_string())
        })?;

        Ok(Self {
            config: config.clone(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            request_id: AtomicU64::new(1),
            tools: Vec::new(),
            resources: Vec::new(),
            logs: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// Get the next request ID
    fn next_id(&self) -> u64 {
        self.request_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Send a JSON-RPC request and wait for response
    pub fn send_request(&mut self, method: &str, params: Option<Value>) -> Result<Value, ServerError> {
        let id = self.next_id();
        let request = JsonRpcRequest::new(id, method, params);

        // Serialize and send
        let mut line = serde_json::to_string(&request)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()?;

        // Read response
        let mut response_line = String::new();
        self.stdout.read_line(&mut response_line)?;

        let response: JsonRpcResponse = serde_json::from_str(&response_line)?;

        // Check for error
        if let Some(error) = response.error {
            return Err(ServerError::RpcError {
                code: error.code,
                message: error.message,
            });
        }

        response.result.ok_or_else(|| {
            ServerError::ProtocolError("Response has no result".to_string())
        })
    }

    /// Send the initialized notification
    pub fn send_initialized(&mut self) -> Result<(), ServerError> {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: "notifications/initialized".to_string(),
            params: None,
        };

        let mut line = serde_json::to_string(&notification)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()?;

        Ok(())
    }

    /// Initialize the MCP connection
    pub fn initialize(&mut self) -> Result<InitializeResult, ServerError> {
        let params = InitializeParams {
            protocol_version: PROTOCOL_VERSION.to_string(),
            capabilities: ClientCapabilities::default(),
            client_info: ClientInfo {
                name: CLIENT_NAME.to_string(),
                version: CLIENT_VERSION.to_string(),
            },
        };

        let result = self.send_request("initialize", Some(serde_json::to_value(params)?))?;
        let init_result: InitializeResult = serde_json::from_value(result)?;

        // Send initialized notification
        self.send_initialized()?;

        Ok(init_result)
    }

    /// List available tools
    pub fn list_tools(&mut self) -> Result<Vec<McpTool>, ServerError> {
        let result = self.send_request("tools/list", None)?;
        let tools_result: ListToolsResult = serde_json::from_value(result)?;

        let tools: Vec<McpTool> = tools_result
            .tools
            .into_iter()
            .map(|t| McpTool {
                name: t.name,
                description: t.description,
                input_schema: serde_json::from_value(t.input_schema).unwrap_or_default(),
                server_id: self.config.id.clone(),
            })
            .collect();

        self.tools = tools.clone();
        Ok(tools)
    }

    /// List available resources
    pub fn list_resources(&mut self) -> Result<Vec<McpResource>, ServerError> {
        let result = self.send_request("resources/list", None)?;
        let resources_result: ListResourcesResult = serde_json::from_value(result)?;

        let resources: Vec<McpResource> = resources_result
            .resources
            .into_iter()
            .map(|r| McpResource {
                uri: r.uri,
                name: r.name,
                description: r.description,
                mime_type: r.mime_type,
                server_id: self.config.id.clone(),
            })
            .collect();

        self.resources = resources.clone();
        Ok(resources)
    }

    /// Call a tool
    pub fn call_tool(
        &mut self,
        name: &str,
        arguments: Option<HashMap<String, Value>>,
    ) -> Result<CallToolResult, ServerError> {
        let params = CallToolParams {
            name: name.to_string(),
            arguments: arguments.map(|a| serde_json::to_value(a).unwrap_or(Value::Null)),
        };

        let result = self.send_request("tools/call", Some(serde_json::to_value(params)?))?;
        let tool_result: CallToolResult = serde_json::from_value(result)?;

        Ok(tool_result)
    }

    /// Check if the process is still running
    #[allow(dead_code)]
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Get server logs
    pub async fn get_logs(&self, limit: usize) -> Vec<String> {
        let logs = self.logs.lock().await;
        logs.iter().rev().take(limit).cloned().collect()
    }

    /// Terminate the process
    pub fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for McpServerProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}
