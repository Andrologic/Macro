use crate::commands::terminal::{
    create_legacy_session_internal, kill_legacy_session_internal, read_legacy_session_internal,
    run_legacy_session_internal, TerminalSessionStore,
};
use crate::commands::{execute_workspace_tool, CommandError};
use crate::core::tool_policy::{get_mode_policy, validate_tool_execution};
use crate::git::GitState;
use crate::WorkspaceMetadataRoot;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ToolHostConfig {
    pub base_url: String,
    pub bearer_token: String,
}

#[derive(Clone)]
struct ToolHostState {
    bearer_token: String,
    workspace_metadata_root: WorkspaceMetadataRoot,
    git_state: GitState,
    terminal_store: TerminalSessionStore,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[derive(Debug, Serialize)]
struct ApiError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct ModePolicyQuery {
    mode: String,
}

#[derive(Debug, Deserialize)]
struct ToolValidationRequest {
    mode: String,
    tool_id: String,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ToolExecuteRequest {
    mode: String,
    tool_id: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    workspace_scope: Option<String>,
}

fn authorized(headers: &HeaderMap, state: &ToolHostState) -> bool {
    let Some(auth_value) = headers.get(header::AUTHORIZATION) else {
        return false;
    };

    let Ok(auth_str) = auth_value.to_str() else {
        return false;
    };

    let provided = auth_str.strip_prefix("Bearer ").unwrap_or_default();
    provided == state.bearer_token
}

fn unauthorized_response() -> impl IntoResponse {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError {
            message: "Unauthorized".to_string(),
        }),
    )
}

fn command_error_response(error: CommandError) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            message: error.message,
        }),
    )
        .into_response()
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "macro-tool-host",
    })
}

async fn tool_mode_policy(
    State(state): State<Arc<ToolHostState>>,
    headers: HeaderMap,
    Query(params): Query<ModePolicyQuery>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    (StatusCode::OK, Json(get_mode_policy(&params.mode))).into_response()
}

async fn tool_validate(
    State(state): State<Arc<ToolHostState>>,
    headers: HeaderMap,
    Json(payload): Json<ToolValidationRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    (
        StatusCode::OK,
        Json(validate_tool_execution(
            &payload.mode,
            &payload.tool_id,
            payload.path.as_deref(),
        )),
    )
        .into_response()
}

async fn tool_execute(
    State(state): State<Arc<ToolHostState>>,
    headers: HeaderMap,
    Json(payload): Json<ToolExecuteRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let workspace_root = state.workspace_metadata_root.0.read().await.clone();

    let result = match payload.tool_id.as_str() {
        "terminal_create_session" => {
            let project_id = payload
                .args
                .get("project_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| CommandError {
                    message: "Missing project_id argument for terminal_create_session.".to_string(),
                })
                .map(str::to_string);

            match project_id {
                Ok(project_id) => create_legacy_session_internal(
                    workspace_root.clone(),
                    state.git_state.clone(),
                    state.terminal_store.clone(),
                    project_id,
                    payload
                        .args
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                )
                .await
                .and_then(|dto| {
                    serde_json::to_string_pretty(&dto).map_err(|error| CommandError {
                        message: error.to_string(),
                    })
                }),
                Err(error) => Err(error),
            }
        }
        "terminal_run" => {
            let session_id = payload
                .args
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| CommandError {
                    message: "Missing session_id argument for terminal_run.".to_string(),
                })
                .map(str::to_string);
            let command = payload
                .args
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| CommandError {
                    message: "Missing command argument for terminal_run.".to_string(),
                });

            match (session_id, command) {
                (Ok(session_id), Ok(command)) => run_legacy_session_internal(
                    state.terminal_store.clone(),
                    session_id,
                    command,
                    payload.args.get("timeout_ms").and_then(Value::as_u64),
                )
                .await
                .and_then(|dto| {
                    serde_json::to_string_pretty(&dto).map_err(|error| CommandError {
                        message: error.to_string(),
                    })
                }),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "terminal_read" => {
            let session_id = payload
                .args
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| CommandError {
                    message: "Missing session_id argument for terminal_read.".to_string(),
                })
                .map(str::to_string);

            match session_id {
                Ok(session_id) => {
                    read_legacy_session_internal(state.terminal_store.clone(), session_id)
                        .await
                        .and_then(|dto| {
                            serde_json::to_string_pretty(&dto).map_err(|error| CommandError {
                                message: error.to_string(),
                            })
                        })
                }
                Err(error) => Err(error),
            }
        }
        "terminal_kill" => {
            let session_id = payload
                .args
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| CommandError {
                    message: "Missing session_id argument for terminal_kill.".to_string(),
                })
                .map(str::to_string);

            match session_id {
                Ok(session_id) => {
                    kill_legacy_session_internal(state.terminal_store.clone(), session_id)
                        .await
                        .and_then(|dto| {
                            serde_json::to_string_pretty(&dto).map_err(|error| CommandError {
                                message: error.to_string(),
                            })
                        })
                }
                Err(error) => Err(error),
            }
        }
        _ => {
            execute_workspace_tool(
                workspace_root.clone(),
                workspace_root,
                state.git_state.clone(),
                payload.mode,
                payload.tool_id,
                payload.args,
                payload.workspace_path,
                payload.workspace_scope,
            )
            .await
        }
    };

    match result {
        Ok(result) => (StatusCode::OK, Json(json!({ "result": result }))).into_response(),
        Err(error) => command_error_response(error),
    }
}

pub fn start(
    workspace_metadata_root: WorkspaceMetadataRoot,
    git_state: GitState,
    terminal_store: TerminalSessionStore,
) -> Result<ToolHostConfig, String> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Failed to bind Macro tool host: {}", error))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to configure Macro tool host listener: {}", error))?;
    let address = std_listener
        .local_addr()
        .map_err(|error| format!("Failed to resolve Macro tool host address: {}", error))?;

    let bearer_token = Uuid::new_v4().to_string();
    let state = Arc::new(ToolHostState {
        bearer_token: bearer_token.clone(),
        workspace_metadata_root,
        git_state,
        terminal_store,
    });

    let router = Router::new()
        .route("/health", get(health))
        .route("/v1/tools/mode-policy", get(tool_mode_policy))
        .route("/v1/tools/validate", post(tool_validate))
        .route("/v1/tools/execute", post(tool_execute))
        .route("/api/v1/tools/mode-policy", get(tool_mode_policy))
        .route("/api/v1/tools/validate", post(tool_validate))
        .route("/api/v1/tools/execute", post(tool_execute))
        .with_state(state);

    std::thread::Builder::new()
        .name("macro-tool-host".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    tracing::error!("Failed to build Macro tool host runtime: {}", error);
                    return;
                }
            };

            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(std_listener) {
                    Ok(listener) => listener,
                    Err(error) => {
                        tracing::error!("Failed to create Macro tool host listener: {}", error);
                        return;
                    }
                };

                if let Err(error) = axum::serve(listener, router).await {
                    tracing::error!("Macro tool host exited: {}", error);
                }
            });
        })
        .map_err(|error| format!("Failed to start Macro tool host thread: {}", error))?;

    Ok(ToolHostConfig {
        base_url: format!("http://{}", address),
        bearer_token,
    })
}
