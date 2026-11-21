use super::ids::is_canonical_mcp_server_id;
use super::interaction::McpInteractionBroker;
use super::types::{
    McpCallToolResponse, McpCatalogDto, McpProtocolEra, McpProtocolMode, McpRuntimeKey,
    McpRuntimeSelector, McpRuntimeServerSnapshot, McpRuntimeSnapshotDto, McpRuntimeStatus,
    McpToolDto,
};
use chrono::Utc;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
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
const PENDING_CANCELLATION_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING_CANCELLATIONS: usize = 1_024;
const CONFIGURATION_CLOSE_BUDGET: Duration = Duration::from_secs(15);

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

#[derive(Default)]
pub struct McpOperationCancellation {
    native: Option<tokio_util::sync::CancellationToken>,
    cancelled: AtomicBool,
    notify: Notify,
    interaction: StdMutex<Option<McpInteractionContext>>,
}

#[derive(Clone)]
pub(crate) struct McpInteractionContext {
    pub key: McpRuntimeKey,
    pub operation_id: String,
    pub broker: McpInteractionBroker,
}

impl fmt::Debug for McpOperationCancellation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpOperationCancellation")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl McpOperationCancellation {
    pub(crate) fn attach_interaction(&self, context: McpInteractionContext) {
        *self
            .interaction
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(context);
    }

    pub(crate) fn interaction(&self) -> Option<McpInteractionContext> {
        self.interaction
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
            || self
                .native
                .as_ref()
                .is_some_and(|token| token.is_cancelled())
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            if let Some(native) = &self.native {
                tokio::select! { _ = notified => {}, _ = native.cancelled() => return }
            } else {
                notified.await;
            }
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
    fn configuration_changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        None
    }

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
    connect_attempt_id: Uuid,
    connection_cancellation: Arc<McpOperationCancellation>,
}

impl RuntimeEntry {
    fn connecting(
        key: McpRuntimeKey,
        config_fingerprint: String,
        connect_attempt_id: Uuid,
    ) -> Self {
        Self {
            snapshot: McpRuntimeServerSnapshot {
                key,
                status: McpRuntimeStatus::Connecting,
                requested_protocol_mode: None,
                negotiated_era: None,
                negotiated_protocol_version: None,
                protocol_decision_reason: None,
                last_error_code: None,
                last_error: None,
                updated_at: now(),
            },
            config_fingerprint,
            session: None,
            catalog: None,
            concurrency: Arc::new(Semaphore::new(1)),
            connect_attempt_id,
            connection_cancellation: Arc::new(McpOperationCancellation::default()),
        }
    }
}

struct ActiveOperation {
    key: McpRuntimeKey,
    cancellation: Arc<McpOperationCancellation>,
}

#[derive(Default)]
struct OperationRegistry {
    active: HashMap<String, ActiveOperation>,
    pending_cancellations: VecDeque<(String, Instant)>,
}

impl OperationRegistry {
    fn prune_pending(&mut self, now: Instant) {
        while self
            .pending_cancellations
            .front()
            .is_some_and(|(_, created_at)| {
                now.duration_since(*created_at) >= PENDING_CANCELLATION_TTL
            })
        {
            self.pending_cancellations.pop_front();
        }
    }

    fn take_pending_cancellation(&mut self, operation_id: &str) -> bool {
        self.prune_pending(Instant::now());
        let Some(index) = self
            .pending_cancellations
            .iter()
            .position(|(pending_id, _)| pending_id == operation_id)
        else {
            return false;
        };
        self.pending_cancellations.remove(index);
        true
    }

    fn remember_pending_cancellation(&mut self, operation_id: &str) {
        let now = Instant::now();
        self.prune_pending(now);
        if self
            .pending_cancellations
            .iter()
            .any(|(pending_id, _)| pending_id == operation_id)
        {
            return;
        }
        while self.pending_cancellations.len() >= MAX_PENDING_CANCELLATIONS {
            self.pending_cancellations.pop_front();
        }
        self.pending_cancellations
            .push_back((operation_id.to_string(), now));
    }
}

#[derive(Default)]
struct RuntimeState {
    entries: HashMap<LogicalRuntimeKey, RuntimeEntry>,
}

