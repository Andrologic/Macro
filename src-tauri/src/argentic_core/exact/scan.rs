// SPDX-License-Identifier: Apache-2.0
//! Byte-oriented JSON scanner. Rust translation of the AgSDL scanners vendored
//! in `src/vendor/agsdl/shared/json.mjs` (AgSDL 0.2.0),
//! `src/vendor/agsdl/experimental/readers/javascript/json.mjs` (AgSDL 0.1.0)
//! and `src/vendor/agsdl/v0.3/json.mjs` (AgSDL 0.3.0). Provenance and license:
//! `src/vendor/agsdl/NOTICE.md`, `src/vendor/agsdl/LICENSE`,
//! `src/vendor/agsdl/v0.3/LICENSE`.
//!
//! The three JS scanners accept the same bytes and report the same first
//! failing byte; only their object member order differs. The shared and
//! experimental scanners build ordinary JS objects (array-index keys first,
//! ascending, then insertion order); the 0.3 scanner keeps insertion order for
//! every key. Number lexemes are kept as authored. The scanner is iterative.
use super::{NumberToken, Object, Value};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ParseError {
    pub(crate) byte: usize,
}

impl ParseError {
    /// Message of the JS `ParseError`.
    pub(crate) fn message(&self) -> String {
        format!("Invalid JSON at byte {}", self.byte)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyOrder {
    /// Ordinary JS object member order.
    Js,
    /// The 0.3 scanner's ordered records.
    Insertion,
}

/// Source byte range of one value, keyed by its JSON pointer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub(crate) pointer: String,
    pub(crate) start: usize,
    pub(crate) end: usize,
}

pub(crate) struct Parsed {
    pub(crate) tree: Value,
    /// Path tree: `(parent, escaped segment)`; entry 0 is the root pointer.
    paths: Vec<(usize, String)>,
    /// `(path, start, end)` in the insertion order of the JS `spans` map.
    spans: Vec<(usize, usize, usize)>,
}

impl Parsed {
    /// Materializes the pointers of the JS `spans` map, in its order.
    pub(crate) fn spans(&self) -> Vec<Span> {
        self.spans
            .iter()
            .map(|&(path, start, end)| {
                let mut segments = Vec::new();
                let mut at = path;
                while at != 0 {
                    let (parent, segment) = &self.paths[at];
                    segments.push(segment.as_str());
                    at = *parent;
                }
                let mut pointer = String::new();
                for segment in segments.iter().rev() {
                    pointer.push('/');
                    pointer.push_str(segment);
                }
                Span {
                    pointer,
                    start,
                    end,
                }
            })
            .collect()
    }
}

/// `pointer(p, k)` of the scanners: escape `~`, then `/`.
pub(crate) fn pointer(path: &str, key: &str) -> String {
    format!("{path}/{}", escape(key))
}

fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// `shared/json.mjs` `parse`, used by `exact.decode`.
pub(crate) fn parse_shared(bytes: &[u8]) -> Result<Parsed, ParseError> {
    parse(bytes, KeyOrder::Js)
}

/// `experimental/readers/javascript/json.mjs` `parse`: same algorithm and
/// object order as the shared scanner.
pub(crate) fn parse_experimental(bytes: &[u8]) -> Result<Parsed, ParseError> {
    parse(bytes, KeyOrder::Js)
}

/// `v0.3/json.mjs` `parse`: insertion-ordered records.
pub(crate) fn parse_v030(bytes: &[u8]) -> Result<Parsed, ParseError> {
    parse(bytes, KeyOrder::Insertion)
}

/// Canonical JS array index (`0` to `2^32 - 2`), which ordinary objects list
/// first in ascending order.
pub(crate) fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    (value < u64::from(u32::MAX)).then_some(value as u32)
}

/// Member order of an ordinary JS object created by inserting `entries`.
pub(crate) fn js_object_order(entries: Vec<(String, Value)>) -> Vec<(String, Value)> {
    let (mut indexed, named): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|(key, _)| array_index(key).is_some());
    indexed.sort_by_key(|(key, _)| array_index(key));
    indexed.extend(named);
    indexed
}

#[derive(PartialEq, Eq)]
enum State {
    First,
    After,
    Next,
}

