use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use macro_lib::commands::workspace_tools::{
    validate_headless_project_mounts, validate_headless_workspace_path,
};
use macro_lib::commands::{execute_workspace_tool, git, WorkspaceProjectMount};
use macro_lib::core::error::BackendError;
use macro_lib::core::load_config;
use macro_lib::core::tool_policy::{
    get_mode_policy, validate_tool_execution, ToolModePolicyResult, ToolValidationResult,
};
use macro_lib::git::GitState;
use macro_lib::project_path::parse_wsl_unc_path;
use macro_lib::workspace;
use macro_lib::workspace::metadata::{
    WorkspaceArchitectActivatePlanChatRequestDto, WorkspaceArchitectActivatePlanHeadRequestDto,
    WorkspaceArchitectListPlansRequestDto,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};

#[derive(Clone)]
struct HeadlessState {
    bearer_token: Option<String>,
    allowed_roots: Vec<PathBuf>,
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
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    workspace_scope: Option<String>,
    #[serde(default)]
    project_mounts: Option<Vec<WorkspaceProjectMount>>,
    #[serde(default)]
    virtual_root_enabled: Option<bool>,
    #[serde(default)]
    focused_project_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ApiError {
    message: String,
}

const DEFAULT_HEADLESS_CORS_ORIGINS: [&str; 6] = [
    "http://localhost:4173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://127.0.0.1:5173",
    "http://tauri.localhost",
    "tauri://localhost",
];

fn normalize_bearer_token(raw: Option<String>) -> Option<String> {
    raw.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn parse_listen_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    let trimmed = host.trim();
    let unwrapped = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed);
    let ip = unwrapped.parse::<IpAddr>().or_else(|_| {
        if unwrapped.eq_ignore_ascii_case("localhost") {
            Ok(IpAddr::V4(Ipv4Addr::LOCALHOST))
        } else {
            Err(format!(
                "MACRO_HEADLESS_HOST must be an IP address or localhost: {}",
                host
            ))
        }
    })?;
    Ok(SocketAddr::new(ip, port))
}

fn validate_listen_security(addr: SocketAddr, bearer_token: Option<&str>) -> Result<(), String> {
    if addr.ip().is_loopback() || bearer_token.is_some_and(|token| !token.is_empty()) {
        return Ok(());
    }

    Err(format!(
        "Refusing non-loopback headless listener {} without MACRO_HEADLESS_BEARER_TOKEN",
        addr
    ))
}

fn configured_headless_allowed_roots(workspace_path: &PathBuf) -> Result<Vec<PathBuf>, String> {
    let mut configured = vec![workspace_path.clone()];
    if let Ok(raw_roots) = std::env::var("MACRO_HEADLESS_ALLOWED_ROOTS") {
        configured
            .extend(std::env::split_paths(&raw_roots).filter(|path| !path.as_os_str().is_empty()));
    }

    let mut canonical_roots = Vec::new();
    for root in configured {
        let canonical = root.canonicalize().map_err(|error| {
            format!(
                "Headless allowed root is not accessible: {} ({})",
                root.display(),
                error
            )
        })?;
        if !canonical.is_dir() {
            return Err(format!(
                "Headless allowed root is not a directory: {}",
                root.display()
            ));
        }
        if !canonical_roots.contains(&canonical) {
            canonical_roots.push(canonical);
        }
    }
    Ok(canonical_roots)
}

fn configured_cors_origins() -> Result<Vec<HeaderValue>, String> {
    let mut origins = DEFAULT_HEADLESS_CORS_ORIGINS
        .iter()
        .map(|origin| (*origin).to_string())
        .collect::<Vec<_>>();
    if let Ok(raw_origins) = std::env::var("MACRO_HEADLESS_CORS_ORIGINS") {
        for origin in raw_origins.split(',').map(str::trim) {
            if origin.is_empty() {
                continue;
            }
            if origin == "*" {
                return Err(
                    "MACRO_HEADLESS_CORS_ORIGINS must not contain the wildcard origin (*)"
                        .to_string(),
                );
            }
            if !origins.iter().any(|configured| configured == origin) {
                origins.push(origin.to_string());
            }
        }
    }

    origins
        .into_iter()
        .map(|origin| {
            HeaderValue::from_str(&origin)
                .map_err(|error| format!("Invalid headless CORS origin '{}': {}", origin, error))
        })
        .collect()
}

