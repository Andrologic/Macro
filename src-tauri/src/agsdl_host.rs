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
    live: AtomicBool,
    ready: AtomicBool,
    loads: AtomicUsize,
    owners: Mutex<BTreeMap<String, EngineOwner>>,
}
struct HostResource(Arc<Incarnation>);
impl tauri::Resource for HostResource {}
struct OwnedHost {
    incarnation: Arc<Incarnation>,
    resource: ResourceId,
}
#[derive(Default)]
pub(crate) struct HostState(Mutex<Option<OwnedHost>>);

impl HostState {
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

fn retire(host: &Arc<Incarnation>, database: &DbPool) {
    if !host.live.swap(false, Ordering::SeqCst) {
        return;
    }
    host.ready.store(false, Ordering::SeqCst);
    host.compiler.close();
    // The same lock fences attach_owner. Any completed attachment is included;
    // attachments reaching the lock later observe live=false and cannot succeed.
    let owners = host
        .owners
        .lock()
        .expect("host ownership")
        .values()
        .cloned()
        .collect::<Vec<_>>();
    if owners.is_empty() {
        return;
    }
    let database = database.clone();
    tauri::async_runtime::spawn(async move {
        // Authority is already revoked in memory. Retain the retirement until the
        // native journal acknowledges it; shutdown recovery handles process loss.
        loop {
            if let Ok(pool) = database.wait_until_ready().await {
                if repository::revoke_host_owners(&pool, &owners).await.is_ok() {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

pub(crate) fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let incarnation = Arc::new(Incarnation {
        generation: uuid::Uuid::new_v4().to_string(),
        compiler: Default::default(),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(false),
        loads: AtomicUsize::new(0),
        owners: Mutex::new(BTreeMap::new()),
    });
    let navigation_database = app.state::<DbPool>().inner().clone();
    let load_database = navigation_database.clone();
    let destroy_database = navigation_database.clone();
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
                retire(&navigation, &navigation_database);
            }
            allowed && navigation.live.load(Ordering::SeqCst)
        })
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
                && load.loads.fetch_add(1, Ordering::SeqCst) > 0
            {
                retire(&load, &load_database);
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
            retire(&incarnation, &destroy_database);
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn execution_host_ready(
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<String> {
    let host = state.authenticate(&webview)?;
    host.ready.store(true, Ordering::SeqCst);
    Ok(host.generation.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_resource_cannot_be_replaced_by_a_matching_generation_string() {
        let first = Arc::new(Incarnation {
            generation: "same".into(),
            compiler: Default::default(),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            loads: AtomicUsize::new(0),
            owners: Mutex::new(BTreeMap::new()),
        });
        let forged = Arc::new(Incarnation {
            generation: "same".into(),
            compiler: Default::default(),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            loads: AtomicUsize::new(0),
            owners: Mutex::new(BTreeMap::new()),
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
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
) -> Result<()> {
    let host = state.authenticate(&webview)?;
    retire(&host, database.inner());
    Ok(())
}
