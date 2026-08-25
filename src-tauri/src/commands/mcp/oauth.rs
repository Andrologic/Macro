//! Macro-owned OAuth boundary for HTTP MCP servers.
//!
//! The official SDK owns protocol details (RFC 9728 discovery, PKCE,
//! resource indicators, issuer binding, CIMD/DCR and refresh semantics).
//! Macro owns outbound network policy, durable secret storage, identity
//! partitioning and refresh single-flight.

use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{RawQuery, State};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures::StreamExt;
use http::{Method, StatusCode};
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationMetadataSource, AuthorizationRequest,
    AuthorizationSession, CredentialStore, OAuthClientConfig, OAuthHttpClient,
    OAuthHttpClientError, OAuthHttpClientFuture, OAuthHttpRedirectPolicy, OAuthHttpRequest,
    StoredCredentials,
};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{oneshot, Mutex};
use url::Url;

use super::runtime_connector::{resolve_oauth_settings, ResolvedOAuthSettings};
use super::streamable_http::validate_endpoint;
use super::types::McpRuntimeKey;
use crate::commands::{command_error, CommandResult};
use crate::config::{McpServerDefinition, McpTransport};
use crate::secrets;

const MAX_OAUTH_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_OAUTH_REDIRECTS: usize = 5;
const DEFAULT_OAUTH_TIMEOUT: Duration = Duration::from_secs(30);
const OAUTH_BROWSER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, thiserror::Error)]
enum McpOAuthHttpError {
    #[error("OAuth request URL is invalid")]
    InvalidUrl,
    #[error("OAuth requires HTTPS except for loopback development endpoints")]
    InsecureTransport,
    #[error("OAuth endpoint violates Macro network policy")]
    NetworkPolicy,
    #[error("OAuth redirect violates the same-origin policy")]
    RedirectPolicy,
    #[error("OAuth response exceeded {0} bytes")]
    ResponseTooLarge(usize),
    #[error("OAuth request timed out")]
    Timeout,
    #[error("OAuth HTTP request failed")]
    Request,
    #[error("OAuth HTTP response could not be constructed")]
    Response,
}

fn oauth_http_error(error: McpOAuthHttpError) -> OAuthHttpClientError {
    Box::new(error)
}

fn url_is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left
            .host_str()
            .zip(right.host_str())
            .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
        && left.port_or_known_default() == right.port_or_known_default()
}

#[derive(Clone)]
pub(crate) struct GuardedOAuthHttpClient {
    allow_loopback: bool,
}

impl GuardedOAuthHttpClient {
    pub(crate) fn new(resource: &str) -> CommandResult<Self> {
        let resource = Url::parse(resource)
            .map_err(|_| command_error("The MCP OAuth resource URL is invalid."))?;
        Ok(Self {
            allow_loopback: url_is_loopback(&resource),
        })
    }

