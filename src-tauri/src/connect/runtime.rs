use super::codec::{Codec, Input, Output};
use crate::{
    connect_resources::{TransitInstance, TRANSIT_OWNER},
    core::db_state::{ChatWorkLifetime, DbPool},
};
use futures::{future::BoxFuture, FutureExt};
use std::{
    path::Path,
    sync::{Arc, LazyLock, Mutex},
};
use tokio::{
    process::Command,
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

// One native PC domain for this application process, including overlapping retired
// generations. Never supplied by IPC or regenerated for a connection/window.
static PC: LazyLock<uuid::Uuid> = LazyLock::new(uuid::Uuid::new_v4);
type Join = futures::future::Shared<BoxFuture<'static, bool>>;
#[derive(Default)]
struct State {
    closed: bool,
    active: bool,
    join: Option<Join>,
    cancel: Option<CancellationToken>,
    quarantine: Option<Codec>,
}
#[derive(Clone, Default)]
pub(crate) struct TransferRuntime(Arc<Mutex<State>>);
pub(crate) struct CodecHandle {
    sender: mpsc::Sender<Request>,
    cancel: CancellationToken,
    join: Join,
}
struct Request {
    input: Input,
    response: oneshot::Sender<Result<Output, &'static str>>,
}
impl Drop for CodecHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
impl CodecHandle {
    pub(crate) async fn run(&self, input: Input) -> Result<Output, &'static str> {
        // Disappearance of an in-flight caller retires the process. The owner,
        // not this future, keeps the pipes, credits and join.
        let guard = self.cancel.clone().drop_guard();
        let (response, receive) = oneshot::channel();
        self.sender
            .try_send(Request { input, response })
            .map_err(|_| "codec_busy")?;
        let result = receive.await.map_err(|_| "codec_closed")?;
        guard.disarm();
        result
    }
    pub(crate) async fn close(self) -> Result<(), &'static str> {
        self.cancel.cancel();
        if self.join.clone().await {
            Ok(())
        } else {
            Err("codec_unreconciled")
        }
    }
}
impl TransferRuntime {
    pub(crate) fn budget(&self) -> Result<TransitInstance, &'static str> {
        TRANSIT_OWNER
            .instance(*PC)
            .map_err(|_| "transit_unavailable")
    }
    pub(crate) async fn start_codec(
        &self,
        app: &tauri::AppHandle,
        db: &DbPool,
    ) -> Result<CodecHandle, &'static str> {
        let path = crate::ai::copilot::resolve_bridge_path(app).map_err(|_| "codec_unavailable")?;
        let source = db
            .source_ready(None)
            .await
            .map_err(|_| "database_unavailable")?;
        let lifetime = source.ready.retain_chat_work();
        let result = self.start(Command::new(path), lifetime).await;
        drop(source);
        result
    }
    async fn start(
        &self,
        mut command: Command,
        lifetime: ChatWorkLifetime,
    ) -> Result<CodecHandle, &'static str> {
        let budget = self.budget()?;
        // No await between checking singleton ownership and publishing its join.
        let mut state = self.0.lock().map_err(|_| "transport_unavailable")?;
        if state.closed || state.active || state.quarantine.is_some() {
            return Err("codec_busy");
        }
        if state
            .join
            .as_ref()
            .is_some_and(|join| join.clone().now_or_never().is_none())
        {
            return Err("codec_busy");
        }
        state.join = None;
        command.arg("connect-codec");
        let codec = Codec::spawn(command, budget, lifetime)?;
        let cancel = CancellationToken::new();
        let (sender, mut receiver) = mpsc::channel::<Request>(1);
        let task_cancel = cancel.clone();
        let owner = self.0.clone();
        state.active = true;
        state.cancel = Some(cancel.clone());
        let task = tokio::spawn(async move {
            let mut codec = codec;
            let work = async {
                tokio::select! {
                    _ = task_cancel.cancelled() => return Err("codec_cancelled"),
                    hello = tokio::time::timeout(std::time::Duration::from_secs(10), codec.hello()) => hello.map_err(|_| "codec_timeout")??,
                }
                loop {
                    let request = tokio::select! {
                        _ = task_cancel.cancelled() => return Err("codec_cancelled"),
                        next = receiver.recv() => next.ok_or("codec_closed")?,
                    };
                    let result = tokio::select! {
                        _ = task_cancel.cancelled() => Err("codec_cancelled"),
                        result = tokio::time::timeout(std::time::Duration::from_secs(30), codec.run(request.input)) => result.unwrap_or(Err("codec_timeout")),
                    };
                    let failed = result.is_err();
                    let _ = request.response.send(result);
                    if failed {
                        return Err("codec_failed");
                    }
                }
                #[allow(unreachable_code)]
                Ok::<(), &'static str>(())
            };
            let _ = std::panic::AssertUnwindSafe(work).catch_unwind().await;
            // Drop queued input copies before closing the process; the admission
            // reservations owned inside Codec remain until physical cleanup.
            drop(receiver);
            let joined = codec.retire().await;
            let mut state = owner.lock().unwrap_or_else(|poison| poison.into_inner());
            if !joined {
                state.quarantine = Some(codec);
            }
            state.active = false;
            state.cancel = None;
            joined
        });
        let join = async move { task.await.unwrap_or(false) }.boxed().shared();
        state.join = Some(join.clone());
        Ok(CodecHandle {
            sender,
            cancel,
            join,
        })
    }
    pub(crate) fn revoke(&self) {
        if let Ok(state) = self.0.lock() {
            if let Some(cancel) = &state.cancel {
                cancel.cancel();
            }
        }
    }
    pub(crate) async fn shutdown(&self) -> bool {
        let join = {
            let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
            state.closed = true;
            if let Some(cancel) = &state.cancel {
                cancel.cancel();
            }
            state.join.clone()
        };
        match join {
            Some(join) => join.await,
            None => true,
        }
    }
    #[cfg(test)]
    async fn source_codec(
        &self,
        executable: &Path,
        entry: &Path,
        db: &DbPool,
    ) -> Result<CodecHandle, &'static str> {
        let source = db
            .source_ready(None)
            .await
            .map_err(|_| "database_unavailable")?;
        let mut command = Command::new(executable);
        command.arg(entry);
        self.start(command, source.ready.retain_chat_work()).await
    }
}

