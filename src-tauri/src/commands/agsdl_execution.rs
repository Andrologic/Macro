//! Product commands have no capture, epoch, admission, effect or commit intake.
use super::DbPool;
use crate::db::agsdl_execution::{self as repository, dto::*};
use repository::intents::{self, *};
use repository::public::*;
use sqlx::Row;
use tauri::{Manager, State};
async fn pool(state: &State<'_, DbPool>) -> repository::Result<sqlx::SqlitePool> {
    state
        .wait_until_ready()
        .await
        .map_err(|_| repository::failure("STORAGE", "", "Execution database unavailable"))
}

#[tauri::command]
pub async fn execution_read_runtime_projection030(
    state: State<'_, DbPool>,
    host: State<'_, crate::agsdl_host::HostState>,
    scope: crate::agsdl_host_projection030::RuntimeProjectionQuery030,
    continuation: Option<crate::agsdl_host_projection030::RuntimeProjectionContinuation030>,
) -> repository::Result<crate::agsdl_host_projection030::RuntimeProjectionPage030> {
    crate::agsdl_host_projection030::read(&host, &pool(&state).await?, scope, continuation).await
}
#[tauri::command]
pub async fn execution_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
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
        if request.profile == "macro-agsdl-030-v1" {
            let retained = crate::agsdl_host_flow030::start_linked(
                Some(&app),
                &host,
                &manager,
                &pool(&state).await?,
                &workspace,
                &git,
                &request,
                None,
            )
            .await?;
            return Ok(public_start030(&request, &retained));
        }
        Err(repository::failure(
            "UNSUPPORTED_EDITION",
            "profile",
            "Only AgSDL 0.3 execution is supported",
        ))
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

pub(crate) fn public_start030(
    request: &EngineStartRequest,
    retained: &repository::start030::RetainedStart030,
) -> PublicStartReceipt {
    let identity = &retained.receipt.identity;
    PublicStartReceipt {
        system_start_id: identity.system_start_id.clone(),
        flow_invocation_id: identity.flow_invocation_id.clone(),
        snapshot: PublicSnapshot {
            system_start_id: identity.system_start_id.clone(),
            source: retained.capture.source.clone(),
            authored_source: retained.capture.authored_source.clone(),
            versions: retained.capture.versions.clone(),
            associations: request.associations.clone(),
        },
    }
}

#[tauri::command]
pub async fn execution_stop<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DbPool>,
    _host: State<'_, crate::agsdl_host::HostState>,
    request: EngineStopRequest,
) -> repository::Result<PublicStopState> {
    let pool = pool(&state).await?;
    let is_flow030: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM engine_start030_requests WHERE system_id=?)",
    )
    .bind(&request.system_start_id)
    .fetch_one(&pool)
    .await?;
    if is_flow030 {
        // As with the legacy path, loss of the IPC observer must not abandon
        // the native Stop or any join already in progress.
        return owned_stop(async move {
            let host = app.state::<crate::agsdl_host::HostState>();
            let ai = app.state::<crate::ai::AiState>();
            let result = host.request_stop(&pool, &ai.stream_tasks, &request).await?;
            Ok(result)
        })
        .await;
    }
    Err(repository::failure(
        "NOT_FOUND",
        "systemStartId",
        "AgSDL 0.3 run not found",
    ))
}

async fn owned_stop(
    future: impl std::future::Future<Output = repository::Result<PublicStopState>> + Send + 'static,
) -> repository::Result<PublicStopState> {
    tokio::spawn(future).await.map_err(|_| {
        repository::failure("STOP_PENDING", "", "Native Stop task did not acknowledge")
    })?
}

#[tauri::command]
pub async fn execution_ensure_stop<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: ExecutionEnsureStopRequest,
) -> repository::Result<PublicStopState> {
    // The orchestration, including cancellation and physical joins, survives IPC loss.
    owned_stop(async move {
        let db = app.state::<DbPool>();
        let host = app.state::<crate::agsdl_host::HostState>();
        let pool = pool(&db).await?;
        let is_flow030: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM engine_start030_requests WHERE system_id=?)",
        )
        .bind(&request.system_start_id)
        .fetch_one(&pool)
        .await?;
        if is_flow030 {
            if request.activation_id.is_some() {
                return Err(repository::failure(
                    "PARTIAL_STOP_UNAVAILABLE",
                    "activationId",
                    "Native 0.3 activation Stop requires a separate scoped operation",
                ));
            }
            let ai = app.state::<crate::ai::AiState>();
            let result = host
                .ensure_stop(&pool, &ai.stream_tasks, &request.system_start_id)
                .await?;
            return Ok(result);
        }
        Err(repository::failure(
            "NOT_FOUND",
            "systemStartId",
            "AgSDL 0.3 run not found",
        ))
    })
    .await
}

#[tauri::command]
pub async fn execution_read_snapshot(
    state: State<'_, DbPool>,
    system_start_id: String,
) -> repository::Result<PublicSnapshot> {
    let pool = pool(&state).await?;
    read_public_snapshot(&pool, &system_start_id).await
}

