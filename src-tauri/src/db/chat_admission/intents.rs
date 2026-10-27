//! Local storage markers. These records cannot dispatch providers or tools.
use super::{durable_lease, invalid, DbResult};
use crate::core::db_state::DbPool;
use serde::{Deserialize, Serialize};
use sqlx::Connection;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IntentMutation {
    Retain,
    Remove,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IntentKind {
    Queue,
    Steer,
    Question,
    Approval,
    Unsaved,
    Recovery,
}
impl IntentKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queue => "queue",
            Self::Steer => "steer",
            Self::Question => "question",
            Self::Approval => "approval",
            Self::Unsaved => "unsaved",
            Self::Recovery => "recovery",
        }
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

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IntentScope {
    GlobalChat,
    Conversation,
    Removed,
}

pub(crate) async fn classify_copy(
    database: &mut sqlx::SqliteConnection,
    conversation: &str,
    mutation: IntentMutation,
) -> DbResult<IntentScope> {
    let global: Option<i64> = sqlx::query_scalar("SELECT CASE WHEN scope_mode='Chat' AND project_id IS NULL AND group_id IS NULL AND task_id IS NULL THEN 1 ELSE 0 END FROM conversations WHERE id=?")
        .bind(conversation).fetch_optional(&mut *database).await?;
    match global {
        Some(0) => Ok(IntentScope::Conversation),
        Some(1) => Ok(IntentScope::GlobalChat),
        None if mutation == IntentMutation::Remove => {
            let protected: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_owners WHERE conversation_id=? AND mode<>'removed')")
                .bind(conversation).fetch_one(&mut *database).await?;
            if protected != 0 {
                return Err(invalid("chat_admission_intent_not_open"));
            }
            Ok(IntentScope::Removed)
        }
        _ => Err(invalid("chat_admission_conversation_missing")),
    }
}

/// The storage owner calls this before changing its existing durable document.
/// Each new write invalidates an earlier browser reconciliation snapshot.
pub(crate) async fn begin(
    owner: &DbPool,
    caller: &str,
    runtime: &str,
    identity: IntentIdentity,
    mutation: IntentMutation,
) -> DbResult<IntentReceipt> {
    if identity.id.trim().is_empty() || identity.conversation_id.trim().is_empty() {
        return Err(invalid("chat_admission_intent_identity_missing"));
    }
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("chat_admission_unavailable"))?;
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
            let acknowledged_revision = revision
                .checked_sub(1)
                .ok_or_else(|| invalid("chat_admission_intent_receipt_conflict"))?;
            tx.commit().await?;
            lease.committed = true;
            return Ok(IntentReceipt {
                operation_id: id,
                runtime: browser,
                revision: acknowledged_revision,
                identity,
            });
        }
        if !matches!(
            phase.as_str(),
            "prepared" | "dispatched" | "result_pending" | "unknown"
        ) && !(identity.kind.as_str() == "recovery"
            && matches!(phase.as_str(), "completed" | "no_effect"))
        {
            return Err(invalid("chat_admission_intent_already_closed"));
        }
        if window == caller && browser == runtime {
            let revision = revision
                .checked_add(1)
                .ok_or_else(|| invalid("chat_admission_revision_exhausted"))?;
            sqlx::query("UPDATE chat_admission_operations SET revision=?,phase=CASE WHEN kind='recovery' THEN 'prepared' ELSE phase END WHERE operation_id=?")
                .bind(revision).bind(&id).execute(&mut *tx).await?;
            sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
                .bind(&identity.conversation_id).execute(&mut *tx).await?;
            (id, revision)
        } else {
            // The one storage owner can retain a known surviving document entry
            // after reload. This never clears an absent entry or an effect row.
            let retired: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_browsers WHERE runtime=? AND caller=? AND phase='retired')")
                .bind(&browser).bind(&window).fetch_one(&mut *tx).await?;
            if retired == 0 {
                return Err(invalid("chat_admission_intent_owner_active"));
            }
            let revision = revision
                .checked_add(1)
                .ok_or_else(|| invalid("chat_admission_revision_exhausted"))?;
            sqlx::query("UPDATE chat_admission_operations SET browser_caller=?,browser_runtime=?,runtime_generation=?,revision=?,phase=CASE WHEN kind='recovery' THEN 'prepared' ELSE phase END WHERE operation_id=?")
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
    Ok(IntentReceipt {
        operation_id,
        runtime: runtime.into(),
        revision,
        identity,
    })
}

