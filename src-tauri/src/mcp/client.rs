//! MCP Client Manager
//!
//! Manages multiple MCP server connections and provides a unified interface.

use crate::mcp::protocol::ContentBlock;
use crate::mcp::server::{McpServerProcess, ServerError};
use crate::mcp::types::*;
use chrono::Utc;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Error, Debug)]
pub enum McpError {
    #[error("Server not found: {0}")]
    ServerNotFound(String),
    #[error("Server not connected: {0}")]
    NotConnected(String),
    #[error("Server error: {0}")]
    ServerError(#[from] ServerError),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("Config error: {0}")]
    ConfigError(String),
}

/// Active connection to an MCP server
struct ActiveConnection {
    process: McpServerProcess,
}

/// Manager for all MCP server connections
pub struct McpClientManager {
    /// Server configurations (persisted)
    configs: RwLock<HashMap<String, McpServerConfig>>,
    /// Active connections (runtime only)
    connections: RwLock<HashMap<String, ActiveConnection>>,
    /// Path to config file
    config_path: PathBuf,
}

impl McpClientManager {
    /// Create a new client manager
    pub fn new(config_dir: PathBuf) -> Self {
        let config_path = config_dir.join("mcp-servers.json");
        Self {
            configs: RwLock::new(HashMap::new()),
            connections: RwLock::new(HashMap::new()),
            config_path,
        }
    }

    /// Load server configurations from disk
    pub async fn load_configs(&self) -> Result<(), McpError> {
        if !self.config_path.exists() {
            return Ok(());
        }

        let content = tokio::fs::read_to_string(&self.config_path).await?;
        let configs: HashMap<String, McpServerConfig> = serde_json::from_str(&content)?;
        
        let mut configs_guard = self.configs.write().await;
        *configs_guard = configs;
        
        Ok(())
    }

    /// Save server configurations to disk
    async fn save_configs(&self) -> Result<(), McpError> {
        let configs = self.configs.read().await;
        let content = serde_json::to_string_pretty(&*configs)?;
        
        // Ensure parent directory exists
        if let Some(parent) = self.config_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        
        tokio::fs::write(&self.config_path, content).await?;
        Ok(())
    }

    /// List all servers with their current status
    pub async fn list_servers(&self) -> Vec<McpServer> {
        let configs = self.configs.read().await;
        let connections = self.connections.read().await;

        configs
            .values()
            .map(|config| {
                let (status, tools, resources, error) = if let Some(conn) = connections.get(&config.id) {
                    (
                        McpServerStatus::Connected,
                        conn.process.tools.clone(),
                        conn.process.resources.clone(),
                        None,
                    )
                } else {
                    (McpServerStatus::Disconnected, Vec::new(), Vec::new(), None)
                };

                McpServer {
                    config: config.clone(),
                    status,
                    error,
                    tools,
                    resources,
                }
            })
            .collect()
    }

    /// Add a new server configuration
    pub async fn add_server(&self, input: AddServerInput) -> Result<McpServer, McpError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        let config = McpServerConfig {
            id: id.clone(),
            name: input.name,
            transport: input.transport,
            command: input.command,
            args: input.args,
            env: input.env,
            url: input.url,
            auto_connect: input.auto_connect,
            created_at: now.clone(),
            updated_at: now,
        };

        {
            let mut configs = self.configs.write().await;
            configs.insert(id.clone(), config.clone());
        }

        self.save_configs().await?;

        Ok(McpServer {
            config,
            status: McpServerStatus::Disconnected,
            error: None,
            tools: Vec::new(),
            resources: Vec::new(),
        })
    }

    /// Update a server configuration
    pub async fn update_server(&self, id: &str, input: UpdateServerInput) -> Result<(), McpError> {
        let mut configs = self.configs.write().await;
        
        let config = configs.get_mut(id).ok_or_else(|| McpError::ServerNotFound(id.to_string()))?;

        if let Some(name) = input.name {
            config.name = name;
        }
        if let Some(command) = input.command {
            config.command = Some(command);
        }
        if let Some(args) = input.args {
            config.args = Some(args);
        }
        if let Some(env) = input.env {
            config.env = Some(env);
        }
        if let Some(url) = input.url {
            config.url = Some(url);
        }
        if let Some(auto_connect) = input.auto_connect {
            config.auto_connect = auto_connect;
        }
        config.updated_at = Utc::now().to_rfc3339();

        drop(configs);
        self.save_configs().await?;

        Ok(())
    }

