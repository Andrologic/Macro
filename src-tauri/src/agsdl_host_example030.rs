//! In-process example adapter for the native 0.3 QA scenario. It never invokes
//! a provider, tool, process, or network endpoint.
use crate::db::agsdl_execution::{
    failure,
    flow030::{FlowEffect030, FlowEffectKind030},
    Result,
};
use crate::{
    agsdl_host::HostState,
    agsdl_host_flow030::FlowWorkAttempt030,
    agsdl_host_work_admission030::PolicyLeases030,
    ai::stream_tasks::{OwnedOperation030, StreamTasks},
    config::ConfigManager,
    db::agsdl_execution::{
        dto::EngineContext,
        flow_work_protocol030,
        work_protocol030::{NativeCall030, ProtocolDecision030, ProtocolEvent030},
    },
};
use sqlx::{Connection, SqlitePool};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

const ADAPTER: &str = "macro-example030-qa/1";
const VERSION: &str = "1.0.0";
static QA_CAPTURE_ENABLED: AtomicBool = AtomicBool::new(false);
static QA_APPROVED_WORKSPACE: OnceLock<std::path::PathBuf> = OnceLock::new();
static QA_SOURCE_PAUSE: std::sync::Mutex<Option<std::sync::Arc<SourceCommitPause030>>> =
    std::sync::Mutex::new(None);
static QA_SOURCE_RECOVERED: AtomicBool = AtomicBool::new(false);
static QA_SOURCE_ROLLBACK_MODE: AtomicBool = AtomicBool::new(false);
static QA_SOURCE_ROLLBACK_PROVEN: AtomicBool = AtomicBool::new(false);
static QA_CLAIM_MODE: AtomicBool = AtomicBool::new(false);
static QA_CLAIM_PROVEN: AtomicBool = AtomicBool::new(false);
static QA_STOP_CLAIM_MODE: AtomicBool = AtomicBool::new(false);
static QA_STOP_CLAIM_PROVEN: AtomicBool = AtomicBool::new(false);
static QA_PREPARE_UNCLAIMED: AtomicBool = AtomicBool::new(false);

struct SourceCommitPause030 {
    reference: crate::db::agsdl_execution::flow030::PrepareRef030,
    before_commit: bool,
    reached: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

fn install_source_commit_pause(
    reference: &crate::db::agsdl_execution::flow030::PrepareRef030,
) -> Result<std::sync::Arc<SourceCommitPause030>> {
    let pause = std::sync::Arc::new(SourceCommitPause030 {
        reference: reference.clone(),
        before_commit: QA_SOURCE_ROLLBACK_MODE.load(Ordering::SeqCst),
        reached: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let mut slot = QA_SOURCE_PAUSE.lock().map_err(|_| {
        failure(
            "RUNTIME_UNAVAILABLE",
            "example",
            "QA interleaving unavailable",
        )
    })?;
    if slot.is_some() {
        return Err(failure(
            "CORRELATION",
            "example",
            "QA interleaving already installed",
        ));
    }
    *slot = Some(pause.clone());
    Ok(pause)
}

async fn pause_source_commit(
    reference: &crate::db::agsdl_execution::flow030::PrepareRef030,
    before_commit: bool,
) {
    let pause = QA_SOURCE_PAUSE.lock().ok().and_then(|slot| {
        slot.as_ref()
            .filter(|p| p.reference == *reference && p.before_commit == before_commit)
            .cloned()
    });
    if let Some(pause) = pause {
        pause.reached.notify_one();
        pause.release.notified().await;
    }
}

pub(crate) async fn pause_before_source_commit(
    reference: &crate::db::agsdl_execution::flow030::PrepareRef030,
) {
    pause_source_commit(reference, true).await;
}
pub(crate) async fn pause_after_source_commit(
    reference: &crate::db::agsdl_execution::flow030::PrepareRef030,
) {
    pause_source_commit(reference, false).await;
}

/// Issued by the adapter itself, not deserialized from a registry or IPC.
pub(crate) struct ExampleObservation030 {
    _private: (),
}

pub(crate) enum ExampleOutcome030 {
    Failed,
    Reported,
}

pub(crate) struct ExampleAdapter030;

/// Refuse to initialize the app with a real profile when the QA entry is used.
pub(crate) fn validate_qa_isolation(app: &tauri::AppHandle) -> std::io::Result<()> {
    if std::env::var_os("MACRO_AGSDL_ENGINE_QA").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Ok(());
    }
    let denied =
        || std::io::Error::other("Native example QA requires an isolated temporary profile");
    let directory =
        std::fs::canonicalize(std::env::var_os("MACRO_AGSDL_ENGINE_QA_DIR").ok_or_else(denied)?)?;
    let temporary = std::fs::canonicalize(std::env::temp_dir())?;
    if directory == temporary
        || !directory.starts_with(&temporary)
        || !app.config().identifier.starts_with("com.macro.desktop.qa.")
    {
        return Err(denied());
    }
    let config = std::fs::canonicalize(std::env::var_os("MACRO_CONFIG_DIR").ok_or_else(denied)?)?;
    let data = app.path().app_data_dir().map_err(|_| denied())?;
    let data_parent = std::fs::canonicalize(data.parent().ok_or_else(denied)?)?;
    let runtime: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config.join("runtime.json"))?)?;
    let workspace = std::fs::canonicalize(
        runtime
            .get("defaultWorkspace")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(denied)?,
    )?;
    if !config.starts_with(&directory)
        || !data_parent.starts_with(&directory)
        || !workspace.starts_with(&directory)
    {
        return Err(denied());
    }
    Ok(())
}

