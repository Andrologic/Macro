//! Provider-independent AI wire contracts. Provider codecs keep their own request formats.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AiChatRequest {
    pub request_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub conversation_id: Option<String>,
    pub messages: Vec<AiChatMessage>,
    #[serde(default)]
    pub tools: Vec<Value>,
    pub tool_choice: Option<String>,
    pub parallel_tool_calls: Option<bool>,
    pub workspace_path: Option<String>,
    pub default_workspace_path: Option<String>,
    #[serde(default)]
    pub project_mounts: Vec<AiProjectMount>,
    pub virtual_root_enabled: Option<bool>,
    pub focused_project_id: Option<String>,
    #[serde(default)]
    pub allowed_tool_ids: Vec<String>,
    #[serde(default)]
    pub copilot_send_timeout_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AiChatMessage {
    pub role: String,
    pub content: AiChatMessageContent,
    #[serde(default)]
    pub tool_calls: Vec<AiToolCall>,
    pub tool_call_id: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_input_items: Option<Vec<Value>>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_turn_state: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AiToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: AiToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AiToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
#[derive(ts_rs::TS)]
pub enum AiChatMessageContent {
    Text(String),
    Parts(Vec<AiChatMessagePart>),
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AiChatMessagePart {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: Option<String>,
    pub image_url: Option<AiChatImageUrl>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AiChatImageUrl {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiStreamChunkEvent {
    pub request_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiStreamToolTraceEvent {
    pub request_id: String,
    pub tool_trace: AiToolTrace,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiStreamDoneEvent {
    pub request_id: String,
    pub output_text: String,
    pub tool_calls: Vec<AiToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub response_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub output_items: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_input_items: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_turn_state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reasoning_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool_traces: Option<Vec<AiToolTrace>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hidden_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accepted_submission_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completion_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiStreamErrorEvent {
    pub request_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiStreamTimelineEvent {
    pub request_id: String,
    pub provider_id: String,
    pub provider_type: String,
    pub phase: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiAuthStartedEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiAuthSuccessEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiAuthCancelledEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct AiAuthErrorEvent {
    pub request_id: String,
    pub provider_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AiProjectMount {
    pub project_id: String,
    pub mount_name: String,
    pub workspace_path: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AiToolTrace {
    pub tool_call_id: String,
    pub tool_name: String,
    pub detail: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub execution_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub batch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub order: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completed_at_ms: Option<u64>,
}
