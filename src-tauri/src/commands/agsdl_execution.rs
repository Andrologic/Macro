//! Product commands have no capture, epoch, admission, effect or commit intake.
use super::DbPool;
use crate::db::agsdl_execution::{self as repository, dto::*};
use repository::intents::{self, *};
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
        let git = app.state::<crate::git::GitState>();
        let workspace_state = app.state::<crate::WorkspaceMetadataRoot>();
        let workspace = workspace_state.0.read().await.clone();
        crate::agsdl_host_capture::start(
            &host,
            &manager,
            &pool(&state).await?,
            &workspace,
            request,
            &git,
        )
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
    repository::stop(&pool, request.clone()).await?;
    stop_effects(
        app,
        &pool,
        &request.system_start_id,
        request.activation_id.as_deref(),
        gate,
    )
    .await
}

async fn stop_effects(
    app: tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    system_start_id: &str,
    activation_id: Option<&str>,
    gate: tokio::sync::MutexGuard<'_, ()>,
) -> repository::Result<PublicStopState> {
    repository::process_recovery::close_dead_process_effects(pool, system_start_id, activation_id)
        .await?;
    repository::confirm_stopped_undispatched_calls(pool, system_start_id, activation_id).await?;
    let projection = repository::read_projection(&pool, system_start_id).await?;
    let mut joins = Vec::new();
    for activation in projection.activations {
        let work = &activation.delivery.delivery.work;
        if activation_id.is_some_and(|id| id != &work.activation_id) {
            continue;
        }
        for effect in repository::read_effects(&pool, work).await? {
            if effect.status == "ended" {
                continue;
            }
            crate::agsdl_host_tools::cancel(&effect.registered);
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
    repository::confirm_stopped_retired_work(pool, system_start_id).await?;
    repository::read_stop_target(&pool, system_start_id, activation_id)
        .await
        .map(Into::into)
}

async fn owned_stop(
    future: impl std::future::Future<Output = repository::Result<PublicStopState>> + Send + 'static,
) -> repository::Result<PublicStopState> {
    tokio::spawn(future).await.map_err(|_| {
        repository::failure("STOP_PENDING", "", "Native Stop task did not acknowledge")
    })?
}

#[tauri::command]
pub async fn execution_ensure_stop(
    app: tauri::AppHandle,
    request: ExecutionEnsureStopRequest,
) -> repository::Result<PublicStopState> {
    // The orchestration, including cancellation and physical joins, survives IPC loss.
    owned_stop(async move {
        let db = app.state::<DbPool>();
        let host = app.state::<crate::agsdl_host::HostState>();
        let pool = pool(&db).await?;
        let gate = host.admission_gate().await;
        repository::ensure_stop(
            &pool,
            &request.system_start_id,
            request.activation_id.as_deref(),
        )
        .await?;
        stop_effects(
            app.clone(),
            &pool,
            &request.system_start_id,
            request.activation_id.as_deref(),
            gate,
        )
        .await
    })
    .await
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
    page: Option<ProjectionPage>,
) -> repository::Result<PublicProjection> {
    repository::public::projection(&pool(&state).await?, &system_start_id, page.as_ref()).await
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
    let result = crate::agsdl_host_capture::compile(
        &host,
        &config_manager,
        &pool(&state).await?,
        &workspace,
        &request,
    )
    .await?
    .public();
    Ok(result)
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

#[tauri::command]
pub async fn execution_pending_approvals(
    state: State<'_, DbPool>,
    request: repository::approvals::ApprovalScope,
) -> repository::Result<repository::approvals::ApprovalPage> {
    repository::approvals::pending_public(&pool(&state).await?, request).await
}
#[tauri::command]
pub async fn execution_decide_approval(
    state: State<'_, DbPool>,
    request: repository::approvals::ApprovalDecision,
) -> repository::Result<repository::approvals::PublicApproval> {
    repository::approvals::decide_public(&pool(&state).await?, request).await
}

fn intent_failure(failure: EngineFailure) -> ExecutionIntentError {
    let code = match failure.code.as_str() {
        "STORAGE" => ExecutionIntentErrorCode::StorageUncertain,
        "INTENT_SCOPE_INVALID" => ExecutionIntentErrorCode::ScopeInvalid,
        "INTENT_SCOPE_UNAVAILABLE" | "SOURCE_UNAVAILABLE" => {
            ExecutionIntentErrorCode::ScopeUnavailable
        }
        _ => ExecutionIntentErrorCode::RuntimeUnavailable,
    };
    intents::error(code)
}
async fn intent_pool(app: &tauri::AppHandle) -> IntentResult<sqlx::SqlitePool> {
    pool(&app.state::<DbPool>()).await.map_err(intent_failure)
}
async fn intent_scope(
    app: &tauri::AppHandle,
    scope: &ExecutionIntentScope,
) -> IntentResult<crate::workspace::architect::LockedExecutionSource> {
    intents::validate_key(&ExecutionIntentKey {
        scope: scope.clone(),
        intent_id: "scope-validation".into(),
    })?;
    let workspace_state = app.state::<crate::WorkspaceMetadataRoot>();
    let workspace = workspace_state.0.read().await.clone();
    let metadata = crate::agsdl_host_capture::metadata_root(&workspace).map_err(intent_failure)?;
    crate::workspace::architect::lock_execution_intent_scope(&workspace, &metadata, scope, None)
        .await
        .map_err(intent_failure)
}

#[tauri::command]
pub async fn execution_stage_intent(
    app: tauri::AppHandle,
    request: ExecutionStageIntentRequest,
) -> IntentResult<PublicExecutionIntent> {
    let guard = intent_scope(&app, &request.scope).await?;
    intents::stage_current(
        &intent_pool(&app).await?,
        request,
        &guard.revision,
        guard.current_source_consistent,
    )
    .await
}
#[tauri::command]
pub async fn execution_read_intents(
    app: tauri::AppHandle,
    request: ExecutionReadIntentsRequest,
) -> IntentResult<Vec<PublicExecutionIntent>> {
    let _guard = intent_scope(&app, &request.scope).await?;
    intents::read_open(&intent_pool(&app).await?, &request.scope).await
}
#[tauri::command]
pub async fn execution_read_intent(
    app: tauri::AppHandle,
    key: ExecutionIntentKey,
) -> IntentResult<Option<PublicExecutionIntent>> {
    intents::validate_key(&key)?;
    let _guard = intent_scope(&app, &key.scope).await?;
    intents::read(&intent_pool(&app).await?, &key).await
}
#[tauri::command]
pub async fn execution_close_intent(
    app: tauri::AppHandle,
    request: ExecutionCloseIntentRequest,
) -> IntentResult<PublicExecutionIntent> {
    let coordinator = app.state::<crate::agsdl_intent_coordinator::IntentCoordinator>();
    // Check the marker before any metadata or SQL await; the reservation is RAII-owned.
    let _owner = coordinator.reserve_close(&request.key)?;
    let _guard = intent_scope(&app, &request.key.scope).await?;
    intents::close(&intent_pool(&app).await?, &request).await
}
async fn submit_retained(
    app: tauri::AppHandle,
    key: ExecutionIntentKey,
) -> IntentResult<PublicExecutionIntent> {
    let pool = intent_pool(&app).await?;
    let guard = intent_scope(&app, &key.scope).await?;
    let submission = intents::begin_submission_current(
        &pool,
        &key,
        &guard.revision,
        guard.current_source_consistent,
    )
    .await?;
    drop(guard);
    let Submission::Dispatch(link) = submission else {
        let Submission::Retained(row) = submission else {
            unreachable!()
        };
        return Ok(row);
    };
    let host = app.state::<crate::agsdl_host::HostState>();
    let workspace_state = app.state::<crate::WorkspaceMetadataRoot>();
    let workspace = workspace_state.0.read().await.clone();
    let result = match &link.payload {
        ExecutionIntentPayload::Start { request } => {
            let manager = app.state::<crate::config::ConfigManager>();
            let git = app.state::<crate::git::GitState>();
            crate::agsdl_host_capture::start_linked(
                &host,
                &manager,
                &pool,
                &workspace,
                request.clone(),
                &git,
                Some(&link),
            )
            .await
            .map(|_| ())
        }
        ExecutionIntentPayload::Deliver { request, .. } => {
            crate::agsdl_host_capture::deliver_linked(
                &host,
                &pool,
                request.clone(),
                Some((&link, &workspace)),
            )
            .await
            .map(|_| ())
        }
    };
    let guard = intent_scope(&app, &key.scope).await?;
    match result {
        Ok(()) => intents::read(&pool, &key)
            .await?
            .ok_or_else(|| intents::error(ExecutionIntentErrorCode::StorageUncertain)),
        // An atomically linked admission wins over a subsequent host attachment error.
        Err(failure) => {
            intents::finish_failure_current(
                &pool,
                &key,
                &failure,
                guard.current_source_consistent.then_some(&guard.revision),
            )
            .await
        }
    }
}
#[tauri::command]
pub async fn execution_submit_intent(
    app: tauri::AppHandle,
    key: ExecutionIntentKey,
) -> IntentResult<PublicExecutionIntent> {
    intents::validate_key(&key)?;
    {
        let _guard = intent_scope(&app, &key.scope).await?;
    }
    let coordinator = app.state::<crate::agsdl_intent_coordinator::IntentCoordinator>();
    let worker_app = app.clone();
    let worker_key = key.clone();
    let result = coordinator
        .submit(key.clone(), move || submit_retained(worker_app, worker_key))
        .await;
    // Every observer proves its full canonical scope again before seeing the result.
    let _guard = intent_scope(&app, &key.scope).await?;
    intents::conversation(&mut *intent_pool(&app).await?.acquire().await?, &key.scope).await?;
    result
}

#[cfg(test)]
mod intent_tests {
    use super::*;
    #[tokio::test]
    async fn owned_stop_join_survives_ipc_observer_loss_without_inventing_confirmation() {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let observer = tokio::spawn(owned_stop(async move {
            // Synthetic native join boundary; no provider or Tauri runtime is started.
            let join = tokio::spawn(async move {
                entered_tx.send(()).unwrap();
                release_rx.await.unwrap();
            });
            join.await.unwrap();
            finished_tx.send(()).unwrap();
            Ok(PublicStopState::Requested {
                request_id: "native-stop-key".into(),
            })
        }));
        entered_rx.await.unwrap();
        observer.abort();
        assert!(observer.await.unwrap_err().is_cancelled());
        release_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), finished_rx)
            .await
            .unwrap()
            .unwrap();
    }
}
