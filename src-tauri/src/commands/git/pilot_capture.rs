use super::*;
#[path = "pilot_capture/core.rs"]
mod core;
use self::core::*;
fn unavailable<T>(_: T) -> String {
    "content_unavailable".into()
}
#[tauri::command]
pub async fn pilot_review_capture(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    request: PilotCaptureRequest,
) -> CaptureResult<PilotCaptureInfo> {
    if parse_wsl_repo_path(&repo_path).is_some() || !cfg!(unix) {
        return Err("content_unavailable".into());
    }
    let workspace = workspace_root.inner().read().await.clone();
    let state = git_state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let path = validate_repo_path(&repo_path, &workspace).map_err(unavailable)?;
        let repo = state.open_repo(&path).map_err(unavailable)?;
        let repo = repo.lock().map_err(unavailable)?;
        create(&repo, path, request)
    })
    .await
    .map_err(unavailable)?
}
#[tauri::command]
pub async fn pilot_review_fresh(
    git_state: State<'_, GitState>,
    snapshot_id: String,
    request: PilotCaptureRequest,
) -> CaptureResult<bool> {
    let state = git_state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let path = capture_path(&snapshot_id)?;
        let repo = state.open_repo(&path).map_err(unavailable)?;
        let repo = repo.lock().map_err(unavailable)?;
        fresh(&repo, &snapshot_id, &request)
    })
    .await
    .map_err(unavailable)?
}
#[tauri::command]
pub fn pilot_review_files(
    snapshot_id: String,
    cursor: Option<String>,
) -> CaptureResult<PilotCapturePage> {
    core::pilot_review_files(snapshot_id, cursor)
}
#[tauri::command]
pub fn pilot_review_read(
    snapshot_id: String,
    file_id: String,
    offset_bytes: usize,
) -> CaptureResult<PilotCaptureFragment> {
    core::pilot_review_read(snapshot_id, file_id, offset_bytes)
}
#[tauri::command]
pub fn pilot_review_release(snapshot_id: String) -> CaptureResult<()> {
    core::pilot_review_release(snapshot_id)
}
