use super::document::{DocumentCache, DocumentEdit, DocumentSnapshot};
use super::error::LspError;
use super::framing::{
    encode_message, LspFramer, DEFAULT_MAX_HEADER_BYTES, DEFAULT_MAX_MESSAGE_BYTES,
};
use super::protocol::{
    JsonRpcErrorObject, JsonRpcId, ServerRequest, ServerRequestHandler, ServerRequestResult,
};
use crate::core::process::background_tokio_command;
use futures::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Instant};
use tokio_util::sync::CancellationToken;

const DEFAULT_STDERR_CAPACITY_BYTES: usize = 64 * 1024;
const DEFAULT_EVENT_CAPACITY: usize = 256;
const OUTBOUND_CAPACITY: usize = 128;
const PROCESS_CONTROL_CAPACITY: usize = 4;
const IO_CHUNK_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientState {
    Created,
    Starting,
    Initializing,
    Ready,
    ShuttingDown,
    Stopped,
    Failed,
}

impl fmt::Display for ClientState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Created => "created",
            Self::Starting => "starting",
            Self::Initializing => "initializing",
            Self::Ready => "ready",
            Self::ShuttingDown => "shutting_down",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        };
        formatter.write_str(value)
    }
}

#[derive(Clone, Debug)]
pub struct LspServerConfig {
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
    pub initialize_params: Value,
    pub startup_timeout: Duration,
    pub request_timeout: Duration,
    pub shutdown_timeout: Duration,
    pub max_message_bytes: usize,
    pub max_header_bytes: usize,
    pub stderr_capacity_bytes: usize,
    pub event_capacity: usize,
}

impl LspServerConfig {
    pub fn new(
        executable: impl Into<PathBuf>,
        working_directory: impl Into<PathBuf>,
        initialize_params: Value,
    ) -> Self {
        Self {
            executable: executable.into(),
            arguments: Vec::new(),
            working_directory: working_directory.into(),
            environment: BTreeMap::new(),
            initialize_params,
            startup_timeout: Duration::from_secs(30),
            request_timeout: Duration::from_secs(30),
            shutdown_timeout: Duration::from_secs(5),
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            max_header_bytes: DEFAULT_MAX_HEADER_BYTES,
            stderr_capacity_bytes: DEFAULT_STDERR_CAPACITY_BYTES,
            event_capacity: DEFAULT_EVENT_CAPACITY,
        }
    }

