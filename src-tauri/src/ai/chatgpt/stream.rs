use super::session::{ensure_fresh_secret, force_refresh_secret};
use super::types::{
    extract_response_error, AiChatMessageContent, AiChatRequest, AiStreamChunkEvent,
    AiStreamDoneEvent, AiStreamErrorEvent, AiToolCall, AiToolCallFunction, ChatGptResponsesRequest,
    ResponsesContentItem, ResponsesMessageItem, DEFAULT_ORIGINATOR,
};
use crate::ai::{emit_timeline, AiState, ProviderTimeline};
use crate::db::models::ProviderConfig;
use crate::db::repository;
use crate::secrets::ChatGptSecret;
use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::StatusCode;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::str;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Default, Clone)]
struct StreamingCompletionAccumulator {
    output_text: String,
    tool_calls: Vec<AiToolCall>,
    output_items: Vec<Value>,
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
                "chatgpt",
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
        if let Some(task_id) = task_id {
            let is_current_task = tasks
                .get(&task_request_id)
                .map(|handle| handle.id() == task_id)
                .unwrap_or(false);
            if is_current_task {
                tasks.remove(&task_request_id);
            }
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
    let timeline = ProviderTimeline::new(
        &app_handle,
        &request.request_id,
        &request.provider_id,
        "chatgpt",
        started_at,
    );
    timeline.emit("backend_task_started");
    let provider = repository::get_provider_config(&pool, &request.provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {} not found.", request.provider_id))?;
    let body = build_responses_request(&request)?;
    let client = reqwest::Client::new();

    let secret_started_at = Instant::now();
    let mut secret = ensure_fresh_secret(&pool, &request.provider_id).await?;
    if secret_started_at.elapsed().as_millis() > 50 {
        timeline.emit("auth_ready");
    }
    timeline.emit("provider_request_sent");
    let mut response = send_chatgpt_request(&client, &provider, &request, &secret, &body).await?;

    if response.status() == StatusCode::UNAUTHORIZED {
        secret = force_refresh_secret(&pool, &request.provider_id, &secret).await?;
        timeline.emit("auth_refreshed");
        timeline.emit("provider_request_sent");
        response = send_chatgpt_request(&client, &provider, &request, &secret, &body).await?;
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(extract_response_error(status.as_u16(), &body));
    }

    let mut stream = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut saw_completed = false;
    let mut completion_accumulator = StreamingCompletionAccumulator::default();
    let mut emitted_first_provider_event = false;
    let mut emitted_first_token = false;

    loop {
        let chunk = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                return Err(format!(
                    "ChatGPT stream was idle for more than {} seconds.",
                    STREAM_IDLE_TIMEOUT.as_secs()
                ));
            }
        };
        let chunk = chunk.map_err(|error| format!("Failed to read ChatGPT stream: {}", error))?;
        for event in parser.push(&chunk)? {
            if !emitted_first_provider_event {
                emitted_first_provider_event = true;
                timeline.emit("first_provider_event");
            }
            if process_sse_event(
                &app_handle,
                &request,
                &event,
                &mut completion_accumulator,
                started_at,
                &mut emitted_first_token,
            )? {
                saw_completed = true;
            }
        }
    }

    for event in parser.finish()? {
        if !emitted_first_provider_event {
            timeline.emit("first_provider_event");
        }
        let completed = process_sse_event(
            &app_handle,
            &request,
            &event,
            &mut completion_accumulator,
            started_at,
            &mut emitted_first_token,
        )?;
        saw_completed |= completed;
    }