    async fn execute_inner(
        &self,
        operation: OAuthHttpRequest,
    ) -> Result<http::Response<Vec<u8>>, OAuthHttpClientError> {
        let redirect_policy = operation.redirect_policy;
        let timeout = operation.timeout.unwrap_or(DEFAULT_OAUTH_TIMEOUT);
        let (parts, body) = operation.request.into_parts();
        let mut url = Url::parse(&parts.uri.to_string())
            .map_err(|_| oauth_http_error(McpOAuthHttpError::InvalidUrl))?;
        let mut method = parts.method;
        let headers = parts.headers;
        let mut request_body = body;

        let exchange = async {
            for redirect_count in 0..=MAX_OAUTH_REDIRECTS {
                let endpoint = validate_endpoint(url.as_str())
                    .await
                    .map_err(|_| oauth_http_error(McpOAuthHttpError::NetworkPolicy))?;
                if endpoint.url.scheme() != "https" && !url_is_loopback(&endpoint.url) {
                    return Err(oauth_http_error(McpOAuthHttpError::InsecureTransport));
                }
                if url_is_loopback(&endpoint.url) && !self.allow_loopback {
                    return Err(oauth_http_error(McpOAuthHttpError::NetworkPolicy));
                }
                let client = endpoint
                    .build_client()
                    .map_err(|_| oauth_http_error(McpOAuthHttpError::NetworkPolicy))?;
                let mut request = client.request(method.clone(), endpoint.url.as_str());
                for (name, value) in &headers {
                    request = request.header(name, value);
                }
                let response = request
                    .body(request_body.clone())
                    .send()
                    .await
                    .map_err(|_| oauth_http_error(McpOAuthHttpError::Request))?;

                let status = response.status();
                let location = response
                    .headers()
                    .get(http::header::LOCATION)
                    .and_then(|value| value.to_str().ok());
                let should_follow = matches!(redirect_policy, OAuthHttpRedirectPolicy::Follow)
                    && status.is_redirection()
                    && location.is_some();
                if should_follow {
                    if redirect_count == MAX_OAUTH_REDIRECTS {
                        return Err(oauth_http_error(McpOAuthHttpError::RedirectPolicy));
                    }
                    let next = url
                        .join(location.unwrap_or_default())
                        .map_err(|_| oauth_http_error(McpOAuthHttpError::RedirectPolicy))?;
                    if !same_origin(&url, &next) {
                        return Err(oauth_http_error(McpOAuthHttpError::RedirectPolicy));
                    }
                    if status == StatusCode::SEE_OTHER
                        || ((status == StatusCode::MOVED_PERMANENTLY
                            || status == StatusCode::FOUND)
                            && method == Method::POST)
                    {
                        method = Method::GET;
                        request_body.clear();
                    }
                    url = next;
                    continue;
                }

                let version = response.version();
                let response_headers = response.headers().clone();
                let mut response_body = Vec::new();
                let mut response_stream = response.bytes_stream();
                while let Some(chunk) = response_stream.next().await {
                    let chunk = chunk.map_err(|_| oauth_http_error(McpOAuthHttpError::Request))?;
                    if response_body.len() + chunk.len() > MAX_OAUTH_RESPONSE_BYTES {
                        return Err(oauth_http_error(McpOAuthHttpError::ResponseTooLarge(
                            MAX_OAUTH_RESPONSE_BYTES,
                        )));
                    }
                    response_body.extend_from_slice(&chunk);
                }
                let mut builder = http::Response::builder().status(status).version(version);
                for (name, value) in &response_headers {
                    builder = builder.header(name, value);
                }
                return builder
                    .body(response_body)
                    .map_err(|_| oauth_http_error(McpOAuthHttpError::Response));
            }
            Err(oauth_http_error(McpOAuthHttpError::RedirectPolicy))
        };

        tokio::time::timeout(timeout.min(DEFAULT_OAUTH_TIMEOUT), exchange)
            .await
            .map_err(|_| oauth_http_error(McpOAuthHttpError::Timeout))?
    }
}

impl OAuthHttpClient for GuardedOAuthHttpClient {
    fn execute(&self, request: OAuthHttpRequest) -> OAuthHttpClientFuture<'_> {
        Box::pin(self.execute_inner(request))
    }
}

#[derive(Clone)]
pub(crate) struct McpOAuthCredentialStore {
    secret_id: Arc<str>,
}

impl McpOAuthCredentialStore {
    pub(crate) fn new(secret_id: String) -> Self {
        Self {
            secret_id: Arc::from(secret_id),
        }
    }
}

