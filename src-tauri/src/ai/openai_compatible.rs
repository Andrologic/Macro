use super::chatgpt::types::{
    AiChatMessageContent, AiChatRequest, AiStreamChunkEvent, AiStreamDoneEvent, AiStreamErrorEvent,
    AiToolCall, AiToolCallFunction,
};
use crate::ai::provider_capabilities::resolve_provider_capabilities;
use crate::ai::{emit_timeline, AiState, ProviderTimeline};
use crate::db::models::ProviderConfig;
use crate::db::repository;
use crate::secrets;
use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{Map, Value};
use sqlx::SqlitePool;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, timeout};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_RETRY_ATTEMPTS: usize = 2;

#[derive(Debug, Default)]
struct ChatCompletionAccumulator {
    output_text: String,
    reasoning_summary: String,
    tool_calls: Vec<AiToolCall>,
    is_reasoning: bool,
}

pub async fn stream_chat(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request: AiChatRequest,
) -> Result<(), String> {
    super::chatgpt::cancel_stream(&ai_state, &request.request_id).await?;

    let request_id = request.request_id.clone();
    let task_request_id = request.request_id.clone();
    let task_provider_id = request.provider_id.clone();
    let app_for_task = app_handle.clone();
    let state_for_task = ai_state.clone();
    let task_started_at = Instant::now();

    let handle = tokio::spawn(async move {
        let result = stream_chat_inner(app_for_task.clone(), pool, request).await;
        if let Err(message) = result {
            emit_timeline(
                &app_for_task,
                &task_request_id,
                &task_provider_id,
                "openai_compatible",
                task_started_at,
                "error",
            );
            let _ = app_for_task.emit(
                "ai:error",
                AiStreamErrorEvent {
                    request_id: task_request_id.clone(),
                    message,
                },
            );
        }

        let mut tasks = state_for_task.stream_tasks.lock().await;
        tasks.remove(&task_request_id);
    });

    let mut tasks = ai_state.stream_tasks.lock().await;
    tasks.insert(request_id, handle);
    Ok(())
}

