use crate::commands::{command_error, CommandResult};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

pub(crate) const MCP_STDIO_PROTOCOL_VERSION: &str = "2025-11-25";
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const KNOWN_LEGACY_PROTOCOL_VERSIONS: [&str; 5] = [
    "2024-10-07",
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
];

fn is_supported_legacy_protocol_version(version: &str) -> bool {
    KNOWN_LEGACY_PROTOCOL_VERSIONS.contains(&version)
}

pub(crate) async fn write_message<W: AsyncWrite + Unpin>(
    writer: &mut W,
    payload: &Value,
) -> CommandResult<()> {
    let mut body = serde_json::to_vec(payload)
        .map_err(|error| command_error(format!("Failed to encode MCP message: {}", error)))?;
    body.push(b'\n');
    writer
        .write_all(&body)
        .await
        .map_err(|error| command_error(format!("Failed to write MCP message: {}", error)))?;
    writer
        .flush()
        .await
        .map_err(|error| command_error(format!("Failed to flush MCP message: {}", error)))?;
    Ok(())
}

async fn read_line_bounded<R>(reader: &mut R) -> CommandResult<Option<String>>
where
    R: AsyncBufRead + Unpin,
{
    let mut line: Vec<u8> = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|error| {
            command_error(format!("Failed to read MCP stdio output: {}", error))
        })?;
        if available.is_empty() {
            break;
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if line.len() + newline > MAX_MESSAGE_BYTES {
                return Err(command_error(format!(
                    "MCP stdio message exceeds the maximum length of {} bytes.",
                    MAX_MESSAGE_BYTES
                )));
            }
            line.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            return String::from_utf8(line).map(Some).map_err(|error| {
                command_error(format!("MCP stdio message is not valid UTF-8: {}", error))
            });
        }
        if line.len() + available.len() > MAX_MESSAGE_BYTES {
            return Err(command_error(format!(
                "MCP stdio message exceeds the maximum length of {} bytes.",
                MAX_MESSAGE_BYTES
            )));
        }
        line.extend_from_slice(available);
        let filled = available.len();
        reader.consume(filled);
    }
    if line.is_empty() {
        return Ok(None);
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|error| command_error(format!("MCP stdio message is not valid UTF-8: {}", error)))
}

async fn read_message<R>(reader: &mut R) -> CommandResult<Value>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let Some(line) = read_line_bounded(reader).await? else {
            return Err(command_error("MCP server closed stdout before responding."));
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        return serde_json::from_str(trimmed).map_err(|error| {
            command_error(format!("Failed to parse MCP NDJSON message: {}", error))
        });
    }
}

async fn respond_to_server_request<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &Value,
) -> CommandResult<()> {
    let id = frame.get("id").cloned().unwrap_or(Value::Null);
    let payload = if frame.get("method").and_then(Value::as_str) == Some("ping") {
        json!({ "jsonrpc": "2.0", "id": id, "result": {} })
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "Method not found." }
        })
    };
    write_message(writer, &payload).await
}

pub(crate) async fn read_response<W, R>(
    writer: &mut W,
    reader: &mut R,
    expected_id: i64,
) -> CommandResult<Value>
where
    W: AsyncWrite + Unpin,
    R: AsyncBufRead + Unpin,
{
    loop {
        let frame = read_message(reader).await?;
        if frame.get("method").is_some() {
            if frame.get("id").is_some() {
                respond_to_server_request(writer, &frame).await?;
            }
            continue;
        }
        match frame.get("id").and_then(Value::as_i64) {
            Some(id) if id == expected_id => {
                if let Some(error) = frame.get("error") {
                    return Err(command_error(format!(
                        "MCP server returned error: {}",
                        error
                    )));
                }
                return frame
                    .get("result")
                    .cloned()
                    .ok_or_else(|| command_error("MCP response is missing result."));
            }
            other => {
                return Err(command_error(format!(
                    "MCP server replied with unexpected response id {:?} instead of {}.",
                    other, expected_id
                )));
            }
        }
    }
}