    fn validate(&self) -> Result<(), LspError> {
        if self.executable.as_os_str().is_empty() {
            return Err(LspError::InvalidConfiguration {
                message: "executable cannot be empty".to_string(),
            });
        }
        if !self.initialize_params.is_object() {
            return Err(LspError::InvalidConfiguration {
                message: "initialize_params must be a JSON object".to_string(),
            });
        }
        for (name, duration) in [
            ("startup_timeout", self.startup_timeout),
            ("request_timeout", self.request_timeout),
            ("shutdown_timeout", self.shutdown_timeout),
        ] {
            if duration.is_zero() {
                return Err(LspError::InvalidConfiguration {
                    message: format!("{name} must be greater than zero"),
                });
            }
        }
        if self.max_message_bytes == 0 || self.max_header_bytes == 0 || self.event_capacity == 0 {
            return Err(LspError::InvalidConfiguration {
                message: "message, header, and event limits must be greater than zero".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default)]
pub struct RequestOptions {
    pub timeout: Option<Duration>,
    pub cancellation: Option<CancellationToken>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub success: bool,
    pub stderr: String,
}

#[derive(Clone, Debug)]
pub enum LspEvent {
    StateChanged {
        previous: ClientState,
        current: ClientState,
    },
    Notification {
        method: String,
        params: Value,
    },
    Diagnostics {
        params: Value,
    },
    Progress {
        params: Value,
    },
    LogMessage {
        method: String,
        params: Value,
    },
    ServerStderr {
        text: String,
    },
    UnmatchedResponse {
        id: JsonRpcId,
    },
    ProcessExited(ProcessExit),
    ProcessFailed {
        error: LspError,
    },
}

pub struct LspClient {
    inner: Arc<Inner>,
}

impl Clone for LspClient {
    fn clone(&self) -> Self {
        self.inner.public_handles.fetch_add(1, Ordering::Relaxed);
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        if self.inner.public_handles.fetch_sub(1, Ordering::AcqRel) != 1 {
            return;
        }
        self.inner.fail_all_pending(LspError::SessionClosing);
        lock(&self.inner.writer).take();
        if let Some(control) = lock(&self.inner.process_control).take() {
            let _ = control.try_send(ProcessCommand::Kill);
        }
    }
}

struct Inner {
    config: LspServerConfig,
    state: StdMutex<ClientState>,
    state_tx: watch::Sender<ClientState>,
    capabilities: StdMutex<Option<Value>>,
    next_request_id: AtomicI64,
    pending: StdMutex<HashMap<JsonRpcId, PendingRequest>>,
    writer: StdMutex<Option<mpsc::Sender<Outbound>>>,
    process_control: StdMutex<Option<mpsc::Sender<ProcessCommand>>>,
    process_exit_tx: watch::Sender<Option<ProcessExit>>,
    runtime: Mutex<Option<RuntimeTasks>>,
    lifecycle_gate: Mutex<()>,
    admission_gate: Mutex<()>,
    document_gate: Mutex<()>,
    documents: StdMutex<DocumentCache>,
    events: broadcast::Sender<LspEvent>,
    server_request_handler: Option<Arc<dyn ServerRequestHandler>>,
    server_requests: StdMutex<HashMap<JsonRpcId, CancellationToken>>,
    stderr: Arc<StdMutex<BoundedStderr>>,
    process_id: AtomicU32,
    termination_expected: AtomicBool,
    public_handles: AtomicUsize,
}

struct PendingRequest {
    method: String,
    sender: oneshot::Sender<Result<Value, LspError>>,
}

struct Outbound {
    bytes: Vec<u8>,
    write_timeout: Duration,
    acknowledgement: oneshot::Sender<Result<(), LspError>>,
}

enum ProcessCommand {
    Kill,
}

struct RuntimeTasks {
    writer: JoinHandle<()>,
    reader: JoinHandle<()>,
    stderr: JoinHandle<()>,
    process: JoinHandle<()>,
}

struct PendingGuard {
    inner: Arc<Inner>,
    id: JsonRpcId,
    armed: bool,
}

impl PendingGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if lock(&self.inner.pending).remove(&self.id).is_some() {
            self.inner.try_send_cancel(&self.id);
        }
    }
}

struct BoundedStderr {
    bytes: Vec<u8>,
    capacity: usize,
}

impl BoundedStderr {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity.min(IO_CHUNK_BYTES)),
            capacity,
        }
    }

    fn append(&mut self, chunk: &[u8]) {
        if self.capacity == 0 {
            return;
        }
        if chunk.len() >= self.capacity {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - self.capacity..]);
            return;
        }
        let overflow = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(self.capacity);
        if overflow > 0 {
            self.bytes.drain(..overflow);
        }
        self.bytes.extend_from_slice(chunk);
    }

    fn snapshot(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl LspClient {
    pub fn new(
        config: LspServerConfig,
        server_request_handler: Option<Arc<dyn ServerRequestHandler>>,
    ) -> Result<Self, LspError> {
        config.validate()?;
        let (events, _) = broadcast::channel(config.event_capacity);
        let (state_tx, _) = watch::channel(ClientState::Created);
        let (process_exit_tx, _) = watch::channel(None);
        let stderr_capacity = config.stderr_capacity_bytes;
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                state: StdMutex::new(ClientState::Created),
                state_tx,
                capabilities: StdMutex::new(None),
                next_request_id: AtomicI64::new(0),
                pending: StdMutex::new(HashMap::new()),
                writer: StdMutex::new(None),
                process_control: StdMutex::new(None),
                process_exit_tx,
                runtime: Mutex::new(None),
                lifecycle_gate: Mutex::new(()),
                admission_gate: Mutex::new(()),
                document_gate: Mutex::new(()),
                documents: StdMutex::new(DocumentCache::default()),
                events,
                server_request_handler,
                server_requests: StdMutex::new(HashMap::new()),
                stderr: Arc::new(StdMutex::new(BoundedStderr::new(stderr_capacity))),
                process_id: AtomicU32::new(0),
                termination_expected: AtomicBool::new(false),
                public_handles: AtomicUsize::new(1),
            }),
        })
    }

    pub fn state(&self) -> ClientState {
        self.inner.state()
    }

    pub fn subscribe_state(&self) -> watch::Receiver<ClientState> {
        self.inner.state_tx.subscribe()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LspEvent> {
        self.inner.events.subscribe()
    }

    pub fn server_capabilities(&self) -> Option<Value> {
        lock(&self.inner.capabilities).clone()
    }

    pub fn pending_request_count(&self) -> usize {
        lock(&self.inner.pending).len()
    }

    pub fn process_id(&self) -> Option<u32> {
        match self.inner.process_id.load(Ordering::Acquire) {
            0 => None,
            process_id => Some(process_id),
        }
    }

    pub fn stderr_snapshot(&self) -> String {
        lock(&self.inner.stderr).snapshot()
    }

    pub async fn start(&self) -> Result<Value, LspError> {
        let _lifecycle = self.inner.lifecycle_gate.lock().await;
        self.inner.transition(
            &[ClientState::Created],
            ClientState::Starting,
            "start the server",
        )?;

        if let Err(error) = self.spawn_runtime().await {
            self.inner.fail_session(error.clone());
            self.force_terminate_and_cleanup().await;
            return Err(error);
        }
        if let Err(error) = self.inner.transition(
            &[ClientState::Starting],
            ClientState::Initializing,
            "initialize the server",
        ) {
            self.inner.fail_session(error.clone());
            self.force_terminate_and_cleanup().await;
            return Err(error);
        }

        let result = self
            .request_internal(
                "initialize",
                self.inner.config.initialize_params.clone(),
                self.inner.config.startup_timeout,
                None,
                &[ClientState::Initializing],
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                self.inner.fail_session(error.clone());
                self.force_terminate_and_cleanup().await;
                return Err(error);
            }
        };
        let Some(capabilities) = result.get("capabilities").cloned() else {
            let error = LspError::Protocol {
                message: "initialize response is missing capabilities".to_string(),
            };
            self.inner.fail_session(error.clone());
            self.force_terminate_and_cleanup().await;
            return Err(error);
        };
        *lock(&self.inner.capabilities) = Some(capabilities);

        if let Err(error) = self
            .send_notification_internal(
                "initialized",
                Some(json!({})),
                self.inner.config.startup_timeout,
            )
            .await
        {
            self.inner.fail_session(error.clone());
            self.force_terminate_and_cleanup().await;
            return Err(error);
        }
        if let Err(error) = self.inner.transition(
            &[ClientState::Initializing],
            ClientState::Ready,
            "finish initialization",
        ) {
            self.inner.fail_session(error.clone());
            self.force_terminate_and_cleanup().await;
            return Err(error);
        }
        Ok(result)
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, LspError> {
        self.request_with_options(method, params, RequestOptions::default())
            .await
    }

    pub async fn request_with_options(
        &self,
        method: impl Into<String>,
        params: Value,
        options: RequestOptions,
    ) -> Result<Value, LspError> {
        let timeout = options.timeout.unwrap_or(self.inner.config.request_timeout);
        if timeout.is_zero() {
            return Err(LspError::InvalidConfiguration {
                message: "request timeout must be greater than zero".to_string(),
            });
        }
        self.request_internal(
            method.into(),
            params,
            timeout,
            options.cancellation,
            &[ClientState::Ready],
        )
        .await
    }

    pub async fn notify(&self, method: impl Into<String>, params: Value) -> Result<(), LspError> {
        let _admission = self.inner.admission_gate.lock().await;
        self.inner
            .ensure_state(&[ClientState::Ready], "send a notification")?;
        self.send_notification_internal(
            method.into(),
            Some(params),
            self.inner.config.request_timeout,
        )
        .await
    }

    pub async fn open_document(
        &self,
        uri: &str,
        language_id: impl Into<String>,
        version: i64,
        content: impl Into<String>,
    ) -> Result<DocumentSnapshot, LspError> {
        let _admission = self.inner.admission_gate.lock().await;
        self.inner
            .ensure_state(&[ClientState::Ready], "open a document")?;
        let _document_operation = self.inner.document_gate.lock().await;
        let candidate = lock(&self.inner.documents).prepare_open(
            uri,
            language_id.into(),
            version,
            content.into(),
        )?;
        self.send_notification_internal(
            "textDocument/didOpen",
            Some(json!({
                "textDocument": {
                    "uri": candidate.uri,
                    "languageId": candidate.language_id,
                    "version": candidate.version,
                    "text": candidate.content,
                }
            })),
            self.inner.config.request_timeout,
        )
        .await?;
        lock(&self.inner.documents).commit(candidate.clone());
        Ok(candidate)
    }

    pub async fn replace_document(
        &self,
        uri: &str,
        version: i64,
        content: impl Into<String>,
    ) -> Result<DocumentSnapshot, LspError> {
        let _admission = self.inner.admission_gate.lock().await;
        self.inner
            .ensure_state(&[ClientState::Ready], "replace a document")?;
        let _document_operation = self.inner.document_gate.lock().await;
        let candidate =
            lock(&self.inner.documents).prepare_replace(uri, version, content.into())?;
        self.send_document_change(&candidate).await?;
        lock(&self.inner.documents).commit(candidate.clone());
        Ok(candidate)
    }

    pub async fn edit_document(
        &self,
        uri: &str,
        version: i64,
        edits: &[DocumentEdit],
    ) -> Result<DocumentSnapshot, LspError> {
        let _admission = self.inner.admission_gate.lock().await;
        self.inner
            .ensure_state(&[ClientState::Ready], "edit a document")?;
        let _document_operation = self.inner.document_gate.lock().await;
        let candidate = lock(&self.inner.documents).prepare_edits(uri, version, edits)?;
        self.send_document_change(&candidate).await?;
        lock(&self.inner.documents).commit(candidate.clone());
        Ok(candidate)
    }

    pub async fn close_document(&self, uri: &str) -> Result<DocumentSnapshot, LspError> {
        let _admission = self.inner.admission_gate.lock().await;
        self.inner
            .ensure_state(&[ClientState::Ready], "close a document")?;
        let _document_operation = self.inner.document_gate.lock().await;
        let candidate = lock(&self.inner.documents).prepare_close(uri)?;
        self.send_notification_internal(
            "textDocument/didClose",
            Some(json!({"textDocument": {"uri": candidate.uri}})),
            self.inner.config.request_timeout,
        )
        .await?;
        lock(&self.inner.documents).commit(candidate.clone());
        Ok(candidate)
    }

    pub async fn document_snapshot(&self, uri: &str) -> Result<Option<DocumentSnapshot>, LspError> {
        Ok(lock(&self.inner.documents).snapshot(uri)?)
    }

    pub async fn document_snapshots(&self) -> Vec<DocumentSnapshot> {
        lock(&self.inner.documents).snapshots()
    }

    pub async fn shutdown(&self) -> Result<(), LspError> {
        let _lifecycle = self.inner.lifecycle_gate.lock().await;
        let admission = self.inner.admission_gate.lock().await;
        match self.state() {
            ClientState::Stopped => return Ok(()),
            ClientState::Created => {
                self.inner.transition(
                    &[ClientState::Created],
                    ClientState::Stopped,
                    "stop the client",
                )?;
                return Ok(());
            }
            ClientState::Failed => {
                self.force_terminate_and_cleanup().await;
                return Ok(());
            }
            ClientState::Ready => self.inner.transition(
                &[ClientState::Ready],
                ClientState::ShuttingDown,
                "shut down the server",
            )?,
            state => {
                return Err(LspError::InvalidState {
                    operation: "shut down the server",
                    state: state.to_string(),
                })
            }
        }

        let pending_ids = self.inner.fail_all_pending(LspError::SessionClosing);
        for id in pending_ids {
            self.inner.try_send_cancel(&id);
        }
        self.inner.cancel_server_requests();
        drop(admission);

        let shutdown_result = self
            .request_internal(
                "shutdown",
                Value::Null,
                self.inner.config.shutdown_timeout,
                None,
                &[ClientState::ShuttingDown],
            )
            .await;

        if shutdown_result.is_ok() {
            self.inner
                .termination_expected
                .store(true, Ordering::Release);
            if self
                .send_notification_internal("exit", None, self.inner.config.shutdown_timeout)
                .await
                .is_ok()
            {
                tracing::debug!("sent LSP exit notification");
            }
        }

        if self
            .wait_for_process_exit(self.inner.config.shutdown_timeout)
            .await
            .is_none()
        {
            self.inner
                .termination_expected
                .store(true, Ordering::Release);
            self.inner.request_process_kill();
            if self
                .wait_for_process_exit(self.inner.config.shutdown_timeout)
                .await
                .is_none()
            {
                self.cleanup_runtime().await;
                let error = LspError::ProcessTerminationFailed;
                self.inner
                    .termination_expected
                    .store(false, Ordering::Release);
                self.inner.fail_session(error.clone());
                return Err(error);
            }
        }

        self.cleanup_runtime().await;
        if self.state() != ClientState::Failed {
            self.inner.transition(
                &[ClientState::ShuttingDown],
                ClientState::Stopped,
                "finish server shutdown",
            )?;
        }
        Ok(())
    }

    async fn send_document_change(&self, document: &DocumentSnapshot) -> Result<(), LspError> {
        self.send_notification_internal(
            "textDocument/didChange",
            Some(json!({
                "textDocument": {"uri": document.uri, "version": document.version},
                "contentChanges": [{"text": document.content}],
            })),
            self.inner.config.request_timeout,
        )
        .await
    }

    async fn spawn_runtime(&self) -> Result<(), LspError> {
        let executable = self.inner.config.executable.clone();
        let mut command = background_tokio_command(&executable);
        command
            .args(&self.inner.config.arguments)
            .current_dir(&self.inner.config.working_directory)
            .envs(&self.inner.config.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        tracing::debug!(
            executable = %executable.display(),
            args = ?self.inner.config.arguments,
            cwd = %self.inner.config.working_directory.display(),
            "starting LSP server"
        );
        let mut child = command.spawn().map_err(|error| LspError::Spawn {
            executable: executable.display().to_string(),
            message: error.to_string(),
        })?;
        self.inner
            .process_id
            .store(child.id().unwrap_or(0), Ordering::Release);

        let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (Some(stdin), Some(stdout), Some(stderr)) = pipes else {
            let _ = child.kill().await;
            let _ = child.wait().await;
            self.inner.process_id.store(0, Ordering::Release);
            return Err(LspError::Protocol {
                message: "spawned LSP process did not expose all stdio pipes".to_string(),
            });
        };

        let (writer_tx, writer_rx) = mpsc::channel(OUTBOUND_CAPACITY);
        let (process_tx, process_rx) = mpsc::channel(PROCESS_CONTROL_CAPACITY);
        *lock(&self.inner.writer) = Some(writer_tx);
        *lock(&self.inner.process_control) = Some(process_tx);

        let writer_inner = self.inner.clone();
        let writer = tokio::spawn(async move { run_writer(writer_inner, stdin, writer_rx).await });
        let reader_inner = self.inner.clone();
        let reader = tokio::spawn(async move { run_reader(reader_inner, stdout).await });
        let stderr_inner = self.inner.clone();
        let stderr = tokio::spawn(async move { run_stderr(stderr_inner, stderr).await });
        let process_inner = self.inner.clone();
        let process =
            tokio::spawn(
                async move { run_process_supervisor(process_inner, child, process_rx).await },
            );
        *self.inner.runtime.lock().await = Some(RuntimeTasks {
            writer,
            reader,
            stderr,
            process,
        });
        Ok(())
    }

    async fn request_internal(
        &self,
        method: impl Into<String>,
        params: Value,
        request_timeout: Duration,
        cancellation: Option<CancellationToken>,
        allowed_states: &[ClientState],
    ) -> Result<Value, LspError> {
        let method = method.into();
        let deadline = Instant::now() + request_timeout;
        let admission = tokio::select! {
            admission = self.inner.admission_gate.lock() => admission,
            _ = wait_for_cancellation(cancellation.clone()) => {
                return Err(LspError::RequestCancelled { method });
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(timeout_error(method, request_timeout));
            }
        };
        self.inner.ensure_state(allowed_states, "send a request")?;
        if cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(LspError::RequestCancelled { method });
        }

        let id = JsonRpcId::Number(self.inner.next_request_id.fetch_add(1, Ordering::Relaxed) + 1);
        let (sender, receiver) = oneshot::channel();
        lock(&self.inner.pending).insert(
            id.clone(),
            PendingRequest {
                method: method.clone(),
                sender,
            },
        );
        let mut guard = PendingGuard {
            inner: self.inner.clone(),
            id: id.clone(),
            armed: true,
        };
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let send_result = tokio::select! {
            result = self.inner.send_json(message, remaining(deadline), false) => result,
            _ = wait_for_cancellation(cancellation.clone()) => {
                self.cancel_request(&id, &method, &mut guard);
                return Err(LspError::RequestCancelled { method });
            }
            _ = tokio::time::sleep_until(deadline) => {
                self.cancel_request(&id, &method, &mut guard);
                return Err(timeout_error(method, request_timeout));
            }
        };
        if let Err(error) = send_result {
            lock(&self.inner.pending).remove(&id);
            guard.disarm();
            return Err(error);
        }
        drop(admission);

        let result = tokio::select! {
            result = receiver => match result {
                Ok(result) => result,
                Err(_) => Err(LspError::TransportClosed),
            },
            _ = wait_for_cancellation(cancellation) => {
                self.cancel_request(&id, &method, &mut guard);
                Err(LspError::RequestCancelled { method })
            }
            _ = tokio::time::sleep_until(deadline) => {
                self.cancel_request(&id, &method, &mut guard);
                Err(timeout_error(method, request_timeout))
            }
        };
        guard.disarm();
        result
    }

    fn cancel_request(&self, id: &JsonRpcId, _method: &str, guard: &mut PendingGuard) {
        if lock(&self.inner.pending).remove(id).is_some() {
            self.inner.try_send_cancel(id);
        }
        guard.disarm();
    }

    async fn send_notification_internal(
        &self,
        method: impl Into<String>,
        params: Option<Value>,
        write_timeout: Duration,
    ) -> Result<(), LspError> {
        let mut message = Map::new();
        message.insert("jsonrpc".to_string(), Value::String("2.0".to_string()));
        message.insert("method".to_string(), Value::String(method.into()));
        if let Some(params) = params {
            message.insert("params".to_string(), params);
        }
        self.inner
            .send_json(Value::Object(message), write_timeout, false)
            .await
    }

    async fn wait_for_process_exit(&self, duration: Duration) -> Option<ProcessExit> {
        let mut receiver = self.inner.process_exit_tx.subscribe();
        if let Some(exit) = receiver.borrow().clone() {
            return Some(exit);
        }
        timeout(duration, async {
            loop {
                if receiver.changed().await.is_err() {
                    return None;
                }
                if let Some(exit) = receiver.borrow().clone() {
                    return Some(exit);
                }
            }
        })
        .await
        .ok()
        .flatten()
    }

    async fn force_terminate_and_cleanup(&self) {
        if self.inner.runtime.lock().await.is_none() {
            lock(&self.inner.writer).take();
            lock(&self.inner.process_control).take();
            return;
        }
        self.inner
            .termination_expected
            .store(true, Ordering::Release);
        self.inner.request_process_kill();
        let _ = self
            .wait_for_process_exit(self.inner.config.shutdown_timeout)
            .await;
        self.cleanup_runtime().await;
    }

    async fn cleanup_runtime(&self) {
        lock(&self.inner.writer).take();
        lock(&self.inner.process_control).take();
        let Some(runtime) = self.inner.runtime.lock().await.take() else {
            return;
        };
        let join_timeout = self.inner.config.shutdown_timeout;
        for mut handle in [
            runtime.writer,
            runtime.reader,
            runtime.stderr,
            runtime.process,
        ] {
            if timeout(join_timeout, &mut handle).await.is_err() {
                handle.abort();
                let _ = handle.await;
            }
        }
    }
}

