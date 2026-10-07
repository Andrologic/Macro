//! Native ownership of the resident execution webview. A label is not an identity.
use crate::core::db_state::DbPool;
use crate::db::agsdl_execution::{self as repository, dto::EngineOwner, failure, Result};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, ResourceId, Webview, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "agsdl-runtime-host";
const ENTRY: &str = "agsdl-runtime-host.html";
struct Incarnation {
    generation: String,
    compiler: crate::agsdl_host_compiler::CompileBroker,
    lifecycle: Arc<tokio::sync::RwLock<()>>,
    live: AtomicBool,
    ready: AtomicBool,
    loads: AtomicUsize,
    owners: Mutex<BTreeMap<String, EngineOwner>>,
    qa_request: Mutex<Option<(String, String)>>,
}
struct HostResource(Arc<Incarnation>);
impl tauri::Resource for HostResource {}
struct OwnedHost {
    incarnation: Arc<Incarnation>,
    resource: ResourceId,
}
#[derive(Default)]
pub(crate) struct HostState(
    Mutex<Option<OwnedHost>>,
    tokio::sync::Mutex<()>,
    crate::agsdl_host_tools::ToolExecutors,
);

/// Native Start holds this lease through the SQL commit and ownership attachment.
/// Retirement marks the host unavailable immediately, then waits for these attachments.
pub(crate) struct HostStartLease {
    host: Arc<Incarnation>,
    _guard: tokio::sync::OwnedRwLockReadGuard<()>,
}
impl HostStartLease {
    pub(crate) fn generation(&self) -> &str {
        &self.host.generation
    }
    pub(crate) fn ensure_live(&self) -> Result<()> {
        if !self.host.live.load(Ordering::SeqCst) {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "",
                "Execution host was revoked",
            ));
        }
        Ok(())
    }
    pub(crate) fn owner(&self, system_id: &str) -> Result<EngineOwner> {
        self.ensure_live()?;
        self.host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?
            .get(system_id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    "RUNTIME_UNAVAILABLE",
                    "owner",
                    "System has no resident owner",
                )
            })
    }
    pub(crate) fn retain_committed_owner(&self, owner: EngineOwner) -> Result<()> {
        // Deliberately record even if retirement began during SQL commit. The
        // retirement writer cannot inspect this map until this lease is dropped.
        let mut owners = self
            .host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
        if owners
            .get(&owner.system_start_id)
            .is_some_and(|previous| previous != &owner)
        {
            return Err(failure(
                "CORRELATION",
                "",
                "Host cannot replace an owned epoch",
            ));
        }
        owners.insert(owner.system_start_id.clone(), owner);
        Ok(())
    }
}

