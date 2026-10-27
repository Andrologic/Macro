//! Local conversation ownership and durable work. No transfer command is exposed.
use super::{preparation_lease::Lease, DbError, DbResult};
use sqlx::{Connection, QueryBuilder, Sqlite, SqliteConnection, SqlitePool};
use tokio::sync::OnceCell;

const MIGRATION: &str = include_str!("migrations/017_chat_admission.sql");
const OBJECTS: &str = "(name GLOB 'chat_admission_*' OR tbl_name GLOB 'chat_admission_*') AND name NOT GLOB 'connect_*'";
pub(crate) mod intents;
pub(crate) mod reconciliation;
pub(crate) mod retirement;
pub(crate) mod runtime;

static EXPECTED: OnceCell<Vec<(String, Option<String>)>> = OnceCell::const_new();
static EXPECTED_LEGACY: OnceCell<Vec<(String, Option<String>)>> = OnceCell::const_new();

fn invalid(code: &str) -> DbError {
    DbError::Validation(code.into())
}

async fn expected_schema(reader: bool) -> DbResult<&'static Vec<(String, Option<String>)>> {
    let cell = if reader { &EXPECTED } else { &EXPECTED_LEGACY };
    cell.get_or_try_init(|| async {
        let mut db = super::connect_transfer::reference(reader).await?;
        let result = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT name,sql FROM sqlite_master WHERE {OBJECTS} ORDER BY name"
        )))
        .fetch_all(&mut db)
        .await?;
        db.close().await?;
        Ok(result)
    })
    .await
}

pub(crate) async fn validate_schema(db: &mut SqliteConnection) -> DbResult<()> {
    // The guard reads a table-valued PRAGMA inside its trigger. SQLite refuses
    // that under trusted_schema=OFF. Report the unsupported configuration;
    // never turn schema trust on behind the caller's back.
    let trusted: i64 = sqlx::query_scalar("PRAGMA trusted_schema")
        .fetch_one(&mut *db)
        .await?;
    if trusted != 1 {
        return Err(invalid("chat_admission_schema_configuration"));
    }
    let reader: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=20 AND name='020_connect_archive_lifecycle')")
        .fetch_one(&mut *db).await?;
    let expected = expected_schema(reader != 0).await?;
    let mut query = QueryBuilder::<Sqlite>::new(format!(
        "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE {OBJECTS})="
    ));
    query.push_bind(expected.len() as i64);
    for (name, ddl) in expected {
        query
            .push(" AND EXISTS(SELECT 1 FROM sqlite_master WHERE name=")
            .push_bind(name)
            .push(" AND sql IS ")
            .push_bind(ddl)
            .push(")");
    }
    query.push(" AND EXISTS(SELECT 1 FROM schema_migrations WHERE version=17 AND name='017_chat_admission')");
    if query
        .build_query_scalar::<i64>()
        .fetch_one(&mut *db)
        .await?
        != 1
    {
        return Err(DbError::Migration(
            "Incomplete chat admission schema".into(),
        ));
    }
    let missing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversations c LEFT JOIN chat_admission_owners o ON o.conversation_id=c.id WHERE c.scope_mode='Chat' AND c.project_id IS NULL AND c.group_id IS NULL AND c.task_id IS NULL AND o.conversation_id IS NULL")
        .fetch_one(&mut *db).await?;
    if missing != 0 {
        return Err(invalid("chat_admission_owner_missing"));
    }
    let inconsistent: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_owners o JOIN conversations c ON c.id=o.conversation_id WHERE o.mode='removed')").fetch_one(db).await?;
    if inconsistent != 0 {
        return Err(invalid("chat_admission_owner_inconsistent"));
    }
    Ok(())
}

/// Only for the freshly created backup reference, never an untrusted archive.
pub(crate) async fn remove_reference_schema(pool: &SqlitePool) -> DbResult<()> {
    remove_reference_schema_in(&mut *pool.acquire().await?).await
}

pub(crate) async fn remove_reference_schema_in(db: &mut SqliteConnection) -> DbResult<()> {
    let has_f: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name='connect_transfers'")
            .fetch_one(&mut *db)
            .await?;
    if has_f != 0 {
        super::connect_transfer::remove_reference_schema_in(db).await?;
        sqlx::query("DELETE FROM schema_migrations WHERE version>=18")
            .execute(&mut *db)
            .await?;
    }

    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'chat_admission_*'",
    )
    .fetch_all(&mut *db)
    .await?;
    for name in names {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
            .execute(&mut *db)
            .await?;
    }
    sqlx::query("DROP TABLE chat_admission_operations")
        .execute(&mut *db)
        .await?;
    sqlx::query("DROP TABLE chat_admission_browsers")
        .execute(&mut *db)
        .await?;
    sqlx::query("DROP TABLE chat_admission_owners")
        .execute(&mut *db)
        .await?;
    Ok(())
}

/// Call inside the writer's transaction. Triggers also protect direct writers.
#[allow(dead_code)]
pub(crate) async fn require_writable(
    db: &mut SqliteConnection,
    conversation: &str,
) -> DbResult<()> {
    let blocked: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_owners WHERE conversation_id=? AND mode<>'open')")
        .bind(conversation).fetch_one(db).await?;
    if blocked != 0 {
        return Err(invalid("chat_admission_read_only"));
    }
    Ok(())
}

