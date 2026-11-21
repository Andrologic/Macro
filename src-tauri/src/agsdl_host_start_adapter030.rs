//! Macro capture and intent adapters for the native Start transaction.
use crate::agsdl_host::HostState;
use crate::agsdl_host_capture::{self as capture, CompilationCapture};
use crate::config::ConfigManager;
use crate::db::agsdl_execution::{
    dto::EngineStartRequest,
    failure,
    flow030::{FlowEffect030, FlowIdentity030},
    flow_store030::{Authority030, CheckFuture, StoreError030},
    intents::{ExecutionIntentScope, IntentAdmissionLink},
    start030::{self, RetainedStart030, StartAuthority030, StartCapture030, StartInspection030},
    Result,
};
use crate::workspace::architect::{
    lock_execution_intent_scope, lock_execution_source_owner, LockedExecutionSource,
};
use argentic_runtime::api::StartSession;
use serde_json::{json, Value};
use sqlx::{SqliteConnection, SqlitePool};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tokio::sync::OwnedMutexGuard;
struct StartGuard {
    _source: LockedExecutionSource,
    _policy: crate::config::ExecutionToolsLease,
    _admission: OwnedMutexGuard<()>,
}
struct Start<'a> {
    host: &'a HostState,
    session: &'a StartSession<'a>,
    manager: &'a ConfigManager,
    pool: &'a SqlitePool,
    workspace: &'a Path,
    git: &'a crate::git::GitState,
    intent_scope: Option<&'a ExecutionIntentScope>,
    captured: Mutex<Option<(Arc<CompilationCapture>, StartCapture030)>>,
    reserve_supervisor: bool,
}
impl Start<'_> {
    async fn source(&self, request: &EngineStartRequest) -> Result<LockedExecutionSource> {
        let metadata = capture::metadata_root(self.workspace)?;
        match self.intent_scope {
            Some(scope) => {
                lock_execution_intent_scope(self.workspace, &metadata, scope, Some(&request.source))
                    .await
            }
            None => {
                lock_execution_source_owner(
                    self.workspace,
                    &metadata,
                    &request.source.owner,
                    Some(&request.source),
                )
                .await
            }
        }
    }
}
impl Authority030 for Start<'_> {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            let creating = self
                .captured
                .lock()
                .map_err(|_| StoreError030::Authority)?
                .as_ref()
                .map(|(_, c)| c.clone());
            self.session
                .check_owner_tx(db, id, creating.as_ref())
                .await?;
            Ok(())
        })
    }
    fn effect<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn settlement<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
        _receipt: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn owner_epoch(&self) -> &str {
        "0"
    }
}
impl StartAuthority030 for Start<'_> {
    type SourceGuard = StartGuard;
    fn require_clear(&self, request: &EngineStartRequest) -> Result<()> {
        self.session.ensure_live()?;
        self.session.require_clear(request)
    }
    fn begin_commit(&self, request: &EngineStartRequest, identity: &FlowIdentity030) -> Result<()> {
        self.session
            .begin_commit(request, identity, self.reserve_supervisor)
    }
    fn commit_acknowledged(&self, request: &EngineStartRequest, identity: &FlowIdentity030) {
        self.session.commit_acknowledged(request, identity);
    }
    async fn capture(&self, request: &EngineStartRequest) -> Result<StartCapture030> {
        self.session.ensure_live()?;
        let source = self.source(request).await?;
        if let Some(diagnostic) = capture::product_slice030(&source.source, None) {
            return Err(failure(
                &diagnostic.code,
                &diagnostic.pointer,
                &diagnostic.message,
            ));
        }
        drop(source);
        let compiled = Arc::new(
            capture::compile_input(
                self.host,
                self.manager,
                self.pool,
                self.workspace,
                &capture::ExecutionPreflightRequest {
                    owner: request.source.owner.clone(),
                    expected: Some(request.source.clone()),
                },
                Some(request.entry.as_ref()),
                request
                    .associations
                    .task_id
                    .as_deref()
                    .map(|id| (id, self.git)),
            )
            .await?,
        );
        let preflight = compiled.public();
        if !preflight.runtime_supported {
            if let Some(diagnostic) = preflight.diagnostics.first() {
                return Err(failure(
                    &diagnostic.code,
                    &diagnostic.pointer,
                    &diagnostic.message,
                ));
            }
        }
        let source = self.source(request).await?;
        let material = compiled.start_material030(&source, request, self.session.generation())?;
        let capture = StartCapture030 {
            identity: FlowIdentity030 { system_start_id: uuid::Uuid::new_v4().to_string(), flow_invocation_id: uuid::Uuid::new_v4().to_string(), snapshot_id: uuid::Uuid::new_v4().to_string(), epoch: uuid::Uuid::new_v4().to_string() },
            source: material.source, versions: material.versions, authored_source: material.authored_source,
            compiled_plan_json: material.compiled_plan_json, registry_json: material.registry_json,
            private_capture_json: json!({"format":"macro-native-flow-capture/030", "generation":material.generation,
                "nativeCatalogueJson":material.native_catalogue_json, "callPermissionsJson":material.call_permissions_json,
                "callScopeJson":material.call_scope_json, "displayCardsJson":material.display_cards_json,
                "associations":request.associations, "entryUnassessed":material.entry_unassessed}).to_string(),
        };
        self.session.ensure_live()?;
        *self.captured.lock().map_err(|_| unavailable())? = Some((compiled, capture.clone()));
        Ok(capture)
    }
    async fn lock_source(&self, request: &EngineStartRequest) -> Result<StartGuard> {
        self.require_clear(request)?;
        let source = self.source(request).await?;
        let (compiled, _) = self
            .captured
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(refused)?;
        compiled.start_material030(&source, request, self.session.generation())?;
        let mut catalogue = crate::agsdl_host_catalogue::capture(self.manager, self.pool).await?;
        let policy = self
            .manager
            .lock_execution_tools(&source.revision.owner.project_id)
            .await
            .map_err(|_| unavailable())?;
        let (current, codex, claude) = capture::observation(
            self.manager,
            self.workspace,
            &source,
            &catalogue,
            &policy.tools,
            &policy.agsdl_host_permissions,
            request
                .associations
                .task_id
                .as_deref()
                .map(|id| (id, self.git)),
        )
        .await?;
        catalogue.codex_account_digest = codex;
        catalogue.claude_account_digest = claude;
        if serde_json::to_string(&catalogue)? != serde_json::to_string(&compiled.native_catalogue)?
            || current.get("version")
                != compiled
                    .native_registry_json
                    .parse::<Value>()?
                    .get("version")
        {
            return Err(failure(
                "CAPTURE_CHANGED",
                "source",
                "Native capture changed before commit",
            ));
        }
        // Existing provider admissions also lock metadata before admission.
        // Never invert those locks, nor acquire a nested config read lease.
        let admission = self.session.lock_admission().await;
        self.require_clear(request)?;
        self.session.ensure_live()?;
        Ok(StartGuard {
            _source: source,
            _policy: policy,
            _admission: admission,
        })
    }
    async fn bind_capture_tx(
        &self,
        db: &mut SqliteConnection,
        _request: &EngineStartRequest,
        capture: &StartCapture030,
    ) -> Result<()> {
        self.session.ensure_live()?;
        let expected = self
            .captured
            .lock()
            .map_err(|_| unavailable())?
            .as_ref()
            .map(|(_, c)| serde_json::to_string(c))
            .transpose()?
            .ok_or_else(refused)?;
        if expected != serde_json::to_string(capture)? {
            return Err(refused());
        }
        self.session.bind_capture_tx(db, capture).await?;
        Ok(())
    }
}

