pub mod chatgpt;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{watch, Mutex};

pub struct AuthTask {
    pub provider_id: String,
    pub handle: tokio::task::JoinHandle<()>,
    pub cancel_sender: watch::Sender<bool>,
}

#[derive(Clone, Default)]
pub struct AiState {
    pub stream_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub auth_tasks: Arc<Mutex<HashMap<String, AuthTask>>>,
}
