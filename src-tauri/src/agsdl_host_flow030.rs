//! Native 0.3 flow ownership and durable dispatch. None of these operations is IPC.
//! Callers obtain a native lifecycle lease before the shared admission gate.
use crate::agsdl_host::{HostStartLease, HostState};
use crate::agsdl_host_capture::{self as capture, CompilationCapture};
use crate::config::ConfigManager;
use crate::db::agsdl_execution::{
    self as repository,
    dto::{EngineOwner, EngineStartRequest},
    failure,
    flow030::{
        DeliveryOccurrence030, FlowEffect030, FlowEffectKind030, FlowEvent030, FlowEventKind030,
        FlowIdentity030, FlowState030, PreparedBatch030, Producer030,
    },
    flow_store030::{self, Apply030, Authority030, CheckFuture, FlowView030, StoreError030},
    intents::{ExecutionIntentScope, IntentAdmissionLink},
    start030::{self, RetainedStart030, StartAuthority030, StartCapture030, StartInspection030},
    Result,
};
use crate::workspace::architect::{
    lock_execution_intent_scope, lock_execution_source_owner, LockedExecutionSource,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};
use std::{
    collections::BTreeMap,
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::OwnedMutexGuard;

/// Process-local exclusion for a Start whose COMMIT has not been acknowledged.
/// A missing response never authorizes a second physical effect.
#[derive(Default)]
pub(crate) struct FlowHost030 {
    committing: Mutex<BTreeMap<String, FlowIdentity030>>,
    controls: Mutex<BTreeMap<String, Arc<FlowControl030>>>,
}

fn unavailable() -> repository::dto::EngineFailure {
    failure(
        "RUNTIME_UNAVAILABLE",
        "",
        "Native flow authority is unavailable",
    )
}
fn uncertain() -> repository::dto::EngineFailure {
    failure(
        "UNCERTAIN",
        "",
        "Native commit or handoff must be reconciled without replay",
    )
}
fn refused() -> repository::dto::EngineFailure {
    failure(
        "CORRELATION",
        "",
        "Native flow receipt does not match its capture",
    )
}
fn store_error(error: StoreError030) -> repository::dto::EngineFailure {
    match error {
        StoreError030::Sql(_) => failure("STORAGE", "", "Native flow storage failed"),
        StoreError030::Authority => failure("AUTHORITY", "", "Native flow owner was revoked"),
        StoreError030::Blocked => failure("FLOW_BLOCKED", "", "Flow requires an explicit Stop"),
        StoreError030::NotClaimable => {
            failure("NOT_CLAIMABLE", "", "Native effect is no longer eligible")
        }
        _ => refused(),
    }
}
fn digest<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
impl FlowHost030 {
    fn available(&self, identity: &FlowIdentity030) -> Result<()> {
        let pending = self.committing.lock().map_err(|_| unavailable())?;
        if pending
            .values()
            .any(|id| id.system_start_id == identity.system_start_id)
        {
            return Err(uncertain());
        }
        Ok(())
    }
    fn begin(&self, request: &EngineStartRequest, identity: &FlowIdentity030) -> Result<()> {
        let mut pending = self.committing.lock().map_err(|_| unavailable())?;
        if pending.contains_key(&request.request_id) {
            return Err(uncertain());
        }
        pending.insert(request.request_id.clone(), identity.clone());
        Ok(())
    }
    fn acknowledge(&self, request: &EngineStartRequest, identity: &FlowIdentity030) {
        // Poison is fail-closed: retaining the barrier is safer than admitting work.
        if let Ok(mut pending) = self.committing.lock() {
            if pending.get(&request.request_id) == Some(identity) {
                pending.remove(&request.request_id);
            }
        }
    }
    /// These capabilities were installed by native Start before COMMIT. A
    /// supplied system label cannot create retirement authority.
    pub(crate) fn retiring_controls(&self, generation: &str) -> Result<Vec<Arc<FlowControl030>>> {
        Ok(self
            .controls
            .lock()
            .map_err(|_| unavailable())?
            .values()
            .filter(|c| c.generation == generation)
            .cloned()
            .collect())
    }
}

async fn check_owner(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    identity: &FlowIdentity030,
    creating: Option<&StartCapture030>,
) -> std::result::Result<EngineOwner, StoreError030> {
    lease.ensure_live().map_err(|_| StoreError030::Authority)?;
    let row = sqlx::query("SELECT invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256 FROM engine_flow030_owners WHERE system_id=?")
        .bind(&identity.system_start_id).fetch_optional(&mut *db).await?
        .ok_or(StoreError030::Missing)?;
    if row.get::<String, _>("invocation_id") != identity.flow_invocation_id
        || row.get::<String, _>("snapshot_id") != identity.snapshot_id
        || row.get::<String, _>("capture_epoch") != identity.epoch
        || row.get::<String, _>("generation") != lease.generation()
        || row.get::<String, _>("status") != "live"
    {
        return Err(StoreError030::Authority);
    }
    let owner = EngineOwner {
        system_start_id: identity.system_start_id.clone(),
        owner_epoch: row.get("owner_epoch"),
    };
    let retained: Option<String> = sqlx::query_scalar(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&identity.system_start_id)
    .bind(&identity.flow_invocation_id)
    .fetch_optional(&mut *db)
    .await?;
    let capture: StartCapture030 = match retained {
        Some(raw) => {
            // The final Start check runs after INSERT but before begin_commit
            // retains its owner in memory. Only this exact native capture may
            // bridge that interval. Replays have no matching creating capture.
            let current_start = match creating {
                Some(expected) if expected.identity == *identity && owner.owner_epoch == "0" => {
                    serde_json::to_string(expected)? == raw
                }
                _ => false,
            };
            if !current_start {
                if lease
                    .owner(&identity.system_start_id)
                    .map_err(|_| StoreError030::Authority)?
                    != owner
                {
                    return Err(StoreError030::Authority);
                }
            } else if let Ok(existing) = lease.owner(&identity.system_start_id) {
                if existing != owner {
                    return Err(StoreError030::Authority);
                }
            }
            serde_json::from_str(&raw)?
        }
        None => creating
            .filter(|c| c.identity == *identity)
            .cloned()
            .ok_or(StoreError030::Authority)?,
    };
    if capture.identity != *identity
        || digest(&capture).map_err(|_| StoreError030::Authority)?
            != row.get::<String, _>("capture_sha256")
    {
        return Err(StoreError030::Authority);
    }
    lease.ensure_live().map_err(|_| StoreError030::Authority)?;
    Ok(owner)
}

struct Authority<'a> {
    runtime: &'a FlowHost030,
    lease: &'a HostStartLease,
    owner: EngineOwner,
}