/// Check the approved effective path, not merely the untrusted runtime file.
pub(crate) fn validate_qa_workspace(
    workspace: &std::path::Path,
    is_default: bool,
) -> std::io::Result<()> {
    if std::env::var_os("MACRO_AGSDL_ENGINE_QA").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Ok(());
    }
    let denied = || std::io::Error::other("Native example QA effective workspace is not isolated");
    let directory =
        std::fs::canonicalize(std::env::var_os("MACRO_AGSDL_ENGINE_QA_DIR").ok_or_else(denied)?)?;
    check_effective_workspace(
        &directory,
        &directory.join("workspace"),
        workspace,
        is_default,
    )?;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let approved = std::fs::canonicalize(workspace)?;
    let report = serde_json::json!({"kind":"native-example-isolation/1","configured":true,
        "workspaceSha256":format!("{:x}", Sha256::digest(approved.as_os_str().to_string_lossy().as_bytes()))});
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("isolation.json"))?;
    file.write_all(&serde_json::to_vec(&report)?)?;
    file.sync_all()?;
    QA_APPROVED_WORKSPACE
        .set(approved)
        .map_err(|_| std::io::Error::other("QA workspace was already installed"))?;
    Ok(())
}

fn check_effective_workspace(
    directory: &std::path::Path,
    expected: &std::path::Path,
    workspace: &std::path::Path,
    is_default: bool,
) -> std::io::Result<()> {
    let denied = || std::io::Error::other("Native example QA effective workspace is not isolated");
    let directory = std::fs::canonicalize(directory)?;
    let expected = std::fs::canonicalize(expected)?;
    let effective = std::fs::canonicalize(workspace)?;
    if is_default
        || expected == directory
        || !expected.starts_with(directory)
        || effective != expected
    {
        return Err(denied());
    }
    Ok(())
}

/// A dedicated debug/feature QA process can opt in using a synthetic request
/// directory under the OS temporary directory. No IPC command enables it.
pub(crate) fn launch_if_requested(app: &tauri::AppHandle) {
    if std::env::var_os("MACRO_AGSDL_ENGINE_QA").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return;
    }
    QA_SOURCE_ROLLBACK_MODE.store(
        std::env::var("MACRO_AGSDL_ENGINE_QA_CASE").as_deref() == Ok("source-rollback"),
        Ordering::SeqCst,
    );
    QA_CLAIM_MODE.store(
        std::env::var("MACRO_AGSDL_ENGINE_QA_CASE").as_deref() == Ok("claim-competition"),
        Ordering::SeqCst,
    );
    QA_STOP_CLAIM_MODE.store(
        std::env::var("MACRO_AGSDL_ENGINE_QA_CASE").as_deref() == Ok("claim-stop"),
        Ordering::SeqCst,
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let directory = std::env::var_os("MACRO_AGSDL_ENGINE_QA_DIR")
                .ok_or_else(|| failure("CORRELATION", "example", "QA directory is absent"))?;
            let directory = std::fs::canonicalize(directory)
                .map_err(|_| failure("CORRELATION", "example", "QA directory is unavailable"))?;
            let temporary = std::fs::canonicalize(std::env::temp_dir()).map_err(|_| {
                failure(
                    "CORRELATION",
                    "example",
                    "Temporary directory is unavailable",
                )
            })?;
            if !directory.starts_with(&temporary) || directory == temporary {
                return Err(failure(
                    "CORRELATION",
                    "example",
                    "QA directory is outside the temporary directory",
                ));
            }
            let raw = tokio::fs::read(directory.join("request.json"))
                .await
                .map_err(|_| failure("CORRELATION", "example", "QA request is unavailable"))?;
            if raw.len() > 1_000_000 {
                return Err(failure(
                    "CORRELATION",
                    "example",
                    "QA request exceeds its bound",
                ));
            }
            let request = serde_json::from_slice(&raw)?;
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    if app.state::<HostState>().start_lease().await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            })
            .await
            .map_err(|_| {
                failure(
                    "RUNTIME_UNAVAILABLE",
                    "example",
                    "Resident host did not become ready",
                )
            })?;
            let result =
                start_error_route030(app.clone(), request, &CancellationToken::new()).await;
            let code = if result.is_ok() { 0 } else { 1 };
            let report = match result {
                Ok(value) => serde_json::json!({"ok":true,"result":value}),
                Err(error) => serde_json::json!({"ok":false,"error":error}),
            };
            tokio::fs::write(directory.join("result.json"), serde_json::to_vec(&report)?)
                .await
                .map_err(|_| failure("STORAGE", "example", "QA report could not be written"))?;
            Ok::<i32, crate::db::agsdl_execution::dto::EngineFailure>(code)
        }
        .await;
        match result {
            Ok(code) => app.exit(code),
            Err(error) => {
                eprintln!("Native example QA failed: {}", error.code);
                app.exit(1);
            }
        }
    });
}

/// Dispatch a single inspected Start through the production claim, admission,
/// owned future and 04 controller. The supervisor waits outside that future.
pub(crate) async fn dispatch_start030(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    owner: &crate::db::agsdl_execution::dto::EngineOwner,
    effect: &FlowEffect030,
    cancelled: &CancellationToken,
) -> Result<crate::agsdl_host_dispatch030::JoinedOwnedAgent030> {
    let host = app.state::<HostState>();
    let inspection =
        crate::agsdl_host_flow030::inspect_run(host.flow030(), &host, pool, owner).await?;
    let prepared = crate::agsdl_host_work_admission030::prepare_effective_agent_work030(
        config,
        &inspection,
        effect,
    )
    .await?;
    let policy = crate::agsdl_host_work_admission030::AttestedWorkPolicy030::from_example(
        prepared,
        &ExampleAdapter030::observe(),
    )?;
    let project_id = inspection.capture.source.owner.project_id.clone();
    let claim = crate::agsdl_host_flow030::claim_expected(
        host.flow030(),
        &host,
        pool,
        &effect.identity,
        &effect.id,
    )
    .await?
    .ok_or_else(|| {
        failure(
            "STALE_REFERENCE",
            "example",
            "Expected start is no longer first",
        )
    })?;
    if claim.effect() != effect {
        return Err(failure("CORRELATION", "example", "Claimed start differs"));
    }
    let (attempt_send, attempt_recv) = tokio::sync::oneshot::channel();
    let (result_send, result_recv) = tokio::sync::oneshot::channel();
    let app_owned = app.clone();
    let pool_owned = pool.clone();
    let config_owned = config.clone();
    let tasks_owned = tasks.clone();
    let effect_owned = effect.clone();
    let cancelled_owned = cancelled.clone();
    claim
        .handoff_agent(tasks, policy, move |attempt| async move {
            if attempt_send.send(attempt.clone()).is_err() {
                return;
            }
            let host = app_owned.state::<HostState>();
            let result = ExampleAdapter030
                .run_owned(
                    &host,
                    &pool_owned,
                    &config_owned,
                    &tasks_owned,
                    &attempt,
                    &project_id,
                    &effect_owned,
                    &cancelled_owned,
                )
                .await;
            let _ = result_send.send(result);
        })
        .await?;
    let attempt = attempt_recv.await.map_err(|_| {
        failure(
            "UNCERTAIN",
            "example",
            "Owned example did not report its native attempt",
        )
    })?;
    let joined = crate::agsdl_host_dispatch030::join_owned_agent030(tasks, &attempt).await?;
    result_recv.await.map_err(|_| {
        failure(
            "UNCERTAIN",
            "example",
            "Owned example completion is unavailable",
        )
    })??;
    let decision =
        flow_work_protocol030::finish_joined_agent030(&host, pool, &joined, cancelled).await?;
    expect_kind(&decision, "finished")?;
    Ok(joined)
}

