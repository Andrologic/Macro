//! Remote UI RPC Server implementation for Tauri applications.
//!
//! This module provides the `RpcServer` struct and related traits for managing a remote UI server,
//! including HTTP and WebSocket handling, lifecycle management, and integration with Tauri's state system.
//!
//! # Features
//! - Start/stop remote UI server
//! - Serve static and embedded assets
//! - WebSocket communication for RPC
//! - Customizable UI activation and disconnect flows
//!
//! # License
//! AGPL-3.0-only License
//! Copyright (c) 2025 DraviaVemal
//! See LICENSE file in the root directory.

use crate::{models::*, remote_ui::net, RemoteUi};
use futures::{stream::SplitSink, SinkExt, StreamExt};
use http_body_util::Full;
use hyper::{
    body::{Bytes, Incoming},
    header::ORIGIN,
    server::conn::http1,
    service::service_fn,
    upgrade::Upgraded,
    Request, Response, StatusCode,
};
use hyper_tungstenite::{tungstenite::Message, HyperWebsocket, WebSocketStream};
use hyper_util::rt::TokioIo;
#[cfg(debug_assertions)]
use std::path::{Component, Path, PathBuf};
use std::{
    collections::HashMap,
    env,
    future::Future,
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{async_runtime::JoinHandle, AppHandle, Error, Listener, Manager, Url, WebviewWindow};
use tokio::{
    net::TcpListener,
    sync::{Mutex, RwLock},
};

/// Extension trait for Tauri's `AppHandle` to manage the Remote UI server lifecycle.
pub trait RemoteUiExt {
    /// Start the remote UI server with the given configuration.
    fn start_remote_ui(
        &self,
        remote_ui_config: RemoteUiConfig,
    ) -> impl Future<Output = Result<(), tauri::Error>>;

    /// Stop the remote UI server if running.
    fn stop_remote_ui(&self) -> impl Future<Output = Result<(), tauri::Error>>;

    /// Check if the remote UI server is currently active.
    fn is_remote_ui_running(&self) -> impl Future<Output = bool>;

    /// The port the remote UI server is currently bound to, or `None` if the
    /// server is not running. Useful when the configuration requested a random
    /// port (`port = None`) and the caller needs to surface the chosen port.
    fn remote_ui_port(&self) -> impl Future<Output = Option<u16>>;
}

/// Implementation of `RemoteUiExt` for Tauri's `AppHandle`.
impl RemoteUiExt for AppHandle {
    /// Start the remote UI server.
    async fn start_remote_ui(&self, remote_ui_config: RemoteUiConfig) -> Result<(), Error> {
        let state = self.state::<Arc<RwLock<RemoteUi>>>();
        let mut guard = state.write().await;
        guard
            .rpc_server
            .start(remote_ui_config)
            .await
            .map_err(Into::into)
    }

    /// Stop the remote UI server.
    async fn stop_remote_ui(&self) -> Result<(), Error> {
        let remote_ui = self.state::<Arc<RwLock<RemoteUi>>>();
        remote_ui.write().await.rpc_server.stop();
        Ok(())
    }

    /// Check if the remote UI server is running.
    async fn is_remote_ui_running(&self) -> bool {
        let state = self.state::<Arc<RwLock<RemoteUi>>>();
        let remote_ui = state.read().await;
        remote_ui.rpc_server.is_active()
    }

    async fn remote_ui_port(&self) -> Option<u16> {
        let state = self.state::<Arc<RwLock<RemoteUi>>>();
        let remote_ui = state.read().await;
        remote_ui.rpc_server.bound_port()
    }
}

/// Type alias for window label strings.
type WindowLabel = String;

const VERSION_PREFIX: &str = "version:";
const SESSION_REPLACED_CLOSE_CODE: u16 = 4009;
const SESSION_REPLACED_CLOSE_REASON: &str = "session_replaced";

fn session_replaced_close_message() -> Message {
    Message::Close(Some(hyper_tungstenite::tungstenite::protocol::CloseFrame {
        code: SESSION_REPLACED_CLOSE_CODE.into(),
        reason: SESSION_REPLACED_CLOSE_REASON.into(),
    }))
}

/// WebSocket sink handle for a single connection (sending side).
pub(crate) type WsSink = Arc<Mutex<SplitSink<WebSocketStream<TokioIo<Upgraded>>, Message>>>;

fn replace_current_handle<T>(
    handles: &mut HashMap<WindowLabel, Arc<T>>,
    window_label: &str,
    handle: Arc<T>,
) -> Option<Arc<T>> {
    handles.insert(window_label.to_owned(), handle)
}

fn remove_handle_if_current<T>(
    handles: &mut HashMap<WindowLabel, Arc<T>>,
    window_label: &str,
    handle: &Arc<T>,
) {
    if handles
        .get(window_label)
        .is_some_and(|current| Arc::ptr_eq(current, handle))
    {
        handles.remove(window_label);
    }
}

/// The main Remote UI RPC server struct.
///
/// Manages HTTP/WebSocket server lifecycle, window handles, and configuration.
#[derive(Debug)]
pub struct RpcServer {
    /// Reference to the Tauri application handle.
    pub(crate) app: Arc<AppHandle>,
    /// Indicates if the server is currently active.
    is_active: bool,
    /// Configuration for the remote UI server.
    remote_ui_config: RemoteUiConfig,
    /// Map of window labels to WebSocket handles.
    ws_window_handle: HashMap<WindowLabel, WsSink>,
    /// Handle to the HTTP server task for aborting on stop.
    http_server_thread: Option<JoinHandle<()>>,
    /// Port the listener was bound to (resolved after start, useful when the
    /// configured port was 0 / `None`).
    bound_port: Option<u16>,
}

impl RpcServer {
    /// Returns whether the server is currently active.
    pub(crate) fn is_active(&self) -> bool {
        self.is_active
    }

    /// The port the listener is bound to, if the server is currently active.
    pub(crate) fn bound_port(&self) -> Option<u16> {
        self.bound_port
    }

    /// The label of the Tauri webview window the remote UI is bound to.
    pub(crate) fn primary_window_label(&self) -> &str {
        self.remote_ui_config.primary_window_label()
    }

    /// Create a new `RpcServer` instance for the given app handle.
    pub(crate) fn new(app: Arc<AppHandle>) -> Self {
        Self {
            app,
            is_active: false,
            remote_ui_config: RemoteUiConfig::default(),
            ws_window_handle: HashMap::new(),
            http_server_thread: None,
            bound_port: None,
        }
    }

    /// Start the remote UI server with the provided configuration.
    /// Returns an error if the server is already running.
    pub(crate) async fn start(&mut self, remote_ui_config: RemoteUiConfig) -> crate::Result<()> {
        if self.is_active {
            return Err(crate::Error::ServerAlreadyRunning);
        }
        self.remote_ui_config = remote_ui_config;
        self.spawn_http_server().await
    }

    /// Stop the remote UI server and abort the HTTP server task.
    pub(crate) fn stop(&mut self) {
        if !self.is_active {
            return;
        }
        self.is_active = false;
        self.bound_port = None;
        let label = self.remote_ui_config.primary_window_label().to_owned();
        if let Some(window) = self.app.get_webview_window(&label) {
            if let Err(err) = window.reload() {
                log::error!("Failed to reload webview window '{label}': {err}");
            }
        }
        if let Some(server_handle) = self.http_server_thread.take() {
            server_handle.abort();
        }
        self.ws_window_handle.clear();
    }

    /// Bind the TCP listener and spawn the connection-accept loop. Records the
    /// bound port on `self` so callers can read it via [`Self::bound_port`].
    pub(crate) async fn spawn_http_server(&mut self) -> crate::Result<()> {
        let origin: &str = self.remote_ui_config.allowed_origin().bind_address();
        let dist_path = if let Some(frontend_path) = self.app.config().build.frontend_dist.as_ref()
        {
            if Url::parse(&frontend_path.to_string()).is_ok() {
                return Err(crate::Error::InvalidFrontendDist);
            }
            frontend_path.to_string()
        } else {
            "../dist".to_owned()
        };
        let static_path = self
            .remote_ui_config
            .bundle_path()
            .map(str::to_owned)
            .unwrap_or(dist_path);
        self.remote_ui_config.bundle_path = Some(static_path);

        let port = self.remote_ui_config.port().unwrap_or(0);
        let listener = TcpListener::bind((origin, port)).await?;
        let actual_port = listener.local_addr()?.port();
        self.bound_port = Some(actual_port);
        self.remote_ui_config.port = Some(actual_port);
        log::info!("Tauri Remote UI listening on {origin}:{actual_port}");

        let scope = self.remote_ui_config.allowed_origin();
        match scope {
            OriginType::Localhost => {
                log::info!("Origin scope: Localhost — peer filter: loopback only");
            }
            OriginType::Any => {
                log::warn!(
                    "Origin scope: Any — peer filter DISABLED, any host that can route to this machine can connect"
                );
            }
            OriginType::Subnet => {
                let subnets = net::trusted_subnet_descriptions();
                if subnets.is_empty() {
                    log::warn!(
                        "Origin scope: Subnet — but no bounded local subnets were detected; only loopback will be accepted"
                    );
                } else {
                    log::info!(
                        "Origin scope: Subnet — trusted networks (peers outside these will get 403): {}",
                        subnets.join(", ")
                    );
                }
            }
        }

        let app_handle = self.app.clone();
        self.is_active = true;
        let handle = tauri::async_runtime::spawn(async move {
            if let Err(err) = run_hyper_server(listener, app_handle).await {
                log::error!("Hyper server for Remote UI exited with error: {err}");
            }
        });
        self.http_server_thread = Some(handle);

        let window_label = self.remote_ui_config.primary_window_label().to_owned();
        let window = self
            .app
            .get_webview_window(&window_label)
            .ok_or_else(|| crate::Error::PrimaryWindowNotFound(window_label.clone()))?;
        if self.remote_ui_config.minimize_app {
            window.minimize().map_err(crate::Error::Tauri)?;
        }
        if !self.remote_ui_config.application_ui {
            let origin = self.remote_ui_config.allowed_origin();
            let urls = build_reachable_urls(origin, actual_port);
            log::info!("Tauri Remote UI reachable at: {}", urls.join(", "));
            let primary_url = urls
                .first()
                .cloned()
                .unwrap_or_else(|| format!("http://127.0.0.1:{actual_port}"));
            self.activate_remote_ui_mode(
                &window,
                &primary_url,
                &urls,
                &self.remote_ui_config.custom_blocking_ui,
            )
            .map_err(crate::Error::Tauri)?;
        }
        Ok(())
    }

    /// Activate the remote UI mode in the given window, replacing its DOM with
    /// custom or default HTML. `urls` is the full list of addresses the server
    /// is reachable on; `primary_url` is the canonical one used for the info
    /// page link and for the JS `console.info` notice.
    pub(crate) fn activate_remote_ui_mode(
        &self,
        window: &WebviewWindow,
        primary_url: &str,
        urls: &[String],
        custom_html: &Option<String>,
    ) -> Result<(), Error> {
        let urls_list = render_urls_list(urls);
        let urls_csv = urls.join(", ");
        let info_url = format!("{primary_url}/remote_ui_info");
        let html = if let Some(custom_html) = custom_html {
            custom_html
                .replace("%URLS%", &urls_csv)
                .replace("%URLS_LIST%", &urls_list)
                .replace("%URL_INFO%", &info_url)
        } else {
            include_str!("default.html")
                .replace("%URLS%", &urls_csv)
                .replace("%URLS_LIST%", &urls_list)
                .replace("%URL_INFO%", &info_url)
        };
        // Replace DOM content with HTML string.
        window.eval(format!(
            r#"(function() {{
            document.body.innerHTML = `{html}`;
            document.body.style.margin = '0';
            document.body.style.padding = '0';
            document.documentElement.style.height = '100%';
            document.body.style.height = '100%';
            console.info("Tauri-Remote-UI : Remote UI Plugin Activated");
            console.info("Tauri-Remote-UI : Reachable at", {urls});
        }})();"#,
            html = html,
            urls = serde_json::to_string(urls).unwrap_or_else(|_| "[]".to_owned()),
        ))
    }

    /// Set the WebSocket handle for a given window label.
    pub(crate) fn set_ws_handle(
        &mut self,
        window_label: &str,
        ws_handle: WsSink,
    ) -> Option<WsSink> {
        replace_current_handle(&mut self.ws_window_handle, window_label, ws_handle)
    }

    /// Get the WebSocket handle for a given window label, if present.
    pub(crate) fn get_ws_handle(&self, window_label: &str) -> Option<&WsSink> {
        self.ws_window_handle.get(window_label)
    }

    pub(crate) fn remove_ws_handle_if_current(&mut self, window_label: &str, ws_handle: &WsSink) {
        remove_handle_if_current(&mut self.ws_window_handle, window_label, ws_handle);
    }
}

