use super::error::FramingError;
use serde_json::Value;

pub const DEFAULT_MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_MAX_HEADER_BYTES: usize = 8 * 1024;
const HEADER_TERMINATOR: &[u8; 4] = b"\r\n\r\n";

#[derive(Debug)]
pub struct LspFramer {
    buffer: Vec<u8>,
    pending_body: Option<(usize, usize)>,
    max_message_bytes: usize,
    max_header_bytes: usize,
}

impl LspFramer {
    pub fn new(max_message_bytes: usize, max_header_bytes: usize) -> Result<Self, FramingError> {
        if max_message_bytes == 0 {
            return Err(FramingError::InvalidContentLength {
                value: "maximum message size is zero".to_string(),
            });
        }
        if max_header_bytes == 0 {
            return Err(FramingError::HeaderTooLarge { max_bytes: 0 });
        }
        Ok(Self {
            buffer: Vec::new(),
            pending_body: None,
            max_message_bytes,
            max_header_bytes,
        })
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, FramingError> {
        let mut messages = Vec::new();
        let mut offset = 0;
        let max_buffer_bytes = self
            .max_header_bytes
            .saturating_add(HEADER_TERMINATOR.len())
            .saturating_add(self.max_message_bytes);

        while offset < chunk.len() {
            self.drain_complete(&mut messages)?;
            let available = max_buffer_bytes.saturating_sub(self.buffer.len());
            if available == 0 {
                return self.buffer_limit_error();
            }
            let take = available.min(chunk.len() - offset);
            self.buffer.extend_from_slice(&chunk[offset..offset + take]);
            offset += take;
            self.drain_complete(&mut messages)?;
        }

        self.validate_partial_buffer()?;
        Ok(messages)
    }

    pub fn finish(&self) -> Result<(), FramingError> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let phase = if self.pending_body.is_some() {
            "body"
        } else {
            "header"
        };
        Err(FramingError::UnexpectedEof {
            phase,
            buffered_bytes: self.buffer.len(),
        })
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }

    fn drain_complete(&mut self, messages: &mut Vec<Value>) -> Result<(), FramingError> {
        loop {
            if let Some((body_start, frame_end)) = self.pending_body {
                if self.buffer.len() < frame_end {
                    return Ok(());
                }
                let message = serde_json::from_slice(&self.buffer[body_start..frame_end]).map_err(
                    |error| FramingError::InvalidJson {
                        message: error.to_string(),
                    },
                )?;
                messages.push(message);
                self.buffer = self.buffer.split_off(frame_end);
                self.pending_body = None;
                continue;
            }

            let Some(header_end) = find_header_end(&self.buffer) else {
                self.validate_partial_buffer()?;
                return Ok(());
            };
            if header_end > self.max_header_bytes {
                return Err(FramingError::HeaderTooLarge {
                    max_bytes: self.max_header_bytes,
                });
            }

            let body_length = parse_content_length(&self.buffer[..header_end])?;
            if body_length > self.max_message_bytes {
                return Err(FramingError::MessageTooLarge {
                    length: body_length,
                    max_bytes: self.max_message_bytes,
                });
            }
            let body_start = header_end + HEADER_TERMINATOR.len();
            let frame_end = body_start.checked_add(body_length).ok_or_else(|| {
                FramingError::InvalidContentLength {
                    value: body_length.to_string(),
                }
            })?;
            self.pending_body = Some((body_start, frame_end));
        }
    }

    fn validate_partial_buffer(&self) -> Result<(), FramingError> {
        if self.pending_body.is_none()
            && find_header_end(&self.buffer).is_none()
            && self.buffer.len() > self.max_header_bytes
        {
            return Err(FramingError::HeaderTooLarge {
                max_bytes: self.max_header_bytes,
            });
        }
        Ok(())
    }

    fn buffer_limit_error<T>(&self) -> Result<T, FramingError> {
        if self.pending_body.is_none() {
            Err(FramingError::HeaderTooLarge {
                max_bytes: self.max_header_bytes,
            })
        } else {
            Err(FramingError::MessageTooLarge {
                length: self.buffer.len(),
                max_bytes: self.max_message_bytes,
            })
        }
    }
}