/// Drive the exact in-process QA scenario using the same native store, owned
/// dispatch and resident 04/05 mailboxes as the host. Unsupported effects fail
/// closed; no provider or external tool is substituted.
pub(crate) async fn drive_error_route030(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    owner: &crate::db::agsdl_execution::dto::EngineOwner,
    cancelled: &CancellationToken,
) -> Result<crate::db::agsdl_execution::flow_store030::FlowView030> {
    let host = app.state::<HostState>();
    let mut joined = std::collections::BTreeMap::new();
    for _ in 0..32 {
        if cancelled.is_cancelled() {
            return Err(failure(
                "INTERRUPTED",
                "example",
                "Example run was cancelled",
            ));
        }
        let inspection =
            crate::agsdl_host_flow030::inspect_run(host.flow030(), &host, pool, owner).await?;
        let mut first = None;
        for row in &inspection.flow.effects {
            if row.get("status").and_then(serde_json::Value::as_str) == Some("uncertain") {
                return Err(failure(
                    "UNCERTAIN",
                    "example",
                    "Example effect is unresolved",
                ));
            }
            if row.get("status").and_then(serde_json::Value::as_str) != Some("pending") {
                continue;
            }
            let effect: FlowEffect030 =
                serde_json::from_value(row.get("effect").cloned().ok_or_else(|| {
                    failure("CORRELATION", "example", "Effect payload is absent")
                })?)?;
            if crate::db::agsdl_execution::flow_store030::eligible(&inspection.flow.state, &effect)
            {
                first = Some(effect);
                break;
            }
        }
        let Some(effect) = first else {
            if inspection.flow.state.verdict.is_some()
                && inspection
                    .flow
                    .state
                    .activations
                    .iter()
                    .all(|a| !a.physical)
            {
                return Ok(inspection.flow);
            }
            return Err(failure(
                "CORRELATION",
                "example",
                "Example run is not terminal",
            ));
        };
        match &effect.kind {
            FlowEffectKind030::Start { agent: Some(_), .. } => {
                if QA_STOP_CLAIM_MODE.load(Ordering::SeqCst) {
                    let prepared =
                        crate::agsdl_host_work_admission030::prepare_effective_agent_work030(
                            config,
                            &inspection,
                            &effect,
                        )
                        .await?;
                    let stop = crate::db::agsdl_execution::dto::EngineStopRequest {
                        system_start_id: effect.identity.system_start_id.clone(),
                        request_id: "qa-stop-before-claim".into(),
                        activation_id: None,
                    };
                    crate::agsdl_host_flow030::request_system_stop030(host.flow030(), pool, &stop)
                        .await?;
                    drop(prepared);
                    if crate::agsdl_host_flow030::claim_expected(
                        host.flow030(),
                        &host,
                        pool,
                        &effect.identity,
                        &effect.id,
                    )
                    .await?
                    .is_some()
                    {
                        return Err(failure(
                            "CORRELATION",
                            "example",
                            "Stopped start was claimed",
                        ));
                    }
                    let rows: Vec<(String, String)> = sqlx::query_as("SELECT effect_json,status FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? ORDER BY rowid")
                        .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).fetch_all(pool).await?;
                    let mut stop_work_pending = false;
                    for (raw, status) in rows {
                        let item: FlowEffect030 = serde_json::from_str(&raw)?;
                        if item.id != effect.id && status == "uncertain" {
                            return Err(failure(
                                "CORRELATION",
                                "example",
                                "Stop caused a foreign claim",
                            ));
                        }
                        if matches!(item.kind, FlowEffectKind030::StopWork { .. })
                            && status == "pending"
                        {
                            stop_work_pending = true;
                        }
                    }
                    if !stop_work_pending {
                        return Err(failure(
                            "CORRELATION",
                            "example",
                            "Expected StopWork is absent",
                        ));
                    }
                    QA_STOP_CLAIM_PROVEN.store(true, Ordering::SeqCst);
                    return Err(failure(
                        "QA_STOP_CLAIM_PROVEN",
                        "example",
                        "Stopped claim refused",
                    ));
                }
                if QA_CLAIM_MODE.load(Ordering::SeqCst) {
                    let prepared =
                        crate::agsdl_host_work_admission030::prepare_effective_agent_work030(
                            config,
                            &inspection,
                            &effect,
                        )
                        .await?;
                    let claim = crate::agsdl_host_flow030::claim_expected(
                        host.flow030(),
                        &host,
                        pool,
                        &effect.identity,
                        &effect.id,
                    )
                    .await?
                    .ok_or_else(|| {
                        failure("CORRELATION", "example", "Initial expected claim failed")
                    })?;
                    if claim.effect() != &effect {
                        return Err(failure(
                            "CORRELATION",
                            "example",
                            "Claimed a foreign effect",
                        ));
                    }
                    drop(claim);
                    drop(prepared);
                    if crate::agsdl_host_flow030::claim_expected(
                        host.flow030(),
                        &host,
                        pool,
                        &effect.identity,
                        &effect.id,
                    )
                    .await?
                    .is_some()
                    {
                        return Err(failure("CORRELATION", "example", "Claim was emitted twice"));
                    }
                    let row: (String, i64) = sqlx::query_as("SELECT status,(SELECT count(*) FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id<>? AND status='uncertain') FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
                        .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).bind(&effect.id)
                        .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).bind(&effect.id).fetch_one(pool).await?;
                    if row.0 != "uncertain" || row.1 != 0 {
                        return Err(failure(
                            "CORRELATION",
                            "example",
                            "Competing claim changed another effect",
                        ));
                    }
                    QA_CLAIM_PROVEN.store(true, Ordering::SeqCst);
                    return Err(failure(
                        "QA_CLAIM_PROVEN",
                        "example",
                        "Competing claim refused",
                    ));
                }
                let witness =
                    dispatch_start030(app, pool, config, tasks, owner, &effect, cancelled).await?;
                joined.insert(witness.attempt().work().activation_id.clone(), witness);
            }
            FlowEffectKind030::PrepareRoute { reference, .. }
                if reference.route.kind == "error" =>
            {
                if crate::agsdl_host_flow030::claim_expected(
                    host.flow030(),
                    &host,
                    pool,
                    &effect.identity,
                    &effect.id,
                )
                .await?
                .is_some()
                {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "PrepareRoute was generically claimed",
                    ));
                }
                let status: String = sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
                    .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).bind(&effect.id).fetch_one(pool).await?;
                if status != "pending" {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "PrepareRoute changed before dedicated dispatch",
                    ));
                }
                QA_PREPARE_UNCLAIMED.store(true, Ordering::SeqCst);
                let witness = joined.remove(&reference.activation_id).ok_or_else(|| {
                    failure("CORRELATION", "example", "Error source has no joined agent")
                })?;
                let pause = install_source_commit_pause(reference)?;
                let app_owned = app.clone();
                let pool_owned = pool.clone();
                let owner_owned = owner.clone();
                let reference_owned = reference.clone();
                let cancelled_owned = cancelled.clone();
                let mut worker = tokio::spawn(async move {
                    let host = app_owned.state::<HostState>();
                    crate::agsdl_host_dispatch030::dispatch_joined_error_route030(
                        &host,
                        &pool_owned,
                        &owner_owned,
                        &reference_owned,
                        &witness,
                        &cancelled_owned,
                    )
                    .await
                });
                tokio::select! {
                    result = &mut worker => {
                        return Err(match result { Ok(Err(error)) => error,
                            _ => failure("CORRELATION", "example", "Source commit pause was not reached") });
                    }
                    reached = tokio::time::timeout(std::time::Duration::from_secs(30), pause.reached.notified()) => {
                        if reached.is_err() {
                            worker.abort();
                            let _ = worker.await;
                            return Err(failure("INTERRUPTED", "example", "Source commit pause timed out"));
                        }
                    }
                }
                worker.abort();
                if !worker.await.is_err_and(|error| error.is_cancelled()) {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Source writer was not cancelled at the boundary",
                    ));
                }
                if host
                    .flow030()
                    .pending_route_source_commit(reference)?
                    .is_none()
                    || host.flow030().available(&reference.identity).is_ok()
                {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Source commit barrier was not retained",
                    ));
                }
                if QA_SOURCE_ROLLBACK_MODE.load(Ordering::SeqCst) {
                    let unresolved = matches!(crate::agsdl_host_dispatch030::resume_error_route030(&host, pool, owner, reference, cancelled).await,
                        Err(error) if error.code == "UNCERTAIN");
                    let blocked = matches!(crate::agsdl_host_flow030::claim_expected(host.flow030(), &host, pool, &effect.identity, &effect.id).await,
                        Err(error) if error.code == "UNCERTAIN");
                    let mut other = reference.clone();
                    other.prepare_id.push_str(":other");
                    let other_blocked = matches!(crate::agsdl_host_dispatch030::resume_error_route030(&host, pool, owner, &other, cancelled).await,
                        Err(error) if error.code == "UNCERTAIN");
                    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations WHERE system_id=? AND invocation_id=? AND prepare_id=?")
                        .bind(&reference.identity.system_start_id).bind(&reference.identity.flow_invocation_id)
                        .bind(&reference.prepare_id).fetch_one(pool).await?;
                    if !unresolved
                        || !blocked
                        || !other_blocked
                        || count != 0
                        || host
                            .flow030()
                            .pending_route_source_commit(reference)?
                            .is_none()
                    {
                        return Err(failure(
                            "CORRELATION",
                            "example",
                            "Source rollback barrier proof failed",
                        ));
                    }
                    // This separate negative QA database deliberately removes
                    // the pending preparation to exercise the empty-queue
                    // barrier. It does not represent a production transition.
                    let changed = sqlx::query("DELETE FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=? AND status='pending'")
                        .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).bind(&effect.id)
                        .execute(pool).await?.rows_affected();
                    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND status='pending'")
                        .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).fetch_one(pool).await?;
                    let empty_blocked = matches!(crate::agsdl_host_flow030::claim_expected(host.flow030(), &host, pool, &effect.identity, &effect.id).await,
                        Err(error) if error.code == "UNCERTAIN");
                    if changed != 1 || remaining != 0 || !empty_blocked {
                        return Err(failure(
                            "CORRELATION",
                            "example",
                            "Empty fixture queue was not fenced",
                        ));
                    }
                    QA_SOURCE_ROLLBACK_PROVEN.store(true, Ordering::SeqCst);
                    return Err(failure(
                        "QA_ROLLBACK_PROVEN",
                        "example",
                        "Source rollback remained unresolved",
                    ));
                }
                crate::agsdl_host_dispatch030::resume_error_route030(
                    &host, pool, owner, reference, cancelled,
                )
                .await?;
                if host
                    .flow030()
                    .pending_route_source_commit(reference)?
                    .is_some()
                {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Exact source readback did not clear its barrier",
                    ));
                }
                QA_SOURCE_PAUSE
                    .lock()
                    .map_err(|_| {
                        failure(
                            "RUNTIME_UNAVAILABLE",
                            "example",
                            "QA interleaving unavailable",
                        )
                    })?
                    .take();
                QA_SOURCE_RECOVERED.store(true, Ordering::SeqCst);
            }
            FlowEffectKind030::Failure { .. }
            | FlowEffectKind030::Return { .. }
            | FlowEffectKind030::RunEnded { .. } => {
                let claim = crate::agsdl_host_flow030::claim_expected(
                    host.flow030(),
                    &host,
                    pool,
                    &effect.identity,
                    &effect.id,
                )
                .await?
                .ok_or_else(|| {
                    failure(
                        "STALE_REFERENCE",
                        "example",
                        "Expected notification changed",
                    )
                })?;
                let request_id = claim.request_id();
                claim.handoff_host(tasks, async {}).await?;
                if !tasks.cancel_owned(&request_id).await.map_err(|_| {
                    failure("UNCERTAIN", "example", "Notification cleanup is unresolved")
                })? {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Notification owner is absent",
                    ));
                }
            }
            _ => {
                return Err(failure(
                    "HARNESS_REFUSED",
                    "example",
                    "Effect is outside the example scenario",
                ))
            }
        }
    }
    Err(failure(
        "CORRELATION",
        "example",
        "Example run exceeded its bounded dispatch count",
    ))
}