/// Resolve the occurrence against the committed native Prepared event, including
/// its producer and batch position. Equal payloads at different indices stay distinct.
fn check_occurrence(
    state: &FlowState030,
    occurrence: &DeliveryOccurrence030,
    message: &Option<String>,
    item: &Option<String>,
    producer: &Option<Producer030>,
) -> std::result::Result<(), StoreError030> {
    let preparation_id = state
        .preparation_receipts
        .get(&occurrence.native_receipt_id)
        .ok_or(StoreError030::Authority)?;
    let preparation = state
        .preparations
        .iter()
        .find(|p| p.reference.prepare_id == *preparation_id && p.status == "consumed")
        .ok_or(StoreError030::Authority)?;
    if producer.as_ref() != Some(&preparation.producer) {
        return Err(StoreError030::Authority);
    }
    let mut matching = Vec::new();
    for record in state.events.values() {
        let event: Value = serde_json::from_str(&record.event_json)?;
        if let Some(prepared) = event.pointer("/kind/Prepared") {
            if prepared.get("native_receipt_id").and_then(Value::as_str)
                == Some(&occurrence.native_receipt_id)
                && prepared.get("reference") == Some(&serde_json::to_value(&preparation.reference)?)
            {
                matching.push(
                    prepared
                        .get("result")
                        .and_then(|r| r.pointer("/Ready/batches"))
                        .cloned()
                        .ok_or(StoreError030::Authority)?,
                );
            }
        }
    }
    if matching.len() != 1 {
        return Err(StoreError030::Authority);
    }
    let batches: Vec<PreparedBatch030> = serde_json::from_value(matching.remove(0))?;
    let batch = batches
        .get(occurrence.target_ordinal)
        .ok_or(StoreError030::Authority)?;
    let index: usize = occurrence
        .item_index
        .parse()
        .map_err(|_| StoreError030::Authority)?;
    let entry = batch.items.get(index).ok_or(StoreError030::Authority)?;
    if index.to_string() != occurrence.item_index
        || batch.target_ordinal != occurrence.target_ordinal
        || entry.occurrence != *occurrence
        || entry.message_json != *message
        || entry.item_json != *item
    {
        return Err(StoreError030::Authority);
    }
    Ok(())
}

