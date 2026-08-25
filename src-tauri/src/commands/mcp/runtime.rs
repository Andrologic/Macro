use super::ids::is_canonical_mcp_server_id;
use super::types::{
    McpCallToolResponse, McpCatalogDto, McpProtocolEra, McpProtocolMode, McpRuntimeKey,
    McpRuntimeSelector, McpRuntimeServerSnapshot, McpRuntimeSnapshotDto, McpRuntimeStatus,
    McpToolDto,
};
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify, Semaphore};
use uuid::Uuid;

const CONNECTOR_UNAVAILABLE: &str = "MCP_RUNTIME_CONNECTOR_UNAVAILABLE";
const STALE_GENERATION: &str = "MCP_RUNTIME_STALE_GENERATION";
const NOT_CONNECTED: &str = "MCP_RUNTIME_NOT_CONNECTED";
const OPERATION_CANCELLED: &str = "MCP_RUNTIME_OPERATION_CANCELLED";

pub(crate) type McpFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, McpRuntimeError>> + Send + 'a>>;
pub(crate) type McpAuthorityGuard = Box<dyn Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeError {
    pub code: &'static str,
    pub message: String,
}

impl McpRuntimeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for McpRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for McpRuntimeError {}

#[derive(Debug, Default)]
pub struct McpOperationCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl McpOperationCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) trait McpSession: Send + Sync {
    fn is_closed(&self) -> bool;

    fn list_tools<'a>(
        &'a self,
        cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, Vec<McpToolDto>>;

    fn call_tool<'a>(
        &'a self,
        tool_name: &'a str,
        arguments: serde_json::Value,
        cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, McpCallToolResponse>;

    fn close<'a>(&'a self) -> McpFuture<'a, ()>;
}

pub(crate) struct McpConnectedSession {
    pub session: Arc<dyn McpSession>,
    pub requested_protocol_mode: Option<McpProtocolMode>,
    pub negotiated_era: Option<McpProtocolEra>,
    pub negotiated_protocol_version: Option<String>,
    pub protocol_decision_reason: Option<String>,
    pub max_concurrent_operations: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct McpConnectionRequest {
    pub key: McpRuntimeKey,
    pub config_fingerprint: String,
}

pub(crate) trait McpConnector: Send + Sync {
    fn acquire_authority<'a>(&'a self) -> McpFuture<'a, Option<McpAuthorityGuard>> {
        Box::pin(async { Ok(None) })
    }

    fn config_fingerprint<'a>(&'a self, selector: &'a McpRuntimeSelector) -> McpFuture<'a, String>;

    fn connect<'a>(
        &'a self,
        request: &'a McpConnectionRequest,
    ) -> McpFuture<'a, McpConnectedSession>;
}

#[derive(Default)]
struct UnavailableConnector;

