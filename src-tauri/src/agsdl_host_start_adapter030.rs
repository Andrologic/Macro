//! Macro capture and intent adapters for the native Start transaction.
use crate::agsdl_host::{HostStartLease, HostState};
use crate::agsdl_host_capture::{self as capture, CompilationCapture};
use crate::agsdl_host_dispatch030::JoinedOwnedAgent030;
use crate::agsdl_host_route_attestations030::{AttestedRouteSource030, RouteSourceCommitMarker030};
use crate::agsdl_host_work_admission030::{self as work_admission, AttestedWorkPolicy030};
use crate::config::ConfigManager;
use crate::db::agsdl_execution::{
    self as repository,
    dto::{EngineOwner, EngineStartRequest, EngineStopRequest},
    failure,
    flow030::{
        DeliveryOccurrence030, Failure030, FlowEffect030, FlowEffectKind030, FlowEvent030,
        FlowEventKind030, FlowIdentity030, FlowReceipt030, FlowState030, PhysicalEvidence030,
        PrepareRef030, PreparedBatch030, PreparedResult030, Producer030, WorkRef030,
    },
    flow_store030::{self, Apply030, Authority030, CheckFuture, FlowView030, StoreError030},
    flow_work_protocol030::AcceptedWorkTerminal030,
    intents::{ExecutionIntentScope, IntentAdmissionLink},
    start030::{self, RetainedStart030, StartAuthority030, StartCapture030, StartInspection030},
    Result,
};
use crate::workspace::architect::{
    lock_execution_intent_scope, lock_execution_source_owner, LockedExecutionSource,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};
use std::{
    collections::BTreeMap,
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tokio::sync::OwnedMutexGuard;

use crate::agsdl_host_flow030::*;
struct StartGuard {
    _source: LockedExecutionSource,
    _policy: crate::config::ExecutionToolsLease,
    _admission: OwnedMutexGuard<()>,
}
struct Start<'a> {
    runtime: &'a FlowHost030,
    host: &'a HostState,
    lease: &'a HostStartLease,
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
            check_owner(db, self.lease, id, creating.as_ref()).await?;
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
        self.lease.ensure_live()?;
        self.runtime.require_start_clear(request)
    }
    fn begin_commit(&self, request: &EngineStartRequest, identity: &FlowIdentity030) -> Result<()> {
        self.runtime.retain_start_before_commit(
            self.host,
            self.lease,
            request,
            identity,
            self.reserve_supervisor,
        )
    }
    fn commit_acknowledged(&self, request: &EngineStartRequest, identity: &FlowIdentity030) {
        self.runtime.acknowledge(request, identity);
    }
    async fn capture(&self, request: &EngineStartRequest) -> Result<StartCapture030> {
        self.lease.ensure_live()?;
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
        let material = compiled.start_material030(&source, request, self.lease.generation())?;
        let capture = StartCapture030 {
            identity: FlowIdentity030 { system_start_id: uuid::Uuid::new_v4().to_string(), flow_invocation_id: uuid::Uuid::new_v4().to_string(), snapshot_id: uuid::Uuid::new_v4().to_string(), epoch: uuid::Uuid::new_v4().to_string() },
            source: material.source, versions: material.versions, authored_source: material.authored_source,
            compiled_plan_json: material.compiled_plan_json, registry_json: material.registry_json,
            private_capture_json: json!({"format":"macro-native-flow-capture/030", "generation":material.generation,
                "nativeCatalogueJson":material.native_catalogue_json, "callPermissionsJson":material.call_permissions_json,
                "callScopeJson":material.call_scope_json, "displayCardsJson":material.display_cards_json,
                "associations":request.associations, "entryUnassessed":material.entry_unassessed}).to_string(),
        };
        self.lease.ensure_live()?;
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
        compiled.start_material030(&source, request, self.lease.generation())?;
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
        let admission = self.host.admission_lock().lock_owned().await;
        self.require_clear(request)?;
        self.lease.ensure_live()?;
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
        self.lease.ensure_live()?;
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
        sqlx::query("INSERT INTO engine_flow030_owners(system_id,invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256) VALUES(?,?,?,?,'0',?,'live',?)")
            .bind(&capture.identity.system_start_id).bind(&capture.identity.flow_invocation_id).bind(&capture.identity.snapshot_id).bind(&capture.identity.epoch)
            .bind(self.lease.generation()).bind(digest(capture)?).execute(db).await?;
        Ok(())
    }
}

