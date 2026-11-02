use super::codec::{AdmittedInput, Admission, BankOwner, Codec, Input, Output, Profile};
use crate::{
    connect_resources::{TransitInstance, TRANSIT_OWNER},
    core::db_state::{ChatWorkLifetime, DbPool},
};
use futures::{future::BoxFuture, FutureExt};
use std::{
    path::{Path, PathBuf},
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
    generation: u64,
    closed: bool,
    active: bool,
    join: Option<Join>,
    cancel: Option<CancellationToken>,
    quarantine: Option<Codec>,
    #[cfg(test)]
    fail_retirement: bool,
    #[cfg(test)]
    scope_probe: Option<super::codec::ScopeProbe>,
    #[cfg(test)]
    profile_events: Vec<(Profile, u32, bool)>,
    http: Option<(
        CancellationToken,
        Join,
        std::sync::Weak<super::http::IdleLanes>,
    )>,
}
impl Drop for State {
    fn drop(&mut self) {
        if let Some(codec) = self.quarantine.take() {
            if !codec.retirement_complete() {
                // Last runtime owner is disappearing without proof of IO end.
                // Keep the existing quarantine and its credits until process
                // exit; dropping it could detach Windows Blocking operations.
                std::mem::forget(codec);
            }
        }
    }
}
#[derive(Clone, Default)]
pub(crate) struct TransferRuntime(Arc<Mutex<State>>);
// This completion is the last field of HttpSession. Its notification therefore
// follows destruction of the sole Hyper drivers, TLS streams and reservations.
pub(crate) struct HttpOwnership {
    pub idle: Arc<super::http::IdleLanes>,
    pub cancel: CancellationToken,
    pub budget: TransitInstance,
    pub database: Arc<ChatWorkLifetime>,
    completion: HttpCompletion,
}
struct HttpCompletion(Option<oneshot::Sender<bool>>);
impl Drop for HttpCompletion {
    fn drop(&mut self) {
        if let Some(done) = self.0.take() {
            let _ = done.send(true);
        }
    }
}
/// Native launch context, bound to one runtime generation and database owner.
/// It cannot be supplied by IPC or derive authority from configuration intent.
pub(crate) struct CodecLauncher {
    runtime: TransferRuntime,
    executable: PathBuf,
    entry: Option<PathBuf>,
    database: DbPool,
    generation: u64,
}
impl CodecLauncher {
    pub(crate) fn belongs_to(&self, runtime: &TransferRuntime) -> bool {
        Arc::ptr_eq(&self.runtime.0, &runtime.0)
    }
    pub(crate) async fn start(&self, profile: Profile) -> Result<CodecHandle, &'static str> {
        let source = self
            .database
            .source_ready(None)
            .await
            .map_err(|_| "database_unavailable")?;
        let mut command = Command::new(&self.executable);
        if let Some(entry) = &self.entry {
            command.arg(entry);
        }
        self.runtime
            .start(
                command,
                source.ready.retain_chat_work(),
                self.generation,
                profile,
            )
            .await
    }
}
pub(crate) struct CodecHandle {
    #[cfg(test)]
    pid: u32,
    sender: mpsc::Sender<Request>,
    bank: BankOwner,
    cancel: CancellationToken,
    join: Join,
}
struct Request {
    input: AdmittedInput,
    response: oneshot::Sender<Result<Output, &'static str>>,
}
impl Drop for CodecHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
impl CodecHandle {
    pub(crate) fn admit(&self, op: u16) -> Result<Admission, &'static str> {
        if self.cancel.is_cancelled() { return Err("codec_closed"); }
        self.bank.admit(op)
    }
    pub(crate) async fn run(&self, input: Input) -> Result<Output, &'static str> {
        let admitted = self.admit(input.op)?.adopt(input)?;
        self.run_admitted(admitted).await
    }
    pub(crate) async fn run_admitted(&self, input: AdmittedInput) -> Result<Output, &'static str> {
        if !self.bank.owns(&input) { return Err("codec_owner"); }
        if self.cancel.is_cancelled() { return Err("codec_closed"); }
        // Disappearance of an in-flight caller retires the process. The owner,
        // not this future, keeps the pipes, credits and join.
        let (response, receive) = oneshot::channel();
        self.sender
            .try_send(Request { input, response })
            .map_err(|_| "codec_busy")?;
        // A rejected caller owns no work and must not cancel an admitted one.
        let guard = self.cancel.clone().drop_guard();
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
    #[cfg(test)]
    pub(crate) fn profile_events(&self) -> Vec<(Profile, u32, bool)> {
        self.0.lock().unwrap().profile_events.clone()
    }
    pub(crate) fn budget(&self) -> Result<TransitInstance, &'static str> {
        TRANSIT_OWNER
            .instance(*PC)
            .map_err(|_| "transit_unavailable")
    }
    pub(crate) fn http_owner(
        &self,
        database: &crate::core::db_state::DbReady,
    ) -> Result<HttpOwnership, &'static str> {
        let mut state = self.0.lock().map_err(|_| "transport_unavailable")?;
        if state.closed
            || state
                .http
                .as_ref()
                .is_some_and(|(_, join, _)| join.clone().now_or_never() != Some(true))
        {
            return Err("http_owner_busy");
        }
        let budget = self.budget()?;
        let cancel = CancellationToken::new();
        let (done, receive) = oneshot::channel();
        let join = async move { receive.await.unwrap_or(false) }
            .boxed()
            .shared();
        let idle = Arc::new(super::http::IdleLanes::default());
        state.http = Some((cancel.clone(), join, Arc::downgrade(&idle)));
        Ok(HttpOwnership {
            idle,
            cancel,
            budget,
            database: Arc::new(database.retain_chat_work()),
            completion: HttpCompletion(Some(done)),
        })
    }
    pub(crate) fn generation(&self) -> Result<u64, &'static str> {
        let state = self.0.lock().map_err(|_| "transport_unavailable")?;
        if state.closed {
            return Err("codec_retired");
        }
        Ok(state.generation)
    }
    pub(crate) fn codec_launcher(
        &self,
        app: &tauri::AppHandle,
        db: &DbPool,
    ) -> Result<CodecLauncher, &'static str> {
        Ok(CodecLauncher {
            runtime: self.clone(),
            executable: crate::ai::copilot::resolve_bridge_path(app)
                .map_err(|_| "codec_unavailable")?,
            entry: None,
            database: db.clone(),
            generation: self.generation()?,
        })
    }
    pub(crate) async fn start_codec(
        &self,
        app: &tauri::AppHandle,
        db: &DbPool,
    ) -> Result<CodecHandle, &'static str> {
        self.codec_launcher(app, db)?
            .start(Profile::Persistent)
            .await
    }
    async fn start(
        &self,
        mut command: Command,
        lifetime: ChatWorkLifetime,
        generation: u64,
        profile: Profile,
    ) -> Result<CodecHandle, &'static str> {
        let budget = self.budget()?;
        // No await between checking singleton ownership and publishing its join.
        let mut state = self.0.lock().map_err(|_| "transport_unavailable")?;
        if state.generation != generation {
            return Err("codec_retired");
        }
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
        command.arg(profile.command());
        let codec = Codec::spawn(command, budget, lifetime, profile)?;
        #[cfg(test)]
        let codec = { let mut codec = codec; codec.scope_probe = state.scope_probe.take(); codec };
        let bank = codec.bank_owner.clone();
        #[cfg(test)]
        let pid = codec.pid();
        #[cfg(test)]
        state.profile_events.push((profile, pid, false));
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
                        next = async {
                            match profile {
                                Profile::Persistent => Ok(receiver.recv().await),
                                Profile::Bootstrap => tokio::time::timeout(std::time::Duration::from_secs(10), receiver.recv()).await.map_err(|_| "codec_idle"),
                            }
                        } => next?.ok_or("codec_closed")?,
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
            // Fault injection exercises quarantine after real physical cleanup;
            // it does not claim to induce an OS Child::wait failure.
            #[cfg(test)]
            let joined = joined && !owner.lock().unwrap().fail_retirement;
            let mut state = owner.lock().unwrap_or_else(|poison| poison.into_inner());
            #[cfg(test)]
            if joined {
                state.profile_events.push((profile, pid, true));
            }
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
            #[cfg(test)]
            pid,
            sender,
            bank,
            cancel,
            join,
        })
    }
    pub(crate) fn revoke(&self) {
        if let Ok(mut state) = self.0.lock() {
            match state.generation.checked_add(1) {
                Some(next) => state.generation = next,
                None => state.closed = true,
            }
            if let Some((cancel, _, idle)) = &state.http {
                cancel.cancel();
                if let Some(idle) = idle.upgrade() {
                    idle.retire();
                }
            }
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
            if let Some((cancel, _, idle)) = &state.http {
                cancel.cancel();
                if let Some(idle) = idle.upgrade() {
                    idle.retire();
                }
            }
            (
                state.join.clone(),
                state.http.as_ref().map(|(_, join, _)| join.clone()),
            )
        };
        let wait = |join: Option<Join>| async move {
            match join {
                Some(join) => join.await,
                None => true,
            }
        };
        let (codec, http) = tokio::join!(wait(join.0), wait(join.1));
        codec && http
    }
    #[cfg(test)]
    pub(crate) fn source_launcher(
        &self,
        executable: &Path,
        entry: &Path,
        db: &DbPool,
    ) -> Result<CodecLauncher, &'static str> {
        Ok(CodecLauncher {
            runtime: self.clone(),
            executable: executable.to_owned(),
            entry: Some(entry.to_owned()),
            database: db.clone(),
            generation: self.generation()?,
        })
    }
    #[cfg(test)]
    pub(crate) async fn source_codec(
        &self,
        executable: &Path,
        entry: &Path,
        db: &DbPool,
    ) -> Result<CodecHandle, &'static str> {
        self.source_launcher(executable, entry, db)?
            .start(Profile::Persistent)
            .await
    }
}

