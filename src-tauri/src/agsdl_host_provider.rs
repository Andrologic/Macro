//! Private resident dispatch through Macro's existing OpenAI-compatible transport.
use crate::agsdl_host::HostState;
use crate::agsdl_host_catalogue::{self, ModelCapture};
use crate::ai::{types::AiChatRequest, AiState};
use crate::config::ConfigManager;
use crate::core::db_state::DbPool;
use crate::db::agsdl_execution::{self as repository, dto::*, failure, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Manager, State, Webview};

fn effect(context: EngineContext, request: &AiChatRequest) -> Result<EngineEffect> {
    if request.request_id.trim().is_empty() || request.request_id.len() > 512 {
        return Err(failure(
            "CORRELATION",
            "request",
            "Invalid native request identity",
        ));
    }
    if request.conversation_id.is_some()
        || request.workspace_path.is_some()
        || request.default_workspace_path.is_some()
        || !request.project_mounts.is_empty()
        || request.virtual_root_enabled == Some(true)
        || request.focused_project_id.is_some()
        || request.parallel_tool_calls == Some(true)
    {
        return Err(failure(
            "PERMISSION",
            "request",
            "Resident provider requests cannot supply conversation or workspace authority",
        ));
    }
    if request.messages.iter().any(|message| {
        !matches!(
            message.content,
            crate::ai::types::AiChatMessageContent::Text(_)
        ) || message.provider_input_items.is_some()
            || message.provider_turn_state.is_some()
    }) {
        return Err(failure(
            "UNSUPPORTED",
            "messages",
            "Provider continuation or media is outside the inline profile",
        ));
    }
    Ok(EngineEffect {
        context,
        effect: EngineEffectIdentity::Provider {
            provider_attempt_id: request.request_id.clone(),
        },
        invocation_json: serde_json::to_string(request)?,
    })
}

pub(crate) async fn scope_guard(
    workspace: &std::path::Path,
    context: &EngineContext,
    git: &crate::git::GitState,
) -> Result<crate::workspace::architect::LockedExecutionSource> {
    let scope: Value = serde_json::from_str(&context.scope_json)?;
    let owner: EngineSourceOwner = serde_json::from_value(
        scope
            .get("sourceOwner")
            .cloned()
            .ok_or_else(|| failure("CORRELATION", "scope", "Source owner is missing"))?,
    )?;
    let metadata = crate::agsdl_host_capture::metadata_root(workspace)?;
    let guard = crate::workspace::architect::lock_execution_source_owner(
        workspace, &metadata, &owner, None,
    )
    .await?;
    let current = crate::agsdl_host_capture::execution_scope(
        workspace,
        &guard,
        scope
            .get("taskId")
            .and_then(Value::as_str)
            .map(|id| (id, git)),
    )?;
    let permissions: Value = serde_json::from_str(&context.permissions_json)?;
    if scope != current
        || permissions.get("readOnly").and_then(Value::as_bool)
            != Some(guard.project.user_read_only || guard.project.is_read_only)
    {
        return Err(failure(
            "CAPTURE_CHANGED",
            "scope",
            "Current project scope differs from the capture",
        ));
    }
    Ok(guard)
}

async fn descriptor(
    pool: &sqlx::SqlitePool,
    manager: &ConfigManager,
    context: &EngineContext,
    request: &AiChatRequest,
) -> Result<crate::db::models::ProviderConfig> {
    let agent_id = context.work.agent_instance_id.as_deref().ok_or_else(|| {
        failure(
            "CORRELATION",
            "work",
            "Provider attempt must belong to an Agent",
        )
    })?;
    let (configuration, _) =
        repository::read_agent(pool, &context.work.system_start_id, agent_id).await?;
    if configuration.provider_id != request.provider_id
        || configuration.model_id != request.model_id
    {
        return Err(failure(
            "CORRELATION",
            "model",
            "Request model differs from the frozen Agent",
        ));
    }
    let settings: Value = serde_json::from_str(&configuration.settings_json)?;
    if request.reasoning_effort.as_deref().is_some_and(|effort| {
        settings.get("reasoningEffort").and_then(Value::as_str) != Some(effort)
    }) {
        return Err(failure(
            "CORRELATION",
            "reasoningEffort",
            "Request reasoning differs from the captured setting",
        ));
    }
    let private = repository::capture::read(pool, &context.owner).await?;
    let captured: ModelCapture = serde_json::from_str(&private.native_catalogue_json)?;
    let expected = captured
        .providers
        .iter()
        .find(|provider| provider.provider_id == request.provider_id)
        .ok_or_else(|| {
            failure(
                "UNSUPPORTED",
                "provider",
                "Provider is absent from the capture",
            )
        })?;
    let current = agsdl_host_catalogue::capture(manager, pool).await?;
    if !current.providers.contains(expected)
        || !current.catalogue.models.iter().any(|model| {
            model.provider_id == request.provider_id && model.model_id == request.model_id
        })
    {
        return Err(failure(
            "CAPTURE_CHANGED",
            "model",
            "Captured provider or model is no longer available",
        ));
    }
    let provider = crate::commands::configured_provider_configs(manager, pool)
        .await
        .map_err(|_| failure("UNSUPPORTED", "provider", "Current provider is unavailable"))?
        .into_iter()
        .find(|provider| provider.id == request.provider_id)
        .ok_or_else(|| failure("UNSUPPORTED", "provider", "Current provider is absent"))?;
    if !provider.is_enabled
        || !matches!(
            provider.provider_type.as_str(),
            "openai" | "ollama" | "lmstudio"
        )
        || provider.provider_type != expected.provider_type
        || format!("sha256:{:x}", Sha256::digest(provider.base_url.as_bytes()))
            != expected.endpoint_digest
    {
        return Err(failure(
            "CAPTURE_CHANGED",
            "provider",
            "Provider descriptor changed before dispatch",
        ));
    }
    Ok(provider)
}