#[derive(Clone)]
pub struct McpRuntimeManager {
    connector: Arc<dyn McpConnector>,
    state: Arc<Mutex<RuntimeState>>,
    operations: Arc<StdMutex<OperationRegistry>>,
    interaction: McpInteractionBroker,
    shutting_down: Arc<AtomicBool>,
    configuration_observer_started: Arc<AtomicBool>,
    configuration_observer_stop: Arc<Notify>,
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
            operations: Arc::new(StdMutex::new(OperationRegistry::default())),
            interaction: McpInteractionBroker::default(),
            shutting_down: Arc::new(AtomicBool::new(false)),
            configuration_observer_started: Arc::new(AtomicBool::new(false)),
            configuration_observer_stop: Arc::new(Notify::new()),
        }
    }

    fn observe_configuration_changes(&self) {
        let Some(mut changes) = self.connector.configuration_changes() else {
            return;
        };
        if self
            .configuration_observer_started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let state = Arc::downgrade(&self.state);
        let operations = Arc::downgrade(&self.operations);
        let connector = self.connector.clone();
        let interaction = self.interaction.clone();
        let shutting_down = self.shutting_down.clone();
        let started = self.configuration_observer_started.clone();
        let stop = self.configuration_observer_stop.clone();
        tokio::spawn(async move {
            loop {
                let notified = stop.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if shutting_down.load(Ordering::Acquire) {
                    break;
                }
                tokio::select! {
                    _ = &mut notified => break,
                    result = changes.changed() => if result.is_err() { break; },
                }
                let (Some(state), Some(operations)) = (state.upgrade(), operations.upgrade())
                else {
                    break;
                };
                let runtime = Self {
                    connector: connector.clone(),
                    state,
                    operations,
                    interaction: interaction.clone(),
                    shutting_down: shutting_down.clone(),
                    configuration_observer_started: started.clone(),
                    configuration_observer_stop: stop.clone(),
                };
                runtime.reconcile_configuration().await;
            }
        });
    }

    async fn reconcile_configuration(&self) {
        // Check all scopes against effective native configuration. Unchanged
        // fingerprints retain their generations, catalogs and conversation leases.
        let keys = {
            let state = self.state.lock().await;
            state
                .entries
                .values()
                .filter(|entry| {
                    entry.config_fingerprint != "invalid"
                        && entry.snapshot.status != McpRuntimeStatus::Disconnected
                })
                .map(|entry| entry.snapshot.key.clone())
                .collect::<Vec<_>>()
        };
        futures::future::join_all(keys.iter().map(|key| async move {
            match self.connector.acquire_authority().await {
                Ok(_authority) => {
                    let _ = crate::secrets::blocking::with_guard(
                        _authority,
                        self.ensure_current_config(key),
                    )
                    .await;
                }
                Err(error) => self.invalidate_if_current(key, &error).await,
            }
        }))
        .await;
    }

    pub(crate) fn interaction_broker(&self) -> &McpInteractionBroker {
        &self.interaction
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
        self.observe_configuration_changes();
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
            let _authority = Arc::new(_authority);
            crate::secrets::blocking::with_guard(
                _authority.clone(),
                self.connector.config_fingerprint(&selector),
            )
            .await
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
        let connect_attempt_id = Uuid::new_v4();
        let (retired_session, connection_cancellation) = {
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
                RuntimeEntry::connecting(
                    key.clone(),
                    config_fingerprint.clone(),
                    connect_attempt_id,
                ),
            );
            let cancellation = state
                .entries
                .get(&logical_key)
                .expect("inserted runtime entry")
                .connection_cancellation
                .clone();
            (retired, cancellation)
        };

        if let Some(session) = retired_session {
            let _ = session.close().await;
        }

        let request = McpConnectionRequest {
            key: key.clone(),
            config_fingerprint: config_fingerprint.clone(),
        };
        let connection = tokio::select! {
            result = self.connector.connect(&request) => result,
            _ = connection_cancellation.cancelled() => Err(McpRuntimeError::new(
                "MCP_RUNTIME_CONNECT_ABORTED", "The MCP connection was invalidated while starting.")),
        };
        let _authority = match self.connector.acquire_authority().await {
            Ok(authority) => authority,
            Err(error) => {
                if let Ok(connection) = connection {
                    let _ = connection.session.close().await;
                }
                self.invalidate_connect_attempt_if_current(&key, connect_attempt_id, &error)
                    .await;
                return Err(error);
            }
        };
        let _authority = Arc::new(_authority);
        let config_change_error = match crate::secrets::blocking::with_guard(_authority.clone(), self.connector.config_fingerprint(&selector)).await {
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
            self.invalidate_connect_attempt_if_current(&key, connect_attempt_id, &error)
                .await;
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
        if entry.connect_attempt_id != connect_attempt_id {
            if let Ok(connection) = connection {
                let session = connection.session;
                drop(state);
                let _ = session.close().await;
            }
            return Err(McpRuntimeError::new(
                "MCP_RUNTIME_CONNECT_ABORTED",
                format!("Connection to server '{}' was superseded.", key.server_id),
            ));
        }
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
                entry.snapshot.last_error_code = None;
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
                entry.snapshot.last_error_code = Some(error.code.to_string());
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
                last_error_code: None,
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
        let _authority = Arc::new(_authority);
        crate::secrets::blocking::with_guard(_authority.clone(), self.ensure_current_config(key))
            .await?;
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
                .active
                .insert(
                    operation_id.clone(),
                    ActiveOperation {
                        key: key.clone(),
                        cancellation: cancellation.clone(),
                    },
                );
            ActiveOperationGuard {
                cancellation_on_return: None,
                operation_id,
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
                    result = crate::secrets::blocking::with_guard(_authority.clone(), session.list_tools(cancellation.clone())) => result,
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
                    self.schedule_reconnect(key.clone(), error.clone());
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
        self.call_tool_owned(key, tool_name, arguments, operation_id, None, None)
            .await
    }

    pub(crate) async fn call_tool_owned(
        &self,
        key: &McpRuntimeKey,
        tool_name: &str,
        arguments: serde_json::Value,
        operation_id: String,
        chat_work: Option<Arc<crate::db::chat_admission::OperationPermit>>,
        native_cancel: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<McpCallToolResponse, McpRuntimeError> {
        validate_key(key)?;
        if operation_id.trim().is_empty() {
            return Err(McpRuntimeError::new(
                "MCP_RUNTIME_INVALID_OPERATION_ID",
                "MCP operation id cannot be empty.",
            ));
        }
        let cancellation = Arc::new(McpOperationCancellation {
            native: native_cancel,
            ..Default::default()
        });
        {
            let mut operations = self
                .operations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if operations.active.contains_key(&operation_id) {
                return Err(McpRuntimeError::new(
                    "MCP_RUNTIME_DUPLICATE_OPERATION_ID",
                    format!("MCP operation '{operation_id}' is already active."),
                ));
            }
            if operations.take_pending_cancellation(&operation_id) {
                cancellation.cancel();
            }
            operations.active.insert(
                operation_id.clone(),
                ActiveOperation {
                    key: key.clone(),
                    cancellation: cancellation.clone(),
                },
            );
        }
        let _operation_guard = ActiveOperationGuard {
            operation_id: operation_id.clone(),
            operations: self.operations.clone(),
            cancellation_on_return: chat_work.as_ref().map(|_| cancellation.clone()),
        };

        let _authority = tokio::select! {
            authority = self.connector.acquire_authority() => authority,
            _ = cancellation.cancelled() => Err(cancelled_error()),
        }?;
        let _authority = Arc::new(_authority);
        tokio::select! {
            result = crate::secrets::blocking::with_guard(_authority.clone(), self.ensure_current_config(key)) => result,
            _ = cancellation.cancelled() => Err(cancelled_error()),
        }?;
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
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

        cancellation.attach_interaction(McpInteractionContext {
            key: key.clone(),
            operation_id: operation_id.clone(),
            broker: self.interaction.clone(),
        });
        let permit = tokio::select! {
            permit = concurrency.acquire_owned() => permit.map_err(|_| {
                McpRuntimeError::new(NOT_CONNECTED, "The MCP runtime is shutting down.")
            }),
            _ = cancellation.cancelled() => Err(cancelled_error()),
        }?;
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        let result = crate::secrets::blocking::with_guard(
            _authority.clone(),
            session.call_tool(tool_name, arguments, cancellation.clone()),
        )
        .await;
        drop(permit);
        if let Err(error) = &result {
            if error.code != OPERATION_CANCELLED && session.is_closed() {
                if chat_work.is_some() {
                    self.reconnect_after_failure(key, error.clone()).await;
                } else {
                    self.schedule_reconnect(key.clone(), error.clone());
                }
            }
        }
        result
    }

    fn schedule_reconnect(&self, key: McpRuntimeKey, reason: McpRuntimeError) {
        let runtime = self.clone();
        tokio::spawn(async move {
            runtime.reconnect_after_failure(&key, reason).await;
        });
    }

    async fn reconnect_after_failure(&self, key: &McpRuntimeKey, reason: McpRuntimeError) {
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
            entry.snapshot.last_error_code = Some(reason.code.to_string());
            entry.snapshot.last_error = Some(reason.to_string());
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
        let mut last_error_code = "MCP_RUNTIME_RECONNECT_FAILED".to_string();

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
                Ok(_authority) => {
                    crate::secrets::blocking::with_guard(
                        _authority,
                        self.connector.config_fingerprint(&selector),
                    )
                    .await
                }
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
            let cancellation = {
                let state = self.state.lock().await;
                let Some(entry) = state.entries.get(&logical_key) else {
                    return;
                };
                entry.connection_cancellation.clone()
            };
            let connection =
                match tokio::time::timeout(remaining, async {
                    tokio::select! {
                        result = self.connector.connect(&request) => result,
                        _ = cancellation.cancelled() => Err(McpRuntimeError::new(
                            "MCP_RUNTIME_CONNECT_ABORTED", "The MCP reconnect was invalidated while starting.")),
                    }
                }).await {
                    Ok(result) => result,
                    Err(_) => {
                        last_error = "MCP reconnect exceeded its 30-second circuit budget.".into();
                        last_error_code = "MCP_RUNTIME_RECONNECT_TIMEOUT".into();
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
                    let _authority = Arc::new(_authority);
                    let config_change_error = match crate::secrets::blocking::with_guard(
                        _authority.clone(),
                        self.connector.config_fingerprint(&selector),
                    )
                    .await
                    {
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
                    entry.snapshot.last_error_code = None;
                    entry.snapshot.last_error = None;
                    entry.snapshot.updated_at = now();
                    entry.concurrency = Arc::new(Semaphore::new(
                        connection.max_concurrent_operations.clamp(1, 16),
                    ));
                    entry.session = Some(connection.session);
                    return;
                }
                Err(error) => {
                    last_error_code = error.code.to_string();
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
                    entry.snapshot.last_error_code = Some(last_error_code.clone());
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
                entry.snapshot.last_error_code = Some(last_error_code);
                entry.snapshot.last_error = Some(format!(
                    "MCP reconnect circuit opened after repeated failures: {last_error}"
                ));
                entry.snapshot.updated_at = now();
            }
        }
    }

    pub async fn shutdown_all(&self) {
        self.interaction.shutdown();
        self.shutting_down.store(true, Ordering::Release);
        self.configuration_observer_stop.notify_waiters();
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
                    entry.connection_cancellation.cancel();
                    entry.snapshot.status = McpRuntimeStatus::Disconnected;
                    entry.snapshot.last_error_code = None;
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
        let mut operations = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(operation) = operations.active.get(operation_id) {
            operation.cancellation.cancel();
        } else {
            operations.remember_pending_cancellation(operation_id);
        }
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
        self.invalidate_if_current_attempt(key, None, error).await;
    }

    async fn invalidate_connect_attempt_if_current(
        &self,
        key: &McpRuntimeKey,
        connect_attempt_id: Uuid,
        error: &McpRuntimeError,
    ) {
        self.invalidate_if_current_attempt(key, Some(connect_attempt_id), error)
            .await;
    }

    async fn invalidate_if_current_attempt(
        &self,
        key: &McpRuntimeKey,
        connect_attempt_id: Option<Uuid>,
        error: &McpRuntimeError,
    ) {
        let logical_key = LogicalRuntimeKey::from(key);
        let session = {
            let mut state = self.state.lock().await;
            let Some(entry) = state.entries.get_mut(&logical_key) else {
                return;
            };
            if entry.snapshot.key != *key {
                return;
            }
            if connect_attempt_id.is_some_and(|attempt_id| entry.connect_attempt_id != attempt_id) {
                return;
            }
            // Invalidation already revoked this generation and took its session.
            // Keep both a pending close's publication key and its final diagnostic
            // until a valid connection installs a new configuration fingerprint.
            if entry.config_fingerprint == "invalid" {
                return;
            }
            self.cancel_operations_for(&logical_key);
            entry.connection_cancellation.cancel();
            if let Some(next_generation) = entry.snapshot.key.config_generation.checked_add(1) {
                entry.snapshot.key.config_generation = next_generation;
            }
            entry.snapshot.status = McpRuntimeStatus::Failed;
            entry.snapshot.requested_protocol_mode = None;
            entry.snapshot.negotiated_era = None;
            entry.snapshot.negotiated_protocol_version = None;
            entry.snapshot.protocol_decision_reason = None;
            entry.snapshot.last_error_code = Some(error.code.to_string());
            entry.snapshot.last_error = Some(error.to_string());
            entry.snapshot.updated_at = now();
            entry.config_fingerprint = "invalid".to_string();
            entry.catalog = None;
            (entry.snapshot.key.clone(), entry.session.take())
        };
        let (revoked_key, session) = session;
        let close_error = if let Some(session) = session {
            match tokio::time::timeout(CONFIGURATION_CLOSE_BUDGET, session.close()).await {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(_) => Some(McpRuntimeError::new(
                    "MCP_RUNTIME_CLOSE_TIMEOUT",
                    "MCP session cleanup exceeded its 15-second budget.",
                )),
            }
        } else {
            None
        };
        let mut state = self.state.lock().await;
        if let Some(entry) = state.entries.get_mut(&logical_key) {
            if entry.snapshot.key == revoked_key && entry.config_fingerprint == "invalid" {
                if let Some(close_error) = close_error {
                    entry.snapshot.last_error_code = Some(close_error.code.to_string());
                    entry.snapshot.last_error =
                        Some(format!("{error}; cleanup failed: {close_error}"));
                } else if matches!(
                    error.code,
                    "MCP_RUNTIME_SERVER_NOT_FOUND" | "MCP_RUNTIME_SERVER_DISABLED"
                ) {
                    entry.snapshot.status = McpRuntimeStatus::Disconnected;
                }
                entry.snapshot.updated_at = now();
            }
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
            .active
            .keys()
            .cloned()
            .collect()
    }

    fn cancel_operations_for(&self, logical_key: &LogicalRuntimeKey) {
        let operations = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for operation in operations.active.values() {
            if LogicalRuntimeKey::from(&operation.key) == *logical_key {
                operation.cancellation.cancel();
            }
        }
    }
}

struct ActiveOperationGuard {
    cancellation_on_return: Option<Arc<McpOperationCancellation>>,
    operation_id: String,
    operations: Arc<StdMutex<OperationRegistry>>,
}

impl Drop for ActiveOperationGuard {
    fn drop(&mut self) {
        if let Some(cancellation) = &self.cancellation_on_return {
            cancellation.cancel();
            if let Some(context) = cancellation.interaction() {
                context
                    .broker
                    .finish_operation(&context.key, &context.operation_id);
            }
        }
        self.operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active
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
        call_count: AtomicUsize,
        close_calls: AtomicUsize,
        block_lists: AtomicBool,
        block_calls: AtomicBool,
        fail_lists: AtomicBool,
        fail_close: AtomicBool,
        block_close: AtomicBool,
        close_started: Notify,
        close_release: Notify,
        closed: AtomicBool,
        list_started: Notify,
        call_started: Notify,
        interaction_seen: StdMutex<Option<(McpRuntimeKey, String)>>,
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
            cancellation: Arc<McpOperationCancellation>,
        ) -> McpFuture<'a, McpCallToolResponse> {
            Box::pin(async move {
                self.call_count.fetch_add(1, Ordering::SeqCst);
                *self.interaction_seen.lock().unwrap() = cancellation
                    .interaction()
                    .map(|context| (context.key, context.operation_id));
                self.call_started.notify_one();
                if self.block_calls.load(Ordering::SeqCst) {
                    cancellation.cancelled().await;
                    return Err(cancelled_error());
                }
                Ok(McpCallToolResponse {
                    content: format!("{tool_name}:{arguments}"),
                    blocks: vec![],
                    is_error: false,
                    raw_result: serde_json::json!({"ok": true}),
                })
            })
        }

        fn close<'a>(&'a self) -> McpFuture<'a, ()> {
            Box::pin(async move {
                self.close_calls.fetch_add(1, Ordering::SeqCst);
                self.close_started.notify_one();
                if self.block_close.load(Ordering::SeqCst) {
                    self.close_release.notified().await;
                }
                if self.fail_close.load(Ordering::SeqCst) {
                    return Err(McpRuntimeError::new(
                        "MCP_RUNTIME_TEST_CLOSE_FAILED",
                        "synthetic close failure",
                    ));
                }
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

    struct SequencedConnector {
        sessions: Vec<Arc<FakeSession>>,
        connect_calls: AtomicUsize,
        fingerprint_calls: AtomicUsize,
        fail_first_postconnect_fingerprint: AtomicBool,
        connect_started: Vec<Notify>,
        connect_release: Vec<Notify>,
    }

    impl McpConnector for SequencedConnector {
        fn config_fingerprint<'a>(
            &'a self,
            _selector: &'a McpRuntimeSelector,
        ) -> McpFuture<'a, String> {
            let call = self.fingerprint_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if call == 2
                    && self
                        .fail_first_postconnect_fingerprint
                        .load(Ordering::SeqCst)
                {
                    return Err(McpRuntimeError::new(
                        "MCP_RUNTIME_CONFIG_INVALID",
                        "the superseded connection observed an invalid configuration",
                    ));
                }
                Ok("same-fingerprint".to_string())
            })
        }

        fn connect<'a>(
            &'a self,
            _request: &'a McpConnectionRequest,
        ) -> McpFuture<'a, McpConnectedSession> {
            let attempt = self.connect_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                self.connect_started[attempt].notify_one();
                self.connect_release[attempt].notified().await;
                Ok(McpConnectedSession {
                    session: self.sessions[attempt].clone(),
                    requested_protocol_mode: Some(McpProtocolMode::Auto),
                    negotiated_era: Some(McpProtocolEra::Legacy),
                    negotiated_protocol_version: Some("2025-11-25".into()),
                    protocol_decision_reason: Some("sequenced connector".into()),
                    max_concurrent_operations: 1,
                })
            })
        }
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
        let (manager, connector) = manager(session.clone());
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
        assert_eq!(
            *session.interaction_seen.lock().unwrap(),
            Some((key, "operation-call-1".into()))
        );
        assert_eq!(connector.connect_calls.load(Ordering::SeqCst), 1);
        assert!(manager.active_operation_ids().await.is_empty());
    }

    #[tokio::test]
    async fn cancellation_while_waiting_for_authority_prevents_tool_dispatch() {
        let session = Arc::new(FakeSession::default());
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
        let authority_guard = authority.write_owned().await;
        let call_manager = manager.clone();
        let call_key = key.clone();
        let call = tokio::spawn(async move {
            call_manager
                .call_tool(
                    &call_key,
                    "echo",
                    serde_json::json!({}),
                    "authority-wait-call".into(),
                )
                .await
        });
        while !manager
            .active_operation_ids()
            .await
            .iter()
            .any(|id| id == "authority-wait-call")
        {
            tokio::task::yield_now().await;
        }

        assert!(manager.cancel_operation("authority-wait-call").await);
        drop(authority_guard);

        assert_eq!(call.await.unwrap().unwrap_err().code, OPERATION_CANCELLED);
        assert_eq!(session.call_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn native_cancellation_before_first_poll_never_calls_the_session() {
        let session = Arc::new(FakeSession::default());
        let (manager, _) = manager(session.clone());
        let key = connected_key(&manager).await;
        let cancel = tokio_util::sync::CancellationToken::new();
        let call = manager.call_tool_owned(
            &key,
            "echo",
            serde_json::json!({}),
            "native-pre-registration".into(),
            None,
            Some(cancel.clone()),
        );
        // Construct the actual executor future, cancel before its first poll.
        cancel.cancel();
        let error = call.await.unwrap_err();
        assert_eq!(error.code, OPERATION_CANCELLED);
        assert_eq!(session.call_count.load(Ordering::SeqCst), 0);
        assert!(manager.active_operation_ids().await.is_empty());
    }

    #[tokio::test]
    async fn cancellation_received_before_call_is_consumed_by_that_operation_only() {
        let session = Arc::new(FakeSession::default());
        let (manager, _) = manager(session.clone());
        let key = connected_key(&manager).await;

        assert!(manager.cancel_operation("cancel-before-call").await);
        let cancelled = manager
            .call_tool(
                &key,
                "echo",
                serde_json::json!({}),
                "cancel-before-call".into(),
            )
            .await
            .unwrap_err();
        let other = manager
            .call_tool(
                &key,
                "echo",
                serde_json::json!({}),
                "independent-call".into(),
            )
            .await
            .unwrap();

        assert_eq!(cancelled.code, OPERATION_CANCELLED);
        assert_eq!(other.content, "echo:{}");
        assert_eq!(session.call_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn superseded_same_configuration_connect_cannot_publish_its_session() {
        let first_session = Arc::new(FakeSession::default());
        let second_session = Arc::new(FakeSession::default());
        let connector = Arc::new(SequencedConnector {
            sessions: vec![first_session.clone(), second_session.clone()],
            connect_calls: AtomicUsize::new(0),
            fingerprint_calls: AtomicUsize::new(0),
            fail_first_postconnect_fingerprint: AtomicBool::new(false),
            connect_started: vec![Notify::new(), Notify::new()],
            connect_release: vec![Notify::new(), Notify::new()],
        });
        let manager = Arc::new(McpRuntimeManager::with_connector(connector.clone()));
        let first_manager = manager.clone();
        let first = tokio::spawn(async move { first_manager.connect(selector()).await });
        connector.connect_started[0].notified().await;
        let key = McpRuntimeKey {
            server_id: "test".into(),
            project_id: None,
            project_ids: vec!["project-1".into()],
            config_generation: 1,
        };
        manager.disconnect(&key).await.unwrap();
        let second_manager = manager.clone();
        let second = tokio::spawn(async move { second_manager.connect(selector()).await });
        connector.connect_started[1].notified().await;

        connector.connect_release[0].notify_one();
        assert_eq!(
            first.await.unwrap().unwrap_err().code,
            "MCP_RUNTIME_CONNECT_ABORTED"
        );
        connector.connect_release[1].notify_one();
        let ready = second.await.unwrap().unwrap();
        manager
            .call_tool(
                &ready.key,
                "echo",
                serde_json::json!({}),
                "second-session-call".into(),
            )
            .await
            .unwrap();

        assert_eq!(first_session.call_count.load(Ordering::SeqCst), 0);
        assert_eq!(first_session.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(second_session.call_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn superseded_connect_error_cannot_invalidate_the_current_attempt() {
        let first_session = Arc::new(FakeSession::default());
        let second_session = Arc::new(FakeSession::default());
        let connector = Arc::new(SequencedConnector {
            sessions: vec![first_session.clone(), second_session.clone()],
            connect_calls: AtomicUsize::new(0),
            fingerprint_calls: AtomicUsize::new(0),
            fail_first_postconnect_fingerprint: AtomicBool::new(true),
            connect_started: vec![Notify::new(), Notify::new()],
            connect_release: vec![Notify::new(), Notify::new()],
        });
        let manager = Arc::new(McpRuntimeManager::with_connector(connector.clone()));
        let first_manager = manager.clone();
        let first = tokio::spawn(async move { first_manager.connect(selector()).await });
        connector.connect_started[0].notified().await;
        let key = McpRuntimeKey {
            server_id: "test".into(),
            project_id: None,
            project_ids: vec!["project-1".into()],
            config_generation: 1,
        };
        manager.disconnect(&key).await.unwrap();
        let second_manager = manager.clone();
        let second = tokio::spawn(async move { second_manager.connect(selector()).await });
        connector.connect_started[1].notified().await;

        connector.connect_release[0].notify_one();
        assert_eq!(
            first.await.unwrap().unwrap_err().code,
            "MCP_RUNTIME_CONFIG_INVALID"
        );
        let connecting = manager.snapshot().await.servers.remove(0);
        assert_eq!(connecting.status, McpRuntimeStatus::Connecting);
        assert_eq!(connecting.key, key);

        connector.connect_release[1].notify_one();
        let ready = second.await.unwrap().unwrap();
        manager
            .call_tool(
                &ready.key,
                "echo",
                serde_json::json!({}),
                "current-session-call".into(),
            )
            .await
            .unwrap();

        assert_eq!(first_session.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(second_session.call_count.load(Ordering::SeqCst), 1);
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
        assert!(manager.cancel_operation("missing").await);
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
    async fn configuration_reconciliation_cancels_invalid_operations_and_preserves_unchanged_leases(
    ) {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());
        let key = connected_key(&manager).await;
        let catalog = manager.refresh_catalog(&key).await.unwrap();
        manager.reconcile_configuration().await;
        assert_eq!(manager.snapshot().await.servers[0].key, key);
        assert_eq!(
            manager.refresh_catalog(&key).await.unwrap().key,
            catalog.key
        );
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 0);

        session.block_calls.store(true, Ordering::SeqCst);
        let calling = manager.clone();
        let call_key = key.clone();
        let call = tokio::spawn(async move {
            calling
                .call_tool(
                    &call_key,
                    "echo",
                    serde_json::json!({}),
                    "configuration-call".into(),
                )
                .await
        });
        session.call_started.notified().await;
        connector.fingerprint_error.store(true, Ordering::SeqCst);
        manager.reconcile_configuration().await;
        assert_eq!(call.await.unwrap().unwrap_err().code, OPERATION_CANCELLED);
        assert!(manager.active_operation_ids().await.is_empty());
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            manager.refresh_catalog(&key).await.unwrap_err().code,
            STALE_GENERATION
        );
    }

    #[tokio::test]
    async fn configuration_reconciliation_aborts_a_pending_connection() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session);
        connector.block_connect.store(true, Ordering::SeqCst);
        let connecting = manager.clone();
        let task = tokio::spawn(async move { connecting.connect(selector()).await });
        connector.connect_started.notified().await;
        connector.fingerprint_error.store(true, Ordering::SeqCst);
        manager.reconcile_configuration().await;
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("connection must abort without releasing its handshake")
            .unwrap()
            .unwrap_err();
        assert_eq!(
            manager.snapshot().await.servers[0].status,
            McpRuntimeStatus::Failed
        );
    }

    #[tokio::test]
    async fn configuration_cleanup_failure_is_visible_in_the_diagnostic_snapshot() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());
        let key = connected_key(&manager).await;
        session.fail_close.store(true, Ordering::SeqCst);
        connector.fingerprint_error.store(true, Ordering::SeqCst);
        manager.reconcile_configuration().await;
        let snapshot = manager.snapshot().await.servers.remove(0);
        assert_eq!(snapshot.status, McpRuntimeStatus::Failed);
        assert_eq!(
            snapshot.last_error_code.as_deref(),
            Some("MCP_RUNTIME_TEST_CLOSE_FAILED")
        );
        assert!(snapshot.last_error.unwrap().contains("cleanup failed"));
        assert!(snapshot.key.config_generation > key.config_generation);
        // An unrelated mutation must not overwrite the cleanup diagnostic.
        manager.reconcile_configuration().await;
        assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            manager.snapshot().await.servers[0].last_error_code,
            snapshot.last_error_code
        );
    }

    #[tokio::test]
    async fn configuration_cleanup_has_a_bounded_wait() {
        let session = Arc::new(FakeSession::default());
        let (manager, connector) = manager(session.clone());
        connected_key(&manager).await;
        session.block_close.store(true, Ordering::SeqCst);
        connector.fingerprint_error.store(true, Ordering::SeqCst);
        tokio::time::timeout(
            CONFIGURATION_CLOSE_BUDGET + Duration::from_secs(2),
            manager.reconcile_configuration(),
        )
        .await
        .expect("cleanup must finish within its budget");
        let snapshot = manager.snapshot().await.servers.remove(0);
        assert_eq!(snapshot.status, McpRuntimeStatus::Failed);
        assert_eq!(
            snapshot.last_error_code.as_deref(),
            Some("MCP_RUNTIME_CLOSE_TIMEOUT")
        );
    }

    #[tokio::test]
    async fn repeated_invalidation_during_close_preserves_result_and_valid_reconnection() {
        let mut checks = tokio::task::JoinSet::new();
        for timeout in [false, true] {
            for reconnect in [false, true] {
                checks.spawn(async move {
                    let session = Arc::new(FakeSession::default());
                    let (manager, connector) = manager(session.clone());
                    let initial = connected_key(&manager).await;
                    session.block_close.store(true, Ordering::SeqCst);
                    session.fail_close.store(true, Ordering::SeqCst);
                    connector.fingerprint_error.store(true, Ordering::SeqCst);
                    let closing_manager = manager.clone();
                    let closing = tokio::spawn(async move {
                        closing_manager.reconcile_configuration().await;
                    });
                    tokio::time::timeout(Duration::from_secs(1), session.close_started.notified())
                        .await
                        .expect("invalidation must take the session and start closing");
                    let revoked = manager.snapshot().await.servers.remove(0);
                    assert!(revoked.key.config_generation > initial.config_generation);

                    // The session is already taken, but its close result has
                    // not been published. Neither rejection may revoke it again.
                    assert_eq!(
                        manager.connect(selector()).await.unwrap_err().code,
                        "MCP_RUNTIME_CONFIG_INVALID"
                    );
                    manager
                        .invalidate_server("test", "repeated secret invalidation")
                        .await;
                    assert_eq!(
                        serde_json::to_value(manager.snapshot().await.servers.remove(0)).unwrap(),
                        serde_json::to_value(&revoked).unwrap()
                    );
                    assert_eq!(session.close_calls.load(Ordering::SeqCst), 1);

                    let ready = if reconnect {
                        connector.fingerprint_error.store(false, Ordering::SeqCst);
                        let ready = manager.connect(selector()).await.unwrap();
                        assert!(ready.key.config_generation > revoked.key.config_generation);
                        assert_eq!(ready.status, McpRuntimeStatus::Ready);
                        Some(ready)
                    } else {
                        None
                    };
                    if !timeout {
                        session.close_release.notify_one();
                    }
                    tokio::time::timeout(
                        CONFIGURATION_CLOSE_BUDGET + Duration::from_secs(2),
                        closing,
                    )
                    .await
                    .expect("close must finish within its budget")
                    .unwrap();
                    let snapshot = manager.snapshot().await.servers.remove(0);
                    if let Some(ready) = ready {
                        // The old close failure/timeout cannot overwrite a real
                        // reconnection on a valid definition and fresh generation.
                        assert_eq!(
                            serde_json::to_value(&snapshot).unwrap(),
                            serde_json::to_value(&ready).unwrap()
                        );
                        manager
                            .call_tool(
                                &ready.key,
                                "echo",
                                serde_json::json!({}),
                                "restored-definition".into(),
                            )
                            .await
                            .unwrap();
                        session.block_close.store(false, Ordering::SeqCst);
                        session.fail_close.store(false, Ordering::SeqCst);
                        manager.disconnect(&ready.key).await.unwrap();
                    } else {
                        assert_eq!(snapshot.key, revoked.key);
                        assert_eq!(snapshot.status, McpRuntimeStatus::Failed);
                        assert_eq!(
                            snapshot.last_error_code.as_deref(),
                            Some(if timeout {
                                "MCP_RUNTIME_CLOSE_TIMEOUT"
                            } else {
                                "MCP_RUNTIME_TEST_CLOSE_FAILED"
                            })
                        );
                        assert_eq!(
                            manager.connect(selector()).await.unwrap_err().code,
                            "MCP_RUNTIME_CONFIG_INVALID"
                        );
                        manager
                            .invalidate_server("test", "invalidation after close")
                            .await;
                        assert_eq!(
                            serde_json::to_value(manager.snapshot().await.servers.remove(0))
                                .unwrap(),
                            serde_json::to_value(&snapshot).unwrap()
                        );
                    }
                    assert_eq!(
                        manager.refresh_catalog(&initial).await.unwrap_err().code,
                        STALE_GENERATION
                    );
                    assert_eq!(
                        connector.connect_calls.load(Ordering::SeqCst),
                        if reconnect { 2 } else { 1 }
                    );
                });
            }
        }
        while let Some(result) = checks.join_next().await {
            result.unwrap();
        }
    }

    #[tokio::test]
    async fn real_adapter_cleanup_results_reach_configuration_snapshot() {
        use super::super::runtime_connector::cleanup_fixture_session;
        use super::super::service_shutdown::fixture::CloseBehavior;
        struct InvalidDefinitionConnector(&'static str);
        impl McpConnector for InvalidDefinitionConnector {
            fn config_fingerprint<'a>(
                &'a self,
                _selector: &'a McpRuntimeSelector,
            ) -> McpFuture<'a, String> {
                Box::pin(async move {
                    Err(McpRuntimeError::new(
                        self.0,
                        "fixture definition is unavailable",
                    ))
                })
            }
            fn connect<'a>(
                &'a self,
                _request: &'a McpConnectionRequest,
            ) -> McpFuture<'a, McpConnectedSession> {
                Box::pin(async { panic!("a rejected definition must not create a session") })
            }
        }
        let mut checks = tokio::task::JoinSet::new();
        for adapter in ["legacy-stdio", "modern-stdio", "legacy-http", "modern-http"] {
            for behavior in [
                CloseBehavior::Success,
                CloseBehavior::Error,
                CloseBehavior::Panic,
                CloseBehavior::Timeout,
            ] {
                for rejection in [
                    "MCP_RUNTIME_SERVER_DISABLED",
                    "MCP_RUNTIME_SERVER_NOT_FOUND",
                ] {
                    checks.spawn(async move {
                        let (session, control) = cleanup_fixture_session(adapter, behavior).await;
                        let manager = McpRuntimeManager::with_connector(Arc::new(
                            InvalidDefinitionConnector(rejection),
                        ));
                        let key = McpRuntimeKey {
                            server_id: "test".into(),
                            project_id: None,
                            project_ids: vec![],
                            config_generation: 1,
                        };
                        // Install the real adapter session. Only the source mutation
                        // is injected here; the native mutation path has its own
                        // subprocess/configuration test below.
                        let mut entry = RuntimeEntry::connecting(
                            key.clone(),
                            "configured".into(),
                            Uuid::new_v4(),
                        );
                        entry.snapshot.status = McpRuntimeStatus::Ready;
                        entry.session = Some(session);
                        manager
                            .state
                            .lock()
                            .await
                            .entries
                            .insert(LogicalRuntimeKey::from(&key), entry);
                        let started = Instant::now();
                        manager
                            .invalidate_if_current(
                                &key,
                                &McpRuntimeError::new(
                                    rejection,
                                    "fixture definition was invalidated",
                                ),
                            )
                            .await;
                        let snapshot = manager.snapshot().await.servers.remove(0);
                        let (status, code) = match behavior {
                            CloseBehavior::Success => (McpRuntimeStatus::Disconnected, rejection),
                            CloseBehavior::Timeout => {
                                (McpRuntimeStatus::Failed, "MCP_RUNTIME_CLOSE_TIMEOUT")
                            }
                            _ => (McpRuntimeStatus::Failed, "MCP_RUNTIME_CLOSE_FAILED"),
                        };
                        assert_eq!(snapshot.status, status, "{adapter}: {behavior:?}");
                        assert_eq!(
                            snapshot.last_error_code.as_deref(),
                            Some(code),
                            "{adapter}: {behavior:?}"
                        );
                        assert!(snapshot.key.config_generation > key.config_generation);
                        if !matches!(behavior, CloseBehavior::Success) {
                            assert!(snapshot.last_error.unwrap().contains("cleanup failed"));
                        }
                        // In particular, the inner 10-second timeout must reach the
                        // snapshot before the runtime's 15-second outer timeout.
                        assert!(
                            started.elapsed() < Duration::from_secs(14),
                            "{adapter}: {behavior:?}"
                        );
                        control.finish().await;
                        let diagnostic = manager.snapshot().await.servers.remove(0);
                        assert_eq!(
                            manager
                                .connect(McpRuntimeSelector {
                                    server_id: key.server_id.clone(),
                                    project_ids: key.project_ids.clone(),
                                })
                                .await
                                .unwrap_err()
                                .code,
                            rejection
                        );
                        manager
                            .invalidate_server("test", "repeated invalidation")
                            .await;
                        assert_eq!(
                            serde_json::to_value(manager.snapshot().await.servers.remove(0))
                                .unwrap(),
                            serde_json::to_value(&diagnostic).unwrap(),
                            "{adapter}: {behavior:?}: {rejection}"
                        );
                        manager.reconcile_configuration().await;
                        assert_eq!(
                            manager.snapshot().await.servers[0]
                                .last_error_code
                                .as_deref(),
                            Some(code)
                        );
                    });
                }
            }
        }
        while let Some(result) = checks.join_next().await {
            result.unwrap();
        }
    }

    async fn patch_mcp_configuration(
        manager: &crate::config::ConfigManager,
        scope: crate::config::ConfigScope,
        servers: serde_json::Value,
        source: crate::config::ConfigChangeSource,
    ) -> crate::config::ConfigPatchResult {
        use crate::config::{ConfigDocumentKind, ConfigPatchRequest, JsonPatchOperation};
        let document = manager
            .get_document(ConfigDocumentKind::Tools, scope.clone())
            .await
            .unwrap();
        manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope,
                expected_etag: document.etag,
                source,
                patch: vec![JsonPatchOperation {
                    op: "add".into(),
                    path: "/mcpServers".into(),
                    from: None,
                    value: Some(servers),
                }],
            })
            .await
            .unwrap()
    }

    #[cfg(unix)]
    fn process_is_running(pid: i32) -> bool {
        // The PID is written by our confined synthetic child. Signal zero only checks existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn voluntary_stdio_eof_checks_detached_descendants_and_reports_incomplete_inspection() {
        use super::super::runtime_connector::ConfiguredMcpConnector;
        use crate::config::{ConfigChangeSource, ConfigManager, ConfigScope};

        // Keep a fallback independent of containment inspection, including on
        // assertion failure. These PIDs belong only to this short-lived fixture.
        struct FixtureProcesses(std::path::PathBuf);
        impl FixtureProcesses {
            fn terminate(&self) {
                if let Ok(contents) = std::fs::read_to_string(&self.0) {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) {
                        for name in ["leader", "descendant"] {
                            if let Some(pid) = value[name].as_i64() {
                                unsafe { libc::kill(pid as i32, libc::SIGKILL) };
                            }
                        }
                    }
                }
            }
        }

        impl Drop for FixtureProcesses {
            fn drop(&mut self) {
                self.terminate();
            }
        }

        for fail_inspection in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let identities = directory.path().join("identities.json");
            let processes = FixtureProcesses(identities.clone());
            let eof = directory.path().join("eof");
            let script = directory.path().join("eof_mcp.py");
            std::fs::write(
                &script,
                r#"
import fcntl, json, os, subprocess, sys

# The inherited marker is the same fault-injection boundary exercised by the
# process manager tests. The Rust guard also owns these PIDs so an incomplete
# inventory cannot leave an undiscovered descendant behind after the test.
marker = None
prefix = 'macro-process-' + os.environ['MACRO_PROCESS_CONTAINMENT_ID'] + '-'
for fd in os.listdir('/dev/fd'):
    try:
        path = fcntl.fcntl(int(fd), fcntl.F_GETPATH, bytes(1024)).split(b'\0', 1)[0].decode()
        if os.path.basename(path).startswith(prefix):
            marker = path
            break
    except OSError:
        pass
assert marker is not None
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    start_new_session=True, close_fds=False)
with open(sys.argv[1], 'w') as file:
    json.dump({'leader': os.getpid(), 'descendant': child.pid, 'marker': marker}, file)