/// Native QA entry. The production Start command performs the capture and
/// durable initialization; this entry supplies only the in-process adapter.
pub(crate) async fn start_error_route030(
    app: tauri::AppHandle,
    request: crate::db::agsdl_execution::dto::EngineStartRequest,
    cancelled: &CancellationToken,
) -> Result<serde_json::Value> {
    if request.profile != "macro-agsdl-030-v1" {
        return Err(failure("CORRELATION", "example", "QA requires a 0.3 start"));
    }
    ExampleAdapter030::enable_qa_capture();
    validate_qa_project(&request.source).await?;
    crate::commands::workspace::workspace_list_projects(
        app.clone(),
        app.state::<crate::WorkspaceMetadataRoot>(),
        app.state::<crate::git::GitState>(),
        app.state::<ConfigManager>(),
        app.state::<crate::config::ConfigWatcherState>(),
    )
    .await
    .map_err(|_| failure("CORRELATION", "example", "QA project registration failed"))?;
    let receipt = crate::commands::agsdl_execution::execution_start(app.clone(), request).await?;
    let pool = app
        .state::<crate::commands::DbPool>()
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "example", "Execution database unavailable"))?;
    let epoch: String = sqlx::query_scalar("SELECT owner_epoch FROM engine_flow030_owners WHERE system_id=? AND invocation_id=? AND status='live'")
        .bind(&receipt.system_start_id).bind(&receipt.flow_invocation_id).fetch_one(&pool).await?;
    let owner = crate::db::agsdl_execution::dto::EngineOwner {
        system_start_id: receipt.system_start_id.clone(),
        owner_epoch: epoch,
    };
    let config = app.state::<ConfigManager>();
    let ai = app.state::<crate::ai::AiState>();
    let view = match drive_error_route030(&app, &pool, &config, &ai.stream_tasks, &owner, cancelled)
        .await
    {
        Err(error)
            if error.code == "QA_ROLLBACK_PROVEN"
                && QA_SOURCE_ROLLBACK_PROVEN.load(Ordering::SeqCst) =>
        {
            return Ok(
                serde_json::json!({"sourceRollbackBarrier":true,"sourceRows":0,"claimBlocked":true,"otherPreparationBlocked":true,
                    "emptyQueueBlocked":true,"emptyQueueFixtureMutation":true}),
            );
        }
        Err(error) if error.code == "QA_CLAIM_PROVEN" && QA_CLAIM_PROVEN.load(Ordering::SeqCst) => {
            return Ok(
                serde_json::json!({"expectedClaimOnce":true,"foreignEffectsUnchanged":true}),
            );
        }
        Err(error)
            if error.code == "QA_STOP_CLAIM_PROVEN"
                && QA_STOP_CLAIM_PROVEN.load(Ordering::SeqCst) =>
        {
            return Ok(
                serde_json::json!({"stopWinsBeforeClaim":true,"foreignStopWorkPending":true,"foreignEffectsUnchanged":true}),
            );
        }
        other => other?,
    };
    let host = app.state::<HostState>();
    let inspection =
        crate::agsdl_host_flow030::inspect_run(host.flow030(), &host, &pool, &owner).await?;
    if inspection.flow.state.revision != view.state.revision {
        return Err(failure(
            "STALE_REFERENCE",
            "example",
            "Flow changed during QA readback",
        ));
    }
    let plan: crate::db::agsdl_execution::flow030::FlowPlan030 =
        serde_json::from_str(&inspection.capture.compiled_plan_json)?;
    let projection = crate::db::agsdl_execution::runtime_projection030::project_runtime030(
        &plan,
        &inspection.flow.state,
    )
    .map_err(|_| failure("CORRELATION", "example", "Runtime projection failed"))?;
    Ok(
        serde_json::json!({"receipt":receipt,"projection":projection,"events":inspection.flow.events,"effects":inspection.flow.effects,
            "sourceCommitRecovery":QA_SOURCE_RECOVERED.load(Ordering::SeqCst),
            "prepareRouteNotClaimed":QA_PREPARE_UNCLAIMED.load(Ordering::SeqCst)}),
    )
}