    /// Remove a server configuration
    pub async fn remove_server(&self, id: &str) -> Result<(), McpError> {
        // Disconnect if connected
        self.disconnect_server(id).await.ok();

        let mut configs = self.configs.write().await;
        configs.remove(id).ok_or_else(|| McpError::ServerNotFound(id.to_string()))?;
        
        drop(configs);
        self.save_configs().await?;

        Ok(())
    }

    /// Connect to a server
    pub async fn connect_server(&self, id: &str) -> Result<McpServer, McpError> {
        let config = {
            let configs = self.configs.read().await;
            configs.get(id).cloned().ok_or_else(|| McpError::ServerNotFound(id.to_string()))?
        };

        // Spawn and initialize the process
        let process = tokio::task::spawn_blocking({
            let config = config.clone();
            move || -> Result<McpServerProcess, ServerError> {
                let mut process = McpServerProcess::spawn(&config)?;
                
                // Initialize the MCP protocol
                let _init_result = process.initialize()?;
                
                // List available tools and resources
                // Try to list tools, but don't fail if not supported
                if let Err(e) = process.list_tools() {
                    eprintln!("[MCP] Warning: Failed to list tools for {}: {}", config.id, e);
                }
                
                // Try to list resources, but don't fail if not supported
                if let Err(e) = process.list_resources() {
                    eprintln!("[MCP] Warning: Failed to list resources for {}: {}", config.id, e);
                }
                
                Ok(process)
            }
        })
        .await
        .map_err(|e| McpError::ConfigError(format!("Task join error: {}", e)))??;

        let tools = process.tools.clone();
        let resources = process.resources.clone();

        // Store the connection
        let mut connections = self.connections.write().await;
        connections.insert(id.to_string(), ActiveConnection { process });

        Ok(McpServer {
            config,
            status: McpServerStatus::Connected,
            error: None,
            tools,
            resources,
        })
    }

    /// Disconnect from a server
    pub async fn disconnect_server(&self, id: &str) -> Result<(), McpError> {
        let mut connections = self.connections.write().await;
        
        if let Some(mut conn) = connections.remove(id) {
            conn.process.terminate();
        }

        Ok(())
    }

    /// Call a tool on a connected server
    pub async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Option<HashMap<String, Value>>,
        call_id: &str,
    ) -> Result<McpToolResult, McpError> {
        let mut connections = self.connections.write().await;
        
        let conn = connections
            .get_mut(server_id)
            .ok_or_else(|| McpError::NotConnected(server_id.to_string()))?;

        let result = conn.process.call_tool(tool_name, arguments)?;

        // Convert content blocks to our format
        let content: Vec<McpContent> = result
            .content
            .into_iter()
            .map(|block| match block {
                ContentBlock::Text { text } => McpContent::Text { text },
                ContentBlock::Image { data, mime_type } => McpContent::Image { data, mime_type },
                ContentBlock::Resource { resource } => McpContent::Resource {
                    resource: McpResourceContent {
                        uri: resource.uri,
                        text: resource.text,
                        blob: resource.blob,
                        mime_type: resource.mime_type,
                    },
                },
            })
            .collect();

        Ok(McpToolResult {
            tool_call_id: call_id.to_string(),
            success: !result.is_error,
            content: Some(content),
            error: if result.is_error {
                Some("Tool execution failed".to_string())
            } else {
                None
            },
        })
    }

    /// Ping a server to check if it's responsive
    pub async fn ping_server(&self, id: &str) -> Result<(), McpError> {
        let connections = self.connections.read().await;
        
        let _conn = connections
            .get(id)
            .ok_or_else(|| McpError::NotConnected(id.to_string()))?;

        // For now, just check if we have a connection
        // In the future, we could send a ping request
        Ok(())
    }

    /// Get server logs
    pub async fn get_server_logs(&self, id: &str, limit: usize) -> Result<Vec<String>, McpError> {
        let connections = self.connections.read().await;
        
        let conn = connections
            .get(id)
            .ok_or_else(|| McpError::NotConnected(id.to_string()))?;

        Ok(conn.process.get_logs(limit).await)
    }
}

/// Create a shared MCP client manager
pub fn create_mcp_manager(app_handle: &tauri::AppHandle) -> Arc<McpClientManager> {
    use tauri::Manager;
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .expect("Failed to get app config dir");
    
    Arc::new(McpClientManager::new(config_dir))
}