#[async_trait::async_trait]
impl CredentialStore for McpOAuthCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let stored = secrets::get_api_key(&self.secret_id)
            .map_err(|_| AuthError::InternalError("OAuth credential store unavailable".into()))?;
        stored
            .map(|value| {
                serde_json::from_str(&value).map_err(|_| {
                    AuthError::InternalError("Stored OAuth credentials are invalid".into())
                })
            })
            .transpose()
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let encoded = serde_json::to_string(&credentials).map_err(|_| {
            AuthError::InternalError("OAuth credentials could not be encoded".into())
        })?;
        secrets::set_api_key(&self.secret_id, &encoded)
            .map_err(|_| AuthError::InternalError("OAuth credential store unavailable".into()))
    }

    async fn clear(&self) -> Result<(), AuthError> {
        secrets::delete_api_key(&self.secret_id)
            .map_err(|_| AuthError::InternalError("OAuth credential store unavailable".into()))
    }
}

pub(crate) trait McpBearerTokenProvider: Send + Sync {
    fn access_token<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = CommandResult<String>> + Send + 'a>>;
}

pub(crate) struct McpOAuthTokenProvider {
    manager: Arc<AuthorizationManager>,
    refresh_single_flight: Mutex<()>,
}

impl McpOAuthTokenProvider {
    pub(crate) fn new(manager: AuthorizationManager) -> Self {
        Self {
            manager: Arc::new(manager),
            refresh_single_flight: Mutex::new(()),
        }
    }
}

impl McpBearerTokenProvider for McpOAuthTokenProvider {
    fn access_token<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = CommandResult<String>> + Send + 'a>> {
        Box::pin(async move {
            let _refresh_guard = self.refresh_single_flight.lock().await;
            self.manager.get_access_token().await.map_err(|error| {
                command_error(match error {
                    AuthError::AuthorizationRequired => {
                        "MCP OAuth authorization is required.".to_string()
                    }
                    AuthError::InsufficientScope { .. } => {
                        "MCP OAuth authorization needs additional scopes.".to_string()
                    }
                    _ => "MCP OAuth token acquisition failed.".to_string(),
                })
            })
        })
    }
}

pub(crate) fn oauth_credential_secret_id(key: &McpRuntimeKey, canonical_resource: &str) -> String {
    let mut project_ids = key.project_ids.clone();
    project_ids.sort();
    project_ids.dedup();
    let identity = serde_json::json!({
        "serverId": key.server_id,
        "projectId": key.project_id,
        "projectIds": project_ids,
        "resource": canonical_resource,
    });
    let bytes = serde_json::to_vec(&identity).unwrap_or_default();
    format!("mcp-oauth:{:x}", Sha256::digest(bytes))
}

pub(crate) async fn load_oauth_token_provider(
    key: &McpRuntimeKey,
    canonical_resource: &str,
    preregistered_client: Option<(&str, Option<&str>)>,
    scopes: &[String],
) -> CommandResult<Option<Arc<dyn McpBearerTokenProvider>>> {
    let mut manager = AuthorizationManager::new_with_oauth_http_client(
        canonical_resource,
        Arc::new(GuardedOAuthHttpClient::new(canonical_resource)?),
    )
    .await
    .map_err(|_| command_error("MCP OAuth manager could not be initialized."))?;
    manager.set_credential_store(McpOAuthCredentialStore::new(oauth_credential_secret_id(
        key,
        canonical_resource,
    )));
    let resolution = manager
        .resolve_metadata()
        .await
        .map_err(|_| command_error("MCP OAuth metadata discovery failed."))?;
    if resolution.source == AuthorizationMetadataSource::LegacyEndpointFallback {
        return Err(command_error(
            "MCP OAuth metadata is required but was not published by the server.",
        ));
    }
    manager.set_metadata(resolution.metadata);
    let initialized = manager
        .initialize_from_store()
        .await
        .map_err(|_| command_error("Stored MCP OAuth credentials could not be validated."))?;
    if !initialized {
        return Ok(None);
    }
    if let Some((client_id, client_secret)) = preregistered_client {
        let mut config = OAuthClientConfig::new(client_id, "http://127.0.0.1/oauth/callback")
            .with_scopes(scopes.to_vec());
        if let Some(client_secret) = client_secret {
            config = config.with_client_secret(client_secret);
        }
        manager
            .configure_client(config)
            .map_err(|_| command_error("Stored MCP OAuth client configuration is invalid."))?;
    }
    Ok(Some(Arc::new(McpOAuthTokenProvider::new(manager))))
}