impl McpConnector for UnavailableConnector {
    fn config_fingerprint<'a>(
        &'a self,
        _selector: &'a McpRuntimeSelector,
    ) -> McpFuture<'a, String> {
        Box::pin(async { Ok("unavailable-connector".to_string()) })
    }

    fn connect<'a>(
        &'a self,
        _request: &'a McpConnectionRequest,
    ) -> McpFuture<'a, McpConnectedSession> {
        Box::pin(async {
            Err(McpRuntimeError::new(
                CONNECTOR_UNAVAILABLE,
                "No persistent MCP connector is installed.",
            ))
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LogicalRuntimeKey {
    server_id: String,
    project_id: Option<String>,
    project_ids: Vec<String>,
}

impl From<&McpRuntimeKey> for LogicalRuntimeKey {
    fn from(key: &McpRuntimeKey) -> Self {
        Self {
            server_id: key.server_id.clone(),
            project_id: key.project_id.clone(),
            project_ids: key.project_ids.clone(),
        }
    }
}

impl From<&McpRuntimeSelector> for LogicalRuntimeKey {
    fn from(selector: &McpRuntimeSelector) -> Self {
        Self {
            server_id: selector.server_id.clone(),
            project_id: None,
            project_ids: selector.project_ids.clone(),
        }
    }
}

struct RuntimeEntry {
    snapshot: McpRuntimeServerSnapshot,
    config_fingerprint: String,
    session: Option<Arc<dyn McpSession>>,
    catalog: Option<McpCatalogDto>,
    concurrency: Arc<Semaphore>,
}

impl RuntimeEntry {
    fn connecting(key: McpRuntimeKey, config_fingerprint: String) -> Self {
        Self {
            snapshot: McpRuntimeServerSnapshot {
                key,
                status: McpRuntimeStatus::Connecting,
                requested_protocol_mode: None,
                negotiated_era: None,
                negotiated_protocol_version: None,
                protocol_decision_reason: None,
                last_error: None,
                updated_at: now(),
            },
            config_fingerprint,
            session: None,
            catalog: None,
            concurrency: Arc::new(Semaphore::new(1)),
        }
    }
}

struct ActiveOperation {
    key: McpRuntimeKey,
    cancellation: Arc<McpOperationCancellation>,
}

#[derive(Default)]
struct RuntimeState {
    entries: HashMap<LogicalRuntimeKey, RuntimeEntry>,
}

#[derive(Clone)]
pub struct McpRuntimeManager {
    connector: Arc<dyn McpConnector>,
    state: Arc<Mutex<RuntimeState>>,
    operations: Arc<StdMutex<HashMap<String, ActiveOperation>>>,
    shutting_down: Arc<AtomicBool>,
}

impl Default for McpRuntimeManager {
    fn default() -> Self {
        Self::with_connector(Arc::new(UnavailableConnector))
    }
}

impl McpRuntimeManager {
    pub(crate) fn production() -> Self {
        Self::with_connector(Arc::new(
            super::runtime_connector::ConfiguredMcpConnector::default(),
        ))
    }

    pub(crate) fn with_connector(connector: Arc<dyn McpConnector>) -> Self {
        Self {
            connector,
            state: Arc::new(Mutex::new(RuntimeState::default())),
            operations: Arc::new(StdMutex::new(HashMap::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn snapshot(&self) -> McpRuntimeSnapshotDto {
        let state = self.state.lock().await;
        let mut servers = state
            .entries
            .values()
            .map(|entry| entry.snapshot.clone())
            .collect::<Vec<_>>();
        servers.sort_by(|left, right| {
            left.key
                .server_id
                .cmp(&right.key.server_id)
                .then_with(|| left.key.project_id.cmp(&right.key.project_id))
                .then_with(|| left.key.project_ids.cmp(&right.key.project_ids))
                .then_with(|| left.key.config_generation.cmp(&right.key.config_generation))
        });
        McpRuntimeSnapshotDto {
            generated_at: now(),
            servers,
        }
    }

    pub async fn connect(
        &self,
        selector: McpRuntimeSelector,
    ) -> Result<McpRuntimeServerSnapshot, McpRuntimeError> {
        validate_selector(&selector)?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(McpRuntimeError::new(
                "MCP_RUNTIME_SHUTTING_DOWN",
                "The MCP runtime is shutting down.",
            ));
        }
        let logical_key = LogicalRuntimeKey::from(&selector);
        let observed_key = {
            let state = self.state.lock().await;
            state
                .entries
                .get(&logical_key)
                .map(|entry| entry.snapshot.key.clone())
        };
        let config_fingerprint = match {
            let _authority = self.connector.acquire_authority().await?;
            self.connector.config_fingerprint(&selector).await
        } {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                if let Some(observed_key) = observed_key {
                    self.invalidate_if_current(&observed_key, &error).await;
                }
                return Err(error);
            }
        };
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(McpRuntimeError::new(
                "MCP_RUNTIME_SHUTTING_DOWN",
                "The MCP runtime is shutting down.",
            ));
        }
        let key;
        let retired_session = {
            let mut state = self.state.lock().await;
            if self.shutting_down.load(Ordering::Acquire) {
                return Err(McpRuntimeError::new(
                    "MCP_RUNTIME_SHUTTING_DOWN",
                    "The MCP runtime is shutting down.",
                ));
            }
            if let Some(entry) = state.entries.get(&logical_key) {
                if entry.config_fingerprint == config_fingerprint {
                    if entry.snapshot.status == McpRuntimeStatus::Ready {
                        return Ok(entry.snapshot.clone());
                    }
                    if matches!(
                        entry.snapshot.status,
                        McpRuntimeStatus::Connecting | McpRuntimeStatus::Reconnecting
                    ) {
                        return Err(McpRuntimeError::new(
                            "MCP_RUNTIME_CONNECT_IN_PROGRESS",
                            format!("Server '{}' is already connecting.", selector.server_id),
                        ));
                    }
                }
            }

            let generation = match state.entries.get(&logical_key) {
                Some(entry) if entry.config_fingerprint == config_fingerprint => {
                    entry.snapshot.key.config_generation
                }
                Some(entry) => entry
                    .snapshot
                    .key
                    .config_generation
                    .checked_add(1)
                    .ok_or_else(|| {
                        McpRuntimeError::new(
                            "MCP_RUNTIME_GENERATION_EXHAUSTED",
                            format!(
                                "Server '{}' exhausted its configuration generations.",
                                selector.server_id
                            ),
                        )
                    })?,
                None => 1,
            };
            key = McpRuntimeKey {
                server_id: selector.server_id.clone(),
                project_id: None,
                project_ids: selector.project_ids.clone(),
                config_generation: generation,
            };

            self.cancel_operations_for(&logical_key);
            let retired = state
                .entries
                .remove(&logical_key)
                .and_then(|entry| entry.session);
            state.entries.insert(
                logical_key.clone(),
                RuntimeEntry::connecting(key.clone(), config_fingerprint.clone()),
            );
            retired
        };

        if let Some(session) = retired_session {
            let _ = session.close().await;
        }

        let connection = self
            .connector
            .connect(&McpConnectionRequest {
                key: key.clone(),
                config_fingerprint: config_fingerprint.clone(),
            })
            .await;
        let _authority = match self.connector.acquire_authority().await {
            Ok(authority) => authority,
            Err(error) => {
                if let Ok(connection) = connection {
                    let _ = connection.session.close().await;
                }
                self.invalidate_if_current(&key, &error).await;
                return Err(error);
            }
        };
        let config_change_error = match self.connector.config_fingerprint(&selector).await {
            Ok(current) if current == config_fingerprint => None,
            Ok(_) => Some(McpRuntimeError::new(
                "MCP_RUNTIME_CONFIG_CHANGED",
                format!(
                    "MCP server '{}' changed while its connection was starting; retry the connection.",
                    selector.server_id
                ),
            )),
            Err(error) => Some(error),
        };
        if let Some(error) = config_change_error {
            if let Ok(connection) = connection {
                let _ = connection.session.close().await;
            }
            self.invalidate_if_current(&key, &error).await;
            return Err(error);
        }
        let mut state = self.state.lock().await;
        if self.shutting_down.load(Ordering::Acquire) {
            if let Ok(connection) = connection {
                drop(state);
                let _ = connection.session.close().await;
            }
            return Err(McpRuntimeError::new(
                "MCP_RUNTIME_SHUTTING_DOWN",
                "The MCP runtime shut down while the server was connecting.",
            ));
        }
        let Some(entry) = state.entries.get_mut(&logical_key) else {
            if let Ok(connection) = connection {
                drop(state);
                let _ = connection.session.close().await;
            }
            return Err(McpRuntimeError::new(
                STALE_GENERATION,
                "The runtime was disconnected while it was connecting.",
            ));
        };
        if entry.snapshot.key != key || entry.config_fingerprint != config_fingerprint {
            let current_generation = entry.snapshot.key.config_generation;
            if let Ok(connection) = connection {
                let session = connection.session;
                drop(state);
                let _ = session.close().await;
            }
            return Err(stale_generation_error(&key, current_generation));
        }
        if entry.snapshot.status != McpRuntimeStatus::Connecting {
            if let Ok(connection) = connection {
                let session = connection.session;
                drop(state);
                let _ = session.close().await;
            }
            return Err(McpRuntimeError::new(
                "MCP_RUNTIME_CONNECT_ABORTED",
                format!("Connection to server '{}' was aborted.", key.server_id),
            ));
        }

        match connection {
            Ok(connection) => {
                entry.snapshot.status = McpRuntimeStatus::Ready;
                entry.snapshot.requested_protocol_mode = connection.requested_protocol_mode;
                entry.snapshot.negotiated_era = connection.negotiated_era;
                entry.snapshot.negotiated_protocol_version = connection.negotiated_protocol_version;
                entry.snapshot.protocol_decision_reason = connection.protocol_decision_reason;
                entry.snapshot.last_error = None;
                entry.snapshot.updated_at = now();
                entry.concurrency = Arc::new(Semaphore::new(
                    connection.max_concurrent_operations.clamp(1, 16),
                ));
                entry.session = Some(connection.session);
                Ok(entry.snapshot.clone())
            }
            Err(error) => {
                entry.snapshot.status = McpRuntimeStatus::Failed;
                entry.snapshot.last_error = Some(error.to_string());
                entry.snapshot.updated_at = now();
                Err(error)
            }
        }
    }

    pub async fn disconnect(&self, key: &McpRuntimeKey) -> Result<(), McpRuntimeError> {
        validate_key(key)?;
        let logical_key = LogicalRuntimeKey::from(key);
        let session = {
            let mut state = self.state.lock().await;
            let current_key = state
                .entries
                .get(&logical_key)
                .map(|entry| entry.snapshot.key.clone())
                .ok_or_else(|| {
                    McpRuntimeError::new(
                        NOT_CONNECTED,
                        format!("Server '{}' is not connected.", key.server_id),
                    )
                })?;
            if current_key != *key {
                return Err(stale_generation_error(key, current_key.config_generation));
            }
            self.cancel_operations_for(&logical_key);
            let entry = state
                .entries
                .get_mut(&logical_key)
                .expect("validated MCP runtime entry must still exist while locked");
            let session = entry.session.take();
            entry.snapshot = McpRuntimeServerSnapshot {
                key: current_key,
                status: McpRuntimeStatus::Disconnected,
                requested_protocol_mode: None,
                negotiated_era: None,
                negotiated_protocol_version: None,
                protocol_decision_reason: None,
                last_error: None,
                updated_at: now(),
            };
            entry.catalog = None;
            session
        };
        if let Some(session) = session {
            session.close().await?;
        }
        Ok(())
    }

    pub async fn refresh_catalog(
        &self,
        key: &McpRuntimeKey,
    ) -> Result<McpCatalogDto, McpRuntimeError> {
        validate_key(key)?;
        let _authority = self.connector.acquire_authority().await?;
        self.ensure_current_config(key).await?;
        let logical_key = LogicalRuntimeKey::from(key);
        let (session, concurrency) = {
            let state = self.state.lock().await;
            let entry = state.entries.get(&logical_key).ok_or_else(|| {
                McpRuntimeError::new(
                    NOT_CONNECTED,
                    format!("Server '{}' is not connected.", key.server_id),
                )
            })?;
            reject_stale_generation(key, entry.snapshot.key.config_generation)?;
            if entry.snapshot.key.config_generation != key.config_generation
                || entry.snapshot.status != McpRuntimeStatus::Ready
            {
                return Err(McpRuntimeError::new(
                    NOT_CONNECTED,
                    format!("Server '{}' is not ready.", key.server_id),
                ));
            }
            (
                entry.session.clone().ok_or_else(|| {
                    McpRuntimeError::new(NOT_CONNECTED, "The MCP session is unavailable.")
                })?,
                entry.concurrency.clone(),
            )
        };

        let operation_id = Uuid::new_v4().to_string();
        let cancellation = Arc::new(McpOperationCancellation::default());
        let operation_guard = {
            self.operations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(
                    operation_id.clone(),
                    ActiveOperation {
                        key: key.clone(),
                        cancellation: cancellation.clone(),
                    },
                );
            ActiveOperationGuard {
                operation_id: operation_id.clone(),
                operations: self.operations.clone(),
            }
        };

        let permit = tokio::select! {
            permit = concurrency.acquire_owned() => permit.map_err(|_| {
                McpRuntimeError::new(NOT_CONNECTED, "The MCP runtime is shutting down.")
            }),
            _ = cancellation.cancelled() => Err(cancelled_error()),
        };

        let result = match permit {
            Ok(_permit) => {
                tokio::select! {
                    result = session.list_tools(cancellation.clone()) => result,
                    _ = cancellation.cancelled() => Err(cancelled_error()),
                }
            }
            Err(error) => Err(error),
        };

        drop(operation_guard);
        let tools = match result {
            Ok(tools) => tools,
            Err(error) => {
                if error.code != OPERATION_CANCELLED && session.is_closed() {
                    self.schedule_reconnect(key.clone(), error.to_string());
                }
                return Err(error);
            }
        };
        let mut state = self.state.lock().await;
        let refreshed_at = now();
        let catalog = McpCatalogDto {
            key: key.clone(),
            tools,
            refreshed_at: Some(refreshed_at),
        };
        let entry = state.entries.get_mut(&logical_key).ok_or_else(|| {
            McpRuntimeError::new(
                STALE_GENERATION,
                "The runtime changed while its catalog was refreshing.",
            )
        })?;
        if entry.snapshot.key != *key {
            return Err(stale_generation_error(
                key,
                entry.snapshot.key.config_generation,
            ));
        }
        if entry.snapshot.status != McpRuntimeStatus::Ready {
            return Err(McpRuntimeError::new(
                NOT_CONNECTED,
                format!(
                    "Server '{}' stopped being ready while its catalog was refreshing.",
                    key.server_id
                ),
            ));
        }
        entry.catalog = Some(catalog.clone());
        entry.snapshot.updated_at = now();
        Ok(catalog)
    }

    pub async fn call_tool(
        &self,
        key: &McpRuntimeKey,
        tool_name: &str,
        arguments: serde_json::Value,
        operation_id: String,
    ) -> Result<McpCallToolResponse, McpRuntimeError> {
        validate_key(key)?;
        let _authority = self.connector.acquire_authority().await?;
        self.ensure_current_config(key).await?;
        if tool_name.trim().is_empty() {
            return Err(McpRuntimeError::new(
                "MCP_RUNTIME_INVALID_TOOL",
                "MCP tool name cannot be empty.",
            ));
        }
        let logical_key = LogicalRuntimeKey::from(key);
        let (session, concurrency) = {
            let state = self.state.lock().await;
            let entry = state.entries.get(&logical_key).ok_or_else(|| {
                McpRuntimeError::new(
                    NOT_CONNECTED,
                    format!("Server '{}' is not connected.", key.server_id),
                )
            })?;
            reject_stale_generation(key, entry.snapshot.key.config_generation)?;
            if entry.snapshot.key != *key || entry.snapshot.status != McpRuntimeStatus::Ready {
                return Err(McpRuntimeError::new(
                    NOT_CONNECTED,
                    format!("Server '{}' is not ready.", key.server_id),
                ));
            }
            (
                entry.session.clone().ok_or_else(|| {
                    McpRuntimeError::new(NOT_CONNECTED, "The MCP session is unavailable.")
                })?,
                entry.concurrency.clone(),
            )
        };

        if operation_id.trim().is_empty() {
            return Err(McpRuntimeError::new(
                "MCP_RUNTIME_INVALID_OPERATION_ID",
                "MCP operation id cannot be empty.",
            ));
        }
        let cancellation = Arc::new(McpOperationCancellation::default());
        {
            let mut operations = self
                .operations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if operations.contains_key(&operation_id) {
                return Err(McpRuntimeError::new(
                    "MCP_RUNTIME_DUPLICATE_OPERATION_ID",
                    format!("MCP operation '{operation_id}' is already active."),
                ));
            }
            operations.insert(
                operation_id.clone(),
                ActiveOperation {
                    key: key.clone(),
                    cancellation: cancellation.clone(),
                },
            );
        }
        let _operation_guard = ActiveOperationGuard {
            operation_id,
            operations: self.operations.clone(),
        };

        let permit = tokio::select! {
            permit = concurrency.acquire_owned() => permit.map_err(|_| {
                McpRuntimeError::new(NOT_CONNECTED, "The MCP runtime is shutting down.")
            }),
            _ = cancellation.cancelled() => Err(cancelled_error()),
        }?;
        let result = tokio::select! {
            result = session.call_tool(tool_name, arguments, cancellation.clone()) => result,
            _ = cancellation.cancelled() => Err(cancelled_error()),
        };
        drop(permit);
        if let Err(error) = &result {
            if error.code != OPERATION_CANCELLED && session.is_closed() {
                self.schedule_reconnect(key.clone(), error.to_string());
            }
        }
        result
    }

    fn schedule_reconnect(&self, key: McpRuntimeKey, reason: String) {
        let runtime = self.clone();
        tokio::spawn(async move {
            runtime.reconnect_after_failure(&key, reason).await;
        });
    }

    async fn reconnect_after_failure(&self, key: &McpRuntimeKey, reason: String) {
        if self.shutting_down.load(Ordering::Acquire) {
            return;
        }
        let logical_key = LogicalRuntimeKey::from(key);
        let (retired, config_fingerprint) = {
            let mut state = self.state.lock().await;
            let Some(entry) = state.entries.get_mut(&logical_key) else {
                return;
            };
            if entry.snapshot.key != *key || entry.snapshot.status != McpRuntimeStatus::Ready {
                return;
            }
            entry.snapshot.status = McpRuntimeStatus::Reconnecting;
            entry.snapshot.last_error = Some(reason);
            entry.snapshot.updated_at = now();
            (entry.session.take(), entry.config_fingerprint.clone())
        };

        self.cancel_operations_for(&logical_key);
        if let Some(session) = retired {
            let _ = session.close().await;
        }
        let selector = McpRuntimeSelector {
            server_id: key.server_id.clone(),
            project_ids: key.project_ids.clone(),
        };
        let started = Instant::now();
        let reconnect_budget = Duration::from_secs(30);
        let mut last_error = "MCP reconnect did not run.".to_string();

        for attempt in 0..5usize {
            let delay = Duration::from_millis(500u64.saturating_mul(1u64 << attempt.min(3)));
            let Some(remaining) = reconnect_budget.checked_sub(started.elapsed()) else {
                break;
            };
            if tokio::time::timeout(remaining, tokio::time::sleep(delay))
                .await
                .is_err()
            {
                break;
            }
            if self.shutting_down.load(Ordering::Acquire) {
                return;
            }
            {
                let state = self.state.lock().await;
                let Some(entry) = state.entries.get(&logical_key) else {
                    return;
                };
                if entry.snapshot.key != *key
                    || entry.snapshot.status != McpRuntimeStatus::Reconnecting
                    || entry.config_fingerprint != config_fingerprint
                {
                    return;
                }
            }

            let current_fingerprint = match self.connector.acquire_authority().await {
                Ok(_authority) => self.connector.config_fingerprint(&selector).await,
                Err(error) => Err(error),
            };
            match current_fingerprint {
                Ok(current) if current == config_fingerprint => {}
                Ok(_) => {
                    let error = McpRuntimeError::new(
                        "MCP_RUNTIME_CONFIG_CHANGED",
                        format!("MCP server '{}' changed during reconnect.", key.server_id),
                    );
                    self.invalidate_if_current(key, &error).await;
                    return;
                }
                Err(error) => {
                    self.invalidate_if_current(key, &error).await;
                    return;
                }
            }

            let Some(remaining) = reconnect_budget.checked_sub(started.elapsed()) else {
                break;
            };
            let request = McpConnectionRequest {
                key: key.clone(),
                config_fingerprint: config_fingerprint.clone(),
            };
            let connection =
                match tokio::time::timeout(remaining, self.connector.connect(&request)).await {
                    Ok(result) => result,
                    Err(_) => {
                        last_error = "MCP reconnect exceeded its 30-second circuit budget.".into();
                        break;
                    }
                };
            match connection {
                Ok(connection) => {
                    let _authority = match self.connector.acquire_authority().await {
                        Ok(authority) => authority,
                        Err(error) => {
                            let _ = connection.session.close().await;
                            self.invalidate_if_current(key, &error).await;
                            return;
                        }
                    };
                    let config_change_error =
                        match self.connector.config_fingerprint(&selector).await {
                            Ok(current) if current == config_fingerprint => None,
                            Ok(_) => Some(McpRuntimeError::new(
                                "MCP_RUNTIME_CONFIG_CHANGED",
                                format!("MCP server '{}' changed during reconnect.", key.server_id),
                            )),
                            Err(error) => Some(error),
                        };
                    if let Some(error) = config_change_error {
                        let _ = connection.session.close().await;
                        self.invalidate_if_current(key, &error).await;
                        return;
                    }
                    let mut state = self.state.lock().await;
                    if self.shutting_down.load(Ordering::Acquire) {
                        drop(state);
                        let _ = connection.session.close().await;
                        return;
                    }
                    let Some(entry) = state.entries.get_mut(&logical_key) else {
                        drop(state);
                        let _ = connection.session.close().await;
                        return;
                    };
                    if entry.snapshot.key != *key
                        || entry.snapshot.status != McpRuntimeStatus::Reconnecting
                        || entry.config_fingerprint != config_fingerprint
                    {
                        drop(state);
                        let _ = connection.session.close().await;
                        return;
                    }
                    entry.snapshot.status = McpRuntimeStatus::Ready;
                    entry.snapshot.requested_protocol_mode = connection.requested_protocol_mode;
                    entry.snapshot.negotiated_era = connection.negotiated_era;
                    entry.snapshot.negotiated_protocol_version =
                        connection.negotiated_protocol_version;
                    entry.snapshot.protocol_decision_reason = connection.protocol_decision_reason;
                    entry.snapshot.last_error = None;
                    entry.snapshot.updated_at = now();
                    entry.concurrency = Arc::new(Semaphore::new(
                        connection.max_concurrent_operations.clamp(1, 16),
                    ));
                    entry.session = Some(connection.session);
                    return;
                }
                Err(error) => {
                    last_error = error.to_string();
                    let mut state = self.state.lock().await;
                    let Some(entry) = state.entries.get_mut(&logical_key) else {
                        return;
                    };
                    if entry.snapshot.key != *key
                        || entry.snapshot.status != McpRuntimeStatus::Reconnecting
                    {
                        return;
                    }
                    entry.snapshot.last_error = Some(last_error.clone());
                    entry.snapshot.updated_at = now();
                }
            }
        }

        let mut state = self.state.lock().await;
        if let Some(entry) = state.entries.get_mut(&logical_key) {
            if entry.snapshot.key == *key && entry.snapshot.status == McpRuntimeStatus::Reconnecting
            {
                entry.snapshot.status = McpRuntimeStatus::Failed;
                entry.snapshot.last_error = Some(format!(
                    "MCP reconnect circuit opened after repeated failures: {last_error}"
                ));
                entry.snapshot.updated_at = now();
            }
        }
    }

    pub async fn shutdown_all(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let sessions = {
            let mut state = self.state.lock().await;
            let keys = state.entries.keys().cloned().collect::<Vec<_>>();
            for key in &keys {
                self.cancel_operations_for(key);
            }
            state
                .entries
                .values_mut()
                .filter_map(|entry| {
                    entry.snapshot.status = McpRuntimeStatus::Disconnected;
                    entry.snapshot.last_error = None;
                    entry.snapshot.updated_at = now();
                    entry.catalog = None;
                    entry.session.take()
                })
                .collect::<Vec<_>>()
        };
        let results = futures::future::join_all(
            sessions
                .into_iter()
                .map(|session| async move { session.close().await }),
        )
        .await;
        for result in results {
            if let Err(error) = result {
                tracing::warn!(error = %error, "failed to close MCP runtime session");
            }
        }
    }

    pub async fn cancel_operation(&self, operation_id: &str) -> bool {
        let operations = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(operation) = operations.get(operation_id) else {
            return false;
        };
        operation.cancellation.cancel();
        true
    }

    async fn ensure_current_config(&self, key: &McpRuntimeKey) -> Result<(), McpRuntimeError> {
        let logical_key = LogicalRuntimeKey::from(key);
        let expected_fingerprint = {
            let state = self.state.lock().await;
            let entry = state.entries.get(&logical_key).ok_or_else(|| {
                McpRuntimeError::new(
                    NOT_CONNECTED,
                    format!("Server '{}' is not connected.", key.server_id),
                )
            })?;
            if entry.snapshot.key != *key {
                return Err(stale_generation_error(
                    key,
                    entry.snapshot.key.config_generation,
                ));
            }
            entry.config_fingerprint.clone()
        };
        let selector = McpRuntimeSelector {
            server_id: key.server_id.clone(),
            project_ids: if key.project_ids.is_empty() {
                key.project_id.iter().cloned().collect()
            } else {
                key.project_ids.clone()
            },
        };
        let current_fingerprint = match self.connector.config_fingerprint(&selector).await {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                self.invalidate_if_current(key, &error).await;
                return Err(error);
            }
        };
        if current_fingerprint != expected_fingerprint {
            let error = McpRuntimeError::new(
                "MCP_RUNTIME_CONFIG_CHANGED",
                format!(
                    "MCP server '{}' changed after this runtime key was issued; reconnect before calling it.",
                    key.server_id
                ),
            );
            self.invalidate_if_current(key, &error).await;
            return Err(error);
        }
        let state = self.state.lock().await;
        let entry = state.entries.get(&logical_key).ok_or_else(|| {
            McpRuntimeError::new(
                NOT_CONNECTED,
                format!("Server '{}' is not connected.", key.server_id),
            )
        })?;
        if entry.snapshot.key != *key || entry.config_fingerprint != expected_fingerprint {
            return Err(stale_generation_error(
                key,
                entry.snapshot.key.config_generation,
            ));
        }
        Ok(())
    }

    async fn invalidate_if_current(&self, key: &McpRuntimeKey, error: &McpRuntimeError) {
        let logical_key = LogicalRuntimeKey::from(key);
        let session = {
            let mut state = self.state.lock().await;
            let Some(entry) = state.entries.get_mut(&logical_key) else {
                return;
            };
            if entry.snapshot.key != *key {
                return;
            }
            self.cancel_operations_for(&logical_key);
            if let Some(next_generation) = entry.snapshot.key.config_generation.checked_add(1) {
                entry.snapshot.key.config_generation = next_generation;
            }
            entry.snapshot.status = McpRuntimeStatus::Failed;
            entry.snapshot.requested_protocol_mode = None;
            entry.snapshot.negotiated_era = None;
            entry.snapshot.negotiated_protocol_version = None;
            entry.snapshot.protocol_decision_reason = None;
            entry.snapshot.last_error = Some(error.to_string());
            entry.snapshot.updated_at = now();
            entry.config_fingerprint = "invalid".to_string();
            entry.catalog = None;
            entry.session.take()
        };
        if let Some(session) = session {
            let _ = session.close().await;
        }
    }

    pub async fn invalidate_server(&self, server_id: &str, reason: impl Into<String>) {
        let error = McpRuntimeError::new("MCP_RUNTIME_CONFIG_CHANGED", reason);
        let keys = {
            let state = self.state.lock().await;
            state
                .entries
                .values()
                .filter(|entry| entry.snapshot.key.server_id == server_id)
                .map(|entry| entry.snapshot.key.clone())
                .collect::<Vec<_>>()
        };
        for key in keys {
            self.invalidate_if_current(&key, &error).await;
        }
    }

    #[cfg(test)]
    async fn active_operation_ids(&self) -> Vec<String> {
        self.operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    fn cancel_operations_for(&self, logical_key: &LogicalRuntimeKey) {
        let operations = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for operation in operations.values() {
            if LogicalRuntimeKey::from(&operation.key) == *logical_key {
                operation.cancellation.cancel();
            }
        }
    }
}

struct ActiveOperationGuard {
    operation_id: String,
    operations: Arc<StdMutex<HashMap<String, ActiveOperation>>>,
}

impl Drop for ActiveOperationGuard {
    fn drop(&mut self) {
        self.operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.operation_id);
    }
}

fn validate_key(key: &McpRuntimeKey) -> Result<(), McpRuntimeError> {
    if !is_canonical_mcp_server_id(&key.server_id) {
        return Err(McpRuntimeError::new(
            "MCP_RUNTIME_INVALID_KEY",
            "MCP server id must be canonical.",
        ));
    }
    if key
        .project_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(McpRuntimeError::new(
            "MCP_RUNTIME_INVALID_KEY",
            "MCP project id cannot be empty.",
        ));
    }
    if key.project_id.is_some() && !key.project_ids.is_empty() {
        return Err(McpRuntimeError::new(
            "MCP_RUNTIME_INVALID_KEY",
            "MCP runtime key cannot contain both projectId and projectIds.",
        ));
    }
    if key
        .project_ids
        .iter()
        .any(|value| value.trim().is_empty() || value.trim() != value)
    {
        return Err(McpRuntimeError::new(
            "MCP_RUNTIME_INVALID_KEY",
            "MCP project ids cannot contain empty values or surrounding whitespace.",
        ));
    }
    let mut normalized = key.project_ids.clone();
    normalized.sort();
    normalized.dedup();
    if normalized != key.project_ids {
        return Err(McpRuntimeError::new(
            "MCP_RUNTIME_INVALID_KEY",
            "MCP project ids must be sorted and unique.",
        ));
    }
    Ok(())
}

fn validate_selector(selector: &McpRuntimeSelector) -> Result<(), McpRuntimeError> {
    if !is_canonical_mcp_server_id(&selector.server_id) {
        return Err(McpRuntimeError::new(
            "MCP_RUNTIME_INVALID_KEY",
            "MCP server id must be canonical.",
        ));
    }
    if selector
        .project_ids
        .iter()
        .any(|value| value.trim().is_empty() || value.trim() != value)
    {
        return Err(McpRuntimeError::new(
            "MCP_RUNTIME_INVALID_KEY",
            "MCP project ids cannot contain empty values or surrounding whitespace.",
        ));
    }
    let mut normalized = selector.project_ids.clone();
    normalized.sort();
    normalized.dedup();
    if normalized != selector.project_ids {
        return Err(McpRuntimeError::new(
            "MCP_RUNTIME_INVALID_KEY",
            "MCP project ids must be sorted and unique.",
        ));
    }
    Ok(())
}

fn reject_stale_generation(
    requested: &McpRuntimeKey,
    current_generation: u32,
) -> Result<(), McpRuntimeError> {
    if requested.config_generation != current_generation {
        return Err(stale_generation_error(requested, current_generation));
    }
    Ok(())
}

fn stale_generation_error(requested: &McpRuntimeKey, current_generation: u32) -> McpRuntimeError {
    McpRuntimeError::new(
        STALE_GENERATION,
        format!(
            "Server '{}' requested configuration generation {}, but generation {} is current.",
            requested.server_id, requested.config_generation, current_generation
        ),
    )
}

fn cancelled_error() -> McpRuntimeError {
    McpRuntimeError::new(OPERATION_CANCELLED, "The MCP operation was cancelled.")
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct FakeSession {
        list_calls: AtomicUsize,
        close_calls: AtomicUsize,
        block_lists: AtomicBool,
        fail_lists: AtomicBool,
        closed: AtomicBool,
        list_started: Notify,
    }

    impl McpSession for FakeSession {
        fn is_closed(&self) -> bool {
            self.closed.load(Ordering::SeqCst)
        }

        fn list_tools<'a>(
            &'a self,
            cancellation: Arc<McpOperationCancellation>,
        ) -> McpFuture<'a, Vec<McpToolDto>> {
            Box::pin(async move {
                self.list_calls.fetch_add(1, Ordering::SeqCst);
                self.list_started.notify_one();
                if self.fail_lists.load(Ordering::SeqCst) {
                    return Err(McpRuntimeError::new(
                        "MCP_RUNTIME_TEST_TRANSPORT_CLOSED",
                        "test transport closed",
                    ));
                }
                if self.block_lists.load(Ordering::SeqCst) {
                    cancellation.cancelled().await;
                    return Err(cancelled_error());
                }
                Ok(vec![McpToolDto {
                    id: "mcp__test__echo".into(),
                    server_id: "test".into(),
                    name: "echo".into(),
                    description: Some("Echo input".into()),
                    input_schema: serde_json::json!({"type": "object"}),
                    enabled: true,
                }])
            })
        }

        fn call_tool<'a>(
            &'a self,
            tool_name: &'a str,
            arguments: serde_json::Value,
            _cancellation: Arc<McpOperationCancellation>,
        ) -> McpFuture<'a, McpCallToolResponse> {
            Box::pin(async move {
                Ok(McpCallToolResponse {
                    content: format!("{tool_name}:{arguments}"),
                    is_error: false,
                    raw_result: serde_json::json!({"ok": true}),
                })
            })
        }

        fn close<'a>(&'a self) -> McpFuture<'a, ()> {
            Box::pin(async move {
                self.close_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    struct FakeConnector {
        session: Arc<FakeSession>,
        authority: Option<Arc<tokio::sync::RwLock<()>>>,
        connect_calls: AtomicUsize,
        max_concurrent_operations: usize,
        fingerprint: StdMutex<String>,
        fingerprint_error: AtomicBool,
        connect_failures: AtomicUsize,
        block_connect: AtomicBool,
        connect_started: Notify,
        connect_release: Notify,
    }

    impl McpConnector for FakeConnector {
        fn acquire_authority<'a>(&'a self) -> McpFuture<'a, Option<McpAuthorityGuard>> {
            let authority = self.authority.clone();
            Box::pin(async move {
                match authority {
                    Some(authority) => Ok(Some(
                        Box::new(authority.read_owned().await) as McpAuthorityGuard
                    )),
                    None => Ok(None),
                }
            })
        }

        fn config_fingerprint<'a>(
            &'a self,
            _selector: &'a McpRuntimeSelector,
        ) -> McpFuture<'a, String> {
            if self.fingerprint_error.load(Ordering::SeqCst) {
                return Box::pin(async {
                    Err(McpRuntimeError::new(
                        "MCP_RUNTIME_CONFIG_INVALID",
                        "test configuration became invalid",
                    ))
                });
            }
            let fingerprint = self
                .fingerprint
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            Box::pin(async move { Ok(fingerprint) })
        }

        fn connect<'a>(
            &'a self,
            request: &'a McpConnectionRequest,
        ) -> McpFuture<'a, McpConnectedSession> {
            self.connect_calls.fetch_add(1, Ordering::SeqCst);
            self.session.closed.store(false, Ordering::SeqCst);
            Box::pin(async move {
                assert_eq!(request.key.server_id, "test");
                if self.block_connect.load(Ordering::SeqCst) {
                    self.connect_started.notify_one();
                    self.connect_release.notified().await;
                }
                if self
                    .connect_failures
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                        remaining.checked_sub(1)
                    })
                    .is_ok()
                {
                    return Err(McpRuntimeError::new(
                        "MCP_RUNTIME_TEST_CONNECT_FAILED",
                        "test reconnect failed",
                    ));
                }
                Ok(McpConnectedSession {
                    session: self.session.clone(),
                    requested_protocol_mode: Some(McpProtocolMode::Auto),
                    negotiated_era: Some(McpProtocolEra::Legacy),
                    negotiated_protocol_version: Some("2025-11-25".into()),
                    protocol_decision_reason: Some("fake connector".into()),
                    max_concurrent_operations: self.max_concurrent_operations,
                })
            })
        }
    }

    fn selector() -> McpRuntimeSelector {
        McpRuntimeSelector {
            server_id: "test".into(),
            project_ids: vec!["project-1".into()],
        }
    }

    async fn connected_key(manager: &McpRuntimeManager) -> McpRuntimeKey {
        manager.connect(selector()).await.unwrap().key
    }

    fn manager(session: Arc<FakeSession>) -> (Arc<McpRuntimeManager>, Arc<FakeConnector>) {
        let connector = Arc::new(FakeConnector {
            session,
            authority: None,
            connect_calls: AtomicUsize::new(0),
            max_concurrent_operations: 1,
            fingerprint: StdMutex::new("fingerprint-1".into()),
            fingerprint_error: AtomicBool::new(false),
            connect_failures: AtomicUsize::new(0),
            block_connect: AtomicBool::new(false),
            connect_started: Notify::new(),
            connect_release: Notify::new(),
        });
        (
            Arc::new(McpRuntimeManager::with_connector(connector.clone())),
            connector,
        )
    }

    async fn wait_for_ready_reconnect(
        manager: &McpRuntimeManager,
        connector: &FakeConnector,
        minimum_connect_calls: usize,
    ) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let ready = manager
                    .snapshot()
                    .await
                    .servers
                    .first()
                    .is_some_and(|server| server.status == McpRuntimeStatus::Ready);
                if ready && connector.connect_calls.load(Ordering::SeqCst) >= minimum_connect_calls
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the background reconnect should complete");
    }

    #[tokio::test]
    async fn reuses_a_ready_session_and_catalog() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());

        let first = manager.connect(selector()).await.unwrap();
        let second = manager.connect(selector()).await.unwrap();
        let catalog = manager.refresh_catalog(&first.key).await.unwrap();

        assert_eq!(first.status, McpRuntimeStatus::Ready);
        assert_eq!(second.negotiated_era, Some(McpProtocolEra::Legacy));
        assert_eq!(catalog.tools.len(), 1);
        assert_eq!(connector.connect_calls.load(Ordering::SeqCst), 1);
        assert_eq!(session.list_calls.load(Ordering::SeqCst), 1);
        assert_eq!(manager.snapshot().await.servers.len(), 1);
    }

    #[tokio::test]
    async fn calls_a_tool_on_the_connected_session() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session);
        let key = connected_key(&manager).await;

        let result = manager
            .call_tool(
                &key,
                "echo",
                serde_json::json!({"value": "ok"}),
                "operation-call-1".into(),
            )
            .await
            .unwrap();

        assert_eq!(result.content, "echo:{\"value\":\"ok\"}");
        assert_eq!(connector.connect_calls.load(Ordering::SeqCst), 1);
        assert!(manager.active_operation_ids().await.is_empty());
    }

    #[tokio::test]
    async fn reconnects_after_a_closed_transport_without_retrying_the_operation() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());
        let key = connected_key(&manager).await;
        session.fail_lists.store(true, Ordering::SeqCst);
        session.closed.store(true, Ordering::SeqCst);

        let error = manager.refresh_catalog(&key).await.unwrap_err();

        assert_eq!(error.code, "MCP_RUNTIME_TEST_TRANSPORT_CLOSED");
        assert_eq!(session.list_calls.load(Ordering::SeqCst), 1);
        wait_for_ready_reconnect(&manager, &connector, 2).await;
        assert_eq!(connector.connect_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            manager.snapshot().await.servers[0].status,
            McpRuntimeStatus::Ready
        );
    }

    #[tokio::test]
    async fn assigns_monotone_generations_and_retires_changed_configuration() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());

        let first = manager.connect(selector()).await.unwrap();
        *connector
            .fingerprint
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = "fingerprint-2".into();
        let second = manager.connect(selector()).await.unwrap();

        assert_eq!(connector.connect_calls.load(Ordering::SeqCst), 2);
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.key.config_generation, 1);
        assert_eq!(second.key.config_generation, 2);
        assert_eq!(
            manager.refresh_catalog(&first.key).await.unwrap_err().code,
            STALE_GENERATION
        );
    }

    #[tokio::test]
    async fn invalid_configuration_revokes_the_previous_key_and_session() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());
        let key = connected_key(&manager).await;
        connector.fingerprint_error.store(true, Ordering::SeqCst);

        let error = manager
            .call_tool(
                &key,
                "echo",
                serde_json::json!({}),
                "invalid-config-call".into(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, "MCP_RUNTIME_CONFIG_INVALID");
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);
        let snapshot = manager.snapshot().await.servers.remove(0);
        assert_eq!(snapshot.status, McpRuntimeStatus::Failed);
        assert_eq!(snapshot.key.config_generation, 2);
        assert_eq!(
            manager.disconnect(&key).await.unwrap_err().code,
            STALE_GENERATION
        );
    }

    #[tokio::test]
    async fn stale_disconnect_cannot_close_a_new_generation() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());
        let first = manager.connect(selector()).await.unwrap();
        *connector
            .fingerprint
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = "fingerprint-2".into();
        let second = manager.connect(selector()).await.unwrap();
        session.block_lists.store(true, Ordering::SeqCst);
        let refresh_manager = manager.clone();
        let refresh_key = second.key.clone();
        let refresh =
            tokio::spawn(async move { refresh_manager.refresh_catalog(&refresh_key).await });
        session.list_started.notified().await;

        assert_eq!(
            manager.disconnect(&first.key).await.unwrap_err().code,
            STALE_GENERATION
        );
        assert!(!refresh.is_finished());
        assert_eq!(
            manager.snapshot().await.servers[0].status,
            McpRuntimeStatus::Ready
        );
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);
        manager.disconnect(&second.key).await.unwrap();
        assert_eq!(
            refresh.await.unwrap().unwrap_err().code,
            OPERATION_CANCELLED
        );
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn configuration_change_during_connect_never_becomes_ready() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());
        connector.block_connect.store(true, Ordering::SeqCst);
        let connect_manager = manager.clone();
        let connect = tokio::spawn(async move { connect_manager.connect(selector()).await });
        connector.connect_started.notified().await;
        *connector
            .fingerprint
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = "fingerprint-2".into();
        connector.connect_release.notify_one();

        assert_eq!(
            connect.await.unwrap().unwrap_err().code,
            "MCP_RUNTIME_CONFIG_CHANGED"
        );
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            manager.snapshot().await.servers[0].status,
            McpRuntimeStatus::Failed
        );
    }

    #[tokio::test]
    async fn reconnect_retries_transient_failures_without_replaying_the_operation() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());
        let key = connected_key(&manager).await;
        connector.connect_failures.store(2, Ordering::SeqCst);
        session.fail_lists.store(true, Ordering::SeqCst);
        session.closed.store(true, Ordering::SeqCst);

        let error = manager.refresh_catalog(&key).await.unwrap_err();

        assert_eq!(error.code, "MCP_RUNTIME_TEST_TRANSPORT_CLOSED");
        assert_eq!(session.list_calls.load(Ordering::SeqCst), 1);
        wait_for_ready_reconnect(&manager, &connector, 4).await;
        assert_eq!(connector.connect_calls.load(Ordering::SeqCst), 4);
        assert_eq!(
            manager.snapshot().await.servers[0].status,
            McpRuntimeStatus::Ready
        );
    }

    #[tokio::test]
    async fn disconnect_cancels_an_active_operation_and_closes_the_session() {
        let session = Arc::new(FakeSession::default());
        session.block_lists.store(true, Ordering::SeqCst);
        let (manager, _) = manager(session.clone());
        let key = connected_key(&manager).await;

        let refresh_manager = manager.clone();
        let refresh_key = key.clone();
        let refresh =
            tokio::spawn(async move { refresh_manager.refresh_catalog(&refresh_key).await });
        session.list_started.notified().await;
        manager.disconnect(&key).await.unwrap();

        let error = refresh.await.unwrap().unwrap_err();
        assert_eq!(error.code, OPERATION_CANCELLED);
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            manager.snapshot().await.servers[0].status,
            McpRuntimeStatus::Disconnected
        );
    }

    #[tokio::test]
    async fn authority_writer_waits_for_an_active_runtime_operation() {
        let session = Arc::new(FakeSession::default());
        session.block_lists.store(true, Ordering::SeqCst);
        let authority = Arc::new(tokio::sync::RwLock::new(()));
        let connector = Arc::new(FakeConnector {
            session: session.clone(),
            authority: Some(authority.clone()),
            connect_calls: AtomicUsize::new(0),
            max_concurrent_operations: 1,
            fingerprint: StdMutex::new("fingerprint-1".into()),
            fingerprint_error: AtomicBool::new(false),
            connect_failures: AtomicUsize::new(0),
            block_connect: AtomicBool::new(false),
            connect_started: Notify::new(),
            connect_release: Notify::new(),
        });
        let manager = Arc::new(McpRuntimeManager::with_connector(connector));
        let key = connected_key(&manager).await;

        let refresh_manager = manager.clone();
        let refresh_key = key.clone();
        let refresh =
            tokio::spawn(async move { refresh_manager.refresh_catalog(&refresh_key).await });
        session.list_started.notified().await;
        assert!(authority.try_write().is_err());

        let writer_acquired = Arc::new(AtomicBool::new(false));
        let writer_flag = writer_acquired.clone();
        let writer = tokio::spawn(async move {
            let _guard = authority.write_owned().await;
            writer_flag.store(true, Ordering::SeqCst);
        });
        manager.disconnect(&key).await.unwrap();
        assert_eq!(
            refresh.await.unwrap().unwrap_err().code,
            OPERATION_CANCELLED
        );
        writer.await.unwrap();
        assert!(writer_acquired.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancels_an_operation_by_id() {
        let session = Arc::new(FakeSession::default());
        session.block_lists.store(true, Ordering::SeqCst);
        let (manager, _) = manager(session.clone());
        let key = connected_key(&manager).await;

        let refresh_manager = manager.clone();
        let refresh = tokio::spawn(async move { refresh_manager.refresh_catalog(&key).await });
        session.list_started.notified().await;
        let operation_id = manager.active_operation_ids().await.pop().unwrap();

        assert!(manager.cancel_operation(&operation_id).await);
        assert!(!manager.cancel_operation("missing").await);
        assert_eq!(
            refresh.await.unwrap().unwrap_err().code,
            OPERATION_CANCELLED
        );
    }

    #[tokio::test]
    async fn bounds_concurrent_operations_per_session() {
        let session = Arc::new(FakeSession::default());
        session.block_lists.store(true, Ordering::SeqCst);
        let (manager, _) = manager(session.clone());
        let key = connected_key(&manager).await;

        let first_manager = manager.clone();
        let first_key = key.clone();
        let first = tokio::spawn(async move { first_manager.refresh_catalog(&first_key).await });
        let second_manager = manager.clone();
        let second_key = key.clone();
        let second = tokio::spawn(async move { second_manager.refresh_catalog(&second_key).await });
        session.list_started.notified().await;
        for _ in 0..20 {
            if manager.active_operation_ids().await.len() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(manager.active_operation_ids().await.len(), 2);
        assert_eq!(session.list_calls.load(Ordering::SeqCst), 1);
        manager.disconnect(&key).await.unwrap();
        assert_eq!(first.await.unwrap().unwrap_err().code, OPERATION_CANCELLED);
        assert_eq!(second.await.unwrap().unwrap_err().code, OPERATION_CANCELLED);
    }

    #[tokio::test]
    async fn removes_an_operation_when_its_task_is_aborted() {
        let session = Arc::new(FakeSession::default());
        session.block_lists.store(true, Ordering::SeqCst);
        let (manager, _) = manager(session.clone());
        let key = connected_key(&manager).await;

        let refresh_manager = manager.clone();
        let refresh = tokio::spawn(async move { refresh_manager.refresh_catalog(&key).await });
        session.list_started.notified().await;
        assert_eq!(manager.active_operation_ids().await.len(), 1);

        refresh.abort();
        assert!(refresh.await.unwrap_err().is_cancelled());
        assert!(manager.active_operation_ids().await.is_empty());
    }

    #[tokio::test]
    async fn shutdown_cancels_operations_closes_sessions_and_blocks_reconnects() {
        let session = Arc::new(FakeSession::default());
        session.block_lists.store(true, Ordering::SeqCst);
        let (manager, connector) = manager(session.clone());
        let key = connected_key(&manager).await;

        let refresh_manager = manager.clone();
        let refresh = tokio::spawn(async move { refresh_manager.refresh_catalog(&key).await });
        session.list_started.notified().await;
        manager.shutdown_all().await;

        assert_eq!(
            refresh.await.unwrap().unwrap_err().code,
            OPERATION_CANCELLED
        );
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(connector.connect_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            manager.connect(selector()).await.unwrap_err().code,
            "MCP_RUNTIME_SHUTTING_DOWN"
        );
        assert_eq!(
            manager.snapshot().await.servers[0].status,
            McpRuntimeStatus::Disconnected
        );
    }

    #[tokio::test]
    async fn the_default_connector_reports_a_stable_error() {
        let manager = McpRuntimeManager::default();
        let error = manager.connect(selector()).await.unwrap_err();
        let snapshot = manager.snapshot().await;

        assert_eq!(error.code, CONNECTOR_UNAVAILABLE);
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "code": "MCP_RUNTIME_CONNECTOR_UNAVAILABLE",
                "message": "No persistent MCP connector is installed."
            })
        );
        assert_eq!(snapshot.servers[0].status, McpRuntimeStatus::Failed);
        assert!(snapshot.servers[0]
            .last_error
            .as_deref()
            .unwrap()
            .starts_with(CONNECTOR_UNAVAILABLE));
    }
}