/// Run the Hyper accept loop for the already-bound listener. The loop exits
/// when the server is marked inactive (the task is also `.abort()`ed by
/// [`RpcServer::stop`], whichever happens first).
async fn run_hyper_server(
    listener: TcpListener,
    app_handle: Arc<AppHandle>,
) -> std::io::Result<()> {
    loop {
        {
            let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
            if !remote_ui.read().await.rpc_server.is_active() {
                break;
            }
        }
        let (stream, peer_addr) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let req_app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = http1::Builder::new()
                .serve_connection(
                    io,
                    service_fn(move |req| handle_request(req, req_app_handle.clone(), peer_addr)),
                )
                .with_upgrades()
                .await
            {
                log::warn!("Error serving Remote UI connection: {err:?}");
            }
        });
    }
    Ok(())
}

/// Build the list of `http://<ip>:<port>` URLs the server is reachable on.
fn build_reachable_urls(origin: OriginType, port: u16) -> Vec<String> {
    let mut urls: Vec<String> = net::reachable_addresses(origin)
        .into_iter()
        .map(|ip| format_url(ip, port))
        .collect();
    urls.dedup();
    urls
}

fn format_url(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(_) => format!("http://{ip}:{port}"),
        IpAddr::V6(_) => format!("http://[{ip}]:{port}"),
    }
}