impl Inner {
    fn state(&self) -> ClientState {
        *lock(&self.state)
    }

    fn transition(
        &self,
        expected: &[ClientState],
        next: ClientState,
        operation: &'static str,
    ) -> Result<(), LspError> {
        let previous = {
            let mut state = lock(&self.state);
            if !expected.contains(&*state) {
                return Err(LspError::InvalidState {
                    operation,
                    state: state.to_string(),
                });
            }
            let previous = *state;
            *state = next;
            previous
        };
        self.state_tx.send_replace(next);
        let _ = self.events.send(LspEvent::StateChanged {
            previous,
            current: next,
        });
        tracing::debug!(previous = %previous, current = %next, "LSP client state changed");
        Ok(())
    }

    fn ensure_state(
        &self,
        expected: &[ClientState],
        operation: &'static str,
    ) -> Result<(), LspError> {
        let state = self.state();
        if expected.contains(&state) {
            Ok(())
        } else {
            Err(LspError::InvalidState {
                operation,
                state: state.to_string(),
            })
        }
    }

    fn fail_session(&self, error: LspError) {
        let previous = {
            let mut state = lock(&self.state);
            if matches!(*state, ClientState::Failed | ClientState::Stopped)
                || (*state == ClientState::ShuttingDown
                    && self.termination_expected.load(Ordering::Acquire))
            {
                self.fail_all_pending(error);
                return;
            }
            let previous = *state;
            *state = ClientState::Failed;
            previous
        };
        self.state_tx.send_replace(ClientState::Failed);
        let _ = self.events.send(LspEvent::StateChanged {
            previous,
            current: ClientState::Failed,
        });
        let _ = self.events.send(LspEvent::ProcessFailed {
            error: error.clone(),
        });
        tracing::warn!(error = %error, "LSP session failed");
        self.fail_all_pending(error);
        self.cancel_server_requests();
        self.request_process_kill();
    }