impl Authority030 for Authority<'_> {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            if check_owner(db, self.lease, id, None).await? != self.owner {
                return Err(StoreError030::Authority);
            }
            Ok(())
        })
    }
    fn effect<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            self.owner(db, &effect.identity).await?;
            if !matches!(
                &effect.kind,
                FlowEffectKind030::StopWork { .. } | FlowEffectKind030::RunEnded { .. }
            ) {
                self.runtime
                    .available(&effect.identity)
                    .map_err(|_| StoreError030::Blocked)?;
            }
            let raw: String = sqlx::query_scalar(
                "SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?",
            )
            .bind(&effect.identity.system_start_id)
            .bind(&effect.identity.flow_invocation_id)
            .fetch_one(&mut *db)
            .await?;
            let state: FlowState030 = serde_json::from_str(&raw)?;
            match &effect.kind {
                FlowEffectKind030::Start {
                    work,
                    step,
                    agent,
                    input_json,
                    message_json,
                    item_json,
                    occurrence,
                    sender,
                } => {
                    let activation = state
                        .activations
                        .iter()
                        .find(|a| a.id == work.activation_id)
                        .ok_or(StoreError030::Authority)?;
                    if activation.start_effect_id.as_deref() != Some(&work.start_effect_id)
                        || work.start_effect_id != effect.id
                        || activation.instance_id != work.agent_instance_id
                        || activation.step != *step
                        || activation.agent != *agent
                        || activation.input_json != *input_json
                        || activation.message_json != *message_json
                        || activation.item_json != *item_json
                        || activation.occurrence != *occurrence
                        || activation.producer != *sender
                    {
                        return Err(StoreError030::Authority);
                    }
                    if let Some(occurrence) = occurrence {
                        check_occurrence(&state, occurrence, message_json, item_json, sender)?;
                    }
                }
                FlowEffectKind030::Steer {
                    work,
                    delivery_activation_id,
                    message_json,
                    occurrence,
                    sender,
                } => {
                    let active = state
                        .activations
                        .iter()
                        .find(|a| a.id == work.activation_id)
                        .ok_or(StoreError030::Authority)?;
                    let delivery = state
                        .activations
                        .iter()
                        .find(|a| a.id == *delivery_activation_id)
                        .ok_or(StoreError030::Authority)?;
                    if active.start_effect_id.as_deref() != Some(&work.start_effect_id)
                        || active.instance_id != work.agent_instance_id
                        || active.instance_id != delivery.instance_id
                        || active.agent != delivery.agent
                        || delivery.message_json.as_deref().unwrap_or("{}") != message_json
                        || delivery.occurrence != *occurrence
                        || delivery.producer != *sender
                    {
                        return Err(StoreError030::Authority);
                    }
                    if let Some(occurrence) = occurrence {
                        check_occurrence(
                            &state,
                            occurrence,
                            &delivery.message_json,
                            &delivery.item_json,
                            sender,
                        )?;
                    }
                }
                FlowEffectKind030::PrepareRoute {
                    reference,
                    producer,
                } => {
                    if !state.preparations.iter().any(|p| {
                        p.reference == *reference
                            && p.producer == *producer
                            && p.status == "pending"
                    }) {
                        return Err(StoreError030::Authority);
                    }
                }
                FlowEffectKind030::StopWork { work, .. } => {
                    if !state.activations.iter().any(|a| {
                        a.id == work.activation_id
                            && a.start_effect_id.as_deref() == Some(&work.start_effect_id)
                            && a.instance_id == work.agent_instance_id
                            && a.physical
                    }) {
                        return Err(StoreError030::Authority);
                    }
                }
                _ => {}
            }
            Ok(())
        })
    }
    fn settlement<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
        receipt: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            self.owner(db, &effect.identity).await?;
            let raw: Option<String> = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND generation=?")
                .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).bind(&effect.id)
                .bind(&self.owner.owner_epoch).bind(self.lease.generation()).fetch_optional(db).await?;
            if raw.as_deref() != Some(serde_json::to_string(receipt)?.as_str()) {
                return Err(StoreError030::Authority);
            }
            Ok(())
        })
    }
    fn owner_epoch(&self) -> &str {
        &self.owner.owner_epoch
    }
}

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
        if self
            .runtime
            .committing
            .lock()
            .map_err(|_| unavailable())?
            .contains_key(&request.request_id)
        {
            return Err(uncertain());
        }
        Ok(())
    }
    fn begin_commit(&self, request: &EngineStartRequest, identity: &FlowIdentity030) -> Result<()> {
        self.runtime.begin(request, identity)?;
        // Retirement must know this owner even if the commit reply or caller is lost.
        let owner = EngineOwner {
            system_start_id: identity.system_start_id.clone(),
            owner_epoch: "0".into(),
        };
        self.lease.retain_committed_owner(owner.clone())?;
        self.runtime
            .controls
            .lock()
            .map_err(|_| unavailable())?
            .insert(
                identity.system_start_id.clone(),
                Arc::new(FlowControl030 {
                    owner,
                    identity: identity.clone(),
                    generation: self.lease.generation().into(),
                    admission: self.host.admission_lock(),
                }),
            );
        Ok(())
    }
    fn commit_acknowledged(&self, request: &EngineStartRequest, identity: &FlowIdentity030) {
        self.runtime.acknowledge(request, identity);
    }
    async fn capture(&self, request: &EngineStartRequest) -> Result<StartCapture030> {
        self.lease.ensure_live()?;
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

pub(crate) async fn start_linked(
    runtime: &FlowHost030,
    host: &HostState,
    manager: &ConfigManager,
    pool: &SqlitePool,
    workspace: &Path,
    git: &crate::git::GitState,
    request: &EngineStartRequest,
    link: Option<&IntentAdmissionLink>,
) -> Result<RetainedStart030> {
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
    };
    let result = start030::start_linked(pool, request, &authority, link).await?;
    lease.ensure_live().map_err(|_| uncertain())?;
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
    };
    let result = start030::inspect_linked(pool, request, &authority, link).await?;
    if let StartInspection030::Committed(ref retained) = result {
        runtime.acknowledge(request, &retained.receipt.identity);
    }
    lease.ensure_live()?;
    Ok(result)
}