#[tauri::command]
pub(crate) async fn execution_host_register_provider(
    webview: Webview,
    host: State<'_, HostState>,
    database: State<'_, DbPool>,
    manager: State<'_, ConfigManager>,
    workspace: State<'_, crate::WorkspaceMetadataRoot>,
    git: State<'_, crate::git::GitState>,
    context: EngineContext,
    request: AiChatRequest,
) -> Result<bool> {
    host.authenticate_owner(&webview, &context.owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let root = workspace.0.read().await.clone();
    let _scope = scope_guard(&root, &context, &git).await?;
    let _provider = descriptor(&pool, &manager, &context, &request).await?;
    let effect = effect(context, &request)?;
    let _gate = host.admission_gate().await;
    host.authenticate_owner(&webview, &effect.context.owner)?;
    repository::register_effect(&pool, effect).await
}
#[tauri::command]
pub(crate) async fn execution_host_dispatch_provider(
    app: tauri::AppHandle,
    webview: Webview,
    host: State<'_, HostState>,
    database: State<'_, DbPool>,
    manager: State<'_, ConfigManager>,
    ai: State<'_, AiState>,
    workspace: State<'_, crate::WorkspaceMetadataRoot>,
    git: State<'_, crate::git::GitState>,
    context: EngineContext,
    request: AiChatRequest,
) -> Result<()> {
    host.authenticate_owner(&webview, &context.owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let root = workspace.0.read().await.clone();
    let _scope = scope_guard(&root, &context, &git).await?;
    let provider = descriptor(&pool, &manager, &context, &request).await?;
    let _gate = host.admission_gate().await;
    repository::authorize_reserved_effect(&pool, &effect(context.clone(), &request)?).await?;
    host.authenticate_owner(&webview, &context.owner)?;
    // StreamTasks owns and deduplicates the physical attempt before it can poll.
    ai.stream_tasks
        .start(request.request_id.clone(), async move {
            let _ = crate::ai::openai_compatible::stream_chat_with_provider(
                app,
                pool,
                request,
                Some(provider),
            )
            .await;
        })
        .map_err(|_| {
            failure(
                "CORRELATION",
                "request",
                "Native attempt was already admitted or cancelled",
            )
        })
}
#[tauri::command]
pub(crate) async fn execution_host_end_provider(
    app: tauri::AppHandle,
    webview: Webview,
    host: State<'_, HostState>,
    context: EngineContext,
    request_id: String,
) -> Result<()> {
    host.authenticate_owner(&webview, &context.owner)?;
    // The native supervisor, not a JavaScript boolean, supplies termination evidence.
    finish(&app, context, request_id).await
}
pub(crate) async fn finish(
    app: &tauri::AppHandle,
    context: EngineContext,
    request_id: String,
) -> Result<()> {
    let pool = app
        .state::<DbPool>()
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let recorded = repository::read_effects(&pool, &context.work).await?;
    if !recorded.iter().any(|record| {
        record.registered.context == context
            && record.registered.effect
                == (EngineEffectIdentity::Provider {
                    provider_attempt_id: request_id.clone(),
                })
    }) {
        return Err(failure(
            "CORRELATION",
            "request",
            "Native termination has no correlated provider effect",
        ));
    }
    let ended = app
        .state::<AiState>()
        .stream_tasks
        .cancel_owned(&request_id)
        .await;
    // The physical cancellation above is attempted even for a revoked owner;
    // only the durable settlement depends on current ownership.
    let identity = EngineEffectIdentity::Provider {
        provider_attempt_id: request_id.clone(),
    };
    let never_admitted_here = ended == Ok(false)
        && repository::process_recovery::registered_in_this_process(&pool, &context, &identity)
            .await?;
    if ended == Ok(true) || never_admitted_here {
        repository::settle_owned_effect(&pool, EngineSettlement {
            context, effect: EngineEffectIdentity::Provider { provider_attempt_id: request_id.clone() },
            status: "ended".into(),
            evidence_json: serde_json::json!({"kind":if never_admitted_here {"macro-native-stream-not-admitted/1"} else {"macro-native-stream-join/1"},"requestId":request_id,"status":"ended"}).to_string(),
        }, None).await
    } else {
        Err(failure(
            "STOP_PENDING",
            "request",
            "Native stream termination remains unconfirmed",
        ))
    }
}
