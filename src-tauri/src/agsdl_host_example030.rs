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

// The QA anchor is fixed by the host, not by an inherited TMPDIR.
fn qa_temporary_base() -> std::io::Result<std::path::PathBuf> {
    #[cfg(unix)]
    {
        std::fs::canonicalize("/tmp")
    }
    #[cfg(not(unix))]
    {
        Err(std::io::Error::other(
            "Native example QA has no trusted temporary base on this platform",
        ))
    }
}

fn check_qa_root_directory(directory: &std::path::Path) -> std::io::Result<()> {
    let denied = || {
        std::io::Error::other(
            "Native example QA requires a private child of the fixed temporary base",
        )
    };
    let directory = std::fs::canonicalize(directory)?;
    let base = qa_temporary_base()?;
    if directory.parent() != Some(base.as_path()) {
        return Err(denied());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(&directory)?;
        if metadata.mode() & 0o777 != 0o700 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(denied());
        }
    }
    check_qa_repository_boundary(&directory, None)
}

fn qa_git_marker(directory: &std::path::Path) -> std::io::Result<bool> {
    fn exists(path: &std::path::Path) -> std::io::Result<bool> {
        match std::fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
    // Stat markers only. Do not open Git contents or invoke repository discovery,
    // which could create or repair metadata outside this synthetic workspace.
    Ok(exists(&directory.join(".git"))?
        || (exists(&directory.join("HEAD"))?
            && exists(&directory.join("objects"))?
            && exists(&directory.join("refs"))?))
}

fn check_qa_repository_boundary(
    directory: &std::path::Path,
    workspace: Option<&std::path::Path>,
) -> std::io::Result<()> {
    let denied =
        || std::io::Error::other("Native example QA refuses Git ancestry or workspace links");
    let directory = std::fs::canonicalize(directory)?;
    for ancestor in directory.ancestors() {
        if qa_git_marker(ancestor)? {
            return Err(denied());
        }
    }
    let Some(workspace) = workspace else {
        return Ok(());
    };
    let workspace = std::fs::canonicalize(workspace)?;
    if !workspace.starts_with(&directory) {
        return Err(denied());
    }
    let mut pending = vec![workspace];
    while let Some(path) = pending.pop() {
        if qa_git_marker(&path)? {
            return Err(denied());
        }
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let kind = std::fs::symlink_metadata(entry.path())?.file_type();
            if kind.is_symlink() {
                return Err(denied());
            }
            if kind.is_dir() {
                pending.push(entry.path());
            } else if !kind.is_file() {
                return Err(denied());
            }
        }
    }
    Ok(())
}

fn check_qa_registry(workspace: &std::path::Path) -> std::io::Result<()> {
    let denied = || std::io::Error::other("Native example QA registry is not isolated");
    let file = workspace.join(".macro/workspace.json");
    let registry: serde_json::Value = serde_json::from_slice(&std::fs::read(file)?)?;
    let projects = registry
        .get("standaloneProjects")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(denied)?;
    if projects.len() != 1
        || projects[0].get("id").and_then(serde_json::Value::as_str) != Some("project")
    {
        return Err(denied());
    }
    for key in ["project_groups", "projectGroups"] {
        if registry
            .get(key)
            .is_some_and(|v| v.as_array().is_none_or(|groups| !groups.is_empty()))
        {
            return Err(denied());
        }
    }
    for project in projects {
        let raw = project
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(denied)?;
        let path = std::path::Path::new(raw);
        let canonical = std::fs::canonicalize(path)?;
        if !path.is_absolute()
            || path != canonical
            || !canonical.starts_with(workspace)
            || canonical == workspace
        {
            return Err(denied());
        }
        check_qa_repository_boundary(&canonical, None)?;
    }
    Ok(())
}

fn check_qa_no_product_windows(config: &tauri::Config, main_present: bool) -> std::io::Result<()> {
    if !config.app.windows.is_empty() || main_present {
        return Err(std::io::Error::other(
            "Native engine QA requires no product windows",
        ));
    }
    Ok(())
}