for line in sys.stdin:
    message = json.loads(line)
    if 'id' not in message:
        continue
    result = {}
    if message.get('method') == 'initialize':
        result = {'protocolVersion': message['params']['protocolVersion'], 'capabilities': {},
            'serverInfo': {'name': 'eof-fixture', 'version': '1'}}
    print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}), flush=True)
with open(sys.argv[2], 'w') as file:
    file.write('voluntary EOF')
os._exit(0)
"#,
            )
            .unwrap();
            let config = ConfigManager::initialize(directory.path().join("config"))
                .await
                .unwrap();
            let mut servers = serde_json::json!({"test": {
                "name": "EOF fixture", "enabled": true, "protocol": {"mode": "legacy"},
                "transport": {"type": "stdio", "command": "python3",
                    "args": [script, identities, eof], "env": {}},
                "startupTimeoutMs": 5000, "operationTimeoutMs": 5000
            }});
            patch_mcp_configuration(
                &config,
                ConfigScope::User,
                servers.clone(),
                ConfigChangeSource::UserInterface,
            )
            .await;
            let runtime = McpRuntimeManager::with_connector(Arc::new(
                ConfiguredMcpConnector::with_config_manager(config.clone()),
            ));
            let initial = runtime
                .connect(McpRuntimeSelector {
                    server_id: "test".into(),
                    project_ids: vec![],
                })
                .await
                .unwrap();
            let identity: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&identities).unwrap()).unwrap();
            let leader = identity["leader"].as_i64().unwrap() as i32;
            let descendant = identity["descendant"].as_i64().unwrap() as i32;
            assert!(process_is_running(leader));
            assert!(process_is_running(descendant));
            assert_ne!(unsafe { libc::getpgid(leader) }, unsafe {
                libc::getpgid(descendant)
            });
            if fail_inspection {
                // Unlink only this fixture's marker to make lsof fail. The
                // test guard handles descendants missed by this partial scan.
                std::fs::remove_file(identity["marker"].as_str().unwrap()).unwrap();
            }
            servers["test"]["enabled"] = serde_json::json!(false);
            patch_mcp_configuration(
                &config,
                ConfigScope::User,
                servers,
                ConfigChangeSource::UserInterface,
            )
            .await;
            let snapshot =
                tokio::time::timeout(CONFIGURATION_CLOSE_BUDGET + Duration::from_secs(2), async {
                    loop {
                        let server = runtime.snapshot().await.servers.remove(0);
                        if server.key != initial.key
                            && server.last_error_code.as_deref()
                                == Some(if fail_inspection {
                                    "MCP_RUNTIME_CLOSE_FAILED"
                                } else {
                                    "MCP_RUNTIME_SERVER_DISABLED"
                                })
                            && server.status
                                == if fail_inspection {
                                    McpRuntimeStatus::Failed
                                } else {
                                    McpRuntimeStatus::Disconnected
                                }
                            && !process_is_running(leader)
                            && (fail_inspection || !process_is_running(descendant))
                        {
                            break server;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await
                .unwrap_or_else(|error| {
                    panic!("EOF cleanup incomplete: {error}; injected={fail_inspection}, leader={leader}, descendant={descendant}, eof={}, leader_pid_exists={}, descendant_pid_exists={}",
                        eof.exists(), process_is_running(leader), process_is_running(descendant));
                });
            assert_eq!(std::fs::read_to_string(&eof).unwrap(), "voluntary EOF");
            assert!(snapshot.key.config_generation > initial.key.config_generation);
            if fail_inspection {
                assert!(snapshot
                    .last_error
                    .unwrap()
                    .contains("Process tree inspection was incomplete"));
            }
            let mut inspection = crate::core::process::background_tokio_command("/bin/ps");
            inspection
                .args(["-o", "stat=", "-p", &descendant.to_string()])
                .kill_on_drop(true);
            let state = tokio::time::timeout(Duration::from_secs(1), inspection.output())
                .await
                .expect("fixture state inspection must be bounded")
                .unwrap();
            assert!(
                state.status.success()
                    || (state.status.code() == Some(1)
                        && state.stdout.is_empty()
                        && state.stderr.is_empty()),
                "{state:?}"
            );
            let state = String::from_utf8(state.stdout).unwrap();
            let state = state.trim();
            eprintln!("EOF cleanup: injected={fail_inspection}, leader={leader}, descendant={descendant}, descendant_os_state={state:?}, zombie={}, status={:?}, code={:?}",
                state.starts_with('Z'), snapshot.status, snapshot.last_error_code);
            // An incomplete inventory reports failure; it cannot promise that
            // an undiscovered detached child was killed. Clean up that fixture
            // explicitly and verify absence independently of the adapter.
            if fail_inspection {
                processes.terminate();
            }
            tokio::time::timeout(Duration::from_secs(2), async {
                while process_is_running(leader) || process_is_running(descendant) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("no fixture processes may survive the test");
            eprintln!("EOF fixture processes absent: leader={leader}, descendant={descendant}");
            runtime.shutdown_all().await;
            // Both PIDs are gone, so the fallback must not signal reused PIDs.
            std::fs::remove_file(&identities).unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_configuration_mutations_close_stdio_processes_without_an_mcp_operation() {
        use super::super::runtime_connector::ConfiguredMcpConnector;
        use crate::config::{ConfigChangeSource, ConfigDocumentKind, ConfigManager, ConfigScope};
        // No global manager, network server or application runtime is needed.
        for mutation in [
            "disable",
            "remove",
            "approve",
            "reload",
            "remove-with-override",
        ] {
            let remove = mutation.starts_with("remove");
            let overridden = mutation == "remove-with-override";
            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("synthetic_mcp.py");
            std::fs::write(&script, r#"
import json, os, sys
with open(sys.argv[1], 'a') as file:
    file.write(str(os.getpid()) + '\n')
for line in sys.stdin:
    message = json.loads(line)
    if 'id' not in message:
        continue
    method = message.get('method')
    result = {}
    if method == 'initialize':
        result = {'protocolVersion': message['params']['protocolVersion'], 'capabilities': {}, 'serverInfo': {'name': 'synthetic', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'echo', 'inputSchema': {'type': 'object'}}]}
    elif method == 'tools/call':
        result = {'content': [{'type': 'text', 'text': 'synthetic-result'}]}
    print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}), flush=True)
"#).unwrap();
            let config = ConfigManager::initialize(directory.path().join("config"))
                .await
                .unwrap();
            let definition = |name: &str| {
                serde_json::json!({
                    "name": name, "enabled": true,
                    "transport": {"type": "stdio", "command": "python3", "args": [script, directory.path().join(format!("{name}.pids"))], "env": {}},
                    "startupTimeoutMs": 5000, "operationTimeoutMs": 5000
                })
            };
            let mut servers =
                serde_json::json!({"retired": definition("retired"), "kept": definition("kept")});
            patch_mcp_configuration(
                &config,
                ConfigScope::User,
                servers.clone(),
                ConfigChangeSource::UserInterface,
            )
            .await;
            let project = directory.path().join("metadata");
            config
                .register_project_root("project", project)
                .await
                .unwrap();
            // Project-only server remains effective when the global entry disappears.
            let mut project_servers =
                serde_json::json!({"project_only": definition("project_only")});
            if overridden {
                project_servers["retired"] = definition("retired");
            }
            patch_mcp_configuration(
                &config,
                ConfigScope::Project {
                    project_id: "project".into(),
                },
                project_servers,
                ConfigChangeSource::UserInterface,
            )
            .await;
            let runtime = McpRuntimeManager::with_connector(Arc::new(
                ConfiguredMcpConnector::with_config_manager(config.clone()),
            ));
            let global = runtime
                .connect(McpRuntimeSelector {
                    server_id: "retired".into(),
                    project_ids: vec![],
                })
                .await
                .unwrap();
            let scoped = runtime
                .connect(McpRuntimeSelector {
                    server_id: "retired".into(),
                    project_ids: vec!["project".into()],
                })
                .await
                .unwrap();
            let kept = runtime
                .connect(McpRuntimeSelector {
                    server_id: "kept".into(),
                    project_ids: vec!["project".into()],
                })
                .await
                .unwrap();
            let project_only = runtime
                .connect(McpRuntimeSelector {
                    server_id: "project_only".into(),
                    project_ids: vec!["project".into()],
                })
                .await
                .unwrap();
            runtime.refresh_catalog(&kept.key).await.unwrap();
            let pids = |name: &str| {
                std::fs::read_to_string(directory.path().join(format!("{name}.pids")))
                    .unwrap()
                    .lines()
                    .map(|pid| pid.parse::<i32>().unwrap())
                    .collect::<Vec<_>>()
            };
            let retired_pids = pids("retired");
            assert_eq!(retired_pids.len(), 2);
            let invalid_pids = if overridden {
                &retired_pids[..1]
            } else {
                &retired_pids[..]
            };
            assert!(retired_pids.iter().all(|pid| process_is_running(*pid)));
            let mut proposal = servers.clone();
            proposal["retired"]["enabled"] = serde_json::json!(false);
            let pending = patch_mcp_configuration(
                &config,
                ConfigScope::User,
                proposal,
                ConfigChangeSource::Agent,
            )
            .await;
            assert_eq!(pending.status, "pendingApproval");
            runtime.reconcile_configuration().await;
            assert!(runtime
                .snapshot()
                .await
                .servers
                .iter()
                .all(|server| server.status == McpRuntimeStatus::Ready));
            assert!(retired_pids.iter().all(|pid| process_is_running(*pid)));
            config
                .reject_pending_change(&pending.pending_change.unwrap().id, true)
                .await
                .unwrap();
            runtime.reconcile_configuration().await;
            if remove {
                servers.as_object_mut().unwrap().remove("retired");
            } else {
                servers["retired"]["enabled"] = serde_json::json!(false);
            }
            match mutation {
                "approve" => {
                    let pending = patch_mcp_configuration(
                        &config,
                        ConfigScope::User,
                        servers,
                        ConfigChangeSource::Agent,
                    )
                    .await;
                    config
                        .accept_pending_change(&pending.pending_change.unwrap().id)
                        .await
                        .unwrap();
                }
                "reload" => {
                    let mut document = config
                        .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
                        .await
                        .unwrap();
                    document.value["mcpServers"] = servers;
                    std::fs::write(
                        &document.file_path,
                        serde_json::to_vec(&document.value).unwrap(),
                    )
                    .unwrap();
                    config
                        .reload(
                            ConfigDocumentKind::Tools,
                            ConfigScope::User,
                            ConfigChangeSource::UserInterface,
                        )
                        .await
                        .unwrap();
                }
                _ => {
                    patch_mcp_configuration(
                        &config,
                        ConfigScope::User,
                        servers,
                        ConfigChangeSource::UserInterface,
                    )
                    .await;
                }
            }
            // No connect, refresh, call or disconnect after the config mutation.
            tokio::time::timeout(CONFIGURATION_CLOSE_BUDGET + Duration::from_secs(2), async {
                loop {
                    let snapshot = runtime.snapshot().await;
                    if invalid_pids.iter().all(|pid| !process_is_running(*pid))
                        && snapshot
                            .servers
                            .iter()
                            .filter(|s| {
                                s.key.server_id == "retired"
                                    && (!overridden || s.key.project_ids.is_empty())
                            })
                            .all(|s| s.status == McpRuntimeStatus::Disconnected)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("invalid processes must close without another MCP operation");
            let snapshot = runtime.snapshot().await;
            let invalid_sessions = if overridden {
                vec![&global]
            } else {
                vec![&global, &scoped]
            };
            for initial in invalid_sessions {
                let server = snapshot
                    .servers
                    .iter()
                    .find(|s| {
                        s.key.server_id == initial.key.server_id
                            && s.key.project_ids == initial.key.project_ids
                    })
                    .unwrap();
                assert!(server.key.config_generation > initial.key.config_generation);
                assert_eq!(
                    server.last_error_code.as_deref(),
                    Some(if remove {
                        "MCP_RUNTIME_SERVER_NOT_FOUND"
                    } else {
                        "MCP_RUNTIME_SERVER_DISABLED"
                    })
                );
            }
            let mut valid_sessions = vec![&kept, &project_only];
            if overridden {
                valid_sessions.push(&scoped);
            }
            for initial in &valid_sessions {
                assert_eq!(
                    snapshot
                        .servers
                        .iter()
                        .find(|s| s.key == initial.key)
                        .unwrap()
                        .status,
                    McpRuntimeStatus::Ready
                );
            }
            assert!(pids("kept")
                .iter()
                .chain(pids("project_only").iter())
                .all(|pid| process_is_running(*pid)));
            // Still-valid opaque conversation leases can dispatch on the original generation.
            for initial in valid_sessions {
                assert!(
                    !runtime
                        .call_tool(
                            &initial.key,
                            "echo",
                            serde_json::json!({}),
                            format!("kept-lease-{}", initial.key.server_id)
                        )
                        .await
                        .unwrap()
                        .is_error
                );
            }
            if overridden {
                assert!(process_is_running(retired_pids[1]));
            }
            runtime.shutdown_all().await;
            assert!(pids("kept")
                .iter()
                .chain(pids("project_only").iter())
                .all(|pid| !process_is_running(*pid)));
            assert!(
                config
                    .effective_user_document(ConfigDocumentKind::Tools)
                    .await["mcpServers"]
                    .get("retired")
                    .is_none()
                    || !remove
            );
        }
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
        assert_eq!(
            snapshot.servers[0].last_error_code.as_deref(),
            Some(CONNECTOR_UNAVAILABLE)
        );
        assert!(snapshot.servers[0]
            .last_error
            .as_deref()
            .unwrap()
            .starts_with(CONNECTOR_UNAVAILABLE));
    }
}
