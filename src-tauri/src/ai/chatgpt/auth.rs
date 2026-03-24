use super::session::{build_token_claims, persist_chatgpt_session, resolve_token_expiry_rfc3339};
use super::types::{
    auth_flow_error_from_persist, build_auth_cancelled_html, build_auth_failure_html,
    build_auth_success_html, extract_response_error, resolve_browser_language,
    AiAuthCancelledEvent, AiAuthErrorEvent, AiAuthStartedEvent, AiAuthSuccessEvent, AuthFlowError,
    BrowserAuthCallbackQuery, BrowserAuthServerState, PkceCodes, TokenResponse,
    AUTH_TIMEOUT_SECONDS, CALLBACK_BIND_RETRY_ATTEMPTS, CALLBACK_BIND_RETRY_DELAY_MS,
    CHATGPT_AUTHORIZE_URL, CHATGPT_BROWSER_SOURCE, CHATGPT_CALLBACK_BIND_HOST,
    CHATGPT_CALLBACK_PATH, CHATGPT_CALLBACK_PORT, CHATGPT_CALLBACK_PUBLIC_HOST,
    CHATGPT_CANCEL_PATH, CHATGPT_CLIENT_ID, CHATGPT_TOKEN_URL, DEFAULT_ORIGINATOR,
};
use crate::ai::{AiState, AuthTask};
use crate::secrets::ChatGptSecret;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::CONTENT_TYPE;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::io::ErrorKind;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{oneshot, watch, Mutex};
use tracing::{debug, error, info, warn};

pub async fn start_browser_auth(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request_id: String,
    provider_id: String,
) -> Result<(), String> {
    info!(
        request_id = %request_id,
        provider_id = %provider_id,
        "starting ChatGPT browser auth"
    );
    cancel_active_auth_tasks(app_handle.clone(), &ai_state).await?;

    let request_id_for_task = request_id.clone();
    let provider_id_for_task = provider_id.clone();
    let app_for_task = app_handle.clone();
    let state_for_task = ai_state.clone();
    let (cancel_tx, cancel_rx) = watch::channel(false);

    let handle = tokio::spawn(async move {
        let result = run_browser_auth_flow(
            app_for_task.clone(),
            pool,
            &provider_id_for_task,
            &request_id_for_task,
            cancel_rx,
        )
        .await;

        if let Err(error) = result {
            warn!(
                request_id = %request_id_for_task,
                provider_id = %provider_id_for_task,
                code = %error.code,
                message = %error.message,
                "ChatGPT browser auth failed"
            );
            let _ = app_for_task.emit(
                "ai:auth-error",
                AiAuthErrorEvent {
                    request_id: request_id_for_task.clone(),
                    provider_id: provider_id_for_task.clone(),
                    code: error.code,
                    message: error.message,
                },
            );
        }

        let mut tasks = state_for_task.auth_tasks.lock().await;
        tasks.remove(&request_id_for_task);
    });

    let mut tasks = ai_state.auth_tasks.lock().await;
    tasks.insert(
        request_id,
        AuthTask {
            provider_id,
            handle,
            cancel_sender: cancel_tx,
        },
    );

    Ok(())
}

pub async fn cancel_auth(
    app_handle: AppHandle,
    ai_state: &AiState,
    request_id: &str,
) -> Result<(), String> {
    let mut tasks = ai_state.auth_tasks.lock().await;
    if let Some(task) = tasks.remove(request_id) {
        cancel_auth_task(&app_handle, request_id.to_string(), task)?;
    }
    Ok(())
}

async fn cancel_active_auth_tasks(app_handle: AppHandle, ai_state: &AiState) -> Result<(), String> {
    let cancelled = {
        let mut tasks = ai_state.auth_tasks.lock().await;
        let request_ids = tasks.keys().cloned().collect::<Vec<_>>();
        request_ids
            .into_iter()
            .filter_map(|request_id| tasks.remove(&request_id).map(|task| (request_id, task)))
            .collect::<Vec<_>>()
    };

    for (request_id, task) in cancelled {
        cancel_auth_task(&app_handle, request_id, task)?;
    }

    Ok(())
}