fn headless_cors_layer() -> Result<CorsLayer, String> {
    Ok(CorsLayer::new()
        .allow_origin(AllowOrigin::list(configured_cors_origins()?))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]))
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

fn resolve_metadata_root_for_workspace(state: &HeadlessState) -> Result<PathBuf, BackendError> {
    if parse_wsl_unc_path(&state.workspace_path.to_string_lossy()).is_some() {
        return Err(BackendError::Git {
            message: "Macro metadata is not yet available for WSL projects.".to_string(),
        });
    }

    match state
        .git_state
        .resolve_macro_metadata_root(&state.workspace_path)
    {
        Ok(path) => Ok(path),
        Err(error) => {
            let error_message = error.to_string();
            if let Some(metadata_worktree) =
                macro_lib::git::find_existing_macro_metadata_worktree_root(&state.workspace_path)
            {
                tracing::warn!(
                    action = "headless_metadata_root_existing_worktree_fallback",
                    workspace_path = %state.workspace_path.display(),
                    fallback_path = %metadata_worktree.display(),
                    reason = %error_message
                );
                return Ok(metadata_worktree);
            }
            let BackendError::GitRepositoryNotFound { message } = error else {
                return Err(error);
            };
            let fallback = state.workspace_path.join(".macro");
            tracing::warn!(
                action = "headless_metadata_root_fallback",
                workspace_path = %state.workspace_path.display(),
                fallback_path = %fallback.display(),
                reason = %message
            );
            Ok(fallback)
        }
    }
}

