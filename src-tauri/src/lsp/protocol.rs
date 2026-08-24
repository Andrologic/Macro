use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Number(i64),
    String(String),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct JsonRpcErrorObject {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcErrorObject {
    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("Method not found: {method}"),
            data: None,
        }
    }

    pub fn internal_error(message: impl Into<String>) -> Self {
        Self {
            code: -32603,
            message: message.into(),
            data: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ServerRequest {
    pub id: JsonRpcId,
    pub method: String,
    pub params: Value,
    pub cancellation: CancellationToken,
}

#[derive(Clone, Debug)]
pub enum ServerRequestResult {
    Result(Value),
    Error(JsonRpcErrorObject),
    Unhandled,
}

pub type ServerRequestFuture = Pin<Box<dyn Future<Output = ServerRequestResult> + Send + 'static>>;

pub trait ServerRequestHandler: Send + Sync + 'static {
    fn handle(&self, request: ServerRequest) -> ServerRequestFuture;
}
