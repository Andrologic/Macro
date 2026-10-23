//! Local storage markers. These records cannot dispatch providers or tools.
use super::{durable_lease, invalid, DbResult};
use crate::core::db_state::DbPool;
use serde::{Deserialize, Serialize};
use sqlx::Connection;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IntentMutation { Retain, Remove }

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IntentKind { Queue, Steer, Question, Approval, Unsaved }
impl IntentKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self { Self::Queue => "queue", Self::Steer => "steer", Self::Question => "question", Self::Approval => "approval", Self::Unsaved => "unsaved" }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IntentIdentity {
    pub conversation_id: String,
    pub kind: IntentKind,
    pub id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IntentReceipt {
    pub operation_id: String,
    pub runtime: String,
    pub revision: i64,
    pub identity: IntentIdentity,
}

/// The storage owner calls this before changing its existing durable document.
/// Retrying the same admitted mutation returns the same receipt.
pub(crate) async fn begin(
    owner: &DbPool, caller: &str, runtime: &str, identity: IntentIdentity, mutation: IntentMutation,
) -> DbResult<IntentReceipt> {
    if identity.id.trim().is_empty() || identity.conversation_id.trim().is_empty() {
        return Err(invalid("chat_admission_intent_identity_missing"));
    }
    let guard = owner.source_ready(None).await.map_err(|_| invalid("chat_admission_unavailable"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    let incarnation: Option<String> = sqlx::query_scalar("SELECT o.incarnation FROM chat_admission_owners o JOIN conversations c ON c.id=o.conversation_id JOIN chat_admission_browsers b ON b.runtime=? AND b.caller=? AND b.runtime_generation=? AND b.phase='active' WHERE o.conversation_id=? AND o.mode='open' AND c.scope_mode='Chat' AND c.project_id IS NULL AND c.group_id IS NULL AND c.task_id IS NULL")
        .bind(runtime).bind(caller).bind(&guard.ready.catalog_generation).bind(&identity.conversation_id).fetch_optional(&mut *tx).await?;
    let incarnation = incarnation.ok_or_else(|| invalid("chat_admission_intent_not_open"))?;
    let previous: Option<(String, i64, String, String, String)> = sqlx::query_as("SELECT operation_id,revision,phase,browser_caller,browser_runtime FROM chat_admission_operations WHERE conversation_id=? AND incarnation=? AND kind=? AND browser_attempt=?")
        .bind(&identity.conversation_id).bind(&incarnation).bind(identity.kind.as_str()).bind(&identity.id).fetch_optional(&mut *tx).await?;
    let (operation_id, revision) = if let Some((id, revision, phase, window, browser)) = previous {
        if mutation == IntentMutation::Remove && phase == "completed" && window == caller {
            let acknowledged_revision = revision.checked_sub(1).ok_or_else(|| invalid("chat_admission_intent_receipt_conflict"))?;
            tx.commit().await?;
            lease.committed = true;
            return Ok(IntentReceipt { operation_id: id, runtime: browser, revision: acknowledged_revision, identity });
        }
        if !matches!(phase.as_str(), "prepared" | "dispatched" | "result_pending" | "unknown") {
            return Err(invalid("chat_admission_intent_already_closed"));
        }
        if window == caller && browser == runtime {
            (id, revision)
        } else {
            // The one storage owner can retain a known surviving document entry
            // after reload. This never clears an absent entry or an effect row.
            let retired: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_browsers WHERE runtime=? AND caller=? AND phase='retired')")
                .bind(&browser).bind(&window).fetch_one(&mut *tx).await?;
            if retired == 0 { return Err(invalid("chat_admission_intent_owner_active")); }
            let revision = revision.checked_add(1).ok_or_else(|| invalid("chat_admission_revision_exhausted"))?;
            sqlx::query("UPDATE chat_admission_operations SET browser_caller=?,browser_runtime=?,runtime_generation=?,revision=? WHERE operation_id=?")
                .bind(caller).bind(runtime).bind(&guard.ready.catalog_generation).bind(revision).bind(&id).execute(&mut *tx).await?;
            sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
                .bind(&identity.conversation_id).execute(&mut *tx).await?;
            (id, revision)
        }
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,runtime_generation,kind,phase,browser_caller,browser_runtime,browser_attempt) VALUES(?,?,?,?,?,'prepared',?,?,?)")
            .bind(&id).bind(&identity.conversation_id).bind(&incarnation).bind(&guard.ready.catalog_generation).bind(identity.kind.as_str()).bind(caller).bind(runtime).bind(&identity.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
            .bind(&identity.conversation_id).execute(&mut *tx).await?;
        (id, 0)
    };
    tx.commit().await?;
    lease.committed = true;
    Ok(IntentReceipt { operation_id, runtime: runtime.into(), revision, identity })
}

/// Called only after the storage owner has confirmed removal from its document.
/// This closes a storage marker, never a parent or an uncertain external effect.
pub(crate) async fn finish(owner: &DbPool, caller: &str, receipt: &IntentReceipt) -> DbResult<()> {
    let guard = owner.source_ready(None).await.map_err(|_| invalid("chat_admission_unavailable"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    let current: Option<(String, i64)> = sqlx::query_as("SELECT p.phase,p.revision FROM chat_admission_operations p JOIN chat_admission_owners o ON o.conversation_id=p.conversation_id AND o.incarnation=p.incarnation WHERE p.operation_id=? AND p.conversation_id=? AND p.kind=? AND p.browser_attempt=? AND p.browser_caller=? AND p.browser_runtime=? AND o.mode IN ('open','removed')")
        .bind(&receipt.operation_id).bind(&receipt.identity.conversation_id).bind(receipt.identity.kind.as_str()).bind(&receipt.identity.id).bind(caller).bind(&receipt.runtime).fetch_optional(&mut *tx).await?;
    match current {
        Some((phase, revision)) if phase == "completed" && Some(revision) == receipt.revision.checked_add(1) => {},
        Some((phase, revision)) if matches!(phase.as_str(), "prepared" | "dispatched" | "result_pending" | "unknown") && revision == receipt.revision => {
            let active: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_browsers WHERE runtime=? AND caller=? AND runtime_generation=? AND phase='active')")
                .bind(&receipt.runtime).bind(caller).bind(&guard.ready.catalog_generation).fetch_one(&mut *tx).await?;
            if active == 0 { return Err(invalid("chat_admission_browser_closed")); }
            sqlx::query("UPDATE chat_admission_operations SET phase='completed',revision=revision+1 WHERE operation_id=?")
                .bind(&receipt.operation_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
                .bind(&receipt.identity.conversation_id).execute(&mut *tx).await?;
        },
        _ => return Err(invalid("chat_admission_intent_receipt_conflict")),
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}