pub(crate) async fn start_linked<R: tauri::Runtime>(
    app: Option<&tauri::AppHandle<R>>,
    host: &HostState,
    manager: &ConfigManager,
    pool: &SqlitePool,
    workspace: &Path,
    git: &crate::git::GitState,
    request: &EngineStartRequest,
    link: Option<&IntentAdmissionLink>,
) -> Result<RetainedStart030> {
    let session = host.begin_start().await?;
    let authority = Start {
        host,
        session: &session,
        manager,
        pool,
        workspace,
        git,
        intent_scope: link.map(|l| &l.key.scope),
        captured: Mutex::new(None),
        reserve_supervisor: app.is_some(),
    };
    let result = match start030::start_linked(pool, request, &authority, link).await {
        Ok(result) => result,
        Err(error) => {
            let system = authority.captured.lock().ok().and_then(|captured| {
                captured
                    .as_ref()
                    .map(|(_, capture)| capture.identity.system_start_id.clone())
            });
            if let Some(system) = system {
                let interruption = if app.is_some() {
                    session.interrupt_run(pool, &system).await
                } else {
                    Ok(())
                };
                session.fail_reservation(&system, error.clone());
                interruption?;
            }
            return Err(error);
        }
    };
    if session.ensure_live().is_err() {
        session.fail_reservation(&result.receipt.identity.system_start_id, uncertain());
        return Err(uncertain());
    }
    let created_here = authority
        .captured
        .lock()
        .map_err(|_| unavailable())?
        .as_ref()
        .is_some_and(|(_, capture)| capture.identity == result.receipt.identity);
    if created_here {
        if let Some(app) = app {
            let attachment = async {
                let ai = app
                    .try_state::<crate::ai::AiState>()
                    .ok_or_else(unavailable)?;
                let expected_capture = authority
                    .captured
                    .lock()
                    .map_err(|_| unavailable())?
                    .as_ref()
                    .ok_or_else(unavailable)?
                    .1
                    .clone();
                session
                    .attach_committed_start(
                        pool,
                        manager.engine_context(),
                        ai.stream_tasks.clone(),
                        &result.receipt.identity,
                        &expected_capture,
                        Arc::new(
                            crate::agsdl_host_action_approval030::CurrentActionPolicy030 {
                                app: app.clone(),
                                config: manager.clone(),
                            },
                        ),
                    )
                    .await
            }
            .await;
            if let Err(error) = attachment {
                let interruption = session
                    .interrupt_run(pool, &result.receipt.identity.system_start_id)
                    .await;
                session.fail_reservation(&result.receipt.identity.system_start_id, error.clone());
                interruption?;
                return Err(error);
            }
        }
    }
    Ok(result)
}

/// A committed result resolves a lost reply. Absence does not release a barrier.
pub(crate) async fn inspect_start_linked(
    host: &HostState,
    manager: &ConfigManager,
    pool: &SqlitePool,
    workspace: &Path,
    git: &crate::git::GitState,
    request: &EngineStartRequest,
    link: Option<&IntentAdmissionLink>,
) -> Result<StartInspection030> {
    let session = host.inspect_start_session().await?;
    let authority = Start {
        host,
        session: &session,
        manager,
        pool,
        workspace,
        git,
        intent_scope: link.map(|l| &l.key.scope),
        captured: Mutex::new(None),
        reserve_supervisor: false,
    };
    let result = start030::inspect_linked(pool, request, &authority, link).await?;
    if let StartInspection030::Committed(ref retained) = result {
        session.commit_acknowledged(request, &retained.receipt.identity);
    }
    session.ensure_live()?;
    Ok(result)
}

fn unavailable() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "RUNTIME_UNAVAILABLE",
        "",
        "Native flow authority is unavailable",
    )
}
fn uncertain() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "UNCERTAIN",
        "",
        "Native commit or handoff must be reconciled without replay",
    )
}
fn refused() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "CORRELATION",
        "",
        "Native flow receipt does not match its capture",
    )
}