#[derive(Clone)]
struct CallbackState {
    callback_base: Arc<str>,
    sender: Arc<Mutex<Option<oneshot::Sender<String>>>>,
}

async fn receive_oauth_callback(
    State(state): State<CallbackState>,
    RawQuery(query): RawQuery,
) -> Response {
    let callback_url = match query {
        Some(query) => format!("{}?{query}", state.callback_base),
        None => state.callback_base.to_string(),
    };
    if let Some(sender) = state.sender.lock().await.take() {
        let _ = sender.send(callback_url);
    }
    Html(
        "<!doctype html><html lang=\"fr\"><meta charset=\"utf-8\"><title>Macro</title>\
         <body><p>Autorisation reçue. Vous pouvez fermer cette fenêtre et revenir dans Macro.</p></body></html>",
    )
    .into_response()
}

async fn spawn_oauth_callback_server(
) -> CommandResult<(String, oneshot::Receiver<String>, CallbackServerGuard)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| command_error("The local MCP OAuth callback server could not start."))?;
    let address = listener
        .local_addr()
        .map_err(|_| command_error("The local MCP OAuth callback address is unavailable."))?;
    let callback_base = format!("http://127.0.0.1:{}/oauth/callback", address.port());
    let (sender, receiver) = oneshot::channel();
    let state = CallbackState {
        callback_base: Arc::from(callback_base.clone()),
        sender: Arc::new(Mutex::new(Some(sender))),
    };
    let router = Router::new()
        .route("/oauth/callback", get(receive_oauth_callback))
        .with_state(state);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((callback_base, receiver, CallbackServerGuard(Some(task))))
}

struct CallbackServerGuard(Option<tokio::task::JoinHandle<()>>);

impl CallbackServerGuard {
    fn abort(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
        }
    }
}

impl Drop for CallbackServerGuard {
    fn drop(&mut self) {
        self.abort();
    }
}

fn authorization_request(
    redirect_uri: String,
    settings: &ResolvedOAuthSettings,
) -> AuthorizationRequest {
    let mut request = AuthorizationRequest::new(redirect_uri)
        .with_client_name("Macro")
        .with_application_type("native")
        .with_scopes(settings.scopes.clone());
    if let Some(client_id) = &settings.client_id {
        request = request.with_preregistered_client(client_id.clone());
        if let Some(client_secret) = &settings.client_secret {
            request = request.with_client_secret(client_secret.clone());
        }
    } else if let Some(client_metadata_url) = &settings.client_metadata_url {
        request = request.with_client_metadata_url(client_metadata_url.clone());
    }
    request
}

