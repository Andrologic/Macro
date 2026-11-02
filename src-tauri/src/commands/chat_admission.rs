use super::{command_error, get_pool, CommandResult, DbPool};
use crate::ai::provider_work::ProviderAdmission;
use crate::db::chat_admission::runtime::{ChatAdmissionContext, ChatAdmissionRuntime};
use tauri::{Manager, State, WebviewWindow};

#[tauri::command]
pub(crate) async fn chat_admission_open_browser(
    pool: State<'_, DbPool>, admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow, runtime: String,
) -> CommandResult<()> {
    admission_runtime.open_browser(pool.inner().clone(), window.label(), &runtime).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_close_browser(
    pool: State<'_, DbPool>, admission_runtime: State<'_, ChatAdmissionRuntime>,
    ai_state: State<'_, crate::ai::AiState>, http: State<'_, crate::ai::admitted_http::AdmittedHttp>,
    window: WebviewWindow, runtime: String,
) -> CommandResult<()> {
    admission_runtime.close_browser(&pool, &ai_state, &http, window.label(), &runtime).await.map_err(Into::into)
}

/// Native lifecycle owns this task even when no JavaScript waiter survives.
pub(crate) fn retire_browser_from_native(app: &tauri::AppHandle, caller: &str) {
    let Some(runtime) = app.try_state::<ChatAdmissionRuntime>() else { return; };
    let page = runtime.invalidate_page(caller);
    let app = app.clone();
    let caller = caller.to_owned();
    tauri::async_runtime::spawn(async move {
        let result = app.state::<ChatAdmissionRuntime>().close_previous_page(
            &app.state::<DbPool>(), &app.state::<crate::ai::AiState>(),
            &app.state::<crate::ai::admitted_http::AdmittedHttp>(), &caller, &page,
        ).await;
        if let Err(error) = result {
            tracing::error!(%error, "Chat browser retirement remains blocked");
        }
    });
}

#[tauri::command]
pub(crate) async fn chat_admission_begin(
    pool: State<'_, DbPool>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    ai_state: State<'_, crate::ai::AiState>,
    http: State<'_, crate::ai::admitted_http::AdmittedHttp>,
    window: WebviewWindow,
    runtime: String,
    conversation_id: String,
    turn_id: String,
    attempt_id: String,
    purpose: crate::db::chat_admission::RootWorkKind,
) -> CommandResult<ProviderAdmission> {
    let page = admission_runtime.current_page(window.label());
    let database = get_pool(&pool).await?;
    let global: Option<i64> = sqlx::query_scalar("SELECT CASE WHEN scope_mode='Chat' AND project_id IS NULL AND group_id IS NULL AND task_id IS NULL THEN 1 ELSE 0 END FROM conversations WHERE id=?")
        .bind(&conversation_id).fetch_optional(&database).await.map_err(|error| command_error(error.to_string()))?;
    match global {
        Some(0) => return Ok(ProviderAdmission::Conversation),
        Some(1) => {}
        _ => return Err(command_error("chat_admission_conversation_missing")),
    }
    admission_runtime.open_browser_on_page(pool.inner().clone(), window.label(), &runtime, &page).await?;
    admission_runtime.retire_previous_unknown_turns(&pool,&ai_state,&http,window.label(),&runtime,&conversation_id,&turn_id).await?;
    admission_runtime
        .begin_root(
            pool.inner().clone(),
            window.label(),
            &runtime,
            &conversation_id,
            &turn_id,
            &attempt_id,
            purpose,
        )
        .await
        .map(|context| ProviderAdmission::GlobalChat { context })
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_close_preparation(
    pool: State<'_, DbPool>, admission_runtime: State<'_, ChatAdmissionRuntime>, window: WebviewWindow,
    context: ChatAdmissionContext, conversation_id: String,
) -> CommandResult<()> {
    let fingerprint = crate::db::chat_admission::runtime::completion_fingerprint("preparation", &())?;
    if crate::db::chat_admission::runtime::replay_completion(&pool, window.label(), &context, &conversation_id, &fingerprint).await? {
        return Ok(());
    }
    let result = admission_runtime.close_preparation(window.label(), &context, &conversation_id).await;
    if result.is_err() && crate::db::chat_admission::runtime::replay_completion(&pool, window.label(), &context, &conversation_id, &fingerprint).await? {
        return Ok(());
    }
    result.map_err(Into::into)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderJoinReceipt {
    phase: String,
    task_error: Option<String>,
}

#[tauri::command]
pub(crate) async fn chat_admission_join_provider(
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    ai_state: State<'_, crate::ai::AiState>,
    window: WebviewWindow,
    context: ChatAdmissionContext,
    conversation_id: String,
    request_id: String,
) -> CommandResult<ProviderJoinReceipt> {
    let parent = admission_runtime
        .parent(window.label(), &context, &conversation_id)
        .await?;
    // No transaction is held while awaiting the real provider task.
    let joined = ai_state.join_stream_task(&request_id).await;
    let phase = parent.provider_invocation_phase(&request_id).await?;
    Ok(ProviderJoinReceipt {
        phase,
        task_error: joined.and_then(Result::err),
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmittedHttpRequest {
    request_id: String,
    provider_id: String,
    url: String,
    headers: Vec<(String, String)>,
    body: String,
}

#[tauri::command]
pub(crate) async fn chat_admission_http_start(
    pool: State<'_, DbPool>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    ai_state: State<'_, crate::ai::AiState>,
    http: State<'_, crate::ai::admitted_http::AdmittedHttp>,
    window: WebviewWindow,
    context: ChatAdmissionContext,
    conversation_id: String,
    request: AdmittedHttpRequest,
) -> CommandResult<()> {
    let reservation = ai_state
        .reserve_stream(request.request_id.clone())
        .map_err(command_error)?;
    let database = get_pool(&pool).await?;
    let work = std::sync::Arc::new(
        crate::ai::provider_work::ProviderWork::admit(
            &database,
            &admission_runtime,
            window.label(),
            ProviderAdmission::GlobalChat { context },
            Some(&conversation_id),
            &request.request_id,
        )
        .await
        .map_err(command_error)?,
    );
    let prepared = async {
        let provider = crate::db::repository::get_provider_config(&database, &request.provider_id)
            .await?
            .ok_or_else(|| command_error("chat_admission_provider_missing"))?;
        let expected = reqwest::Url::parse(&format!(
            "{}/chat/completions",
            provider.base_url.trim_end_matches('/')
        ))
        .map_err(|e| command_error(e.to_string()))?;
        let actual = reqwest::Url::parse(&request.url).map_err(|e| command_error(e.to_string()))?;
        if expected != actual {
            return Err(command_error("chat_admission_provider_destination_changed"));
        }
        // Redirecting a POST is another emission. Do not follow it invisibly.
        let client = work
            .configure_http_client(reqwest::Client::builder())
            .build()
            .map_err(|e| command_error(e.to_string()))?;
        let mut outgoing = client.post(actual).body(request.body);
        for (name, value) in request.headers {
            outgoing = outgoing.header(name, value);
        }
        let outgoing = outgoing.build().map_err(|e| command_error(e.to_string()))?;
        Ok::<_, super::CommandError>((client, outgoing))
    }
    .await;
    let (client, outgoing) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            work.settle(&Err(error.message.clone()))
                .await
                .map_err(command_error)?;
            return Err(error);
        }
    };
    http.start(
        window.label(),
        request.request_id,
        reservation,
        work,
        request.provider_id,
        client,
        outgoing,
    )
    .await
    .map_err(command_error)
}

#[tauri::command]
pub(crate) async fn chat_admission_http_read(
    http: State<'_, crate::ai::admitted_http::AdmittedHttp>,
    window: WebviewWindow,
    request_id: String,
) -> CommandResult<crate::ai::admitted_http::HttpPart> {
    http.read(window.label(), &request_id)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub(crate) async fn chat_admission_http_finish(
    http: State<'_, crate::ai::admitted_http::AdmittedHttp>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    ai_state: State<'_, crate::ai::AiState>,
    window: WebviewWindow,
    context: ChatAdmissionContext,
    conversation_id: String,
    request_id: String,
    outcome: crate::ai::admitted_http::HttpOutcome,
) -> CommandResult<ProviderJoinReceipt> {
    let parent = admission_runtime
        .parent(window.label(), &context, &conversation_id)
        .await?;
    // Check the exact parent/request relation before stopping any task.
    parent.provider_invocation_phase(&request_id).await?;
    http.finish(window.label(), &request_id, outcome)
        .await
        .map_err(command_error)?;
    let joined = ai_state.join_stream_task(&request_id).await;
    let phase = parent.provider_invocation_phase(&request_id).await?;
    http.remove(window.label(), &request_id).await;
    Ok(ProviderJoinReceipt {
        phase,
        task_error: joined.and_then(Result::err),
    })
}

#[tauri::command]
pub(crate) async fn chat_admission_finish_response(
    pool: State<'_, DbPool>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    context: ChatAdmissionContext,
    conversation_id: String,
    mut params: super::DbUpdateMessageParams,
) -> CommandResult<()> {
    let input = params.take_input();
    let fingerprint = crate::db::chat_admission::runtime::completion_fingerprint("response", &input)?;
    if crate::db::chat_admission::runtime::replay_completion(&pool, window.label(), &context, &conversation_id, &fingerprint).await? {
        return Ok(());
    }
    let result = admission_runtime.finish_response(window.label(), &context, &conversation_id, input).await;
    if result.is_err() && crate::db::chat_admission::runtime::replay_completion(&pool, window.label(), &context, &conversation_id, &fingerprint).await? {
        return Ok(());
    }
    result.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_finish_compaction(
    pool: State<'_, DbPool>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    context: ChatAdmissionContext,
    conversation_id: String,
    input: Option<crate::db::models::UpsertConversationCompactionStateInput>,
) -> CommandResult<()> {
    let fingerprint = crate::db::chat_admission::runtime::completion_fingerprint("compaction", &input)?;
    if crate::db::chat_admission::runtime::replay_completion(&pool, window.label(), &context, &conversation_id, &fingerprint).await? {
        return Ok(());
    }
    let result = admission_runtime.finish_compaction(window.label(), &context, &conversation_id, input).await;
    if result.is_err() && crate::db::chat_admission::runtime::replay_completion(&pool, window.label(), &context, &conversation_id, &fingerprint).await? {
        return Ok(());
    }
    result.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_acknowledge_completion(
    pool: State<'_, DbPool>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    context: ChatAdmissionContext,
    conversation_id: String,
) -> CommandResult<()> {
    admission_runtime.acknowledge_completion(&pool, window.label(), &context, &conversation_id).await.map_err(Into::into)
}

/// Reserve before asynchronous validation, then retain the actual executor task.
pub(crate) async fn admit_tool(
    runtime: &ChatAdmissionRuntime,
    ai_state: &crate::ai::AiState,
    caller: &str,
    admission: crate::db::chat_admission::runtime::ChatToolAdmission,
) -> CommandResult<(
    crate::ai::stream_tasks::StreamReservation,
    std::sync::Arc<crate::db::chat_admission::OperationPermit>,
)> {
    let reservation = ai_state
        .reserve_stream(admission.request_id.clone())
        .map_err(command_error)?;
    let parent = runtime
        .parent(
            caller,
            &admission.context,
            &admission.identity.conversation_id,
        )
        .await?;
    let tool = parent.tool_permit(&admission.identity).await?;
    let work = tool
        .child(
            crate::db::chat_admission::WorkKind::Tool,
            Some(&admission.request_id),
        )
        .await?;
    Ok((reservation, std::sync::Arc::new(work)))
}


#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum IntentAdmission {
    GlobalChat { receipt: crate::db::chat_admission::intents::IntentReceipt },
    Conversation,
}

#[tauri::command]
pub(crate) async fn chat_admission_begin_intent(
    pool: State<'_, DbPool>, admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow, runtime: String,
    identity: crate::db::chat_admission::intents::IntentIdentity, mutation: crate::db::chat_admission::intents::IntentMutation,
) -> CommandResult<IntentAdmission> {
    let page = admission_runtime.current_page(window.label());
    let database = get_pool(&pool).await?;
    let mut connection = database.acquire().await.map_err(|error| command_error(error.to_string()))?;
    let scope = crate::db::chat_admission::intents::classify_copy(&mut connection, &identity.conversation_id, mutation).await?;
    drop(connection);
    match scope {
        crate::db::chat_admission::intents::IntentScope::GlobalChat => {},
        // Only removal is classified Removed. This cleans up an orphaned copy
        // without touching old markers/effects or reviving a tombstoned ID.
        _ => return Ok(IntentAdmission::Conversation),
    }
    admission_runtime.open_browser_on_page(pool.inner().clone(), window.label(), &runtime, &page).await?;
    let receipt = admission_runtime.begin_intent(&pool, window.label(), &runtime, identity, mutation).await?;
    Ok(IntentAdmission::GlobalChat { receipt })
}

#[tauri::command]
pub(crate) async fn chat_admission_finish_intent(
    pool: State<'_, DbPool>, admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow, receipt: crate::db::chat_admission::intents::IntentReceipt,
) -> CommandResult<()> {
    admission_runtime.finish_intent(&pool, window.label(), &receipt).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_write_approval_registry(
    pool: State<'_, DbPool>, window: WebviewWindow, conversation_id: String,
    receipt: Option<crate::db::chat_admission::intents::IntentReceipt>,
    expected_value_json: Option<String>, value_json: Option<String>,
) -> CommandResult<()> {
    crate::db::chat_admission::intents::write_approval_registry(&pool, window.label(), &conversation_id,
        receipt.as_ref(), expected_value_json.as_deref(), value_json.as_deref()).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_complete_steer_handoff(
    admission_runtime: State<'_, ChatAdmissionRuntime>, window: WebviewWindow,
    context: ChatAdmissionContext, conversation_id: String, request_id: String,
    receipts: Vec<crate::db::chat_admission::intents::IntentReceipt>,
) -> CommandResult<()> {
    let parent = admission_runtime.parent(window.label(), &context, &conversation_id).await?;
    crate::db::chat_admission::intents::complete_steer_handoff(&parent, window.label(), &request_id, &receipts).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_complete_question_handoff(
    admission_runtime: State<'_, ChatAdmissionRuntime>, window: WebviewWindow,
    context: ChatAdmissionContext, conversation_id: String, response_message_id: String,
    receipt: crate::db::chat_admission::intents::IntentReceipt,
) -> CommandResult<()> {
    let parent = admission_runtime.parent(window.label(), &context, &conversation_id).await?;
    crate::db::chat_admission::intents::complete_question_handoff(&parent, window.label(), &receipt, &response_message_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_reserve_response(
    admission_runtime: State<'_, ChatAdmissionRuntime>, window: WebviewWindow,
    context: ChatAdmissionContext, conversation_id: String, message_id: String,
) -> CommandResult<crate::db::chat_admission::intents::IntentReceipt> {
    let parent = admission_runtime.parent(window.label(), &context, &conversation_id).await?;
    crate::db::chat_admission::intents::reserve_response(&parent, window.label(), &message_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_prepare_response_recovery(
    pool: State<'_, DbPool>, admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow, runtime: String, conversation_id: String, message_id: String,
    mutation: crate::db::chat_admission::intents::IntentMutation,
) -> CommandResult<IntentAdmission> {
    let page = admission_runtime.current_page(window.label());
    let database = get_pool(&pool).await?;
    let mut connection = database.acquire().await.map_err(|error| command_error(error.to_string()))?;
    let scope = crate::db::chat_admission::intents::classify_copy(&mut connection, &conversation_id, mutation).await?;
    drop(connection);
    if scope != crate::db::chat_admission::intents::IntentScope::GlobalChat { return Ok(IntentAdmission::Conversation); }
    admission_runtime.open_browser_on_page(pool.inner().clone(), window.label(), &runtime, &page).await?;
    let identity = crate::db::chat_admission::intents::response_recovery_identity(&pool, &conversation_id, &message_id).await?;
    let receipt = admission_runtime.begin_intent(&pool, window.label(), &runtime, identity, mutation).await?;
    Ok(IntentAdmission::GlobalChat { receipt })
}

#[tauri::command]
pub(crate) async fn chat_admission_recover_response(
    pool: State<'_, DbPool>, window: WebviewWindow,
    receipt: crate::db::chat_admission::intents::IntentReceipt, mut params: super::DbUpdateMessageParams,
) -> CommandResult<()> {
    crate::db::chat_admission::intents::recover_response(&pool, window.label(), &receipt, params.take_input()).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_begin_reconciliation(
    pool: State<'_, DbPool>, admission_runtime: State<'_, ChatAdmissionRuntime>, window: WebviewWindow,
    runtime: String, conversation_id: String,
) -> CommandResult<String> {
    admission_runtime.begin_reconciliation(&pool,window.label(),&runtime,&conversation_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn chat_admission_complete_reconciliation(
    pool: State<'_, DbPool>, admission_runtime: State<'_, ChatAdmissionRuntime>, window: WebviewWindow,
    runtime: String, handle: String, observed: crate::db::chat_admission::reconciliation::BrowserInspection,
) -> CommandResult<()> {
    admission_runtime.complete_reconciliation(&pool,window.label(),&runtime,&handle,&observed).await.map_err(Into::into)
}
