//! Stream registration and cancellation follow the actual task through cleanup.
use super::AiState;
use futures::future::{BoxFuture, FutureExt, Shared};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use tokio_util::sync::CancellationToken;

pub(super) struct StreamTask {
    cancel: CancellationToken,
    joined: Shared<BoxFuture<'static, Result<(), String>>>,
}

type SpawnedStream = Option<tokio::task::JoinHandle<Result<(), String>>>;

/// Owns the request from command admission, before asynchronous setup, until
/// the spawned task and its cleanup have returned. It is never serialized.
pub(crate) struct StreamReservation {
    state: AiState,
    request: String,
    cancel: CancellationToken,
    completion: Option<tokio::sync::oneshot::Sender<Result<SpawnedStream, String>>>,
}

impl Drop for StreamReservation {
    fn drop(&mut self) {
        // No await or user code runs under this mutex. Drop also covers command
        // setup failure and unwind, so cancellation cannot leave a stale slot.
        self.state
            .stream_tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.request);
        if let Some(completion) = self.completion.take() {
            let _ = completion.send(Err("AI stream setup did not complete.".into()));
        }
    }
}

impl StreamReservation {
    pub(crate) fn spawn<F, Fut>(mut self, run: F) -> Result<(), String>
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        if self.cancel.is_cancelled() {
            let completion = self.completion.take();
            drop(self);
            if let Some(completion) = completion {
                let _ = completion.send(Ok(None));
            }
            return Err("AI stream cancelled before launch.".into());
        }
        let completion = self.completion.take().expect("reserved stream completion");
        let handle = tokio::spawn(async move {
            let cancel = self.cancel.clone();
            let result = run_catching_panic(async move {
                // Cancellation may race spawn. Do not invoke the provider
                // closure if it won before the task first ran.
                if !cancel.is_cancelled() {
                    run(cancel).await;
                }
                Ok(())
            })
            .await;
            // Reservation drop happens after the provider future is dropped.
            drop(self);
            result
        });
        let _ = completion.send(Ok(Some(handle)));
        Ok(())
    }
}

impl AiState {
    pub(crate) fn reserve_stream(&self, request: String) -> Result<StreamReservation, String> {
        let mut tasks = self.stream_tasks.lock().unwrap_or_else(|e| e.into_inner());
        if tasks.contains_key(&request) {
            return Err("chat_admission_request_active".into());
        }
        let cancel = CancellationToken::new();
        let (completion, completed) =
            tokio::sync::oneshot::channel::<Result<SpawnedStream, String>>();
        let joined = async move {
            match completed
                .await
                .map_err(|_| "AI stream completion was lost.".to_string())??
            {
                Some(handle) => handle
                    .await
                    .map_err(|error| format!("AI stream task failed: {error}"))?,
                None => Ok(()),
            }
        }
        .boxed()
        .shared();
        tasks.insert(
            request.clone(),
            StreamTask {
                cancel: cancel.clone(),
                joined,
            },
        );
        Ok(StreamReservation {
            state: self.clone(),
            request,
            cancel,
            completion: Some(completion),
        })
    }

    #[cfg(test)]
    async fn spawn_stream<F, Fut>(&self, request: String, run: F) -> Result<(), String>
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.reserve_stream(request)?.spawn(run)
    }

    pub(crate) async fn cancel_stream_task(&self, request: &str) -> Result<(), String> {
        let joined = {
            let tasks = self.stream_tasks.lock().unwrap_or_else(|e| e.into_inner());
            tasks.get(request).map(|task| {
                task.cancel.cancel();
                task.joined.clone()
            })
        };
        // Setup or physical cleanup can still be running. Join outside the lock.
        if let Some(joined) = joined {
            joined.await?;
        }
        Ok(())
    }
}

/// Never resume a panicked provider future. Its owner still performs cleanup
/// and records an uncertain effect; the panic payload is not a wire receipt.
pub(super) async fn run_catching_panic<T>(
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    AssertUnwindSafe(future)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err("AI stream task panicked.".into()))
}