/// Render a list of URLs as `<li><a href="...">...</a></li>` items.
fn render_urls_list(urls: &[String]) -> String {
    urls.iter()
        .map(|u| {
            let escaped = html_escape(u);
            format!("<li><a href=\"{escaped}\" target=\"_blank\">{escaped}</a></li>")
        })
        .collect::<Vec<_>>()
        .join("")
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Handle incoming HTTP requests for the remote UI server.
/// Routes requests to keep-alive, info, WebSocket, disconnect, or asset serving endpoints.
async fn handle_request(
    request: Request<Incoming>,
    app_handle: Arc<AppHandle>,
    peer_addr: SocketAddr,
) -> Result<Response<Full<Bytes>>, Error> {
    // Origin scope filter: reject early if the peer is outside the allowed scope.
    {
        let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
        let origin = remote_ui
            .read()
            .await
            .rpc_server
            .remote_ui_config
            .allowed_origin();
        if !net::peer_allowed(origin, peer_addr.ip()) {
            log::warn!("Remote UI: rejected {peer_addr} with 403 (scope: {origin:?})");
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Full::new(Bytes::from("Forbidden")))
                .map_err(|err| {
                    Error::AssetNotFound(format!("Failed to build forbidden response: {err}"))
                });
        }
    }
    let path = request.uri().path().to_string();
    match (request.method().as_str(), path.as_str()) {
        ("GET", "/keep_alive") => {
            // Respond to keep-alive checks
            let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
            if remote_ui.read().await.rpc_server.is_active() {
                let response = Response::builder()
                    .header("Content-Type", "text/plain; charset=UTF-8".to_owned())
                    .body(Full::new(Bytes::from("alive")))
                    .map_err(|err| {
                        Error::AssetNotFound(format!("Failed to respond to keep alive. Err:{err}"))
                    })?;
                Ok(response)
            } else {
                not_found()
                    .map_err(|err| Error::AssetNotFound(format!("Keep alive failed. {err:?}")))
            }
        }
        ("GET", "/remote_ui_info") => {
            // Serve remote UI info page
            let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
            if !remote_ui
                .read()
                .await
                .rpc_server
                .remote_ui_config
                .enable_info_url
            {
                not_found()
                    .map_err(|err| Error::AssetNotFound(format!("File serving failed. {err:?}")))
            } else {
                let app = app_handle.state::<Arc<RwLock<RemoteUi>>>();
                let remote_ui_config = app.read().await.rpc_server.remote_ui_config.clone();
                let info_html = include_str!("information.html")
                    .replace(
                        "%ORIGIN_SCOPE%",
                        remote_ui_config.allowed_origin().bind_address(),
                    )
                    .replace(
                        "%PORT%",
                        &remote_ui_config.port().unwrap_or_default().to_string(),
                    )
                    .replace("%PLUGIN_VERSION%", env!("CARGO_PKG_VERSION"))
                    .replace(
                        "%APP_VERSION%",
                        &app_handle.package_info().version.to_string(),
                    );
                let response = Response::builder()
                    .header("Content-Type", "text/html; charset=UTF-8".to_owned())
                    .body(Full::new(Bytes::from(info_html)))
                    .map_err(|err| {
                        Error::AssetNotFound(format!("Failed to Load Info Page. Err:{err}"))
                    })?;
                Ok(response)
            }
        }
        ("GET", "/remote_ui_ws") => {
            // Handle WebSocket upgrade requests
            let authorized = {
                let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
                let remote_ui = remote_ui.read().await;
                websocket_request_authorized(
                    &request,
                    remote_ui
                        .rpc_server
                        .remote_ui_config
                        .websocket_origin
                        .as_deref(),
                    remote_ui
                        .rpc_server
                        .remote_ui_config
                        .websocket_token
                        .as_deref(),
                )
            };
            if !authorized {
                log::warn!("Remote UI: rejected unauthorized WebSocket upgrade from {peer_addr}");
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Full::new(Bytes::from("Forbidden")))
                    .map_err(|err| {
                        Error::AssetNotFound(format!("Failed to build forbidden response: {err}"))
                    });
            }
            if hyper_tungstenite::is_upgrade_request(&request) {
                match hyper_tungstenite::upgrade(request, None) {
                    Ok((response, websocket)) => {
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = ws_handle(websocket, Arc::clone(&app_handle)).await {
                                log::warn!("WebSocket session error: {e:?}");
                            }
                        });
                        Ok(response)
                    }
                    Err(e) => {
                        log::warn!("WebSocket upgrade error: {e}");
                        let response = Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .body(Full::new(Bytes::from("WebSocket upgrade failed")))
                            .map_err(|err| {
                                Error::AssetNotFound(format!(
                                    "Failed to build WS upgrade failure response: {err}"
                                ))
                            })?;
                        Ok(response)
                    }
                }
            } else {
                Err(Error::PluginInitialization(
                    "tauri-remote-ui".to_owned(),
                    "Failed to Upgrade WS RPC".to_owned(),
                ))
            }
        }
        ("GET", "/remote_ui_disconnect") => {
            // Serve disconnect page
            let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
            let redirect_html = if let Some(redirect_html) = remote_ui
                .read()
                .await
                .rpc_server
                .remote_ui_config
                .custom_disconnect_ui
                .as_ref()
            {
                redirect_html.to_string()
            } else {
                include_str!("redirect.html").to_string()
            };

            let response = Response::builder()
                .header("Content-Type", "text/html; charset=UTF-8".to_owned())
                .body(Full::new(Bytes::from(redirect_html)))
                .map_err(|err| {
                    Error::AssetNotFound(format!("Failed to Load Disconnect Page. Err:{err}"))
                })?;
            Ok(response)
        }
        ("GET", path) => wildcard_get_handler(path, app_handle)
            .await
            .map_err(|err| Error::AssetNotFound(format!("File serving failed. {err:?}"))),

        _ => {
            not_found().map_err(|err| Error::AssetNotFound(format!("File serving failed. {err:?}")))
        }
    }
}

