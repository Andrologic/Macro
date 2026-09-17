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
use std::future::Future;
use std::str;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, timeout};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const RESPONSE_HEADERS_TIMEOUT: Duration = Duration::from_secs(30);
const ERROR_BODY_TIMEOUT: Duration = Duration::from_secs(10);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_RETRY_ATTEMPTS: usize = 2;
const MAX_SSE_BUFFER_BYTES: usize = 1_048_576;

#[derive(Debug, Default)]
struct ChatCompletionAccumulator {
    output_text: String,
    reasoning_summary: String,
    tool_calls: Vec<AiToolCall>,
    is_reasoning: bool,
    completion_reason: Option<String>,
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

        let task_id = tokio::task::try_id();
        let mut tasks = state_for_task.stream_tasks.lock().await;
        if task_id
            .map(|task_id| {
                tasks
                    .get(&task_request_id)
                    .map(|handle| handle.id() == task_id)
                    .unwrap_or(false)
            })
            .unwrap_or(false)
        {
            tasks.remove(&task_request_id);
        }
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
    let request_body = build_chat_completions_request(&request, &provider)?;
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    timeline.emit("provider_request_sent");
    let response =
        send_chat_completions_request(&client, &provider, &request, &api_key, &request_body)
            .await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = await_http_operation(
            response.text(),
            ERROR_BODY_TIMEOUT,
            "Provider error response body",
        )
        .await
        .map_err(|error| format!("Provider error {}: {}", status.as_u16(), error))?;
        return Err(extract_provider_error(status.as_u16(), &error_body));
    }

    let mut stream = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut accumulator = ChatCompletionAccumulator::default();
    let mut emitted_first_provider_event = false;
    let mut emitted_first_token = false;
    let mut saw_completion = false;

    'stream: loop {
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
        let is_terminal = process_sse_events_until_terminal(parser.push(&chunk)?, |event| {
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
                event,
                &mut accumulator,
            )
        })?;
        saw_completion |= is_terminal;
        if is_terminal {
            break 'stream;
        }
    }
    drop(stream);

    if !saw_completion {
        let is_terminal = process_sse_events_until_terminal(parser.finish()?, |event| {
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
                event,
                &mut accumulator,
            )
        })?;
        saw_completion |= is_terminal;
    }

    if !saw_completion {
        accumulator.completion_reason = Some("incomplete".to_string());
    }
    ensure_terminal_completion_reason(&mut accumulator.completion_reason, &accumulator.tool_calls);

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
                completion_reason: accumulator.completion_reason,
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

    if provider.id == super::macro_ai::PROVIDER_ID {
        let effort = request
            .reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("medium");
        let thinking = match effort {
            "none" => serde_json::json!({ "enable_thinking": false }),
            "low" | "medium" | "xhigh" => serde_json::json!({
                "enable_thinking": true,
                "reasoning_effort": effort,
            }),
            _ => return Err(format!("Unsupported Macro AI reasoning effort: {effort}")),
        };
        body.insert("chat_template_kwargs".to_string(), thinking);
    } else if let Some(reasoning_effort) = request.reasoning_effort.as_deref().map(str::trim) {
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
    let mut system_contents = Vec::new();
    let mut messages = Vec::new();
    for message in &request.messages {
        if message.role == "system" {
            let content = message_content_to_plain_text(&message.content);
            let content = content.trim();
            if !content.is_empty() {
                system_contents.push(content.to_string());
            }
            continue;
        }

        if let Some(provider_items) = serialize_provider_input_items(message)? {
            messages.extend(provider_items);
            continue;
        }

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

    if !system_contents.is_empty() {
        messages.insert(
            0,
            serde_json::json!({
                "role": "system",
                "content": system_contents.join("\n\n"),
            }),
        );
    }
    Ok(messages)
}

fn message_content_to_plain_text(content: &AiChatMessageContent) -> String {
    match content {
        AiChatMessageContent::Text(text) => text.clone(),
        AiChatMessageContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| part.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn serialize_provider_input_items(
    message: &super::chatgpt::types::AiChatMessage,
) -> Result<Option<Vec<Value>>, String> {
    let Some(items) = message
        .provider_input_items
        .as_ref()
        .filter(|items| !items.is_empty())
    else {
        return Ok(None);
    };

    let mut serialized = Vec::new();
    for item in items {
        match item.get("type").and_then(Value::as_str).unwrap_or_default() {
            "chat_completion_message" => {
                if let Some(message) = serialize_chat_completion_provider_item(item) {
                    serialized.push(message);
                }
            }
            "message" => {
                let role = item
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("assistant");
                if role != "assistant" && role != "user" {
                    continue;
                }
                serialized.push(serde_json::json!({
                    "role": role,
                    "content": responses_message_content_to_text(item.get("content")),
                }));
            }
            "function_call" => append_responses_function_call(&mut serialized, item)?,
            "function_call_output" => {
                let Some(call_id) = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                serialized.push(serde_json::json!({
                    "role": "tool",
                    "content": item.get("output").cloned().unwrap_or(Value::String(String::new())),
                    "tool_call_id": call_id,
                }));
            }
            _ => {}
        }
    }

    Ok((!serialized.is_empty()).then_some(serialized))
}

fn serialize_chat_completion_provider_item(item: &Value) -> Option<Value> {
    let role = item.get("role").and_then(Value::as_str)?;
    if role != "assistant" && role != "tool" {
        return None;
    }

    let mut output = Map::new();
    output.insert("role".to_string(), Value::String(role.to_string()));
    output.insert(
        "content".to_string(),
        item.get("content").cloned().unwrap_or(Value::Null),
    );

    if role == "assistant" {
        for key in [
            "tool_calls",
            "reasoning_content",
            "reasoning_details",
            "reasoning",
        ] {
            if let Some(value) = item.get(key) {
                output.insert(key.to_string(), value.clone());
            }
        }
    } else {
        let tool_call_id = item
            .get("tool_call_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        output.insert(
            "tool_call_id".to_string(),
            Value::String(tool_call_id.to_string()),
        );
        if let Some(name) = item
            .get("tool_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            output.insert("name".to_string(), Value::String(name.to_string()));
        }
    }

    Some(Value::Object(output))
}

fn append_responses_function_call(messages: &mut Vec<Value>, item: &Value) -> Result<(), String> {
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Persisted function call is missing call_id.".to_string())?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Persisted function call is missing name.".to_string())?;
    let tool_call = serde_json::json!({
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": item.get("arguments").and_then(Value::as_str).unwrap_or("{}"),
        },
    });

    let can_append = messages
        .last()
        .and_then(Value::as_object)
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        == Some("assistant");
    if !can_append {
        messages.push(serde_json::json!({ "role": "assistant", "content": null }));
    }
    let message = messages
        .last_mut()
        .and_then(Value::as_object_mut)
        .expect("assistant message was just inserted");
    let tool_calls = message
        .entry("tool_calls".to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "Persisted assistant tool_calls is not an array.".to_string())?;
    tool_calls.push(tool_call);
    Ok(())
}

fn responses_message_content_to_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            let kind = part.get("type").and_then(Value::as_str)?;
            if kind != "output_text" && kind != "text" {
                return None;
            }
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.get("value").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("")
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
    if provider.id == super::macro_ai::PROVIDER_ID {
        if let Some(conversation_id) = request
            .conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            builder = builder.header("X-Macro-Conversation-Id", conversation_id);
        }
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
        match await_http_operation(
            cloned_builder.send(),
            RESPONSE_HEADERS_TIMEOUT,
            "Provider response headers",
        )
        .await
        {
            Ok(response) => return Ok(response),
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < REQUEST_RETRY_ATTEMPTS {
                    sleep(Duration::from_millis(250)).await;
                }
            }
        }
    }

    await_http_operation(
        builder.send(),
        RESPONSE_HEADERS_TIMEOUT,
        "Provider response headers",
    )
    .await
    .map_err(|error| {
        let previous = last_error
            .map(|message| format!(" Last retryable error: {}", message))
            .unwrap_or_default();
        format!("Failed to send provider request: {}{}", error, previous)
    })
}