/// Restrict discovery to the synthetic QA registry first, then authenticate
/// the requested owner and source using the native metadata lock.
async fn validate_qa_project(
    source: &crate::db::agsdl_execution::dto::EngineSourceRevision,
) -> Result<()> {
    let refused = || failure("CORRELATION", "example", "QA project is not isolated");
    if source.owner.project_id != "project"
        || source.owner.plan_id != "source"
        || source.owner.branch != "develop"
    {
        return Err(refused());
    }
    let root =
        std::fs::canonicalize(std::env::var_os("MACRO_AGSDL_ENGINE_QA_DIR").ok_or_else(refused)?)
            .map_err(|_| refused())?;
    let workspace = std::fs::canonicalize(root.join("workspace")).map_err(|_| refused())?;
    if QA_APPROVED_WORKSPACE.get() != Some(&workspace) {
        return Err(refused());
    }
    let metadata = std::fs::canonicalize(workspace.join(".macro")).map_err(|_| refused())?;
    let project = std::fs::canonicalize(workspace.join("project")).map_err(|_| refused())?;
    let plan = std::fs::canonicalize(project.join(".macro/branches/develop/plans/source"))
        .map_err(|_| refused())?;
    if !workspace.starts_with(&root)
        || !metadata.starts_with(&workspace)
        || !project.starts_with(&workspace)
        || !plan.starts_with(&project)
    {
        return Err(refused());
    }
    let registry_file =
        std::fs::canonicalize(metadata.join("workspace.json")).map_err(|_| refused())?;
    let plan_file = std::fs::canonicalize(plan.join("plan.json")).map_err(|_| refused())?;
    let manifest_file = std::fs::canonicalize(plan.join("manifest.json")).map_err(|_| refused())?;
    if !registry_file.starts_with(&metadata)
        || !plan_file.starts_with(&plan)
        || !manifest_file.starts_with(&plan)
    {
        return Err(refused());
    }
    let registry: serde_json::Value =
        serde_json::from_slice(&std::fs::read(registry_file).map_err(|_| refused())?)?;
    let projects = registry
        .get("standaloneProjects")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(refused)?;
    let groups = registry
        .get("project_groups")
        .or_else(|| registry.get("projectGroups"));
    if projects.len() != 1
        || groups.is_some_and(|value| value.as_array().is_none_or(|groups| !groups.is_empty()))
        || projects[0].get("id").and_then(serde_json::Value::as_str) != Some("project")
    {
        return Err(refused());
    }
    let path = projects[0]
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(refused)?;
    if std::fs::canonicalize(path).map_err(|_| refused())? != project {
        return Err(refused());
    }
    let locked = crate::workspace::architect::lock_execution_source_owner(
        &workspace,
        &metadata,
        &source.owner,
        Some(source),
    )
    .await?;
    if locked.project.id != source.owner.project_id
        || std::fs::canonicalize(&locked.project.path).map_err(|_| refused())? != project
        || locked.revision != *source
    {
        return Err(refused());
    }
    Ok(())
}