// Inspect a supplied snapshot so tests never mutate process-global environment.
fn check_qa_environment(
    directory: &std::path::Path,
    variables: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> std::io::Result<()> {
    let denied = || std::io::Error::other("Native engine QA environment is not isolated");
    let required = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];
    let mut present = std::collections::BTreeSet::new();
    for (key, value) in variables {
        let key = key.to_string_lossy();
        if key.starts_with("GIT_") {
            return Err(denied());
        }
        if key.starts_with("XDG_") {
            if !required.contains(&key.as_ref()) {
                return Err(denied());
            }
            let raw_path = std::path::PathBuf::from(value);
            if !raw_path.is_absolute() {
                return Err(denied());
            }
            let path = std::fs::canonicalize(raw_path)?;
            if !path.starts_with(directory) || path == directory {
                return Err(denied());
            }
            present.insert(key.into_owned());
        }
    }
    if required.iter().any(|key| !present.contains(*key)) {
        return Err(denied());
    }
    Ok(())
}

/// Refuse to initialize the app with a real profile when the QA entry is used.
pub(crate) fn validate_qa_isolation(app: &tauri::AppHandle) -> std::io::Result<()> {
    if std::env::var_os("MACRO_AGSDL_ENGINE_QA").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Ok(());
    }
    let denied =
        || std::io::Error::other("Native example QA requires an isolated temporary profile");
    let directory =
        std::fs::canonicalize(std::env::var_os("MACRO_AGSDL_ENGINE_QA_DIR").ok_or_else(denied)?)?;
    check_qa_root_directory(&directory)?;
    check_qa_environment(&directory, std::env::vars_os())?;
    check_qa_no_product_windows(app.config(), app.get_webview_window("main").is_some())?;
    tracing::info!(
        configured_windows = 0,
        main_present = false,
        "Native engine QA uses only the resident execution host"
    );
    if !app.config().identifier.starts_with("com.macro.desktop.qa.") {
        return Err(denied());
    }
    let home = std::fs::canonicalize(std::env::var_os("HOME").ok_or_else(denied)?)?;
    if !home.starts_with(&directory) {
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
    check_qa_root_directory(&directory)?;
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
        || !expected.starts_with(&directory)
        || effective != expected
    {
        return Err(denied());
    }
    check_qa_repository_boundary(&directory, Some(&effective))?;
    check_qa_registry(&effective)
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
            check_qa_root_directory(&directory).map_err(|_| {
                failure(
                    "CORRELATION",
                    "example",
                    "QA directory does not meet the fixed temporary boundary",
                )
            })?;
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

/// A started example remains owned by the registry while the native timeline
/// decides when to deliver its result. The mailbox does not carry authority.
struct ScriptedWork030 {
    key: crate::agsdl_host_scenario030::WorkKey030,
    attempt: FlowWorkAttempt030,
    send: tokio::sync::oneshot::Sender<crate::agsdl_host_scenario030::ExampleResult030>,
    result: tokio::sync::oneshot::Receiver<Result<()>>,
}

struct ScriptedCall030 {
    key: crate::agsdl_host_scenario030::WorkKey030,
    request_id: String,
    driver: crate::agsdl_host_calls030::SyntheticCallDriver030,
    result: tokio::sync::oneshot::Receiver<Result<crate::agsdl_host_calls030::JoinedCall030>>,
}

async fn start_scripted_call030(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    owner: &crate::db::agsdl_execution::dto::EngineOwner,
    effect: &FlowEffect030,
    cancelled: &CancellationToken,
) -> Result<ScriptedCall030> {
    use crate::agsdl_host_call_authority030::NativeCallAuthority030;
    use crate::agsdl_host_calls030 as calls;
    let host = app.state::<HostState>();
    let lease = host.start_lease().await?;
    let broker = lease.call_data030()?;
    drop(lease);
    let authority = NativeCallAuthority030::capture(&host, owner).await?;
    let attempt = calls::reserve_call030(pool, &authority, effect).await?;
    match calls::prepare_call030(pool, &authority, &broker, &attempt, cancelled).await? {
        calls::CallPreparation030::Ready => {}
        _ => {
            return Err(failure(
                "CORRELATION",
                "example",
                "Pinned command preparation failed",
            ))
        }
    }
    drop(authority);
    let key = scripted_work_key030(effect)?;
    let claim = crate::agsdl_host_flow030::claim_expected(
        host.flow030(),
        &host,
        pool,
        &effect.identity,
        &effect.id,
    )
    .await?
    .ok_or_else(|| failure("STALE_REFERENCE", "call", "Pinned call Start changed"))?;
    if claim.effect() != effect {
        return Err(failure("CORRELATION", "call", "Pinned call claim differs"));
    }
    let request_id = claim.request_id();
    let (driver_send, driver_recv) = tokio::sync::oneshot::channel();
    let (result_send, result) = tokio::sync::oneshot::channel();
    let (app, pool, owner, cancelled) =
        (app.clone(), pool.clone(), owner.clone(), cancelled.clone());
    claim
        .handoff_host(tasks, async move {
            let host = app.state::<HostState>();
            let result = async {
                let authority = NativeCallAuthority030::capture(&host, &owner).await?;
                let control = crate::agsdl_host_calls::Control {
                    stop: CancellationToken::new(),
                    machine_timeout: CancellationToken::new(),
                };
                let (driver, owned) =
                    calls::launch_synthetic030(&pool, &authority, &attempt, control).await?;
                drop(authority);
                driver_send
                    .send(driver)
                    .map_err(|_| failure("UNCERTAIN", "call", "Call timeline closed"))?;
                let joined = owned.join().await?;
                let authority = NativeCallAuthority030::capture(&host, &owner).await?;
                match calls::finish_joined_call030(&pool, &authority, &broker, &joined, &cancelled)
                    .await?
                {
                    calls::CallSettlement030::Terminal { .. } => Ok(joined),
                    calls::CallSettlement030::Diagnostic { .. } => {
                        Err(failure("UNCERTAIN", "call", "Pinned call has a diagnostic"))
                    }
                }
            }
            .await;
            let _ = result_send.send(result);
        })
        .await?;
    let driver = driver_recv
        .await
        .map_err(|_| failure("UNCERTAIN", "call", "Call launch did not acknowledge"))?;
    Ok(ScriptedCall030 {
        key,
        request_id,
        driver,
        result,
    })
}

fn scripted_work_key030(
    effect: &FlowEffect030,
) -> Result<crate::agsdl_host_scenario030::WorkKey030> {
    let FlowEffectKind030::Start {
        step: Some(step),
        item_json,
        occurrence,
        ..
    } = &effect.kind
    else {
        return Err(failure("CORRELATION", "example", "Scripted start differs"));
    };
    let item = if item_json.is_some() {
        Some(
            occurrence
                .as_ref()
                .ok_or_else(|| failure("CORRELATION", "example", "Item occurrence is absent"))?
                .item_index
                .clone(),
        )
    } else {
        None
    };
    Ok(crate::agsdl_host_scenario030::WorkKey030 {
        step: step.clone(),
        item,
    })
}

async fn start_scripted_work030(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    owner: &crate::db::agsdl_execution::dto::EngineOwner,
    effect: &FlowEffect030,
    cancelled: &CancellationToken,
) -> Result<ScriptedWork030> {
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
    let project = inspection.capture.source.owner.project_id.clone();
    let key = scripted_work_key030(effect)?;
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
    let (outcome_send, outcome_recv) = tokio::sync::oneshot::channel();
    let (app, pool, config, tasks_owned, effect, cancelled) = (
        app.clone(),
        pool.clone(),
        config.clone(),
        tasks.clone(),
        effect.clone(),
        cancelled.clone(),
    );
    claim
        .handoff_agent(tasks, policy, move |attempt| async move {
            if attempt_send.send(attempt.clone()).is_err() {
                return;
            }
            let outcome = match outcome_recv.await {
                Ok(value) => value,
                Err(_) => return,
            };
            let host = app.state::<HostState>();
            let result = run_scripted_owned030(
                &host,
                &pool,
                &config,
                &tasks_owned,
                &attempt,
                &project,
                &effect,
                outcome,
                &cancelled,
            )
            .await;
            let _ = result_send.send(result);
        })
        .await?;
    let attempt = attempt_recv.await.map_err(|_| {
        failure(
            "UNCERTAIN",
            "example",
            "Owned example attempt is unavailable",
        )
    })?;
    Ok(ScriptedWork030 {
        key,
        attempt,
        send: outcome_send,
        result: result_recv,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_scripted_owned030(
    host: &HostState,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    attempt: &FlowWorkAttempt030,
    project_id: &str,
    effect: &FlowEffect030,
    outcome: crate::agsdl_host_scenario030::ExampleResult030,
    cancelled: &CancellationToken,
) -> Result<()> {
    let correlated = matches!(&effect.kind, FlowEffectKind030::Start {work, step, agent:Some(agent), ..}
        if effect.identity == *attempt.identity() && effect.id == attempt.start_effect_id()
            && work.start_effect_id == attempt.start_effect_id() && work.activation_id == attempt.work().activation_id
            && work.agent_instance_id == attempt.work().agent_instance_id && step == &attempt.work().step && agent == attempt.agent());
    if !correlated || cancelled.is_cancelled() {
        return Err(failure("CORRELATION", "example", "Scripted work differs"));
    }
    match outcome {
        crate::agsdl_host_scenario030::ExampleResult030::Failed(code) => {
            let decision = emit(
                host,
                pool,
                config,
                tasks,
                attempt,
                project_id,
                "failure",
                serde_json::json!({"kind":"stop","reason":code}),
                cancelled,
            )
            .await?;
            expect_kind(&decision, "stopping")?;
        }
        crate::agsdl_host_scenario030::ExampleResult030::Returned { text, submit_json } => {
            if let Some(text) = text {
                let decision = emit(host, pool, config, tasks, attempt, project_id, "text", serde_json::json!({"kind":"visibleText","messageId":"example","textParts":[text]}), cancelled).await?;
                expect_kind(&decision, "waiting")?;
            }
            let decision = emit(
                host,
                pool,
                config,
                tasks,
                attempt,
                project_id,
                "submit",
                serde_json::json!({"kind":"submit","callId":"example","argumentsJson":submit_json}),
                cancelled,
            )
            .await?;
            expect_kind(&decision, "accepted")?;
        }
    }
    Ok(())
}

/// Drain eligible effects before the next timeline event. Agent starts are
/// attached to owned parents and wait for the corresponding native mailbox.
async fn quiesce_scenario030(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    owner: &crate::db::agsdl_execution::dto::EngineOwner,
    works: &mut Vec<ScriptedWork030>,
    calls: &mut Vec<ScriptedCall030>,
    joined_calls: &std::collections::BTreeMap<String, crate::agsdl_host_calls030::JoinedCall030>,
    joined: &std::collections::BTreeMap<String, crate::agsdl_host_dispatch030::JoinedOwnedAgent030>,
    cancelled: &CancellationToken,
) -> Result<crate::db::agsdl_execution::flow_store030::FlowView030> {
    let host = app.state::<HostState>();
    for _ in 0..256 {
        if cancelled.is_cancelled() {
            return Err(failure("INTERRUPTED", "example", "Scenario was cancelled"));
        }
        let inspection =
            crate::agsdl_host_flow030::inspect_run(host.flow030(), &host, pool, owner).await?;
        let mut next = None;
        for row in &inspection.flow.effects {
            let status = row.get("status").and_then(serde_json::Value::as_str);
            if status == Some("uncertain") {
                return Err(failure("UNCERTAIN", "example", "Effect is unresolved"));
            }
            if status != Some("pending") {
                continue;
            }
            let effect: FlowEffect030 =
                serde_json::from_value(row.get("effect").cloned().ok_or_else(|| {
                    failure("CORRELATION", "example", "Effect payload is absent")
                })?)?;
            if crate::db::agsdl_execution::flow_store030::eligible(&inspection.flow.state, &effect)
            {
                next = Some(effect);
                break;
            }
        }
        let Some(effect) = next else {
            return Ok(inspection.flow);
        };
        match &effect.kind {
            FlowEffectKind030::Start { agent: Some(_), .. } => {
                let key = scripted_work_key030(&effect)?;
                if works.iter().any(|existing| existing.key == key) {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Scripted work key is ambiguous",
                    ));
                }
                let work =
                    start_scripted_work030(app, pool, config, tasks, owner, &effect, cancelled)
                        .await?;
                works.push(work);
            }
            FlowEffectKind030::Start { agent: None, .. } => {
                let key = scripted_work_key030(&effect)?;
                if calls.iter().any(|c| c.key == key) || works.iter().any(|w| w.key == key) {
                    return Err(failure(
                        "CORRELATION",
                        "call",
                        "Pinned call key is ambiguous",
                    ));
                }
                calls.push(
                    start_scripted_call030(app, pool, tasks, owner, &effect, cancelled).await?,
                );
            }
            FlowEffectKind030::StopWork { work, .. } => {
                let matching = works
                    .iter()
                    .enumerate()
                    .filter(|(_, w)| {
                        w.attempt.work().activation_id == work.activation_id
                            && w.attempt.start_effect_id() == work.start_effect_id
                            && w.attempt.work().agent_instance_id == work.agent_instance_id
                    })
                    .map(|(i, _)| i)
                    .collect::<Vec<_>>();
                if matching.len() != 1 {
                    return Err(failure("CORRELATION", "stop", "Stopped work is not unique"));
                }
                let index = matching[0];
                crate::agsdl_host_dispatch030::dispatch_stop_work030(
                    &host,
                    pool,
                    tasks,
                    owner,
                    &effect,
                    &works[index].attempt,
                )
                .await?;
                works.remove(index);
            }
            FlowEffectKind030::PrepareRoute { reference, .. } => {
                crate::agsdl_host_dispatch030::dispatch_source_route030(
                    &host,
                    pool,
                    owner,
                    reference,
                    if let Some(call) = joined_calls.get(&reference.activation_id) {
                        crate::agsdl_host_dispatch030::SourceOwnership030::Call(call)
                    } else {
                        joined.get(&reference.activation_id).map_or(
                            crate::agsdl_host_dispatch030::SourceOwnership030::Join,
                            crate::agsdl_host_dispatch030::SourceOwnership030::Agent,
                        )
                    },
                    cancelled,
                )
                .await?;
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
                    "Effect is outside the pinned scenario",
                ))
            }
        }
    }
    Err(failure(
        "CORRELATION",
        "example",
        "Scenario dispatch exceeded its bound",
    ))
}

