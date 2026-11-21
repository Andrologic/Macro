//! Application command and wire mirror for the native Codex adapter.
use crate::{config::ConfigManager, db::agsdl_execution::Result};
use tauri::State;
#[tauri::command]
pub(crate) async fn execution_codex_status(
    manager: State<'_, ConfigManager>,
) -> Result<crate::agsdl_host_codex::CodexStatus> {
    Ok(crate::agsdl_host_codex::profile_status(&manager.engine_context()).await)
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexStatus {
    pub available: bool,
    pub code: String,
    pub version: Option<String>,
    pub platform: String,
    pub tool_policy: String,
}