async fn await_http_operation<T, F>(
    future: F,
    deadline: Duration,
    operation: &str,
) -> Result<T, String>
where
    F: Future<Output = Result<T, reqwest::Error>>,
{
    match timeout(deadline, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(format!("{} failed: {}", operation, error)),
        Err(_) => Err(format!(
            "{} timed out after {} seconds.",
            operation,
            deadline.as_secs()
        )),
    }
}

fn process_sse_event(
    app_handle: &AppHandle,
    request: &AiChatRequest,
    provider_type: &str,
    started_at: Instant,
    emitted_first_token: &mut bool,
    raw_event: &str,
    accumulator: &mut ChatCompletionAccumulator,
) -> Result<bool, String> {
    let Some(data) = extract_sse_data(raw_event) else {
        return Ok(false);
    };
    let data = data.trim();
    if data.is_empty() {
        return Ok(false);
    }
    if data == "[DONE]" {
        ensure_terminal_completion_reason(
            &mut accumulator.completion_reason,
            &accumulator.tool_calls,
        );
        return Ok(true);
    }

    let value: Value = serde_json::from_str(data)
        .map_err(|error| format!("Invalid provider SSE payload: {}", error))?;
    if let Some(error) = extract_sse_provider_error(&value) {
        return Err(error);
    }
    let Some(choice) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return Ok(is_terminal_sse_value(&value));
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

    if let Some(finish_reason) = choice.get("finish_reason").and_then(Value::as_str) {
        accumulator.completion_reason = Some(normalize_finish_reason(finish_reason).to_string());
    }

    Ok(is_terminal_sse_value(&value))
}

