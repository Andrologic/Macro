use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use macro_lib::commands::workspace_tools::{
    validate_headless_project_mounts, validate_headless_workspace_path,
};
use macro_lib::commands::{execute_workspace_tool, git, WorkspaceProjectMount};
use macro_lib::config::{
    delete_orphan_secret, install_runtime_config_manager, list_orphan_secrets,
    resolve_standalone_config_root, ConfigApiError, ConfigChangeSource, ConfigDocumentKind,
    ConfigManager, ConfigPatchRequest, ConfigScope, ConfigSnapshot, DeleteOrphanSecretRequest,
    JsonPatchOperation,
};
use macro_lib::core::error::BackendError;
use macro_lib::core::http_auth::BearerTokenDigest;
use macro_lib::core::tool_policy::{
    get_mode_policy, validate_tool_execution, ToolModePolicyResult, ToolValidationResult,
};
use macro_lib::core::{apply_runtime_workspace, load_config};
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
    bearer_token: Option<BearerTokenDigest>,
    approval_token: Option<BearerTokenDigest>,
    allowed_roots: Vec<PathBuf>,
    workspace_path: PathBuf,
    git_state: GitState,
    config_manager: ConfigManager,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[derive(Debug, Deserialize)]
struct ModePolicyQuery {
    mode: String,
    #[serde(alias = "projectId")]
    project_id: String,
}