struct Frame {
    object: bool,
    items: Vec<Value>,
    entries: Vec<(String, Value)>,
    keys: HashSet<String>,
    path: usize,
    start: usize,
    state: State,
}

impl Frame {
    fn finish(self, order: KeyOrder) -> Value {
        if !self.object {
            return Value::Array(self.items);
        }
        let entries = match order {
            KeyOrder::Js => js_object_order(self.entries),
            KeyOrder::Insertion => self.entries,
        };
        Value::Object(Object::from_unique_entries(entries))
    }
}

fn bad<T>(byte: usize) -> Result<T, ParseError> {
    Err(ParseError { byte })
}

struct Scanner<'a> {
    b: &'a [u8],
    i: usize,
}

impl Scanner<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn byte_at(&self, at: usize) -> Option<u8> {
        self.b.get(at).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn digit(&self) -> bool {
        matches!(self.peek(), Some(b'0'..=b'9'))
    }

    fn digits(&mut self) {
        while self.digit() {
            self.i += 1;
        }
    }

    /// One UTF-8 scalar, refusing overlong forms, surrogates and values past
    /// U+10FFFF at the byte where the JS scanner refuses them.
    fn scalar(&mut self) -> Result<char, ParseError> {
        let start = self.i;
        let Some(a) = self.peek() else {
            return bad(start);
        };
        self.i += 1;
        if a < 128 {
            return Ok(char::from(a));
        }
        let n = match a {
            0xc2..=0xdf => 1,
            0xe0..=0xef => 2,
            0xf0..=0xf4 => 3,
            _ => return bad(start),
        };
        let mut cp = u32::from(a) & (0x7f >> (n + 1));
        for j in 0..n {
            let Some(c) = self.peek() else {
                return bad(self.b.len());
            };
            if !(0x80..=0xbf).contains(&c) {
                return bad(self.i);
            }
            if j == 0
                && ((a == 0xe0 && c < 0xa0)
                    || (a == 0xed && c >= 0xa0)
                    || (a == 0xf0 && c < 0x90)
                    || (a == 0xf4 && c >= 0x90))
            {
                return bad(self.i);
            }
            cp = (cp << 6) | u32::from(c & 63);
            self.i += 1;
        }
        char::from_u32(cp).map_or_else(|| bad(start), Ok)
    }

    fn hex(&mut self) -> Result<u32, ParseError> {
        let mut value = 0;
        for _ in 0..4 {
            let Some(digit) = self.peek().and_then(|c| char::from(c).to_digit(16)) else {
                return bad(self.i);
            };
            value = value * 16 + digit;
            self.i += 1;
        }
        Ok(value)
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.i += 1;
        let mut s = String::new();
        while let Some(c) = self.peek() {
            if c == b'"' {
                self.i += 1;
                return Ok(s);
            }
            if c < 32 {
                return bad(self.i);
            }
            if c != b'\\' {
                s.push(self.scalar()?);
                continue;
            }
            self.i += 1;
            let at = self.i;
            let escape = self.byte_at(self.i);
            self.i += 1;
            let short = match escape {
                Some(b'"') => Some('"'),
                Some(b'\\') => Some('\\'),
                Some(b'/') => Some('/'),
                Some(b'b') => Some('\u{8}'),
                Some(b'f') => Some('\u{c}'),
                Some(b'n') => Some('\n'),
                Some(b'r') => Some('\r'),
                Some(b't') => Some('\t'),
                _ => None,
            };
            if let Some(short) = short {
                s.push(short);
                continue;
            }
            if escape != Some(b'u') {
                return bad(at.min(self.b.len()));
            }
            let mut cp = self.hex()?;
            if (0xd800..=0xdbff).contains(&cp) {
                if self.byte_at(self.i) != Some(b'\\') || self.byte_at(self.i + 1) != Some(b'u') {
                    return bad(at - 1);
                }
                self.i += 2;
                let low = self.hex()?;
                if !(0xdc00..=0xdfff).contains(&low) {
                    return bad(at - 1);
                }
                cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
            } else if (0xdc00..=0xdfff).contains(&cp) {
                return bad(at - 1);
            }
            s.push(char::from_u32(cp).map_or_else(|| bad(at - 1), Ok)?);
        }
        bad(self.i)
    }

