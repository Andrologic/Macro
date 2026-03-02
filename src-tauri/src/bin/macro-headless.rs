use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use macro_lib::commands::{git, execute_workspace_tool};
use macro_lib::core::error::BackendError;
use macro_lib::core::tool_policy::{get_mode_policy, validate_tool_execution, ToolModePolicyResult, ToolValidationResult};
use macro_lib::core::load_config;
use macro_lib::git::GitState;
use macro_lib::workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone)]
struct HeadlessState {
    bearer_token: Option<String>,
    workspace_path: PathBuf,
    git_state: GitState,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
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
}

#[derive(Debug, Serialize)]
struct ApiError {
    message: String,
}

fn backend_error_to_status(error: &BackendError) -> StatusCode {
    match error {
        BackendError::FilesystemNotFound { .. }
        | BackendError::GitRepositoryNotFound { .. }
        | BackendError::GitBranchNotFound { .. }
        | BackendError::GitInvalidCommit { .. }
        | BackendError::NotFound(_) => StatusCode::NOT_FOUND,
        BackendError::Validation(_) => StatusCode::BAD_REQUEST,
        BackendError::FilesystemPathOutsideWorkspace { .. } => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn backend_error_response(error: BackendError) -> axum::response::Response {
    let status = backend_error_to_status(&error);
    (
        status,
        Json(ApiError {
            message: error.to_string(),
        }),
    )
        .into_response()
}

async fn resolve_project_repo_path(state: &HeadlessState, project_id: &str) -> Result<String, BackendError> {
    let groups = workspace::list_projects(&state.workspace_path).await?;

    let project = groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .find(|project| project.id == project_id)
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    Ok(project.path.clone())
}

fn authorized(headers: &HeaderMap, state: &HeadlessState) -> bool {
    let Some(expected) = state.bearer_token.as_ref() else {
        return true;
    };

    let Some(auth_value) = headers.get(header::AUTHORIZATION) else {
        return false;
    };

    let Ok(auth_str) = auth_value.to_str() else {
        return false;
    };

    let provided = auth_str.strip_prefix("Bearer ").unwrap_or_default();
    provided == expected
}

fn unauthorized_response() -> impl IntoResponse {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError {
            message: "Unauthorized".to_string(),
        }),
    )
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "macro-headless",
    })
}

async fn tool_mode_policy(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Query(params): Query<ModePolicyQuery>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let result: ToolModePolicyResult = get_mode_policy(&params.mode);
    (StatusCode::OK, Json(result)).into_response()
}

async fn tool_validate(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ToolValidationRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let result: ToolValidationResult =
        validate_tool_execution(&payload.mode, &payload.tool_id, payload.path.as_deref());
    (StatusCode::OK, Json(result)).into_response()
}

async fn tool_execute(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ToolExecuteRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    match execute_workspace_tool(
        state.workspace_path.clone(),
        state.git_state.clone(),
        payload.mode,
        payload.tool_id,
        payload.args,
    )
    .await
    {
        Ok(result) => (StatusCode::OK, Json(json!({ "result": result }))).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                message: error.message,
            }),
        )
            .into_response(),
    }
}

async fn workspace_bootstrap(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    match workspace::get_bootstrap(&state.workspace_path).await {
        Ok(bootstrap) => (StatusCode::OK, Json(bootstrap)).into_response(),
        Err(error) => backend_error_response(error),
    }
}

async fn workspace_bootstrap_scoped(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Path(_workspace_id): Path<String>,
) -> impl IntoResponse {
    workspace_bootstrap(State(state), headers).await
}

async fn workspace_tasks(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    match workspace::list_tasks(&state.workspace_path).await {
        Ok(tasks) => (StatusCode::OK, Json(json!({ "tasks": tasks }))).into_response(),
        Err(error) => backend_error_response(error),
    }
}

async fn workspace_tasks_scoped(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Path(_workspace_id): Path<String>,
) -> impl IntoResponse {
    workspace_tasks(State(state), headers).await
}

async fn project_git_tree(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let repo_path = match resolve_project_repo_path(&state, &project_id).await {
        Ok(path) => path,
        Err(error) => return backend_error_response(error),
    };

    let workspace_path = state.workspace_path.clone();
    let git_state = state.git_state.clone();

    let tree_result = tokio::task::spawn_blocking(move || {
        let validated = git::validate_repo_path(&repo_path, &workspace_path)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        git::build_git_tree(&repo, None)
    })
    .await;

    match tree_result {
        Ok(Ok(tree)) => (StatusCode::OK, Json(json!({ "tree": tree }))).into_response(),
        Ok(Err(error)) => backend_error_response(error),
        Err(error) => backend_error_response(BackendError::Internal {
            message: format!("Git task join error: {}", error),
        }),
    }
}

async fn project_git_commits(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let repo_path = match resolve_project_repo_path(&state, &project_id).await {
        Ok(path) => path,
        Err(error) => return backend_error_response(error),
    };

    let workspace_path = state.workspace_path.clone();
    let git_state = state.git_state.clone();

    let commits_result = tokio::task::spawn_blocking(move || {
        let validated = git::validate_repo_path(&repo_path, &workspace_path)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        git::build_git_log(&repo, 50, None)
    })
    .await;

    match commits_result {
        Ok(Ok(commits)) => (StatusCode::OK, Json(json!({ "commits": commits }))).into_response(),
        Ok(Err(error)) => backend_error_response(error),
        Err(error) => backend_error_response(BackendError::Internal {
            message: format!("Git task join error: {}", error),
        }),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .compact()
        .init();

    let host = std::env::var("MACRO_HEADLESS_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("MACRO_HEADLESS_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(8787);
    let bearer_token = std::env::var("MACRO_HEADLESS_BEARER_TOKEN").ok();
    let config = load_config()?;

    let state = Arc::new(HeadlessState {
        bearer_token,
        workspace_path: config.workspace_path,
        git_state: GitState::new(),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/tools/mode-policy", get(tool_mode_policy))
        .route("/v1/tools/validate", post(tool_validate))
        .route("/v1/tools/execute", post(tool_execute))
        .route("/api/v1/tools/mode-policy", get(tool_mode_policy))
        .route("/api/v1/tools/validate", post(tool_validate))
        .route("/api/v1/tools/execute", post(tool_execute))
        .route("/api/v1/workspace/bootstrap", get(workspace_bootstrap))
        .route("/api/v1/workspaces/{workspace_id}/bootstrap", get(workspace_bootstrap_scoped))
        .route("/api/v1/workspace/tasks", get(workspace_tasks))
        .route("/api/v1/workspaces/{workspace_id}/tasks", get(workspace_tasks_scoped))
        .route("/api/v1/projects/{project_id}/git/tree", get(project_git_tree))
        .route("/api/v1/projects/{project_id}/git/commits", get(project_git_commits))
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", host, port).parse()?;
    tracing::info!("macro-headless listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