#[derive(Debug, Deserialize)]
struct ToolValidationRequest {
    mode: String,
    tool_id: String,
    path: Option<String>,
    #[serde(alias = "projectId")]
    project_id: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigSnapshotRequest {
    #[serde(default)]
    project_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigDocumentRequest {
    kind: ConfigDocumentKind,
    #[serde(default)]
    scope: ConfigScope,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigValidationRequest {
    kind: ConfigDocumentKind,
    #[serde(default)]
    scope: ConfigScope,
    document: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HeadlessConfigPatchRequest {
    kind: ConfigDocumentKind,
    #[serde(default)]
    scope: ConfigScope,
    expected_etag: String,
    patch: Vec<JsonPatchOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigPendingDecisionRequest {
    id: String,
    #[serde(default)]
    restore_approved: bool,
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

fn validate_approval_authority(
    bearer_token: Option<&str>,
    approval_token: Option<&str>,
) -> Result<(), String> {
    let (Some(bearer_token), Some(approval_token)) = (bearer_token, approval_token) else {
        return Ok(());
    };
    let approval_header = format!("Bearer {approval_token}");
    if BearerTokenDigest::new(bearer_token).authorizes(Some(&approval_header)) {
        return Err(
            "MACRO_HEADLESS_APPROVAL_TOKEN must differ from MACRO_HEADLESS_BEARER_TOKEN"
                .to_string(),
        );
    }
    Ok(())
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

fn configured_headless_allowed_roots(
    workspace_path: &PathBuf,
    runtime_roots: &[String],
) -> Result<Vec<PathBuf>, String> {
    let mut configured = vec![workspace_path.clone()];
    for root in runtime_roots {
        let path = PathBuf::from(root);
        if !path.is_absolute() {
            return Err(format!(
                "runtime.json.allowedRoots doit contenir des chemins absolus : {root}"
            ));
        }
        configured.push(path);
    }
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
        BackendError::RevisionConflict { .. } => StatusCode::CONFLICT,
        BackendError::FilesystemPathOutsideWorkspace { .. } => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn config_error_response(error: ConfigApiError) -> Response {
    let status = match error.code.as_str() {
        "config.document.not_found" | "config.project.not_registered" => StatusCode::NOT_FOUND,
        "config.etag.conflict" => StatusCode::CONFLICT,
        "config.document.future_version" => StatusCode::PRECONDITION_FAILED,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, Json(error)).into_response()
}

async fn config_snapshot(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ConfigSnapshotRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    match state
        .config_manager
        .get_snapshot(&payload.project_ids)
        .await
    {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => config_error_response(error),
    }
}

async fn config_document(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ConfigDocumentRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    match state
        .config_manager
        .get_document(payload.kind, payload.scope)
        .await
    {
        Ok(document) => (StatusCode::OK, Json(document)).into_response(),
        Err(error) => config_error_response(error),
    }
}

async fn config_schema(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ConfigDocumentRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    match state.config_manager.get_schema(payload.kind) {
        Ok(schema) => (StatusCode::OK, Json(schema)).into_response(),
        Err(error) => config_error_response(error),
    }
}

async fn config_validate_document(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ConfigValidationRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    (
        StatusCode::OK,
        Json(
            state
                .config_manager
                .validate(payload.kind, payload.scope, &payload.document),
        ),
    )
        .into_response()
}

async fn config_apply_patch(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<HeadlessConfigPatchRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    let request = ConfigPatchRequest {
        kind: payload.kind,
        scope: payload.scope,
        expected_etag: payload.expected_etag,
        patch: payload.patch,
        source: ConfigChangeSource::Agent,
    };
    match state.config_manager.apply_patch(request).await {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(error) => config_error_response(error),
    }
}

async fn config_reload_document(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ConfigDocumentRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    match state
        .config_manager
        .reload(
            payload.kind,
            payload.scope,
            macro_lib::config::ConfigChangeSource::ExternalEditor,
        )
        .await
    {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(error) => config_error_response(error),
    }
}

async fn config_pending_changes(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    (
        StatusCode::OK,
        Json(state.config_manager.list_pending_changes().await),
    )
        .into_response()
}

async fn config_orphan_secrets(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    match list_orphan_secrets(&state.config_manager).await {
        Ok(entries) => (StatusCode::OK, Json(entries)).into_response(),
        Err(error) => config_error_response(error),
    }
}

async fn config_delete_orphan_secret(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<DeleteOrphanSecretRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }
    match delete_orphan_secret(&state.config_manager, payload).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => config_error_response(error),
    }
}

async fn config_accept_pending(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ConfigPendingDecisionRequest>,
) -> impl IntoResponse {
    if !approval_authorized(&headers, &state) {
        return approval_unauthorized_response().into_response();
    }
    match state
        .config_manager
        .accept_pending_change(&payload.id)
        .await
    {
        Ok(document) => (StatusCode::OK, Json(document)).into_response(),
        Err(error) => config_error_response(error),
    }
}

async fn config_reject_pending(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ConfigPendingDecisionRequest>,
) -> impl IntoResponse {
    if !approval_authorized(&headers, &state) {
        return approval_unauthorized_response().into_response();
    }
    match state
        .config_manager
        .reject_pending_change(&payload.id, payload.restore_approved)
        .await
    {
        Ok(document) => (StatusCode::OK, Json(document)).into_response(),
        Err(error) => config_error_response(error),
    }
}

fn backend_error_response(error: BackendError) -> axum::response::Response {
    let status = backend_error_to_status(&error);
    (status, Json(error)).into_response()
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

async fn register_headless_project_config_roots(state: &HeadlessState) -> Result<(), BackendError> {
    let workspace_metadata_root = resolve_metadata_root_for_workspace(state)?;
    let bootstrap =
        workspace::get_bootstrap(&state.workspace_path, &workspace_metadata_root).await?;
    let projects = bootstrap
        .standalone_projects
        .into_iter()
        .chain(
            bootstrap
                .project_groups
                .into_iter()
                .flat_map(|group| group.projects),
        )
        .collect::<Vec<_>>();

    for project in projects {
        if parse_wsl_unc_path(&project.path).is_some() {
            tracing::warn!(
                project_id = %project.id,
                "Skipping headless project policy registration for an unsupported WSL project"
            );
            continue;
        }
        let project_state = HeadlessState {
            workspace_path: PathBuf::from(&project.path),
            ..state.clone()
        };
        let metadata_root = match resolve_metadata_root_for_workspace(&project_state) {
            Ok(root) => root,
            Err(error) => {
                tracing::warn!(
                    project_id = %project.id,
                    %error,
                    "Unable to resolve the headless project policy root"
                );
                continue;
            }
        };
        if let Err(error) = state
            .config_manager
            .register_project_root(&project.id, metadata_root)
            .await
        {
            tracing::warn!(
                project_id = %project.id,
                code = %error.code,
                message = %error.message,
                "Unable to register the headless project policy root"
            );
        }
    }
    Ok(())
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

    expected.authorizes(Some(auth_str))
}

fn unauthorized_response() -> impl IntoResponse {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError {
            message: "Unauthorized".to_string(),
        }),
    )
}

fn approval_authorized(headers: &HeaderMap, state: &HeadlessState) -> bool {
    approval_token_authorizes(headers, state.approval_token.as_ref())
}

fn approval_token_authorizes(headers: &HeaderMap, expected: Option<&BearerTokenDigest>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    expected.authorizes(authorization)
}

fn approval_unauthorized_response() -> impl IntoResponse {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError {
            message: "A distinct user approval bearer token is required".to_string(),
        }),
    )
}

fn policy_denied_response(message: impl Into<String>) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(ApiError {
            message: message.into(),
        }),
    )
        .into_response()
}

fn is_strict_observe_tool(tool_id: &str) -> bool {
    matches!(
        tool_id,
        "question"
            | "config_list"
            | "config_get"
            | "config_validate"
            | "skill_activate"
            | "skill_read_resource"
            | "read_file"
            | "read_sources"
            | "mark_source_passage"
            | "list"
            | "read"
            | "glob"
            | "grep"
            | "git_status"
            | "git_log"
            | "git_branch_list"
            | "git_diff"
            | "git_get_tree"
            | "plan_list"
            | "plan_get"
            | "strategy_get"
            | "task_todo_get"
            | "task_artifact_list"
            | "task_artifact_get"
    )
}

fn configured_mode_policy(mode: &str, tools: &Value) -> Result<ToolModePolicyResult, String> {
    let tools = tools
        .as_object()
        .ok_or_else(|| "The scoped tools policy is missing or invalid".to_string())?;
    let risk_level = tools
        .get("riskLevel")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "strict" | "balanced" | "yolo"))
        .ok_or_else(|| "The scoped tools.riskLevel policy is missing or invalid".to_string())?;
    let built_in = tools
        .get("builtIn")
        .and_then(Value::as_object)
        .ok_or_else(|| "The scoped tools.builtIn policy is missing or invalid".to_string())?;
    let modes = tools
        .get("modes")
        .and_then(Value::as_object)
        .ok_or_else(|| "The scoped tools.modes policy is missing or invalid".to_string())?;
    let mode_overrides = match modes.get(mode) {
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| format!("The scoped tools.modes.{mode} policy is invalid"))?,
        ),
        None => None,
    };

    let mut policy = get_mode_policy(mode);
    policy.allowed_tool_ids.retain(|tool_id| {
        built_in.get(tool_id).and_then(Value::as_bool) != Some(false)
            && mode_overrides
                .and_then(|overrides| overrides.get(tool_id))
                .and_then(Value::as_bool)
                != Some(false)
            && (risk_level != "strict" || is_strict_observe_tool(tool_id))
    });
    Ok(policy)
}

