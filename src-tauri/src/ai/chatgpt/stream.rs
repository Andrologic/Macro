use super::session::{ensure_fresh_secret, force_refresh_secret};
use super::types::{
    extract_response_error, AiChatMessage, AiChatMessageContent, AiChatRequest, AiStreamChunkEvent,
    AiStreamDoneEvent, AiStreamErrorEvent, ChatGptResponsesRequest, ResponsesContentItem,
    ResponsesMessageItem, DEFAULT_ORIGINATOR,
};
use crate::ai::AiState;
use crate::db::models::ProviderConfig;
use crate::db::repository;
use crate::secrets::ChatGptSecret;
use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::StatusCode;
use serde_json::Value;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

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
    let body = build_responses_request(&request.model_id, &request.messages)?;
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
            if process_sse_event(&app_handle, &request.request_id, &event)? {
                saw_completed = true;
            }
        }
    }

    if !buffer.trim().is_empty() {
        let completed = process_sse_event(&app_handle, &request.request_id, &buffer)?;
        saw_completed |= completed;
    }

    if !saw_completed {
        app_handle
            .emit(
                "ai:done",
                AiStreamDoneEvent {
                    request_id: request.request_id,
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
        app_handle
            .emit(
                "ai:done",
                AiStreamDoneEvent {
                    request_id: request_id.to_string(),
                },
            )
            .map_err(|error| error.to_string())?;
        return Ok(true);
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
        "response.completed" => {
            app_handle
                .emit(
                    "ai:done",
                    AiStreamDoneEvent {
                        request_id: request_id.to_string(),
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

pub(super) fn build_responses_request(
    model_id: &str,
    messages: &[AiChatMessage],
) -> Result<ChatGptResponsesRequest, String> {
    let mut instructions = Vec::new();
    let mut input = Vec::new();

    for message in messages {
        match message.role.as_str() {
            "system" => instructions.push(content_to_plain_text(&message.content)),
            "assistant" => input.push(ResponsesMessageItem::Message {
                role: "assistant".to_string(),
                content: build_response_content_items(&message.content, true)?,
            }),
            "user" => input.push(ResponsesMessageItem::Message {
                role: "user".to_string(),
                content: build_response_content_items(&message.content, false)?,
            }),
            "tool" => input.push(ResponsesMessageItem::Message {
                role: "user".to_string(),
                content: vec![ResponsesContentItem::InputText {
                    text: content_to_plain_text(&message.content),
                }],
            }),
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

    Ok(ChatGptResponsesRequest {
        model: model_id.to_string(),
        instructions: instructions.join("\n\n").trim().to_string(),
        input,
        tools: Vec::new(),
        tool_choice: "auto".to_string(),
        parallel_tool_calls: false,
        reasoning: None,
        store: false,
        stream: true,
        include: Vec::new(),
    })
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
