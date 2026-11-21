//! Preserve cleanup results that rmcp otherwise only logs.
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::service::{QuitReason, RoleClient, RunningService, RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use rmcp::Service;

use super::runtime::McpRuntimeError;

pub(super) const SERVICE_CLOSE_BUDGET: Duration = Duration::from_secs(10);

#[derive(Clone, Default)]
pub(super) struct TransportCleanup(Arc<Mutex<CleanupResult>>);

#[derive(Default)]
struct CleanupResult {
    transport: Option<Result<(), String>>,
    http_delete: Option<Result<(), McpRuntimeError>>,
}

pub(super) struct ObservedTransport<T> {
    transport: T,
    cleanup: TransportCleanup,
}

impl TransportCleanup {
    pub(super) fn observe<T>(transport: T) -> (ObservedTransport<T>, Self) {
        let cleanup = Self::default();
        (
            ObservedTransport {
                transport,
                cleanup: cleanup.clone(),
            },
            cleanup,
        )
    }

    pub(super) fn observe_with<T>(&self, transport: T) -> ObservedTransport<T> {
        ObservedTransport {
            transport,
            cleanup: self.clone(),
        }
    }

    // The HTTP worker also logs DELETE failures/timeouts instead of returning
    // them. Record an unfinished attempt before awaiting it so cancellation
    // by the SDK's internal deadline cannot turn it into success.
    pub(super) async fn http_delete<E: std::fmt::Display>(
        &self,
        delete: impl Future<Output = Result<(), E>>,
    ) -> Result<(), E> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).http_delete =
            Some(Err(McpRuntimeError::new(
                "MCP_RUNTIME_CLOSE_TIMEOUT",
                "MCP HTTP session deletion did not complete.",
            )));
        let result = delete.await;
        self.0.lock().unwrap_or_else(|p| p.into_inner()).http_delete =
            Some(result.as_ref().map(|_| ()).map_err(|error| {
                McpRuntimeError::new(
                    "MCP_RUNTIME_CLOSE_FAILED",
                    format!("MCP HTTP session deletion failed: {error}"),
                )
            }));
        result
    }

    pub(super) async fn shutdown<S: Service<RoleClient>>(
        self,
        mut service: RunningService<RoleClient, S>,
        server_name: &str,
    ) -> Result<(), McpRuntimeError> {
        let failure = |message| {
            McpRuntimeError::new(
                "MCP_RUNTIME_CLOSE_FAILED",
                format!("MCP server '{server_name}' cleanup failed: {message}"),
            )
        };
        match service.close_with_timeout(SERVICE_CLOSE_BUDGET).await {
            Ok(None) => {
                return Err(McpRuntimeError::new(
                    "MCP_RUNTIME_CLOSE_TIMEOUT",
                    format!("MCP server '{server_name}' cleanup exceeded its 10-second budget."),
                ))
            }
            Err(error) | Ok(Some(QuitReason::JoinError(error))) => {
                return Err(failure(error.to_string()));
            }
            Ok(Some(QuitReason::Cancelled | QuitReason::Closed)) => {}
            Ok(Some(reason)) => {
                return Err(failure(format!("unexpected service exit: {reason:?}")))
            }
        }
        // rmcp 3.1.3 logs transport.close() errors and returns the service's
        // earlier quit reason. Read the actual transport result as well.
        let result = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(Err(error)) = &result.http_delete {
            return Err(error.clone());
        }
        match result.transport.as_ref() {
            Some(Ok(())) => Ok(()),
            Some(Err(error)) => Err(failure(error.clone())),
            None => Err(failure("transport cleanup did not complete".to_owned())),
        }
    }
}

impl<T: Transport<RoleClient>> Transport<RoleClient> for ObservedTransport<T> {
    type Error = T::Error;

    fn send(
        &mut self,
        message: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.transport.send(message)
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        self.transport.receive().await
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        let result = self.transport.close().await;
        self.cleanup
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .transport = Some(result.as_ref().map(|_| ()).map_err(ToString::to_string));
        result
    }
}

