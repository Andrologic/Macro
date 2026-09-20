use crate::core::http_auth::BearerTokenDigest;
use crate::core::tool_policy::{get_mode_policy, validate_tool_execution};
use crate::core::workspace_execution::{
    execute_workspace_tool, CommandError, WorkspaceProjectMount,
};
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
    bearer_token: BearerTokenDigest,
    workspace_metadata_root: WorkspaceMetadataRoot,
    git_state: GitState,
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
    #[serde(default)]
    project_mounts: Option<Vec<WorkspaceProjectMount>>,
    #[serde(default)]
    virtual_root_enabled: Option<bool>,
    #[serde(default)]
    focused_project_id: Option<String>,
}

fn authorized(headers: &HeaderMap, state: &ToolHostState) -> bool {
    let Some(auth_value) = headers.get(header::AUTHORIZATION) else {
        return false;
    };

    let Ok(auth_str) = auth_value.to_str() else {
        return false;
    };

    state.bearer_token.authorizes(Some(auth_str))
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
    (StatusCode::BAD_REQUEST, Json(error)).into_response()
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
        tool_id if tool_id.starts_with("terminal_") => Err(CommandError {
            message:
                "Agent terminal tools must be relayed through Macro's frontend permission review."
                    .to_string(),
        }),
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
                payload.project_mounts,
                payload.virtual_root_enabled,
                payload.focused_project_id,
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
        bearer_token: BearerTokenDigest::new(&bearer_token),
        workspace_metadata_root,
        git_state,
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use tempfile::TempDir;
    use tokio::sync::RwLock;

    fn request(tool_id: &str, args: Value) -> ToolExecuteRequest {
        ToolExecuteRequest {
            mode: "Implement".into(),
            tool_id: tool_id.into(),
            args,
            workspace_path: None,
            workspace_scope: None,
            project_mounts: None,
            virtual_root_enabled: None,
            focused_project_id: None,
        }
    }

    #[tokio::test]
    async fn tool_host_preserves_bearer_authority_core_reads_and_terminal_rejection() {
        let workspace = TempDir::new().expect("workspace fixture");
        std::fs::write(workspace.path().join("read.txt"), "shared execution\n")
            .expect("read fixture");
        let state = Arc::new(ToolHostState {
            bearer_token: BearerTokenDigest::new("test-tool-host-token"),
            workspace_metadata_root: WorkspaceMetadataRoot(Arc::new(RwLock::new(
                workspace.path().to_path_buf(),
            ))),
            git_state: GitState::new(),
        });
        for bearer in [None, Some("Bearer invalid")] {
            let mut headers = HeaderMap::new();
            if let Some(bearer) = bearer {
                headers.insert(header::AUTHORIZATION, bearer.parse().expect("header"));
            }
            let response = tool_execute(
                State(state.clone()),
                headers,
                Json(request(
                    "write",
                    json!({"path": "unauthorized.txt", "content": "forbidden"}),
                )),
            )
            .await
            .into_response();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert!(!workspace.path().join("unauthorized.txt").exists());
        }

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer test-tool-host-token".parse().unwrap(),
        );
        let read_args = json!({"path": "read.txt"});
        let expected = execute_workspace_tool(
            workspace.path().to_path_buf(),
            workspace.path().to_path_buf(),
            state.git_state.clone(),
            "Implement".into(),
            "read".into(),
            read_args.clone(),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("core read");
        let response = tool_execute(
            State(state.clone()),
            headers.clone(),
            Json(request("read", read_args)),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("response body");
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"result": expected})
        );

        let response = tool_execute(
            State(state),
            headers,
            Json(request(
                "terminal_run",
                json!({
                    "command": "printf forbidden > terminal-effect.txt",
                    "cwd": workspace.path().to_string_lossy(),
                }),
            )),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("response body");
        assert!(serde_json::from_slice::<Value>(&body).unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("frontend permission review"));
        assert!(!workspace.path().join("terminal-effect.txt").exists());
    }
}
