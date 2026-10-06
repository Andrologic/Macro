//! Product commands have no capture, epoch, admission, effect or commit intake.
use super::DbPool;
use crate::db::agsdl_execution::{self as repository, dto::*};
use repository::public::*;
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
) -> repository::Result<PublicStartReceipt> {
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
) -> repository::Result<PublicStopState> {
    repository::stop(&pool(&state).await?, request)
        .await
        .map(Into::into)
}
#[tauri::command]
pub async fn execution_read_snapshot(
    state: State<'_, DbPool>,
    system_start_id: String,
) -> repository::Result<PublicSnapshot> {
    repository::read_snapshot(&pool(&state).await?, &system_start_id)
        .await
        .map(Into::into)
}
#[tauri::command]
pub async fn execution_read_projection(
    state: State<'_, DbPool>,
    system_start_id: String,
) -> repository::Result<PublicProjection> {
    repository::public::projection(&pool(&state).await?, &system_start_id).await
}
#[tauri::command]
pub async fn execution_read_events(
    state: State<'_, DbPool>,
    system_start_id: String,
    after: Option<String>,
    limit: u32,
) -> repository::Result<PublicEventPage> {
    repository::read_events(
        &pool(&state).await?,
        &system_start_id,
        after.as_deref(),
        limit,
    )
    .await
    .map(Into::into)
}

#[tauri::command]
pub async fn execution_model_choices(
    state: State<'_, DbPool>,
    config_manager: State<'_, crate::config::ConfigManager>,
) -> repository::Result<crate::agsdl_host_catalogue::NativeModelCatalogue> {
    crate::agsdl_host_catalogue::choices(&config_manager, &pool(&state).await?).await
}

#[tauri::command]
pub async fn execution_list_runs(
    state: State<'_, DbPool>,
    request: repository::discovery::RunListRequest,
) -> repository::Result<repository::discovery::RunPage> {
    repository::discovery::list_runs(&pool(&state).await?, request).await
}
#[tauri::command]
pub async fn execution_find_start(
    state: State<'_, DbPool>,
    owner: EngineSourceOwner,
    request_id: String,
) -> repository::Result<Option<PublicStartReceipt>> {
    repository::discovery::find_start(&pool(&state).await?, &owner, &request_id).await
}

#[tauri::command]
pub async fn execution_read_diagnostic(
    state: State<'_, DbPool>,
    request: repository::diagnostics::DiagnosticRequest,
) -> repository::Result<repository::diagnostics::PublicExecutionDiagnostic> {
    repository::diagnostics::read(&pool(&state).await?, request).await
}