#[cfg(test)]
pub(super) fn test_bun() -> std::path::PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
        .find(|path| path.is_file())
        .expect("installed Bun required")
}

#[cfg(test)]
mod tests {
    use super::super::codec::Bytes;
    use super::*;
    use crate::connect_resources::TRANSIT_INSTANCE_LIMIT;
    use super::test_bun as bun;
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
    async fn profiles_join_bootstrap_then_keep_persistent_child_idle_past_poll() {
        let (_dir, db, pool) = database().await;
        let owner = TransferRuntime::default();
        let budget = owner.budget().unwrap();
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts");
        let launcher = owner.source_launcher(&bun(), &entry, &db).unwrap();
        let bootstrap = launcher.start(Profile::Bootstrap).await.unwrap();
        assert_eq!(
            bootstrap.run(input(&budget)).await.err(),
            Some("codec_profile")
        );
        assert!(launcher.start(Profile::Persistent).await.is_err());
        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT - 524_288).is_err());
        bootstrap.close().await.unwrap();
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        let persistent = launcher.start(Profile::Persistent).await.unwrap();
        let pid = persistent.pid;
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT - 524_288).unwrap());
        let mut wrong = input(&budget);
        wrong.op = 10;
        assert_eq!(persistent.run(wrong).await.err(), Some("codec_profile"));
        let first = persistent.run(input(&budget)).await.unwrap();
        assert_eq!(first.status, 0);
        drop(first);
        tokio::time::sleep(std::time::Duration::from_secs(26)).await;
        let next = persistent.run(input(&budget)).await.unwrap();
        assert_eq!(next.status, 0);
        drop(next);
        assert_eq!(persistent.pid, pid);
        persistent.close().await.unwrap();
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        db.set_ready(pool).await.unwrap();
        assert!(owner.shutdown().await);
    }

    #[tokio::test]
    async fn wrong_hello_profile_refuses_before_work_and_returns_credits_after_join() {
        let (dir, db, _pool) = database().await;
        let owner = TransferRuntime::default();
        let budget = owner.budget().unwrap();
        let wrapper = dir.path().join("wrong-profile.ts");
        let entry = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../copilot-bridge/src/connect-bootstrap.ts");
        std::fs::write(
            &wrapper,
            format!(
                "import {{runBootstrapCodec}} from {}; await runBootstrapCodec();",
                serde_json::to_string(&entry).unwrap()
            ),
        )
        .unwrap();
        let codec = owner.source_codec(&bun(), &wrapper, &db).await.unwrap();
        assert!(codec.run(input(&budget)).await.is_err());
        codec.close().await.unwrap();
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        assert!(owner.shutdown().await);
    }

    #[tokio::test]
    async fn failed_retirement_quarantines_profile_and_refuses_replacement() {
        let (_dir, db, _pool) = database().await;
        let owner = TransferRuntime::default();
        let budget = owner.budget().unwrap();
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts");
        let launcher = owner.source_launcher(&bun(), &entry, &db).unwrap();
        let bootstrap = launcher.start(Profile::Bootstrap).await.unwrap();
        owner.0.lock().unwrap().fail_retirement = true;
        assert_eq!(bootstrap.close().await.err(), Some("codec_unreconciled"));
        assert!(owner.0.lock().unwrap().quarantine.is_some());
        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
        assert!(launcher.start(Profile::Persistent).await.is_err());
        assert!(!owner.shutdown().await);
        drop(launcher);
        drop(owner);
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
    }

    #[tokio::test]
    async fn busy_rejection_preserves_admitted_request_and_child_reuse() {
        let (_dir, db, pool) = database().await;
        let owner = TransferRuntime::default();
        let budget = owner.budget().unwrap();
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts");
        let codec = owner.source_codec(&bun(), &entry, &db).await.unwrap();
        {
            let accepted = codec.run(input(&budget));
            tokio::pin!(accepted);
            assert!(futures::poll!(&mut accepted).is_pending());
            assert_eq!(codec.run(input(&budget)).await.err(), Some("codec_busy"));
            assert!(!codec.cancel.is_cancelled());
            let first = tokio::time::timeout(std::time::Duration::from_secs(5), accepted)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(first.status, 0);
        }
        assert_eq!(codec.run(input(&budget)).await.unwrap().status, 0);
        codec.close().await.unwrap();
        assert!(owner.shutdown().await);
        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
        db.set_ready(pool).await.unwrap();
    }

    #[tokio::test]
    async fn revoked_generation_cannot_spawn_after_waiting_for_database() {
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::db::create_pool(&directory.path().join("waiting.db"))
            .await
            .unwrap();
        let db = DbPool::default();
        let owner = TransferRuntime::default();
        let executable = bun();
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts");
        let pending = owner.source_codec(&executable, &entry, &db);
        tokio::pin!(pending);
        assert!(futures::poll!(&mut pending).is_pending());
        owner.revoke();
        db.set_ready(pool.clone()).await.unwrap();
        assert_eq!(pending.await.err(), Some("codec_retired"));
        assert!(owner
            .budget()
            .unwrap()
            .reserve(TRANSIT_INSTANCE_LIMIT)
            .is_ok());
        db.set_ready(pool).await.unwrap();
        assert!(owner.shutdown().await);
    }

    #[tokio::test]
    async fn child_eof_and_hello_deadline_keep_the_owner_until_reap() {
        let (directory, db, pool) = database().await;
        for (name, script) in [
            ("eof.ts", "process.exit(0);"),
            ("silent.ts", "setInterval(() => {}, 1000);"),
        ] {
            let entry = directory.path().join(name);
            std::fs::write(&entry, script).unwrap();
            let owner = TransferRuntime::default();
            let budget = owner.budget().unwrap();
            let codec = owner.source_codec(&bun(), &entry, &db).await.unwrap();
            assert!(db.set_ready(pool.clone()).await.is_err());
            // EOF and the production ten-second HELLO deadline both retire the
            // real Child, rather than returning the accounting slot on a timer.
            assert!(tokio::time::timeout(
                std::time::Duration::from_secs(13),
                codec.run(input(&budget))
            )
            .await
            .unwrap()
            .is_err());
            codec.close().await.unwrap();
            assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
            db.set_ready(pool.clone()).await.unwrap();
        }
    }

    #[tokio::test]
    async fn real_scope_errors_and_caller_abandon_keep_bank_until_child_reap() {
        for phase in [1, 2] {
            for after in [false, true] {
                for abandon in [false, true] {
                    let (_dir, db, pool) = database().await;
                    let owner = TransferRuntime::default();
                    let budget = owner.budget().unwrap();
                    let (reached, seen) = oneshot::channel();
                    let (resume, wait) = oneshot::channel();
                    owner.0.lock().unwrap().scope_probe = Some(super::super::codec::ScopeProbe { phase, after, reached, resume: wait });
                    let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts");
                    let codec = owner.source_codec(&bun(), &entry, &db).await.unwrap();
                    let pid = codec.pid;
                    let admitted = codec.admit(1).unwrap().adopt(input(&budget)).unwrap();
                    let mut work = Box::pin(codec.run_admitted(admitted));
                    tokio::select! {
                        result = &mut work => panic!("finished before scope probe: {:?}", result.err()),
                        reached = tokio::time::timeout(std::time::Duration::from_secs(5), seen) => reached.unwrap().unwrap(),
                    }
                    assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
                    assert_eq!(codec.admit(1).err().unwrap(), "codec_busy");
                    assert!(db.set_ready(pool.clone()).await.is_err());
                    #[cfg(unix)]
                    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
                    if abandon {
                        drop(work); // Direct future destruction after admission.
                    } else {
                        resume.send(()).unwrap();
                        assert_eq!(work.await.err(), Some("codec_test_scope"));
                    }
                    codec.close().await.unwrap();
                    #[cfg(unix)]
                    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
                    assert!(owner.profile_events().contains(&(Profile::Persistent, pid, true)));
                    drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
                    db.set_ready(pool).await.unwrap();
                    assert!(owner.shutdown().await);
                }
            }
        }
    }

    #[tokio::test]
    async fn native_bank_runs_all_nine_operations_on_one_real_child() {
        let (_dir, db, _) = database().await;
        let owner = TransferRuntime::default();
        let budget = owner.budget().unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        // Synthetic fixtures belong to the test driver, not to a product input
        // loader. This recipe checks native/Child transitions and equivalence.
        let vectors = Command::new(bun()).current_dir(root).arg("-e").arg(
            "import {codecVectors} from './copilot-bridge/src/connect-codec-vectors.testSupport.ts'; console.log(JSON.stringify(codecVectors(true)));"
        ).output().await.unwrap();
        assert!(vectors.status.success());
        let vectors: Vec<serde_json::Value> = serde_json::from_slice(&vectors.stdout).unwrap();
        assert_eq!(vectors.len(), 9);
        let codec = owner.source_codec(&bun(), &root.join("copilot-bridge/src/entry.ts"), &db).await.unwrap();
        let pid = codec.pid;
        for vector in vectors {
            let op = vector["op"].as_u64().unwrap() as u16;
            let body = Bytes::serialize(&budget, &vector["body"]).unwrap();
            let input = codec.admit(op).unwrap().input(&vector["facts"], body).unwrap();
            let result = codec.run_admitted(input).await.unwrap();
            assert_eq!(result.status, 0, "operation {op}");
            assert!(!result.bytes.as_slice().is_empty());
            assert_eq!(codec.pid, pid);
            assert_eq!(codec.admit(op).err().unwrap(), "codec_busy");
            drop(result);
        }
        codec.close().await.unwrap();
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        assert!(owner.shutdown().await);
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
        // Exactly one raw graph plus BANK and startup fits. Separate native
        // expectation/body reservations would make the real Child fail.
        let remainder = budget.reserve(TRANSIT_INSTANCE_LIMIT - 524_288 - 28_311_552 - 2_097_152).unwrap();
        for _ in 0..2 {
            let result = codec.run(input(&budget)).await.unwrap();
            assert_eq!(result.status, 0);
            drop(result);
        }
        drop(remainder);
        let last = codec.run(input(&budget)).await.unwrap();
        assert_eq!(codec.admit(1).err().unwrap(), "codec_busy");
        drop(last);
        let admitted = codec.admit(1).unwrap();
        drop(admitted);
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