fn cancel_auth_task(
    app_handle: &AppHandle,
    request_id: String,
    task: AuthTask,
) -> Result<(), String> {
    info!(
        request_id = %request_id,
        provider_id = %task.provider_id,
        "cancelling ChatGPT browser auth task"
    );
    let _ = task.cancel_sender.send(true);
    task.handle.abort();
    app_handle
        .emit(
            "ai:auth-cancelled",
            AiAuthCancelledEvent {
                request_id,
                provider_id: task.provider_id,
            },
        )
        .map_err(|error| error.to_string())
}

async fn run_browser_auth_flow(
    app_handle: AppHandle,
    pool: SqlitePool,
    provider_id: &str,
    request_id: &str,
    cancel_rx: watch::Receiver<bool>,
) -> Result<(), AuthFlowError> {
    let pkce = generate_pkce();
    let state = generate_state_token();
    let (redirect_uri, callback_rx) =
        spawn_browser_auth_callback_server(state.clone(), cancel_rx).await?;
    let auth_url = build_authorize_url(&redirect_uri, &pkce, &state)?;
    info!(
        request_id = %request_id,
        provider_id = %provider_id,
        redirect_uri = %redirect_uri,
        "ChatGPT browser auth callback server ready"
    );

    app_handle
        .emit(
            "ai:auth-started",
            AiAuthStartedEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
            },
        )
        .map_err(|error| AuthFlowError::new("browser_open_failed", error.to_string()))?;

    info!(
        request_id = %request_id,
        provider_id = %provider_id,
        "opening ChatGPT authorization URL in browser"
    );
    app_handle
        .opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|error| {
            AuthFlowError::new(
                "browser_open_failed",
                format!("Failed to open your browser: {}", error),
            )
        })?;

    debug!(
        request_id = %request_id,
        provider_id = %provider_id,
        timeout_seconds = AUTH_TIMEOUT_SECONDS,
        "waiting for ChatGPT browser callback"
    );
    let code = tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECONDS), callback_rx)
        .await
        .map_err(|_| {
            AuthFlowError::new("callback_timeout", "Timed out waiting for ChatGPT login.")
        })?
        .map_err(|_| {
            AuthFlowError::new(
                "callback_timeout",
                "Browser callback channel closed unexpectedly.",
            )
        })??;

    let token_response = exchange_authorization_code(&redirect_uri, &pkce, &code)
        .await
        .map_err(|message| AuthFlowError::new("token_exchange_failed", message))?;
    info!(
        request_id = %request_id,
        provider_id = %provider_id,
        has_refresh_token = token_response
            .refresh_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        has_id_token = token_response
            .id_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        "ChatGPT authorization code exchange succeeded"
    );

    let access_token = token_response
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AuthFlowError::new(
                "token_exchange_failed",
                "Token exchange did not return an access token.",
            )
        })?;
    let refresh_token = token_response
        .refresh_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AuthFlowError::new(
                "token_exchange_failed",
                "Token exchange did not return a refresh token.",
            )
        })?;
    let id_token = token_response
        .id_token
        .filter(|value| !value.trim().is_empty());
    let claims = build_token_claims(&access_token, id_token.as_deref())
        .map_err(|message| AuthFlowError::new("token_exchange_failed", message))?;

    let secret = ChatGptSecret {
        access_token,
        refresh_token,
        access_token_expires_at: resolve_token_expiry_rfc3339(
            claims.expires_at,
            token_response.expires_in,
        ),
        account_id: claims.account_id.clone(),
        auth_source: CHATGPT_BROWSER_SOURCE.to_string(),
    };

    persist_chatgpt_session(&pool, provider_id, &secret, claims.plan_type, claims.email)
        .await
        .map_err(auth_flow_error_from_persist)?;

    info!(
        request_id = %request_id,
        provider_id = %provider_id,
        has_account_id = secret.account_id.is_some(),
        "ChatGPT auth completed and session persisted"
    );
    app_handle
        .emit(
            "ai:auth-success",
            AiAuthSuccessEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
            },
        )
        .map_err(|error| AuthFlowError::new("token_exchange_failed", error.to_string()))?;

    Ok(())
}