    fn number(&mut self) -> Result<NumberToken, ParseError> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        if self.peek() == Some(b'0') {
            self.i += 1;
        } else {
            if !matches!(self.peek(), Some(b'1'..=b'9')) {
                return bad(self.i);
            }
            self.digits();
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if !self.digit() {
                return bad(self.i);
            }
            self.digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !self.digit() {
                return bad(self.i);
            }
            self.digits();
        }
        // The grammar admits ASCII only.
        Ok(NumberToken::from_scanned(
            String::from_utf8_lossy(&self.b[start..self.i]).into_owned(),
        ))
    }

    /// Reads a scalar, or opens a container frame and returns `None`.
    fn value(
        &mut self,
        path: usize,
        frames: &mut Vec<Frame>,
        spans: &mut Vec<(usize, usize, usize)>,
    ) -> Result<Option<Value>, ParseError> {
        self.ws();
        let start = self.i;
        let value = match self.peek() {
            Some(open @ (b'{' | b'[')) => {
                self.i += 1;
                frames.push(Frame {
                    object: open == b'{',
                    items: Vec::new(),
                    entries: Vec::new(),
                    keys: HashSet::new(),
                    path,
                    start,
                    state: State::First,
                });
                return Ok(None);
            }
            Some(b'"') => Value::String(self.string()?),
            Some(first @ (b't' | b'f' | b'n')) => {
                let literal: &[u8] = match first {
                    b't' => b"true",
                    b'f' => b"false",
                    _ => b"null",
                };
                for &c in literal {
                    if self.peek() != Some(c) {
                        return bad(self.i);
                    }
                    self.i += 1;
                }
                match first {
                    b't' => Value::Bool(true),
                    b'f' => Value::Bool(false),
                    _ => Value::Null,
                }
            }
            Some(b'-' | b'0'..=b'9') => Value::Number(self.number()?),
            _ => return bad(self.i),
        };
        spans.push((path, start, self.i));
        Ok(Some(value))
    }
}

/// Places a completed value in its parent frame, or returns it as the root.
fn attach(frames: &mut [Frame], value: Value) -> Option<Value> {
    let Some(parent) = frames.last_mut() else {
        return Some(value);
    };
    if parent.object {
        // The key was recorded with a placeholder when it was read.
        if let Some(entry) = parent.entries.last_mut() {
            entry.1 = value;
        }
    } else {
        parent.items.push(value);
    }
    None
}

fn parse(bytes: &[u8], order: KeyOrder) -> Result<Parsed, ParseError> {
    let mut scanner = Scanner { b: bytes, i: 0 };
    let mut paths = vec![(0, String::new())];
    let mut spans = Vec::new();
    let mut frames: Vec<Frame> = Vec::new();
    let mut root = scanner.value(0, &mut frames, &mut spans)?;
    while let Some(frame) = frames.last_mut() {
        scanner.ws();
        let close = if frame.object { b'}' } else { b']' };
        if frame.state == State::After {
            if scanner.peek() == Some(b',') {
                scanner.i += 1;
                frame.state = State::Next;
                scanner.ws();
            } else if scanner.peek() != Some(close) {
                return bad(scanner.i);
            }
        }
        if scanner.peek() == Some(close) && frame.state != State::Next {
            scanner.i += 1;
            if let Some(closed) = frames.pop() {
                spans.push((closed.path, closed.start, scanner.i));
                if let Some(value) = attach(&mut frames, closed.finish(order)) {
                    root = Some(value);
                }
            }
            continue;
        }
        let segment = if frame.object {
            if scanner.peek() != Some(b'"') {
                return bad(scanner.i);
            }
            let key_at = scanner.i;
            let key = scanner.string()?;
            if frame.keys.contains(&key) {
                return bad(key_at);
            }
            scanner.ws();
            let colon = scanner.peek();
            scanner.i += 1;
            if colon != Some(b':') {
                return bad(scanner.i - 1);
            }
            let segment = escape(&key);
            frame.keys.insert(key.clone());
            frame.entries.push((key, Value::Null));
            segment
        } else {
            frame.items.len().to_string()
        };
        frame.state = State::After;
        paths.push((frame.path, segment));
        let path = paths.len() - 1;
        if let Some(value) = scanner.value(path, &mut frames, &mut spans)? {
            attach(&mut frames, value);
        }
    }
    scanner.ws();
    if scanner.i != bytes.len() {
        return bad(scanner.i);
    }
    match root {
        Some(tree) => Ok(Parsed { tree, paths, spans }),
        // A completed scan always yields a root value.
        None => bad(scanner.i),
    }
}

