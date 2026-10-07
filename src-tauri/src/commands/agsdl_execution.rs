//! Product commands have no capture, epoch, admission, effect or commit intake.
use super::DbPool;
use crate::db::agsdl_execution::{self as repository, dto::*};
use repository::public::*;
use tauri::{Manager, State};
async fn pool(state: &State<'_, DbPool>) -> repository::Result<sqlx::SqlitePool> {
    state
        .wait_until_ready()
        .await
        .map_err(|_| repository::failure("STORAGE", "", "Execution database unavailable"))
}
#[tauri::command]
pub async fn execution_start(
    app: tauri::AppHandle,
    request: EngineStartRequest,
) -> repository::Result<PublicStartReceipt> {
    // Dropping a UI invocation cannot abandon a committed Start before native
    // ownership attachment. The task remains resident until that boundary ends.
    tokio::spawn(async move {
        let state = app.state::<DbPool>();
        let host = app.state::<crate::agsdl_host::HostState>();
        let manager = app.state::<crate::config::ConfigManager>();
        let workspace_state = app.state::<crate::WorkspaceMetadataRoot>();
        let workspace = workspace_state.0.read().await.clone();
        crate::agsdl_host_capture::start(&host, &manager, &pool(&state).await?, &workspace, request)
            .await
            .map(Into::into)
    })
    .await
    .map_err(|_| {
        repository::failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "Native Start task did not acknowledge",
        )
    })?
}

#[tauri::command]
pub async fn execution_stop(
    app: tauri::AppHandle,
    state: State<'_, DbPool>,
    host: State<'_, crate::agsdl_host::HostState>,
    request: EngineStopRequest,
) -> repository::Result<PublicStopState> {
    let pool = pool(&state).await?;
    let gate = host.admission_gate().await;
    let receipt = repository::stop(&pool, request.clone()).await?;
    let projection = repository::read_projection(&pool, &request.system_start_id).await?;
    let mut joins = Vec::new();
    for activation in projection.activations {
        let work = &activation.delivery.delivery.work;
        if request
            .activation_id
            .as_ref()
            .is_some_and(|id| id != &work.activation_id)
        {
            continue;
        }
        for effect in repository::read_effects(&pool, work).await? {
            if effect.status == "ended" {
                continue;
            }
            if let EngineEffectIdentity::Provider {
                provider_attempt_id,
            } = effect.registered.effect
            {
                let app = app.clone();
                let context = effect.registered.context;
                // The task survives loss of the UI acknowledgement.
                joins.push(tokio::spawn(async move {
                    crate::agsdl_host_provider::finish(&app, context, provider_attempt_id).await
                }));
            }
        }
    }
    drop(gate);
    // Other Agents can reach their own admission while physical joins are pending.
    for join in joins {
        join.await.map_err(|_| {
            repository::failure(
                "STOP_PENDING",
                "",
                "Native termination acknowledgement was lost",
            )
        })??;
    }
    Ok(receipt.into())
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

#[tauri::command]
pub async fn execution_preflight(
    state: State<'_, DbPool>,
    host: State<'_, crate::agsdl_host::HostState>,
    config_manager: State<'_, crate::config::ConfigManager>,
    workspace_root: State<'_, crate::WorkspaceMetadataRoot>,
    request: crate::agsdl_host_capture::ExecutionPreflightRequest,
) -> repository::Result<crate::agsdl_host_capture::ExecutionPreflight> {
    let workspace = workspace_root.0.read().await.clone();
    Ok(crate::agsdl_host_capture::compile(
        &host,
        &config_manager,
        &pool(&state).await?,
        &workspace,
        &request,
    )
    .await?
    .public())
}

#[tauri::command]
pub async fn execution_deliver(
    app: tauri::AppHandle,
    request: crate::agsdl_host_capture::ExecutionExternalDelivery,
) -> repository::Result<EngineAcceptedDelivery> {
    tokio::spawn(async move {
        let database = app.state::<DbPool>();
        let host = app.state::<crate::agsdl_host::HostState>();
        crate::agsdl_host_capture::deliver(&host, &pool(&database).await?, request).await
    })
    .await
    .map_err(|_| {
        repository::failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "Delivery acknowledgement was lost",
        )
    })?
}

#[tauri::command]
pub async fn execution_resolve_card_task(
    state: State<'_, DbPool>,
    workspace: State<'_, crate::WorkspaceMetadataRoot>,
    git: State<'_, crate::git::GitState>,
    request: crate::agsdl_host_tasks::ResolveCardTask,
) -> repository::Result<Option<crate::agsdl_host_tasks::ResolvedCardTask>> {
    let workspace = workspace.0.read().await.clone();
    crate::agsdl_host_tasks::resolve(&pool(&state).await?, &workspace, &git, request).await
}
