//! Bounded private runner protocol. A separate reader revokes admission on EOF
//! even while the host is compiling policy or waiting for approval.
use crate::db::agsdl_execution::{failure, Result};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, watch};
pub(crate) struct Client {
    stdin: ChildStdin,
    frames: mpsc::Receiver<Value>,
    alive: Arc<AtomicBool>,
    closed: watch::Sender<bool>,
    reader: tokio::task::JoinHandle<()>,
}
struct ReaderLease(Arc<AtomicBool>, watch::Sender<bool>);
impl Drop for ReaderLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
        let _ = self.1.send(false);
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.closed.send(false);
        self.reader.abort();
    }
}
impl Client {
    pub fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        let (sender, frames) = mpsc::channel(32);
        let (closed, _) = watch::channel(true);
        let alive = Arc::new(AtomicBool::new(true));
        let lease = ReaderLease(alive.clone(), closed.clone());
        let reader = tokio::spawn(async move {
            let _lease = lease;
            let mut stdout = BufReader::new(stdout);
            while let Ok(frame) = read_next(&mut stdout).await {
                if frame.get("method").and_then(Value::as_str) == Some("nativeExit") {
                    _lease.0.store(false, Ordering::SeqCst);
                    let _ = _lease.1.send(false);
                    continue;
                }
                if sender.try_send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            stdin,
            frames,
            alive,
            closed,
            reader,
        }
    }
    pub fn liveness(&self) -> Arc<AtomicBool> {
        self.alive.clone()
    }
    pub fn closure(&self) -> watch::Receiver<bool> {
        self.closed.subscribe()
    }
    pub async fn send(&mut self, message: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(message)?;
        if bytes.len() > 2_000_000 {
            return Err(failure(
                "UNSUPPORTED",
                "input",
                "Claude request exceeds the protocol limit",
            ));
        }
        bytes.push(b'\n');
        let result = async {
            self.stdin.write_all(&bytes).await?;
            self.stdin.flush().await
        }
        .await;
        if result.is_err() {
            self.alive.store(false, Ordering::SeqCst);
            let _ = self.closed.send(false);
            return Err(failure(
                "NATIVE_UNCERTAIN",
                "operation",
                "Claude request may have been sent",
            ));
        }
        Ok(())
    }
    pub async fn next(&mut self) -> Result<Value> {
        // Drain receipts already received before EOF. Tool dispatch separately
        // checks liveness, so a queued tool can never restore admission.
        self.frames.recv().await.ok_or_else(|| {
            failure(
                "NATIVE_UNCERTAIN",
                "stdio",
                "Claude runner channel is closed",
            )
        })
    }
}
async fn read_next(stdout: &mut BufReader<ChildStdout>) -> Result<Value> {
    let mut bytes = Vec::new();
    loop {
        let chunk = stdout
            .fill_buf()
            .await
            .map_err(|_| failure("NATIVE_UNCERTAIN", "stdio", "Claude protocol read failed"))?;
        if chunk.is_empty() {
            return Err(failure(
                "NATIVE_UNCERTAIN",
                "stdio",
                "Claude closed stdio without the required receipt",
            ));
        }
        let end = chunk.iter().position(|b| *b == b'\n').map(|i| i + 1);
        let count = end.unwrap_or(chunk.len());
        if bytes.len() + count > 2_000_000 {
            return Err(failure(
                "NATIVE_UNCERTAIN",
                "stdio",
                "Claude protocol frame exceeds the limit",
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
        stdout.consume(count);
        if end.is_some() {
            break;
        }
    }
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn eof_revokes_tool_admission_without_polling_protocol_frames() {
        let mut child = crate::core::process::background_tokio_command("/usr/bin/python3")
            .args([
                "-c",
                "import time;print('{\"method\":\"pendingApproval\"}',flush=True);time.sleep(0.05)",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut client = Client::new(child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let live = client.liveness();
        let mut closed = client.closure();
        child.wait().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while *closed.borrow_and_update() {
                closed.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert!(!live.load(Ordering::SeqCst));
        assert_eq!(client.next().await.unwrap()["method"], "pendingApproval");
        assert_eq!(client.next().await.unwrap_err().code, "NATIVE_UNCERTAIN");
    }
}