impl ExampleAdapter030 {
    /// This opt-in is called only by the native QA entry, never by IPC.
    pub(crate) fn enable_qa_capture() {
        QA_CAPTURE_ENABLED.store(true, Ordering::SeqCst);
    }

    pub(crate) fn qa_capture_enabled() -> bool {
        QA_CAPTURE_ENABLED.load(Ordering::SeqCst)
    }

    pub(crate) fn observe() -> ExampleObservation030 {
        ExampleObservation030 { _private: () }
    }

    /// The adapter performs the two actual operations used by the QA run.
    /// The report is accepted only when the routed message carries both the
    /// expected prompt and the error produced by the preceding native work.
    pub(crate) async fn execute(
        &self,
        effect: &FlowEffect030,
        cancelled: &CancellationToken,
    ) -> Result<ExampleOutcome030> {
        let FlowEffectKind030::Start {
            step: Some(step),
            agent: Some(agent),
            message_json,
            ..
        } = &effect.kind
        else {
            return Err(failure("CORRELATION", "example", "Example start differs"));
        };
        if cancelled.is_cancelled() {
            return Err(failure(
                "INTERRUPTED",
                "example",
                "Example work was cancelled",
            ));
        }
        tokio::task::yield_now().await;
        if cancelled.is_cancelled() {
            return Err(failure(
                "INTERRUPTED",
                "example",
                "Example work was cancelled",
            ));
        }
        match (step.as_slice(), agent.as_str()) {
            ([step], "dev") if step == "build" => Ok(ExampleOutcome030::Failed),
            ([step], "ops") if step == "notify" => {
                let raw = message_json
                    .as_ref()
                    .ok_or_else(|| failure("CORRELATION", "example", "Routed message is absent"))?;
                let message: serde_json::Value = serde_json::from_str(raw)?;
                if message.get("prompt").and_then(serde_json::Value::as_str)
                    != Some("Report the failure.")
                    || message
                        .pointer("/resources/error/value/code")
                        .and_then(serde_json::Value::as_str)
                        != Some("AGENT_FAILED")
                {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Routed error message differs",
                    ));
                }
                Ok(ExampleOutcome030::Reported)
            }
            _ => Err(failure("CORRELATION", "example", "Unexpected example work")),
        }
    }

    /// Called inside the already owned native parent after its 036 handoff.
    /// The adapter only reports its own observed outcome to the real 04
    /// mailbox; physical completion is emitted later by the supervisor.
    pub(crate) async fn run_owned(
        &self,
        host: &HostState,
        pool: &SqlitePool,
        config: &ConfigManager,
        tasks: &StreamTasks,
        attempt: &FlowWorkAttempt030,
        project_id: &str,
        effect: &FlowEffect030,
        cancelled: &CancellationToken,
    ) -> Result<()> {
        let matches = matches!(&effect.kind, FlowEffectKind030::Start {work, step, agent:Some(agent), ..}
            if effect.identity == *attempt.identity() && effect.id == attempt.start_effect_id()
                && work.start_effect_id == attempt.start_effect_id()
                && work.activation_id == attempt.work().activation_id
                && work.agent_instance_id == attempt.work().agent_instance_id
                && step == &attempt.work().step && agent == attempt.agent());
        if !matches {
            return Err(failure(
                "CORRELATION",
                "example",
                "Example work differs from its native attempt",
            ));
        }
        match self.execute(effect, cancelled).await? {
            ExampleOutcome030::Failed => {
                let decision = emit(
                    host,
                    pool,
                    config,
                    tasks,
                    attempt,
                    project_id,
                    "failure",
                    serde_json::json!({"kind":"stop","reason":"AGENT_FAILED"}),
                    cancelled,
                )
                .await?;
                expect_kind(&decision, "stopping")?;
            }
            ExampleOutcome030::Reported => {
                let text = emit(host, pool, config, tasks, attempt, project_id, "text",
                    serde_json::json!({"kind":"visibleText","messageId":"report","textParts":["Reported."]}), cancelled).await?;
                expect_kind(&text, "waiting")?;
                let turn = emit(
                    host,
                    pool,
                    config,
                    tasks,
                    attempt,
                    project_id,
                    "submit",
                    serde_json::json!({"kind":"submit","callId":"report","argumentsJson":"{}"}),
                    cancelled,
                )
                .await?;
                expect_kind(&turn, "accepted")?;
            }
        }
        Ok(())
    }
}