pub(super) async fn spawn_browser_auth_callback_server(
    expected_state: String,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(String, oneshot::Receiver<Result<String, AuthFlowError>>), AuthFlowError> {
    let listener = bind_browser_auth_callback_listener().await?;
    let redirect_uri = build_callback_redirect_uri();

    let (result_tx, result_rx) = oneshot::channel::<Result<String, AuthFlowError>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let state = BrowserAuthServerState {
        expected_state,
        result_sender: Arc::new(Mutex::new(Some(result_tx))),
        shutdown_sender: Arc::new(Mutex::new(Some(shutdown_tx))),
    };

    let router = Router::new()
        .route(CHATGPT_CALLBACK_PATH, get(handle_browser_callback))
        .route(CHATGPT_CANCEL_PATH, get(handle_browser_cancel))
        .with_state(state);

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                tokio::select! {
                    _ = async {
                        let _ = shutdown_rx.await;
                    } => {}
                    _ = async {
                        let _ = cancel_rx.changed().await;
                    } => {}
                }
            })
            .await;
    });

    debug!(redirect_uri = %redirect_uri, "spawned ChatGPT callback server");
    Ok((redirect_uri, result_rx))
}

async fn bind_browser_auth_callback_listener() -> Result<tokio::net::TcpListener, AuthFlowError> {
    let bind_address = (CHATGPT_CALLBACK_BIND_HOST, CHATGPT_CALLBACK_PORT);
    let mut cancel_attempted = false;

    for attempt in 0..CALLBACK_BIND_RETRY_ATTEMPTS {
        match tokio::net::TcpListener::bind(bind_address).await {
            Ok(listener) => {
                info!(
                    host = CHATGPT_CALLBACK_BIND_HOST,
                    port = CHATGPT_CALLBACK_PORT,
                    attempt = attempt + 1,
                    "bound ChatGPT callback listener"
                );
                return Ok(listener);
            }
            Err(error) if error.kind() == ErrorKind::AddrInUse => {
                warn!(
                    host = CHATGPT_CALLBACK_BIND_HOST,
                    port = CHATGPT_CALLBACK_PORT,
                    attempt = attempt + 1,
                    "ChatGPT callback port already in use"
                );
                if !cancel_attempted {
                    cancel_attempted = true;
                    request_existing_auth_server_cancel().await;
                }

                if attempt + 1 < CALLBACK_BIND_RETRY_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(CALLBACK_BIND_RETRY_DELAY_MS)).await;
                    continue;
                }

                return Err(AuthFlowError::new(
                    "callback_bind_failed",
                    format!(
                        "The local ChatGPT login callback on {} is already in use. Close any other pending Macro or Codex login window and try again.",
                        build_callback_redirect_uri()
                    ),
                ));
            }
            Err(error) => {
                error!(
                    host = CHATGPT_CALLBACK_BIND_HOST,
                    port = CHATGPT_CALLBACK_PORT,
                    attempt = attempt + 1,
                    error = %error,
                    "failed to bind ChatGPT callback listener"
                );
                return Err(AuthFlowError::new(
                    "callback_bind_failed",
                    format!(
                        "Failed to bind the local ChatGPT login callback on {}:{}: {}",
                        CHATGPT_CALLBACK_BIND_HOST, CHATGPT_CALLBACK_PORT, error
                    ),
                ));
            }
        }
    }

    Err(AuthFlowError::new(
        "callback_bind_failed",
        "Failed to bind the local ChatGPT login callback.",
    ))
}

async fn request_existing_auth_server_cancel() {
    let cancel_url = format!(
        "http://{}:{}{}",
        CHATGPT_CALLBACK_BIND_HOST, CHATGPT_CALLBACK_PORT, CHATGPT_CANCEL_PATH
    );

    debug!(
        cancel_url = %cancel_url,
        "requesting cancellation of existing ChatGPT callback server"
    );
    match reqwest::Client::new()
        .get(cancel_url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => {
            info!(
                status = %response.status(),
                "existing ChatGPT callback server responded to cancel request"
            );
        }
        Err(error) => {
            debug!(error = %error, "no active ChatGPT callback server responded to cancel request");
        }
    }
}

fn build_callback_redirect_uri() -> String {
    format!(
        "http://{}:{}{}",
        CHATGPT_CALLBACK_PUBLIC_HOST, CHATGPT_CALLBACK_PORT, CHATGPT_CALLBACK_PATH
    )
}