    fn fail_all_pending(&self, error: LspError) -> Vec<JsonRpcId> {
        let pending = std::mem::take(&mut *lock(&self.pending));
        let mut ids = Vec::with_capacity(pending.len());
        for (id, request) in pending {
            ids.push(id);
            let _ = request.sender.send(Err(error.clone()));
        }
        ids
    }

    fn cancel_server_requests(&self) {
        let requests = std::mem::take(&mut *lock(&self.server_requests));
        for cancellation in requests.into_values() {
            cancellation.cancel();
        }
    }

    fn request_process_kill(&self) {
        if let Some(control) = lock(&self.process_control).as_ref() {
            let _ = control.try_send(ProcessCommand::Kill);
        }
    }

    async fn send_json(
        &self,
        message: Value,
        write_timeout: Duration,
        urgent: bool,
    ) -> Result<(), LspError> {
        let bytes = encode_message(&message, self.config.max_message_bytes)?;
        let sender = lock(&self.writer)
            .clone()
            .ok_or(LspError::TransportClosed)?;
        let (acknowledgement, receiver) = oneshot::channel();
        let outbound = Outbound {
            bytes,
            write_timeout,
            acknowledgement,
        };
        if urgent {
            sender
                .try_send(outbound)
                .map_err(|_| LspError::TransportClosed)?;
        } else {
            timeout(write_timeout, sender.send(outbound))
                .await
                .map_err(|_| LspError::Io {
                    operation: "queueing an LSP message",
                    message: "outbound queue did not accept the message before the deadline"
                        .to_string(),
                })?
                .map_err(|_| LspError::TransportClosed)?;
        }
        timeout(write_timeout, receiver)
            .await
            .map_err(|_| LspError::Io {
                operation: "writing an LSP message",
                message: "writer acknowledgement timed out".to_string(),
            })?
            .map_err(|_| LspError::TransportClosed)?
    }