impl HostState {
    pub(crate) fn tools(&self) -> &crate::agsdl_host_tools::ToolExecutors {
        &self.2
    }
    pub(crate) async fn admission_gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.1.lock().await
    }
    pub(crate) async fn start_lease(&self) -> Result<HostStartLease> {
        let host = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "", "Host not installed"))?;
        let guard = host.lifecycle.clone().read_owned().await;
        if !host.ready.load(Ordering::SeqCst) {
            return Err(failure("RUNTIME_UNAVAILABLE", "", "Host not ready"));
        }
        let lease = HostStartLease {
            host,
            _guard: guard,
        };
        lease.ensure_live()?;
        Ok(lease)
    }
    pub(crate) async fn compile(
        &self,
        source: repository::dto::EngineSourceRevision,
        authored_source: String,
        registry_json: String,
    ) -> Result<crate::agsdl_host_compiler::CompileReceipt> {
        let host = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "", "Host not installed"))?;
        if !host.live.load(Ordering::SeqCst) || !host.ready.load(Ordering::SeqCst) {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "",
                "Compiler host is not ready",
            ));
        }
        let receipt = host
            .compiler
            .compile(&host.generation, source, authored_source, registry_json)
            .await?;
        if !host.live.load(Ordering::SeqCst) || receipt.generation != host.generation {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "",
                "Compiler host was revoked",
            ));
        }
        Ok(receipt)
    }
    /// Called only by native capture after the durable start receipt. There is no
    /// IPC that lets a caller claim an arbitrary system or choose its epoch.
    pub(crate) fn attach_owner(&self, caller: &Webview, owner: EngineOwner) -> Result<()> {
        let incarnation = self.authenticate(caller)?;
        let mut owners = incarnation
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
        if !incarnation.live.load(Ordering::SeqCst) {
            return Err(failure("PERMISSION", "", "Host was revoked during capture"));
        }
        if let Some(previous) = owners.get(&owner.system_start_id) {
            if previous != &owner {
                return Err(failure(
                    "CORRELATION",
                    "",
                    "Host cannot replace an owned epoch",
                ));
            }
        }
        owners.insert(owner.system_start_id.clone(), owner);
        Ok(())
    }
    pub(crate) fn authenticate_owner(
        &self,
        caller: &Webview,
        owner: &EngineOwner,
    ) -> Result<String> {
        let host = self.authenticate(caller)?;
        let owners = host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
        if owners.get(&owner.system_start_id) != Some(owner) {
            return Err(failure(
                "PERMISSION",
                "owner",
                "Execution is not owned by this host incarnation",
            ));
        }
        Ok(host.generation.clone())
    }
    fn authenticate(&self, caller: &Webview) -> Result<Arc<Incarnation>> {
        let host = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host state unavailable"))?;
        let host = host
            .as_ref()
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "", "Host not installed"))?;
        // ResourceTable belongs to the physical caller, even if another window reuses a label.
        let resource = caller
            .resources_table()
            .get::<HostResource>(host.resource)
            .map_err(|_| {
                failure(
                    "PERMISSION",
                    "",
                    "Execution commands require the resident host",
                )
            })?;
        if caller.label() != LABEL
            || !Arc::ptr_eq(&resource.0, &host.incarnation)
            || !host.incarnation.live.load(Ordering::SeqCst)
        {
            return Err(failure(
                "PERMISSION",
                "",
                "Execution host incarnation is not current",
            ));
        }
        Ok(host.incarnation.clone())
    }
}