fn process_sse_events_until_terminal<F>(events: Vec<String>, mut process: F) -> Result<bool, String>
where
    F: FnMut(&str) -> Result<bool, String>,
{
    for event in events {
        if process(&event)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn extract_sse_provider_error(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    if error.is_null() {
        return None;
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or("Provider stream returned an unspecified error.");
    let mut details = Vec::new();
    for (label, key) in [("code", "code"), ("type", "type"), ("status", "status")] {
        if let Some(value) = error.get(key).or_else(|| payload.get(key)) {
            let rendered = value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string());
            if !rendered.trim().is_empty() {
                details.push(format!("{}: {}", label, rendered));
            }
        }
    }
    let suffix = if details.is_empty() {
        String::new()
    } else {
        format!(" ({})", details.join(", "))
    };
    Some(format!("Provider stream error: {}{}", message, suffix))
}

fn normalize_finish_reason(finish_reason: &str) -> &str {
    match finish_reason {
        "length" | "max_tokens" | "max_output_tokens" => "length",
        "stop" | "tool_calls" | "function_call" => "completed",
        "" => "incomplete",
        other => other,
    }
}

fn ensure_terminal_completion_reason(
    completion_reason: &mut Option<String>,
    tool_calls: &[AiToolCall],
) {
    if completion_reason.is_none() {
        let has_complete_tool_batch = !tool_calls.is_empty()
            && tool_calls.iter().all(|tool_call| {
                !tool_call.id.trim().is_empty()
                    && !tool_call.function.name.trim().is_empty()
                    && serde_json::from_str::<Value>(&tool_call.function.arguments).is_ok()
            });
        *completion_reason = Some(
            if has_complete_tool_batch {
                "completed"
            } else {
                "incomplete"
            }
            .to_string(),
        );
    }
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
        .split('\n')
        .filter_map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let data = line.strip_prefix("data:")?;
            Some(data.strip_prefix(' ').unwrap_or(data).to_string())
        })
        .collect::<Vec<_>>();
    if data_lines.is_empty() {
        None
    } else {
        Some(data_lines.join("\n"))
    }
}

fn is_terminal_sse_value(value: &Value) -> bool {
    value.get("done").and_then(Value::as_bool) == Some(true)
}

#[derive(Debug, Default)]
struct SseParser {
    input: String,
    event: String,
    utf8_tail: Vec<u8>,
}

impl SseParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.append_utf8(chunk)?;
        Ok(self.drain_events(false))
    }

    fn finish(&mut self) -> Result<Vec<String>, String> {
        if !self.utf8_tail.is_empty() {
            return Err("Provider stream ended with invalid UTF-8.".to_string());
        }

        Ok(self.drain_events(true))
    }

    fn append_utf8(&mut self, chunk: &[u8]) -> Result<(), String> {
        let mut bytes = std::mem::take(&mut self.utf8_tail);
        bytes.extend_from_slice(chunk);

        match str::from_utf8(&bytes) {
            Ok(text) => self.input.push_str(text),
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                self.input.push_str(
                    str::from_utf8(&bytes[..valid_up_to])
                        .expect("valid UTF-8 prefix should decode"),
                );
                if error.error_len().is_some() {
                    return Err("Provider stream contained invalid UTF-8.".to_string());
                }
                self.utf8_tail.extend_from_slice(&bytes[valid_up_to..]);
            }
        }

        if self.input.len() + self.event.len() + self.utf8_tail.len() > MAX_SSE_BUFFER_BYTES {
            return Err("Provider SSE buffer exceeded the 1048576-byte limit.".to_string());
        }

        Ok(())
    }

    fn drain_events(&mut self, flush: bool) -> Vec<String> {
        let mut events = Vec::new();
        loop {
            let Some((line_end, terminator_len)) = self.find_line_end(flush) else {
                break;
            };
            let line = self.input[..line_end].to_string();
            self.input.drain(..line_end + terminator_len);
            if line.is_empty() {
                self.dispatch_event(&mut events);
            } else {
                self.append_line(&line);
            }
        }

        if flush {
            if !self.input.is_empty() {
                let line = std::mem::take(&mut self.input);
                self.append_line(&line);
            }
            self.dispatch_event(&mut events);
        }

        events
    }

    fn find_line_end(&self, flush: bool) -> Option<(usize, usize)> {
        let bytes = self.input.as_bytes();
        for index in 0..bytes.len() {
            match bytes[index] {
                b'\n' => return Some((index, 1)),
                b'\r' => {
                    if index + 1 == bytes.len() && !flush {
                        return None;
                    }
                    let terminator_len =
                        usize::from(index + 1 < bytes.len() && bytes[index + 1] == b'\n') + 1;
                    return Some((index, terminator_len));
                }
                _ => {}
            }
        }
        None
    }

    fn append_line(&mut self, line: &str) {
        if !self.event.is_empty() {
            self.event.push('\n');
        }
        self.event.push_str(line);
    }

    fn dispatch_event(&mut self, events: &mut Vec<String>) {
        if !self.event.is_empty() {
            events.push(std::mem::take(&mut self.event));
        }
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
    provider_type.eq_ignore_ascii_case("openai")
        || provider_type.eq_ignore_ascii_case("openrouter")
        || provider_type.eq_ignore_ascii_case("ollama")
        || provider_type.eq_ignore_ascii_case("lmstudio")
}

