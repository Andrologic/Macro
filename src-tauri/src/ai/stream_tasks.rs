//! Own a stream before admission can yield. Request IDs are single-use per process.
use crate::core::process::ContainedBackgroundProcess;
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
}

impl StreamTasks {
    /// Registration and cancellation share this synchronous lock. No provider
    /// work can be polled until its owner is installed in the registry.
    pub fn start<F>(&self, request_id: String, work: F) -> Result<(), String>
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
        let handle = tokio::spawn(async move {
            if admitted.await.is_ok() {
                work.await;
            }
        });
        entries.insert(
            request_id.clone(),
            Entry {
                abort: Some(handle.abort_handle()),
                admitted: true,
                finished: receiver,
                cleanups: Vec::new(),
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

    /// A cancel received before admission leaves a tombstone. IDs remain
    /// single-use so delayed starts, duplicate cancels and late starts cannot
    /// replace a previous owner. The registry is cleared only on process exit.
    /// A cancellation tombstone is not evidence that an earlier physical stream
    /// ended. Recovery must distinguish an owned task from an absent request.
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
                }
            });
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
    use crate::core::process::background_tokio_command;
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