pub(crate) async fn read(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
) -> Result<FlowView030> {
    let lease = host.start_lease().await?;
    let authority = Authority {
        runtime,
        owner: lease.owner(&id.system_start_id)?,
        lease: &lease,
    };
    let mut db = pool.acquire().await?;
    let mut tx = db.begin().await?;
    let result = flow_store030::read_tx(&mut tx, &authority, id)
        .await
        .map_err(store_error)?;
    tx.commit().await?;
    lease.ensure_live()?;
    Ok(result)
}

/// Private input for 0.3 controllers and executors. The capture and state are
/// read in one SQLite snapshot and never adapted into a historical State020.
pub(crate) struct NativeFlowInspection030 {
    pub owner: EngineOwner,
    pub capture: StartCapture030,
    pub flow: FlowView030,
}

pub(crate) async fn inspect_run(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
) -> Result<NativeFlowInspection030> {
    let lease = host.start_lease().await?;
    if lease.owner(&owner.system_start_id)? != *owner {
        return Err(refused());
    }
    let authority = Authority {
        runtime,
        lease: &lease,
        owner: owner.clone(),
    };
    let mut db = pool.acquire().await?;
    let mut tx = db.begin().await?;
    let raw: String =
        sqlx::query_scalar("SELECT capture_json FROM engine_start030_requests WHERE system_id=?")
            .bind(&owner.system_start_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                failure(
                    "NOT_FOUND",
                    "systemStartId",
                    "Native flow capture is absent",
                )
            })?;
    let capture: StartCapture030 = serde_json::from_str(&raw)?;
    authority
        .owner(&mut tx, &capture.identity)
        .await
        .map_err(store_error)?;
    let flow = flow_store030::read_tx(&mut tx, &authority, &capture.identity)
        .await
        .map_err(store_error)?;
    tx.commit().await?;
    lease.ensure_live()?;
    Ok(NativeFlowInspection030 {
        owner: owner.clone(),
        capture,
        flow,
    })
}

