//! Remote UI Plugin Extension for Tauri
//!
//! This module provides the main plugin state, initialization, and core APIs for the remote UI system.
//! It enables RPC invocation and event emission over WebSocket for Tauri applications.
//!
//! # License
//! AGPL-3.0-only License
//! Copyright (c) 2025 DraviaVemal
//! See LICENSE file in the root directory.

use crate::{RpcServer, RpcStatus, WsPayload};
use futures::{stream::SplitSink, SinkExt};
use hyper::upgrade::Upgraded;
use hyper_tungstenite::{tungstenite::Message, WebSocketStream};
use hyper_util::rt::TokioIo;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::json;
use std::{collections::HashMap, sync::Arc};
use tauri::{plugin::PluginApi, AppHandle, Error, Manager, Runtime};
use tokio::sync::{Mutex, RwLock};

/// Initialize the remote UI plugin state for Tauri.
///
/// This function sets up the shared state for the plugin, including the RPC server and app handle.
/// It should be called from the plugin setup code.
pub fn init<R, C>(app: &AppHandle, _api: PluginApi<R, C>) -> crate::Result<Arc<RwLock<RemoteUi>>>
where
    C: DeserializeOwned,
    R: Runtime,
{
    let app_handle = Arc::new(app.clone());
    let remote_ui = Arc::new(RwLock::new(RemoteUi {
        app: app_handle.clone(),
        rpc_server: RpcServer::new(app_handle),
    }));
    Ok(remote_ui)
}

/// Main plugin state for remote UI APIs.
///
/// Holds references to the Tauri app and the RPC server for remote UI communication.
#[derive(Debug)]
pub struct RemoteUi {
    /// Reference to the Tauri application handle.
    pub(crate) app: Arc<AppHandle>,
    /// The RPC server instance for remote UI.
    pub(crate) rpc_server: RpcServer,
}

impl RemoteUi {
    /// Returns whether the remote UI RPC server is currently active.
    pub(crate) fn is_rpc_active(&self) -> bool {
        self.rpc_server.is_active()
    }

    /// Invoke an RPC command from a WebSocket payload.
    ///
    /// This method deserializes the payload, executes the command in the Tauri window,
    /// and sends the result back over WebSocket.
    pub(crate) fn invoke_rpc(
        &self,
        payload: &str,
        session: Arc<Mutex<SplitSink<WebSocketStream<TokioIo<Upgraded>>, Message>>>,
        session_id: u64,
    ) -> Result<(), Error> {
        let ws_payload: WsPayload = serde_json::from_str(payload).map_err(|err| {
            Error::PluginInitialization(
                "tauri-remote-ui".to_owned(),
                format!("Failed to parse WS payload. Err: {err}"),
            )
        })?;
        let window_label = self.rpc_server.primary_window_label().to_owned();
        let window = self.app.get_webview_window(&window_label).ok_or_else(|| {
            Error::AssetNotFound(format!("Webview window '{window_label}' not found",))
        })?;
        // JSON-encode every interpolated input so untrusted strings from the
        // socket cannot escape the JS string context inside `window.eval`.
        let cmd_json = serde_json::to_string(&ws_payload.cmd).map_err(|err| {
            Error::PluginInitialization(
                "tauri-remote-ui".to_owned(),
                format!("Failed to serialize cmd: {err}"),
            )
        })?;
        let args_json = serde_json::to_string(&ws_payload.args).map_err(|err| {
            Error::PluginInitialization(
                "tauri-remote-ui".to_owned(),
                format!("Failed to serialize args: {err}"),
            )
        })?;
        let opts_json = serde_json::to_string(&ws_payload.option).map_err(|err| {
            Error::PluginInitialization(
                "tauri-remote-ui".to_owned(),
                format!("Failed to serialize options: {err}"),
            )
        })?;
        let js = format!(
            r#"
            window.__TAURI_INTERNALS__.invoke({cmd}, {args}, {opts})
                .then((res) => {{
                    return window.__TAURI_INTERNALS__.invoke("plugin:remote-ui|complete_rpc", {{
                        sessionId: "{session_id}",
                        id: {id},
                        status: "{success}", payload: res
                    }});
                }}, (err) => {{
                    return window.__TAURI_INTERNALS__.invoke("plugin:remote-ui|complete_rpc", {{
                        sessionId: "{session_id}",
                        id: {id},
                        status: "{error}", payload: err
                    }});
                }}).catch((err) => console.error("Remote UI RPC completion failed", err));
            "#,
            cmd = cmd_json,
            args = args_json,
            opts = opts_json,
            session_id = session_id,
            id = ws_payload.id,
            success = RpcStatus::Success.as_str(),
            error = RpcStatus::Error.as_str(),
        );
        let pending = self.app.state::<PendingRpcs>();
        let key = (session_id.to_string(), ws_payload.id);
        pending.insert(key.clone(), session)?;
        if let Err(err) = window.eval(js) {
            pending.take(&key);
            return Err(err);
        }
        Ok(())
    }