async fn durable_lease(pool: &SqlitePool) -> DbResult<Lease> {
    let mut lease = Lease::new(pool.acquire().await?);
    sqlx::query("PRAGMA recursive_triggers=ON")
        .execute(&mut *lease)
        .await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *lease)
        .await?;
    Ok(lease)
}

/// Official startup only, after the single-instance boundary, before Ready.
/// A missing process does not establish that a dispatched external effect ended.
pub(crate) async fn reconcile_after_restart(pool: &SqlitePool) -> DbResult<()> {
    let mut lease = durable_lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    super::connect_transfer::hold_in(&mut tx, false).await?;
    sqlx::query("UPDATE chat_admission_operations SET phase='unknown',revision=revision+1 WHERE phase IN ('prepared','dispatched')")
        .execute(&mut *tx).await?;
    // The old process cannot retain HTTP callbacks after exclusive startup.
    // A child process or opaque runtime has no equivalent proof here.
    sqlx::query("UPDATE chat_admission_operations SET local_closed_at=COALESCE(local_closed_at,?) WHERE local_transport='http'")
        .bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    let roots:Vec<String>=sqlx::query_scalar("SELECT operation_id FROM chat_admission_operations WHERE parent_id IS NULL AND local_closed_at IS NULL AND phase='unknown'").fetch_all(&mut *tx).await?;
    for root in roots {
        retirement::close_proven_root(&mut tx, &root).await?;
    }
    sqlx::query("UPDATE chat_admission_browsers SET phase='retired' WHERE phase<>'retired'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE chat_admission_owners SET browser_reconciled=0,runtime_generation=NULL")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

/// The restore marker remains durable until this transaction has completed.
pub(crate) async fn hold_restored_profile(pool: &SqlitePool) -> DbResult<()> {
    let mut lease = durable_lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    super::run_migrations_on_connection(&mut tx).await?;
    validate_schema(&mut tx).await?;
    super::connect_transfer::hold_in(&mut tx, true).await?;
    // The restore owner has established process quiescence. Reuse official
    // startup reconciliation before installing holds, inside this transaction.
    super::agent_runs::reconcile_active_agent_runs_after_restart_in(&mut tx).await?;
    super::conversation_goals::reconcile_audits_after_restart_in(&mut tx).await?;
    // Reconcile tools while an ordinary restored owner is still writable.
    // A protected owner with pending tools is inconsistent and stays closed.
    super::tool_invocations::reconcile_pending_after_restart_in(&mut tx).await?;
    sqlx::query("UPDATE chat_admission_browsers SET phase='retired' WHERE phase<>'retired'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE chat_admission_owners SET mode='restore_hold',revision=revision+1,browser_reconciled=0,runtime_generation=NULL WHERE mode IN ('open','frozen')")
        .execute(&mut *tx).await?;
    sqlx::query("UPDATE chat_admission_operations SET phase='unknown',revision=revision+1 WHERE phase IN ('prepared','dispatched')")
        .execute(&mut *tx).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

// The permit is native-only. Its fields cannot be reconstructed from an IPC
// receipt or restored browser data. The frontend registry will own these values.
#[allow(dead_code)]
#[derive(Clone, Copy)]
pub(crate) enum ProviderBoundary {
    ExistingContext,
    IndependentRequest,
}

pub(crate) struct OperationPermit {
    owner: crate::core::db_state::DbPool,
    generation: String,
    operation: String,
    conversation: String,
    incarnation: String,
    _runtime: crate::core::db_state::ChatWorkLifetime,
}

impl std::fmt::Debug for OperationPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperationPermit").finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RootWorkKind {
    Turn,
    Compaction,
}
impl RootWorkKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Compaction => "compaction",
        }
    }
}

#[derive(Clone, Copy)]
#[allow(dead_code)]
pub(crate) enum WorkKind {
    Turn,
    Provider,
    Tool,
    Compaction,
    Queue,
    Steer,
    Question,
    Approval,
    Unsaved,
    Recovery,
}
impl WorkKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Provider => "provider",
            Self::Tool => "tool",
            Self::Compaction => "compaction",
            Self::Queue => "queue",
            Self::Steer => "steer",
            Self::Question => "question",
            Self::Approval => "approval",
            Self::Unsaved => "unsaved",
            Self::Recovery => "recovery",
        }
    }
}

#[allow(dead_code)]
impl OperationPermit {
    /// A turn starts before preparation, image persistence or provider dispatch.
    pub(crate) async fn begin_turn(
        owner: crate::core::db_state::DbPool,
        conversation: &str,
        turn: &str,
    ) -> DbResult<Self> {
        Self::begin_root(owner, conversation, turn, RootWorkKind::Turn).await
    }

    pub(crate) async fn begin_root(
        owner: crate::core::db_state::DbPool,
        conversation: &str,
        turn: &str,
        purpose: RootWorkKind,
    ) -> DbResult<Self> {
        Self::begin_root_owned(owner, conversation, turn, purpose, None).await
    }

