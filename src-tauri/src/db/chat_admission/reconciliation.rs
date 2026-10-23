//! Browser storage inspection and private source reservation. No transfer IPC.
use super::{durable_lease, invalid, DbResult};
use crate::{core::db_state::DbPool, db::{conversation_content, models::ConversationContentToken}};
use serde::Deserialize;
use sqlx::{Connection, SqliteConnection};

/// Only the live runtime constructs this snapshot; IPC receives an opaque handle.
#[derive(Clone)]
pub(super) struct Snapshot {
    pub conversation: String,
    pub caller: String,
    pub browser: String,
    generation: String,
    incarnation: String,
    revision: i64,
    content: ConversationContentToken,
    reconciled: bool,
}

/// IDs observed by the existing storage owners and questionnaire codec. No
/// transcript, callbacks, permissions or provider state cross this boundary.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserInspection {
    pub queue: Vec<String>,
    pub unsaved: Vec<String>,
    pub approvals: Vec<String>,
    pub questions: Vec<String>,
    pub drafts: Vec<String>,
    pub steers: Vec<String>,
}
impl BrowserInspection {
    fn is_empty(&self) -> bool {
        self.queue.is_empty() && self.unsaved.is_empty() && self.approvals.is_empty()
            && self.questions.is_empty() && self.drafts.is_empty() && self.steers.is_empty()
    }
}

async fn check(db: &mut SqliteConnection, snapshot: &Snapshot) -> DbResult<()> {
    let recursive: i64 = sqlx::query_scalar("PRAGMA recursive_triggers").fetch_one(&mut *db).await?;
    if recursive != 1 { return Err(invalid("chat_admission_connection_config")); }
    let valid: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_owners o JOIN conversations c ON c.id=o.conversation_id JOIN chat_admission_browsers b ON b.runtime=? AND b.caller=? AND b.runtime_generation=? AND b.phase='active' WHERE o.conversation_id=? AND o.incarnation=? AND o.revision=? AND o.mode='open' AND c.scope_mode='Chat' AND c.project_id IS NULL AND c.group_id IS NULL AND c.task_id IS NULL)")
        .bind(&snapshot.browser).bind(&snapshot.caller).bind(&snapshot.generation)
        .bind(&snapshot.conversation).bind(&snapshot.incarnation).bind(snapshot.revision).fetch_one(&mut *db).await?;
    if valid != 1 { return Err(invalid("chat_admission_inspection_stale")); }
    conversation_content::token_in(db, &snapshot.conversation, Some(&snapshot.content)).await?;
    Ok(())
}