#[cfg(test)]
mod tests {
    use super::super::codec::Bytes;
    use super::*;
    use crate::connect_resources::TRANSIT_INSTANCE_LIMIT;
    fn bun() -> std::path::PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|dir| dir.join("bun"))
            .find(|path| path.is_file())
            .expect("installed Bun required")
    }
    async fn database() -> (tempfile::TempDir, DbPool, sqlx::SqlitePool) {
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::db::create_pool(&directory.path().join("synthetic.db"))
            .await
            .unwrap();
        let db = DbPool::default();
        db.set_ready(pool.clone()).await.unwrap();
        (directory, db, pool)
    }
    fn input(budget: &TransitInstance) -> Input {
        Input { op: 1,
            expectations: Bytes::copy(budget, br#"{"request_id_header":"00000000-0000-4000-8000-000000000001"}"#).unwrap(),
            body: Bytes::copy(budget, br#"{"authority_contract":"transfer-authority-1","type":"preflight","request_id":"00000000-0000-4000-8000-000000000001","scope":{"kind":"controller","source_instance_id":"synthetic-source","target_instance_id":"synthetic-target"}}"#).unwrap() }
    }
    #[tokio::test]
    async fn real_codec_reuses_child_and_keeps_database_and_last_result_charged() {
        let (_dir, db, pool) = database().await;
        let owner = TransferRuntime::default();
        let budget = owner.budget().unwrap();
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts");
        let codec = owner.source_codec(&bun(), &entry, &db).await.unwrap();
        assert!(owner.source_codec(&bun(), &entry, &db).await.is_err());
        assert!(db.set_ready(pool.clone()).await.is_err());
        for _ in 0..2 {
            let result = codec.run(input(&budget)).await.unwrap();
            assert_eq!(result.status, 0);
            drop(result);
        }
        let last = codec.run(input(&budget)).await.unwrap();
        codec.close().await.unwrap();
        assert!(
            budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err(),
            "last output is still a physical copy"
        );
        drop(last);
        let all = budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap();
        drop(all);
        db.set_ready(pool).await.unwrap();
        assert!(owner.shutdown().await);
    }
    #[tokio::test]
    async fn cancelled_hello_is_joined_before_credits_and_database_return() {
        let (dir, db, pool) = database().await;
        let entry = dir.path().join("silent.ts");
        std::fs::write(&entry, "setInterval(() => {}, 1000);\n").unwrap();
        let owner = TransferRuntime::default();
        let budget = owner.budget().unwrap();
        let codec = owner.source_codec(&bun(), &entry, &db).await.unwrap();
        assert!(db.set_ready(pool.clone()).await.is_err());
        drop(codec);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), owner.shutdown())
                .await
                .unwrap()
        );
        let all = budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap();
        drop(all);
        db.set_ready(pool).await.unwrap();
    }
    #[tokio::test]
    async fn hostile_header_refuses_without_reading_its_payload_then_joins() {
        let (dir, db, pool) = database().await;
        let entry = dir.path().join("hostile.ts");
        std::fs::write(&entry, "import {writeSync} from 'node:fs';const h=Buffer.alloc(32);h.write('MCF1');h.writeUInt16BE(1,4);h[6]=1;h.writeUInt32BE(0xffffffff,24);writeSync(1,h);setInterval(()=>{},1000);\n").unwrap();
        let owner = TransferRuntime::default();
        let budget = owner.budget().unwrap();
        let codec = owner.source_codec(&bun(), &entry, &db).await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), codec.run(input(&budget)))
                .await
                .unwrap()
                .is_err()
        );
        codec.close().await.unwrap();
        let all = budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap();
        drop(all);
        db.set_ready(pool).await.unwrap();
    }
}
