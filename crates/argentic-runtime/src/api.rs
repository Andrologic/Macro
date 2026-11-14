//! Host operations over one engine. Ownership, leases and registries stay private.
use crate::{
    agsdl_host::{HostStartLease, HostState},
    agsdl_host_flow030 as flow,
    host::HostContext,
    persistence::{
        self, dto::*, failure, flow030::FlowIdentity030, start030::StartCapture030, Result,
    },
};
use serde_json::Value;
use sqlx::{SqliteConnection, SqlitePool};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub use crate::agsdl_host_codex::CodexStatus;
pub use crate::agsdl_host_flow030::{DeliveryReceipt030, DeliveryRequest030};
pub use crate::agsdl_host_human030::HumanAnswer030;
pub use crate::agsdl_host_projection030::{
    RuntimeProjectionContinuation030, RuntimeProjectionItem030, RuntimeProjectionPage030,
    RuntimeProjectionQuery030, RuntimeProjectionScope030,
};
pub use crate::tasks::StreamTasks;

pub struct Compilation {
    pub generation: String,
    pub result_json: String,
}
/// Holds the original native lifecycle lease and, for Start, admission guard.
/// Its constructor cannot install or adopt an existing run.
pub struct StartSession<'a> {
    engine: &'a HostState,
    lease: HostStartLease,
    _start: Option<tokio::sync::RwLockReadGuard<'a, ()>>,
}
impl HostState {
    pub async fn begin_start(&self) -> Result<StartSession<'_>> {
        let gate = self.flow030().start_admission_guard().await;
        let lease = self.start_lease().await?;
        self.flow030().ensure_accepting_starts()?;
        Ok(StartSession {
            engine: self,
            lease,
            _start: Some(gate),
        })
    }
    pub async fn inspect_start_session(&self) -> Result<StartSession<'_>> {
        Ok(StartSession {
            engine: self,
            lease: self.start_lease().await?,
            _start: None,
        })
    }
    pub async fn compile_document(
        &self,
        source: EngineSourceRevision,
        authored: String,
        registry: String,
    ) -> Result<Compilation> {
        let result = self.compile(source, authored, registry).await?;
        Ok(Compilation {
            generation: result.generation,
            result_json: result.result_json,
        })
    }
    pub async fn request_stop(
        &self,
        pool: &SqlitePool,
        tasks: &StreamTasks,
        request: &EngineStopRequest,
    ) -> Result<persistence::public::PublicStopState> {
        let result =
            crate::agsdl_host_stop030::request(self.flow030(), pool, tasks, request).await?;
        self.flow030()
            .supervisors
            .wait(&request.system_start_id)
            .await?;
        Ok(result)
    }
    pub async fn ensure_stop(
        &self,
        pool: &SqlitePool,
        tasks: &StreamTasks,
        system: &str,
    ) -> Result<persistence::public::PublicStopState> {
        let result = crate::agsdl_host_stop030::ensure(self.flow030(), pool, tasks, system).await?;
        self.flow030().supervisors.wake(system);
        self.flow030().supervisors.wait(system).await?;
        Ok(result)
    }
    pub async fn runtime_projection(
        &self,
        pool: &SqlitePool,
        query: RuntimeProjectionQuery030,
        continuation: Option<RuntimeProjectionContinuation030>,
    ) -> Result<RuntimeProjectionPage030> {
        crate::agsdl_host_projection030::read(self, pool, query, continuation).await
    }
    pub async fn deliver_message(
        &self,
        pool: &SqlitePool,
        request: DeliveryRequest030,
    ) -> Result<DeliveryReceipt030> {
        flow::deliver030(self, pool, request).await
    }
    pub async fn human_page(
        &self,
        pool: &SqlitePool,
        scope: persistence::public030::HumanScope030,
        continuation: Option<persistence::public030::HumanContinuation030>,
    ) -> Result<persistence::public030::HumanPage030> {
        crate::agsdl_host_human_projection030::read(pool, scope, continuation).await
    }
    pub async fn submit_person(&self, pool: &SqlitePool, input: HumanSubmission) -> Result<String> {
        let owner = {
            let lease = self.start_lease().await?;
            lease.owner(&input.scope.system_start_id)?
        };
        let inspection = flow::inspect_run(self.flow030(), self, pool, &owner).await?;
        let broker = self
            .flow030()
            .humans
            .broker(self, pool, &inspection.capture.identity)
            .await?;
        let _operation = broker.operation.lock().await;
        let receipt = broker
            .submit(
                self,
                crate::agsdl_host_human030::HumanSubmission030 {
                    scope: input.scope,
                    request_id: input.request_id,
                    expected_revision: input.expected_revision,
                    answer: input.answer,
                },
                crate::agsdl_host_human030::HumanOrigin030::Person,
            )
            .await?;
        broker.pump(self, &CancellationToken::new()).await?;
        self.flow030().supervisors.wake(&owner.system_start_id);
        Ok(receipt)
    }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanSubmission {
    pub scope: persistence::public030::HumanScope030,
    pub request_id: String,
    pub expected_revision: String,
    pub answer: HumanAnswer030,
}
impl StartSession<'_> {
    pub fn generation(&self) -> &str {
        self.lease.generation()
    }
    pub fn ensure_live(&self) -> Result<()> {
        self.lease.ensure_live()
    }
    pub fn require_clear(&self, request: &EngineStartRequest) -> Result<()> {
        self.lease.ensure_live()?;
        self.engine.flow030().require_start_clear(request)
    }
    pub async fn lock_admission(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.engine.admission_lock().lock_owned().await
    }
    pub fn begin_commit(
        &self,
        request: &EngineStartRequest,
        identity: &FlowIdentity030,
        reserve_supervisor: bool,
    ) -> Result<()> {
        self.engine.flow030().retain_start_before_commit(
            self.engine,
            &self.lease,
            request,
            identity,
            reserve_supervisor,
        )
    }
    pub fn commit_acknowledged(&self, request: &EngineStartRequest, identity: &FlowIdentity030) {
        self.engine.flow030().acknowledge(request, identity)
    }
    pub async fn check_owner_tx(
        &self,
        db: &mut SqliteConnection,
        id: &FlowIdentity030,
        creating: Option<&StartCapture030>,
    ) -> std::result::Result<(), persistence::flow_store030::StoreError030> {
        flow::check_owner(db, &self.lease, id, creating)
            .await
            .map(|_| ())
    }
    pub async fn bind_capture_tx(
        &self,
        db: &mut SqliteConnection,
        capture: &StartCapture030,
    ) -> Result<()> {
        self.lease.ensure_live()?;
        sqlx::query("INSERT INTO engine_flow030_owners(system_id,invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256) VALUES(?,?,?,?,'0',?,'live',?)")
            .bind(&capture.identity.system_start_id).bind(&capture.identity.flow_invocation_id).bind(&capture.identity.snapshot_id).bind(&capture.identity.epoch)
            .bind(self.lease.generation()).bind(flow::digest(capture)?).execute(db).await?;
        Ok(())
    }
    pub fn fail_reservation(&self, system: &str, error: EngineFailure) {
        self.engine.flow030().fail_start_reservation(system, error)
    }
    pub async fn interrupt_run(&self, pool: &SqlitePool, system: &str) -> Result<()> {
        flow::interrupt_run030(pool, system).await
    }
}
/// Startup fencing retains Macro's existing interruption semantics.
pub async fn interrupt_previous_runs(pool: &SqlitePool) -> Result<()> {
    flow::interrupt_previous_runs030(pool).await
}