async fn stream_chat_inner(
    app_handle: AppHandle,
    pool: SqlitePool,
    request: AiChatRequest,
) -> Result<(), String> {
    let started_at = Instant::now();
    let provider = repository::get_provider_config(&pool, &request.provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {} not found.", request.provider_id))?;
    let provider_type = provider.provider_type.clone();
    let capabilities = resolve_provider_capabilities(
        &request.provider_id,
        &provider_type,
        Some(&provider.base_url),
    );
    if capabilities.provider_id == "opencode-go" {
        tracing::debug!(
            provider_id = %request.provider_id,
            provider_type = %provider_type,
            operation = "opencode_http_probe",
            http_only = capabilities.http_only,
            uses_local_runtime = capabilities.uses_local_runtime,
            supports_model_scan = capabilities.supports_model_scan,
            "resolved OpenCode provider capabilities"
        );
    }
    let timeline = ProviderTimeline::new(
        &app_handle,
        &request.request_id,
        &request.provider_id,
        &provider_type,
        started_at,
    );
    timeline.emit("backend_task_started");
    let secret_started_at = Instant::now();
    let api_key = secrets::get_api_key(&request.provider_id)
        .map_err(|error| format!("Failed to read provider API key: {}", error))?
        .unwrap_or_default();
    if secret_started_at.elapsed().as_millis() > 50 {
        timeline.emit("auth_ready");
    }
    let body = build_chat_completions_request(&request, &provider)?;
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    timeline.emit("provider_request_sent");
    let response =
        send_chat_completions_request(&client, &provider, &request, &api_key, &body).await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(extract_provider_error(status.as_u16(), &body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut accumulator = ChatCompletionAccumulator::default();
    let mut emitted_first_provider_event = false;
    let mut emitted_first_token = false;

    loop {
        let chunk = match timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                return Err(format!(
                    "Provider stream was idle for more than {} seconds.",
                    STREAM_IDLE_TIMEOUT.as_secs()
                ))
            }
        };
        let chunk = chunk.map_err(|error| format!("Failed to read provider stream: {}", error))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);
        if buffer.contains("\r\n") {
            buffer = buffer.replace("\r\n", "\n");
        }

        while let Some(split_index) = buffer.find("\n\n") {
            let event = buffer[..split_index].to_string();
            buffer = buffer[split_index + 2..].to_string();
            if !emitted_first_provider_event {
                emitted_first_provider_event = true;
                timeline.emit("first_provider_event");
            }
            process_sse_event(
                &app_handle,
                &request,
                &provider_type,
                started_at,
                &mut emitted_first_token,
                &event,
                &mut accumulator,
            )?;
        }
    }

    if !buffer.trim().is_empty() {
        if !emitted_first_provider_event {
            timeline.emit("first_provider_event");
        }
        process_sse_event(
            &app_handle,
            &request,
            &provider_type,
            started_at,
            &mut emitted_first_token,
            &buffer,
            &mut accumulator,
        )?;
    }
    if accumulator.is_reasoning {
        emit_delta(
            &app_handle,
            &request.request_id,
            "</think>",
            &mut accumulator,
        )?;
        accumulator.is_reasoning = false;
    }

    timeline.emit("done");
    app_handle
        .emit(
            "ai:done",
            AiStreamDoneEvent {
                request_id: request.request_id.clone(),
                output_text: accumulator.output_text,
                tool_calls: normalize_tool_calls(accumulator.tool_calls),
                response_id: None,
                output_items: None,
                provider_input_items: None,
                provider_turn_state: None,
                reasoning_summary: optional_text(accumulator.reasoning_summary),
                tool_traces: None,
                hidden_context: None,
            },
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn build_chat_completions_request(
    request: &AiChatRequest,
    provider: &ProviderConfig,
) -> Result<Value, String> {
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(request.model_id.clone()));
    body.insert(
        "messages".to_string(),
        Value::Array(serialize_messages(request)?),
    );
    body.insert("stream".to_string(), Value::Bool(true));

    if !request.tools.is_empty() {
        body.insert("tools".to_string(), Value::Array(request.tools.clone()));
        body.insert(
            "tool_choice".to_string(),
            Value::String(
                request
                    .tool_choice
                    .clone()
                    .unwrap_or_else(|| "auto".to_string()),
            ),
        );
        body.insert(
            "parallel_tool_calls".to_string(),
            Value::Bool(request.parallel_tool_calls.unwrap_or(false)),
        );
    }

    if let Some(reasoning_effort) = request.reasoning_effort.as_deref().map(str::trim) {
        if !reasoning_effort.is_empty() && supports_reasoning_effort(&provider.provider_type) {
            if provider.provider_type.eq_ignore_ascii_case("openrouter") {
                body.insert(
                    "reasoning".to_string(),
                    serde_json::json!({ "effort": reasoning_effort }),
                );
                body.insert("include_reasoning".to_string(), Value::Bool(true));
            } else {
                body.insert(
                    "reasoning_effort".to_string(),
                    Value::String(reasoning_effort.to_string()),
                );
            }
        }
    }

    Ok(Value::Object(body))
}

fn serialize_messages(request: &AiChatRequest) -> Result<Vec<Value>, String> {
    let mut messages = Vec::new();
    for message in &request.messages {
        let mut serialized = Map::new();
        serialized.insert("role".to_string(), Value::String(message.role.clone()));
        serialized.insert(
            "content".to_string(),
            serialize_message_content(&message.content)?,
        );
        if !message.tool_calls.is_empty() {
            serialized.insert(
                "tool_calls".to_string(),
                serde_json::to_value(&message.tool_calls).map_err(|error| error.to_string())?,
            );
        }
        if let Some(tool_call_id) = message.tool_call_id.as_ref() {
            serialized.insert(
                "tool_call_id".to_string(),
                Value::String(tool_call_id.clone()),
            );
        }
        messages.push(Value::Object(serialized));
    }
    Ok(messages)
}

fn serialize_message_content(content: &AiChatMessageContent) -> Result<Value, String> {
    serde_json::to_value(content).map_err(|error| error.to_string())
}

async fn send_chat_completions_request(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    request: &AiChatRequest,
    api_key: &str,
    body: &Value,
) -> Result<reqwest::Response, String> {
    let url = format!(
        "{}/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let mut builder = client
        .post(&url)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "text/event-stream")
        .header("x-client-request-id", request.request_id.clone())
        .json(body);

    if !api_key.trim().is_empty() {
        builder = builder.header(AUTHORIZATION, format!("Bearer {}", api_key.trim()));
    }
    if provider.provider_type.eq_ignore_ascii_case("openrouter") {
        builder = builder
            .header("HTTP-Referer", "https://macro.local")
            .header("X-Title", "Macro");
    }

    let mut last_error = None;
    for attempt in 0..REQUEST_RETRY_ATTEMPTS {
        let Some(cloned_builder) = builder.try_clone() else {
            break;
        };
        match cloned_builder.send().await {
            Ok(response) => return Ok(response),
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt + 1 < REQUEST_RETRY_ATTEMPTS {
                    sleep(Duration::from_millis(250)).await;
                }
            }
        }
    }

    builder.send().await.map_err(|error| {
        let previous = last_error
            .map(|message| format!(" Last retryable error: {}", message))
            .unwrap_or_default();
        format!("Failed to send provider request: {}{}", error, previous)
    })
}

