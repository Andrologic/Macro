use serde_json::Value;
use thiserror::Error;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum FramingError {
    #[error("LSP header exceeded the {max_bytes}-byte limit")]
    HeaderTooLarge { max_bytes: usize },

    #[error("LSP header line is malformed: {line}")]
    MalformedHeader { line: String },

    #[error("LSP message is missing Content-Length")]
    MissingContentLength,

    #[error("LSP message contains more than one Content-Length header")]
    DuplicateContentLength,

    #[error("invalid LSP Content-Length value: {value}")]
    InvalidContentLength { value: String },

    #[error("LSP body length {length} exceeds the {max_bytes}-byte limit")]
    MessageTooLarge { length: usize, max_bytes: usize },

    #[error("LSP body is not valid JSON: {message}")]
    InvalidJson { message: String },

    #[error("unexpected EOF in LSP {phase}; {buffered_bytes} bytes remain buffered")]
    UnexpectedEof {
        phase: &'static str,
        buffered_bytes: usize,
    },
}

#[derive(Clone, Debug, Error)]
pub enum LspError {
    #[error(transparent)]
    Framing(#[from] FramingError),

    #[error("invalid LSP configuration: {message}")]
    InvalidConfiguration { message: String },

    #[error("failed to start LSP executable '{executable}': {message}")]
    Spawn { executable: String, message: String },

    #[error("LSP I/O failed during {operation}: {message}")]
    Io {
        operation: &'static str,
        message: String,
    },

    #[error("invalid LSP protocol message: {message}")]
    Protocol { message: String },

    #[error("LSP request '{method}' failed with JSON-RPC error {code}: {message}")]
    JsonRpc {
        method: String,
        code: i64,
        message: String,
        data: Option<Value>,
    },

    #[error("cannot {operation} while the LSP client is {state}")]
    InvalidState {
        operation: &'static str,
        state: String,
    },

    #[error("LSP request '{method}' timed out after {timeout_ms} ms")]
    RequestTimeout { method: String, timeout_ms: u64 },

    #[error("LSP request '{method}' was cancelled")]
    RequestCancelled { method: String },

    #[error("LSP session is closing")]
    SessionClosing,

    #[error("LSP transport is closed")]
    TransportClosed,

    #[error("LSP server exited with code {code:?}: {stderr}")]
    ProcessExited { code: Option<i32>, stderr: String },

    #[error("LSP server did not terminate after it was killed")]
    ProcessTerminationFailed,

    #[error("invalid document URI '{uri}': {message}")]
    InvalidDocumentUri { uri: String, message: String },

    #[error("invalid transition for document '{uri}': {message}")]
    InvalidDocumentState { uri: String, message: String },

    #[error("document '{uri}' version must be greater than {current}; received {received}")]
    StaleDocumentVersion {
        uri: String,
        current: i64,
        received: i64,
    },

    #[error("invalid edit for document '{uri}': {message}")]
    InvalidDocumentEdit { uri: String, message: String },

    #[error("LSP background task failed: {message}")]
    BackgroundTask { message: String },
}