async fn resolve_project_repo_path(
    state: &HeadlessState,
    project_id: &str,
) -> Result<String, BackendError> {
    let metadata_root = resolve_metadata_root_for_workspace(state)?;
    let project = workspace::get_project_by_id(&state.workspace_path, &metadata_root, project_id)
        .await?
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    Ok(project.path)
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

async fn health(State(state): State<Arc<HeadlessState>>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    Json(HealthResponse {
        status: "ok",
        service: "macro-headless",
    })
    .into_response()
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
    Json(mut payload): Json<ToolExecuteRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    payload.workspace_path = match validate_headless_workspace_path(
        payload.workspace_path.as_deref(),
        &state.workspace_path,
        &state.allowed_roots,
    ) {
        Ok(path) => path,
        Err(error) => {
            return (
                StatusCode::FORBIDDEN,
                Json(ApiError {
                    message: error.message,
                }),
            )
                .into_response()
        }
    };
    payload.project_mounts = match payload.project_mounts.as_deref() {
        Some(mounts) => match validate_headless_project_mounts(mounts, &state.allowed_roots) {
            Ok(mounts) => Some(mounts),
            Err(error) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(ApiError {
                        message: error.message,
                    }),
                )
                    .into_response()
            }
        },
        None => None,
    };

    match execute_workspace_tool(
        state.workspace_path.clone(),
        state.workspace_path.clone(),
        state.git_state.clone(),
        payload.mode,
        payload.tool_id,
        payload.args,
        payload.workspace_path,
        payload.workspace_scope,
        payload.project_mounts,
        payload.virtual_root_enabled,
        payload.focused_project_id,
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

    let metadata_root = match resolve_metadata_root_for_workspace(&state) {
        Ok(path) => path,
        Err(error) => return backend_error_response(error),
    };

    match workspace::get_bootstrap(&state.workspace_path, &metadata_root).await {
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

    let metadata_root = match resolve_metadata_root_for_workspace(&state) {
        Ok(path) => path,
        Err(error) => return backend_error_response(error),
    };

    match workspace::list_tasks(&state.workspace_path, &metadata_root).await {
        Ok(task_catalog) => (StatusCode::OK, Json(task_catalog)).into_response(),
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

async fn workspace_architect_list_plans(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<WorkspaceArchitectListPlansRequestDto>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let metadata_root = match resolve_metadata_root_for_workspace(&state) {
        Ok(path) => path,
        Err(error) => return backend_error_response(error),
    };

    match workspace::architect::list_plans(&state.workspace_path, &metadata_root, payload).await {
        Ok(plans) => (StatusCode::OK, Json(plans)).into_response(),
        Err(error) => backend_error_response(error),
    }
}

async fn workspace_architect_list_plans_scoped(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Path(_workspace_id): Path<String>,
    Json(payload): Json<WorkspaceArchitectListPlansRequestDto>,
) -> impl IntoResponse {
    workspace_architect_list_plans(State(state), headers, Json(payload)).await
}

async fn workspace_architect_activate_plan_head(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<WorkspaceArchitectActivatePlanHeadRequestDto>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let metadata_root = match resolve_metadata_root_for_workspace(&state) {
        Ok(path) => path,
        Err(error) => return backend_error_response(error),
    };

    match workspace::architect::activate_plan_head(&state.workspace_path, &metadata_root, payload)
        .await
    {
        Ok(head) => (StatusCode::OK, Json(head)).into_response(),
        Err(error) => backend_error_response(error),
    }
}

async fn workspace_architect_activate_plan_head_scoped(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Path(_workspace_id): Path<String>,
    Json(payload): Json<WorkspaceArchitectActivatePlanHeadRequestDto>,
) -> impl IntoResponse {
    workspace_architect_activate_plan_head(State(state), headers, Json(payload)).await
}

async fn workspace_architect_activate_plan_chat(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<WorkspaceArchitectActivatePlanChatRequestDto>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let metadata_root = match resolve_metadata_root_for_workspace(&state) {
        Ok(path) => path,
        Err(error) => return backend_error_response(error),
    };

    match workspace::architect::activate_plan_chat(&state.workspace_path, &metadata_root, payload)
        .await
    {
        Ok(transcript) => (StatusCode::OK, Json(transcript)).into_response(),
        Err(error) => backend_error_response(error),
    }
}

async fn workspace_architect_activate_plan_chat_scoped(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Path(_workspace_id): Path<String>,
    Json(payload): Json<WorkspaceArchitectActivatePlanChatRequestDto>,
) -> impl IntoResponse {
    workspace_architect_activate_plan_chat(State(state), headers, Json(payload)).await
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
    let addr = parse_listen_addr(&host, port)?;
    let bearer_token = normalize_bearer_token(std::env::var("MACRO_HEADLESS_BEARER_TOKEN").ok());
    validate_listen_security(addr, bearer_token.as_deref())?;
    let config = load_config()?;
    let workspace_path = config
        .workspace_path
        .canonicalize()
        .map_err(|error| format!("Headless workspace path is not accessible: {}", error))?;
    let allowed_roots = configured_headless_allowed_roots(&workspace_path)?;

    let state = Arc::new(HeadlessState {
        bearer_token,
        allowed_roots,
        workspace_path,
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
        .route(
            "/api/v1/workspaces/{workspace_id}/bootstrap",
            get(workspace_bootstrap_scoped),
        )
        .route("/api/v1/workspace/tasks", get(workspace_tasks))
        .route(
            "/api/v1/workspaces/{workspace_id}/tasks",
            get(workspace_tasks_scoped),
        )
        .route(
            "/api/v1/workspace/architect/plans/list",
            post(workspace_architect_list_plans),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}/architect/plans/list",
            post(workspace_architect_list_plans_scoped),
        )
        .route(
            "/api/v1/workspace/architect/plans/activate-head",
            post(workspace_architect_activate_plan_head),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}/architect/plans/activate-head",
            post(workspace_architect_activate_plan_head_scoped),
        )
        .route(
            "/api/v1/workspace/architect/plans/activate-chat",
            post(workspace_architect_activate_plan_chat),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}/architect/plans/activate-chat",
            post(workspace_architect_activate_plan_chat_scoped),
        )
        .route(
            "/api/v1/projects/{project_id}/git/tree",
            get(project_git_tree),
        )
        .route(
            "/api/v1/projects/{project_id}/git/commits",
            get(project_git_commits),
        )
        .with_state(state)
        .layer(headless_cors_layer()?);

    tracing::info!("macro-headless listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