    fn try_send_cancel(&self, id: &JsonRpcId) {
        let message = json!({
            "jsonrpc": "2.0",
            "method": "$/cancelRequest",
            "params": {"id": id},
        });
        self.try_send_json(message);
    }

    fn try_send_json(&self, message: Value) {
        let Ok(bytes) = encode_message(&message, self.config.max_message_bytes) else {
            return;
        };
        let Some(sender) = lock(&self.writer).clone() else {
            return;
        };
        let (acknowledgement, receiver) = oneshot::channel();
        drop(receiver);
        let _ = sender.try_send(Outbound {
            bytes,
            write_timeout: self.config.request_timeout,
            acknowledgement,
        });
    }

    fn stderr_snapshot(&self) -> String {
        lock(&self.stderr).snapshot()
    }
}

async fn run_writer(
    inner: Arc<Inner>,
    mut stdin: ChildStdin,
    mut receiver: mpsc::Receiver<Outbound>,
) {
    while let Some(outbound) = receiver.recv().await {
        let result = timeout(outbound.write_timeout, async {
            stdin
                .write_all(&outbound.bytes)
                .await
                .map_err(|error| LspError::Io {
                    operation: "writing to LSP stdin",
                    message: error.to_string(),
                })?;
            stdin.flush().await.map_err(|error| LspError::Io {
                operation: "flushing LSP stdin",
                message: error.to_string(),
            })
        })
        .await
        .unwrap_or_else(|_| {
            Err(LspError::Io {
                operation: "writing to LSP stdin",
                message: "write timed out".to_string(),
            })
        });
        let _ = outbound.acknowledgement.send(result.clone());
        if let Err(error) = result {
            inner.fail_session(error);
            break;
        }
    }
    let _ = stdin.shutdown().await;
}

