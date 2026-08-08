use crate::commands::{command_error, CommandResult};
use serde_json::{json, Value};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
};

pub(crate) async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    payload: &Value,
) -> CommandResult<()> {
    let body = serde_json::to_vec(payload)
        .map_err(|error| command_error(format!("Failed to encode MCP frame: {}", error)))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer
        .write_all(header.as_bytes())
        .await
        .map_err(|error| command_error(format!("Failed to write MCP frame header: {}", error)))?;
    writer
        .write_all(&body)
        .await
        .map_err(|error| command_error(format!("Failed to write MCP frame body: {}", error)))?;
    writer
        .flush()
        .await
        .map_err(|error| command_error(format!("Failed to flush MCP frame: {}", error)))?;
    Ok(())
}

pub(crate) async fn read_frame<R>(reader: &mut R) -> CommandResult<Value>
where
    R: AsyncBufRead + AsyncRead + Unpin,
{
    let mut content_length: Option<usize> = None;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).await.map_err(|error| {
            command_error(format!("Failed to read MCP frame header: {}", error))
        })?;
        if bytes_read == 0 {
            return Err(command_error("MCP server closed stdout before responding."));
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }

        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(value.trim().parse::<usize>().map_err(|error| {
                    command_error(format!("Invalid MCP Content-Length header: {}", error))
                })?);
            }
        }
    }

    let length =
        content_length.ok_or_else(|| command_error("MCP frame is missing Content-Length."))?;
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|error| command_error(format!("Failed to read MCP frame body: {}", error)))?;
    serde_json::from_slice(&body)
        .map_err(|error| command_error(format!("Failed to parse MCP JSON-RPC frame: {}", error)))
}

pub(crate) async fn read_response<R>(reader: &mut R, expected_id: i64) -> CommandResult<Value>
where
    R: AsyncBufRead + AsyncRead + Unpin,
{
    loop {
        let frame = read_frame(reader).await?;
        if frame.get("id").and_then(Value::as_i64) != Some(expected_id) {
            continue;
        }
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
}

pub(crate) async fn initialize<W, R>(writer: &mut W, reader: &mut R) -> CommandResult<()>
where
    W: AsyncWrite + Unpin,
    R: AsyncBufRead + AsyncRead + Unpin,
{
    write_frame(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "Macro", "version": env!("CARGO_PKG_VERSION") }
            }
        }),
    )
    .await?;
    let _ = read_response(reader, 1).await?;
    write_frame(
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
    use tokio::io::BufReader;

    #[tokio::test]
    async fn reads_content_length_json_frames() {
        let body = br#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#;
        let raw = format!("Content-Length: {}\r\n\r\n", body.len());
        let frame_bytes = [raw.as_bytes(), body].concat();
        let mut reader = BufReader::new(frame_bytes.as_slice());

        let frame = read_frame(&mut reader).await.expect("read frame");
        assert_eq!(frame["id"], 7);
        assert_eq!(frame["result"]["ok"], true);
    }
}