fn configured_tool_validation(
    mode: &str,
    tool_id: &str,
    path: Option<&str>,
    tools: &Value,
) -> Result<ToolValidationResult, String> {
    let static_validation = validate_tool_execution(mode, tool_id, path);
    if !static_validation.allowed {
        return Ok(static_validation);
    }

    let configured = configured_mode_policy(mode, tools)?;
    if configured
        .allowed_tool_ids
        .iter()
        .any(|allowed| allowed == tool_id.trim())
    {
        return Ok(static_validation);
    }

    Ok(ToolValidationResult {
        allowed: false,
        reason: Some(format!(
            "Tool '{}' is disabled by the scoped project policy",
            tool_id.trim()
        )),
        enforce_macro_only_writes: static_validation.enforce_macro_only_writes,
    })
}

fn project_tools_from_snapshot<'a>(
    snapshot: &'a ConfigSnapshot,
    project_id: &str,
) -> Result<&'a Value, String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("A project_id is required for tool policy decisions".to_string());
    }
    snapshot
        .project_effective
        .get(project_id)
        .and_then(|documents| documents.get("tools"))
        .ok_or_else(|| format!("No scoped tools policy is loaded for project '{project_id}'"))
}

async fn load_project_tools_policy(
    state: &HeadlessState,
    project_id: &str,
) -> Result<Value, String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("A project_id is required for tool policy decisions".to_string());
    }
    let snapshot = state
        .config_manager
        .get_snapshot(&[project_id.to_string()])
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    project_tools_from_snapshot(&snapshot, project_id).cloned()
}

async fn load_project_tools_policies(
    state: &HeadlessState,
    project_ids: &BTreeSet<String>,
) -> Result<Vec<(String, Value)>, String> {
    if project_ids.is_empty() {
        return Err("At least one project is required for tool policy decisions".to_string());
    }
    let requested_ids = project_ids.iter().cloned().collect::<Vec<_>>();
    let snapshot = state
        .config_manager
        .get_snapshot(&requested_ids)
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    requested_ids
        .into_iter()
        .map(|project_id| {
            project_tools_from_snapshot(&snapshot, &project_id)
                .cloned()
                .map(|tools| (project_id, tools))
        })
        .collect()
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

    let tools = match load_project_tools_policy(&state, &params.project_id).await {
        Ok(tools) => tools,
        Err(error) => return policy_denied_response(error),
    };
    match configured_mode_policy(&params.mode, &tools) {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(error) => policy_denied_response(error),
    }
}