async fn run_reader(inner: Arc<Inner>, mut stdout: ChildStdout) {
    let mut framer = match LspFramer::new(
        inner.config.max_message_bytes,
        inner.config.max_header_bytes,
    ) {
        Ok(framer) => framer,
        Err(error) => {
            inner.fail_session(error.into());
            return;
        }
    };
    let mut chunk = vec![0u8; IO_CHUNK_BYTES];
    loop {
        match stdout.read(&mut chunk).await {
            Ok(0) => {
                if let Err(error) = framer.finish() {
                    inner.fail_session(error.into());
                } else if !inner.termination_expected.load(Ordering::Acquire) {
                    inner.fail_session(LspError::TransportClosed);
                }
                return;
            }
            Ok(read) => match framer.push(&chunk[..read]) {
                Ok(messages) => {
                    for message in messages {
                        if let Err(error) = dispatch_message(inner.clone(), message).await {
                            inner.fail_session(error);
                            return;
                        }
                    }
                }
                Err(error) => {
                    inner.fail_session(error.into());
                    return;
                }
            },
            Err(error) => {
                inner.fail_session(LspError::Io {
                    operation: "reading LSP stdout",
                    message: error.to_string(),
                });
                return;
            }
        }
    }
}

async fn dispatch_message(inner: Arc<Inner>, message: Value) -> Result<(), LspError> {
    let object = message.as_object().ok_or_else(|| LspError::Protocol {
        message: "JSON-RPC message must be an object".to_string(),
    })?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(LspError::Protocol {
            message: "JSON-RPC message must declare version 2.0".to_string(),
        });
    }

    if let Some(method_value) = object.get("method") {
        let method = method_value
            .as_str()
            .ok_or_else(|| LspError::Protocol {
                message: "JSON-RPC method must be a string".to_string(),
            })?
            .to_string();
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id_value) = object.get("id").filter(|id| !id.is_null()) {
            let id = serde_json::from_value::<JsonRpcId>(id_value.clone()).map_err(|error| {
                LspError::Protocol {
                    message: format!("invalid server request id: {error}"),
                }
            })?;
            start_server_request(inner, id, method, params);
        } else {
            handle_notification(&inner, method, params);
        }
        return Ok(());
    }

    let id_value = object.get("id").ok_or_else(|| LspError::Protocol {
        message: "JSON-RPC response is missing an id".to_string(),
    })?;
    let id = serde_json::from_value::<JsonRpcId>(id_value.clone()).map_err(|error| {
        LspError::Protocol {
            message: format!("invalid response id: {error}"),
        }
    })?;
    let Some(pending) = lock(&inner.pending).remove(&id) else {
        let _ = inner.events.send(LspEvent::UnmatchedResponse { id });
        return Ok(());
    };
    let result = match (object.get("result"), object.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => {
            let error: JsonRpcErrorObject =
                serde_json::from_value(error.clone()).map_err(|error| LspError::Protocol {
                    message: format!("malformed JSON-RPC error response: {error}"),
                })?;
            Err(LspError::JsonRpc {
                method: pending.method.clone(),
                code: error.code,
                message: error.message,
                data: error.data,
            })
        }
        _ => Err(LspError::Protocol {
            message: "JSON-RPC response must contain exactly one of result or error".to_string(),
        }),
    };
    let _ = pending.sender.send(result);
    Ok(())
}

