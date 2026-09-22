use super::types::{McpCallToolResponse, McpResultBlock};
use base64::Engine;
use serde_json::{json, Value};

pub(crate) const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_BLOCKS: usize = 64;

fn unavailable(reason: &str) -> McpResultBlock {
    McpResultBlock::Unavailable {
        reason: reason.to_string(),
    }
}

/// Remote content is data. Never dereference resources or interpret instructions here.
pub(crate) fn normalize_tool_call_result(result: Value) -> McpCallToolResponse {
    let mut is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut remaining = MAX_RESULT_BYTES;
    let mut blocks = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content.iter().take(MAX_BLOCKS) {
            let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
            let block = match kind {
                "text" => match item.get("text").and_then(Value::as_str) {
                    Some(text) if text.len() <= remaining => {
                        remaining -= text.len();
                        McpResultBlock::Text {
                            text: text.to_string(),
                        }
                    }
                    Some(_) => {
                        unavailable("MCP result exceeds the 8 MiB content limit; block omitted.")
                    }
                    None => unavailable("Invalid MCP text block."),
                },
                "unavailable" => unavailable(
                    &item
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("MCP content unavailable.")
                        .chars()
                        .take(256)
                        .collect::<String>(),
                ),
                "image" | "audio" => {
                    let data = item.get("data").and_then(Value::as_str).unwrap_or("");
                    let mime = item.get("mimeType").and_then(Value::as_str).unwrap_or("");
                    let valid_mime = if kind == "image" {
                        matches!(
                            mime,
                            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                        )
                    } else {
                        matches!(
                            mime,
                            "audio/wav"
                                | "audio/x-wav"
                                | "audio/mpeg"
                                | "audio/mp3"
                                | "audio/ogg"
                                | "audio/flac"
                                | "audio/mp4"
                                | "audio/webm"
                        )
                    };
                    if data.len() > remaining {
                        unavailable("MCP result exceeds the 8 MiB content limit; media omitted.")
                    } else if !valid_mime
                        || data.is_empty()
                        || base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .is_err()
                    {
                        unavailable("Invalid MCP media MIME type or base64 data; media omitted.")
                    } else {
                        remaining -= data.len();
                        if kind == "image" {
                            McpResultBlock::Image {
                                data: data.into(),
                                mime_type: mime.into(),
                            }
                        } else {
                            McpResultBlock::Audio {
                                data: data.into(),
                                mime_type: mime.into(),
                            }
                        }
                    }
                }
                _ => unavailable("Unsupported MCP content type; no resource was fetched."),
            };
            is_error |= matches!(block, McpResultBlock::Unavailable { .. });
            blocks.push(block);
        }
        if content.len() > MAX_BLOCKS {
            blocks.push(unavailable(
                "MCP result exceeds the 64 block limit; remaining blocks omitted.",
            ));
            is_error = true;
        }
    } else {
        let text = result.to_string();
        if text.len() <= remaining {
            blocks.push(McpResultBlock::Text { text });
        } else {
            blocks.push(unavailable("MCP result exceeds the 8 MiB content limit."));
            is_error = true;
        }
    }
    let content = blocks
        .iter()
        .map(|block| match block {
            McpResultBlock::Text { text } => text.clone(),
            McpResultBlock::Image { mime_type, .. } => {
                format!("[MCP image {mime_type} retained; this text does not expose its pixels.]")
            }
            McpResultBlock::Audio { mime_type, .. } => {
                format!("[MCP audio {mime_type} retained; this text does not expose its sound.]")
            }
            McpResultBlock::Unavailable { reason } => {
                format!("[MCP content unavailable: {reason}]")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    // Keep bounded textual responses compatible without duplicating raw media.
    let raw_result = if blocks
        .iter()
        .all(|block| matches!(block, McpResultBlock::Text { .. }))
        && result.to_string().len() <= MAX_RESULT_BYTES
    {
        result
    } else {
        json!({ "isError": is_error, "code": result.get("code").and_then(Value::as_str).map(|s| s.chars().take(128).collect::<String>()) })
    };
    McpCallToolResponse {
        content,
        blocks,
        is_error,
        raw_result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_matches_the_frontend_and_sdk_contract() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/typed-result.json")).unwrap();
        let result = normalize_tool_call_result(fixture.clone());
        assert_eq!(
            serde_json::to_value(&result.blocks).unwrap(),
            fixture["content"]
        );
        assert!(result.is_error);
    }

    #[test]
    fn preserves_mixed_content_and_errors() {
        let result = normalize_tool_call_result(json!({"isError":true,"content":[
            {"type":"text","text":"hello"},
            {"type":"image","mimeType":"image/png","data":"aGk="},
            {"type":"audio","mimeType":"audio/wav","data":"aGk="}]}));
        assert!(result.is_error);
        assert!(matches!(result.blocks[1], McpResultBlock::Image { .. }));
        assert!(matches!(result.blocks[2], McpResultBlock::Audio { .. }));
        assert!(!result.content.contains("aGk="));
    }
    #[test]
    fn rejects_invalid_and_oversized_blocks_without_echoing_them() {
        for block in [
            json!({"type":"image","mimeType":"text/html","data":"aGk="}),
            json!({"type":"audio","mimeType":"audio/wav","data":"!!!"}),
            json!({"type":"resource_link","uri":"file:///secret"}),
            json!({"type":"text","text":"a".repeat(MAX_RESULT_BYTES+1)}),
        ] {
            let result = normalize_tool_call_result(json!({"content":[block]}));
            assert!(result.is_error);
            assert!(matches!(
                result.blocks[0],
                McpResultBlock::Unavailable { .. }
            ));
            assert!(result.content.len() < 200);
        }
    }
}
