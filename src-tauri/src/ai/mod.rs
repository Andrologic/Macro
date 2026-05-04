pub mod chatgpt;
pub mod copilot;
pub mod openai_compatible;
pub mod reasoning_catalog;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
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

#[derive(Clone, Debug)]
pub struct CopilotRuntimeCache {
    pub manifest_version: String,
    pub platform_key: String,
    pub path: PathBuf,
    pub version: String,
    pub source: String,
    pub validated_at: Instant,
}

#[derive(Clone, Default)]
pub struct AiState {
    pub stream_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub copilot_tool_writers: Arc<Mutex<HashMap<String, Arc<Mutex<ChildStdin>>>>>,
    pub copilot_runtime_cache: Arc<Mutex<Option<CopilotRuntimeCache>>>,
    pub auth_tasks: Arc<Mutex<HashMap<String, AuthTask>>>,
    pub download_tasks: Arc<Mutex<HashMap<String, DownloadTask>>>,
}

pub fn emit_timeline(
    app_handle: &AppHandle,
    request_id: &str,
    provider_id: &str,
    provider_type: &str,
    started_at: Instant,
    phase: &str,
) {
    let elapsed_ms = started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let _ = app_handle.emit(
        "ai:timeline",
        chatgpt::types::AiStreamTimelineEvent {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            provider_type: provider_type.to_string(),
            phase: phase.to_string(),
            elapsed_ms,
        },
    );
}

#[derive(Clone)]
pub struct ProviderTimeline {
    app_handle: AppHandle,
    request_id: String,
    provider_id: String,
    provider_type: String,
    started_at: Instant,
}

impl ProviderTimeline {
    pub fn new(
        app_handle: &AppHandle,
        request_id: &str,
        provider_id: &str,
        provider_type: &str,
        started_at: Instant,
    ) -> Self {
        Self {
            app_handle: app_handle.clone(),
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            provider_type: provider_type.to_string(),
            started_at,
        }
    }

    pub fn emit(&self, phase: &str) {
        emit_timeline(
            &self.app_handle,
            &self.request_id,
            &self.provider_id,
            &self.provider_type,
            self.started_at,
            phase,
        );
    }
}
