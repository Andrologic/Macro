use super::*;
#[path = "pilot_capture/core.rs"]
mod core;
#[path = "pilot_capture/verdict.rs"]
mod verdict;
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

/// Detection-only secrets use the existing vault, including provider OAuth and MCP
/// values. Never log this result or store it in a Pilot capture journal.
#[tauri::command]
pub fn pilot_content_policy() -> CaptureResult<Vec<String>> {
    if !cfg!(unix) || std::env::var_os("WSL_INTEROP").is_some() {
        return Err("content_unavailable".into());
    }
    let mut values = Vec::new();
    for entry in crate::secrets::list_secret_metadata().map_err(unavailable)? {
        match entry.secret_type.as_str() {
            "apiKey" => {
                if let Some(value) = crate::secrets::get_api_key(&entry.id).map_err(unavailable)? {
                    values.push(value);
                }
            }
            "chatgptSession" => {
                if let Some(value) =
                    crate::secrets::get_chatgpt_secret(&entry.id).map_err(unavailable)?
                {
                    values.push(value.access_token);
                    values.push(value.refresh_token);
                }
            }
            _ => return Err("content_unavailable".into()),
        }
    }
    if values.len() > 4096 || values.iter().map(String::len).sum::<usize>() > 1024 * 1024 {
        return Err("resource_limit".into());
    }
    Ok(values)
}

#[tauri::command]
pub async fn pilot_review_commit(
    pool: State<'_, crate::commands::DbPool>,
    git_state: State<'_, GitState>,
    input: verdict::VerdictCommit,
) -> CaptureResult<bool> {
    let pool = crate::commands::get_pool(&pool)
        .await
        .map_err(unavailable)?;
    let state = git_state.inner().clone();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let path = capture_path(&input.snapshot_id)?;
        let repo = state.open_repo(&path).map_err(unavailable)?;
        let repo = repo.lock().map_err(unavailable)?;
        let expected_secrets = input.request.secret_values.clone();
        runtime.block_on(verdict::commit(&pool, &repo, input, || {
            // Recheck after waiting for SQLite and immediately before commit.
            if pilot_content_policy()?
                .iter()
                .any(|value| !value.is_empty() && !expected_secrets.contains(value))
            {
                return Err("stale_revision".into());
            }
            Ok(())
        }))
    })
    .await
    .map_err(unavailable)?
}
