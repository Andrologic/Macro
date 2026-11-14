//! Own a stream before admission can yield. Request IDs are single-use per process.
use crate::process::ContainedBackgroundProcess;
use std::collections::HashMap;
use std::future::Future;
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{oneshot, watch};
use tokio::task::{AbortHandle, JoinHandle};

type ProcessResult = Result<(ExitStatus, String), String>;

// Spawned tasks do not inherit this scope: a request ID alone cannot attest
// that the caller is the owned parent future.
tokio::task_local! {
    static OWNED_STREAM_SCOPE: (std::sync::Weak<Mutex<HashMap<String, Entry>>>, String);
}

/// Attribution only: this value is neither an admission nor an SQL grant.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct OwnedOperation030 {
    pub identity: crate::persistence::flow030::FlowIdentity030,
    pub context: crate::persistence::dto::EngineContext,
    pub generation: String,
    pub agent: String,
    pub provider_attempt_id: String,
    pub operation_id: String,
    pub method: String,
    pub request_json: String,
}

/// Single-use attachment, not a durable authorization. The transport must
/// consume the attached operation itself rather than reconstructing its bytes.
pub(crate) struct OwnedOperationPermit030 {
    operation: OwnedOperation030,
    digest: String,
    registry: std::sync::Weak<Mutex<HashMap<String, Entry>>>,
    parent_request_id: String,
}

/// Issued only by this registry after the matching parent and its cleanups
/// have completed. Its fields cannot be constructed by a caller.
#[derive(Clone)]
pub(crate) struct JoinedOwnedAgent030 {
    attempt: crate::agsdl_host_flow030::FlowWorkAttempt030,
    request_id: String,
}
impl JoinedOwnedAgent030 {
    pub(crate) fn attempt(&self) -> &crate::agsdl_host_flow030::FlowWorkAttempt030 {
        &self.attempt
    }
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }
}

fn agent_binding030(
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let raw = serde_json::to_vec(attempt).map_err(|_| "Cannot encode native agent binding")?;
    Ok(format!("{:x}", Sha256::digest(raw)))
}
impl OwnedOperationPermit030 {
    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }
    pub(crate) fn into_operation(self) -> Result<OwnedOperation030, String> {
        let entries = self.registry.upgrade().ok_or("Owned registry is gone.")?;
        let in_parent = OWNED_STREAM_SCOPE
            .try_with(|(registry, scoped_id)| {
                scoped_id == &self.parent_request_id
                    && registry
                        .upgrade()
                        .is_some_and(|scoped| Arc::ptr_eq(&scoped, &entries))
            })
            .unwrap_or(false);
        if !in_parent {
            return Err("Operation must be consumed by its owned parent.".into());
        }
        let guard = entries.lock().map_err(|_| "Stream registry poisoned")?;
        let parent = guard
            .get(&self.parent_request_id)
            .ok_or("Owned parent is absent.")?;
        if parent.cancelled
            || parent
                .abort
                .as_ref()
                .is_none_or(tokio::task::AbortHandle::is_finished)
            || parent.operations030.get(&self.operation.operation_id) != Some(&self.operation)
        {
            return Err("Owned operation is no longer active.".into());
        }
        Ok(self.operation)
    }
}

/// Dropping the stream requests tree termination; a separate supervisor owns
/// the process until bounded reap and pipe draining provide a receipt.
pub struct OwnedProcess {
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    _cancel: oneshot::Sender<()>,
    result: watch::Receiver<Option<ProcessResult>>,
}
impl OwnedProcess {
    pub async fn wait(&mut self) -> ProcessResult {
        loop {
            if let Some(result) = self.result.borrow_and_update().clone() {
                return result;
            }
            self.result
                .changed()
                .await
                .map_err(|_| "Process receipt channel closed")?;
        }
    }
}