    if !saw_completed {
        timeline.emit("done");
        let provider_input_items = optional_output_items(
            normalize_provider_input_items_for_replay(&completion_accumulator.output_items)?,
        );
        app_handle
            .emit(
                "ai:done",
                AiStreamDoneEvent {
                    request_id: request.request_id,
                    output_text: completion_accumulator.output_text,
                    tool_calls: completion_accumulator.tool_calls,
                    response_id: completion_accumulator.response_id,
                    output_items: optional_output_items(completion_accumulator.output_items),
                    provider_input_items,
                    provider_turn_state: None,
                    reasoning_summary: optional_text(completion_accumulator.reasoning_summary),
                    tool_traces: None,
                    hidden_context: None,
                    completion_reason: Some("completed".to_string()),
                },
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

async fn send_chatgpt_request(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    request: &AiChatRequest,
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
    let stable_conversation_id = request
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(request.request_id.as_str());

    client
        .post(&url)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "text/event-stream")
        .header(AUTHORIZATION, format!("Bearer {}", secret.access_token))
        .header("ChatGPT-Account-Id", account_id)
        .header("originator", DEFAULT_ORIGINATOR)
        .header("conversation_id", stable_conversation_id)
        .header("session_id", stable_conversation_id)
        .header("x-client-request-id", request.request_id.to_string())
        .json(body)
        .send()
        .await
        .map_err(|error| format!("Failed to send ChatGPT request: {}", error))
}

#[derive(Debug, Default)]
pub(super) struct SseParser {
    input: String,
    event: String,
    utf8_tail: Vec<u8>,
}

impl SseParser {
    pub(super) fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.append_utf8(chunk)?;
        Ok(self.drain_events(false))
    }

    pub(super) fn finish(&mut self) -> Result<Vec<String>, String> {
        if !self.utf8_tail.is_empty() {
            return Err("ChatGPT stream ended with invalid UTF-8.".to_string());
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
                    return Err("ChatGPT stream contained invalid UTF-8.".to_string());
                }
                self.utf8_tail.extend_from_slice(&bytes[valid_up_to..]);
            }
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

fn process_sse_event(
    app_handle: &AppHandle,
    request: &AiChatRequest,
    raw_event: &str,
    completion_accumulator: &mut StreamingCompletionAccumulator,
    started_at: Instant,
    emitted_first_token: &mut bool,
) -> Result<bool, String> {
    let Some(payload) = extract_sse_data(raw_event) else {
        return Ok(false);
    };
    if payload == "[DONE]" {
        return Ok(false);
    }

    let value: Value = serde_json::from_str(&payload)
        .map_err(|error| format!("Invalid SSE payload: {}", error))?;
    if let Some(response_id) = extract_response_id(&value) {
        completion_accumulator.response_id = Some(response_id);
    }
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match event_type {
        "response.output_text.delta" => {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                if !*emitted_first_token {
                    *emitted_first_token = true;
                    emit_timeline(
                        app_handle,
                        &request.request_id,
                        &request.provider_id,
                        "chatgpt",
                        started_at,
                        "first_token",
                    );
                }
                app_handle
                    .emit(
                        "ai:stream",
                        AiStreamChunkEvent {
                            request_id: request.request_id.to_string(),
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
        "response.content_part.done" => {
            if let Some(part) = value.get("part").or_else(|| value.get("content_part")) {
                merge_output_text(
                    &mut completion_accumulator.output_text,
                    &extract_output_text_from_content_part(part),
                );
            }
            Ok(false)
        }
        "response.output_item.done" => {
            if let Some(item) = value.get("item") {
                upsert_output_item(&mut completion_accumulator.output_items, item.clone());
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
                upsert_output_item(
                    &mut completion_accumulator.output_items,
                    json!({
                        "type": "function_call",
                        "call_id": tool_call.id.clone(),
                        "name": tool_call.function.name.clone(),
                        "arguments": tool_call.function.arguments.clone(),
                    }),
                );
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
            let output_items = select_best_output_items(
                extract_completed_items(&value).cloned(),
                &completion_accumulator.output_items,
            );
            let provider_input_items = output_items
                .as_ref()
                .map(|items| normalize_provider_input_items_for_replay(items))
                .transpose()?
                .and_then(optional_output_items);
            let response_id =
                extract_response_id(&value).or_else(|| completion_accumulator.response_id.clone());
            emit_timeline(
                app_handle,
                &request.request_id,
                &request.provider_id,
                "chatgpt",
                started_at,
                "done",
            );
            app_handle
                .emit(
                    "ai:done",
                    AiStreamDoneEvent {
                        request_id: request.request_id.to_string(),
                        output_text,
                        tool_calls,
                        response_id,
                        output_items,
                        provider_input_items,
                        provider_turn_state: None,
                        reasoning_summary,
                        tool_traces: None,
                        hidden_context: None,
                        completion_reason: Some("completed".to_string()),
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

pub(super) fn extract_sse_data(raw_event: &str) -> Option<String> {
    let data_lines = raw_event
        .split('\n')
        .filter_map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let data = line.strip_prefix("data:")?;
            Some(data.strip_prefix(' ').unwrap_or(data).to_string())
        })
        .collect::<Vec<_>>();

    (!data_lines.is_empty()).then(|| data_lines.join("\n"))
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
                if let Some(provider_input_items) = extract_message_provider_input_items(message)? {
                    input.extend(provider_input_items);
                    continue;
                }

                let text = content_to_plain_text(&message.content);
                if !text.trim().is_empty() {
                    input.push(serialize_response_input_item(
                        ResponsesMessageItem::Message {
                            role: "assistant".to_string(),
                            content: build_response_content_items(&message.content, true)?,
                        },
                    )?);
                }
                for tool_call in &message.tool_calls {
                    if tool_call.kind != "function" {
                        continue;
                    }
                    input.push(serialize_response_input_item(
                        ResponsesMessageItem::FunctionCall {
                            call_id: tool_call.id.clone(),
                            name: tool_call.function.name.clone(),
                            arguments: tool_call.function.arguments.clone(),
                        },
                    )?);
                }
            }
            "user" => {
                if let Some(provider_input_items) = extract_message_provider_input_items(message)? {
                    input.extend(provider_input_items);
                    continue;
                }

                input.push(serialize_response_input_item(
                    ResponsesMessageItem::Message {
                        role: "user".to_string(),
                        content: build_response_content_items(&message.content, false)?,
                    },
                )?);
            }
            "tool" => {
                if let Some(provider_input_items) = extract_message_provider_input_items(message)? {
                    input.extend(provider_input_items);
                    continue;
                }

                let call_id = message
                    .tool_call_id
                    .clone()
                    .ok_or_else(|| "Tool message is missing tool_call_id.".to_string())?;
                input.push(serialize_response_input_item(
                    ResponsesMessageItem::FunctionCallOutput {
                        call_id,
                        output: content_to_plain_text(&message.content),
                    },
                )?);
            }
            _ => input.push(serialize_response_input_item(
                ResponsesMessageItem::Message {
                    role: "user".to_string(),
                    content: vec![ResponsesContentItem::InputText {
                        text: content_to_plain_text(&message.content),
                    }],
                },
            )?),
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
        input,
        tools,
        tool_choice: request
            .tool_choice
            .clone()
            .unwrap_or_else(|| "auto".to_string()),
        parallel_tool_calls: request.parallel_tool_calls.unwrap_or(false),
        reasoning: default_reasoning_config(&request.model_id, request.reasoning_effort.as_deref()),
        prompt_cache_key: request
            .conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        store: false,
        stream: true,
        include: vec!["reasoning.encrypted_content".to_string()],
    })
}

fn serialize_response_input_item(item: ResponsesMessageItem) -> Result<Value, String> {
    serde_json::to_value(item)
        .map_err(|error| format!("Failed to serialize response input item: {}", error))
}

fn extract_message_provider_input_items(
    message: &super::types::AiChatMessage,
) -> Result<Option<Vec<Value>>, String> {
    if let Some(provider_input_items) = message
        .provider_input_items
        .as_ref()
        .filter(|items| !items.is_empty())
    {
        let normalized = normalize_provider_input_items_for_replay(provider_input_items)?;
        if !normalized.is_empty() {
            return Ok(Some(normalized));
        }
    }

    extract_provider_turn_output_items(message.provider_turn_state.as_ref())
}

fn extract_provider_turn_output_items(
    provider_turn_state: Option<&Value>,
) -> Result<Option<Vec<Value>>, String> {
    let Some(provider_turn_state) = provider_turn_state else {
        return Ok(None);
    };

    if provider_turn_state.get("provider").and_then(Value::as_str) != Some("chatgpt") {
        return Ok(None);
    }

    let output_items = provider_turn_state
        .get("output_items")
        .and_then(Value::as_array)
        .ok_or_else(|| "ChatGPT provider_turn_state is missing output_items.".to_string())?
        .clone();

    if output_items.is_empty() {
        return Ok(None);
    }

    let normalized = normalize_provider_input_items_for_replay(&output_items)?;
    if normalized.is_empty() {
        return Ok(None);
    }

    Ok(Some(normalized))
}

pub(super) fn normalize_provider_input_items_for_replay(
    output_items: &[Value],
) -> Result<Vec<Value>, String> {
    let mut normalized = Vec::new();

    for item in output_items {
        if let Some(replay_item) = normalize_provider_input_item_for_replay(item)? {
            normalized.push(replay_item);
        }
    }

    Ok(normalized)
}

fn normalize_provider_input_item_for_replay(item: &Value) -> Result<Option<Value>, String> {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();

    match kind {
        "message" => normalize_message_item_for_replay(item),
        "reasoning" => {
            let encrypted_content = item
                .get("encrypted_content")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let Some(encrypted_content) = encrypted_content else {
                return Ok(None);
            };

            let summary = item
                .get("summary")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            Ok(Some(json!({
                "type": "reasoning",
                "summary": summary,
                "encrypted_content": encrypted_content,
            })))
        }
        "function_call" => {
            let Some(tool_call) = extract_function_call_from_output_item(item)? else {
                return Ok(None);
            };

            Ok(Some(json!({
                "type": "function_call",
                "call_id": tool_call.id,
                "name": tool_call.function.name,
                "arguments": tool_call.function.arguments,
            })))
        }
        "function_call_output" => {
            let call_id = item
                .get("call_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Function call output item is missing call_id.".to_string())?;
            let output = item
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            Ok(Some(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": output,
            })))
        }
        "output_text" => {
            let text = extract_output_text_from_output_item(item);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }

            Ok(Some(json!({
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": trimmed,
                    }
                ],
            })))
        }
        _ => {
            let text = extract_output_text_from_output_item(item);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }

            Ok(Some(json!({
                "type": "message",
                "role": item.get("role").and_then(Value::as_str).unwrap_or("assistant"),
                "content": [
                    {
                        "type": "output_text",
                        "text": trimmed,
                    }
                ],
            })))
        }
    }
}