    async fn begin_root_owned(
        owner: crate::core::db_state::DbPool,
        conversation: &str,
        turn: &str,
        purpose: RootWorkKind,
        browser: Option<(&str, &str, &str)>,
    ) -> DbResult<Self> {
        if conversation.trim().is_empty() || turn.trim().is_empty() {
            return Err(invalid("chat_admission_invalid_identity"));
        }
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("chat_admission_unavailable"))?;
        let generation = guard.ready.catalog_generation.clone();
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        if let Some((caller, runtime, _)) = browser {
            let current: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_browsers WHERE runtime=? AND caller=? AND runtime_generation=? AND phase='active')")
                .bind(runtime).bind(caller).bind(&generation).fetch_one(&mut *tx).await?;
            if current == 0 {
                return Err(invalid("chat_admission_browser_closed"));
            }
        }
        let incarnation: Option<String> = sqlx::query_scalar("SELECT o.incarnation FROM chat_admission_owners o JOIN conversations c ON c.id=o.conversation_id WHERE c.id=? AND c.scope_mode='Chat' AND c.project_id IS NULL AND c.group_id IS NULL AND c.task_id IS NULL AND o.mode='open'")
            .bind(conversation).fetch_optional(&mut *tx).await?;
        let incarnation =
            incarnation.ok_or_else(|| invalid("chat_admission_not_open_global_chat"))?;
        // Local retirement never resolves the remote outcome. Only a distinct
        // user turn can proceed after the physical owner closed the old tree.
        let uncertain: i64 = sqlx::query_scalar("WITH RECURSIVE ancestors(id,parent_id,local_closed_at,turn_id) AS (SELECT operation_id,parent_id,local_closed_at,turn_id FROM chat_admission_operations WHERE conversation_id=? AND incarnation=? AND kind IN ('provider','tool') AND phase='unknown' UNION SELECT p.operation_id,p.parent_id,p.local_closed_at,p.turn_id FROM chat_admission_operations p JOIN ancestors a ON a.parent_id=p.operation_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE parent_id IS NULL AND (local_closed_at IS NULL OR turn_id=?))")
            .bind(conversation).bind(&incarnation).bind(turn).fetch_one(&mut *tx).await?;
        if uncertain != 0 {
            return Err(invalid("chat_admission_effect_unreconciled"));
        }
        // A response reservation retains the old copy; it does not own a new
        // explicit turn once that uncertain root's physical lifetime is closed.
        // Other completed/no-effect parents still require their ordinary copy ACK.
        let recovery: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations copy WHERE copy.conversation_id=? AND copy.incarnation=? AND copy.kind='unsaved' AND copy.phase NOT IN ('completed','no_effect') AND NOT EXISTS(SELECT 1 FROM chat_admission_operations root WHERE root.operation_id=copy.parent_id AND root.parent_id IS NULL AND root.kind='turn' AND root.phase IN ('unknown','no_effect') AND EXISTS(WITH RECURSIVE family(id,kind,phase) AS (SELECT operation_id,kind,phase FROM chat_admission_operations WHERE parent_id=root.operation_id UNION ALL SELECT p.operation_id,p.kind,p.phase FROM chat_admission_operations p JOIN family f ON p.parent_id=f.id) SELECT 1 FROM family WHERE kind IN ('provider','tool') AND phase='unknown') AND root.local_closed_at IS NOT NULL AND root.turn_id<>? AND ?='turn'))")
            .bind(conversation).bind(&incarnation).bind(turn).bind(purpose.as_str()).fetch_one(&mut *tx).await?;
        if recovery != 0 {
            return Err(invalid("chat_admission_response_recovery_pending"));
        }
        let active: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE conversation_id=? AND kind IN ('turn','compaction') AND parent_id IS NULL AND phase IN ('prepared','dispatched','result_pending'))")
            .bind(conversation).fetch_one(&mut *tx).await?;
        if active != 0 {
            return Err(invalid("chat_admission_busy"));
        }
        let operation = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,runtime_generation,kind,phase,turn_id,browser_caller,browser_runtime,browser_attempt) VALUES(?,?,?,?,?,'prepared',?,?,?,?)")
            .bind(&operation).bind(conversation).bind(&incarnation).bind(&generation).bind(purpose.as_str()).bind(turn)
            .bind(browser.map(|b| b.0)).bind(browser.map(|b| b.1)).bind(browser.map(|b| b.2))
            .execute(&mut *tx).await?;
        if purpose == RootWorkKind::Turn {
            if let Some((caller, runtime, _)) = browser {
                let queued: Option<(String, String, Option<String>, String, String)> = sqlx::query_as("SELECT operation_id,phase,parent_id,browser_caller,browser_runtime FROM chat_admission_operations WHERE conversation_id=? AND incarnation=? AND kind='queue' AND browser_attempt=?")
                    .bind(conversation).bind(&incarnation).bind(turn).fetch_optional(&mut *tx).await?;
                if let Some((id, phase, parent, window, queue_runtime)) = queued {
                    if parent.is_some()
                        || !matches!(phase.as_str(), "prepared" | "unknown")
                        || window != caller
                        || queue_runtime != runtime
                    {
                        return Err(invalid("chat_admission_queue_already_claimed"));
                    }
                    sqlx::query("UPDATE chat_admission_operations SET parent_id=?,phase='result_pending',revision=revision+1 WHERE operation_id=?")
                        .bind(&operation).bind(id).execute(&mut *tx).await?;
                }
            }
        }
        sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
            .bind(conversation).execute(&mut *tx).await?;
        tx.commit().await?;
        lease.committed = true;
        // Drop the SQLite lease before its source generation guard. The returned
        // permit retains identity, never a lock across network work.
        let runtime = guard.ready.retain_chat_work();
        drop(lease);
        drop(guard);
        Ok(Self {
            owner,
            generation,
            operation,
            conversation: conversation.into(),
            incarnation,
            _runtime: runtime,
        })
    }

    pub(crate) fn conversation_id(&self) -> &str {
        &self.conversation
    }

    async fn check(&self, db: &mut SqliteConnection) -> DbResult<String> {
        let current: Option<String> = sqlx::query_scalar("SELECT p.phase FROM chat_admission_operations p JOIN chat_admission_owners o ON o.conversation_id=p.conversation_id WHERE p.operation_id=? AND p.conversation_id=? AND p.incarnation=? AND p.runtime_generation=? AND o.incarnation=p.incarnation AND o.mode='open'")
            .bind(&self.operation).bind(&self.conversation).bind(&self.incarnation).bind(&self.generation)
            .fetch_optional(db).await?;
        current.ok_or_else(|| invalid("chat_admission_stale_operation"))
    }

    pub(crate) async fn child(&self, kind: WorkKind, request: Option<&str>) -> DbResult<Self> {
        if matches!(kind, WorkKind::Provider) {
            return Err(invalid("chat_admission_provider_context_missing"));
        }
        self.admit_child(kind, request, None).await
    }

    /// The existing tool journal and its admitted child become durable together.
    pub(crate) async fn record_tool(
        &self,
        input: super::tool_invocations::RecordToolInvocationInput,
    ) -> DbResult<super::tool_invocations::RecordToolInvocationResult> {
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        if !matches!(
            self.check(&mut tx).await?.as_str(),
            "prepared" | "dispatched" | "result_pending"
        ) {
            return Err(invalid("chat_admission_parent_closed"));
        }
        let identity = input.identity.clone();
        let matches: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations p JOIN messages m ON m.id=? WHERE p.operation_id=? AND p.parent_id IS NULL AND p.kind='turn' AND p.conversation_id=? AND p.turn_id=? AND m.conversation_id=p.conversation_id AND m.turn_id=p.turn_id AND m.role='assistant')")
            .bind(&identity.message_id).bind(&self.operation).bind(&identity.conversation_id).bind(&identity.turn_id)
            .fetch_one(&mut *tx).await?;
        if matches != 1 {
            return Err(invalid("chat_admission_tool_identity"));
        }
        let result = super::tool_invocations::record_on_connection(&mut tx, input).await?;
        if result.is_new {
            sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,parent_id,runtime_generation,kind,phase,turn_id,message_id,call_id) SELECT ?,conversation_id,incarnation,operation_id,runtime_generation,'tool','dispatched',turn_id,?,? FROM chat_admission_operations WHERE operation_id=?")
                .bind(uuid::Uuid::new_v4().to_string()).bind(&identity.message_id).bind(&identity.call_id).bind(&self.operation)
                .execute(&mut *tx).await?;
        }
        tx.commit().await?;
        lease.committed = true;
        Ok(result)
    }

    async fn tool_operation(
        &self,
        db: &mut SqliteConnection,
        identity: &super::tool_invocations::ToolInvocationIdentity,
    ) -> DbResult<(String, String)> {
        if !matches!(
            self.check(db).await?.as_str(),
            "prepared" | "dispatched" | "result_pending"
        ) {
            return Err(invalid("chat_admission_parent_closed"));
        }
        sqlx::query_as("SELECT operation_id,phase FROM chat_admission_operations WHERE parent_id=? AND kind='tool' AND conversation_id=? AND turn_id=? AND message_id=? AND call_id=? AND runtime_generation=?")
            .bind(&self.operation).bind(&identity.conversation_id).bind(&identity.turn_id)
            .bind(&identity.message_id).bind(&identity.call_id).bind(&self.generation)
            .fetch_optional(db).await?.ok_or_else(|| invalid("chat_admission_tool_identity"))
    }

    /// Link a physical native executor to the already durable tool intent.
    pub(crate) async fn tool_permit(
        &self,
        identity: &super::tool_invocations::ToolInvocationIdentity,
    ) -> DbResult<Self> {
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        let (operation, phase) = self.tool_operation(&mut tx, identity).await?;
        if phase != "dispatched" {
            return Err(invalid("chat_admission_tool_closed"));
        }
        tx.commit().await?;
        lease.committed = true;
        Ok(Self {
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            operation,
            conversation: self.conversation.clone(),
            incarnation: self.incarnation.clone(),
            _runtime: guard.ready.retain_chat_work(),
        })
    }

    /// The existing receipt and admission child close in the same transaction.
    /// Absence of a receipt preserves uncertainty; it never authorizes a retry.
    pub(crate) async fn finish_tool(
        &self,
        identity: super::tool_invocations::ToolInvocationIdentity,
        receipt: Option<String>,
    ) -> DbResult<super::tool_invocations::ToolInvocation> {
        use super::tool_invocations::{self, CompleteToolInvocationInput, ToolInvocationStatus};
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        let (operation, phase) = self.tool_operation(&mut tx, &identity).await?;
        let previous = tool_invocations::get_on_connection(&mut tx, &identity)
            .await?
            .ok_or_else(|| invalid("chat_admission_tool_identity"))?;
        let (row, next) = if let Some(receipt_id) = receipt {
            if phase == "unknown" || previous.status == ToolInvocationStatus::Unknown {
                return Err(invalid("chat_admission_tool_unreconciled"));
            }
            let pending: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE parent_id=? AND phase NOT IN ('completed','no_effect'))")
                .bind(&operation).fetch_one(&mut *tx).await?;
            if pending != 0 {
                return Err(invalid("chat_admission_children_pending"));
            }
            (
                tool_invocations::complete_on_connection(
                    &mut tx,
                    CompleteToolInvocationInput {
                        identity,
                        receipt_id,
                    },
                )
                .await?,
                "completed",
            )
        } else {
            let row = tool_invocations::mark_unknown_on_connection(&mut tx, identity).await?;
            let next = if row.status == ToolInvocationStatus::Completed {
                "completed"
            } else {
                "unknown"
            };
            (row, next)
        };
        sqlx::query("UPDATE chat_admission_operations SET phase=?,revision=revision+1 WHERE operation_id=? AND phase<>?")
            .bind(next).bind(operation).bind(next).execute(&mut *tx).await?;
        tx.commit().await?;
        lease.committed = true;
        Ok(row)
    }

    pub(crate) async fn provider_invocation(&self, request: &str) -> DbResult<Self> {
        self.admit_child(WorkKind::Provider, Some(request), None)
            .await
    }

    /// Context is derived by the provider owner from its actual transport, not
    /// from a frontend turn/session ID. An uncertain prior attempt remains a
    /// blocker across local runtime generations and cannot authorize a retry.
    pub(crate) async fn provider_attempt(
        &self,
        request: &str,
        provider: &str,
        context: &str,
    ) -> DbResult<Self> {
        if provider.is_empty() || context.is_empty() {
            return Err(invalid("chat_admission_provider_context_missing"));
        }
        self.admit_child(
            WorkKind::Provider,
            Some(request),
            Some((provider, context, ProviderBoundary::ExistingContext)),
        )
        .await
    }

    /// Only a native owner constructing a complete independent request may use
    /// this boundary. JavaScript and opaque HTTP submissions cannot select it.
    pub(crate) async fn provider_attempt_with_boundary(
        &self,
        request: &str,
        provider: &str,
        context: &str,
        boundary: ProviderBoundary,
    ) -> DbResult<Self> {
        if provider.is_empty() || context.is_empty() {
            return Err(invalid("chat_admission_provider_context_missing"));
        }
        self.admit_child(
            WorkKind::Provider,
            Some(request),
            Some((provider, context, boundary)),
        )
        .await
    }

    async fn admit_child(
        &self,
        kind: WorkKind,
        request: Option<&str>,
        context: Option<(&str, &str, ProviderBoundary)>,
    ) -> DbResult<Self> {
        if matches!(kind, WorkKind::Turn) || request.is_some_and(|v| v.trim().is_empty()) {
            return Err(invalid("chat_admission_invalid_child"));
        }
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        let parent_phase = self.check(&mut tx).await?;
        if !matches!(
            parent_phase.as_str(),
            "prepared" | "dispatched" | "result_pending"
        ) {
            return Err(invalid("chat_admission_parent_closed"));
        }
        if matches!(kind, WorkKind::Provider) && context.is_none() {
            let pending: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE parent_id=? AND kind='provider' AND phase NOT IN ('completed','no_effect'))")
                .bind(&self.operation).fetch_one(&mut *tx).await?;
            if pending != 0 {
                return Err(invalid("chat_admission_provider_unreconciled"));
            }
        }
        if let Some((provider, context, boundary)) = context {
            let query = match boundary {
                ProviderBoundary::ExistingContext => "SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE conversation_id=?1 AND incarnation=?2 AND (provider_id=?3 OR provider_context=?4) AND phase NOT IN ('completed','no_effect')) AND ?5 IS NOT NULL",
                ProviderBoundary::IndependentRequest => "WITH RECURSIVE ancestors(id,parent_id,local_closed_at,turn_id) AS (SELECT operation_id,parent_id,local_closed_at,turn_id FROM chat_admission_operations WHERE conversation_id=?1 AND incarnation=?2 AND (provider_id=?3 OR provider_context=?4) AND phase NOT IN ('completed','no_effect') UNION SELECT p.operation_id,p.parent_id,p.local_closed_at,p.turn_id FROM chat_admission_operations p JOIN ancestors a ON a.parent_id=p.operation_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE parent_id IS NULL AND (local_closed_at IS NULL OR turn_id=(SELECT turn_id FROM chat_admission_operations WHERE operation_id=?5)))",
            };
            let unresolved: i64 = sqlx::query_scalar(query)
                .bind(&self.conversation)
                .bind(&self.incarnation)
                .bind(provider)
                .bind(context)
                .bind(&self.operation)
                .fetch_one(&mut *tx)
                .await?;
            if unresolved != 0 {
                return Err(invalid("chat_admission_provider_unreconciled"));
            }
        }
        let operation = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,parent_id,runtime_generation,kind,phase,turn_id,message_id,request_id,provider_id,provider_context) SELECT ?,conversation_id,incarnation,operation_id,runtime_generation,?,'prepared',turn_id,message_id,?,?,? FROM chat_admission_operations WHERE operation_id=?")
            .bind(&operation).bind(kind.as_str()).bind(request).bind(context.map(|v| v.0)).bind(context.map(|v| v.1)).bind(&self.operation)
            .execute(&mut *tx).await?;
        if context.is_some_and(|(_, _, boundary)| {
            matches!(boundary, ProviderBoundary::IndependentRequest)
        }) {
            sqlx::query("UPDATE chat_admission_operations SET local_transport='http' WHERE operation_id=? OR (operation_id=? AND kind='provider')")
                .bind(&operation).bind(&self.operation).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        lease.committed = true;
        Ok(Self {
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            operation,
            conversation: self.conversation.clone(),
            incarnation: self.incarnation.clone(),
            _runtime: guard.ready.retain_chat_work(),
        })
    }

    /// Called by the actual task owner after its provider future and cleanup
    /// returned. It does not settle a parent turn or acknowledge persistence.
    pub(crate) async fn settle_provider_return(&self, result: &Result<(), String>) -> DbResult<()> {
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        let phase = self.check(&mut tx).await?;
        let kind: String =
            sqlx::query_scalar("SELECT kind FROM chat_admission_operations WHERE operation_id=?")
                .bind(&self.operation)
                .fetch_one(&mut *tx)
                .await?;
        if kind != "provider" {
            return Err(invalid("chat_admission_not_provider"));
        }
        let children_pending: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE parent_id=? AND phase NOT IN ('completed','no_effect'))")
            .bind(&self.operation).fetch_one(&mut *tx).await?;
        let attempt_context: Option<String> = sqlx::query_scalar(
            "SELECT provider_context FROM chat_admission_operations WHERE operation_id=?",
        )
        .bind(&self.operation)
        .fetch_one(&mut *tx)
        .await?;
        let child_effects: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE parent_id=? AND phase<>'no_effect')")
            .bind(&self.operation).fetch_one(&mut *tx).await?;
        let next = match phase.as_str() {
            "prepared" if children_pending == 0 => "no_effect",
            "dispatched" | "result_pending" if result.is_ok() && children_pending == 0 => {
                "completed"
            }
            "dispatched" | "result_pending" if result.is_ok() => "result_pending",
            "dispatched" if attempt_context.is_none() && child_effects == 0 => "no_effect",
            "result_pending" => "result_pending",
            "dispatched" => "unknown",
            "completed" | "no_effect" | "unknown" => phase.as_str(),
            _ => return Err(invalid("chat_admission_phase_conflict")),
        };
        if next != phase {
            sqlx::query("UPDATE chat_admission_operations SET phase=?,revision=revision+1 WHERE operation_id=?")
                .bind(next).bind(&self.operation).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE chat_admission_operations SET local_closed_at=COALESCE(local_closed_at,?) WHERE operation_id=? AND local_transport='http'")
            .bind(chrono::Utc::now().to_rfc3339()).bind(&self.operation).execute(&mut *tx).await?;
        tx.commit().await?;
        lease.committed = true;
        Ok(())
    }

    /// The stored response and the parent receipt commit together. Existing
    /// partial/provenance writes remain useful, but are never closure evidence.
    pub(crate) async fn finish_response(
        &self,
        input: super::repository::UpdateMessageContentInput<'_>,
    ) -> DbResult<()> {
        let receipt = runtime::completion_fingerprint("response", &input)?;
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        let phase = self.check(&mut tx).await?;
        if !matches!(phase.as_str(), "prepared" | "dispatched" | "result_pending") {
            return Err(invalid("chat_admission_parent_closed"));
        }
        persist_response_in(
            &mut tx,
            &self.operation,
            &self.conversation,
            &receipt,
            input,
        )
        .await?;
        tx.commit().await?;
        lease.committed = true;
        Ok(())
    }

    pub(crate) async fn finish_compaction(
        &self,
        input: Option<super::models::UpsertConversationCompactionStateInput>,
    ) -> DbResult<()> {
        let receipt = runtime::completion_fingerprint("compaction", &input)?;
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        let phase = self.check(&mut tx).await?;
        if !matches!(phase.as_str(), "prepared" | "dispatched" | "result_pending") {
            return Err(invalid("chat_admission_parent_closed"));
        }
        let kind: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE operation_id=? AND parent_id IS NULL AND kind='compaction')")
            .bind(&self.operation).fetch_one(&mut *tx).await?;
        if kind == 0 {
            return Err(invalid("chat_admission_not_compaction"));
        }
        let pending: i64 = sqlx::query_scalar("WITH RECURSIVE children(id,phase) AS (SELECT operation_id,phase FROM chat_admission_operations WHERE parent_id=? UNION SELECT p.operation_id,p.phase FROM chat_admission_operations p JOIN children c ON p.parent_id=c.id) SELECT EXISTS(SELECT 1 FROM children WHERE phase NOT IN ('completed','no_effect'))")
            .bind(&self.operation).fetch_one(&mut *tx).await?;
        if pending != 0 {
            return Err(invalid("chat_admission_children_pending"));
        }
        if unresolved_turn_tools(&mut tx, &self.conversation, &self.operation).await? {
            return Err(invalid("chat_admission_tool_journal_unreconciled"));
        }
        if let Some(input) = input {
            if input.conversation_id != self.conversation {
                return Err(invalid("chat_admission_compaction_identity_mismatch"));
            }
            let belongs: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE id=? AND conversation_id=?)",
            )
            .bind(&input.up_to_message_id)
            .bind(&self.conversation)
            .fetch_one(&mut *tx)
            .await?;
            if belongs == 0 {
                return Err(invalid("chat_admission_compaction_boundary_missing"));
            }
            super::repository::upsert_conversation_compaction_state_with_connection(&mut tx, input)
                .await?;
        } else {
            let present: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM conversation_compactions WHERE conversation_id=?)",
            )
            .bind(&self.conversation)
            .fetch_one(&mut *tx)
            .await?;
            if present != 0 {
                return Err(invalid("chat_admission_compaction_changed"));
            }
        }
        sqlx::query("UPDATE chat_admission_operations SET phase='completed',completion_receipt=?,revision=revision+1 WHERE operation_id=?")
            .bind(receipt).bind(&self.operation).execute(&mut *tx).await?;
        tx.commit().await?;
        lease.committed = true;
        Ok(())
    }

    pub(crate) async fn provider_invocation_phase(&self, request: &str) -> DbResult<String> {
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        self.check(&mut tx).await?;
        let phase: Option<String> = sqlx::query_scalar("SELECT phase FROM chat_admission_operations WHERE parent_id=? AND kind='provider' AND request_id=? AND runtime_generation=?")
            .bind(&self.operation).bind(request).bind(&self.generation).fetch_optional(&mut *tx).await?;
        let phase = phase.ok_or_else(|| invalid("chat_admission_provider_invocation_missing"))?;
        tx.commit().await?;
        lease.committed = true;
        Ok(phase)
    }

    pub(crate) async fn dispatched(&self) -> DbResult<()> {
        self.transition("prepared", "dispatched").await
    }
    pub(crate) async fn result_pending(&self) -> DbResult<()> {
        self.transition("dispatched", "result_pending").await
    }
    /// Preparation can own a completed metadata request before an assistant
    /// exists. Preserve that outcome instead of calling it no_effect.
    pub(crate) async fn finish_preparation(&self) -> DbResult<()> {
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        let phase = self.check(&mut tx).await?;
        let unlaunched: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE operation_id=? AND parent_id IS NULL AND message_id IS NULL)")
            .bind(&self.operation).fetch_one(&mut *tx).await?;
        if phase != "prepared" || unlaunched == 0 {
            return Err(invalid("chat_admission_preparation_already_launched"));
        }
        let pending: i64 = sqlx::query_scalar("WITH RECURSIVE children(id,phase) AS (SELECT operation_id,phase FROM chat_admission_operations WHERE parent_id=? UNION SELECT p.operation_id,p.phase FROM chat_admission_operations p JOIN children c ON p.parent_id=c.id) SELECT EXISTS(SELECT 1 FROM children WHERE phase NOT IN ('completed','no_effect'))")
            .bind(&self.operation).fetch_one(&mut *tx).await?;
        if pending != 0 {
            return Err(invalid("chat_admission_children_pending"));
        }
        let effect: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE parent_id=? AND kind IN ('provider','tool') AND phase='completed')")
            .bind(&self.operation).fetch_one(&mut *tx).await?;
        let receipt = runtime::completion_fingerprint("preparation", &())?;
        sqlx::query("UPDATE chat_admission_operations SET phase=?,completion_receipt=?,revision=revision+1 WHERE operation_id=?")
            .bind(if effect == 0 { "no_effect" } else { "completed" }).bind(receipt).bind(&self.operation).execute(&mut *tx).await?;
        tx.commit().await?;
        lease.committed = true;
        Ok(())
    }

    /// The executable owner returned a successful result after its physical
    /// cleanup. This receipt never changes the external-effect phase.
    pub(crate) async fn local_execution_closed(&self) -> DbResult<()> {
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        self.check(&mut tx).await?;
        sqlx::query("UPDATE chat_admission_operations SET local_closed_at=COALESCE(local_closed_at,?) WHERE operation_id=? AND kind='tool' AND request_id IS NOT NULL")
            .bind(chrono::Utc::now().to_rfc3339()).bind(&self.operation).execute(&mut *tx).await?;
        tx.commit().await?;
        lease.committed = true;
        Ok(())
    }

    pub(crate) async fn no_effect(&self) -> DbResult<()> {
        self.transition("prepared", "no_effect").await
    }
    /// Only a transport owner with a confirmed pre-prompt rejection may use
    /// this transition. A timeout, disconnect or partial response is unknown.
    pub(crate) async fn rejected_before_prompt(&self) -> DbResult<()> {
        self.transition("dispatched", "no_effect").await
    }
    /// The native task owner has not polled the executor future at all.
    pub(crate) async fn cancelled_before_execution(&self) -> DbResult<()> {
        self.transition("dispatched", "no_effect").await
    }
    pub(crate) async fn unknown(&self) -> DbResult<()> {
        self.transition("dispatched", "unknown").await
    }
    pub(crate) async fn completed(&self) -> DbResult<()> {
        self.transition("result_pending", "completed").await
    }

    async fn transition(&self, from: &str, to: &str) -> DbResult<()> {
        let guard = self
            .owner
            .source_ready(Some(&self.generation))
            .await
            .map_err(|_| invalid("chat_admission_stale_generation"))?;
        let mut lease = durable_lease(&guard.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
        guard.ready.check_source_schema(&mut tx).await?;
        let phase = self.check(&mut tx).await?;
        if phase == to {
            tx.commit().await?;
            lease.committed = true;
            return Ok(());
        }
        if phase != from {
            return Err(invalid("chat_admission_phase_conflict"));
        }
        if to == "completed" || to == "no_effect" {
            let query = if to == "no_effect" {
                "SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE parent_id=? AND phase<>'no_effect' AND NOT (kind IN ('question','queue','unsaved') AND phase='completed'))"
            } else {
                "SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE parent_id=? AND phase NOT IN ('completed','no_effect'))"
            };
            let pending: i64 = sqlx::query_scalar(query)
                .bind(&self.operation)
                .fetch_one(&mut *tx)
                .await?;
            if pending != 0 {
                return Err(invalid("chat_admission_children_pending"));
            }
        }
        let changed = sqlx::query("UPDATE chat_admission_operations SET phase=?,revision=revision+1 WHERE operation_id=? AND phase=?")
            .bind(to).bind(&self.operation).bind(from).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(invalid("chat_admission_phase_conflict"));
        }
        tx.commit().await?;
        lease.committed = true;
        Ok(())
    }
}