#[derive(Clone, Default)]
pub struct StreamTasks {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

struct Entry {
    abort: Option<AbortHandle>,
    finished: watch::Receiver<Option<Result<(), String>>>,
    cleanups: Vec<JoinHandle<Result<(), String>>>,
    admitted: bool,
    cancelled: bool,
    operations030: HashMap<String, OwnedOperation030>,
    operations030_bytes: usize,
    owner030: Option<(crate::persistence::dto::EngineOwner, String)>,
    work030: Option<(
        crate::persistence::flow030::FlowIdentity030,
        crate::persistence::dto::EngineWork,
        String,
        String,
    )>,
    agent_binding030: Option<String>,
}

impl StreamTasks {
    /// Establish that this caller is the currently running native parent. This
    /// is attribution only and does not itself authorize an operation.
    pub(crate) fn verify_agent_scope030(
        &self,
        request_id: &str,
        attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    ) -> Result<(), String> {
        let in_parent = OWNED_STREAM_SCOPE
            .try_with(|(registry, scoped_id)| {
                scoped_id == request_id
                    && registry
                        .upgrade()
                        .is_some_and(|entries| Arc::ptr_eq(&entries, &self.entries))
            })
            .unwrap_or(false);
        if !in_parent {
            return Err("Operation is outside the owned parent".into());
        }
        let entries = self
            .entries
            .lock()
            .map_err(|_| "Stream registry poisoned")?;
        let parent = entries.get(request_id).ok_or("Owned parent is absent")?;
        if !parent.admitted
            || parent.cancelled
            || parent
                .abort
                .as_ref()
                .is_none_or(tokio::task::AbortHandle::is_finished)
            || parent.owner030.as_ref()
                != Some(&(attempt.owner().clone(), attempt.generation().to_owned()))
            || parent.work030.as_ref()
                != Some(&(
                    attempt.identity().clone(),
                    attempt.work().clone(),
                    attempt.agent().to_owned(),
                    attempt.provider_attempt_id().to_owned(),
                ))
            || parent.agent_binding030.as_deref() != Some(agent_binding030(attempt)?.as_str())
        {
            return Err("Owned parent attribution differs".into());
        }
        Ok(())
    }

    /// Registration and cancellation share this synchronous lock. No provider
    /// work can be polled until its owner is installed in the registry.
    pub fn start<F>(&self, request_id: String, work: F) -> Result<(), String>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.start_inner(request_id, None, None, None, work)
    }