fn normalize_message_item_for_replay(item: &Value) -> Result<Option<Value>, String> {
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    let mut normalized_content = Vec::new();

    if let Some(parts) = item.get("content").and_then(Value::as_array) {
        for part in parts {
            if let Some(normalized_part) = normalize_message_content_part_for_replay(role, part)? {
                normalized_content.push(normalized_part);
            }
        }
    }

    if normalized_content.is_empty() {
        let text = extract_output_text_from_output_item(item);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        normalized_content.push(json!({
            "type": if role == "user" { "input_text" } else { "output_text" },
            "text": trimmed,
        }));
    }

    Ok(Some(json!({
        "type": "message",
        "role": role,
        "content": normalized_content,
    })))
}

fn normalize_message_content_part_for_replay(
    role: &str,
    part: &Value,
) -> Result<Option<Value>, String> {
    let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();

    match kind {
        "input_text" | "output_text" | "text" => {
            let text = part
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if text.is_empty() {
                return Ok(None);
            }

            Ok(Some(json!({
                "type": if role == "user" { "input_text" } else { "output_text" },
                "text": text,
            })))
        }
        "input_image" | "image_url" => {
            let image_url =
                part.get("image_url")
                    .and_then(|value| {
                        value.as_str().map(str::to_string).or_else(|| {
                            value.get("url").and_then(Value::as_str).map(str::to_string)
                        })
                    })
                    .ok_or_else(|| "Message image content is missing image_url.".to_string())?;

            Ok(Some(json!({
                "type": "input_image",
                "image_url": image_url,
            })))
        }
        _ => Ok(None),
    }
}

