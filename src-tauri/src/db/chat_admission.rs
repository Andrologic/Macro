//! Local conversation ownership and durable work. No transfer command is exposed.
use super::{preparation_lease::Lease, DbError, DbResult};
use sqlx::{Connection, QueryBuilder, Sqlite, SqliteConnection, SqlitePool};
use tokio::sync::OnceCell;

const MIGRATION: &str = include_str!("migrations/017_chat_admission.sql");
const OBJECTS: &str = "name GLOB 'chat_admission_*' OR tbl_name GLOB 'chat_admission_*'";
static EXPECTED: OnceCell<Vec<(String, Option<String>)>> = OnceCell::const_new();

fn invalid(code: &str) -> DbError {
    DbError::Validation(code.into())
}

async fn expected_schema() -> DbResult<&'static Vec<(String, Option<String>)>> {
    EXPECTED.get_or_try_init(|| async {
        let mut db = SqliteConnection::connect("sqlite::memory:").await?;
        // Trigger DDL is compared verbatim. These empty tables provide only the
        // namespaces needed to install it; they never serve as admission data.
        for table in ["conversations", "messages", "conversation_management",
            "conversation_response_versions", "conversation_citations",
            "conversation_toolbox_state", "conversation_compactions",
            "conversation_compaction_events", "conversation_action_receipts",
            "tool_invocations", "pilot_message_attachments", "pilot_file_sends", "app_settings"] {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "CREATE TABLE {table}(id TEXT,conversation_id TEXT,scope_mode TEXT,project_id TEXT,group_id TEXT,task_id TEXT)"
            ))).execute(&mut db).await?;
        }
        sqlx::raw_sql(MIGRATION).execute(&mut db).await?;
        let result = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT name,sql FROM sqlite_master WHERE {OBJECTS} ORDER BY name"
        ))).fetch_all(&mut db).await?;
        db.close().await?;
        Ok(result)
    }).await
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
    let expected = expected_schema().await?;
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
    sqlx::query("UPDATE chat_admission_operations SET phase='unknown',revision=revision+1 WHERE phase IN ('prepared','dispatched')")
        .execute(&mut *tx).await?;
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
    // Reconcile tools while an ordinary restored owner is still writable.
    // A protected owner with pending tools is inconsistent and stays closed.
    super::tool_invocations::reconcile_pending_after_restart_in(&mut tx).await?;
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
pub(crate) struct OperationPermit {
    owner: crate::core::db_state::DbPool,
    generation: String,
    operation: String,
    conversation: String,
    incarnation: String,
    _runtime: crate::core::db_state::ChatWorkLifetime,
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
        let incarnation: Option<String> = sqlx::query_scalar("SELECT o.incarnation FROM chat_admission_owners o JOIN conversations c ON c.id=o.conversation_id WHERE c.id=? AND c.scope_mode='Chat' AND c.project_id IS NULL AND c.group_id IS NULL AND c.task_id IS NULL AND o.mode='open'")
            .bind(conversation).fetch_optional(&mut *tx).await?;
        let incarnation =
            incarnation.ok_or_else(|| invalid("chat_admission_not_open_global_chat"))?;
        let active: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE conversation_id=? AND kind IN ('turn','compaction') AND parent_id IS NULL AND phase IN ('prepared','dispatched','result_pending'))")
            .bind(conversation).fetch_one(&mut *tx).await?;
        if active != 0 {
            return Err(invalid("chat_admission_busy"));
        }
        let operation = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,runtime_generation,kind,phase,turn_id) VALUES(?,?,?,?,'turn','prepared',?)")
            .bind(&operation).bind(conversation).bind(&incarnation).bind(&generation).bind(turn)
            .execute(&mut *tx).await?;
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

    async fn check(&self, db: &mut SqliteConnection) -> DbResult<String> {
        let current: Option<String> = sqlx::query_scalar("SELECT p.phase FROM chat_admission_operations p JOIN chat_admission_owners o ON o.conversation_id=p.conversation_id WHERE p.operation_id=? AND p.conversation_id=? AND p.incarnation=? AND p.runtime_generation=? AND o.incarnation=p.incarnation AND o.mode='open'")
            .bind(&self.operation).bind(&self.conversation).bind(&self.incarnation).bind(&self.generation)
            .fetch_optional(db).await?;
        current.ok_or_else(|| invalid("chat_admission_stale_operation"))
    }

    pub(crate) async fn child(&self, kind: WorkKind, request: Option<&str>) -> DbResult<Self> {
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
        let operation = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,parent_id,runtime_generation,kind,phase,turn_id,message_id,request_id) SELECT ?,conversation_id,incarnation,operation_id,runtime_generation,?,'prepared',turn_id,message_id,? FROM chat_admission_operations WHERE operation_id=?")
            .bind(&operation).bind(kind.as_str()).bind(request).bind(&self.operation)
            .execute(&mut *tx).await?;
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

    pub(crate) async fn dispatched(&self) -> DbResult<()> {
        self.transition("prepared", "dispatched").await
    }
    pub(crate) async fn result_pending(&self) -> DbResult<()> {
        self.transition("dispatched", "result_pending").await
    }
    pub(crate) async fn no_effect(&self) -> DbResult<()> {
        self.transition("prepared", "no_effect").await
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
            let pending: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE parent_id=? AND phase NOT IN ('completed','no_effect'))")
                .bind(&self.operation).fetch_one(&mut *tx).await?;
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

#[cfg(test)]
mod tests;