fn websocket_request_authorized(
    request: &Request<Incoming>,
    expected_origin: Option<&str>,
    expected_token: Option<&str>,
) -> bool {
    let origin = request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok());
    websocket_credentials_match(
        origin,
        request.uri().query(),
        expected_origin,
        expected_token,
    )
}

fn websocket_credentials_match(
    origin: Option<&str>,
    query: Option<&str>,
    expected_origin: Option<&str>,
    expected_token: Option<&str>,
) -> bool {
    let origin_matches = expected_origin.is_none_or(|expected| origin == Some(expected));
    let token_matches = expected_token.is_none_or(|expected| {
        query.and_then(|query| {
            query
                .split('&')
                .find_map(|item| item.strip_prefix("token="))
        }) == Some(expected)
    });
    origin_matches && token_matches
}

#[cfg(test)]
mod tests {
    use super::{
        confined_asset_path, remove_handle_if_current, replace_current_handle,
        session_replaced_close_message, websocket_credentials_match, SESSION_REPLACED_CLOSE_CODE,
        SESSION_REPLACED_CLOSE_REASON,
    };
    use hyper_tungstenite::tungstenite::{accept, client, Message};
    use std::collections::HashMap;
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn websocket_requires_the_expected_origin_and_token() {
        let origin = Some("http://127.0.0.1:1422");
        let token = Some("secret");

        assert!(websocket_credentials_match(
            origin,
            Some("token=secret"),
            origin,
            token,
        ));
        assert!(!websocket_credentials_match(
            Some("http://127.0.0.1:1440"),
            Some("token=secret"),
            origin,
            token,
        ));
        assert!(!websocket_credentials_match(origin, None, origin, token,));
        assert!(!websocket_credentials_match(
            origin,
            Some("token=wrong"),
            origin,
            token,
        ));
    }