    pub(crate) fn start_owned030<F>(
        &self,
        request_id: String,
        owner: crate::persistence::dto::EngineOwner,
        generation: String,
        work: F,
    ) -> Result<(), String>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.start_inner(request_id, Some((owner, generation)), None, None, work)
    }

    /// The opaque attempt is minted from a claimed native Start. It binds the
    /// parent to one exact work and provider attempt; it is not an SQL grant.
    pub(crate) fn start_agent030<F>(
        &self,
        request_id: String,
        attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
        work: F,
    ) -> Result<(), String>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.start_inner(
            request_id,
            Some((attempt.owner().clone(), attempt.generation().into())),
            Some((
                attempt.identity().clone(),
                attempt.work().clone(),
                attempt.agent().into(),
                attempt.provider_attempt_id().into(),
            )),
            Some(agent_binding030(attempt)?),
            work,
        )
    }

    // Production binding awaits native 036 admission; do not derive it from
    // the first operation. This constructor is available only to fixtures.
    #[cfg(test)]
    pub(crate) fn start_work_fixture030<F>(
        &self,
        request_id: String,
        identity: crate::persistence::flow030::FlowIdentity030,
        context: crate::persistence::dto::EngineContext,
        generation: String,
        agent: String,
        provider_attempt_id: String,
        work: F,
    ) -> Result<(), String>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.start_inner(
            request_id,
            Some((context.owner, generation)),
            Some((identity, context.work, agent, provider_attempt_id)),
            None,
            work,
        )
    }

    fn start_inner<F>(
        &self,
        request_id: String,
        owner030: Option<(crate::persistence::dto::EngineOwner, String)>,
        work030: Option<(
            crate::persistence::flow030::FlowIdentity030,
            crate::persistence::dto::EngineWork,
            String,
            String,
        )>,
        agent_binding030: Option<String>,
        work: F,
    ) -> Result<(), String>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Stream registry poisoned")?;
        if entries.contains_key(&request_id) {
            return Err("Stream request ID was already admitted or cancelled.".into());
        }
        let (start, admitted) = oneshot::channel();
        let (finished, receiver) = watch::channel(None);
        let scope = (Arc::downgrade(&self.entries), request_id.clone());
        let handle = tokio::spawn(async move {
            if admitted.await.is_ok() {
                OWNED_STREAM_SCOPE.scope(scope, work).await;
            }
        });
        entries.insert(
            request_id.clone(),
            Entry {
                abort: Some(handle.abort_handle()),
                admitted: true,
                finished: receiver,
                cleanups: Vec::new(),
                cancelled: false,
                operations030: HashMap::new(),
                operations030_bytes: 0,
                owner030,
                work030,
                agent_binding030,
            },
        );
        let registry = self.clone();
        // The supervisor owns the JoinHandle even if the cancellation caller
        // disappears. It confirms destruction of the owned future, not reversal
        // or termination of effects already dispatched outside this process.
        tokio::spawn(async move {
            let mut result = match handle.await {
                Ok(()) => Ok(()),
                Err(error) if error.is_cancelled() => Ok(()),
                Err(error) => Err(format!("Stream task failed: {error}")),
            };
            // The owned future is destroyed before these resources are joined.
            let cleanups = match registry.entries.lock() {
                Ok(mut entries) => entries
                    .get_mut(&request_id)
                    .map(|entry| {
                        entry.abort = None;
                        // Only the request tombstone and completion receipt survive
                        // the parent. Release request bodies and attribution after
                        // its future has been destroyed, before joining resources.
                        entry.operations030 = HashMap::new();
                        entry.operations030_bytes = 0;
                        entry.owner030 = None;
                        entry.work030 = None;
                        std::mem::take(&mut entry.cleanups)
                    })
                    .unwrap_or_default(),
                Err(_) => {
                    result = Err("Stream registry poisoned".into());
                    Vec::new()
                }
            };
            for cleanup in cleanups {
                let outcome = cleanup
                    .await
                    .unwrap_or_else(|error| Err(format!("Stream cleanup task failed: {error}")));
                if let Err(error) = outcome {
                    result = Err(error);
                }
            }
            finished.send_replace(Some(result));
        });
        let _ = start.send(());
        Ok(())
    }

    /// Called under the host handoff lock after durable claim. This attaches
    /// the exact operation to its current parent; it never grants authority.
    pub(crate) fn attach_operation030(
        &self,
        request_id: &str,
        operation: OwnedOperation030,
    ) -> Result<OwnedOperationPermit030, String> {
        use sha2::{Digest, Sha256};
        let in_parent = OWNED_STREAM_SCOPE
            .try_with(|(registry, scoped_id)| {
                scoped_id == request_id
                    && registry
                        .upgrade()
                        .is_some_and(|entries| Arc::ptr_eq(&entries, &self.entries))
            })
            .unwrap_or(false);
        if !in_parent {
            return Err("Operation is not running in its owned parent.".into());
        }
        if operation.operation_id.is_empty()
            || operation.agent.is_empty()
            || operation.provider_attempt_id.is_empty()
            || operation.generation.is_empty()
            || operation.method.is_empty()
            || operation.request_json.len() > 2_000_000
        {
            return Err("Native operation attribution is incomplete.".into());
        }
        let encoded = serde_json::to_vec(&operation)
            .map_err(|_| "Native operation attribution cannot be encoded.")?;
        let digest = format!("{:x}", Sha256::digest(&encoded));
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Stream registry poisoned")?;
        let parent = entries
            .get_mut(request_id)
            .ok_or("Owned parent is absent.")?;
        if !parent.admitted
            || parent.cancelled
            || parent
                .abort
                .as_ref()
                .is_none_or(tokio::task::AbortHandle::is_finished)
        {
            return Err("Owned parent has stopped or is stopping.".into());
        }
        if parent.owner030.as_ref()
            != Some(&(
                operation.context.owner.clone(),
                operation.generation.clone(),
            ))
        {
            return Err("Owned parent attribution differs.".into());
        }
        if parent.work030.as_ref()
            != Some(&(
                operation.identity.clone(),
                operation.context.work.clone(),
                operation.agent.clone(),
                operation.provider_attempt_id.clone(),
            ))
        {
            return Err("Owned parent work or provider attempt differs.".into());
        }
        if parent.operations030.contains_key(&operation.operation_id) {
            return Err("Native operation was already attached.".into());
        }
        let total = parent
            .operations030_bytes
            .checked_add(encoded.len())
            .filter(|total| *total <= 8_000_000)
            .ok_or("Owned operation attribution exceeds its bound.")?;
        if parent.operations030.len() >= 1000 {
            return Err("Too many operations attached to the owned parent.".into());
        }
        parent
            .operations030
            .insert(operation.operation_id.clone(), operation.clone());
        parent.operations030_bytes = total;
        Ok(OwnedOperationPermit030 {
            operation,
            digest,
            registry: Arc::downgrade(&self.entries),
            parent_request_id: request_id.into(),
        })
    }

    pub fn own_process(
        &self,
        request_id: &str,
        mut process: ContainedBackgroundProcess,
    ) -> Result<OwnedProcess, String> {
        let stdin = process.take_stdin();
        let stdout = process.take_stdout();
        let stderr = process.take_stderr();
        let (cancel, cancelled) = oneshot::channel::<()>();
        let (receipt, result) = watch::channel(None);
        let cleanup = tokio::spawn(async move {
            let stderr_read =
                async move {
                    let mut output = Vec::new();
                    if let Some(stderr) = stderr {
                        let mut lines = BufReader::new(stderr).lines();
                        while let Some(line) = lines.next_line().await.map_err(|error| {
                            format!("Failed to drain AI runtime stderr: {error}")
                        })? {
                            if !line.trim().is_empty() {
                                output.push(line.trim().to_owned());
                            }
                        }
                    }
                    Ok::<_, String>(output.join("\n"))
                };
            let process_end = async {
                let status = tokio::select! {
                    status = process.wait() => status.map_err(|error| format!("Failed to wait for AI runtime process: {error}"))?,
                    _ = cancelled => return process.terminate_with_grace(Duration::ZERO).await.map_err(|error| format!("AI runtime stop was not confirmed: {error}")),
                };
                // A leader exiting is not proof that its descendants exited.
                process
                    .terminate_with_grace(Duration::ZERO)
                    .await
                    .map_err(|error| format!("AI runtime tree end was not confirmed: {error}"))?;
                Ok(status)
            };
            let mut stderr_task = tokio::spawn(stderr_read);
            let status = process_end.await;
            let stderr = match tokio::time::timeout(Duration::from_secs(1), &mut stderr_task).await
            {
                Ok(result) => result
                    .unwrap_or_else(|error| Err(format!("AI runtime stderr task failed: {error}"))),
                Err(_) => {
                    stderr_task.abort();
                    let _cancelled = stderr_task.await;
                    Err("AI runtime stderr drain was not confirmed".to_string())
                }
            };
            let outcome = status.and_then(|status| stderr.map(|stderr| (status, stderr)));
            let cleanup = outcome.as_ref().map(|_| ()).map_err(Clone::clone);
            receipt.send_replace(Some(outcome));
            cleanup
        });
        // No await between spawning the resource owner and attaching its receipt.
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Stream registry poisoned")?;
        let entry = entries
            .get_mut(request_id)
            .ok_or("Stream resource has no owner")?;
        entry.cleanups.push(cleanup);
        Ok(OwnedProcess {
            stdin,
            stdout,
            _cancel: cancel,
            result,
        })
    }

    /// Attach an effect owner before awaiting it. The parent joins this task
    /// even if its work future is cancelled or dropped.
    pub(crate) fn attach_cleanup030(
        &self,
        request_id: &str,
        cleanup: tokio::task::JoinHandle<Result<(), String>>,
    ) -> Result<(), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Stream registry poisoned")?;
        let entry = entries
            .get_mut(request_id)
            .ok_or("Stream resource has no owner")?;
        entry.cleanups.push(cleanup);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn attach_test_cleanup030(
        &self,
        request_id: &str,
        cleanup: tokio::task::JoinHandle<Result<(), String>>,
    ) -> Result<(), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Stream registry poisoned")?;
        let entry = entries
            .get_mut(request_id)
            .ok_or("Stream resource has no owner")?;
        entry.cleanups.push(cleanup);
        Ok(())
    }

    /// A cancel received before admission leaves a tombstone. IDs remain
    /// single-use so delayed starts, duplicate cancels and late starts cannot
    /// replace a previous owner. The registry is cleared only on process exit.
    /// A cancellation tombstone is not evidence that an earlier physical stream
    /// ended. Recovery must distinguish an owned task from an absent request.
    /// Verify the complete native attribution before waiting or cancelling.
    /// The digest survives cleanup, without retaining request bodies or context.
    pub(crate) async fn join_agent030(
        &self,
        attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
        cancel: bool,
    ) -> Result<JoinedOwnedAgent030, String> {
        let request_id = format!(
            "flow030:{}:{}",
            attempt.identity().system_start_id,
            attempt.start_effect_id()
        );
        let expected = agent_binding030(attempt)?;
        let mut finished = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "Stream registry poisoned")?;
            let entry = entries
                .get_mut(&request_id)
                .ok_or("Owned parent is absent")?;
            if !entry.admitted || entry.agent_binding030.as_deref() != Some(expected.as_str()) {
                return Err("Owned parent attribution differs".into());
            }
            if cancel {
                entry.cancelled = true;
                if let Some(abort) = &entry.abort {
                    abort.abort();
                }
            }
            entry.finished.clone()
        };
        loop {
            if let Some(result) = finished.borrow_and_update().clone() {
                result?;
                return Ok(JoinedOwnedAgent030 {
                    attempt: attempt.clone(),
                    request_id,
                });
            }
            finished
                .changed()
                .await
                .map_err(|_| "Stream completion was not confirmed")?;
        }
    }

    pub async fn cancel_owned(&self, request_id: &str) -> Result<bool, String> {
        let admitted = self
            .entries
            .lock()
            .map_err(|_| "Stream registry poisoned")?
            .get(request_id)
            .is_some_and(|entry| entry.admitted);
        self.cancel(request_id).await?;
        Ok(admitted)
    }

    pub async fn cancel(&self, request_id: &str) -> Result<(), String> {
        let mut finished = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "Stream registry poisoned")?;
            let entry = entries.entry(request_id.into()).or_insert_with(|| {
                let (_, receiver) = watch::channel(Some(Ok(())));
                Entry {
                    abort: None,
                    admitted: false,
                    finished: receiver,
                    cleanups: Vec::new(),
                    cancelled: true,
                    operations030: HashMap::new(),
                    operations030_bytes: 0,
                    owner030: None,
                    work030: None,
                    agent_binding030: None,
                }
            });
            entry.cancelled = true;
            if let Some(abort) = &entry.abort {
                abort.abort();
            }
            entry.finished.clone()
        };
        loop {
            if let Some(result) = finished.borrow_and_update().clone() {
                return result;
            }
            finished
                .changed()
                .await
                .map_err(|_| "Stream completion was not confirmed")?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn operation030() -> OwnedOperation030 {
        OwnedOperation030 {
            identity: crate::persistence::flow030::FlowIdentity030 {
                system_start_id: "system".into(),
                flow_invocation_id: "flow".into(),
                snapshot_id: "snapshot".into(),
                epoch: "capture".into(),
            },
            context: serde_json::from_value(serde_json::json!({
                "owner":{"systemStartId":"system","ownerEpoch":"3"},
                "work":{"systemStartId":"system","flowInvocationId":"flow",
                    "activationId":"activation","agentInstanceId":"agent","step":["work"]},
                "permissionsJson":"{}","scopeJson":"{}","registryVersion":"registry"
            }))
            .unwrap(),
            generation: "generation".into(),
            agent: "worker".into(),
            provider_attempt_id: "attempt".into(),
            operation_id: "operation".into(),
            method: "turn/start".into(),
            request_json: r#"{"value":1e0}"#.into(),
        }
    }

    #[tokio::test]
    async fn failed_cleanup_never_produces_an_agent_join_witness() {
        use crate::agsdl_host_flow030::FlowWorkAttempt030;

        let registry = StreamTasks::default();
        // This test exercises registry evidence only, with no SQL admission.
        let attempt = FlowWorkAttempt030::registry_fixture030("attempt");
        let foreign = FlowWorkAttempt030::registry_fixture030("foreign-attempt");
        let request_id = format!(
            "flow030:{}:{}",
            attempt.identity().system_start_id,
            attempt.start_effect_id()
        );
        let (started, running) = oneshot::channel();
        registry
            .start_agent030(request_id.clone(), &attempt, async move {
                started.send(()).unwrap();
                std::future::pending::<()>().await;
            })
            .unwrap();
        running.await.unwrap();
        registry
            .entries
            .lock()
            .unwrap()
            .get_mut(&request_id)
            .unwrap()
            .cleanups
            .push(tokio::spawn(async {
                Err("synthetic cleanup failure".to_string())
            }));

        let foreign_error = tokio::time::timeout(
            Duration::from_secs(2),
            registry.join_agent030(&foreign, true),
        )
        .await
        .expect("foreign attribution must be rejected without waiting")
        .err()
        .expect("foreign attribution cannot produce a witness");
        assert_eq!(foreign_error, "Owned parent attribution differs");
        assert!(!registry.entries.lock().unwrap()[&request_id].cancelled);

        for _ in 0..2 {
            let cleanup_error = tokio::time::timeout(
                Duration::from_secs(2),
                registry.join_agent030(&attempt, true),
            )
            .await
            .expect("the cancelled parent and cleanup must finish")
            .err()
            .expect("failed cleanup cannot produce a witness, including on retry");
            assert_eq!(cleanup_error, "synthetic cleanup failure");
        }
        let entries = registry.entries.lock().unwrap();
        assert_eq!(entries.len(), 1);
        let tombstone = &entries[&request_id];
        assert!(tombstone.admitted && tombstone.cancelled && tombstone.abort.is_none());
        assert!(tombstone.cleanups.is_empty());
        assert!(tombstone.operations030.is_empty());
        assert!(tombstone.owner030.is_none() && tombstone.work030.is_none());
        assert_eq!(
            tombstone.finished.borrow().as_ref(),
            Some(&Err("synthetic cleanup failure".to_string()))
        );
        drop(entries);
        assert!(registry.start(request_id, async {}).is_err());
    }

    #[tokio::test]
    async fn operation_is_attached_once_only_by_its_running_parent() {
        let registry = StreamTasks::default();
        assert!(registry
            .attach_operation030("parent", operation030())
            .is_err());
        let inside = registry.clone();
        let (tx, rx) = oneshot::channel();
        registry
            .start_work_fixture030(
                "parent".into(),
                operation030().identity,
                operation030().context,
                "generation".into(),
                "worker".into(),
                "attempt".into(),
                async move {
                    let operation = operation030();
                    let mut foreign_owner = operation.clone();
                    foreign_owner.context.owner.owner_epoch = "different".into();
                    assert!(inside.attach_operation030("parent", foreign_owner).is_err());
                    let mut foreign_generation = operation.clone();
                    foreign_generation.generation = "different".into();
                    assert!(inside
                        .attach_operation030("parent", foreign_generation)
                        .is_err());
                    let mut foreign_work = operation.clone();
                    foreign_work.context.work.activation_id = "other-work".into();
                    foreign_work.operation_id = "foreign-work".into();
                    let work_refused = inside.attach_operation030("parent", foreign_work).is_err();
                    let mut foreign_attempt = operation.clone();
                    foreign_attempt.provider_attempt_id = "other-attempt".into();
                    foreign_attempt.operation_id = "foreign-attempt".into();
                    let attempt_refused = inside
                        .attach_operation030("parent", foreign_attempt)
                        .is_err();
                    let mut foreign_step = operation.clone();
                    foreign_step.context.work.step = Some(vec!["other-step".into()]);
                    foreign_step.operation_id = "foreign-step".into();
                    let step_refused = inside.attach_operation030("parent", foreign_step).is_err();
                    let mut foreign_instance = operation.clone();
                    foreign_instance.context.work.agent_instance_id = Some("other-instance".into());
                    foreign_instance.operation_id = "foreign-instance".into();
                    let instance_refused = inside.attach_operation030("parent", foreign_instance).is_err();
                    let mut foreign_agent = operation.clone();
                    foreign_agent.agent = "other-agent".into();
                    foreign_agent.operation_id = "foreign-agent".into();
                    let agent_refused = inside.attach_operation030("parent", foreign_agent).is_err();
                    let mut foreign_snapshot = operation.clone();
                    foreign_snapshot.identity.snapshot_id = "other-snapshot".into();
                    foreign_snapshot.operation_id = "foreign-snapshot".into();
                    let snapshot_refused = inside.attach_operation030("parent", foreign_snapshot).is_err();
                    let mut foreign_epoch = operation.clone();
                    foreign_epoch.identity.epoch = "other-epoch".into();
                    foreign_epoch.operation_id = "foreign-epoch".into();
                    let epoch_refused = inside.attach_operation030("parent", foreign_epoch).is_err();
                    assert!(
                        work_refused && attempt_refused && step_refused && instance_refused && agent_refused && snapshot_refused && epoch_refused,
                        "work: {work_refused}; attempt: {attempt_refused}; step: {step_refused}; instance: {instance_refused}; agent: {agent_refused}; snapshot: {snapshot_refused}; epoch: {epoch_refused}"
                    );
                    let permit = inside
                        .attach_operation030("parent", operation.clone())
                        .unwrap();
                    assert_eq!(permit.digest().len(), 64);
                    assert_eq!(permit.into_operation().unwrap(), operation);
                    let mut detached = operation.clone();
                    detached.operation_id = "detached".into();
                    let permit = inside.attach_operation030("parent", detached).unwrap();
                    assert!(
                        tokio::spawn(async move { permit.into_operation().is_err() })
                            .await
                            .unwrap()
                    );
                    assert!(inside
                        .attach_operation030("parent", operation.clone())
                        .is_err());
                    assert!(inside
                        .attach_operation030("other", operation.clone())
                        .is_err());
                    assert!(StreamTasks::default()
                        .attach_operation030("parent", operation)
                        .is_err());
                    tx.send(()).unwrap();
                    std::future::pending::<()>().await;
                },
            )
            .unwrap();
        rx.await.unwrap();
        let entries = registry.entries.lock().unwrap();
        let stored = &entries["parent"].operations030["operation"];
        assert_eq!(stored.request_json, r#"{"value":1e0}"#);
        assert_eq!(stored.provider_attempt_id, "attempt");
        drop(entries);
        assert!(registry.cancel_owned("parent").await.unwrap());
        assert!(registry
            .attach_operation030("parent", operation030())
            .is_err());
    }

    async fn finished_parent_releases_operation_data(cancel: bool) {
        let registry = StreamTasks::default();
        let inside = registry.clone();
        let (attached, observed) = oneshot::channel();
        let (finish, finishing) = oneshot::channel();
        registry
            .start_work_fixture030(
                "parent".into(),
                operation030().identity,
                operation030().context,
                "generation".into(),
                "worker".into(),
                "attempt".into(),
                async move {
                    let mut operation = operation030();
                    operation.request_json = format!(r#"{{"content":"{}"}}"#, "x".repeat(65_536));
                    for id in ["first", "second"] {
                        operation.operation_id = id.into();
                        inside
                            .attach_operation030("parent", operation.clone())
                            .unwrap()
                            .into_operation()
                            .unwrap();
                    }
                    attached.send(()).unwrap();
                    let _ = finishing.await;
                },
            )
            .unwrap();
        observed.await.unwrap();
        let mut completion = {
            let entries = registry.entries.lock().unwrap();
            let active = &entries["parent"];
            assert_eq!(active.operations030.len(), 2);
            assert!(active.operations030_bytes > 131_072);
            assert!(active.owner030.is_some() && active.work030.is_some());
            active.finished.clone()
        };
        if cancel {
            registry.cancel("parent").await.unwrap();
        } else {
            finish.send(()).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while completion.borrow_and_update().is_none() {
                completion.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(completion.borrow().as_ref(), Some(&Ok(())));
        {
            let entries = registry.entries.lock().unwrap();
            let tombstone = &entries["parent"];
            assert!(tombstone.admitted && tombstone.abort.is_none());
            assert!(tombstone.operations030.is_empty());
            assert_eq!(tombstone.operations030.capacity(), 0);
            assert_eq!(tombstone.operations030_bytes, 0);
            assert!(tombstone.owner030.is_none() && tombstone.work030.is_none());
        }
        assert!(registry.start("parent".into(), async {}).is_err());
        registry.cancel("parent").await.unwrap();
        assert!(registry
            .attach_operation030("parent", operation030())
            .is_err());
    }

    #[tokio::test]
    async fn completed_parent_releases_request_data_but_keeps_its_tombstone() {
        finished_parent_releases_operation_data(false).await;
    }

    #[tokio::test]
    async fn cancelled_parent_releases_request_data_but_keeps_its_tombstone() {
        finished_parent_releases_operation_data(true).await;
    }

    #[tokio::test]
    async fn spawned_child_cannot_attach_using_its_parents_id() {
        let registry = StreamTasks::default();
        let inside = registry.clone();
        let (tx, rx) = oneshot::channel();
        registry
            .start_work_fixture030(
                "parent".into(),
                operation030().identity,
                operation030().context,
                "generation".into(),
                "worker".into(),
                "attempt".into(),
                async move {
                    let child = tokio::spawn(async move {
                        inside
                            .attach_operation030("parent", operation030())
                            .is_err()
                    });
                    tx.send(child.await.unwrap()).unwrap();
                },
            )
            .unwrap();
        assert!(rx.await.unwrap());
        registry.cancel("parent").await.unwrap();
    }

    #[tokio::test]
    async fn owner_only_parent_cannot_choose_work_from_its_first_operation() {
        let registry = StreamTasks::default();
        let inner = registry.clone();
        let (done, result) = oneshot::channel();
        registry
            .start_owned030(
                "parent".into(),
                operation030().context.owner,
                "generation".into(),
                async move {
                    let _ = done.send(inner.attach_operation030("parent", operation030()).is_err());
                },
            )
            .unwrap();
        assert!(result.await.unwrap());
        registry.cancel("parent").await.unwrap();
    }

    #[tokio::test]
    async fn cancel_before_admission_and_duplicate_start_never_poll_work() {
        let registry = StreamTasks::default();
        registry.cancel("early").await.unwrap();
        assert!(registry
            .start("early".into(), async { panic!("cancelled work polled") })
            .is_err());
        registry
            .start("active".into(), std::future::pending())
            .unwrap();
        assert!(registry
            .start("active".into(), async { panic!("duplicate work polled") })
            .is_err());
        registry.cancel("active").await.unwrap();
        registry.cancel("active").await.unwrap();
        assert!(registry.start("active".into(), async {}).is_err());
    }

    struct DropProof(Arc<AtomicBool>);
    impl Drop for DropProof {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn cancellation_waits_for_owned_future_destruction_during_admission() {
        let registry = StreamTasks::default();
        let dropped = Arc::new(AtomicBool::new(false));
        let proof = DropProof(dropped.clone());
        registry
            .start("admission".into(), async move {
                let _proof = proof;
                std::future::pending::<()>().await;
            })
            .unwrap();
        registry.cancel("admission").await.unwrap();
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_cancels_both_wait_for_the_executor_and_preserve_other_owner() {
        let registry = StreamTasks::default();
        let dropped = Arc::new(AtomicBool::new(false));
        let proof = DropProof(dropped.clone());
        let (running, started) = oneshot::channel();
        registry
            .start("running".into(), async move {
                let _proof = proof;
                let _ = running.send(());
                std::future::pending::<()>().await;
            })
            .unwrap();
        registry
            .start("other".into(), std::future::pending())
            .unwrap();
        started.await.unwrap();
        let (first, second) = tokio::join!(registry.cancel("running"), registry.cancel("running"));
        first.unwrap();
        second.unwrap();
        assert!(dropped.load(Ordering::SeqCst));
        assert!(registry.entries.lock().unwrap()["other"].abort.is_some());
        registry.cancel("other").await.unwrap();
    }

    #[tokio::test]
    async fn immediate_completion_and_late_cancel_do_not_allow_reuse() {
        let registry = StreamTasks::default();
        registry.start("fast".into(), async {}).unwrap();
        tokio::task::yield_now().await;
        registry.cancel("fast").await.unwrap();
        assert!(registry.start("fast".into(), async {}).is_err());
    }
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    use crate::process::background_tokio_command;
    use std::process::Stdio;

    #[tokio::test]
    async fn cancel_joins_copilot_process_tree_and_stderr_receipt() {
        let registry = StreamTasks::default();
        let owned = registry.clone();
        let (started, ready) = oneshot::channel();
        let mut command = background_tokio_command("/bin/sh");
        command
            .args(["-c", "printf 'synthetic stderr\\n' >&2; sleep 30 & wait"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let process = ContainedBackgroundProcess::spawn(command).unwrap();
        let pid = process.id().unwrap();
        registry
            .start("synthetic-copilot".into(), async move {
                let mut process = owned.own_process("synthetic-copilot", process).unwrap();
                let _ = started.send(());
                let _ = process.wait().await;
            })
            .unwrap();
        ready.await.unwrap();
        tokio::time::timeout(Duration::from_secs(8), registry.cancel("synthetic-copilot"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
        assert!(registry.entries.lock().unwrap()["synthetic-copilot"]
            .cleanups
            .is_empty());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[tokio::test]
    async fn recovery_distinguishes_tombstones_from_joined_streams() {
        let tasks = StreamTasks::default();
        assert!(!tasks.cancel_owned("missing").await.unwrap());
        assert!(!tasks.cancel_owned("missing").await.unwrap());
        tasks.start("owned".into(), std::future::pending()).unwrap();
        assert!(tasks.cancel_owned("owned").await.unwrap());
        assert!(tasks.cancel_owned("owned").await.unwrap());
        assert!(tasks.start("missing".into(), async {}).is_err());
    }
}