/// A cancelled processing future has already released its borrows and pipes.
/// Keep the actual process and stderr reader owned until both have finished.
pub(super) async fn finish_child_stream(
    child: &mut tokio::process::Child,
    stderr: Option<tokio::task::JoinHandle<String>>,
    cancel: &CancellationToken,
    processing_failed: bool,
) -> Result<(std::process::ExitStatus, String), String> {
    if processing_failed {
        let _ = child.start_kill();
    }
    let status = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            let _ = child.start_kill();
            child.wait().await
        },
        status = child.wait() => status,
    };
    let stderr_output = if let Some(mut task) = stderr {
        if processing_failed || status.is_err() {
            task.abort();
        }
        let joined = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                task.abort();
                task.await
            },
            output = &mut task => output,
        };
        match joined {
            Ok(output) => output,
            Err(error)
                if error.is_cancelled()
                    && (processing_failed || cancel.is_cancelled() || status.is_err()) =>
            {
                String::new()
            }
            Err(error) => return Err(format!("AI runtime stderr task failed: {error}")),
        }
    } else {
        String::new()
    };
    let status =
        status.map_err(|error| format!("Failed to wait for AI runtime process: {error}"))?;
    Ok((status, stderr_output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn cancellation_during_command_setup_prevents_provider_launch() {
        let state = AiState::default();
        // The command owns this reservation before its first pool/config await.
        let reservation = state.reserve_stream("setup".into()).unwrap();
        let cancellation = state.cancel_stream_task("setup");
        tokio::pin!(cancellation);
        assert!(futures::poll!(&mut cancellation).is_pending());
        assert!(state.reserve_stream("setup".into()).is_err());
        let invoked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = invoked.clone();
        assert!(reservation
            .spawn(move |_| async move {
                observed.store(true, std::sync::atomic::Ordering::SeqCst);
            })
            .is_err());
        cancellation.await.unwrap();
        assert!(!invoked.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.stream_tasks.lock().unwrap().contains_key("setup"));
    }

    #[tokio::test]
    async fn abandoned_command_setup_releases_slot_with_error() {
        let state = AiState::default();
        let reservation = state.reserve_stream("setup".into()).unwrap();
        let cancellation = state.cancel_stream_task("setup");
        tokio::pin!(cancellation);
        assert!(futures::poll!(&mut cancellation).is_pending());
        // The same Drop runs for a setup error, cancelled command future or panic.
        drop(reservation);
        assert_eq!(
            cancellation.await.unwrap_err(),
            "AI stream setup did not complete."
        );
        assert!(!state.stream_tasks.lock().unwrap().contains_key("setup"));
        assert!(state.reserve_stream("setup".into()).is_ok());
    }

    #[tokio::test]
    async fn cancellation_waits_for_cleanup_and_rejects_request_reuse() {
        let state = AiState::default();
        let (cancelled, observed) = oneshot::channel();
        let (release, cleanup) = oneshot::channel();
        state
            .spawn_stream("request".into(), move |cancel| async move {
                cancel.cancelled().await;
                cancelled.send(()).unwrap();
                cleanup.await.unwrap();
            })
            .await
            .unwrap();
        let cancelling_state = state.clone();
        let cancellation =
            tokio::spawn(async move { cancelling_state.cancel_stream_task("request").await });
        observed.await.unwrap();
        assert!(!cancellation.is_finished());
        assert!(state
            .spawn_stream("request".into(), |_| async {})
            .await
            .is_err());
        // An unrelated request can still complete during cleanup.
        let (done, unrelated) = oneshot::channel();
        state
            .spawn_stream("other".into(), |_| async move {
                done.send(()).unwrap();
            })
            .await
            .unwrap();
        unrelated.await.unwrap();
        release.send(()).unwrap();
        cancellation.await.unwrap().unwrap();
        assert!(!state.stream_tasks.lock().unwrap().contains_key("request"));
        state.cancel_stream_task("request").await.unwrap();
    }

    #[tokio::test]
    async fn panic_is_an_error_and_removes_registration_after_future_drop() {
        let state = AiState::default();
        let (release, ready) = oneshot::channel();
        state
            .spawn_stream("panic".into(), |_| async move {
                ready.await.unwrap();
                panic!("synthetic stream panic");
            })
            .await
            .unwrap();
        let joined = state
            .stream_tasks
            .lock()
            .unwrap()
            .get("panic")
            .unwrap()
            .joined
            .clone();
        release.send(()).unwrap();
        assert_eq!(joined.await.unwrap_err(), "AI stream task panicked.");
        assert!(!state.stream_tasks.lock().unwrap().contains_key("panic"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_and_panic_reap_real_child_and_join_stderr_reader() {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};
        for panics in [false, true] {
            let mut child = tokio::process::Command::new("sh")
                .args(["-c", "printf 'synthetic-ready\\n' >&2; read ignored"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let (ready, observed) = oneshot::channel();
            let stderr = child.stderr.take().unwrap();
            let reader = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                let first = lines.next_line().await.unwrap().unwrap();
                ready.send(first.clone()).unwrap();
                while lines.next_line().await.unwrap().is_some() {}
                first
            });
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(5), observed)
                    .await
                    .unwrap()
                    .unwrap(),
                "synthetic-ready"
            );
            assert!(child.try_wait().unwrap().is_none());
            let cancel = CancellationToken::new();
            let request_cancel = cancel.clone();
            let task = tokio::spawn(async move {
                let processing = run_catching_panic(async move {
                    if panics {
                        panic!("synthetic processing panic");
                    }
                    Ok(())
                })
                .await;
                assert_eq!(processing.is_err(), panics);
                let result =
                    finish_child_stream(&mut child, Some(reader), &cancel, processing.is_err())
                        .await;
                // wait has reaped the process, not just requested termination.
                assert!(child.id().is_none());
                result
            });
            if !panics {
                request_cancel.cancel();
            }
            let (status, _) = tokio::time::timeout(std::time::Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(!status.success());
        }
    }
}