pub const CODEX_ADAPTER: &str = crate::agsdl_host_codex::ADAPTER;
#[derive(Clone)]
pub struct ObservedProfile {
    pub digest: String,
    identity: String,
}
impl ObservedProfile {
    pub fn identity(&self) -> String {
        self.identity.clone()
    }
}
#[derive(Clone)]
pub struct CodexObservation {
    pub profile: ObservedProfile,
    pub version: String,
    pub models: Vec<Value>,
    pub account_digest: String,
}
impl From<crate::agsdl_host_codex::CodexObservation030> for CodexObservation {
    fn from(value: crate::agsdl_host_codex::CodexObservation030) -> Self {
        Self {
            profile: ObservedProfile {
                identity: value.profile.identity(),
                digest: value.profile.digest,
            },
            version: value.version,
            models: value.models,
            account_digest: value.account_digest,
        }
    }
}
pub async fn codex_status(context: &HostContext) -> CodexStatus {
    crate::agsdl_host_codex::profile_status(context).await
}
pub async fn observe_codex(
    context: &HostContext,
    scope: &Value,
    read_only: bool,
) -> Result<Option<CodexObservation>> {
    Ok(
        crate::agsdl_host_codex::observe_catalogue030(context, scope, read_only)
            .await?
            .map(Into::into),
    )
}
pub fn qualified_codex_version(version: &str) -> bool {
    crate::agsdl_host_codex::qualified_version030(version)
}
pub fn codex_module() -> String {
    crate::agsdl_host_codex030::approvals::module030()
}
pub fn validate_codex_document(document: &Value) -> Result<()> {
    crate::agsdl_host_work_admission030::validate_codex_document030(document)
}
pub fn validate_codex_permissions(value: &Value, pointer: &str) -> Result<()> {
    crate::agsdl_host_work_admission030::codex_permissions030(value, pointer)
}
pub fn codex_read_only(policy: &crate::permissions::EffectivePolicy) -> Result<bool> {
    crate::agsdl_host_work_admission030::codex_read_only030(policy)
}
pub fn qualify_skill_folders(document: &Value, root: &std::path::Path) -> Result<()> {
    crate::agsdl_host_codex030::content::qualify_skill_folders(document, root)
}
pub fn declared_steps(document: &Value) -> impl Iterator<Item = (String, &Value)> {
    crate::agsdl_host_qualification030::declared_steps030(document)
}
pub struct Diagnostic {
    pub code: String,
    pub pointer: String,
    pub message: String,
}
pub fn product_slice(authored: &str, compiled: Option<&str>) -> Option<Diagnostic> {
    crate::agsdl_host_qualification030::product_slice030(authored, compiled).map(|d| Diagnostic {
        code: d.code,
        pointer: d.pointer,
        message: d.message,
    })
}