fn extract_completed_items(payload: &Value) -> Option<&Vec<Value>> {
    payload
        .get("response")
        .and_then(|response| response.get("output"))
        .and_then(Value::as_array)
        .or_else(|| payload.get("output").and_then(Value::as_array))
}

pub(super) fn extract_completed_output_text(payload: &Value) -> String {
    let direct_output_text = payload
        .get("response")
        .and_then(|response| response.get("output_text"))
        .or_else(|| payload.get("output_text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let item_output_text = extract_completed_items(payload)
        .into_iter()
        .flatten()
        .map(extract_output_text_from_output_item)
        .collect::<Vec<_>>()
        .join("");

    select_best_output_text(direct_output_text, &item_output_text)
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
    if item.get("type").and_then(Value::as_str) == Some("output_text") {
        return extract_json_text_value(item.get("text")).unwrap_or_default();
    }

    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(extract_output_text_from_content_part)
        .collect::<Vec<_>>()
        .join("")
}

fn extract_json_text_value(value: Option<&Value>) -> Option<String> {
    value.and_then(|text| {
        text.as_str().map(str::to_string).or_else(|| {
            text.get("value")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    })
}

fn extract_output_text_from_content_part(part: &Value) -> String {
    let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind != "output_text" && kind != "text" {
        return String::new();
    }

    extract_json_text_value(part.get("text"))
        .or_else(|| extract_json_text_value(part.get("value")))
        .unwrap_or_default()
}

pub(super) fn extract_reasoning_summary_from_output_item(item: &Value) -> String {
    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
        return String::new();
    }

    item.get("summary")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|summary_item| {
            summary_item.get("type").and_then(Value::as_str) == Some("summary_text")
        })
        .filter_map(|summary_item| extract_json_text_value(summary_item.get("text")))
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

fn select_best_output_items(primary: Option<Vec<Value>>, fallback: &[Value]) -> Option<Vec<Value>> {
    if let Some(primary) = primary.filter(|items| !items.is_empty()) {
        return Some(primary);
    }

    optional_output_items(fallback.to_vec())
}

fn optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn optional_output_items(value: Vec<Value>) -> Option<Vec<Value>> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn output_item_identity(item: &Value) -> Option<String> {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or("item");

    item.get("id")
        .or_else(|| item.get("call_id"))
        .or_else(|| item.get("item_id"))
        .and_then(Value::as_str)
        .map(|identifier| format!("{}:{}", kind, identifier))
}

fn upsert_output_item(output_items: &mut Vec<Value>, item: Value) {
    if let Some(identity) = output_item_identity(&item) {
        if let Some(existing) = output_items
            .iter_mut()
            .find(|existing| output_item_identity(existing).as_deref() == Some(identity.as_str()))
        {
            *existing = item;
            return;
        }
    }

    if output_items.iter().all(|existing| existing != &item) {
        output_items.push(item);
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