fn retire(host: &Arc<Incarnation>, database: &DbPool, app: &tauri::AppHandle) {
    let app = app.clone();
    if !host.live.swap(false, Ordering::SeqCst) {
        return;
    }
    host.ready.store(false, Ordering::SeqCst);
    host.compiler.close();
    let database = database.clone();
    let host = host.clone();
    tauri::async_runtime::spawn(async move {
        let _retirement_guard = host.lifecycle.clone().write_owned().await;
        let owners = host
            .owners
            .lock()
            .expect("host ownership")
            .values()
            .cloned()
            .collect::<Vec<_>>();

        // Authority is already revoked in memory. Retain the retirement until the
        // native journal acknowledges it; shutdown recovery handles process loss.
        while !owners.is_empty() {
            if let Ok(pool) = database.wait_until_ready().await {
                if repository::revoke_host_owners(&pool, &owners).await.is_ok() {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        drop(_retirement_guard);
        // A native replacement follows durable fencing, never a Flow polling tick.
        for _ in 0..10 {
            let current = app
                .state::<HostState>()
                .0
                .lock()
                .ok()
                .and_then(|owned| {
                    owned
                        .as_ref()
                        .map(|owned| Arc::ptr_eq(&owned.incarnation, &host))
                })
                .unwrap_or(false);
            if !current {
                return;
            }
            let app_for_main = app.clone();
            let retired = host.clone();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if app
                .run_on_main_thread(move || {
                    let matches = app_for_main
                        .state::<HostState>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|owned| {
                            owned
                                .as_ref()
                                .map(|owned| Arc::ptr_eq(&owned.incarnation, &retired))
                        })
                        .unwrap_or(false);
                    if !matches {
                        let _ = sender.send(true);
                        return;
                    }
                    if let Some(window) = app_for_main.get_webview_window(LABEL) {
                        let _ = window.destroy();
                    }
                    let _ = sender.send(install(&app_for_main).is_ok());
                })
                .is_err()
            {
                return;
            }
            if receiver.await.unwrap_or(false) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        tracing::warn!("Resident execution host replacement failed after bounded retries");
    });
}

pub(crate) fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let incarnation = Arc::new(Incarnation {
        generation: uuid::Uuid::new_v4().to_string(),
        compiler: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(false),
        loads: AtomicUsize::new(0),
        owners: Mutex::new(BTreeMap::new()),
        qa_request: Mutex::new(None),
    });
    let navigation_database = app.state::<DbPool>().inner().clone();
    let load_database = navigation_database.clone();
    let destroy_database = navigation_database.clone();
    let navigation_app = app.clone();
    let load_app = app.clone();
    let destroy_app = app.clone();
    let navigation = incarnation.clone();
    let load = incarnation.clone();
    let expected = if cfg!(dev) {
        app.config()
            .build
            .dev_url
            .as_ref()
            .and_then(|url| url.join(ENTRY).ok())
    } else {
        None
    };
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(ENTRY.into()))
        .visible(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |url| {
            let allowed = expected.as_ref().map_or_else(
                || {
                    matches!(url.scheme(), "tauri" | "http" | "https")
                        && matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
                        && url.path() == format!("/{ENTRY}")
                        && url.query().is_none()
                        && url.fragment().is_none()
                },
                |expected| url == expected,
            );
            if !allowed {
                retire(&navigation, &navigation_database, &navigation_app);
            }
            allowed && navigation.live.load(Ordering::SeqCst)
        })
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
                && load.loads.fetch_add(1, Ordering::SeqCst) > 0
            {
                retire(&load, &load_database, &load_app);
            }
        })
        .build()?;
    let resource = window
        .as_ref()
        .resources_table()
        .add(HostResource(incarnation.clone()));
    *app.state::<HostState>()
        .0
        .lock()
        .expect("host installation") = Some(OwnedHost {
        incarnation: incarnation.clone(),
        resource,
    });
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            retire(&incarnation, &destroy_database, &destroy_app);
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn execution_host_ready(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<String> {
    let host = state.authenticate(&webview)?;
    if !host.ready.swap(true, Ordering::SeqCst) {
        // Do not await the compiler here: the JS mailbox starts after this handshake.
        let generation = host.generation.clone();
        // This synchronous command runs on the main thread, outside a Tokio context.
        tauri::async_runtime::spawn(async move {
            if let Err(error) = reattach_retained(&app, &generation).await {
                tracing::warn!(code = %error.code, "Execution host recovery did not complete");
            }
        });
    }
    Ok(host.generation.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn retirement_waits_for_owner_committed_during_start() {
        let host = Arc::new(Incarnation {
            generation: "native-generation".into(),
            compiler: Default::default(),
            lifecycle: Arc::new(tokio::sync::RwLock::new(())),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(true),
            loads: AtomicUsize::new(0),
            owners: Mutex::new(BTreeMap::new()),
            qa_request: Mutex::new(None),
        });
        let lease = HostStartLease {
            host: host.clone(),
            _guard: host.lifecycle.clone().read_owned().await,
        };
        host.live.store(false, Ordering::SeqCst);
        assert!(lease.ensure_live().is_err());
        assert!(host.lifecycle.try_write().is_err());
        let owner = EngineOwner {
            system_start_id: "committed-system".into(),
            owner_epoch: "0".into(),
        };
        lease.retain_committed_owner(owner.clone()).unwrap();
        drop(lease);
        let _retirement = host.lifecycle.write().await;
        assert_eq!(
            host.owners.lock().unwrap().get("committed-system"),
            Some(&owner)
        );
    }

    #[test]
    fn physical_resource_cannot_be_replaced_by_a_matching_generation_string() {
        let first = Arc::new(Incarnation {
            generation: "same".into(),
            compiler: Default::default(),
            lifecycle: Arc::new(tokio::sync::RwLock::new(())),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            loads: AtomicUsize::new(0),
            owners: Mutex::new(BTreeMap::new()),
            qa_request: Mutex::new(None),
        });
        let forged = Arc::new(Incarnation {
            generation: "same".into(),
            compiler: Default::default(),
            lifecycle: Arc::new(tokio::sync::RwLock::new(())),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            loads: AtomicUsize::new(0),
            owners: Mutex::new(BTreeMap::new()),
            qa_request: Mutex::new(None),
        });
        assert!(!Arc::ptr_eq(&first, &forged));
        let mut table = tauri::ResourceTable::default();
        let id = table.add(HostResource(first.clone()));
        assert!(Arc::ptr_eq(
            &table.get::<HostResource>(id).unwrap().0,
            &first
        ));
        assert!(tauri::ResourceTable::default()
            .get::<HostResource>(id)
            .is_err());
    }
}

#[tauri::command]
pub(crate) async fn execution_host_next_compile(
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<crate::agsdl_host_compiler::HostCompileJob> {
    let host = state.authenticate(&webview)?;
    let job = host.compiler.next().await?;
    state.authenticate(&webview)?;
    Ok(job)
}
#[tauri::command]
pub(crate) fn execution_host_complete_compile(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    ticket: String,
    result_json: String,
) -> Result<()> {
    let host = state.authenticate(&webview)?;
    host.compiler
        .complete(&host.generation, &ticket, result_json)
}

#[tauri::command]
pub(crate) fn execution_host_failed(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
) -> Result<()> {
    let host = state.authenticate(&webview)?;
    retire(&host, database.inner(), &app);
    Ok(())
}

#[tauri::command]
pub(crate) fn execution_host_owners(
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<Vec<EngineOwner>> {
    let host = state.authenticate(&webview)?;
    let owners = host
        .owners
        .lock()
        .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
    Ok(owners.values().cloned().collect())
}
#[tauri::command]
pub(crate) async fn execution_host_inspect(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
) -> Result<repository::inspection::HostInspection> {
    state.authenticate_owner(&webview, &owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let result = repository::inspection::read(&pool, &owner).await?;
    state.authenticate_owner(&webview, &owner)?;
    Ok(result)
}
#[tauri::command]
pub(crate) async fn execution_host_begin(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
    delivery_id: String,
) -> Result<repository::inspection::HostAdmission> {
    state.authenticate_owner(&webview, &owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let result = repository::begin(&pool, &owner, &delivery_id).await?;
    state.authenticate_owner(&webview, &owner)?;
    Ok(result.into())
}

#[tauri::command]
pub(crate) async fn execution_host_prepare_terminal(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    request: repository::prepared::Prepare,
) -> Result<String> {
    let generation = state.authenticate_owner(&webview, &request.owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::prepared::prepare(&pool, &generation, request).await
}
#[tauri::command]
pub(crate) async fn execution_host_commit_terminal(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
    witness_id: String,
) -> Result<repository::dto::EngineTerminalCommit> {
    let generation = state.authenticate_owner(&webview, &owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::prepared::commit(&pool, &generation, &owner, &witness_id).await
}
#[tauri::command]
pub(crate) async fn execution_host_append_response(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    emission: repository::responses::Emission,
) -> Result<bool> {
    state.authenticate_owner(&webview, &emission.context.owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::responses::append(&pool, emission).await
}
#[tauri::command]
pub(crate) async fn execution_host_read_responses(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
    work: repository::dto::EngineWork,
) -> Result<(Vec<repository::responses::Emission>, String)> {
    state.authenticate_owner(&webview, &owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let result = repository::responses::read(&pool, &owner, &work).await?;
    state.authenticate_owner(&webview, &owner)?;
    Ok(result)
}
#[tauri::command]
pub(crate) async fn execution_host_close_responses(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    closure: repository::responses::Closure,
) -> Result<repository::responses::Closure> {
    state.authenticate_owner(&webview, &closure.owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::responses::close(&pool, closure).await
}

#[tauri::command]
pub(crate) async fn execution_host_mark_uncertain(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
    work: repository::dto::EngineWork,
    reason: String,
) -> Result<()> {
    state.authenticate_owner(&webview, &owner)?;
    if reason.len() > 2048 {
        return Err(failure(
            "CORRELATION",
            "reason",
            "Uncertainty reason exceeds its bound",
        ));
    }
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::mark_uncertain(&pool, &owner, &work, &reason).await?;
    state.authenticate_owner(&webview, &owner)?;
    Ok(())
}

async fn reattach_retained(app: &tauri::AppHandle, generation: &str) -> Result<()> {
    let database = app.state::<DbPool>();
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let state = app.state::<HostState>();
    let lease = state.start_lease().await?;
    if lease.generation() != generation {
        return Err(failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "Recovery generation changed",
        ));
    }
    let mut after = String::new();
    loop {
        let candidates = repository::retained_for_resume(&pool, &after).await?;
        if candidates.is_empty() {
            break;
        }
        for (snapshot, capture) in candidates {
            after = snapshot.system_start_id.clone();
            lease.ensure_live()?;
            if lease.owner(&snapshot.system_start_id).is_ok() {
                continue;
            }
            if capture.implementation_digest != "macro-native-host/1" {
                continue;
            }
            let verified = state
                .compile(
                    snapshot.source.clone(),
                    snapshot.authored_source.clone(),
                    capture.registry_json,
                )
                .await?;
            let result: serde_json::Value = serde_json::from_str(&verified.result_json)?;
            let Some(compiled) = result
                .get("compiledPlanJson")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            // Recompile using the original capture. Exact plan equality includes every implementation version.
            if verified.generation != generation
                || !crate::db::exact_json::equal(compiled, &snapshot.compiled_plan_json)?
            {
                continue;
            }
            let _gate = state.admission_gate().await;
            lease.ensure_live()?;
            if lease.owner(&snapshot.system_start_id).is_ok() {
                continue;
            }
            let owner =
                repository::resume(&pool, &snapshot.system_start_id, &snapshot.versions).await?;
            lease.retain_committed_owner(owner)?;
        }
    }
    Ok(())
}

// Manual qualification only. The native slot authorizes one existing delivery;
// an event from another webview cannot manufacture an admission or owner.
#[tauri::command]
pub(crate) fn execution_qa_available(app: tauri::AppHandle) -> bool {
    cfg!(all(debug_assertions, feature = "browser-runtime-debug"))
        && app.config().identifier.starts_with("com.macro.desktop.qa.")
}
#[tauri::command]
pub(crate) async fn execution_qa_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    system_start_id: String,
    delivery_id: String,
) -> Result<()> {
    use tauri::Emitter;
    if !execution_qa_available(app.clone()) {
        return Err(failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "Manual qualification is disabled",
        ));
    }
    let lease = state.start_lease().await?;
    let owner = lease.owner(&system_start_id)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Database unavailable"))?;
    let inspection = repository::inspection::read(&pool, &owner).await?;
    let plan: serde_json::Value = serde_json::from_str(&inspection.snapshot.compiled_plan_json)?;
    let delivery = inspection
        .projection
        .activations
        .iter()
        .find(|activation| activation.delivery.delivery.delivery_id == delivery_id);
    if plan.get("entry") != Some(&serde_json::Value::Null)
        || !delivery.is_some_and(|activation| {
            activation.work_state == "queued"
                && activation
                    .delivery
                    .delivery
                    .work
                    .agent_instance_id
                    .is_some()
        })
    {
        return Err(failure(
            "CORRELATION",
            "delivery",
            "Manual qualification requires a queued graphless Agent delivery",
        ));
    }
    lease.ensure_live()?;
    let mut slot = lease
        .host
        .qa_request
        .lock()
        .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "QA request unavailable"))?;
    if slot.is_some() {
        return Err(failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "A manual qualification request is pending",
        ));
    }
    *slot = Some((system_start_id, delivery_id));
    if app.emit_to(LABEL, "agsdl-qa-wake", ()).is_err() {
        *slot = None;
        return Err(failure("RUNTIME_UNAVAILABLE", "", "Host wake failed"));
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn execution_host_qa_take(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<Option<(EngineOwner, String)>> {
    if !execution_qa_available(app) {
        return Ok(None);
    }
    let host = state.authenticate(&webview)?;
    let request = host
        .qa_request
        .lock()
        .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "QA request unavailable"))?
        .take();
    request
        .map(|(system, delivery)| {
            let owner = host
                .owners
                .lock()
                .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Owner unavailable"))?
                .get(&system)
                .cloned()
                .ok_or_else(|| failure("CORRELATION", "", "QA owner is absent"))?;
            Ok((owner, delivery))
        })
        .transpose()
}
#[tauri::command]
pub(crate) async fn execution_qa_replace_host(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
) -> Result<()> {
    if !execution_qa_available(app.clone()) {
        return Err(failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "Manual qualification is disabled",
        ));
    }
    let lease = state.start_lease().await?;
    retire(&lease.host, database.inner(), &app);
    Ok(())
}