/// Only native controllers, receipt resolvers and supervisors construct events.
/// This is deliberately not a command accepting deserialized model events.
pub(crate) async fn apply_native_event(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    event: &FlowEvent030,
) -> Result<Apply030> {
    let lease = host.start_lease().await?;
    let _admission = host.admission_lock().lock_owned().await;
    if !matches!(
        &event.kind,
        FlowEventKind030::Stop | FlowEventKind030::PhysicalEnded { .. }
    ) {
        runtime.available(&event.identity)?;
    }
    let authority = Authority {
        runtime,
        owner: lease.owner(&event.identity.system_start_id)?,
        lease: &lease,
    };
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let result = flow_store030::apply_tx(&mut tx, &authority, event)
        .await
        .map_err(store_error)?;
    lease.ensure_live()?;
    tx.commit().await.map_err(|_| uncertain())?;
    lease.ensure_live().map_err(|_| uncertain())?;
    Ok(result)
}

/// Not Clone/Deserialize. Dropping it after COMMIT leaves the claim uncertain;
/// it never becomes a fresh pending effect. The gate spans COMMIT to handoff.
pub(crate) struct DispatchLease030<'a> {
    runtime: &'a FlowHost030,
    lease: HostStartLease,
    _admission: OwnedMutexGuard<()>,
    pool: SqlitePool,
    owner: EngineOwner,
    effect: FlowEffect030,
}
impl DispatchLease030<'_> {
    pub(crate) fn effect(&self) -> &FlowEffect030 {
        &self.effect
    }
    pub(crate) fn request_id(&self) -> String {
        format!(
            "flow030:{}:{}",
            self.effect.identity.system_start_id, self.effect.id
        )
    }
    pub(crate) async fn handoff<F>(
        self,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        work: F,
    ) -> Result<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        if !matches!(
            &self.effect.kind,
            FlowEffectKind030::StopWork { .. } | FlowEffectKind030::RunEnded { .. }
        ) {
            self.runtime.available(&self.effect.identity)?;
        }
        let request_id = self.request_id();
        let (release, ready) = tokio::sync::oneshot::channel();
        self.lease
            .admit_owned_stream(&self.owner, tasks, request_id.clone(), async move {
                // The registry owns the future before its first poll. Effect IO
                // waits for an acknowledged commit of the handoff receipt.
                if ready.await.is_ok() {
                    work.await;
                }
            })?;
        let receipt = json!({"kind":"nativeOwnedHandoff030", "identity":self.effect.identity,
            "effectId":self.effect.id, "ownerEpoch":self.owner.owner_epoch,
            "generation":self.lease.generation(), "requestId":request_id});
        let authority = Authority {
            runtime: self.runtime,
            owner: self.owner.clone(),
            lease: &self.lease,
        };
        let mut db = self.pool.acquire().await.map_err(|_| uncertain())?;
        sqlx::query("PRAGMA synchronous=FULL")
            .execute(&mut *db)
            .await
            .map_err(|_| uncertain())?;
        let mut tx = db
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| uncertain())?;
        authority
            .owner(&mut tx, &self.effect.identity)
            .await
            .map_err(|_| uncertain())?;
        sqlx::query("INSERT INTO engine_flow030_handoffs(system_id,invocation_id,effect_id,owner_epoch,generation,receipt_json) VALUES(?,?,?,?,?,?)")
            .bind(&self.effect.identity.system_start_id).bind(&self.effect.identity.flow_invocation_id).bind(&self.effect.id)
            .bind(&self.owner.owner_epoch).bind(self.lease.generation()).bind(receipt.to_string()).execute(&mut *tx).await.map_err(|_| uncertain())?;
        flow_store030::settle_tx(
            &mut tx,
            &authority,
            &self.effect.identity,
            &self.effect.id,
            &receipt,
        )
        .await
        .map_err(|_| uncertain())?;
        tx.commit().await.map_err(|_| uncertain())?;
        self.lease.ensure_live().map_err(|_| uncertain())?;
        release.send(()).map_err(|_| uncertain())?;
        Ok(())
    }
}