fn handle_notification(inner: &Arc<Inner>, method: String, params: Value) {
    let _ = inner.events.send(LspEvent::Notification {
        method: method.clone(),
        params: params.clone(),
    });
    match method.as_str() {
        "textDocument/publishDiagnostics" => {
            let _ = inner.events.send(LspEvent::Diagnostics { params });
        }
        "$/progress" => {
            let _ = inner.events.send(LspEvent::Progress { params });
        }
        "window/logMessage" | "window/showMessage" => {
            let _ = inner.events.send(LspEvent::LogMessage { method, params });
        }
        "$/cancelRequest" => {
            if let Some(id) = params
                .get("id")
                .cloned()
                .and_then(|id| serde_json::from_value::<JsonRpcId>(id).ok())
            {
                if let Some(cancellation) = lock(&inner.server_requests).get(&id) {
                    cancellation.cancel();
                }
            }
        }
        _ => {}
    }
}

fn start_server_request(inner: Arc<Inner>, id: JsonRpcId, method: String, params: Value) {
    let cancellation = CancellationToken::new();
    {
        let mut active = lock(&inner.server_requests);
        if active.contains_key(&id) {
            let response = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32600, "message": "Duplicate active server request id"},
            });
            inner.try_send_json(response);
            return;
        }
        active.insert(id.clone(), cancellation.clone());
    }

    tokio::spawn(async move {
        let request = ServerRequest {
            id: id.clone(),
            method: method.clone(),
            params,
            cancellation: cancellation.clone(),
        };
        let outcome = if let Some(handler) = inner.server_request_handler.clone() {
            let future = std::panic::AssertUnwindSafe(handler.handle(request)).catch_unwind();
            tokio::select! {
                _ = cancellation.cancelled() => ServerRequestResult::Error(JsonRpcErrorObject {
                    code: -32800,
                    message: "Request cancelled".to_string(),
                    data: None,
                }),
                result = timeout(inner.config.request_timeout, future) => match result {
                    Ok(Ok(outcome)) => outcome,
                    Ok(Err(_)) => ServerRequestResult::Error(JsonRpcErrorObject::internal_error(
                        "Server request handler panicked",
                    )),
                    Err(_) => ServerRequestResult::Error(JsonRpcErrorObject::internal_error(
                        "Server request handler timed out",
                    )),
                }
            }
        } else {
            ServerRequestResult::Unhandled
        };
        lock(&inner.server_requests).remove(&id);

        let response = match outcome {
            ServerRequestResult::Result(result) => {
                json!({"jsonrpc": "2.0", "id": id, "result": result})
            }
            ServerRequestResult::Error(error) => {
                json!({"jsonrpc": "2.0", "id": id, "error": error})
            }
            ServerRequestResult::Unhandled => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": JsonRpcErrorObject::method_not_found(&method),
            }),
        };
        let _ = inner
            .send_json(response, inner.config.request_timeout, false)
            .await;
    });
}

