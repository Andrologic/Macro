pub mod chatgpt;
pub mod copilot;
pub mod openai_compatible;
pub mod reasoning_catalog;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::ChildStdin;
use tokio::sync::{watch, Mutex};

pub struct AuthTask {
    pub provider_id: String,
    pub handle: tokio::task::JoinHandle<()>,
    pub cancel_sender: watch::Sender<bool>,
}

pub struct DownloadTask {
    pub provider_id: String,
    pub handle: tokio::task::JoinHandle<()>,
    pub cancel_sender: watch::Sender<bool>,
}

#[derive(Clone, Default)]
pub struct AiState {
    pub stream_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub copilot_tool_writers: Arc<Mutex<HashMap<String, Arc<Mutex<ChildStdin>>>>>,
    pub auth_tasks: Arc<Mutex<HashMap<String, AuthTask>>>,
    pub download_tasks: Arc<Mutex<HashMap<String, DownloadTask>>>,
}