pub(crate) async fn authorize_interactively(
    app: &AppHandle,
    key: &McpRuntimeKey,
    definition: &McpServerDefinition,
) -> CommandResult<()> {
    let McpTransport::StreamableHttp { url, .. } = &definition.transport else {
        return Err(command_error(
            "MCP OAuth is available only for Streamable HTTP servers.",
        ));
    };
    let settings = resolve_oauth_settings(&key.server_id, definition)
        .map_err(|error| command_error(error.to_string()))?
        .ok_or_else(|| command_error("MCP OAuth is not configured for this server."))?;
    let endpoint = validate_endpoint(url).await?;
    let resource = endpoint.url.as_str();
    let mut manager = AuthorizationManager::new_with_oauth_http_client(
        resource,
        Arc::new(GuardedOAuthHttpClient::new(resource)?),
    )
    .await
    .map_err(|_| command_error("MCP OAuth manager could not be initialized."))?;
    manager.set_credential_store(McpOAuthCredentialStore::new(oauth_credential_secret_id(
        key, resource,
    )));
    let resolution = manager
        .resolve_metadata()
        .await
        .map_err(|_| command_error("MCP OAuth metadata discovery failed."))?;
    if resolution.source == AuthorizationMetadataSource::LegacyEndpointFallback {
        return Err(command_error(
            "MCP OAuth metadata is required but was not published by the server.",
        ));
    }
    manager.set_metadata(resolution.metadata);

    let (redirect_uri, callback, mut callback_server) = spawn_oauth_callback_server().await?;
    let session =
        match AuthorizationSession::new(manager, authorization_request(redirect_uri, &settings))
            .await
        {
            Ok(session) => session,
            Err((_manager, _error)) => {
                return Err(command_error("MCP OAuth client registration failed."));
            }
        };
    app.opener()
        .open_url(session.get_authorization_url(), None::<&str>)
        .map_err(|_| command_error("The MCP OAuth authorization page could not be opened."))?;
    let callback_url = match tokio::time::timeout(OAUTH_BROWSER_TIMEOUT, callback).await {
        Ok(Ok(callback_url)) => callback_url,
        _ => {
            return Err(command_error("MCP OAuth authorization timed out."));
        }
    };
    callback_server.abort();
    session
        .handle_callback_url(&callback_url)
        .await
        .map_err(|error| match error {
            AuthError::AuthorizationServerMismatch { .. }
            | AuthError::AuthorizationServerMissingIssuer { .. } => {
                command_error("MCP OAuth authorization issuer validation failed.")
            }
            _ => command_error("MCP OAuth authorization failed."),
        })?;
    Ok(())
}