    #[test]
    fn static_assets_cannot_escape_their_canonical_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "tauri-remote-ui-assets-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("temporary asset root must be created");
        std::fs::write(root.join("index.html"), "ok").expect("temporary asset must be written");

        let root_string = root.to_string_lossy();
        assert!(confined_asset_path(&root_string, "index.html").is_some());
        assert!(confined_asset_path(&root_string, "%2e%2e%2fpackage.json").is_none());
        assert!(confined_asset_path(&root_string, "%2e%2e%5cpackage.json").is_none());

        std::fs::remove_dir_all(&root).expect("temporary asset root must be removed");
    }

    #[test]
    fn second_real_client_receives_ownership_without_reconnect_eviction_loop() {
        let first_owner = Arc::new("first");
        let second_owner = Arc::new("second");
        let mut registry = HashMap::new();
        assert!(replace_current_handle(&mut registry, "main", first_owner.clone()).is_none());
        let replaced = replace_current_handle(&mut registry, "main", second_owner.clone())
            .expect("second client must replace the first registry owner");
        assert!(Arc::ptr_eq(&replaced, &first_owner));
        remove_handle_if_current(&mut registry, "main", &first_owner);
        assert!(Arc::ptr_eq(
            registry
                .get("main")
                .expect("new owner must remain registered"),
            &second_owner,
        ));
        remove_handle_if_current(&mut registry, "main", &second_owner);
        assert!(!registry.contains_key("main"));

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test websocket server");
        let address = listener.local_addr().expect("read test websocket address");
        let server = thread::spawn(move || {
            let (first_stream, _) = listener.accept().expect("accept first client");
            let mut first = accept(first_stream).expect("upgrade first client");
            let (second_stream, _) = listener.accept().expect("accept second client");
            let mut second = accept(second_stream).expect("upgrade second client");

            first
                .send(session_replaced_close_message())
                .expect("close replaced client");
            second
                .send(Message::Text("session_owner".into()))
                .expect("confirm new owner");
        });

        let url = format!("ws://{address}/remote_ui_ws");
        let (mut first, _) = client(
            url.as_str(),
            TcpStream::connect(address).expect("connect first client"),
        )
        .expect("handshake first client");
        let (mut second, _) = client(
            url.as_str(),
            TcpStream::connect(address).expect("connect second client"),
        )
        .expect("handshake second client");

        let Message::Close(Some(close)) = first.read().expect("read terminal close") else {
            panic!("first client must receive a close frame");
        };
        assert_eq!(u16::from(close.code), SESSION_REPLACED_CLOSE_CODE);
        assert_eq!(close.reason, SESSION_REPLACED_CLOSE_REASON);
        assert_eq!(
            second.read().expect("read ownership confirmation"),
            Message::Text("session_owner".into())
        );
        server.join().expect("join test websocket server");
    }
}