pub fn encode_message(message: &Value, max_message_bytes: usize) -> Result<Vec<u8>, FramingError> {
    let body = serde_json::to_vec(message).map_err(|error| FramingError::InvalidJson {
        message: error.to_string(),
    })?;
    if body.len() > max_message_bytes {
        return Err(FramingError::MessageTooLarge {
            length: body.len(),
            max_bytes: max_message_bytes,
        });
    }
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut frame = Vec::with_capacity(header.len() + body.len());
    frame.extend_from_slice(header.as_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(HEADER_TERMINATOR.len())
        .position(|window| window == HEADER_TERMINATOR)
}

fn parse_content_length(header: &[u8]) -> Result<usize, FramingError> {
    let header = std::str::from_utf8(header).map_err(|error| FramingError::MalformedHeader {
        line: error.to_string(),
    })?;
    let mut content_length = None;
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            return Err(FramingError::MalformedHeader {
                line: line.to_string(),
            });
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            return Err(FramingError::MalformedHeader {
                line: line.to_string(),
            });
        }
        if name.eq_ignore_ascii_case("Content-Length") {
            if content_length.is_some() {
                return Err(FramingError::DuplicateContentLength);
            }
            if !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(FramingError::InvalidContentLength {
                    value: value.to_string(),
                });
            }
            content_length =
                Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| FramingError::InvalidContentLength {
                            value: value.to_string(),
                        })?,
                );
        }
    }
    content_length.ok_or(FramingError::MissingContentLength)
}

#[cfg(test)]
mod tests {
    use super::{encode_message, LspFramer};
    use crate::lsp::FramingError;
    use serde_json::{json, Value};

    fn framer() -> LspFramer {
        LspFramer::new(1024, 256).expect("create framer")
    }

    #[test]
    fn parses_split_headers_and_bodies() {
        let frame = encode_message(&json!({"text": "héllo"}), 1024).expect("encode");
        let header_split = 8;
        let body_split = frame.len() - 3;
        let mut decoder = framer();
        assert!(decoder.push(&frame[..header_split]).unwrap().is_empty());
        assert!(decoder
            .push(&frame[header_split..body_split])
            .unwrap()
            .is_empty());
        assert_eq!(
            decoder.push(&frame[body_split..]).unwrap(),
            vec![json!({"text": "héllo"})]
        );
        decoder.finish().expect("clean EOF");
    }

    #[test]
    fn parses_multiple_messages_in_one_chunk() {
        let mut bytes = encode_message(&json!({"id": 1}), 1024).unwrap();
        bytes.extend(encode_message(&json!({"id": 2}), 1024).unwrap());
        assert_eq!(
            framer().push(&bytes).unwrap(),
            vec![json!({"id": 1}), json!({"id": 2})]
        );
    }

    #[test]
    fn content_length_counts_utf8_bytes() {
        let value = json!({"text": "é"});
        let frame = encode_message(&value, 1024).unwrap();
        let header_end = frame
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap();
        let header = std::str::from_utf8(&frame[..header_end]).unwrap();
        let declared: usize = header
            .trim_start_matches("Content-Length: ")
            .parse()
            .unwrap();
        assert_eq!(declared, serde_json::to_vec(&value).unwrap().len());
        assert_eq!(framer().push(&frame).unwrap(), vec![value]);
    }

    #[test]
    fn rejects_malformed_headers_lengths_json_and_partial_eof() {
        let mut decoder = framer();
        assert!(matches!(
            decoder.push(b"Broken\r\n\r\n{}"),
            Err(FramingError::MalformedHeader { .. })
        ));

        let mut decoder = framer();
        assert!(matches!(
            decoder.push(b"Content-Length: nope\r\n\r\n{}"),
            Err(FramingError::InvalidContentLength { .. })
        ));

        let mut decoder = framer();
        assert!(matches!(
            decoder.push(b"Content-Length: 2\r\n\r\nxx"),
            Err(FramingError::InvalidJson { .. })
        ));

        let mut decoder = framer();
        decoder.push(b"Content-Length: 4\r\n\r\n{").unwrap();
        assert!(matches!(
            decoder.finish(),
            Err(FramingError::UnexpectedEof { phase: "body", .. })
        ));
    }

    #[test]
    fn rejects_oversized_messages_before_reading_the_body() {
        let mut decoder = LspFramer::new(4, 128).unwrap();
        assert_eq!(
            decoder.push(b"Content-Length: 5\r\n\r\n"),
            Err(FramingError::MessageTooLarge {
                length: 5,
                max_bytes: 4,
            })
        );
    }

    #[test]
    fn accepts_arbitrary_json_values() {
        let values: Vec<Value> = vec![json!(null), json!(["one", "two"]), json!(42)];
        for value in values {
            let frame = encode_message(&value, 1024).unwrap();
            assert_eq!(framer().push(&frame).unwrap(), vec![value]);
        }
    }
}