async fn drive_scenario030(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    owner: &crate::db::agsdl_execution::dto::EngineOwner,
    scenario: crate::agsdl_host_scenario030::PinnedScenario030,
    cancelled: &CancellationToken,
) -> Result<crate::db::agsdl_execution::flow_store030::FlowView030> {
    use crate::agsdl_host_scenario030::TimelineEvent030;
    let mut works: Vec<ScriptedWork030> = Vec::new();
    let mut calls: Vec<ScriptedCall030> = Vec::new();
    let mut joined_calls = std::collections::BTreeMap::new();
    let mut joined = std::collections::BTreeMap::new();
    for event in scenario.timeline {
        let view = quiesce_scenario030(
            app,
            pool,
            config,
            tasks,
            owner,
            &mut works,
            &mut calls,
            &joined_calls,
            &joined,
            cancelled,
        )
        .await?;
        match event {
            TimelineEvent030::Running(expected) => {
                let mut actual = works
                    .iter()
                    .map(|w| (w.key.step.clone(), w.key.item.clone()))
                    .chain(
                        calls
                            .iter()
                            .map(|c| (c.key.step.clone(), c.key.item.clone())),
                    )
                    .collect::<Vec<_>>();
                let mut expected = expected
                    .into_iter()
                    .map(|w| (w.step, w.item))
                    .collect::<Vec<_>>();
                actual.sort();
                expected.sort();
                let physical = view.state.activations.iter().filter(|a| a.physical).count();
                if actual != expected
                    || physical != works.len() + calls.len()
                    || works.iter().any(|work| {
                        !view
                            .state
                            .activations
                            .iter()
                            .any(|a| a.id == work.attempt.work().activation_id && a.physical)
                    })
                {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Running work differs from pinned timeline",
                    ));
                }
            }
            TimelineEvent030::Command { key, receipt } => {
                let matching = calls
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.key == key)
                    .map(|(i, _)| i)
                    .collect::<Vec<_>>();
                if matching.len() != 1 || works.iter().any(|w| w.key == key) {
                    return Err(failure(
                        "CORRELATION",
                        "call",
                        "Command timeline work is not unique",
                    ));
                }
                let call = calls.remove(matching[0]);
                call.driver.send(receipt)?;
                let witness = call
                    .result
                    .await
                    .map_err(|_| failure("UNCERTAIN", "call", "Owned call result unavailable"))??;
                if !tasks
                    .cancel_owned(&call.request_id)
                    .await
                    .map_err(|_| failure("UNCERTAIN", "call", "Call parent did not join"))?
                {
                    return Err(failure("CORRELATION", "call", "Call parent is absent"));
                }
                joined_calls.insert(witness.attempt().work().activation_id.clone(), witness);
            }
            TimelineEvent030::Work { key, outcome } => {
                let matches = works
                    .iter()
                    .enumerate()
                    .filter(|(_, work)| work.key == key)
                    .map(|(i, _)| i)
                    .collect::<Vec<_>>();
                if matches.len() != 1 {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Timeline work is not unique",
                    ));
                }
                let work = works.remove(matches[0]);
                work.send
                    .send(outcome)
                    .map_err(|_| failure("UNCERTAIN", "example", "Owned work mailbox closed"))?;
                let witness =
                    crate::agsdl_host_dispatch030::join_owned_agent030(tasks, &work.attempt)
                        .await?;
                work.result.await.map_err(|_| {
                    failure(
                        "UNCERTAIN",
                        "example",
                        "Owned example completion is unavailable",
                    )
                })??;
                let host = app.state::<HostState>();
                let decision =
                    flow_work_protocol030::finish_joined_agent030(&host, pool, &witness, cancelled)
                        .await?;
                expect_kind(&decision, "finished")?;
                joined.insert(witness.attempt().work().activation_id.clone(), witness);
            }
        }
    }
    let view = quiesce_scenario030(
        app,
        pool,
        config,
        tasks,
        owner,
        &mut works,
        &mut calls,
        &joined_calls,
        &joined,
        cancelled,
    )
    .await?;
    if !works.is_empty()
        || !calls.is_empty()
        || view.state.verdict.is_none()
        || view.state.activations.iter().any(|a| a.physical)
        || view.effects.iter().any(|row| {
            matches!(
                row.get("status").and_then(serde_json::Value::as_str),
                Some("pending" | "uncertain")
            )
        })
    {
        return Err(failure(
            "UNCERTAIN",
            "example",
            "Scenario did not finish physically and durably",
        ));
    }
    Ok(view)
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
    let entry_json = request
        .entry
        .as_ref()
        .map(|entry| entry.message_json.clone())
        .ok_or_else(|| failure("CORRELATION", "example", "Pinned scenario entry is absent"))?;
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
    let generic = std::env::var("MACRO_AGSDL_ENGINE_QA_CASE").as_deref() == Ok("scenario");
    let mut scenario_pin = None;
    let result = if generic {
        let host = app.state::<HostState>();
        let inspection =
            crate::agsdl_host_flow030::inspect_run(host.flow030(), &host, &pool, &owner).await?;
        let scenario = crate::agsdl_host_scenario030::PinnedScenario030::from_capture(
            &inspection.capture.authored_source,
            &entry_json,
        )?;
        scenario_pin = Some(serde_json::json!({
            "name": scenario.name,
            "fixtureSha256": scenario.fixture_sha256.clone(),
        }));
        drive_scenario030(
            &app,
            &pool,
            &config,
            &ai.stream_tasks,
            &owner,
            scenario,
            cancelled,
        )
        .await
    } else {
        drive_error_route030(&app, &pool, &config, &ai.stream_tasks, &owner, cancelled).await
    };
    let view = match result {
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
    let mut report = serde_json::json!({"receipt":receipt,"projection":projection,"events":inspection.flow.events,"effects":inspection.flow.effects,
        "sourceCommitRecovery":QA_SOURCE_RECOVERED.load(Ordering::SeqCst),
        "prepareRouteNotClaimed":QA_PREPARE_UNCLAIMED.load(Ordering::SeqCst)});
    if let Some(pin) = scenario_pin {
        report["scenario"] = pin;
    }
    Ok(report)
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
    check_qa_root_directory(&root).map_err(|_| refused())?;
    check_qa_repository_boundary(&root, Some(&workspace)).map_err(|_| refused())?;
    check_qa_registry(&workspace).map_err(|_| refused())?;
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

/// QA admission has no external effects. Recheck the native opt-in, approved
/// workspace, captured owner/scope and exact pinned declaration in SQL callers.
pub(crate) fn qualify_synthetic_call030(
    capture: &crate::db::agsdl_execution::start030::StartCapture030,
    effect: &FlowEffect030,
    declaration: &str,
) -> Result<()> {
    let denied = || {
        failure(
            "AUTHORITY",
            "call",
            "Synthetic call is outside native QA capture",
        )
    };
    if !ExampleAdapter030::qa_capture_enabled() || effect.identity != capture.identity {
        return Err(denied());
    }
    let private: serde_json::Value = serde_json::from_str(&capture.private_capture_json)?;
    let scope: serde_json::Value =
        serde_json::from_str(private["callScopeJson"].as_str().ok_or_else(denied)?)?;
    let root = std::path::Path::new(scope["root"].as_str().ok_or_else(denied)?);
    let approved = QA_APPROVED_WORKSPACE.get().ok_or_else(denied)?;
    if !root.starts_with(approved)
        || scope["sourceOwner"] != serde_json::to_value(&capture.source.owner)?
        || scope["projectId"].as_str() != Some(&capture.source.owner.project_id)
    {
        return Err(denied());
    }
    let _: serde_json::Value =
        serde_json::from_str(private["callPermissionsJson"].as_str().ok_or_else(denied)?)?;
    let plan: crate::db::agsdl_execution::flow030::FlowPlan030 =
        serde_json::from_str(&capture.compiled_plan_json)?;
    let FlowEffectKind030::Start {
        step: Some(address),
        agent: None,
        ..
    } = &effect.kind
    else {
        return Err(denied());
    };
    if plan
        .steps
        .iter()
        .filter(|s| {
            s.address == *address && s.r#type == "call" && s.declaration_json == declaration
        })
        .count()
        != 1
    {
        return Err(denied());
    }
    let call: serde_json::Value = serde_json::from_str(declaration)?;
    if !call["command"].is_string()
        || call.get("mcp").is_some()
        || !crate::agsdl_host_scenario030::PinnedScenario030::recognizes_document(
            &capture.authored_source,
        )?
    {
        return Err(denied());
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
        if !crate::agsdl_host_scenario030::PinnedScenario030::recognizes_document(authored_source)?
            || agents.is_empty()
            || agents.values().any(|agent| {
                agent.get("harness").and_then(serde_json::Value::as_str) != Some("example")
            })
        {
            return Err(failure(
                "HARNESS_REFUSED",
                "example",
                "Example declarations are outside the pinned QA scenarios",
            ));
        }
        // This module describes the pinned conformance language. Only the
        // separately observed capabilities qualify this in-process QA adapter.
        let module =
            include_str!("../../dev/agsdl/fixtures/v0.3/conformance/modules/example/module.json");
        if format!("{:x}", Sha256::digest(module.as_bytes()))
            != "95de087ea2d6a97fe36aabbc6ce0fd262c0831dc3f0aad52e2cc10949381db5f"
        {
            return Err(failure(
                "HARNESS_REFUSED",
                "example",
                "Pinned example module differs",
            ));
        }
        let evidence = serde_json::json!({"adapterId":ADAPTER,"sourceSha256":source_sha256,"kind":"native-example-qa"}).to_string();
        let capabilities = [
            "result-submission",
            "continuity",
            "permission-enforcement",
            "contained-stop",
            "response-attribution",
            "resources",
            "delivery.queue",
            "instance.new",
        ]
        .iter()
        .map(|name| {
            let capability_evidence = match *name {
                "delivery.queue" => serde_json::json!({
                    "adapterId":ADAPTER, "sourceSha256":source_sha256,
                    "kind":"host-reducer-queue"
                })
                .to_string(),
                "instance.new" => serde_json::json!({
                    "adapterId":ADAPTER, "sourceSha256":source_sha256,
                    "kind":"native-example-qa", "instance":"fresh-per-work"
                })
                .to_string(),
                _ => evidence.clone(),
            };
            serde_json::json!({"name":name,"support":"native","evidenceJson":capability_evidence})
        })
        .collect::<Vec<_>>();
        let observed = agents.iter().map(|(name, agent)| {
            serde_json::json!({"agentName":name,"agentDeclarationJson":agent.to_string(),"settingsJson":"{}",
                "permissionsJson":serde_json::json!({"requested":agent["permissions"],"authority":"native-03-at-handoff"}).to_string(),
                "scopeJson":scope.to_string(),"evidenceJson":evidence,
                "provenanceJson":serde_json::json!({"sourceSha256":source_sha256,"agent":name}).to_string()})
        }).collect::<Vec<_>>();
        Ok(
            serde_json::json!({"modules":[{"harness":"example","moduleJson":module}],
            "harnesses":[{"harness":"example","version":VERSION,"installation":"available","adapterId":ADAPTER,
                "qualified":true,"capabilities":capabilities,
                "models":[{"name":"in-process-example","efforts":[],"defaultEffort":null}],"defaultModel":"in-process-example"}],
            "agents":observed, "hostCapabilities":[{"name":"call.command","support":"native","evidenceJson":evidence}]}),
        )
    }
}

mod isolation_tests {
    use super::*;
    use crate::core::config::{apply_runtime_workspace, AppConfig};

    fn registry(workspace: &std::path::Path, project: &std::path::Path) {
        std::fs::create_dir_all(workspace.join(".macro")).unwrap();
        std::fs::create_dir_all(project).unwrap();
        std::fs::write(
            workspace.join(".macro/workspace.json"),
            serde_json::to_vec(&serde_json::json!({
                "standaloneProjects":[{"id":"project","path":project}], "project_groups":[]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn reject_repository_boundaries() {
        for case in [
            "ancestor-directory",
            "ancestor-file",
            "bare-ancestor",
            "nested-project",
            "nested-link",
        ] {
            let temp = tempfile::tempdir_in(qa_temporary_base().unwrap()).unwrap();
            let qa = temp.path().join("qa");
            let workspace = qa.join("workspace");
            let outside = temp.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            registry(&workspace, &workspace.join("project"));
            let sentinel = outside.join("workspace.json");
            std::fs::write(&sentinel, b"unchanged synthetic metadata").unwrap();
            match case {
                "ancestor-directory" => std::fs::create_dir(temp.path().join(".git")).unwrap(),
                "ancestor-file" => {
                    std::fs::write(temp.path().join(".git"), b"gitdir: outside/not-opened").unwrap()
                }
                "bare-ancestor" => {
                    std::fs::write(temp.path().join("HEAD"), b"ref: refs/heads/synthetic").unwrap();
                    std::fs::create_dir(temp.path().join("objects")).unwrap();
                    std::fs::create_dir(temp.path().join("refs")).unwrap();
                }
                "nested-project" => std::fs::write(
                    workspace.join("project/.git"),
                    b"gitdir: ../../../outside/not-opened",
                )
                .unwrap(),
                "nested-link" => {
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(&outside, workspace.join("linked-outside")).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                check_effective_workspace(&qa, &workspace, &workspace, false).is_err(),
                "{case}"
            );
            assert!(!qa.join("isolation.json").exists());
            assert_eq!(
                std::fs::read(&sentinel).unwrap(),
                b"unchanged synthetic metadata"
            );
        }
    }

    fn reject_external_registry_and_nested_root() {
        let temp = tempfile::tempdir_in(qa_temporary_base().unwrap()).unwrap();
        let qa = temp.path().join("qa");
        let workspace = qa.join("workspace");
        let outside = temp.path().join("outside");
        registry(&workspace, &outside);
        let sentinel = outside.join("workspace.json");
        std::fs::write(&sentinel, b"unchanged synthetic metadata").unwrap();
        assert!(check_effective_workspace(&qa, &workspace, &workspace, false).is_err());
        assert!(check_qa_root_directory(&qa).is_err());
        assert_eq!(
            std::fs::read(sentinel).unwrap(),
            b"unchanged synthetic metadata"
        );
        assert!(!qa.join("isolation.json").exists());
    }

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
        registry(&workspace, &workspace.join("project"));
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
        reject_repository_boundaries();
        reject_external_registry_and_nested_root();
        let temp = tempfile::tempdir_in(qa_temporary_base().unwrap()).unwrap();
        let qa = temp.path().to_path_buf();
        let workspace = qa.join("workspace");
        registry(&workspace, &workspace.join("project"));
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

    #[test]
    fn isolation_rejects_product_config_and_accepts_the_engine_overlay() {
        let product: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let engine: tauri::Config =
            serde_json::from_str(include_str!("../tauri.agsdl-engine-qa.conf.json")).unwrap();
        assert!(check_qa_no_product_windows(&product, false).is_err());
        assert!(check_qa_no_product_windows(&engine, false).is_ok());
        assert!(check_qa_no_product_windows(&engine, true).is_err());
    }

    #[test]
    fn isolation_environment_requires_private_xdg_and_refuses_git_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("sentinel");
        std::fs::write(&sentinel, b"unchanged").unwrap();
        let mut environment = Vec::new();
        for (key, name) in [
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
        ] {
            let path = root.join(name);
            std::fs::create_dir(&path).unwrap();
            environment.push((std::ffi::OsString::from(key), path.into_os_string()));
        }
        check_qa_environment(&root, environment.clone()).unwrap();
        for key in [
            "GIT_DIR",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CEILING_DIRECTORIES",
            "XDG_CONFIG_DIRS",
            "XDG_STATE_HOME",
            "XDG_RUNTIME_DIR",
        ] {
            let mut variables = environment.clone();
            variables.push((key.into(), "synthetic".into()));
            assert!(check_qa_environment(&root, variables).is_err(), "{key}");
        }
        for index in 0..environment.len() {
            let mut missing = environment.clone();
            missing.remove(index);
            assert!(check_qa_environment(&root, missing).is_err());
            let mut external = environment.clone();
            external[index].1 = outside.path().as_os_str().to_owned();
            assert!(check_qa_environment(&root, external).is_err());
        }
        #[cfg(unix)]
        {
            let link = root.join("outside-link");
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            let mut linked = environment;
            linked[0].1 = link.into_os_string();
            assert!(check_qa_environment(&root, linked).is_err());
        }
        assert_eq!(std::fs::read(sentinel).unwrap(), b"unchanged");
    }

    #[test]
    fn isolation_rejects_git_context_before_discovery() {
        reject_repository_boundaries();
        reject_external_registry_and_nested_root();
    }

    #[tokio::test]
    async fn isolation_accepts_only_approved_canonical_workspace() {
        accept_approved_workspace().await;
    }
}

pub(crate) async fn run_isolation_checks030() {
    isolation_tests::run_checks().await;
}
