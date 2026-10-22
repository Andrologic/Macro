//! Stream registration and cancellation follow the actual task through cleanup.
use super::AiState;
use futures::future::{BoxFuture, FutureExt, Shared};
use std::future::Future;
use tokio_util::sync::CancellationToken;

pub(super) struct StreamTask {
    cancel: CancellationToken,
    joined: Shared<BoxFuture<'static, Result<(), String>>>,
}

impl AiState {
    pub(crate) async fn spawn_stream<F, Fut>(&self, request: String, run: F) -> Result<(), String>
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let mut tasks = self.stream_tasks.lock().await;
        if tasks.contains_key(&request) {
            return Err("chat_admission_request_active".into());
        }
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let state = self.clone();
        let task_request = request.clone();
        // Hold registration until insertion: even an immediately completed task
        // cannot remove its entry before that entry exists.
        let handle = tokio::spawn(async move {
            run(task_cancel).await;
            state.stream_tasks.lock().await.remove(&task_request);
        });
        let joined = async move {
            handle
                .await
                .map_err(|error| format!("AI stream task failed: {error}"))
        }
        .boxed()
        .shared();
        tasks.insert(request, StreamTask { cancel, joined });
        Ok(())
    }

    pub(crate) async fn cancel_stream_task(&self, request: &str) -> Result<(), String> {
        let joined = {
            let tasks = self.stream_tasks.lock().await;
            tasks.get(request).map(|task| {
                task.cancel.cancel();
                task.joined.clone()
            })
        };
        // The task removes itself under this mutex. Never join while holding it.
        if let Some(joined) = joined {
            joined.await?;
        }
        Ok(())
    }
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
        assert!(!state.stream_tasks.lock().await.contains_key("request"));
        state.cancel_stream_task("request").await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_reaps_real_child_and_joins_stderr_reader() {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};
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
            let result = finish_child_stream(&mut child, Some(reader), &cancel, false).await;
            // wait has reaped the process, not just requested termination.
            assert!(child.id().is_none());
            result
        });
        request_cancel.cancel();
        let (status, _) = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(!status.success());
    }
}
