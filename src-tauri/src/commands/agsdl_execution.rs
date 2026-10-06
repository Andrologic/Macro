//! Product commands have no capture, epoch, admission, effect or commit intake.
use super::DbPool;
use crate::db::agsdl_execution::{self as repository, dto::*};
use tauri::State;
async fn pool(state: &State<'_, DbPool>) -> repository::Result<sqlx::SqlitePool> {
    state
        .wait_until_ready()
        .await
        .map_err(|_| repository::failure("STORAGE", "", "Execution database unavailable"))
}
#[tauri::command]
pub async fn execution_start(
    request: EngineStartRequest,
) -> repository::Result<EngineStartReceipt> {
    let _ = request;
    Err(repository::failure(
        "RUNTIME_UNAVAILABLE",
        "",
        "Trusted execution host is not installed",
    ))
}
#[tauri::command]
pub async fn execution_stop(
    state: State<'_, DbPool>,
    request: EngineStopRequest,
) -> repository::Result<EngineStopState> {
    repository::stop(&pool(&state).await?, request).await
}
#[tauri::command]
pub async fn execution_read_snapshot(
    state: State<'_, DbPool>,
    system_start_id: String,
) -> repository::Result<EngineSnapshot> {
    repository::read_snapshot(&pool(&state).await?, &system_start_id).await
}
#[tauri::command]
pub async fn execution_read_projection(
    state: State<'_, DbPool>,
    system_start_id: String,
) -> repository::Result<EngineProjection> {
    repository::read_projection(&pool(&state).await?, &system_start_id).await
}
#[tauri::command]
pub async fn execution_read_events(
    state: State<'_, DbPool>,
    system_start_id: String,
    after: Option<String>,
    limit: u32,
) -> repository::Result<EngineEventPage> {
    repository::read_events(
        &pool(&state).await?,
        &system_start_id,
        after.as_deref(),
        limit,
    )
    .await
}