async fn run_stderr(inner: Arc<Inner>, mut stderr: ChildStderr) {
    let mut chunk = vec![0u8; IO_CHUNK_BYTES];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) => return,
            Ok(read) => {
                lock(&inner.stderr).append(&chunk[..read]);
                let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
                let _ = inner.events.send(LspEvent::ServerStderr { text });
            }
            Err(error) => {
                tracing::debug!(error = %error, "failed to drain LSP stderr");
                return;
            }
        }
    }
}

async fn run_process_supervisor(
    inner: Arc<Inner>,
    mut child: Child,
    mut controls: mpsc::Receiver<ProcessCommand>,
) {
    let wait_result = tokio::select! {
        result = child.wait() => result,
        command = controls.recv() => {
            match command {
                Some(ProcessCommand::Kill) | None => {
                    let _ = child.kill().await;
                    child.wait().await
                }
            }
        }
    };
    inner.process_id.store(0, Ordering::Release);
    let stderr = inner.stderr_snapshot();
    let exit = match wait_result {
        Ok(status) => ProcessExit {
            code: status.code(),
            success: status.success(),
            stderr,
        },
        Err(error) => ProcessExit {
            code: None,
            success: false,
            stderr: if stderr.is_empty() {
                error.to_string()
            } else {
                format!("{stderr}\n{error}")
            },
        },
    };
    inner.process_exit_tx.send_replace(Some(exit.clone()));
    let _ = inner.events.send(LspEvent::ProcessExited(exit.clone()));
    inner.fail_all_pending(LspError::ProcessExited {
        code: exit.code,
        stderr: exit.stderr.clone(),
    });
    if !inner.termination_expected.load(Ordering::Acquire) {
        inner.fail_session(LspError::ProcessExited {
            code: exit.code,
            stderr: exit.stderr,
        });
    }
}

async fn wait_for_cancellation(cancellation: Option<CancellationToken>) {
    match cancellation {
        Some(cancellation) => cancellation.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

fn timeout_error(method: String, duration: Duration) -> LspError {
    LspError::RequestTimeout {
        method,
        timeout_ms: duration.as_millis().min(u128::from(u64::MAX)) as u64,
    }
}