/// Handle a WebSocket connection for remote UI RPC.
/// Manages ping/pong, message routing, and connection lifecycle.
async fn ws_handle(websocket: HyperWebsocket, app_handle: Arc<AppHandle>) -> Result<(), Error> {
    static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

    match websocket.await {
        Ok(ws_stream) => {
            let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
            let pending_listeners = Arc::new(std::sync::Mutex::new(HashMap::new()));
            let (tx, mut rx) = ws_stream.split();
            let ws_sender = Arc::new(Mutex::new(tx));
            let primary_label;
            // Transfer primary-session ownership to the newest browser client. The
            // terminal close code tells the previous client not to reconnect.
            let existing_handle = {
                let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
                let mut remote_ui_mut = remote_ui.write().await;
                primary_label = remote_ui_mut.rpc_server.primary_window_label().to_owned();
                remote_ui_mut
                    .rpc_server
                    .set_ws_handle(&primary_label, ws_sender.clone())
            };
            if let Some(existing_handle) = existing_handle {
                if let Err(err) = existing_handle
                    .lock()
                    .await
                    .send(session_replaced_close_message())
                    .await
                {
                    log::warn!("Failed to close existing socket connection: {err}");
                }
            }
            let mut session_error = None;
            while let Some(message_stream) = rx.next().await {
                match message_stream {
                    Ok(message) => match message {
                        Message::Text(msg) => {
                            if msg == "ping" {
                                if let Err(err) = ws_sender
                                    .lock()
                                    .await
                                    .send(Message::Text("pong".into()))
                                    .await
                                {
                                    log::warn!("Failed to send pong: {err}");
                                }
                            } else if let Some(client_version) = msg.strip_prefix(VERSION_PREFIX) {
                                let server_version = env!("CARGO_PKG_VERSION");
                                if client_version != server_version {
                                    log::warn!(
                                        "Tauri Remote UI version mismatch — frontend npm package is '{client_version}', host crate is '{server_version}'. Behavior is undefined; align both to the same release."
                                    );
                                }
                                let reply = format!("{VERSION_PREFIX}{server_version}");
                                if let Err(err) = ws_sender
                                    .lock()
                                    .await
                                    .send(Message::Text(reply.into()))
                                    .await
                                {
                                    log::warn!("Failed to send version reply: {err}");
                                }
                            } else {
                                let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
                                let remote_ui_mut = remote_ui.read().await;
                                if let Err(err) = remote_ui_mut.invoke_rpc(
                                    msg.as_ref(),
                                    ws_sender.clone(),
                                    session_id,
                                    pending_listeners.clone(),
                                ) {
                                    session_error = Some(err);
                                    break;
                                }
                            }
                        }
                        Message::Close(_) => {
                            log::debug!("Remote UI socket closed by peer");
                        }
                        _ => {
                            log::trace!("Unhandled WS data frame");
                        }
                    },
                    Err(err) => {
                        log::warn!("Message read failed: {err}");
                    }
                }
            }
            let remote_ui = app_handle.state::<Arc<RwLock<RemoteUi>>>();
            remote_ui
                .write()
                .await
                .rpc_server
                .remove_ws_handle_if_current(&primary_label, &ws_sender);
            let listener_ids = pending_listeners
                .lock()
                .expect("remote UI listener registry mutex poisoned")
                .drain()
                .map(|(_, id)| id)
                .collect::<Vec<_>>();
            for listener_id in listener_ids {
                app_handle.unlisten(listener_id);
            }
            match session_error {
                Some(err) => Err(err),
                None => Ok(()),
            }
        }
        Err(err) => {
            log::warn!("Socket stream upgrade failed: {err:?}");
            Err(Error::FailedToReceiveMessage)
        }
    }
}