async fn tool_validate(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(payload): Json<ToolValidationRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let tools = match load_project_tools_policy(&state, &payload.project_id).await {
        Ok(tools) => tools,
        Err(error) => return policy_denied_response(error),
    };
    match configured_tool_validation(
        &payload.mode,
        &payload.tool_id,
        payload.path.as_deref(),
        &tools,
    ) {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(error) => policy_denied_response(error),
    }
}

async fn tool_execute(
    State(state): State<Arc<HeadlessState>>,
    headers: HeaderMap,
    Json(mut payload): Json<ToolExecuteRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return unauthorized_response().into_response();
    }

    let Some(project_id) = payload
        .focused_project_id
        .as_deref()
        .map(str::trim)
        .filter(|project_id| !project_id.is_empty())
    else {
        return policy_denied_response(
            "A focused_project_id is required for tool execution policy decisions",
        );
    };
    let mut affected_project_ids = payload
        .project_mounts
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|mount| mount.project_id.trim().to_string())
        .filter(|project_id| !project_id.is_empty())
        .collect::<BTreeSet<_>>();
    affected_project_ids.insert(project_id.to_string());
    let policies = match load_project_tools_policies(&state, &affected_project_ids).await {
        Ok(policies) => policies,
        Err(error) => return policy_denied_response(error),
    };
    let candidate_path = payload
        .args
        .get("path")
        .or_else(|| payload.args.get("repo_path"))
        .and_then(Value::as_str);
    for (policy_project_id, tools) in policies {
        match configured_tool_validation(&payload.mode, &payload.tool_id, candidate_path, &tools) {
            Ok(validation) if validation.allowed => {}
            Ok(validation) => {
                return policy_denied_response(format!(
                    "Project '{policy_project_id}' denied the tool: {}",
                    validation
                        .reason
                        .unwrap_or_else(|| "Tool execution is denied by policy".to_string()),
                ))
            }
            Err(error) => {
                return policy_denied_response(format!(
                    "Project '{policy_project_id}' has an invalid tool policy: {error}",
                ))
            }
        }
    }

    payload.workspace_path = match validate_headless_workspace_path(
        payload.workspace_path.as_deref(),
        &state.workspace_path,
        &state.allowed_roots,
    ) {
        Ok(path) => path,
        Err(error) => return (StatusCode::FORBIDDEN, Json(error)).into_response(),
    };
    payload.project_mounts = match payload.project_mounts.as_deref() {
        Some(mounts) => match validate_headless_project_mounts(mounts, &state.allowed_roots) {
            Ok(mounts) => Some(mounts),
            Err(error) => return (StatusCode::FORBIDDEN, Json(error)).into_response(),
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
        Err(error) => (StatusCode::BAD_REQUEST, Json(error)).into_response(),
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

    let config_root = resolve_standalone_config_root()
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let config_manager = ConfigManager::initialize(config_root)
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    install_runtime_config_manager(config_manager.clone())
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let snapshot = config_manager
        .get_snapshot(&[])
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let runtime = snapshot
        .effective
        .get("runtime")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let host = std::env::var("MACRO_HEADLESS_HOST").unwrap_or_else(|_| {
        runtime
            .pointer("/headless/bindAddress")
            .and_then(Value::as_str)
            .unwrap_or("127.0.0.1")
            .to_string()
    });
    let port = std::env::var("MACRO_HEADLESS_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .or_else(|| {
            runtime
                .pointer("/headless/port")
                .and_then(Value::as_u64)
                .and_then(|port| u16::try_from(port).ok())
        })
        .unwrap_or(43117);
    let addr = parse_listen_addr(&host, port)?;
    // The agent bearer authenticates ordinary API calls. Sensitive pending-change
    // decisions require the separate user-held approval bearer and never fall
    // back to the agent bearer when it is absent.
    let bearer_token = normalize_bearer_token(std::env::var("MACRO_HEADLESS_BEARER_TOKEN").ok());
    let approval_token =
        normalize_bearer_token(std::env::var("MACRO_HEADLESS_APPROVAL_TOKEN").ok());
    validate_approval_authority(bearer_token.as_deref(), approval_token.as_deref())?;
    validate_listen_security(addr, bearer_token.as_deref())?;
    let mut config = load_config()?;
    apply_runtime_workspace(&mut config, &runtime)?;
    let workspace_path = config
        .workspace_path
        .canonicalize()
        .map_err(|error| format!("Headless workspace path is not accessible: {}", error))?;
    let runtime_roots = runtime
        .get("allowedRoots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let allowed_roots = configured_headless_allowed_roots(&workspace_path, &runtime_roots)?;

    let state = HeadlessState {
        bearer_token: bearer_token.as_deref().map(BearerTokenDigest::new),
        approval_token: approval_token.as_deref().map(BearerTokenDigest::new),
        allowed_roots,
        workspace_path,
        git_state: GitState::new(),
        config_manager,
    };
    register_headless_project_config_roots(&state).await?;
    let state = Arc::new(state);

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/tools/mode-policy", get(tool_mode_policy))
        .route("/v1/tools/validate", post(tool_validate))
        .route("/v1/tools/execute", post(tool_execute))
        .route("/api/v1/tools/mode-policy", get(tool_mode_policy))
        .route("/api/v1/tools/validate", post(tool_validate))
        .route("/api/v1/tools/execute", post(tool_execute))
        .route("/api/v1/config/snapshot", post(config_snapshot))
        .route("/api/v1/config/document", post(config_document))
        .route("/api/v1/config/schema", post(config_schema))
        .route("/api/v1/config/validate", post(config_validate_document))
        .route("/api/v1/config/patch", post(config_apply_patch))
        .route("/api/v1/config/reload", post(config_reload_document))
        .route("/api/v1/config/pending", get(config_pending_changes))
        .route("/api/v1/config/orphan-secrets", get(config_orphan_secrets))
        .route(
            "/api/v1/config/orphan-secrets/delete",
            post(config_delete_orphan_secret),
        )
        .route("/api/v1/config/pending/accept", post(config_accept_pending))
        .route("/api/v1/config/pending/reject", post(config_reject_pending))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn bearer_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization header"),
        );
        headers
    }

    #[test]
    fn headless_patch_payload_cannot_claim_user_interface_provenance() {
        let payload = json!({
            "kind": "tools",
            "scope": { "type": "user" },
            "expectedEtag": "sha256:test",
            "patch": [],
            "source": "userInterface"
        });
        assert!(serde_json::from_value::<HeadlessConfigPatchRequest>(payload).is_err());
    }

    #[test]
    fn pending_accept_refuses_the_agent_bearer() {
        let headers = bearer_headers("agent-secret");
        let approval = BearerTokenDigest::new("user-approval-secret");

        assert!(!approval_token_authorizes(&headers, Some(&approval)));
        assert!(validate_approval_authority(Some("agent-secret"), Some("agent-secret")).is_err());
    }

    #[test]
    fn pending_accept_allows_a_distinct_user_approval_bearer() {
        let headers = bearer_headers("user-approval-secret");
        let approval = BearerTokenDigest::new("user-approval-secret");

        assert!(approval_token_authorizes(&headers, Some(&approval)));
        assert!(
            validate_approval_authority(Some("agent-secret"), Some("user-approval-secret")).is_ok()
        );
        assert!(!approval_token_authorizes(&headers, None));
    }

    #[test]
    fn configured_policy_denies_disabled_and_strict_tools() {
        let disabled = json!({
            "riskLevel": "balanced",
            "builtIn": { "write": false },
            "modes": {}
        });
        let disabled_validation =
            configured_tool_validation("Implement", "write", Some("file.txt"), &disabled)
                .expect("valid policy");
        assert!(!disabled_validation.allowed);

        let strict = json!({
            "riskLevel": "strict",
            "builtIn": {},
            "modes": {}
        });
        let strict_write =
            configured_tool_validation("Implement", "write", Some("file.txt"), &strict)
                .expect("valid strict policy");
        let strict_read =
            configured_tool_validation("Implement", "read", Some("file.txt"), &strict)
                .expect("valid strict policy");
        assert!(!strict_write.allowed);
        assert!(strict_read.allowed);
    }

    #[test]
    fn missing_project_policy_fails_closed() {
        let snapshot = ConfigSnapshot {
            schema_version: 1,
            effective: BTreeMap::new(),
            project_effective: BTreeMap::new(),
            documents: Vec::new(),
            provenance: Vec::new(),
            diagnostics: Vec::new(),
            pending_restart_paths: Vec::new(),
        };

        assert!(project_tools_from_snapshot(&snapshot, "missing-project").is_err());
        assert!(project_tools_from_snapshot(&snapshot, "").is_err());
    }
}
