use super::session::{ensure_fresh_secret, force_refresh_secret};
use super::types::{
    extract_response_error, AiChatMessageContent, AiChatRequest, AiStreamChunkEvent,
    AiStreamDoneEvent, AiStreamErrorEvent, AiToolCall, AiToolCallFunction, ChatGptResponsesRequest,
    ResponsesContentItem, ResponsesMessageItem, DEFAULT_ORIGINATOR,
};
use crate::ai::AiState;
use crate::db::models::ProviderConfig;
use crate::db::repository;
use crate::secrets::ChatGptSecret;
use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::StatusCode;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Default, Clone)]
struct StreamingCompletionAccumulator {
    output_text: String,
    tool_calls: Vec<AiToolCall>,
    response_id: Option<String>,
    reasoning_summary: String,
}

pub async fn cancel_stream(ai_state: &AiState, request_id: &str) -> Result<(), String> {
    let mut tasks = ai_state.stream_tasks.lock().await;
    if let Some(handle) = tasks.remove(request_id) {
        handle.abort();
    }
    Ok(())
}

pub async fn stream_chat(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request: AiChatRequest,
) -> Result<(), String> {
    cancel_stream(&ai_state, &request.request_id).await?;

    let request_id = request.request_id.clone();
    let task_request_id = request.request_id.clone();
    let app_for_task = app_handle.clone();
    let state_for_task = ai_state.clone();

    let handle = tokio::spawn(async move {
        let result = stream_chat_inner(app_for_task.clone(), pool, request).await;
        if let Err(message) = result {
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
    let provider = repository::get_provider_config(&pool, &request.provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {} not found.", request.provider_id))?;
    let body = build_responses_request(&request)?;
    let client = reqwest::Client::new();

    let mut secret = ensure_fresh_secret(&pool, &request.provider_id).await?;
    let mut response =
        send_chatgpt_request(&client, &provider, &request.request_id, &secret, &body).await?;

    if response.status() == StatusCode::UNAUTHORIZED {
        secret = force_refresh_secret(&pool, &request.provider_id, &secret).await?;
        response =
            send_chatgpt_request(&client, &provider, &request.request_id, &secret, &body).await?;
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(extract_response_error(status.as_u16(), &body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut saw_completed = false;
    let mut completion_accumulator = StreamingCompletionAccumulator::default();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Failed to read ChatGPT stream: {}", error))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);
        if buffer.contains("\r\n") {
            buffer = buffer.replace("\r\n", "\n");
        }

        while let Some(split_index) = buffer.find("\n\n") {
            let event = buffer[..split_index].to_string();
            buffer = buffer[split_index + 2..].to_string();
            if process_sse_event(
                &app_handle,
                &request.request_id,
                &event,
                &mut completion_accumulator,
            )? {
                saw_completed = true;
            }
        }
    }

    if !buffer.trim().is_empty() {
        let completed = process_sse_event(
            &app_handle,
            &request.request_id,
            &buffer,
            &mut completion_accumulator,
        )?;
        saw_completed |= completed;
    }

    if !saw_completed {
        app_handle
            .emit(
                "ai:done",
                AiStreamDoneEvent {
                    request_id: request.request_id,
                    output_text: completion_accumulator.output_text,
                    tool_calls: completion_accumulator.tool_calls,
                    response_id: completion_accumulator.response_id,
                    reasoning_summary: optional_text(completion_accumulator.reasoning_summary),
                    tool_traces: None,
                    hidden_context: None,
                },
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

async fn send_chatgpt_request(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    request_id: &str,
    secret: &ChatGptSecret,
    body: &ChatGptResponsesRequest,
) -> Result<reqwest::Response, String> {
    let account_id = secret
        .account_id
        .clone()
        .ok_or_else(|| "ChatGPT account ID is missing. Reconnect with ChatGPT.".to_string())?;
    let url = format!(
        "{}/codex/responses",
        provider.base_url.trim_end_matches('/')
    );

    client
        .post(&url)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "text/event-stream")
        .header(AUTHORIZATION, format!("Bearer {}", secret.access_token))
        .header("ChatGPT-Account-Id", account_id)
        .header("originator", DEFAULT_ORIGINATOR)
        .header("session_id", request_id.to_string())
        .json(body)
        .send()
        .await
        .map_err(|error| format!("Failed to send ChatGPT request: {}", error))
}

fn process_sse_event(
    app_handle: &AppHandle,
    request_id: &str,
    raw_event: &str,
    completion_accumulator: &mut StreamingCompletionAccumulator,
) -> Result<bool, String> {
    let mut payload = String::new();
    for line in raw_event.lines() {
        let trimmed = line.trim_end();
        if let Some(rest) = trimmed.strip_prefix("data:") {
            payload.push_str(rest.trim_start());
        }
    }

    if payload.is_empty() {
        return Ok(false);
    }
    if payload == "[DONE]" {
        return Ok(false);
    }

    let value: Value = serde_json::from_str(&payload)
        .map_err(|error| format!("Invalid SSE payload: {}", error))?;
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match event_type {
        "response.output_text.delta" => {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                app_handle
                    .emit(
                        "ai:stream",
                        AiStreamChunkEvent {
                            request_id: request_id.to_string(),
                            delta: delta.to_string(),
                        },
                    )
                    .map_err(|error| error.to_string())?;
            }
            Ok(false)
        }
        "response.output_text.done" => {
            if let Some(text) = value.get("text").and_then(Value::as_str) {
                merge_output_text(&mut completion_accumulator.output_text, text);
            }
            Ok(false)
        }
        "response.output_item.done" => {
            if let Some(item) = value.get("item") {
                merge_output_text(
                    &mut completion_accumulator.output_text,
                    &extract_output_text_from_output_item(item),
                );
                merge_output_text(
                    &mut completion_accumulator.reasoning_summary,
                    &extract_reasoning_summary_from_output_item(item),
                );
                if let Some(tool_call) = extract_function_call_from_output_item(item)? {
                    upsert_tool_call(&mut completion_accumulator.tool_calls, tool_call);
                }
            }
            Ok(false)
        }
        "response.function_call_arguments.done" => {
            if let Some(tool_call) = extract_function_call_from_arguments_done(&value)? {
                upsert_tool_call(&mut completion_accumulator.tool_calls, tool_call);
            }
            Ok(false)
        }
        "response.completed" => {
            let output_text = select_best_output_text(
                extract_completed_output_text(&value),
                &completion_accumulator.output_text,
            );
            let reasoning_summary = select_best_optional_text(
                extract_completed_reasoning_summary(&value),
                &completion_accumulator.reasoning_summary,
            );
            let tool_calls = merge_tool_calls(
                extract_completed_tool_calls(&value)?,
                &completion_accumulator.tool_calls,
            );
            let response_id =
                extract_response_id(&value).or_else(|| completion_accumulator.response_id.clone());
            app_handle
                .emit(
                    "ai:done",
                    AiStreamDoneEvent {
                        request_id: request_id.to_string(),
                        output_text,
                        tool_calls,
                        response_id,
                        reasoning_summary,
                        tool_traces: None,
                        hidden_context: None,
                    },
                )
                .map_err(|error| error.to_string())?;
            Ok(true)
        }
        "response.failed" => Err(extract_stream_error(&value)),
        "response.incomplete" => Err("Incomplete response returned by ChatGPT.".to_string()),
        _ => Ok(false),
    }
}

fn normalize_tool_definition(raw_tool: &Value) -> Result<Value, String> {
    if !raw_tool.is_object() {
        return Err("Tool definitions must be JSON objects.".to_string());
    }

    if raw_tool.get("function").is_some() {
        let function = raw_tool
            .get("function")
            .and_then(Value::as_object)
            .ok_or_else(|| "Invalid function tool definition.".to_string())?;
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "Tool definition is missing function.name.".to_string())?;
        let description = function
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let parameters = function
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));

        return Ok(serde_json::json!({
            "type": "function",
            "name": name,
            "description": description,
            "parameters": parameters,
        }));
    }

    Ok(raw_tool.clone())
}

pub(super) fn build_responses_request(
    request: &AiChatRequest,
) -> Result<ChatGptResponsesRequest, String> {
    let mut instructions = Vec::new();
    let mut input = Vec::new();

    for message in &request.messages {
        match message.role.as_str() {
            "system" => instructions.push(content_to_plain_text(&message.content)),
            "assistant" => {
                let text = content_to_plain_text(&message.content);
                if !text.trim().is_empty() {
                    input.push(ResponsesMessageItem::Message {
                        role: "assistant".to_string(),
                        content: build_response_content_items(&message.content, true)?,
                    });
                }
                for tool_call in &message.tool_calls {
                    if tool_call.kind != "function" {
                        continue;
                    }
                    input.push(ResponsesMessageItem::FunctionCall {
                        call_id: tool_call.id.clone(),
                        name: tool_call.function.name.clone(),
                        arguments: tool_call.function.arguments.clone(),
                    });
                }
            }
            "user" => input.push(ResponsesMessageItem::Message {
                role: "user".to_string(),
                content: build_response_content_items(&message.content, false)?,
            }),
            "tool" => {
                let call_id = message
                    .tool_call_id
                    .clone()
                    .ok_or_else(|| "Tool message is missing tool_call_id.".to_string())?;
                input.push(ResponsesMessageItem::FunctionCallOutput {
                    call_id,
                    output: content_to_plain_text(&message.content),
                });
            }
            _ => input.push(ResponsesMessageItem::Message {
                role: "user".to_string(),
                content: vec![ResponsesContentItem::InputText {
                    text: content_to_plain_text(&message.content),
                }],
            }),
        }
    }

    if input.is_empty() {
        return Err("No chat messages were provided.".to_string());
    }

    let tools = request
        .tools
        .iter()
        .map(normalize_tool_definition)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ChatGptResponsesRequest {
        model: request.model_id.clone(),
        instructions: instructions.join("\n\n").trim().to_string(),
        previous_response_id: request.previous_response_id.clone(),
        input,
        tools,
        tool_choice: request
            .tool_choice
            .clone()
            .unwrap_or_else(|| "auto".to_string()),
        parallel_tool_calls: request.parallel_tool_calls.unwrap_or(false),
        reasoning: default_reasoning_config(&request.model_id, request.reasoning_effort.as_deref()),
        // The ChatGPT/Codex backend currently rejects stored responses on this endpoint.
        // We still keep `previous_response_id` for multi-turn continuation.
        store: false,
        stream: true,
        include: Vec::new(),
    })
}

fn extract_completed_items(payload: &Value) -> Option<&Vec<Value>> {
    payload
        .get("response")
        .and_then(|response| response.get("output"))
        .and_then(Value::as_array)
        .or_else(|| payload.get("output").and_then(Value::as_array))
}

fn extract_completed_output_text(payload: &Value) -> String {
    extract_completed_items(payload)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

pub(super) fn extract_completed_reasoning_summary(payload: &Value) -> Option<String> {
    optional_text(
        extract_completed_items(payload)
            .into_iter()
            .flatten()
            .map(extract_reasoning_summary_from_output_item)
            .collect::<Vec<_>>()
            .join(""),
    )
}

pub(super) fn extract_output_text_from_output_item(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

pub(super) fn extract_reasoning_summary_from_output_item(item: &Value) -> String {
    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
        return String::new();
    }

    item.get("summary")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|summary_item| summary_item.get("type").and_then(Value::as_str) == Some("summary_text"))
        .filter_map(|summary_item| summary_item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

pub(super) fn extract_response_id(payload: &Value) -> Option<String> {
    payload
        .get("response")
        .and_then(|response| response.get("id"))
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn extract_completed_tool_calls(payload: &Value) -> Result<Vec<AiToolCall>, String> {
    let Some(items) = extract_completed_items(payload) else {
        return Ok(Vec::new());
    };

    let mut tool_calls = Vec::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }

        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Function call item is missing call_id.".to_string())?;
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "Function call item is missing name.".to_string())?;
        let arguments = item
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}");

        tool_calls.push(AiToolCall {
            id: call_id.to_string(),
            kind: "function".to_string(),
            function: AiToolCallFunction {
                name: name.to_string(),
                arguments: arguments.to_string(),
            },
        });
    }

    Ok(tool_calls)
}

pub(super) fn extract_function_call_from_output_item(
    item: &Value,
) -> Result<Option<AiToolCall>, String> {
    if item.get("type").and_then(Value::as_str) != Some("function_call") {
        return Ok(None);
    }

    let call_id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Function call item is missing call_id.".to_string())?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Function call item is missing name.".to_string())?;
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");

    Ok(Some(AiToolCall {
        id: call_id.to_string(),
        kind: "function".to_string(),
        function: AiToolCallFunction {
            name: name.to_string(),
            arguments: arguments.to_string(),
        },
    }))
}

fn extract_function_call_from_arguments_done(value: &Value) -> Result<Option<AiToolCall>, String> {
    let name = match value.get("name").and_then(Value::as_str) {
        Some(name) if !name.trim().is_empty() => name,
        _ => return Ok(None),
    };
    let call_id = value
        .get("call_id")
        .or_else(|| value.get("item_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Function call arguments event is missing call_id.".to_string())?;
    let arguments = value
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");

    Ok(Some(AiToolCall {
        id: call_id.to_string(),
        kind: "function".to_string(),
        function: AiToolCallFunction {
            name: name.to_string(),
            arguments: arguments.to_string(),
        },
    }))
}

fn merge_output_text(current: &mut String, candidate: &str) {
    let trimmed_candidate = candidate.trim();
    if trimmed_candidate.is_empty() {
        return;
    }

    if current.trim().is_empty() {
        *current = trimmed_candidate.to_string();
        return;
    }

    let trimmed_current = current.trim().to_string();
    if trimmed_current == trimmed_candidate {
        return;
    }

    if trimmed_candidate.len() > trimmed_current.len()
        && trimmed_candidate.contains(&trimmed_current)
    {
        *current = trimmed_candidate.to_string();
        return;
    }

    if !trimmed_current.contains(trimmed_candidate) {
        current.push_str(trimmed_candidate);
    }
}

fn select_best_output_text(primary: String, fallback: &str) -> String {
    let trimmed_primary = primary.trim();
    let trimmed_fallback = fallback.trim();

    if trimmed_primary.is_empty() {
        return trimmed_fallback.to_string();
    }

    if trimmed_fallback.len() > trimmed_primary.len() && trimmed_fallback.contains(trimmed_primary)
    {
        return trimmed_fallback.to_string();
    }

    trimmed_primary.to_string()
}

fn select_best_optional_text(primary: Option<String>, fallback: &str) -> Option<String> {
    let merged = select_best_output_text(primary.unwrap_or_default(), fallback);
    optional_text(merged)
}

fn optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn upsert_tool_call(tool_calls: &mut Vec<AiToolCall>, tool_call: AiToolCall) {
    if let Some(existing) = tool_calls
        .iter_mut()
        .find(|existing| existing.id == tool_call.id)
    {
        *existing = tool_call;
        return;
    }

    tool_calls.push(tool_call);
}

fn merge_tool_calls(primary: Vec<AiToolCall>, fallback: &[AiToolCall]) -> Vec<AiToolCall> {
    let mut merged = primary;
    for tool_call in fallback {
        if merged.iter().all(|existing| existing.id != tool_call.id) {
            merged.push(tool_call.clone());
        }
    }
    merged
}

fn build_response_content_items(
    content: &AiChatMessageContent,
    is_assistant: bool,
) -> Result<Vec<ResponsesContentItem>, String> {
    match content {
        AiChatMessageContent::Text(text) => {
            if is_assistant {
                Ok(vec![ResponsesContentItem::OutputText {
                    text: text.clone(),
                }])
            } else {
                Ok(vec![ResponsesContentItem::InputText { text: text.clone() }])
            }
        }
        AiChatMessageContent::Parts(parts) => {
            let mut items = Vec::new();
            for part in parts {
                match part.kind.as_str() {
                    "text" => {
                        let text = part.text.clone().unwrap_or_default();
                        if is_assistant {
                            items.push(ResponsesContentItem::OutputText { text });
                        } else {
                            items.push(ResponsesContentItem::InputText { text });
                        }
                    }
                    "image_url" => {
                        let image_url = part
                            .image_url
                            .as_ref()
                            .map(|image| image.url.clone())
                            .ok_or_else(|| {
                                "Missing image_url payload for image content.".to_string()
                            })?;
                        items.push(ResponsesContentItem::InputImage { image_url });
                    }
                    _ => {}
                }
            }

            if items.is_empty() {
                return Err("Message content is empty.".to_string());
            }

            Ok(items)
        }
    }
}

fn default_reasoning_config(model_id: &str, selected_effort: Option<&str>) -> Option<Value> {
    let normalized = model_id.trim().to_ascii_lowercase();
    if !normalized.starts_with("gpt-5") {
        return None;
    }

    let effort = selected_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("medium");

    Some(json!({
        "effort": effort,
        "summary": "auto",
    }))
}

fn content_to_plain_text(content: &AiChatMessageContent) -> String {
    match content {
        AiChatMessageContent::Text(text) => text.clone(),
        AiChatMessageContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part.kind.as_str() {
                "text" => part.text.clone(),
                "image_url" => part
                    .image_url
                    .as_ref()
                    .map(|image| format!("[image:{}]", image.url)),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn extract_stream_error(payload: &Value) -> String {
    payload
        .get("response")
        .and_then(|response| response.get("error"))
        .and_then(|error| error.get("message").or_else(|| error.get("code")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "ChatGPT stream failed.".to_string())
}
