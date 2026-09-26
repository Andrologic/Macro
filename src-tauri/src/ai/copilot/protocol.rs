//! Copilot bridge wire contracts and frontend IPC payloads.
//! Runtime installation and process transport remain in the parent module.

use crate::ai::types::AiToolTrace;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
pub struct BridgeHealthResult {
    pub ok: bool,
    #[serde(rename = "cli_installed")]
    pub _cli_installed: bool,
    pub cli_version: Option<String>,
    pub min_cli_version: String,
    #[serde(rename = "version_ok")]
    pub _version_ok: bool,
    pub auth_status: String,
    pub auth_source: Option<String>,
    pub account_label: Option<String>,
    pub status_message: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
pub struct BridgeModelRecord {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
    pub owned_by: Option<String>,
    pub supported_reasoning_efforts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
pub struct BridgeModelsResponse {
    pub models: Vec<BridgeModelRecord>,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeSendEvent {
    Delta {
        delta: String,
    },
    ToolTrace {
        #[serde(flatten)]
        tool_trace: AiToolTrace,
    },
    ToolRequest {
        request_id: String,
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        args: Value,
    },
    Done {
        content: String,
        reasoning_summary: Option<String>,
        hidden_context: Option<String>,
        tool_traces: Option<Vec<AiToolTrace>>,
        completion_reason: Option<String>,
    },
    Error {
        code: Option<String>,
        message: String,
    },
    Progress {
        #[serde(flatten)]
        _extra: HashMap<String, Value>,
    },
    LoginComplete {
        #[serde(flatten)]
        _extra: HashMap<String, Value>,
    },
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotStatus {
    pub ok: bool,
    pub runtime_source: String,
    pub runtime_status: String,
    pub runtime_version: Option<String>,
    pub min_cli_version: String,
    pub auth_status: String,
    pub auth_source: Option<String>,
    pub account_label: Option<String>,
    pub status_message: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotDownloadProgressEvent {
    pub request_id: String,
    pub provider_id: String,
    pub phase: String,
    pub message: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotDownloadCompleteEvent {
    pub request_id: String,
    pub provider_id: String,
    pub runtime_version: String,
    pub runtime_source: String,
    pub status: CopilotStatus,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotDownloadErrorEvent {
    pub request_id: String,
    pub provider_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotAuthProgressEvent {
    pub request_id: String,
    pub provider_id: String,
    pub phase: String,
    pub message: String,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotAuthCompleteEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotAuthCancelledEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotAuthErrorEvent {
    pub request_id: String,
    pub provider_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct CopilotToolRequestEvent {
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Value,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
pub struct CopilotToolResultRequest {
    pub request_id: String,
    pub tool_call_id: String,
    pub result: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blocks: Option<Vec<crate::commands::mcp::McpResultBlock>>,
    pub hidden_context: Option<String>,
    pub visible_content: Option<String>,
    pub interrupt: Option<bool>,
    pub is_error: Option<bool>,
    pub error_kind: Option<String>,
}

/// Native stdin payload. Nullable fields are always emitted; absent input flags become false.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct BridgeToolResultMessage {
    #[serde(rename = "type")]
    #[ts(type = "\"tool_result\"")]
    message_type: &'static str,
    pub request_id: String,
    pub tool_call_id: String,
    pub result: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blocks: Option<Vec<crate::commands::mcp::McpResultBlock>>,
    pub hidden_context: Option<String>,
    pub visible_content: Option<String>,
    pub interrupt: bool,
    pub is_error: bool,
    pub error_kind: Option<String>,
}

impl From<CopilotToolResultRequest> for BridgeToolResultMessage {
    fn from(request: CopilotToolResultRequest) -> Self {
        Self {
            message_type: "tool_result",
            request_id: request.request_id,
            tool_call_id: request.tool_call_id,
            result: request.result,
            blocks: request.blocks,
            hidden_context: request.hidden_context,
            visible_content: request.visible_content,
            interrupt: request.interrupt.unwrap_or(false),
            is_error: request.is_error.unwrap_or(false),
            error_kind: request.error_kind,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_done_event_deserializes_reasoning_summary() {
        let event = serde_json::from_str::<BridgeSendEvent>(
            r#"{
                "type": "done",
                "content": "Final answer.",
                "reasoning_summary": "Reasoning shown to the user.",
                "completion_reason": "length"
            }"#,
        )
        .expect("done event should deserialize");

        match event {
            BridgeSendEvent::Done {
                content,
                reasoning_summary,
                completion_reason,
                ..
            } => {
                assert_eq!(content, "Final answer.");
                assert_eq!(
                    reasoning_summary.as_deref(),
                    Some("Reasoning shown to the user.")
                );
                assert_eq!(completion_reason.as_deref(), Some("length"));
            }
            _ => panic!("expected done event"),
        }
    }

    #[test]
    fn mcp_blocks_survive_native_tool_submission() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../commands/mcp/fixtures/typed-result.json"
        ))
        .unwrap();
        let request: CopilotToolResultRequest = serde_json::from_value(serde_json::json!({
            "request_id":"fixture", "tool_call_id":"call", "result":"partial result",
            "blocks":fixture["content"], "is_error":true
        }))
        .unwrap();
        let payload = serde_json::to_value(BridgeToolResultMessage::from(request)).unwrap();
        assert_eq!(payload["blocks"], fixture["content"]);
        assert_eq!(payload["is_error"], true);
    }

    #[test]
    fn native_tool_result_payloads_match_shared_decoder_fixtures() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("fixtures/tool-results.json")).unwrap();
        for fixture in fixtures {
            let request: CopilotToolResultRequest =
                serde_json::from_value(fixture["request"].clone()).unwrap();
            // This is the conversion and serializer used by submit_tool_result.
            // The outbound DTO is Serialize-only: never deserialize it as a roundtrip.
            let line = serde_json::to_string(&BridgeToolResultMessage::from(request)).unwrap();
            let actual: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(actual, fixture["payload"], "{}", fixture["name"]);
            assert!(actual.get("error").is_none());
        }
    }

    #[test]
    fn bridge_events_preserve_flatten_defaults_and_error_codes() {
        let trace = serde_json::from_str::<BridgeSendEvent>(
            r#"{"type":"tool_trace","tool_call_id":"call-1","tool_name":"read_file","status":"done","detail":null}"#,
        ).unwrap();
        match trace {
            BridgeSendEvent::ToolTrace { tool_trace } => {
                assert_eq!(tool_trace.tool_call_id, "call-1");
                assert_eq!(tool_trace.status, "done");
                assert!(tool_trace.detail.is_none());
                assert!(tool_trace.execution_mode.is_none());
            }
            _ => panic!("expected flattened tool trace"),
        }
        for args in ["", r#", "args": null"#] {
            let request = format!(
                r#"{{"type":"tool_request","request_id":"req-1","tool_call_id":"call-1","tool_name":"read_file"{args}}}"#
            );
            assert!(matches!(
                serde_json::from_str::<BridgeSendEvent>(&request).unwrap(),
                BridgeSendEvent::ToolRequest {
                    args: Value::Null,
                    ..
                }
            ));
        }
        for kind in ["progress", "login_complete"] {
            let line = format!(r#"{{"type":"{kind}","future":{{"ok":true}}}}"#);
            let extra = match serde_json::from_str::<BridgeSendEvent>(&line).unwrap() {
                BridgeSendEvent::Progress { _extra }
                | BridgeSendEvent::LoginComplete { _extra } => _extra,
                _ => panic!("expected extensible event"),
            };
            assert_eq!(extra["future"]["ok"], true);
        }
        for code in [None, Some("auth_required"), Some("future_code")] {
            let mut payload = serde_json::json!({"type":"error","message":"Bridge failed."});
            if let Some(code) = code {
                payload["code"] = Value::String(code.to_string());
            }
            match serde_json::from_value::<BridgeSendEvent>(payload).unwrap() {
                BridgeSendEvent::Error {
                    code: actual,
                    message,
                } => {
                    assert_eq!(actual.as_deref(), code);
                    assert_eq!(message, "Bridge failed.");
                }
                _ => panic!("expected error event"),
            }
        }
    }
}