async fn handle_browser_callback(
    headers: HeaderMap,
    State(state): State<BrowserAuthServerState>,
    Query(query): Query<BrowserAuthCallbackQuery>,
) -> Html<String> {
    let language = resolve_browser_language(
        headers
            .get("accept-language")
            .and_then(|value| value.to_str().ok()),
    );
    let has_error = query.error.is_some();
    let has_code = query
        .code
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let state_valid = query.state.as_deref() == Some(state.expected_state.as_str());
    info!(
        has_error,
        has_code, state_valid, "received ChatGPT browser callback"
    );

    let result = match query.error {
        Some(error) => Err(AuthFlowError::new(
            "callback_denied",
            query
                .error_description
                .unwrap_or_else(|| format!("Authentication was denied: {}", error)),
        )),
        None => {
            if query.state.as_deref() != Some(state.expected_state.as_str()) {
                Err(AuthFlowError::new(
                    "callback_invalid",
                    "The ChatGPT login callback returned an invalid state token.",
                ))
            } else if let Some(code) = query.code.filter(|value| !value.trim().is_empty()) {
                Ok(code)
            } else {
                Err(AuthFlowError::new(
                    "callback_invalid",
                    "The ChatGPT login callback did not include an authorization code.",
                ))
            }
        }
    };

    match &result {
        Ok(_) => info!("ChatGPT browser callback accepted"),
        Err(error) => warn!(
            code = %error.code,
            message = %error.message,
            "ChatGPT browser callback rejected"
        ),
    }

    if let Some(sender) = state.result_sender.lock().await.take() {
        let _ = sender.send(result.clone());
    }
    if let Some(sender) = state.shutdown_sender.lock().await.take() {
        let _ = sender.send(());
    }

    match result {
        Ok(_) => Html(build_auth_success_html(language)),
        Err(error) => Html(build_auth_failure_html(language, &error.message)),
    }
}

async fn handle_browser_cancel(
    headers: HeaderMap,
    State(state): State<BrowserAuthServerState>,
) -> Html<String> {
    let language = resolve_browser_language(
        headers
            .get("accept-language")
            .and_then(|value| value.to_str().ok()),
    );
    info!("received ChatGPT local callback cancellation request");
    let _ = state.result_sender.lock().await.take();
    if let Some(sender) = state.shutdown_sender.lock().await.take() {
        let _ = sender.send(());
    }

    Html(build_auth_cancelled_html(language))
}

async fn exchange_authorization_code(
    redirect_uri: &str,
    pkce: &PkceCodes,
    code: &str,
) -> Result<TokenResponse, String> {
    debug!(redirect_uri = %redirect_uri, "exchanging ChatGPT authorization code");
    let client = reqwest::Client::new();
    let response = client
        .post(CHATGPT_TOKEN_URL)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(build_oauth_form_body(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", CHATGPT_CLIENT_ID),
            ("code_verifier", &pkce.verifier),
        ]))
        .send()
        .await
        .map_err(|error| format!("Failed to exchange ChatGPT authorization code: {}", error))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        warn!(
            status = status.as_u16(),
            response_error = %extract_response_error(status.as_u16(), &body),
            "ChatGPT authorization code exchange returned non-success status"
        );
        return Err(extract_response_error(status.as_u16(), &body));
    }

    let token_response = response
        .json::<TokenResponse>()
        .await
        .map_err(|error| format!("Failed to parse ChatGPT token exchange response: {}", error))?;
    debug!(
        has_refresh_token = token_response
            .refresh_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        has_id_token = token_response
            .id_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        "parsed ChatGPT token exchange response"
    );
    Ok(token_response)
}

fn generate_state_token() -> String {
    format!("macro_{}", uuid::Uuid::new_v4())
}

fn generate_pkce() -> PkceCodes {
    let verifier_seed = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let verifier = URL_SAFE_NO_PAD.encode(verifier_seed.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    PkceCodes {
        verifier,
        challenge,
    }
}

pub(super) fn build_authorize_url(
    redirect_uri: &str,
    pkce: &PkceCodes,
    state: &str,
) -> Result<reqwest::Url, AuthFlowError> {
    let mut url = reqwest::Url::parse(CHATGPT_AUTHORIZE_URL)
        .map_err(|error| AuthFlowError::new("browser_open_failed", error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CHATGPT_CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair(
            "scope",
            "openid profile email offline_access api.connectors.read api.connectors.invoke",
        )
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", state)
        .append_pair("originator", DEFAULT_ORIGINATOR);
    Ok(url)
}

pub(super) fn build_oauth_form_body(params: &[(&str, &str)]) -> String {
    params
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                urlencoding::encode(key),
                urlencoding::encode(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}
