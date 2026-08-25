use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDto {
    pub id: String,
    pub name: String,
    pub transport: Option<McpTransportDto>,
    pub config: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransportDto {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    StreamableHttp {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDto {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscoverToolsResponse {
    pub tools: Vec<McpToolDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolResponse {
    pub content: String,
    pub is_error: bool,
    pub raw_result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeSelector {
    pub server_id: String,
    #[serde(default)]
    pub project_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeKey {
    pub server_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_ids: Vec<String>,
    pub config_generation: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum McpProtocolMode {
    Auto,
    Legacy,
    Modern,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum McpProtocolEra {
    Legacy,
    Modern,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum McpRuntimeStatus {
    Disconnected,
    Probing,
    Connecting,
    Ready,
    Reconnecting,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeServerSnapshot {
    pub key: McpRuntimeKey,
    pub status: McpRuntimeStatus,
    pub requested_protocol_mode: Option<McpProtocolMode>,
    pub negotiated_era: Option<McpProtocolEra>,
    pub negotiated_protocol_version: Option<String>,
    pub protocol_decision_reason: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeSnapshotDto {
    pub generated_at: String,
    pub servers: Vec<McpRuntimeServerSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogDto {
    pub key: McpRuntimeKey,
    pub tools: Vec<McpToolDto>,
    pub refreshed_at: Option<String>,
}