    /// Emit a message to the target window over WebSocket.
    ///
    /// This method serializes the event and payload and sends it to the primary window session if available.
    pub async fn emit<P: Serialize + Clone>(&self, event: &str, payload: P) -> Result<(), Error> {
        let label = self.rpc_server.primary_window_label();
        if let Some(session) = self.rpc_server.get_ws_handle(label) {
            let json = json!({
                "event":event,
                "payload":payload
            })
            .to_string();
            session
                .lock()
                .await
                .send(Message::text(json))
                .await
                .map_err(|err| {
                    Error::PluginInitialization(
                        "tauri-remote-ui".to_owned(),
                        format!("Failed to send WS message. Err: {err}"),
                    )
                })?;
        }
        Ok(())
    }
}

type WsSender = Arc<Mutex<SplitSink<WebSocketStream<TokioIo<Upgraded>>, Message>>>;
pub(crate) type PendingRpcs = RpcRegistry<WsSender>;

// Registration is synchronous: completion never depends on Tauri's pending
// event-listener queue. Taking a recipient also consumes the request atomically.
#[derive(Debug)]
pub(crate) struct RpcRegistry<T>(std::sync::Mutex<HashMap<(String, usize), T>>);

impl<T> Default for RpcRegistry<T> {
    fn default() -> Self {
        Self(std::sync::Mutex::new(HashMap::new()))
    }
}

impl<T> RpcRegistry<T> {
    fn insert(&self, key: (String, usize), recipient: T) -> Result<(), Error> {
        use std::collections::hash_map::Entry;
        match self
            .0
            .lock()
            .expect("RPC registry mutex poisoned")
            .entry(key)
        {
            Entry::Vacant(entry) => {
                entry.insert(recipient);
                Ok(())
            }
            Entry::Occupied(_) => Err(Error::PluginInitialization(
                "tauri-remote-ui".into(),
                "Duplicate pending RPC id".into(),
            )),
        }
    }

    fn take(&self, key: &(String, usize)) -> Option<T> {
        self.0
            .lock()
            .expect("RPC registry mutex poisoned")
            .remove(key)
    }

    pub(crate) fn remove_session(&self, session_id: u64) {
        let session_id = session_id.to_string();
        self.0
            .lock()
            .expect("RPC registry mutex poisoned")
            .retain(|(session, _), _| session != &session_id);
    }
}

impl PendingRpcs {
    pub(crate) fn remove_recipient(&self, recipient: &WsSender) {
        self.0
            .lock()
            .expect("RPC registry mutex poisoned")
            .retain(|_, sender| !Arc::ptr_eq(sender, recipient));
    }
}

#[tauri::command]
pub(crate) async fn complete_rpc(
    webview: tauri::Webview,
    remote_ui: tauri::State<'_, Arc<RwLock<RemoteUi>>>,
    pending: tauri::State<'_, PendingRpcs>,
    session_id: String,
    id: usize,
    status: RpcStatus,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    if webview.label() != remote_ui.read().await.rpc_server.primary_window_label() {
        return Err("RPC completion must originate from the primary host webview".into());
    }
    if let Some(session) = pending.take(&(session_id, id)) {
        // Preserve the existing wire envelope: payload is a JSON string.
        let payload = json!({"status": status, "payload": payload}).to_string();
        session
            .lock()
            .await
            .send(Message::text(
                json!({"id": id, "payload": payload}).to_string(),
            ))
            .await
            .map_err(|err| format!("WS send message failed: {err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::RpcRegistry;

    #[test]
    fn immediate_completions_are_consumed_once_and_isolated_by_session() {
        let pending = RpcRegistry::default();
        for id in 0..1000 {
            pending.insert(("1".into(), id), "first").unwrap();
            pending.insert(("2".into(), id), "second").unwrap();
            assert_eq!(pending.take(&("1".into(), id)), Some("first"));
            assert_eq!(pending.take(&("1".into(), id)), None);
            assert_eq!(pending.take(&("2".into(), id)), Some("second"));
        }
    }

    #[test]
    fn concurrent_completions_deliver_to_only_one_recipient() {
        let pending = std::sync::Arc::new(RpcRegistry::default());
        pending.insert(("1".into(), 7), 42).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let pending = pending.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    pending.take(&("1".into(), 7))
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results, vec![42]);
    }

    #[test]
    fn disconnect_and_eval_failure_remove_only_their_requests() {
        let pending = RpcRegistry::default();
        pending.insert(("1".into(), 1), 11).unwrap();
        pending.insert(("1".into(), 2), 12).unwrap();
        pending.insert(("2".into(), 1), 21).unwrap();
        assert!(pending.insert(("2".into(), 1), 99).is_err());
        assert_eq!(pending.take(&("1".into(), 1)), Some(11));
        pending.remove_session(1);
        assert_eq!(pending.take(&("1".into(), 2)), None);
        assert_eq!(pending.take(&("2".into(), 1)), Some(21));
    }
}