pub(crate) async fn start_linked<R: tauri::Runtime>(
    app: Option<&tauri::AppHandle<R>>,
    runtime: &FlowHost030,
    host: &HostState,
    manager: &ConfigManager,
    pool: &SqlitePool,
    workspace: &Path,
    git: &crate::git::GitState,
    request: &EngineStartRequest,
    link: Option<&IntentAdmissionLink>,
) -> Result<RetainedStart030> {
    let _start = runtime.start_admission.read().await;
    let lease = host.start_lease().await?;
    if runtime
        .shutdown_started
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err(failure(
            "SHUTDOWN_PENDING",
            "",
            "Application shutdown has begun",
        ));
    }
    let authority = Start {
        runtime,
        host,
        lease: &lease,
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
                    interrupt_run030(pool, &system).await
                } else {
                    Ok(())
                };
                runtime.supervisors.fail_reservation(&system, error.clone());
                interruption?;
            }
            return Err(error);
        }
    };
    if lease.ensure_live().is_err() {
        runtime
            .supervisors
            .fail_reservation(&result.receipt.identity.system_start_id, uncertain());
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
            let attachment = (|| {
                let ai = app
                    .try_state::<crate::ai::AiState>()
                    .ok_or_else(unavailable)?;
                let config = manager.clone();
                let agents: Arc<dyn crate::agsdl_host_runtime030::AgentExecutor030> = Arc::new(
                    crate::agsdl_host_codex030::CodexExecutor030::new(config.clone())
                        .with_approvals(Arc::new(
                            crate::agsdl_host_action_approval030::AgentActionHumans030 {
                                app: app.clone(),
                                pool: pool.clone(),
                                config: config.clone(),
                            },
                        )),
                );
                #[cfg(test)]
                let agents = app
                    .try_state::<crate::agsdl_host_runtime030::TestAgentExecutor030>()
                    .map_or(agents, |executor| executor.0.clone());
                let plan: repository::flow030::FlowPlan030 = serde_json::from_str(
                    &authority
                        .captured
                        .lock()
                        .map_err(|_| unavailable())?
                        .as_ref()
                        .ok_or_else(unavailable)?
                        .1
                        .compiled_plan_json,
                )?;
                let document: Value = serde_json::from_str(&plan.document_json)?;
                let needs_clock = plan.steps.iter().any(|step| {
                    step.r#type == "approval"
                        || step.r#type == "call"
                        || step.timeout_ms_json.is_some()
                }) || document["agents"].as_object().is_some_and(|agents| {
                    agents
                        .values()
                        .any(|agent| agent.get("answerTimeoutMs").is_some())
                });
                let executors = crate::agsdl_host_runtime030::Executors030 {
                    agents,
                    calls: Some(Arc::new(
                        crate::agsdl_host_call_executor030::CallExecutor030 {
                            config: config.engine_context(),
                            pool: pool.clone(),
                            tasks: ai.stream_tasks.clone(),
                            transport: Arc::new(
                                crate::agsdl_host_call_executor030::NativeCallTransport030 {
                                    humans: Some(Arc::new(
                                        crate::agsdl_host_human_executor030::CallHumans030 {
                                            app: (*host).clone(),
                                            pool: pool.clone(),
                                            identity: result.receipt.identity.clone(),
                                        },
                                    )),
                                },
                            ),
                            owner: EngineOwner {
                                system_start_id: result.receipt.identity.system_start_id.clone(),
                                owner_epoch: "0".into(),
                            },
                        },
                    )),
                    humans: Some(Arc::new(
                        crate::agsdl_host_human_executor030::HumanExecutor030 {
                            pool: pool.clone(),
                            tasks: ai.stream_tasks.clone(),
                        },
                    )),
                    clock: needs_clock.then(|| {
                        Arc::new(crate::agsdl_host_human_executor030::HumanClockRuntime030 {
                            app: (*host).clone(),
                            pool: pool.clone(),
                            tasks: ai.stream_tasks.clone(),
                            identity: result.receipt.identity.clone(),
                        })
                            as Arc<dyn crate::agsdl_host_runtime030::RuntimeClock030>
                    }),
                };
                crate::agsdl_host_runtime030::spawn_supervisor030(
                    (*host).clone(),
                    pool.clone(),
                    config.engine_context(),
                    ai.stream_tasks.clone(),
                    EngineOwner {
                        system_start_id: result.receipt.identity.system_start_id.clone(),
                        owner_epoch: "0".into(),
                    },
                    executors,
                )
            })();
            if let Err(error) = attachment {
                let interruption =
                    interrupt_run030(pool, &result.receipt.identity.system_start_id).await;
                runtime
                    .supervisors
                    .fail_reservation(&result.receipt.identity.system_start_id, error.clone());
                interruption?;
                return Err(error);
            }
        }
    }
    Ok(result)
}

/// A committed result resolves a lost reply. Absence does not release a barrier.
pub(crate) async fn inspect_start_linked(
    runtime: &FlowHost030,
    host: &HostState,
    manager: &ConfigManager,
    pool: &SqlitePool,
    workspace: &Path,
    git: &crate::git::GitState,
    request: &EngineStartRequest,
    link: Option<&IntentAdmissionLink>,
) -> Result<StartInspection030> {
    let lease = host.start_lease().await?;
    let authority = Start {
        runtime,
        host,
        lease: &lease,
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
        runtime.acknowledge(request, &retained.receipt.identity);
    }
    lease.ensure_live()?;
    Ok(result)
}