fn process_sse_event(
    app_handle: &AppHandle,
    request: &AiChatRequest,
    provider_type: &str,
    started_at: Instant,
    emitted_first_token: &mut bool,
    raw_event: &str,
    accumulator: &mut ChatCompletionAccumulator,
) -> Result<(), String> {
    let Some(data) = extract_sse_data(raw_event) else {
        return Ok(());
    };
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }

    let value: Value = serde_json::from_str(data)
        .map_err(|error| format!("Invalid provider SSE payload: {}", error))?;
    let Some(choice) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return Ok(());
    };

    let delta = choice.get("delta").unwrap_or(&Value::Null);
    let message = choice.get("message").unwrap_or(&Value::Null);
    if let Some(reasoning) = delta
        .get("reasoning")
        .or_else(|| delta.get("reasoning_content"))
        .and_then(Value::as_str)
    {
        if !reasoning.is_empty() {
            accumulator.reasoning_summary.push_str(reasoning);
            if !accumulator.is_reasoning {
                emit_delta(app_handle, &request.request_id, "<think>", accumulator)?;
                accumulator.is_reasoning = true;
            }
            emit_delta(app_handle, &request.request_id, reasoning, accumulator)?;
        }
    }

    if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
        merge_tool_call_deltas(&mut accumulator.tool_calls, tool_calls);
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        merge_tool_call_deltas(&mut accumulator.tool_calls, tool_calls);
    }

    let mut emitted_content_delta = false;
    if let Some(content) = delta.get("content").and_then(Value::as_str) {
        if !content.is_empty() {
            if accumulator.is_reasoning {
                emit_delta(app_handle, &request.request_id, "</think>", accumulator)?;
                accumulator.is_reasoning = false;
            }
            emit_first_token_timeline(
                app_handle,
                request,
                provider_type,
                started_at,
                emitted_first_token,
            );
            emit_delta(app_handle, &request.request_id, content, accumulator)?;
            emitted_content_delta = true;
        }
    }

    if !emitted_content_delta {
        if let Some(content) = message.get("content").and_then(Value::as_str) {
            if !content.is_empty() {
                if accumulator.is_reasoning {
                    emit_delta(app_handle, &request.request_id, "</think>", accumulator)?;
                    accumulator.is_reasoning = false;
                }
                emit_first_token_timeline(
                    app_handle,
                    request,
                    provider_type,
                    started_at,
                    emitted_first_token,
                );
                emit_delta(app_handle, &request.request_id, content, accumulator)?;
            }
        }
    }

    Ok(())
}

fn emit_first_token_timeline(
    app_handle: &AppHandle,
    request: &AiChatRequest,
    provider_type: &str,
    started_at: Instant,
    emitted_first_token: &mut bool,
) {
    if *emitted_first_token {
        return;
    }
    *emitted_first_token = true;
    emit_timeline(
        app_handle,
        &request.request_id,
        &request.provider_id,
        provider_type,
        started_at,
        "first_token",
    );
}

fn extract_sse_data(raw_event: &str) -> Option<String> {
    let data_lines = raw_event
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            line.strip_prefix("data:")
                .map(|data| data.trim_start().to_string())
        })
        .collect::<Vec<_>>();
    if data_lines.is_empty() {
        None
    } else {
        Some(data_lines.join("\n"))
    }
}

fn merge_tool_call_deltas(tool_calls: &mut Vec<AiToolCall>, deltas: &[Value]) {
    for delta in deltas {
        let index = delta.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        while tool_calls.len() <= index {
            tool_calls.push(AiToolCall {
                id: String::new(),
                kind: "function".to_string(),
                function: AiToolCallFunction {
                    name: String::new(),
                    arguments: String::new(),
                },
            });
        }
        let tool_call = &mut tool_calls[index];
        if let Some(id) = delta.get("id").and_then(Value::as_str) {
            tool_call.id = id.to_string();
        }
        if let Some(kind) = delta.get("type").and_then(Value::as_str) {
            tool_call.kind = kind.to_string();
        }
        if let Some(function) = delta.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                tool_call.function.name = name.to_string();
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                tool_call.function.arguments.push_str(arguments);
            }
        }
    }
}