/// Called only after the storage owner has confirmed removal from its document.
/// This closes a storage marker, never a parent or an uncertain external effect.
pub(crate) async fn finish(owner: &DbPool, caller: &str, receipt: &IntentReceipt) -> DbResult<()> {
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("chat_admission_unavailable"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    let current: Option<(String, i64)> = sqlx::query_as("SELECT p.phase,p.revision FROM chat_admission_operations p JOIN chat_admission_owners o ON o.conversation_id=p.conversation_id AND o.incarnation=p.incarnation WHERE p.operation_id=? AND p.conversation_id=? AND p.kind=? AND p.browser_attempt=? AND p.browser_caller=? AND p.browser_runtime=? AND o.mode IN ('open','removed')")
        .bind(&receipt.operation_id).bind(&receipt.identity.conversation_id).bind(receipt.identity.kind.as_str()).bind(&receipt.identity.id).bind(caller).bind(&receipt.runtime).fetch_optional(&mut *tx).await?;
    match current {
        Some((phase, revision))
            if phase == "completed" && Some(revision) == receipt.revision.checked_add(1) => {}
        Some((phase, revision))
            if matches!(
                phase.as_str(),
                "prepared" | "dispatched" | "result_pending" | "unknown"
            ) && revision == receipt.revision =>
        {
            if matches!(receipt.identity.kind.as_str(), "steer" | "question") {
                return Err(invalid("chat_admission_intent_handoff_required"));
            }
            let active: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_browsers WHERE runtime=? AND caller=? AND runtime_generation=? AND phase='active')")
                .bind(&receipt.runtime).bind(caller).bind(&guard.ready.catalog_generation).fetch_one(&mut *tx).await?;
            if active == 0 {
                return Err(invalid("chat_admission_browser_closed"));
            }
            sqlx::query("UPDATE chat_admission_operations SET phase='completed',revision=revision+1 WHERE operation_id=?")
                .bind(&receipt.operation_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
                .bind(&receipt.identity.conversation_id).execute(&mut *tx).await?;
        }
        _ => return Err(invalid("chat_admission_intent_receipt_conflict")),
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

pub(crate) const APPROVAL_REGISTRY_KEY: &str = "toolApprovalRecovery:v1";

/// Only the existing TS recovery codec interprets approval payloads. This check
/// restricts its aggregate document mutation to one conversation and preserves
/// every other entry and extension byte-for-value.
fn approval_delta(expected: Option<&str>, value: Option<&str>, conversation: &str) -> DbResult<()> {
    fn document(raw: Option<&str>) -> DbResult<serde_json::Map<String, serde_json::Value>> {
        let value = match raw {
            Some(raw) => serde_json::from_str(raw)
                .map_err(|_| invalid("chat_admission_approval_unreadable"))?,
            None => serde_json::json!({"version":1,"requests":{}}),
        };
        value
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("chat_admission_approval_unreadable"))
    }
    let mut after = document(value)?;
    // The TS codec may retain an unreadable root verbatim while accepting a
    // fresh request. That envelope keeps its warning and cannot reconcile the
    // unknown contents. No old bytes or unrelated readable entries may vanish.
    let old = document(expected);
    let supported_shape = old.as_ref().is_ok_and(|doc| {
        doc.get("version") == Some(&serde_json::json!(1))
            && doc
                .get("requests")
                .is_some_and(serde_json::Value::is_object)
    });
    if expected.is_some() && !supported_shape {
        let requests = after
            .remove("requests")
            .and_then(|v| v.as_object().cloned())
            .ok_or_else(|| invalid("chat_admission_approval_unreadable"))?;
        if requests.keys().any(|key| key != conversation)
            || after
                != serde_json::json!({
                    "version":1,"preservedData":[{"valueJson":expected.unwrap()}]
                })
                .as_object()
                .unwrap()
                .clone()
        {
            return Err(invalid("chat_admission_approval_extension_conflict"));
        }
        return Ok(());
    }
    let mut before = old?;
    let mut old_requests = before
        .remove("requests")
        .and_then(|v| v.as_object().cloned())
        .ok_or_else(|| invalid("chat_admission_approval_unreadable"))?;
    let mut new_requests = after
        .remove("requests")
        .and_then(|v| v.as_object().cloned())
        .ok_or_else(|| invalid("chat_admission_approval_unreadable"))?;
    let previous = old_requests.remove(conversation);
    new_requests.remove(conversation);
    if old_requests != new_requests {
        return Err(invalid("chat_admission_approval_other_conversation"));
    }
    if before.get("preservedData") != after.get("preservedData") {
        let old = before.remove("preservedData");
        let mut preserved = match old {
            None => vec![],
            Some(serde_json::Value::Array(v)) => v,
            Some(v) => vec![v],
        };
        let previous =
            previous.ok_or_else(|| invalid("chat_admission_approval_extension_conflict"))?;
        preserved.push(serde_json::json!({"conversationId":conversation,"value":previous}));
        if after.remove("preservedData") != Some(serde_json::Value::Array(preserved)) {
            return Err(invalid("chat_admission_approval_extension_conflict"));
        }
    }
    if before != after {
        return Err(invalid("chat_admission_approval_extension_conflict"));
    }
    Ok(())
}

pub(crate) async fn write_approval_registry(
    owner: &DbPool,
    caller: &str,
    conversation: &str,
    receipt: Option<&IntentReceipt>,
    expected: Option<&str>,
    value: Option<&str>,
) -> DbResult<()> {
    approval_delta(expected, value, conversation)?;
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("chat_admission_unavailable"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    let retained = value
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|doc| {
            doc.get("requests")
                .and_then(|r| r.get(conversation))
                .cloned()
        })
        .is_some();
    let mutation = if retained {
        IntentMutation::Retain
    } else {
        IntentMutation::Remove
    };
    match classify_copy(&mut tx, conversation, mutation).await? {
        IntentScope::Conversation | IntentScope::Removed => {}
        IntentScope::GlobalChat => {
            let receipt = receipt.ok_or_else(|| invalid("chat_admission_intent_required"))?;
            if receipt.identity.conversation_id != conversation
                || receipt.identity.kind.as_str() != "approval"
            {
                return Err(invalid("chat_admission_intent_receipt_conflict"));
            }
            let admitted: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations p JOIN chat_admission_owners o ON o.conversation_id=p.conversation_id AND o.incarnation=p.incarnation JOIN chat_admission_browsers b ON b.runtime=p.browser_runtime AND b.caller=p.browser_caller AND b.runtime_generation=p.runtime_generation WHERE p.operation_id=? AND p.kind='approval' AND p.conversation_id=? AND p.browser_attempt=? AND p.browser_caller=? AND p.browser_runtime=? AND p.revision=? AND p.phase IN ('prepared','result_pending','unknown') AND o.mode='open' AND b.phase='active' AND b.runtime_generation=?)")
                .bind(&receipt.operation_id).bind(conversation).bind(&receipt.identity.id).bind(caller).bind(&receipt.runtime).bind(receipt.revision).bind(&guard.ready.catalog_generation).fetch_one(&mut *tx).await?;
            if admitted == 0 {
                return Err(invalid("chat_admission_intent_receipt_conflict"));
            }
        }
    }
    let current: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key=?")
            .bind(APPROVAL_REGISTRY_KEY)
            .fetch_optional(&mut *tx)
            .await?;
    if current.as_deref() != value {
        if current.as_deref() != expected {
            return Err(invalid("chat_admission_approval_stale_document"));
        }
        if let Some(value) = value {
            sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
                .bind(APPROVAL_REGISTRY_KEY).bind(value).bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
        } else {
            sqlx::query("DELETE FROM app_settings WHERE key=?")
                .bind(APPROVAL_REGISTRY_KEY)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

/// A consumed steer is acknowledged only against a physically completed native
/// provider invocation of the same turn. Removing it from a browser Map is not
/// evidence of delivery. An uncertain provider never reaches this transition.
pub(crate) async fn complete_steer_handoff(
    parent: &super::OperationPermit,
    caller: &str,
    request: &str,
    receipts: &[IntentReceipt],
) -> DbResult<()> {
    let guard = parent
        .owner
        .source_ready(Some(&parent.generation))
        .await
        .map_err(|_| invalid("chat_admission_stale_generation"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    parent.check(&mut tx).await?;
    let provider: Option<String> = sqlx::query_scalar("SELECT operation_id FROM chat_admission_operations WHERE parent_id=? AND request_id=? AND runtime_generation=? AND kind='provider' AND phase='completed'")
        .bind(&parent.operation).bind(request).bind(&parent.generation).fetch_optional(&mut *tx).await?;
    let provider = provider.ok_or_else(|| invalid("chat_admission_steer_provider_unconfirmed"))?;
    for receipt in receipts {
        if receipt.identity.kind.as_str() != "steer"
            || receipt.identity.conversation_id != parent.conversation
        {
            return Err(invalid("chat_admission_intent_receipt_conflict"));
        }
        let marker: Option<(String, i64, Option<String>)> = sqlx::query_as("SELECT p.phase,p.revision,p.parent_id FROM chat_admission_operations p JOIN chat_admission_browsers b ON b.runtime=p.browser_runtime AND b.caller=p.browser_caller AND b.runtime_generation=p.runtime_generation JOIN messages m ON m.id=p.browser_attempt AND m.conversation_id=p.conversation_id AND m.role='user' JOIN chat_admission_operations root ON root.operation_id=? AND root.turn_id=m.turn_id WHERE p.operation_id=? AND p.conversation_id=? AND p.incarnation=? AND p.kind='steer' AND p.browser_attempt=? AND p.browser_caller=? AND p.browser_runtime=? AND p.runtime_generation=? AND b.phase='active'")
            .bind(&parent.operation).bind(&receipt.operation_id).bind(&parent.conversation).bind(&parent.incarnation).bind(&receipt.identity.id).bind(caller).bind(&receipt.runtime).bind(&parent.generation).fetch_optional(&mut *tx).await?;
        match marker {
            Some((phase, revision, Some(previous)))
                if phase == "completed" && Some(revision) == receipt.revision.checked_add(1) =>
            {
                let same_turn: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE operation_id=? AND parent_id=? AND kind='provider' AND phase='completed')")
                    .bind(previous).bind(&parent.operation).fetch_one(&mut *tx).await?;
                if same_turn == 0 {
                    return Err(invalid("chat_admission_intent_receipt_conflict"));
                }
            }
            Some((phase, revision, None))
                if matches!(phase.as_str(), "prepared" | "unknown")
                    && revision == receipt.revision =>
            {
                sqlx::query("UPDATE chat_admission_operations SET parent_id=?,phase='completed',revision=revision+1 WHERE operation_id=?")
                    .bind(&provider).bind(&receipt.operation_id).execute(&mut *tx).await?;
                sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
                    .bind(&parent.conversation).execute(&mut *tx).await?;
            }
            _ => return Err(invalid("chat_admission_intent_receipt_conflict")),
        }
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

/// A persisted human answer hands the pending questionnaire to an already
/// admitted new turn. That parent remains durable before any provider dispatch.
/// Questionnaire parsing stays in the existing TS codec.
pub(crate) async fn complete_question_handoff(
    parent: &super::OperationPermit,
    caller: &str,
    receipt: &IntentReceipt,
    response: &str,
) -> DbResult<()> {
    if receipt.identity.kind.as_str() != "question"
        || receipt.identity.conversation_id != parent.conversation
    {
        return Err(invalid("chat_admission_intent_receipt_conflict"));
    }
    let guard = parent
        .owner
        .source_ready(Some(&parent.generation))
        .await
        .map_err(|_| invalid("chat_admission_stale_generation"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    parent.check(&mut tx).await?;
    let answer: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages answer JOIN chat_admission_operations root ON root.operation_id=? AND root.conversation_id=answer.conversation_id AND root.turn_id=answer.turn_id JOIN messages question ON question.id=? AND question.conversation_id=answer.conversation_id AND question.role='assistant' WHERE answer.id=? AND answer.conversation_id=? AND answer.role='user' AND root.kind='turn' AND root.phase IN ('prepared','dispatched','result_pending'))")
        .bind(&parent.operation).bind(&receipt.identity.id).bind(response).bind(&parent.conversation).fetch_one(&mut *tx).await?;
    if answer == 0 {
        return Err(invalid("chat_admission_question_answer_missing"));
    }
    let marker: Option<(String, i64, Option<String>)> = sqlx::query_as("SELECT p.phase,p.revision,p.parent_id FROM chat_admission_operations p JOIN chat_admission_browsers b ON b.runtime=p.browser_runtime AND b.caller=p.browser_caller AND b.runtime_generation=p.runtime_generation WHERE p.operation_id=? AND p.conversation_id=? AND p.incarnation=? AND p.kind='question' AND p.browser_attempt=? AND p.browser_caller=? AND p.browser_runtime=? AND p.runtime_generation=? AND b.phase='active'")
        .bind(&receipt.operation_id).bind(&parent.conversation).bind(&parent.incarnation).bind(&receipt.identity.id).bind(caller).bind(&receipt.runtime).bind(&parent.generation).fetch_optional(&mut *tx).await?;
    match marker {
        Some((phase, revision, Some(previous)))
            if phase == "completed"
                && Some(revision) == receipt.revision.checked_add(1)
                && previous == parent.operation => {}
        Some((phase, revision, None))
            if matches!(phase.as_str(), "prepared" | "unknown") && revision == receipt.revision =>
        {
            sqlx::query("UPDATE chat_admission_operations SET parent_id=?,message_id=?,phase='completed',revision=revision+1 WHERE operation_id=?")
                .bind(&parent.operation).bind(response).bind(&receipt.operation_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
                .bind(&parent.conversation).execute(&mut *tx).await?;
        }
        _ => return Err(invalid("chat_admission_intent_receipt_conflict")),
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

/// Reserve the recovery copy before any provider dispatch. The message binding
/// survives browser loss and never grants permission to dispatch a new turn.
pub(crate) async fn reserve_response(
    parent: &super::OperationPermit,
    caller: &str,
    message: &str,
) -> DbResult<IntentReceipt> {
    let guard = parent
        .owner
        .source_ready(Some(&parent.generation))
        .await
        .map_err(|_| invalid("chat_admission_stale_generation"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    parent.check(&mut tx).await?;
    let runtime: Option<String> = sqlx::query_scalar("SELECT p.browser_runtime FROM chat_admission_operations p JOIN messages m ON m.id=? WHERE p.operation_id=? AND p.kind='turn' AND p.parent_id IS NULL AND p.phase IN ('prepared','dispatched','result_pending') AND p.browser_caller=? AND m.conversation_id=p.conversation_id AND m.role='assistant' AND m.turn_id=p.turn_id AND (p.message_id IS NULL OR p.message_id=m.id)")
        .bind(message).bind(&parent.operation).bind(caller).fetch_optional(&mut *tx).await?;
    let runtime = runtime.ok_or_else(|| invalid("chat_admission_response_identity_mismatch"))?;
    let existing: Option<(String,i64,String)> = sqlx::query_as("SELECT operation_id,revision,phase FROM chat_admission_operations WHERE parent_id=? AND kind='unsaved' AND message_id=?")
        .bind(&parent.operation).bind(message).fetch_optional(&mut *tx).await?;
    let (operation_id, revision) = match existing {
        Some((id, revision, phase)) if phase == "prepared" => (id, revision),
        Some(_) => return Err(invalid("chat_admission_recovery_already_closed")),
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,runtime_generation,kind,phase,parent_id,turn_id,message_id,browser_caller,browser_runtime,browser_attempt) SELECT ?,conversation_id,incarnation,runtime_generation,'unsaved','prepared',operation_id,turn_id,?,browser_caller,browser_runtime,operation_id FROM chat_admission_operations WHERE operation_id=?")
                .bind(&id).bind(message).bind(&parent.operation).execute(&mut *tx).await?;
            sqlx::query("UPDATE chat_admission_operations SET message_id=?,revision=revision+1 WHERE operation_id=?")
                .bind(message).bind(&parent.operation).execute(&mut *tx).await?;
            sqlx::query("UPDATE chat_admission_owners SET revision=revision+1,browser_reconciled=0 WHERE conversation_id=?")
                .bind(&parent.conversation).execute(&mut *tx).await?;
            (id, 0)
        }
    };
    tx.commit().await?;
    lease.committed = true;
    Ok(IntentReceipt {
        operation_id,
        runtime,
        revision,
        identity: IntentIdentity {
            conversation_id: parent.conversation.clone(),
            kind: IntentKind::Unsaved,
            id: parent.operation.clone(),
        },
    })
}

/// Find the native reservation for this exact saved response. Legacy copies
/// without a reservation get a storage marker, never a fabricated parent.
pub(crate) async fn response_recovery_identity(
    owner: &DbPool,
    conversation: &str,
    message: &str,
) -> DbResult<IntentIdentity> {
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("chat_admission_unavailable"))?;
    let rows: Vec<String> = sqlx::query_scalar("SELECT p.browser_attempt FROM chat_admission_operations p JOIN chat_admission_owners o ON o.conversation_id=p.conversation_id AND o.incarnation=p.incarnation WHERE p.conversation_id=? AND p.kind='unsaved' AND p.message_id=? AND p.phase<>'completed'")
        .bind(conversation).bind(message).fetch_all(&guard.ready.pool).await?;
    if rows.len() > 1 {
        return Err(invalid("chat_admission_recovery_ambiguous"));
    }
    Ok(IntentIdentity {
        conversation_id: conversation.into(),
        kind: IntentKind::Unsaved,
        id: rows.into_iter().next().unwrap_or_else(|| message.into()),
    })
}

/// A retired browser cannot dispatch again. Recovery may finish its known local
/// writes, but an unknown provider/tool remains a blocker and leaves the copy.
pub(crate) async fn recover_response(
    owner: &DbPool,
    caller: &str,
    receipt: &IntentReceipt,
    input: crate::db::repository::UpdateMessageContentInput<'_>,
) -> DbResult<()> {
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("chat_admission_unavailable"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    let marker: Option<(Option<String>, Option<String>)> = sqlx::query_as("SELECT p.parent_id,p.message_id FROM chat_admission_operations p JOIN chat_admission_owners o ON o.conversation_id=p.conversation_id AND o.incarnation=p.incarnation JOIN chat_admission_browsers b ON b.runtime=p.browser_runtime AND b.caller=p.browser_caller AND b.phase='active' AND b.runtime_generation=? WHERE p.operation_id=? AND p.kind='unsaved' AND p.conversation_id=? AND p.browser_attempt=? AND p.browser_caller=? AND p.browser_runtime=? AND p.revision=? AND p.phase IN ('prepared','unknown') AND o.mode='open'")
        .bind(&guard.ready.catalog_generation).bind(&receipt.operation_id).bind(&receipt.identity.conversation_id).bind(&receipt.identity.id).bind(caller).bind(&receipt.runtime).bind(receipt.revision).fetch_optional(&mut *tx).await?;
    let (parent, message) =
        marker.ok_or_else(|| invalid("chat_admission_intent_receipt_conflict"))?;
    if receipt.identity.kind.as_str() != "unsaved"
        || message.as_deref().is_some_and(|id| id != input.id)
    {
        return Err(invalid("chat_admission_response_identity_mismatch"));
    }
    let fingerprint = super::runtime::completion_fingerprint("response", &input)?;
    if let Some(parent) = parent {
        let root: Option<(String,Option<String>)> = sqlx::query_as("SELECT p.phase,p.completion_receipt FROM chat_admission_operations p JOIN chat_admission_browsers b ON b.runtime=p.browser_runtime AND b.caller=p.browser_caller WHERE p.operation_id=? AND p.message_id=? AND p.conversation_id=? AND p.kind='turn' AND p.parent_id IS NULL AND b.phase='retired'")
            .bind(&parent).bind(input.id).bind(&receipt.identity.conversation_id).fetch_optional(&mut *tx).await?;
        match root {
            Some((phase, saved))
                if phase == "completed" && saved.as_deref() == Some(fingerprint.as_str()) => {}
            Some((phase, _))
                if matches!(phase.as_str(), "unknown" | "result_pending" | "no_effect") =>
            {
                super::persist_response_in(
                    &mut tx,
                    &parent,
                    &receipt.identity.conversation_id,
                    &fingerprint,
                    input,
                )
                .await?;
            }
            _ => return Err(invalid("chat_admission_recovery_parent_not_retired")),
        }
    } else {
        let valid: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND role='assistant')")
            .bind(input.id).bind(&receipt.identity.conversation_id).fetch_one(&mut *tx).await?;
        if valid == 0 || receipt.identity.id != input.id {
            return Err(invalid("chat_admission_response_identity_mismatch"));
        }
        crate::db::repository::update_message_content_with_connection(&mut tx, input).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}