fn expect_kind(decision: &ProtocolDecision030, expected: &str) -> Result<()> {
    let receipt: serde_json::Value = serde_json::from_str(&decision.receipt_json)?;
    if receipt
        .pointer("/decision/kind")
        .and_then(serde_json::Value::as_str)
        != Some(expected)
    {
        return Err(failure(
            "CORRELATION",
            "example",
            "Controller decision differs from the observed example outcome",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn emit(
    host: &HostState,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    attempt: &FlowWorkAttempt030,
    project_id: &str,
    label: &str,
    body: serde_json::Value,
    cancelled: &CancellationToken,
) -> Result<ProtocolDecision030> {
    let policies = PolicyLeases030::acquire(config, project_id).await?;
    let lease = host.start_lease().await?;
    let gate = host.admission_lock().lock_owned().await;
    host.flow030().available(attempt.identity())?;
    let parent = format!(
        "flow030:{}:{}",
        attempt.identity().system_start_id,
        attempt.start_effect_id()
    );
    tasks.verify_agent_scope030(&parent, attempt).map_err(|_| {
        failure(
            "AUTHORITY",
            "example",
            "Owned example parent is unavailable",
        )
    })?;
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let raw_context: String = sqlx::query_scalar("SELECT context_json FROM engine_flow030_work_admissions WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&attempt.work().activation_id).fetch_one(&mut *tx).await?;
    let context: EngineContext = serde_json::from_str(&raw_context)?;
    let revision: Option<String> = sqlx::query_scalar("SELECT revision FROM engine_flow030_work_state WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&attempt.work().activation_id).fetch_optional(&mut *tx).await?;
    let event_id = format!("example:{}:{}", attempt.provider_attempt_id(), label);
    let event_json = serde_json::json!({"eventId":event_id,"owner":{
        "systemStartId":attempt.work().system_start_id,"activationId":attempt.work().activation_id,
        "agentInstanceId":attempt.work().agent_instance_id,"ownerEpoch":attempt.owner().owner_epoch},"event":body}).to_string();
    let input = ProtocolEvent030 {
        context: context.clone(),
        event_id: event_id.clone(),
        expected_revision: revision.unwrap_or_else(|| "0".into()),
        event_json: event_json.clone(),
        native_call: Some(NativeCall030 {
            provider_attempt_id: attempt.provider_attempt_id().into(),
            native_call_id: event_id.clone(),
        }),
        control: false,
    };
    let operation = OwnedOperation030 {
        identity: attempt.identity().clone(),
        context,
        generation: attempt.generation().into(),
        agent: attempt.agent().into(),
        provider_attempt_id: attempt.provider_attempt_id().into(),
        operation_id: event_id,
        method: "example/event".into(),
        request_json: event_json,
    };
    lease.ensure_live()?;
    tx.rollback().await?;
    let permit = lease.attach_owned_operation030(tasks, &parent, operation)?;
    drop(db);
    drop(gate);
    drop(lease);
    flow_work_protocol030::transition_owned_agent030(
        host, pool, attempt, &input, permit, policies, cancelled,
    )
    .await
}

impl ExampleObservation030 {
    pub(crate) fn adapter_id(&self) -> &'static str {
        ADAPTER
    }
    pub(crate) fn version(&self) -> &'static str {
        VERSION
    }

    /// Build transport observations from this adapter and the native source
    /// lock. The later 036 writer still obtains and checks actual 03 policy.
    pub(crate) fn registry(
        &self,
        document: &serde_json::Value,
        authored_source: &str,
        source_sha256: &str,
        scope: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        use sha2::{Digest, Sha256};
        if format!("{:x}", Sha256::digest(authored_source.as_bytes())) != source_sha256
            || serde_json::from_str::<serde_json::Value>(authored_source)? != *document
        {
            return Err(failure(
                "CORRELATION",
                "example",
                "Native example source differs",
            ));
        }
        let agents = document
            .get("agents")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| failure("CORRELATION", "example", "Example agents are absent"))?;
        let expected = [("dev", "workspace"), ("ops", "read-only")];
        if agents.len() != expected.len()
            || expected.iter().any(|(name, permissions)| {
                agents.get(*name)
                    != Some(&serde_json::json!({"harness":"example","permissions":permissions}))
            })
        {
            return Err(failure(
                "HARNESS_REFUSED",
                "example",
                "Example declarations are outside the QA scenario",
            ));
        }
        let module = serde_json::json!({
            "name":"example", "version":VERSION, "contract":"agsdl-0.3.0", "harnessVersions":">=1.0.0 <2.0.0",
            "properties":{"resources":{"support":"native"}},
            "permissions":{
                "read":{"allow":"sandbox","deny":"sandbox","ask":"sandbox","outside":"sandbox"},
                "write":{"allow":"sandbox","deny":"sandbox","ask":"sandbox"},
                "shell":{"allow":"sandbox","deny":"sandbox","ask":"sandbox"},
                "network":{"allow":"sandbox","deny":"sandbox","ask":"sandbox"},
                "mcp":{"allow":"sandbox","deny":"sandbox","ask":"sandbox"},
                "delegate":{"allow":"sandbox","deny":"sandbox","ask":"sandbox"}
            }
        });
        let evidence = serde_json::json!({"adapterId":ADAPTER,"sourceSha256":source_sha256,"kind":"native-example-qa"}).to_string();
        let capabilities = [
            "result-submission",
            "continuity",
            "permission-enforcement",
            "contained-stop",
            "response-attribution",
            "resources",
            "delivery.queue",
        ]
        .iter()
        .map(|name| serde_json::json!({"name":name,"support":"native","evidenceJson":evidence}))
        .collect::<Vec<_>>();
        let observed = expected.iter().map(|(name,_)| {
            let agent = &agents[*name];
            serde_json::json!({"agentName":name,"agentDeclarationJson":agent.to_string(),"settingsJson":"{}",
                "permissionsJson":serde_json::json!({"requested":agent["permissions"],"authority":"native-03-at-handoff"}).to_string(),
                "scopeJson":scope.to_string(),"evidenceJson":evidence,
                "provenanceJson":serde_json::json!({"sourceSha256":source_sha256,"agent":name}).to_string()})
        }).collect::<Vec<_>>();
        Ok(
            serde_json::json!({"modules":[{"harness":"example","moduleJson":module.to_string()}],
            "harnesses":[{"harness":"example","version":VERSION,"installation":"available","adapterId":ADAPTER,
                "qualified":true,"capabilities":capabilities,
                "models":[{"name":"in-process-example","efforts":[],"defaultEffort":null}],"defaultModel":"in-process-example"}],
            "agents":observed}),
        )
    }
}

mod isolation_tests {
    use super::*;
    use crate::core::config::{apply_runtime_workspace, AppConfig};

    async fn approved_workspace(
        valid: bool,
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::path::PathBuf,
        AppConfig,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let qa = temp.path().join("qa");
        let workspace = qa.join("workspace");
        let config = qa.join("config");
        let fallback = temp.path().join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let mut runtime = serde_json::json!({"schemaVersion":1,"defaultWorkspace":workspace});
        if valid {
            runtime["$schema"] = serde_json::json!("./schemas/v1/runtime.schema.json");
        }
        std::fs::write(
            config.join("runtime.json"),
            serde_json::to_vec(&runtime).unwrap(),
        )
        .unwrap();
        let manager = ConfigManager::initialize(config).await.unwrap();
        let snapshot = manager.get_snapshot(&[]).await.unwrap();
        let mut actual = AppConfig::default();
        actual.workspace_path = fallback;
        apply_runtime_workspace(&mut actual, &snapshot.effective["runtime"]).unwrap();
        (temp, qa, workspace, actual)
    }

    async fn reject_invalid_runtime_fallback() {
        let (temp, qa, expected, actual) = approved_workspace(false).await;
        let sentinel = temp.path().join("outside/workspace.json");
        std::fs::write(&sentinel, b"unchanged").unwrap();
        assert!(actual.workspace_path_source.is_default());
        assert!(check_effective_workspace(
            &qa,
            &expected,
            &actual.workspace_path,
            actual.workspace_path_source.is_default()
        )
        .is_err());
        // Default provenance remains forbidden even if cwd resolves inside QA.
        assert!(check_effective_workspace(&qa, &expected, &expected, true).is_err());
        // A configured path outside the QA directory is also forbidden.
        assert!(check_effective_workspace(&qa, &expected, &actual.workspace_path, false).is_err());
        #[cfg(unix)]
        {
            let link = qa.join("outside-link");
            std::os::unix::fs::symlink(&actual.workspace_path, &link).unwrap();
            assert!(check_effective_workspace(&qa, &expected, &link, false).is_err());
        }
        assert_eq!(std::fs::read(sentinel).unwrap(), b"unchanged");
    }

    async fn accept_approved_workspace() {
        let (_temp, qa, expected, actual) = approved_workspace(true).await;
        assert!(!actual.workspace_path_source.is_default());
        check_effective_workspace(
            &qa,
            &expected,
            &actual.workspace_path,
            actual.workspace_path_source.is_default(),
        )
        .unwrap();
        assert!(check_effective_workspace(&qa, &expected, &actual.workspace_path, true).is_err());
    }

    pub(super) async fn run_checks() {
        reject_invalid_runtime_fallback().await;
        accept_approved_workspace().await;
        let temp = tempfile::tempdir().unwrap();
        let qa = temp.path().join("qa");
        let workspace = qa.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let old_flag = std::env::var_os("MACRO_AGSDL_ENGINE_QA");
        let old_dir = std::env::var_os("MACRO_AGSDL_ENGINE_QA_DIR");
        std::env::set_var("MACRO_AGSDL_ENGINE_QA", "1");
        std::env::set_var("MACRO_AGSDL_ENGINE_QA_DIR", &qa);
        assert!(validate_qa_workspace(&workspace, true).is_err());
        assert!(!qa.join("isolation.json").exists());
        validate_qa_workspace(&workspace, false).unwrap();
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(qa.join("isolation.json")).unwrap()).unwrap();
        assert_eq!(report["kind"], "native-example-isolation/1");
        assert_eq!(report["configured"], true);
        assert_eq!(
            QA_APPROVED_WORKSPACE.get(),
            Some(&std::fs::canonicalize(&workspace).unwrap())
        );
        match old_flag {
            Some(value) => std::env::set_var("MACRO_AGSDL_ENGINE_QA", value),
            None => std::env::remove_var("MACRO_AGSDL_ENGINE_QA"),
        }
        match old_dir {
            Some(value) => std::env::set_var("MACRO_AGSDL_ENGINE_QA_DIR", value),
            None => std::env::remove_var("MACRO_AGSDL_ENGINE_QA_DIR"),
        }
    }

    #[tokio::test]
    async fn isolation_rejects_invalid_runtime_fallback_before_discovery() {
        reject_invalid_runtime_fallback().await;
    }

    #[tokio::test]
    async fn isolation_accepts_only_approved_canonical_workspace() {
        accept_approved_workspace().await;
    }
}

pub(crate) async fn run_isolation_checks030() {
    isolation_tests::run_checks().await;
}