pub(crate) async fn clear_credentials(
    key: &McpRuntimeKey,
    definition: &McpServerDefinition,
) -> CommandResult<()> {
    let McpTransport::StreamableHttp { url, .. } = &definition.transport else {
        return Err(command_error(
            "MCP OAuth is available only for Streamable HTTP servers.",
        ));
    };
    let endpoint = validate_endpoint(url).await?;
    secrets::delete_api_key(&oauth_credential_secret_id(key, endpoint.url.as_str()))
        .map_err(|_| command_error("Stored MCP OAuth credentials could not be deleted."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Form;
    use axum::Json;
    use rmcp::transport::auth::InMemoryCredentialStore;
    use std::collections::HashMap;

    #[test]
    fn oauth_identity_is_stable_and_partitioned_by_scope() {
        let base = McpRuntimeKey {
            server_id: "github".to_string(),
            project_id: Some("a".to_string()),
            project_ids: vec!["b".to_string(), "a".to_string()],
            config_generation: 1,
        };
        let reordered = McpRuntimeKey {
            project_ids: vec!["a".to_string(), "b".to_string(), "a".to_string()],
            config_generation: 99,
            ..base.clone()
        };
        assert_eq!(
            oauth_credential_secret_id(&base, "https://example.test/mcp"),
            oauth_credential_secret_id(&reordered, "https://example.test/mcp")
        );

        let other = McpRuntimeKey {
            project_ids: vec!["c".to_string()],
            ..base.clone()
        };
        assert_ne!(
            oauth_credential_secret_id(&base, "https://example.test/mcp"),
            oauth_credential_secret_id(&other, "https://example.test/mcp")
        );
        assert_ne!(
            oauth_credential_secret_id(&base, "https://example.test/mcp"),
            oauth_credential_secret_id(&base, "https://example.test/other")
        );
    }

    #[test]
    fn oauth_allows_plain_http_only_on_loopback() {
        assert!(url_is_loopback(
            &Url::parse("http://127.0.0.1:3000/mcp").unwrap()
        ));
        assert!(url_is_loopback(
            &Url::parse("http://[::1]:3000/mcp").unwrap()
        ));
        assert!(!url_is_loopback(
            &Url::parse("http://example.test/mcp").unwrap()
        ));
    }

    #[derive(Clone)]
    struct OAuthFixtureState {
        issuer: Arc<str>,
        resource: Arc<str>,
        token_forms: Arc<Mutex<Vec<HashMap<String, String>>>>,
    }

    async fn protected_resource_metadata(
        State(state): State<OAuthFixtureState>,
    ) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "resource": state.resource,
            "authorization_servers": [state.issuer],
            "scopes_supported": ["tools:read"]
        }))
    }

    async fn authorization_server_metadata(
        State(state): State<OAuthFixtureState>,
    ) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "issuer": state.issuer,
            "authorization_endpoint": format!("{}/authorize", state.issuer),
            "token_endpoint": format!("{}/token", state.issuer),
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["tools:read", "offline_access"],
            "authorization_response_iss_parameter_supported": true
        }))
    }

    async fn token_endpoint(
        State(state): State<OAuthFixtureState>,
        Form(form): Form<HashMap<String, String>>,
    ) -> Json<serde_json::Value> {
        state.token_forms.lock().await.push(form);
        Json(serde_json::json!({
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "tools:read offline_access"
        }))
    }

    async fn spawn_oauth_fixture() -> (OAuthFixtureState, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer: Arc<str> = Arc::from(format!("http://{}", listener.local_addr().unwrap()));
        let state = OAuthFixtureState {
            issuer: issuer.clone(),
            resource: Arc::from(format!("{issuer}/mcp")),
            token_forms: Arc::new(Mutex::new(Vec::new())),
        };
        let router = Router::new()
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                get(protected_resource_metadata),
            )
            .route(
                "/.well-known/oauth-authorization-server",
                get(authorization_server_metadata),
            )
            .route("/token", axum::routing::post(token_endpoint))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (state, task)
    }

    #[tokio::test]
    async fn oauth_flow_binds_resource_pkce_and_authorization_issuer() {
        let (fixture, server) = spawn_oauth_fixture().await;
        let mut manager = AuthorizationManager::new_with_oauth_http_client(
            fixture.resource.as_ref(),
            Arc::new(GuardedOAuthHttpClient::new(&fixture.resource).unwrap()),
        )
        .await
        .unwrap();
        manager.set_credential_store(InMemoryCredentialStore::new());
        let resolution = manager.resolve_metadata().await.unwrap();
        assert_eq!(
            resolution.source,
            AuthorizationMetadataSource::ProtectedResourceMetadata
        );
        manager.set_metadata(resolution.metadata);
        let session = AuthorizationSession::new(
            manager,
            AuthorizationRequest::new("http://127.0.0.1:34567/oauth/callback")
                .with_preregistered_client("macro-test")
                .with_scopes(["tools:read"]),
        )
        .await
        .map_err(|(_, error)| error)
        .unwrap();

        let authorization_url = Url::parse(session.get_authorization_url()).unwrap();
        let parameters = authorization_url
            .query_pairs()
            .into_owned()
            .collect::<HashMap<_, _>>();
        assert_eq!(
            parameters.get("resource"),
            Some(&fixture.resource.to_string())
        );
        assert_eq!(
            parameters.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        let state = parameters.get("state").unwrap();

        let mismatch = session
            .handle_callback_with_issuer("code", state, Some("https://attacker.example"))
            .await;
        assert!(matches!(
            mismatch,
            Err(AuthError::AuthorizationServerMismatch { .. })
        ));
        session
            .handle_callback_with_issuer("code", state, Some(&fixture.issuer))
            .await
            .unwrap();
        assert_eq!(
            session.auth_manager.get_access_token().await.unwrap(),
            "access-token"
        );

        let forms = fixture.token_forms.lock().await;
        assert_eq!(forms.len(), 1);
        assert_eq!(
            forms[0].get("resource"),
            Some(&fixture.resource.to_string())
        );
        assert!(forms[0]
            .get("code_verifier")
            .is_some_and(|value| !value.is_empty()));
        server.abort();
    }
}