impl StartSession<'_> {
    /// Expectations are comparisons only. Native ownership and the committed
    /// capture are re-read before any supervisor is attached.
    pub async fn attach_committed_start(
        &self,
        pool: &SqlitePool,
        context: HostContext,
        tasks: StreamTasks,
        identity: &FlowIdentity030,
        expected_capture: &StartCapture030,
        current_policy: Arc<dyn crate::host::ActionPolicySource>,
    ) -> Result<()> {
        self.lease.ensure_live()?;
        let owner = self.lease.owner(&identity.system_start_id)?;
        let inspected = flow::inspect_run(self.engine.flow030(), self.engine, pool, &owner).await?;
        if inspected.owner != owner
            || inspected.capture.identity != *identity
            || expected_capture.identity != *identity
            || serde_json::to_vec(&inspected.capture)? != serde_json::to_vec(expected_capture)?
        {
            return Err(failure(
                "CORRELATION",
                "capture",
                "Committed Start differs from its expected capture",
            ));
        }
        self.lease.ensure_live()?;
        let capture = inspected.capture;
        let plan: persistence::flow030::FlowPlan030 =
            serde_json::from_str(&capture.compiled_plan_json)?;
        let document: Value = serde_json::from_str(&plan.document_json)?;
        let needs_clock = plan.steps.iter().any(|step| {
            step.r#type == "approval" || step.r#type == "call" || step.timeout_ms_json.is_some()
        }) || document["agents"].as_object().is_some_and(|agents| {
            agents
                .values()
                .any(|agent| agent.get("answerTimeoutMs").is_some())
        });
        let agents = crate::agsdl_host_codex030::CodexExecutor030::new(context.clone())
            .with_approvals(Arc::new(
                crate::agsdl_host_action_approval030::AgentActionHumans030 {
                    host: self.engine.clone(),
                    pool: pool.clone(),
                    policy: current_policy,
                },
            ));
        let agents: Arc<dyn crate::agsdl_host_runtime030::AgentExecutor030> = Arc::new(agents);
        #[cfg(feature = "dev-support")]
        let agents = self
            .engine
            .flow030()
            .fixture_agents
            .lock()
            .expect("synthetic executor")
            .clone()
            .unwrap_or(agents);
        let executors = crate::agsdl_host_runtime030::Executors030 {
            agents,
            calls: Some(Arc::new(
                crate::agsdl_host_call_executor030::CallExecutor030 {
                    config: context.clone(),
                    pool: pool.clone(),
                    tasks: tasks.clone(),
                    transport: Arc::new(
                        crate::agsdl_host_call_executor030::NativeCallTransport030 {
                            humans: Some(Arc::new(
                                crate::agsdl_host_human_executor030::CallHumans030 {
                                    app: self.engine.clone(),
                                    pool: pool.clone(),
                                    identity: capture.identity.clone(),
                                },
                            )),
                        },
                    ),
                    owner: owner.clone(),
                },
            )),
            humans: Some(Arc::new(
                crate::agsdl_host_human_executor030::HumanExecutor030 {
                    pool: pool.clone(),
                    tasks: tasks.clone(),
                },
            )),
            clock: needs_clock.then(|| {
                Arc::new(crate::agsdl_host_human_executor030::HumanClockRuntime030 {
                    app: self.engine.clone(),
                    pool: pool.clone(),
                    tasks: tasks.clone(),
                    identity: capture.identity.clone(),
                }) as Arc<dyn crate::agsdl_host_runtime030::RuntimeClock030>
            }),
        };
        crate::agsdl_host_runtime030::spawn_supervisor030(
            self.engine.clone(),
            pool.clone(),
            context,
            tasks,
            owner,
            executors,
        )
    }
}

/// Observe the version of an installed descriptive harness; never grants execution.
pub async fn observe_harness(name: &str) -> Option<Value> {
    crate::agsdl_host_harness030::observe(name).await
}

/// Fixed descriptive metadata for the host capture regression. No executable,
/// provider credential, native owner or response authority is returned.
#[cfg(feature = "dev-support")]
#[doc(hidden)]
pub fn synthetic_codex_observation() -> CodexObservation {
    CodexObservation {
        profile: ObservedProfile {
            identity: "synthetic-profile".into(),
            digest: "synthetic-profile".into(),
        },
        version: "0.167.0".into(),
        models: vec![
            serde_json::json!({"name":"fixture","efforts":["medium","high"],"defaultEffort":"medium","isDefault":true}),
        ],
        account_digest: "synthetic-account".into(),
    }
}