async fn unresolved_turn_tools(
    db: &mut SqliteConnection,
    conversation: &str,
    operation: &str,
) -> DbResult<bool> {
    Ok(sqlx::query_scalar::<_,i64>("SELECT EXISTS(SELECT 1 FROM tool_invocations WHERE conversation_id=? AND turn_id=(SELECT turn_id FROM chat_admission_operations WHERE operation_id=?) AND status IN ('pending','unknown'))")
        .bind(conversation).bind(operation).fetch_one(db).await? != 0)
}

// Both live completion and recovery of a retired browser use the same writer.
// The unsaved marker remains pending until its browser copy is actually removed.
pub(crate) async fn persist_response_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    operation: &str,
    conversation: &str,
    receipt: &str,
    input: super::repository::UpdateMessageContentInput<'_>,
) -> DbResult<()> {
    let matches: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations p JOIN messages m ON m.id=? WHERE p.operation_id=? AND p.parent_id IS NULL AND p.kind='turn' AND m.conversation_id=p.conversation_id AND m.role='assistant' AND m.turn_id=p.turn_id AND (? IS NULL OR ?=p.turn_id))")
            .bind(input.id).bind(operation).bind(&input.turn_id).bind(&input.turn_id)
            .fetch_one(&mut **tx).await?;
    if matches == 0 {
        return Err(invalid("chat_admission_response_identity_mismatch"));
    }
    let pending: i64 = sqlx::query_scalar("WITH RECURSIVE children(id,phase,kind,message_id) AS (SELECT operation_id,phase,kind,message_id FROM chat_admission_operations WHERE parent_id=? UNION SELECT p.operation_id,p.phase,p.kind,p.message_id FROM chat_admission_operations p JOIN children c ON p.parent_id=c.id) SELECT EXISTS(SELECT 1 FROM children WHERE phase NOT IN ('completed','no_effect') AND NOT (kind='unsaved' AND message_id=?))")
            .bind(operation).bind(input.id).fetch_one(&mut **tx).await?;
    if pending != 0 {
        let uncertain: i64 = sqlx::query_scalar("WITH RECURSIVE children(id,phase) AS (SELECT operation_id,phase FROM chat_admission_operations WHERE parent_id=? UNION SELECT p.operation_id,p.phase FROM chat_admission_operations p JOIN children c ON p.parent_id=c.id) SELECT EXISTS(SELECT 1 FROM children WHERE phase='unknown')")
                .bind(operation).fetch_one(&mut **tx).await?;
        return Err(invalid(if uncertain != 0 {
            "chat_admission_response_outcome_unknown"
        } else {
            "chat_admission_children_pending"
        }));
    }
    if unresolved_turn_tools(&mut **tx, conversation, operation).await? {
        return Err(invalid("chat_admission_tool_journal_unreconciled"));
    }
    let message = input.id.to_owned();
    super::repository::update_message_content_with_connection(&mut **tx, input).await?;
    sqlx::query("UPDATE chat_admission_operations SET phase='completed',message_id=?,completion_receipt=?,revision=revision+1 WHERE operation_id=?")
            .bind(message).bind(receipt).bind(operation).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