pub(super) async fn begin(owner: &DbPool, caller: &str, browser: &str, conversation: &str) -> DbResult<Snapshot> {
    let guard = owner.source_ready(None).await.map_err(|_| invalid("chat_admission_unavailable"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    let row: Option<(String,i64)> = sqlx::query_as("SELECT incarnation,revision FROM chat_admission_owners WHERE conversation_id=? AND mode='open'")
        .bind(conversation).fetch_optional(&mut *tx).await?;
    let (incarnation, revision) = row.ok_or_else(|| invalid("chat_admission_not_open_global_chat"))?;
    let content = conversation_content::token_in(&mut tx,conversation,None).await?;
    let mut snapshot = Snapshot { conversation:conversation.into(),caller:caller.into(),browser:browser.into(),generation:guard.ready.catalog_generation.clone(),incarnation,revision,content,reconciled:false };
    check(&mut tx,&snapshot).await?;
    sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
        .bind(conversation).execute(&mut *tx).await?;
    snapshot.revision = revision.checked_add(1).ok_or_else(|| invalid("chat_admission_revision_exhausted"))?;
    tx.commit().await?; lease.committed=true;
    Ok(snapshot)
}

pub(super) async fn complete(owner: &DbPool, snapshot: &mut Snapshot, observed: &BrowserInspection) -> DbResult<()> {
    if !observed.is_empty() { return Err(invalid("chat_admission_browser_intentions_pending")); }
    let guard = owner.source_ready(Some(&snapshot.generation)).await.map_err(|_| invalid("chat_admission_stale_generation"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    check(&mut tx,snapshot).await?;
    if snapshot.reconciled { tx.commit().await?; lease.committed=true; return Ok(()); }
    // Inspection never joins native work. The real owners have to finish first.
    let unsafe_work: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations p LEFT JOIN chat_admission_browsers b ON b.runtime=p.browser_runtime AND b.caller=p.browser_caller WHERE p.conversation_id=? AND p.incarnation=? AND p.phase NOT IN ('completed','no_effect') AND (p.kind IN ('provider','tool','compaction') OR p.browser_caller IS NULL OR p.browser_caller<>? OR (p.browser_runtime<>? AND COALESCE(b.phase,'missing')<>'retired') OR (p.kind='turn' AND COALESCE(b.phase,'missing')<>'retired')))")
        .bind(&snapshot.conversation).bind(&snapshot.incarnation).bind(&snapshot.caller).bind(&snapshot.browser).fetch_one(&mut *tx).await?;
    if unsafe_work != 0 { return Err(invalid("chat_admission_work_unreconciled")); }
    // A missing recovery copy does not establish that a completed provider's
    // response was persisted. An absent assistant proves only explicit deletion.
    let lost_response: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations copy JOIN chat_admission_operations root ON root.operation_id=copy.parent_id JOIN messages m ON m.id=copy.message_id AND m.conversation_id=copy.conversation_id WHERE copy.conversation_id=? AND copy.incarnation=? AND copy.kind='unsaved' AND copy.phase NOT IN ('completed','no_effect') AND root.completion_receipt IS NULL AND EXISTS(SELECT 1 FROM chat_admission_operations effect WHERE effect.parent_id=root.operation_id AND effect.kind IN ('provider','tool') AND effect.phase='completed'))")
        .bind(&snapshot.conversation).bind(&snapshot.incarnation).fetch_one(&mut *tx).await?;
    if lost_response != 0 { return Err(invalid("chat_admission_response_recovery_missing")); }
    sqlx::query("UPDATE chat_admission_operations SET phase='no_effect',revision=revision+1 WHERE conversation_id=? AND incarnation=? AND kind IN ('queue','steer','question','approval','unsaved','recovery') AND phase NOT IN ('completed','no_effect')")
        .bind(&snapshot.conversation).bind(&snapshot.incarnation).execute(&mut *tx).await?;
    // Orphans before dispatch can close after their browser is physically gone.
    // No unknown effect or completed effect is relabelled as never sent.
    sqlx::query("UPDATE chat_admission_operations AS root SET phase='no_effect',revision=revision+1 WHERE conversation_id=? AND incarnation=? AND kind='turn' AND phase NOT IN ('completed','no_effect') AND NOT EXISTS(SELECT 1 FROM chat_admission_operations child WHERE child.parent_id=root.operation_id AND child.kind IN ('provider','tool','compaction') AND child.phase<>'no_effect')")
        .bind(&snapshot.conversation).bind(&snapshot.incarnation).execute(&mut *tx).await?;
    require_quiescent(&mut tx,&snapshot.conversation,&snapshot.incarnation).await?;
    sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=1,runtime_generation=? WHERE conversation_id=?")
        .bind(&snapshot.generation).bind(&snapshot.conversation).execute(&mut *tx).await?;
    let revision = snapshot.revision.checked_add(1).ok_or_else(|| invalid("chat_admission_revision_exhausted"))?;
    tx.commit().await?; lease.committed=true;
    snapshot.revision=revision; snapshot.reconciled=true;
    Ok(())
}

async fn require_quiescent(db: &mut SqliteConnection, conversation: &str, incarnation: &str) -> DbResult<()> {
    let pending: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE conversation_id=? AND incarnation=? AND phase NOT IN ('completed','no_effect'))")
        .bind(conversation).bind(incarnation).fetch_one(&mut *db).await?;
    if pending != 0 || super::super::tool_invocations::has_unresolved_on_connection(&mut *db,conversation).await? { return Err(invalid("chat_admission_work_unreconciled")); }
    // Only associations of this chat matter. A Goal or run elsewhere is unrelated.
    // Match the effective Goal/audit/run links, including independent legacy
    // foreign keys. Pending audits are queued/running/ready_for_verdict; only
    // queued/running AgentRunStatus values represent an active run.
    let related: i64 = sqlx::query_scalar(r#"
        WITH related_audits AS (
            SELECT a.audit_id,a.current_run_id,a.status FROM conversation_goal_audits a
            WHERE a.conversation_id=?1
               OR EXISTS(SELECT 1 FROM conversation_goals g WHERE g.goal_id=a.goal_id AND g.conversation_id=?1)
               OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=a.current_run_id AND (r.parent_conversation_id=?1 OR r.child_conversation_id=?1))
               OR EXISTS(SELECT 1 FROM conversation_goal_audit_runs l JOIN agent_runs r ON r.id=l.run_id WHERE l.audit_id=a.audit_id AND (r.parent_conversation_id=?1 OR r.child_conversation_id=?1))
        )
        SELECT EXISTS(SELECT 1 FROM conversation_goals WHERE conversation_id=?1 AND is_current=1 AND status<>'achieved')
            OR EXISTS(SELECT 1 FROM related_audits WHERE status IN ('queued','running','ready_for_verdict'))
            OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.status IN ('queued','running') AND (
                r.parent_conversation_id=?1 OR r.child_conversation_id=?1
                OR r.id IN (SELECT current_run_id FROM related_audits)
                OR r.id IN (SELECT l.run_id FROM conversation_goal_audit_runs l JOIN related_audits a ON a.audit_id=l.audit_id)))
        "#).bind(conversation).fetch_one(db).await?;
    if related != 0 { return Err(invalid("chat_admission_related_work_pending")); }
    Ok(())
}

/// Private local transaction only. Canonical transfer identity/decision binding
/// and any public command remain a later composition requirement.
#[allow(dead_code)]
pub(super) async fn reserve(owner: &DbPool, snapshot: &Snapshot) -> DbResult<()> {
    if !snapshot.reconciled { return Err(invalid("chat_admission_browser_not_reconciled")); }
    let guard = owner.source_ready(Some(&snapshot.generation)).await.map_err(|_| invalid("chat_admission_stale_generation"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    check(&mut tx,snapshot).await?;
    let ready: i64 = sqlx::query_scalar("SELECT browser_reconciled=1 AND runtime_generation=? FROM chat_admission_owners WHERE conversation_id=?")
        .bind(&snapshot.generation).bind(&snapshot.conversation).fetch_one(&mut *tx).await?;
    if ready != 1 { return Err(invalid("chat_admission_browser_not_reconciled")); }
    require_quiescent(&mut tx,&snapshot.conversation,&snapshot.incarnation).await?;
    sqlx::query("UPDATE chat_admission_owners SET mode='frozen',revision=revision+1 WHERE conversation_id=?")
        .bind(&snapshot.conversation).execute(&mut *tx).await?;
    tx.commit().await?; lease.committed=true;
    Ok(())
}
