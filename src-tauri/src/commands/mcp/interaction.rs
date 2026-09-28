//! Ephemeral, bounded handoff between MCP operations and an explicit UI host.
//! No interaction or response is persisted or logged.
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::form_schema::FormSchema;
use super::runtime::{McpOperationCancellation, McpRuntimeError};
use super::types::McpRuntimeKey;

const MAX_PENDING: usize = 32;
const MAX_PROMPTS: usize = 8;
const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct McpElicitationPrompt {
    pub id: String,
    pub request: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct McpInteractionRequest {
    pub request_id: String,
    pub key: McpRuntimeKey,
    pub operation_id: String,
    /// Absolute deadline for the ephemeral UI queue; Rust remains authoritative.
    pub expires_at_ms: u64,
    pub prompts: Vec<McpElicitationPrompt>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
pub enum McpElicitationAction {
    Accept,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct McpElicitationAnswer {
    pub id: String,
    pub action: McpElicitationAction,
    pub content: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct McpInteractionResponse {
    pub request_id: String,
    pub key: McpRuntimeKey,
    pub operation_id: String,
    pub answers: Vec<McpElicitationAnswer>,
}

struct Port {
    lease_id: String,
    channel: Channel<McpInteractionRequest>,
}

struct Pending {
    lease_id: String,
    key: McpRuntimeKey,
    operation_id: String,
    form_schemas: BTreeMap<String, FormSchema>,
    sender: oneshot::Sender<BTreeMap<String, Value>>,
}

#[derive(Default)]
struct BrokerState {
    closed: bool,
    port: Option<Port>,
    pending: HashMap<String, Pending>,
}

#[derive(Clone, Default)]
pub struct McpInteractionBroker {
    state: Arc<Mutex<BrokerState>>,
}

struct PendingGuard {
    broker: McpInteractionBroker,
    request_id: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.broker.remove(&self.request_id);
    }
}

fn error(code: &'static str, message: &'static str) -> McpRuntimeError {
    McpRuntimeError::new(code, message)
}

impl McpInteractionBroker {
    /// The port is installed only after the global form host has mounted.
    pub fn has_host(&self) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        !state.closed && state.port.is_some()
    }

    pub fn open(&self, channel: Channel<McpInteractionRequest>) -> Result<String, McpRuntimeError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.closed {
            return Err(error(
                "MCP_INTERACTION_HOST_CLOSED",
                "The MCP interaction broker is shut down.",
            ));
        }
        if state.port.is_some() {
            return Err(error(
                "MCP_INTERACTION_PORT_BUSY",
                "An MCP interaction host is already connected.",
            ));
        }
        let lease_id = Uuid::new_v4().to_string();
        state.port = Some(Port {
            lease_id: lease_id.clone(),
            channel,
        });
        Ok(lease_id)
    }

    pub fn close(&self, lease_id: &str) -> Result<(), McpRuntimeError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state
            .port
            .as_ref()
            .is_none_or(|port| port.lease_id != lease_id)
        {
            return Err(error(
                "MCP_INTERACTION_PORT_STALE",
                "The MCP interaction host lease is no longer active.",
            ));
        }
        state.port = None;
        state.pending.clear(); // Dropped senders wake every waiter with an explicit error.
        Ok(())
    }

    pub fn shutdown(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.closed = true;
        state.port = None;
        state.pending.clear();
    }

    pub fn respond(
        &self,
        lease_id: &str,
        response: McpInteractionResponse,
    ) -> Result<(), McpRuntimeError> {
        if serde_json::to_vec(&response.answers)
            .map_or(true, |bytes| bytes.len() > MAX_RESPONSE_BYTES)
        {
            return Err(error(
                "MCP_INTERACTION_LIMIT",
                "The MCP interaction response exceeds its size limit.",
            ));
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let pending = state.pending.get(&response.request_id).ok_or_else(|| {
            error(
                "MCP_INTERACTION_STALE",
                "The MCP interaction is no longer pending.",
            )
        })?;
        if pending.lease_id != lease_id
            || pending.key != response.key
            || pending.operation_id != response.operation_id
        {
            return Err(error(
                "MCP_INTERACTION_MISMATCH",
                "The MCP interaction does not belong to this host or operation.",
            ));
        }
        if response.answers.len() != pending.form_schemas.len() {
            return Err(error(
                "MCP_INTERACTION_INVALID_RESPONSE",
                "The MCP interaction response has the wrong number of answers.",
            ));
        }
        let mut answers = BTreeMap::new();
        for answer in response.answers {
            if !pending.form_schemas.contains_key(&answer.id) || answers.contains_key(&answer.id) {
                return Err(error(
                    "MCP_INTERACTION_INVALID_RESPONSE",
                    "The MCP interaction response contains an unknown or duplicate prompt.",
                ));
            }
            let value = match answer.action {
                McpElicitationAction::Accept => {
                    let content = answer.content.ok_or_else(|| {
                        error(
                            "MCP_INTERACTION_INVALID_RESPONSE",
                            "Accepted MCP input requires content.",
                        )
                    })?;
                    pending
                        .form_schemas
                        .get(&answer.id)
                        .expect("checked above")
                        .validate_content(&content)?;
                    serde_json::json!({ "action": "accept", "content": content })
                }
                McpElicitationAction::Decline => {
                    if answer.content.is_some() {
                        return Err(error(
                            "MCP_INTERACTION_INVALID_RESPONSE",
                            "Declined MCP input cannot contain content.",
                        ));
                    }
                    serde_json::json!({ "action": "decline" })
                }
                McpElicitationAction::Cancel => {
                    if answer.content.is_some() {
                        return Err(error(
                            "MCP_INTERACTION_INVALID_RESPONSE",
                            "Cancelled MCP input cannot contain content.",
                        ));
                    }
                    serde_json::json!({ "action": "cancel" })
                }
            };
            answers.insert(answer.id, value);
        }
        let pending = state
            .pending
            .remove(&response.request_id)
            .expect("checked above");
        pending.sender.send(answers).map_err(|_| {
            error(
                "MCP_INTERACTION_STALE",
                "The MCP interaction is no longer pending.",
            )
        })
    }

    pub async fn request(
        &self,
        key: McpRuntimeKey,
        operation_id: String,
        prompts: Vec<McpElicitationPrompt>,
        cancellation: Arc<McpOperationCancellation>,
    ) -> Result<BTreeMap<String, Value>, McpRuntimeError> {
        self.request_with_timeout(key, operation_id, prompts, cancellation, RESPONSE_TIMEOUT)
            .await
    }

    async fn request_with_timeout(
        &self,
        key: McpRuntimeKey,
        operation_id: String,
        prompts: Vec<McpElicitationPrompt>,
        cancellation: Arc<McpOperationCancellation>,
        response_timeout: Duration,
    ) -> Result<BTreeMap<String, Value>, McpRuntimeError> {
        if prompts.is_empty()
            || prompts.len() > MAX_PROMPTS
            || serde_json::to_vec(&prompts).map_or(true, |bytes| bytes.len() > MAX_REQUEST_BYTES)
        {
            return Err(error(
                "MCP_INTERACTION_LIMIT",
                "The MCP interaction exceeds its request limits.",
            ));
        }
        let mut form_schemas = BTreeMap::new();
        for prompt in &prompts {
            if prompt.id.is_empty() || form_schemas.contains_key(&prompt.id) {
                return Err(error(
                    "MCP_INTERACTION_INVALID_REQUEST",
                    "The MCP interaction contains an invalid prompt id.",
                ));
            }
            form_schemas.insert(prompt.id.clone(), FormSchema::from_prompt(&prompt.request)?);
        }
        if cancellation.is_cancelled() {
            return Err(error(
                "MCP_RUNTIME_OPERATION_CANCELLED",
                "MCP tool call was cancelled.",
            ));
        }
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        let (channel, lease_id) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let port = state.port.as_ref().ok_or_else(|| {
                error(
                    "MCP_INTERACTION_NO_HOST",
                    "No MCP interaction host is connected.",
                )
            })?;
            let lease_id = port.lease_id.clone();
            let channel = port.channel.clone();
            if state.pending.len() >= MAX_PENDING {
                return Err(error(
                    "MCP_INTERACTION_LIMIT",
                    "Too many MCP interactions are pending.",
                ));
            }
            state.pending.insert(
                request_id.clone(),
                Pending {
                    lease_id: lease_id.clone(),
                    key: key.clone(),
                    operation_id: operation_id.clone(),
                    form_schemas,
                    sender,
                },
            );
            (channel, lease_id)
        };
        let _pending_guard = PendingGuard {
            broker: self.clone(),
            request_id: request_id.clone(),
        };
        let expires_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .saturating_add(response_timeout.as_millis())
            .min(u64::MAX as u128) as u64;
        let request = McpInteractionRequest {
            request_id: request_id.clone(),
            key,
            operation_id,
            expires_at_ms,
            prompts,
        };
        if channel.send(request).is_err() {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state
                .port
                .as_ref()
                .is_some_and(|port| port.lease_id == lease_id)
            {
                state.port = None;
                state.pending.clear();
            }
            return Err(error(
                "MCP_INTERACTION_HOST_CLOSED",
                "The MCP interaction host is unavailable.",
            ));
        }
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(error("MCP_RUNTIME_OPERATION_CANCELLED", "MCP tool call was cancelled.")),
            _ = tokio::time::sleep(response_timeout) => Err(error("MCP_INTERACTION_TIMEOUT", "The MCP interaction timed out.")),
            answer = receiver => answer.map_err(|_| error("MCP_INTERACTION_HOST_CLOSED", "The MCP interaction host closed.")),
        };
        result
    }

    fn remove(&self, request_id: &str) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .remove(request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::InvokeResponseBody;

    fn key(server_id: &str) -> McpRuntimeKey {
        McpRuntimeKey {
            server_id: server_id.into(),
            project_id: None,
            project_ids: vec![],
            config_generation: 1,
        }
    }

    fn prompts() -> Vec<McpElicitationPrompt> {
        ["a", "b", "c"].into_iter().map(|id| McpElicitationPrompt {
            id: id.into(), request: serde_json::json!({ "method": "elicitation/create", "params": {
                "mode": "form", "message": "Name", "requestedSchema": {
                    "type": "object", "properties": { "name": { "type": "string", "minLength": 2 } }, "required": ["name"]
                }
            } }),
        }).collect()
    }

    fn open(
        broker: &McpInteractionBroker,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<McpInteractionRequest>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            tx.send(body.deserialize().unwrap()).unwrap();
            Ok(())
        });
        (broker.open(channel).unwrap(), rx)
    }

    #[tokio::test]
    async fn no_host_fails_closed_and_answers_are_typed() {
        let broker = McpInteractionBroker::default();
        let error = broker
            .request(
                key("alpha"),
                "op".into(),
                prompts(),
                Arc::new(McpOperationCancellation::default()),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "MCP_INTERACTION_NO_HOST");
        let (lease, mut rx) = open(&broker);
        let b = broker.clone();
        let task = tokio::spawn(async move {
            b.request(
                key("alpha"),
                "op".into(),
                prompts(),
                Arc::new(McpOperationCancellation::default()),
            )
            .await
        });
        let request = rx.recv().await.unwrap();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(request.expires_at_ms > now_ms);
        assert!(request.expires_at_ms <= now_ms + RESPONSE_TIMEOUT.as_millis() as u64);
        broker
            .respond(
                &lease,
                McpInteractionResponse {
                    request_id: request.request_id,
                    key: request.key,
                    operation_id: request.operation_id,
                    answers: vec![
                        McpElicitationAnswer {
                            id: "a".into(),
                            action: McpElicitationAction::Accept,
                            content: Some(serde_json::json!({"name":"Ada"})),
                        },
                        McpElicitationAnswer {
                            id: "b".into(),
                            action: McpElicitationAction::Decline,
                            content: None,
                        },
                        McpElicitationAnswer {
                            id: "c".into(),
                            action: McpElicitationAction::Cancel,
                            content: None,
                        },
                    ],
                },
            )
            .unwrap();
        let result = task.await.unwrap().unwrap();
        assert_eq!(
            result["a"],
            serde_json::json!({"action":"accept","content":{"name":"Ada"}})
        );
        assert_eq!(result["b"], serde_json::json!({"action":"decline"}));
        assert_eq!(result["c"], serde_json::json!({"action":"cancel"}));
    }

    #[tokio::test]
    async fn hostile_accept_must_match_the_pending_form_schema() {
        let broker = McpInteractionBroker::default();
        let (lease, mut rx) = open(&broker);
        let prompt = McpElicitationPrompt {
            id: "form".into(),
            request: serde_json::json!({"method":"elicitation/create","params":{
                "message":"Profile","requestedSchema":{"type":"object","properties":{
                    "name":{"type":"string","minLength":2,"maxLength":8},
                    "age":{"type":"integer","minimum":18,"maximum":120},
                    "role":{"type":"string","enum":["reader","writer"]},
                    "verified":{"type":"boolean"},
                    "tags":{"type":"array","items":{"type":"string","enum":["a","b"]},"minItems":1,"maxItems":2}
                },"required":["name","role"]}
            }}),
        };
        let b = broker.clone();
        let task = tokio::spawn(async move {
            b.request(
                key("alpha"),
                "op".into(),
                vec![prompt],
                Arc::new(McpOperationCancellation::default()),
            )
            .await
        });
        let pending = rx.recv().await.unwrap();
        let invalid = [
            serde_json::json!({"role":"reader"}),
            serde_json::json!({"name":"A","role":"reader"}),
            serde_json::json!({"name":"Ada","role":"admin"}),
            serde_json::json!({"name":"Ada","role":"reader","age":17}),
            serde_json::json!({"name":"Ada","role":"reader","tags":["c"]}),
            serde_json::json!({"name":"Ada","role":"reader","verified":"yes"}),
            serde_json::json!({"name":"Ada","role":"reader","extra":"leak"}),
        ];
        for content in invalid {
            let response: McpInteractionResponse = serde_json::from_value(serde_json::json!({
                "requestId": pending.request_id, "key": pending.key, "operationId": pending.operation_id,
                "answers": [{"id":"form","action":"accept","content":content}]
            })).unwrap();
            assert_eq!(
                broker.respond(&lease, response).unwrap_err().code,
                "MCP_INTERACTION_INVALID_RESPONSE"
            );
            assert!(!task.is_finished());
        }
        broker.respond(&lease, McpInteractionResponse {
            request_id: pending.request_id,
            key: pending.key,
            operation_id: pending.operation_id,
            answers: vec![McpElicitationAnswer {
                id: "form".into(), action: McpElicitationAction::Accept,
                content: Some(serde_json::json!({"name":"Ada","role":"writer","age":25.0,"verified":true,"tags":["a","b"]})),
            }],
        }).unwrap();
        let answers = task.await.unwrap().unwrap();
        assert_eq!(answers["form"]["action"], "accept");
        assert_eq!(answers["form"]["content"]["name"], "Ada");
    }

    #[tokio::test]
    async fn invalid_form_schema_is_rejected_before_handoff() {
        let broker = McpInteractionBroker::default();
        for schema in [
            serde_json::json!({"type":"object","properties":{"nested":{"type":"object"}}}),
            serde_json::json!({"type":"object","properties":{"name":{"type":"string"}},"required":["missing"]}),
            serde_json::json!({"type":"object","properties":{"name":{"type":"string","pattern":".*"}}}),
        ] {
            let error = broker.request(key("alpha"), "op".into(), vec![McpElicitationPrompt {
                id: "form".into(), request: serde_json::json!({"method":"elicitation/create","params":{"message":"Invalid","requestedSchema":schema}})
            }], Arc::new(McpOperationCancellation::default())).await.unwrap_err();
            assert_eq!(error.code, "MCP_INTERACTION_INVALID_REQUEST");
        }
    }

    #[tokio::test]
    async fn wrong_server_or_call_cannot_resolve_a_request() {
        let broker = McpInteractionBroker::default();
        let (lease, mut rx) = open(&broker);
        let b = broker.clone();
        let task = tokio::spawn(async move {
            b.request(
                key("alpha"),
                "op".into(),
                prompts(),
                Arc::new(McpOperationCancellation::default()),
            )
            .await
        });
        let request = rx.recv().await.unwrap();
        for (wrong_key, wrong_op) in [(key("beta"), "op"), (key("alpha"), "other")] {
            let error = broker
                .respond(
                    &lease,
                    McpInteractionResponse {
                        request_id: request.request_id.clone(),
                        key: wrong_key,
                        operation_id: wrong_op.into(),
                        answers: vec![],
                    },
                )
                .unwrap_err();
            assert_eq!(error.code, "MCP_INTERACTION_MISMATCH");
            assert!(!task.is_finished());
        }
        broker.close(&lease).unwrap();
        assert_eq!(
            task.await.unwrap().unwrap_err().code,
            "MCP_INTERACTION_HOST_CLOSED"
        );
        broker.shutdown();
        assert_eq!(
            broker
                .open(Channel::new(|_body: InvokeResponseBody| Ok(())))
                .unwrap_err()
                .code,
            "MCP_INTERACTION_HOST_CLOSED"
        );
    }

    #[tokio::test]
    async fn dropped_operation_cannot_leave_a_pending_interaction() {
        let broker = McpInteractionBroker::default();
        let (lease, mut rx) = open(&broker);
        let b = broker.clone();
        let task = tokio::spawn(async move {
            b.request(
                key("alpha"),
                "aborted".into(),
                prompts(),
                Arc::new(McpOperationCancellation::default()),
            )
            .await
        });
        let pending = rx.recv().await.unwrap();
        task.abort();
        assert!(task.await.is_err());
        assert_eq!(
            broker
                .respond(
                    &lease,
                    McpInteractionResponse {
                        request_id: pending.request_id,
                        key: pending.key,
                        operation_id: pending.operation_id,
                        answers: vec![],
                    }
                )
                .unwrap_err()
                .code,
            "MCP_INTERACTION_STALE"
        );
    }

    #[tokio::test]
    async fn timeout_and_operation_cancellation_remove_pending_requests() {
        let broker = McpInteractionBroker::default();
        let (lease, mut rx) = open(&broker);
        let error = broker
            .request_with_timeout(
                key("alpha"),
                "timeout".into(),
                prompts(),
                Arc::new(McpOperationCancellation::default()),
                Duration::from_millis(1),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "MCP_INTERACTION_TIMEOUT");
        let expired = rx.recv().await.unwrap();
        assert_eq!(
            broker
                .respond(
                    &lease,
                    McpInteractionResponse {
                        request_id: expired.request_id,
                        key: expired.key,
                        operation_id: expired.operation_id,
                        answers: vec![]
                    }
                )
                .unwrap_err()
                .code,
            "MCP_INTERACTION_STALE"
        );
        let cancellation = Arc::new(McpOperationCancellation::default());
        let b = broker.clone();
        let c = cancellation.clone();
        let task =
            tokio::spawn(
                async move { b.request(key("alpha"), "cancel".into(), prompts(), c).await },
            );
        let pending = rx.recv().await.unwrap();
        cancellation.cancel();
        assert_eq!(
            task.await.unwrap().unwrap_err().code,
            "MCP_RUNTIME_OPERATION_CANCELLED"
        );
        assert_eq!(
            broker
                .respond(
                    &lease,
                    McpInteractionResponse {
                        request_id: pending.request_id,
                        key: pending.key,
                        operation_id: pending.operation_id,
                        answers: vec![]
                    }
                )
                .unwrap_err()
                .code,
            "MCP_INTERACTION_STALE"
        );
    }
}