pub(crate) async fn read_public_snapshot(
    pool: &sqlx::SqlitePool,
    system_start_id: &str,
) -> repository::Result<PublicSnapshot> {
    let retained = sqlx::query("SELECT request_json,capture_json,receipt_json FROM engine_start030_requests WHERE system_id=?")
        .bind(system_start_id)
        .fetch_optional(pool)
        .await?;
    if let Some(row) = retained {
        let request: EngineStartRequest = serde_json::from_str(row.get("request_json"))?;
        let capture: repository::start030::StartCapture030 =
            serde_json::from_str(row.get("capture_json"))?;
        let receipt: repository::start030::StartReceipt030 =
            serde_json::from_str(row.get("receipt_json"))?;
        if request.profile != "macro-agsdl-030-v1"
            || request.source != capture.source
            || capture.identity != receipt.identity
            || capture.identity.system_start_id != system_start_id
            || capture.versions.profile != request.profile
            || capture.versions.snapshot != "2"
            || capture.versions.contract != "agsdl-0.3.0"
        {
            return Err(repository::failure(
                "CORRELATION",
                "snapshot",
                "Stored capture differs from its request",
            ));
        }
        return Ok(PublicSnapshot {
            system_start_id: system_start_id.to_owned(),
            source: capture.source,
            authored_source: capture.authored_source,
            versions: capture.versions,
            associations: request.associations,
        });
    }
    Err(repository::failure(
        "NOT_FOUND",
        "systemStartId",
        "AgSDL 0.3 capture not found",
    ))
}

#[tauri::command]
pub async fn execution_model_choices(
    state: State<'_, DbPool>,
    config_manager: State<'_, crate::config::ConfigManager>,
) -> repository::Result<crate::agsdl_host_catalogue::NativeModelCatalogue> {
    crate::agsdl_host_catalogue::choices(&config_manager, &pool(&state).await?).await
}

#[tauri::command]
pub async fn execution_list_runs030(
    app: tauri::AppHandle,
    state: State<'_, DbPool>,
    request: repository::discovery030::RunListRequest030,
) -> repository::Result<repository::discovery030::RunPage030> {
    let workspace_state = app.state::<crate::WorkspaceMetadataRoot>();
    let workspace = workspace_state.0.read().await.clone();
    list_runs030_scoped(&pool(&state).await?, &workspace, request).await
}

pub(crate) async fn list_runs030_scoped(
    pool: &sqlx::SqlitePool,
    workspace: &std::path::Path,
    request: repository::discovery030::RunListRequest030,
) -> repository::Result<repository::discovery030::RunPage030> {
    let metadata = crate::agsdl_host_capture::metadata_root(&workspace)?;
    let _scope = crate::workspace::architect::lock_execution_history_owner(
        workspace,
        &metadata,
        &request.owner,
    )
    .await?;
    repository::discovery030::list_runs030(pool, request).await
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

/// Read only the native-attested public view. A page cursor is scoped to the
/// complete captured source and is invalidated when its requests change.
#[tauri::command]
pub async fn execution_read_humans030(
    host: State<'_, crate::agsdl_host::HostState>,
    state: State<'_, DbPool>,
    scope: repository::public030::HumanScope030,
    continuation: Option<repository::public030::HumanContinuation030>,
) -> repository::Result<repository::public030::HumanPage030> {
    host.human_page(&pool(&state).await?, scope, continuation)
        .await
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
pub async fn execution_read_run_correlation030(
    app: tauri::AppHandle,
    scope: ExecutionIntentScope,
    system_start_id: String,
) -> IntentResult<ExecutionRunCorrelation030> {
    let _guard = intent_scope(&app, &scope).await?;
    intents::read_run_correlation030(&intent_pool(&app).await?, &scope, &system_start_id).await
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
            if request.profile == "macro-agsdl-030-v1" {
                crate::agsdl_host_flow030::start_linked(
                    Some(&app),
                    &host,
                    &manager,
                    &pool,
                    &workspace,
                    &git,
                    request,
                    Some(&link),
                )
                .await
                .map(|_| ())
            } else {
                Err(repository::failure(
                    "UNSUPPORTED_EDITION",
                    "profile",
                    "Only AgSDL 0.3 execution is supported",
                ))
            }
        }
        ExecutionIntentPayload::Deliver { .. } => Err(repository::failure(
            "UNSUPPORTED_EDITION",
            "payload",
            "Use the AgSDL 0.3 delivery command",
        )),
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
    // Isolated QA can interrupt the observer after admission, before its acknowledgement.
    // This never delays a release build or a non-QA profile.
    #[cfg(all(debug_assertions, feature = "browser-runtime-debug"))]
    if app.config().identifier.starts_with("com.macro.desktop.qa.") && result.is_ok() {
        if let Some(delay) = std::env::var("MACRO_AGSDL_QA_DELAY_ADMISSION_ACK_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value <= 30_000)
        {
            tracing::warn!("AgSDL QA: delaying admission acknowledgement");
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
    }
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

/// Persists receipt arbitration even if the invoking UI disappears.
#[tauri::command]
pub async fn execution_submit_human030(
    app: tauri::AppHandle,
    input: argentic_runtime::api::HumanSubmission,
) -> repository::Result<String> {
    tokio::spawn(async move {
        let state = app.state::<DbPool>();
        let host = app.state::<crate::agsdl_host::HostState>();
        let pool = pool(&state).await?;
        host.submit_person(&pool, input).await
    })
    .await
    .map_err(|_| {
        repository::failure(
            "UNCERTAIN",
            "human",
            "Native submission did not acknowledge",
        )
    })?
}

/// Admit a message into the retained 0.3 run, independently of the live editor.
#[tauri::command]
pub async fn execution_deliver030(
    host: tauri::State<'_, crate::agsdl_host::HostState>,
    database: tauri::State<'_, DbPool>,
    request: crate::agsdl_host_flow030::DeliveryRequest030,
) -> repository::Result<crate::agsdl_host_flow030::DeliveryReceipt030> {
    host.deliver_message(&pool(&database).await?, request).await
}