#[cfg(test)]
pub(super) mod fixture {
    use super::*;
    use rmcp::model::ProtocolVersion;
    use rmcp::service::{ClientLifecycleMode, ClientServiceExt};
    use tokio::sync::{mpsc, Notify};

    #[derive(Clone, Copy, Debug)]
    pub(crate) enum CloseBehavior {
        Success,
        Error,
        Panic,
        Timeout,
    }

    pub(crate) struct CloseControl {
        release: Arc<Notify>,
        dropped: Arc<Notify>,
    }

    impl CloseControl {
        pub(crate) async fn finish(self) {
            // close_with_timeout can leave the SDK task cleaning up in the
            // background. Explicitly release it and prove transport drop.
            self.release.notify_one();
            tokio::time::timeout(Duration::from_secs(2), self.dropped.notified())
                .await
                .expect("fixture transport must be dropped");
        }
    }

    struct CleanupTransport {
        behavior: CloseBehavior,
        responses: mpsc::UnboundedReceiver<RxJsonRpcMessage<RoleClient>>,
        sender: mpsc::UnboundedSender<RxJsonRpcMessage<RoleClient>>,
        release: Arc<Notify>,
        dropped: Arc<Notify>,
    }

    impl Drop for CleanupTransport {
        fn drop(&mut self) {
            self.dropped.notify_one();
        }
    }

    impl Transport<RoleClient> for CleanupTransport {
        type Error = std::io::Error;
        fn send(
            &mut self,
            message: TxJsonRpcMessage<RoleClient>,
        ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
            let sender = self.sender.clone();
            async move {
                let message = serde_json::to_value(message).unwrap();
                if let Some(id) = message.get("id") {
                    let result = match message["method"].as_str().unwrap() {
                        "initialize" => serde_json::json!({
                            "protocolVersion": "2025-11-25", "capabilities": {},
                            "serverInfo": {"name": "cleanup-fixture", "version": "1"}
                        }),
                        "server/discover" => {
                            serde_json::to_value(rmcp::model::DiscoverResult::new(
                                vec![ProtocolVersion::V_2026_07_28],
                                rmcp::model::ServerCapabilities::default(),
                            ))
                            .unwrap()
                        }
                        method => panic!("unexpected fixture request: {method}"),
                    };
                    sender
                        .send(
                            serde_json::from_value(serde_json::json!({
                                "jsonrpc": "2.0", "id": id, "result": result
                            }))
                            .unwrap(),
                        )
                        .unwrap();
                }
                Ok(())
            }
        }
        async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
            self.responses.recv().await
        }
        async fn close(&mut self) -> Result<(), Self::Error> {
            match self.behavior {
                CloseBehavior::Success => Ok(()),
                CloseBehavior::Error => {
                    Err(std::io::Error::other("synthetic transport cleanup error"))
                }
                CloseBehavior::Panic => panic!("synthetic transport cleanup panic"),
                CloseBehavior::Timeout => {
                    self.release.notified().await;
                    Ok(())
                }
            }
        }
    }

    pub(crate) async fn service<S: Service<RoleClient>>(
        handler: S,
        modern: bool,
        behavior: CloseBehavior,
    ) -> (
        RunningService<RoleClient, S>,
        TransportCleanup,
        CloseControl,
    ) {
        let (sender, responses) = mpsc::unbounded_channel();
        let release = Arc::new(Notify::new());
        let dropped = Arc::new(Notify::new());
        let (transport, cleanup) = TransportCleanup::observe(CleanupTransport {
            behavior,
            responses,
            sender,
            release: release.clone(),
            dropped: dropped.clone(),
        });
        let lifecycle = if modern {
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            }
        } else {
            ClientLifecycleMode::Initialize
        };
        let service = handler
            .serve_with_lifecycle(transport, lifecycle)
            .await
            .unwrap();
        (service, cleanup, CloseControl { release, dropped })
    }
}
