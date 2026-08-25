use serde_json::Value;

pub(crate) fn format_tool_call_result(result: &Value) -> String {
    let Some(content) = result.get("content").and_then(Value::as_array) else {
        return serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string());
    };

    let parts: Vec<String> = content
        .iter()
        .map(|item| {
            if item.get("type").and_then(Value::as_str) == Some("text") {
                item.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            } else {
                serde_json::to_string(item).unwrap_or_else(|_| item.to_string())
            }
        })
        .filter(|part| !part.trim().is_empty())
        .collect();

    if parts.is_empty() {
        serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string())
    } else {
        parts.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_text_tool_content() {
        let result = json!({
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "text", "text": "world" }
            ]
        });
        assert_eq!(format_tool_call_result(&result), "hello\nworld");
    }

    #[test]
    fn formats_non_text_content_as_json() {
        let result = json!({
            "content": [
                { "type": "image", "data": "abc" }
            ]
        });
        assert_eq!(
            format_tool_call_result(&result),
            r#"{"data":"abc","type":"image"}"#
        );
    }
}