/// Handler for all wildcard GET routes: serve file from disk (debug), then embedded (release), else 404.
/// Used for static asset serving in the remote UI server.
async fn wildcard_get_handler(
    path: &str,
    app_handle: Arc<AppHandle>,
) -> Result<Response<Full<Bytes>>, tauri::http::Error> {
    // If the path ends with a slash or has no file extension, serve index.html
    let mut file_path = path.trim_start_matches('/').to_string();
    file_path = if file_path.ends_with('/') || !file_path.contains('.') {
        format!("{}/index.html", &file_path.trim_end_matches('/'))
    } else {
        file_path
    };
    #[cfg(debug_assertions)]
    {
        let remote_state = app_handle.state::<Arc<RwLock<RemoteUi>>>();
        let remote_ui = remote_state.read().await;
        if let Some(static_path) = remote_ui.rpc_server.remote_ui_config.bundle_path.as_ref() {
            if let Some(file_path) = confined_asset_path(static_path, &file_path) {
                let Ok(bytes) = std::fs::read(&file_path) else {
                    return not_found();
                };
                let content_type = mime_guess::from_path(&file_path).first_or_octet_stream();
                return Response::builder()
                    .header("Content-Type", content_type.to_string())
                    .body(Full::new(Bytes::from(bytes)));
            }
        }
    }
    #[cfg(not(debug_assertions))] // Release mode: serve from the embedded asset resolver.
    {
        let content_type = mime_guess::from_path(&file_path).first_or_octet_stream();
        if let Some(asset) = app_handle.asset_resolver().get(file_path) {
            return Response::builder()
                .header("Content-Type", content_type.to_string())
                .body(Full::new(Bytes::from(asset.bytes)));
        }
    }
    not_found()
}

#[cfg(debug_assertions)]
fn confined_asset_path(root: &str, requested_path: &str) -> Option<PathBuf> {
    let decoded = urlencoding::decode(requested_path).ok()?;
    let relative = Path::new(decoded.as_ref());
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }

    let canonical_root = std::fs::canonicalize(root).ok()?;
    let candidate = std::fs::canonicalize(canonical_root.join(relative)).ok()?;
    candidate.starts_with(&canonical_root).then_some(candidate)
}

/// Helper to return a 404 Not Found HTTP response.
fn not_found() -> Result<Response<Full<Bytes>>, tauri::http::Error> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Full::new(Bytes::from("Not Found!")))
}