/// End of the JSON number lexeme starting at `start`, if one is there.
pub(super) fn number_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut scanner = Scanner { b: bytes, i: start };
    scanner.number().ok().map(|_| scanner.i)
}

#[cfg(test)]
mod tests {
    use super::super::stringify;
    use super::*;

    fn error(text: &[u8]) -> usize {
        parse_v030(text).err().unwrap().byte
    }

    #[test]
    fn object_order_depends_on_the_scanner() {
        // src/vendor/agsdl/v0.3/diagnosticOrder.test.ts
        let source = r#"{"other":0,"2":9007199254740993,"1":0,"nested":{"9":0,"8":1}}"#;
        assert_eq!(
            stringify(&parse_v030(source.as_bytes()).unwrap().tree),
            source
        );
        assert_eq!(
            stringify(&parse_shared(source.as_bytes()).unwrap().tree),
            r#"{"1":0,"2":9007199254740993,"other":0,"nested":{"8":1,"9":0}}"#
        );
        let keys = r#"{"4294967295":0,"4294967294":1,"01":2,"10":3,"-0":4,"0":5}"#;
        assert_eq!(
            stringify(&parse_shared(keys.as_bytes()).unwrap().tree),
            r#"{"0":5,"10":3,"4294967294":1,"4294967295":0,"01":2,"-0":4}"#
        );
    }

    #[test]
    fn spans_follow_the_js_map_order() {
        let parsed = parse_v030(br#" {"a/b":[1, "x"],"~":{}} "#).unwrap();
        let spans: Vec<_> = parsed
            .spans()
            .into_iter()
            .map(|s| (s.pointer, s.start, s.end))
            .collect();
        assert_eq!(
            spans,
            [
                ("/a~1b/0".into(), 9, 10),
                ("/a~1b/1".into(), 12, 15),
                ("/a~1b".into(), 8, 16),
                ("/~0".into(), 21, 23),
                (String::new(), 1, 24)
            ]
        );
    }

    #[test]
    fn first_failing_byte_matches_the_js_scanner() {
        for (text, byte) in [
            (&b""[..], 0),
            (b"[1 2]", 3),
            (b"[1,]", 3),
            (b"{,}", 1),
            (b"{\"a\":1,}", 7),
            (b"{\"a\" 1}", 5),
            (b"{\"a\":1,\"\\u0061\":2}", 7),
            (b"\xef\xbb\xbf{}", 0),
            (b"\"\xc0\x80\"", 1),
            (b"\"\xe0\x80\x80\"", 2),
            (b"\"\xed\xa0\x80\"", 2),
            (b"\"\xf4\x90\x80\x80\"", 2),
            (b"\"\xe2\x82", 3),
            (b"\"\\uD800\"", 1),
            (b"\"\\uDC00\"", 1),
            (b"\"\\uD800\\u0041\"", 1),
            (b"\"\\uZZZZ\"", 3),
            (b"\"\\x\"", 2),
            (b"\"\\", 2),
            (b"\"a\nb\"", 2),
            (b"01", 1),
            (b"-", 1),
            (b"1.", 2),
            (b"1e+", 3),
            (b"tru", 3),
            (b"nul1", 3),
            (b"[1] x", 4),
        ] {
            assert_eq!(error(text), byte, "{:?}", String::from_utf8_lossy(text));
            assert_eq!(parse_shared(text).err().unwrap().byte, byte);
        }
        assert_eq!(ParseError { byte: 7 }.message(), "Invalid JSON at byte 7");
    }

    #[test]
    fn deep_v030_documents_parse_iteratively() {
        // src/vendor/agsdl/v0.3/exact.test.ts uses 4000 levels.
        let source = format!(
            "{}1e100000000000000000000{}",
            "[".repeat(4000),
            "]".repeat(4000)
        );
        assert_eq!(
            stringify(&parse_v030(source.as_bytes()).unwrap().tree),
            source
        );
        assert_eq!(error(format!("{}0", "[".repeat(4000)).as_bytes()), 4001);
    }
}