fn normalize_tool_calls(tool_calls: Vec<AiToolCall>) -> Vec<AiToolCall> {
    tool_calls
        .into_iter()
        .enumerate()
        .filter_map(|(index, mut tool_call)| {
            if tool_call.function.name.trim().is_empty() {
                return None;
            }
            if tool_call.id.trim().is_empty() {
                tool_call.id = format!("call_{}", index + 1);
            }
            if tool_call.kind.trim().is_empty() {
                tool_call.kind = "function".to_string();
            }
            Some(tool_call)
        })
        .collect()
}

fn emit_delta(
    app_handle: &AppHandle,
    request_id: &str,
    delta: &str,
    accumulator: &mut ChatCompletionAccumulator,
) -> Result<(), String> {
    accumulator.output_text.push_str(delta);
    app_handle
        .emit(
            "ai:stream",
            AiStreamChunkEvent {
                request_id: request_id.to_string(),
                delta: delta.to_string(),
            },
        )
        .map_err(|error| error.to_string())
}

fn extract_provider_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return format!("Provider error {}: {}", status, message);
        }
    }
    format!("Provider error {}: {}", status, body.trim())
}

fn optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn supports_reasoning_effort(provider_type: &str) -> bool {
    provider_type.eq_ignore_ascii_case("openai") || provider_type.eq_ignore_ascii_case("openrouter")
}

#[cfg(test)]
mod tests {
    use super::super::chatgpt::types::AiChatMessage;
    use super::*;

    fn request(reasoning_effort: Option<&str>) -> AiChatRequest {
        AiChatRequest {
            request_id: "req-1".to_string(),
            provider_id: "provider-1".to_string(),
            model_id: "model-1".to_string(),
            reasoning_effort: reasoning_effort.map(str::to_string),
            conversation_id: None,
            messages: vec![AiChatMessage {
                role: "user".to_string(),
                content: AiChatMessageContent::Text("hello".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: None,
            }],
            tools: Vec::new(),
            tool_choice: None,
            parallel_tool_calls: None,
            workspace_path: None,
            default_workspace_path: None,
            project_mounts: Vec::new(),
            virtual_root_enabled: None,
            focused_project_id: None,
            allowed_tool_ids: Vec::new(),
            copilot_send_timeout_ms: None,
        }
    }

    fn provider(provider_type: &str) -> ProviderConfig {
        ProviderConfig {
            id: "provider-1".to_string(),
            name: "Provider".to_string(),
            provider_type: provider_type.to_string(),
            base_url: "https://example.test/v1".to_string(),
            api_key: None,
            has_stored_api_key: false,
            is_enabled: true,
            is_local: false,
            auth_status: None,
            auth_source: None,
            plan_type: None,
            account_label: None,
            token_expires_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn openrouter_reasoning_payload_matches_provider_contract() {
        let body =
            build_chat_completions_request(&request(Some("medium")), &provider("openrouter"))
                .expect("body");

        assert_eq!(body.get("reasoning_effort"), None);
        assert_eq!(
            body.pointer("/reasoning/effort").and_then(Value::as_str),
            Some("medium")
        );
        assert_eq!(
            body.get("include_reasoning").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn openai_reasoning_payload_keeps_reasoning_effort() {
        let body = build_chat_completions_request(&request(Some("high")), &provider("openai"))
            .expect("body");

        assert_eq!(
            body.get("reasoning_effort").and_then(Value::as_str),
            Some("high")
        );
        assert_eq!(body.get("reasoning"), None);
    }

    #[test]
    fn sse_data_supports_multi_line_events_and_done() {
        let event = "event: message\ndata: {\"a\":1,\ndata: \"b\":2}\n\n";

        assert_eq!(
            extract_sse_data(event),
            Some("{\"a\":1,\n\"b\":2}".to_string())
        );
        assert_eq!(
            extract_sse_data("data: [DONE]\n"),
            Some("[DONE]".to_string())
        );
    }

    #[test]
    fn merge_tool_calls_assembles_chunked_arguments() {
        let mut tool_calls = Vec::new();
        merge_tool_call_deltas(
            &mut tool_calls,
            &[
                serde_json::json!({
                    "index": 0,
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "read", "arguments": "{\"path\"" }
                }),
                serde_json::json!({
                    "index": 0,
                    "function": { "arguments": ":\"src/lib.rs\"}" }
                }),
            ],
        );

        let normalized = normalize_tool_calls(tool_calls);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].function.name, "read");
        assert_eq!(
            normalized[0].function.arguments,
            "{\"path\":\"src/lib.rs\"}"
        );
    }
}