pub(crate) async fn claim_next<'a>(
    runtime: &'a FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
) -> Result<Option<DispatchLease030<'a>>> {
    let lease = host.start_lease().await?;
    let admission = host.admission_lock().lock_owned().await;
    let owner = lease.owner(&id.system_start_id)?;
    let authority = Authority {
        runtime,
        lease: &lease,
        owner: owner.clone(),
    };
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    authority.owner(&mut tx, id).await.map_err(store_error)?;
    let effects: Vec<String> = sqlx::query_scalar("SELECT effect_id FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND status='pending' ORDER BY rowid")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *tx).await?;
    for effect_id in effects {
        match flow_store030::claim_tx(&mut tx, &authority, id, &effect_id).await {
            Ok(effect) => {
                lease.ensure_live()?;
                tx.commit().await.map_err(|_| uncertain())?;
                lease.ensure_live().map_err(|_| uncertain())?;
                return Ok(Some(DispatchLease030 {
                    runtime,
                    lease,
                    _admission: admission,
                    pool: pool.clone(),
                    owner,
                    effect,
                }));
            }
            Err(StoreError030::NotClaimable) => continue,
            Err(error) => return Err(store_error(error)),
        }
    }
    tx.commit().await?;
    Ok(None)
}

/// Called by the native retirement supervisor, after synchronous revocation.
/// It fences ordinary operations without making uncertain effects pending again.
pub(crate) async fn revoke_generation(pool: &SqlitePool, generation: &str) -> Result<()> {
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        "UPDATE engine_flow030_owners SET status='revoked' WHERE generation=? AND status='live'",
    )
    .bind(generation)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Native cleanup capability, retained before Start can commit. It has neither
/// Deserialize nor an external constructor and cannot claim a new effect.
pub(crate) struct FlowControl030 {
    owner: EngineOwner,
    identity: FlowIdentity030,
    generation: String,
    admission: Arc<tokio::sync::Mutex<()>>,
}
impl FlowControl030 {
    pub(crate) fn identity(&self) -> &FlowIdentity030 {
        &self.identity
    }

    /// Cleanup is allowed after live=false; re-admission is not. The caller
    /// constructs physical evidence from the native supervisor, never model IPC.
    pub(crate) async fn apply(&self, pool: &SqlitePool, event: &FlowEvent030) -> Result<Apply030> {
        if event.identity != self.identity
            || !matches!(
                &event.kind,
                FlowEventKind030::Stop | FlowEventKind030::PhysicalEnded { .. }
            )
        {
            return Err(refused());
        }
        let _admission = self.admission.clone().lock_owned().await;
        let mut db = pool.acquire().await?;
        sqlx::query("PRAGMA synchronous=FULL")
            .execute(&mut *db)
            .await?;
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        let result = flow_store030::apply_tx(&mut tx, self, event)
            .await
            .map_err(store_error)?;
        tx.commit().await.map_err(|_| uncertain())?;
        Ok(result)
    }

    pub(crate) async fn read(&self, pool: &SqlitePool) -> Result<FlowView030> {
        let mut db = pool.acquire().await?;
        let mut tx = db.begin().await?;
        let view = flow_store030::read_tx(&mut tx, self, &self.identity)
            .await
            .map_err(store_error)?;
        tx.commit().await?;
        Ok(view)
    }
}
impl Authority030 for FlowControl030 {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        identity: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            if *identity != self.identity {
                return Err(StoreError030::Authority);
            }
            let row = sqlx::query("SELECT invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status FROM engine_flow030_owners WHERE system_id=?")
                .bind(&identity.system_start_id).fetch_optional(db).await?.ok_or(StoreError030::Missing)?;
            if row.get::<String, _>("invocation_id") != identity.flow_invocation_id
                || row.get::<String, _>("snapshot_id") != identity.snapshot_id
                || row.get::<String, _>("capture_epoch") != identity.epoch
                || row.get::<String, _>("owner_epoch") != self.owner.owner_epoch
                || row.get::<String, _>("generation") != self.generation
                || !matches!(row.get::<&str, _>("status"), "live" | "revoked")
            {
                return Err(StoreError030::Authority);
            }
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
        &self.owner.owner_epoch
    }
}