pub(crate) async fn initialize<W, R>(writer: &mut W, reader: &mut R) -> CommandResult<()>
where
    W: AsyncWrite + Unpin,
    R: AsyncBufRead + Unpin,
{
    write_message(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_STDIO_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "Macro", "version": env!("CARGO_PKG_VERSION") }
            }
        }),
    )
    .await?;
    let result = read_response(writer, reader, 1).await?;
    let negotiated = result
        .get("protocolVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| command_error("MCP initialize response is missing protocolVersion."))?;
    if !is_supported_legacy_protocol_version(negotiated) {
        return Err(command_error(format!(
            "MCP server negotiated unsupported protocol version '{}'. Macro supports: {}.",
            negotiated,
            KNOWN_LEGACY_PROTOCOL_VERSIONS.join(", ")
        )));
    }
    write_message(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tokio::io::BufReader;

    fn ndjson_reader(lines: &[&str]) -> BufReader<Cursor<Vec<u8>>> {
        let mut bytes = lines.join("\n").into_bytes();
        bytes.push(b'\n');
        BufReader::new(Cursor::new(bytes))
    }

    #[test]
    fn accepts_only_known_legacy_protocol_versions() {
        assert!(is_supported_legacy_protocol_version("2024-10-07"));
        assert!(is_supported_legacy_protocol_version("2024-11-05"));
        assert!(is_supported_legacy_protocol_version("2025-03-26"));
        assert!(is_supported_legacy_protocol_version("2025-06-18"));
        assert!(is_supported_legacy_protocol_version("2025-11-25"));
        for unsupported in ["2026-07-28", "2099-01-01", "", "latest"] {
            assert!(
                !is_supported_legacy_protocol_version(unsupported),
                "{unsupported}"
            );
        }
    }

    #[tokio::test]
    async fn reads_ndjson_messages_and_skips_blank_lines() {
        let mut reader = ndjson_reader(&[
            "",
            r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#,
        ]);

        let notification = read_message(&mut reader).await.expect("read message");
        assert_eq!(notification["method"], "notifications/progress");

        let response = read_message(&mut reader).await.expect("read message");
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["ok"], true);

        let error = read_message(&mut reader)
            .await
            .expect_err("eof should be reported");
        assert!(error.message.contains("closed stdout"));
    }

    #[tokio::test]
    async fn rejects_content_length_framing() {
        let mut body = br#"{"jsonrpc":"2.0","id":7,"result":{}}"#.to_vec();
        let raw = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut framed = raw.into_bytes();
        framed.append(&mut body);
        framed.push(b'\n');
        let mut reader = BufReader::new(Cursor::new(framed));

        let error = read_message(&mut reader)
            .await
            .expect_err("Content-Length framing must be rejected");
        assert!(error.message.contains("Failed to parse MCP NDJSON message"));
    }

    #[tokio::test]
    async fn rejects_oversized_lines() {
        let mut oversized = vec![b'a'; MAX_MESSAGE_BYTES + 1];
        oversized.push(b'\n');
        let mut reader = BufReader::new(Cursor::new(oversized));

        let error = read_message(&mut reader)
            .await
            .expect_err("oversized line must be rejected");
        assert!(error.message.contains("maximum length"));
    }

    #[tokio::test]
    async fn rejects_malformed_json_lines() {
        let mut reader = ndjson_reader(&["not-json"]);

        let error = read_message(&mut reader)
            .await
            .expect_err("malformed json must be rejected");
        assert!(error.message.contains("Failed to parse MCP NDJSON message"));
    }

    #[tokio::test]
    async fn drains_notifications_answers_ping_and_rejects_unsupported_server_requests() {
        let mut writer = Cursor::new(Vec::new());
        let mut reader = ndjson_reader(&[
            r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}"#,
            r#"{"jsonrpc":"2.0","id":"srv-1","method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":7,"method":"roots/list"}"#,
            r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#,
        ]);

        let result = read_response(&mut writer, &mut reader, 7)
            .await
            .expect("read response");
        assert_eq!(result["ok"], true);

        let written = String::from_utf8(writer.into_inner()).expect("utf8 replies");
        assert!(written.contains(r#""id":"srv-1""#), "{written}");
        assert!(written.contains(r#""result":{}"#), "{written}");
        assert!(written.contains("-32601"), "{written}");
        assert!(written.contains(r#""id":7,"#), "{written}");
    }

    #[tokio::test]
    async fn fails_fast_on_wrong_response_ids() {
        let mut writer = Cursor::new(Vec::new());
        let mut reader = ndjson_reader(&[r#"{"jsonrpc":"2.0","id":99,"result":{"ok":true}}"#]);

        let error = read_response(&mut writer, &mut reader, 7)
            .await
            .expect_err("wrong id must be rejected");
        assert!(
            error.message.contains("unexpected response id"),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn proposes_latest_legacy_version_and_accepts_negotiated_downgrade() {
        let mut writer = Cursor::new(Vec::new());
        let mut reader = ndjson_reader(&[
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}"#,
        ]);

        initialize(&mut writer, &mut reader)
            .await
            .expect("initialize should succeed");

        let written = String::from_utf8(writer.into_inner()).expect("utf8 messages");
        assert!(
            written.contains(r#""protocolVersion":"2025-11-25""#),
            "{written}"
        );
        assert!(written.contains("notifications/initialized"), "{written}");
    }

    #[tokio::test]
    async fn rejects_unsupported_negotiated_protocol_versions() {
        let mut writer = Cursor::new(Vec::new());
        let mut reader = ndjson_reader(&[
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2026-07-28"}}"#,
        ]);

        let error = initialize(&mut writer, &mut reader)
            .await
            .expect_err("modern-era negotiation must fail the legacy baseline");
        assert!(error.message.contains("unsupported protocol version"));
        let written = String::from_utf8(writer.into_inner()).expect("utf8 messages");
        assert!(!written.contains("notifications/initialized"), "{written}");
    }

    #[tokio::test]
    async fn rejects_initialize_responses_missing_protocol_version() {
        let mut writer = Cursor::new(Vec::new());
        let mut reader =
            ndjson_reader(&[r#"{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}"#]);

        let error = initialize(&mut writer, &mut reader)
            .await
            .expect_err("missing protocolVersion must be rejected");
        assert!(error.message.contains("missing protocolVersion"));
    }
}