#[cfg(test)]
mod tests {
    use super::super::chatgpt::types::AiChatMessage;
    use super::*;
    use std::future::pending;

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
            base_url: "https://provider.invalid/v1".to_string(),
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

    fn message(role: &str, content: &str) -> AiChatMessage {
        AiChatMessage {
            role: role.to_string(),
            content: AiChatMessageContent::Text(content.to_string()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            provider_input_items: None,
            provider_turn_state: None,
        }
    }

    #[test]
    fn native_messages_merge_all_system_instructions_at_the_front() {
        let mut request = request(None);
        request.messages = vec![
            message("system", "Initial policy"),
            message("user", "Question"),
            message("system", "Recovery policy"),
            message("assistant", "Answer"),
        ];

        let messages = serialize_messages(&request).expect("messages");

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "Initial policy\n\nRecovery policy");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["role"], "assistant");
    }

    #[test]
    fn native_messages_restore_persisted_tool_calls_and_results_in_order() {
        let mut historical = message("assistant", "Read complete.");
        historical.provider_input_items = Some(vec![
            serde_json::json!({
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Read complete." }]
            }),
            serde_json::json!({
                "type": "function_call",
                "call_id": "call_read_1",
                "name": "read",
                "arguments": "{\"path\":\"value.txt\"}"
            }),
            serde_json::json!({
                "type": "function_call_output",
                "call_id": "call_read_1",
                "output": "314159"
            }),
        ]);
        let mut request = request(None);
        request.messages = vec![historical, message("user", "What was the value?")];

        let messages = serialize_messages(&request).expect("messages");

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["tool_calls"][0]["id"], "call_read_1");
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "call_read_1");
        assert_eq!(messages[1]["content"], "314159");
        assert_eq!(messages[2]["role"], "user");
    }

    #[test]
    fn structured_sse_errors_keep_provider_diagnostics() {
        assert!(extract_sse_provider_error(&serde_json::json!({
            "error": null,
            "choices": [{ "delta": { "content": "still valid" } }]
        }))
        .is_none());

        let error = extract_sse_provider_error(&serde_json::json!({
            "error": {
                "message": "upstream failure",
                "code": "upstream_error",
                "type": "provider_error",
                "status": 503
            }
        }))
        .expect("structured error");

        assert!(error.contains("upstream failure"));
        assert!(error.contains("code: upstream_error"));
        assert!(error.contains("type: provider_error"));
        assert!(error.contains("status: 503"));
    }

    #[test]
    fn event_batch_stops_at_the_first_terminal_marker() {
        let mut parser = SseParser::default();
        let events = parser
            .push(b"data: token\n\ndata: [DONE]\n\ndata: ignored\n\n")
            .expect("SSE events");
        let mut processed = Vec::new();
        let terminal = process_sse_events_until_terminal(events, |event| {
            let data = extract_sse_data(event).expect("data");
            processed.push(data.clone());
            Ok(data == "[DONE]")
        })
        .expect("event batch");

        assert!(terminal);
        assert_eq!(processed, vec!["token", "[DONE]"]);
    }

    #[tokio::test]
    async fn http_operation_deadline_covers_pending_headers_and_error_body() {
        for operation in [
            "Synthetic .invalid response headers",
            "Synthetic .invalid error body",
        ] {
            let error = await_http_operation(
                pending::<Result<(), reqwest::Error>>(),
                Duration::from_millis(1),
                operation,
            )
            .await
            .expect_err("deadline");

            assert!(error.contains("timed out"));
            assert!(error.contains(operation));
        }
    }

    #[test]
    fn macro_ai_reasoning_controls_reach_the_chat_template() {
        let mut config = provider("openai");
        config.id = super::super::macro_ai::PROVIDER_ID.into();
        for effort in [
            None,
            Some("none"),
            Some("low"),
            Some("medium"),
            Some("xhigh"),
        ] {
            let body = build_chat_completions_request(&request(effort), &config).unwrap();
            assert_eq!(body.get("reasoning_effort"), None);
            assert_eq!(
                body["chat_template_kwargs"]["enable_thinking"],
                effort != Some("none")
            );
            if effort != Some("none") {
                assert_eq!(
                    body["chat_template_kwargs"]["reasoning_effort"],
                    effort.unwrap_or("medium")
                );
            } else {
                assert!(body["chat_template_kwargs"]
                    .get("reasoning_effort")
                    .is_none());
            }
        }
        assert!(build_chat_completions_request(&request(Some("high")), &config).is_err());
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
    fn local_openai_compatible_providers_keep_reasoning_effort() {
        for provider_type in ["ollama", "lmstudio"] {
            let body =
                build_chat_completions_request(&request(Some("max")), &provider(provider_type))
                    .expect("body");

            assert_eq!(
                body.get("reasoning_effort").and_then(Value::as_str),
                Some("max"),
                "provider {provider_type}"
            );
        }
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
    fn sse_parser_handles_cr_lf_crlf_and_flushes_final_event() {
        let mut parser = SseParser::default();
        assert!(parser
            .push(b"data: first\r")
            .expect("first chunk")
            .is_empty());
        assert_eq!(
            parser
                .push(b"\ndata: second\r\n\r\n")
                .expect("second chunk"),
            vec!["data: first\ndata: second".to_string()]
        );
        assert!(parser
            .push(b"data: [DONE]\r\n")
            .expect("terminal chunk")
            .is_empty());
        assert_eq!(
            parser.finish().expect("final flush"),
            vec!["data: [DONE]".to_string()]
        );
    }

    #[test]
    fn sse_parser_preserves_utf8_split_across_chunks() {
        let bytes = "data: café\n\n".as_bytes();
        let split_at = bytes
            .iter()
            .position(|byte| *byte == b'\xc3')
            .expect("multibyte character")
            + 1;
        let mut parser = SseParser::default();

        assert!(parser
            .push(&bytes[..split_at])
            .expect("first chunk")
            .is_empty());
        assert_eq!(
            parser.push(&bytes[split_at..]).expect("second chunk"),
            vec!["data: café".to_string()]
        );
    }

    #[test]
    fn truncated_sse_event_has_no_completion_marker() {
        let mut parser = SseParser::default();
        parser
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}")
            .expect("chunk");
        let events = parser.finish().expect("flush");
        assert_eq!(events.len(), 1);
        assert!(!is_terminal_sse_value(
            &serde_json::from_str::<Value>(&extract_sse_data(&events[0]).expect("data"))
                .expect("payload")
        ));
    }

    #[test]
    fn finish_reasons_preserve_output_limit_exhaustion() {
        assert_eq!(normalize_finish_reason("length"), "length");
        assert_eq!(normalize_finish_reason("max_output_tokens"), "length");
        assert_eq!(normalize_finish_reason("stop"), "completed");
        assert_eq!(normalize_finish_reason("content_filter"), "content_filter");
        assert!(!is_terminal_sse_value(&serde_json::json!({
            "choices": [{ "finish_reason": "stop" }]
        })));
        assert!(is_terminal_sse_value(&serde_json::json!({ "done": true })));
    }

    #[test]
    fn terminal_marker_without_finish_reason_is_incomplete() {
        let mut completion_reason = None;
        ensure_terminal_completion_reason(&mut completion_reason, &[]);
        assert_eq!(completion_reason.as_deref(), Some("incomplete"));

        let mut completed = Some("completed".to_string());
        ensure_terminal_completion_reason(&mut completed, &[]);
        assert_eq!(completed.as_deref(), Some("completed"));
    }

    #[test]
    fn invalid_utf8_is_rejected_instead_of_replaced() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"data: \xff").is_err());
    }

    #[test]
    fn sse_parser_rejects_an_unbounded_event_buffer() {
        let mut parser = SseParser::default();
        let oversized = vec![b'x'; MAX_SSE_BUFFER_BYTES + 1];
        assert!(parser.push(&oversized).is_err());
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
