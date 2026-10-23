//! Live local handles. SQLite remains authoritative for every work transition.
use super::{invalid, OperationPermit, RootWorkKind};
use crate::core::db_state::DbPool;
use crate::db::DbResult;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;


/// One fingerprint for the actual write and its replay check; no payload is
/// retained in the local admission journal.
pub(crate) fn completion_fingerprint<T: Serialize>(kind: &str, input: &T) -> DbResult<String> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(input)
        .map_err(|_| invalid("chat_admission_completion_encoding"))?;
    Ok(format!("{kind}:{:x}", Sha256::digest(bytes)))
}

/// Read-only receipt lookup cannot reconstruct a live dispatch capability.
pub(crate) async fn replay_completion(
    owner: &DbPool,
    caller: &str,
    context: &ChatAdmissionContext,
    conversation: &str,
    fingerprint: &str,
) -> DbResult<bool> {
    let guard = owner.source_ready(None).await
        .map_err(|_| invalid("chat_admission_unavailable"))?;
    let mut db = guard.ready.pool.acquire().await?;
    guard.ready.check_source_schema(&mut db).await?;
    let receipt: Option<String> = sqlx::query_scalar("SELECT completion_receipt FROM chat_admission_operations WHERE operation_id=? AND conversation_id=? AND browser_caller=? AND browser_runtime=? AND phase='completed' AND completion_receipt IS NOT NULL")
        .bind(&context.handle).bind(conversation).bind(caller).bind(&context.runtime)
        .fetch_optional(&mut *db).await?;
    match receipt {
        Some(receipt) if receipt == fingerprint => Ok(true),
        Some(_) => Err(invalid("chat_admission_completion_receipt_conflict")),
        None => Ok(false),
    }
}

/// Local IPC only. Never part of an archive, transfer receipt or provider body.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatAdmissionContext {
    pub handle: String,
    pub runtime: String,
}

/// Captured local tool identity. It carries no reusable transfer authority.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatToolAdmission {
    pub request_id: String,
    pub context: ChatAdmissionContext,
    pub identity: crate::db::tool_invocations::ToolInvocationIdentity,
}

struct Turn {
    caller: String,
    runtime: String,
    conversation: String,
    turn: String,
    attempt: String,
    purpose: RootWorkKind,
    permit: Option<Arc<OperationPermit>>,
    completion_receipt: Option<String>,
    finalization: Arc<Mutex<()>>,
}

#[derive(Clone)]
struct BrowserOwner {
    caller: String,
    runtime: String,
    generation: String,
    page: String,
    closing: bool,
    error: Option<String>,
}

#[derive(Default)]
pub(crate) struct ChatAdmissionRuntime {
    turns: Mutex<HashMap<String, Turn>>,
    browser: std::sync::Mutex<Option<BrowserOwner>>,
    browser_closed: tokio::sync::Notify,
    pages: std::sync::Mutex<HashMap<String, String>>,
    lifecycle: Mutex<()>,
}

impl ChatAdmissionRuntime {
    fn check_browser(&self, caller: &str, runtime: &str) -> DbResult<()> {
        let browser = self.browser.lock().unwrap_or_else(|e| e.into_inner());
        if browser.as_ref().is_some_and(|owner| owner.caller == caller && owner.runtime == runtime && !owner.closing) {
            Ok(())
        } else {
            Err(invalid("chat_admission_browser_closed"))
        }
    }

    pub(crate) fn current_page(&self, caller: &str) -> String {
        self.pages.lock().unwrap_or_else(|e| e.into_inner()).get(caller).cloned().unwrap_or_default()
    }

    pub(crate) fn invalidate_page(&self, caller: &str) -> String {
        let page = uuid::Uuid::new_v4().to_string();
        self.pages.lock().unwrap_or_else(|e| e.into_inner()).insert(caller.into(), page.clone());
        self.revoke_browser(caller);
        page
    }

    pub(crate) async fn close_previous_page(
        &self, owner: &DbPool, ai: &crate::ai::AiState,
        http: &crate::ai::admitted_http::AdmittedHttp, caller: &str, page: &str,
    ) -> DbResult<()> {
        let previous = {
            // Also wait for an open whose SQLite transaction was in progress
            // when native page invalidation ran, before it published its owner.
            let _lifecycle = self.lifecycle.lock().await;
            if self.current_page(caller) != page { return Ok(()); }
            let mut current = self.browser.lock().unwrap_or_else(|e| e.into_inner());
            current.as_mut().filter(|b| b.caller == caller && b.page != page).map(|b| {
                b.closing = true;
                b.runtime.clone()
            })
        };
        if let Some(runtime) = previous {
            self.close_browser(owner, ai, http, caller, &runtime).await?;
        }
        Ok(())
    }

    pub(crate) async fn open_browser(&self, owner: DbPool, caller: &str, runtime: &str) -> DbResult<()> {
        let page = self.current_page(caller);
        self.open_browser_on_page(owner, caller, runtime, &page).await
    }

    pub(crate) async fn open_browser_on_page(&self, owner: DbPool, caller: &str, runtime: &str, page: &str) -> DbResult<()> {
        if caller.is_empty() || runtime.is_empty() { return Err(invalid("chat_admission_runtime_missing")); }
        loop {
            let notified = self.browser_closed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let current = self.browser.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(current) = current {
                if let Some(error) = current.error { return Err(invalid(&error)); }
                if current.closing { notified.await; continue; }
            }
            let _lifecycle = self.lifecycle.lock().await;
            if self.current_page(caller) != page { return Err(invalid("chat_admission_browser_page_retired")); }
            if self.browser.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|b| b.closing) { continue; }
            let guard = owner.source_ready(None).await.map_err(|_| invalid("chat_admission_unavailable"))?;
            let generation = guard.ready.catalog_generation.clone();
            let mut lease = super::durable_lease(&guard.ready.pool).await?;
            use sqlx::Connection;
            let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
            guard.ready.check_source_schema(&mut tx).await?;
            let active: Option<(String, String, String, String)> = sqlx::query_as("SELECT runtime,caller,runtime_generation,phase FROM chat_admission_browsers WHERE phase IN ('active','retiring')")
                .fetch_optional(&mut *tx).await?;
            if active.as_ref().is_some_and(|(id, window, epoch, phase)| id != runtime || window != caller || epoch != &generation || phase != "active") {
                return Err(invalid("chat_admission_browser_already_owned"));
            }
            if active.is_none() {
                let retired: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_browsers WHERE runtime=?)")
                    .bind(runtime).fetch_one(&mut *tx).await?;
                if retired != 0 { return Err(invalid("chat_admission_browser_retired")); }
                sqlx::query("INSERT INTO chat_admission_browsers(runtime,caller,runtime_generation,phase) VALUES(?,?,?,'active')")
                    .bind(runtime).bind(caller).bind(&generation).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            lease.committed = true;
            let pages = self.pages.lock().unwrap_or_else(|e| e.into_inner());
            let closing = pages.get(caller).map(String::as_str).unwrap_or("") != page;
            *self.browser.lock().unwrap_or_else(|e| e.into_inner()) = Some(BrowserOwner {
                caller: caller.into(), runtime: runtime.into(), generation, page: page.into(), closing, error: None,
            });
            return if closing { Err(invalid("chat_admission_browser_page_retired")) } else { Ok(()) };
        }
    }

    /// Called synchronously by native page/window lifecycle before scheduling
    /// cleanup. New IPC lookups stop immediately; admitted work is joined below.
    pub(crate) fn revoke_browser(&self, caller: &str) -> Option<String> {
        let mut browser = self.browser.lock().unwrap_or_else(|e| e.into_inner());
        let current = browser.as_mut().filter(|b| b.caller == caller && !b.closing)?;
        current.closing = true;
        Some(current.runtime.clone())
    }

    pub(crate) async fn close_browser(
        &self, owner: &DbPool, ai: &crate::ai::AiState,
        http: &crate::ai::admitted_http::AdmittedHttp,
        caller: &str, runtime: &str,
    ) -> DbResult<()> {
        if caller.is_empty() || runtime.is_empty() { return Err(invalid("chat_admission_runtime_missing")); }
        let result = self.close_browser_inner(owner, ai, http, caller, runtime).await;
        if let Err(error) = &result {
            let mut browser = self.browser.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(current) = browser.as_mut().filter(|b| b.caller == caller && b.runtime == runtime) {
                current.closing = true;
                current.error = Some(error.to_string());
            }
        }
        self.browser_closed.notify_waiters();
        result
    }

    async fn close_browser_inner(
        &self, owner: &DbPool, ai: &crate::ai::AiState,
        http: &crate::ai::admitted_http::AdmittedHttp,
        caller: &str, runtime: &str,
    ) -> DbResult<()> {
        let _lifecycle = self.lifecycle.lock().await;
        let current = self.browser.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let generation = match current {
            Some(current) if current.caller == caller && current.runtime == runtime => current.generation,
            _ => {
                // A close may beat the first registration or its IPC ACK.
                // Persist a tombstone so a delayed open cannot revive it.
                let guard = owner.source_ready(None).await.map_err(|_| invalid("chat_admission_unavailable"))?;
                let mut lease = super::durable_lease(&guard.ready.pool).await?;
                use sqlx::Connection;
                let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
                guard.ready.check_source_schema(&mut tx).await?;
                let previous: Option<(String, String)> = sqlx::query_as("SELECT caller,phase FROM chat_admission_browsers WHERE runtime=?")
                    .bind(runtime).fetch_optional(&mut *tx).await?;
                match previous {
                    Some((window, phase)) if window == caller && phase == "retired" => {},
                    Some(_) => return Err(invalid("chat_admission_browser_mismatch")),
                    None => {
                        let work: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE browser_runtime=?)")
                            .bind(runtime).fetch_one(&mut *tx).await?;
                        if work != 0 { return Err(invalid("chat_admission_browser_journal_inconsistent")); }
                        sqlx::query("INSERT INTO chat_admission_browsers(runtime,caller,runtime_generation,phase) VALUES(?,?,?,'retired')")
                            .bind(runtime).bind(caller).bind(&guard.ready.catalog_generation).execute(&mut *tx).await?;
                    }
                }
                tx.commit().await?;
                lease.committed = true;
                return Ok(());
            }
        };
        self.revoke_browser(caller);
        let requests = {
            let guard = owner.source_ready(Some(&generation)).await.map_err(|_| invalid("chat_admission_stale_generation"))?;
            let mut lease = super::durable_lease(&guard.ready.pool).await?;
            use sqlx::Connection;
            let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
            guard.ready.check_source_schema(&mut tx).await?;
            sqlx::query("UPDATE chat_admission_browsers SET phase='retiring' WHERE runtime=? AND caller=? AND runtime_generation=? AND phase='active'")
                .bind(runtime).bind(caller).bind(&generation).execute(&mut *tx).await?;
            let requests: Vec<String> = sqlx::query_scalar("WITH RECURSIVE owned(id) AS (SELECT operation_id FROM chat_admission_operations WHERE browser_runtime=? AND browser_caller=? AND runtime_generation=? UNION ALL SELECT p.operation_id FROM chat_admission_operations p JOIN owned o ON p.parent_id=o.id) SELECT request_id FROM chat_admission_operations WHERE operation_id IN (SELECT id FROM owned) AND request_id IS NOT NULL")
                .bind(runtime).bind(caller).bind(&generation).fetch_all(&mut *tx).await?;
            // No later child can dispatch through a closed parent. An already
            // emitted effect keeps its uncertainty; cancellation is not success.
            sqlx::query("WITH RECURSIVE owned(id) AS (SELECT operation_id FROM chat_admission_operations WHERE browser_runtime=? AND browser_caller=? AND runtime_generation=? UNION ALL SELECT p.operation_id FROM chat_admission_operations p JOIN owned o ON p.parent_id=o.id) UPDATE chat_admission_operations SET phase=CASE WHEN phase='prepared' THEN 'no_effect' ELSE 'unknown' END,revision=revision+1 WHERE operation_id IN (SELECT id FROM owned) AND kind IN ('turn','provider','tool','compaction') AND phase IN ('prepared','dispatched','result_pending')")
                .bind(runtime).bind(caller).bind(&generation).execute(&mut *tx).await?;
            let pending_tools: Vec<(String, String, String, String)> = sqlx::query_as("SELECT p.conversation_id,p.turn_id,p.message_id,p.call_id FROM chat_admission_operations p JOIN chat_admission_operations root ON root.operation_id=p.parent_id JOIN tool_invocations t ON t.conversation_id=p.conversation_id AND t.turn_id=p.turn_id AND t.message_id=p.message_id AND t.call_id=p.call_id WHERE root.browser_runtime=? AND root.browser_caller=? AND root.runtime_generation=? AND t.status='pending'")
                .bind(runtime).bind(caller).bind(&generation).fetch_all(&mut *tx).await?;
            for (conversation_id, turn_id, message_id, call_id) in pending_tools {
                super::super::tool_invocations::mark_unknown_on_connection(&mut tx, super::super::tool_invocations::ToolInvocationIdentity { conversation_id, turn_id, message_id, call_id }).await?;
            }
            sqlx::query("UPDATE chat_admission_owners SET browser_reconciled=0,runtime_generation=NULL")
                .execute(&mut *tx).await?;
            tx.commit().await?;
            lease.committed = true;
            requests
        };
        for request in &requests {
            // Err means the joined task failed. Its durable unknown is retained.
            // The join itself still proves that this local task has returned.
            let _ = ai.cancel_stream_task(request).await;
            http.remove(caller, request).await;
        }
        {
            let guard = owner.source_ready(Some(&generation)).await.map_err(|_| invalid("chat_admission_stale_generation"))?;
            let mut lease = super::durable_lease(&guard.ready.pool).await?;
            use sqlx::Connection;
            let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
            guard.ready.check_source_schema(&mut tx).await?;
            sqlx::query("UPDATE chat_admission_browsers SET phase='retired' WHERE runtime=? AND caller=? AND runtime_generation=? AND phase='retiring'")
                .bind(runtime).bind(caller).bind(&generation).execute(&mut *tx).await?;
            tx.commit().await?;
            lease.committed = true;
        }
        self.turns.lock().await.retain(|_, turn| turn.caller != caller || turn.runtime != runtime);
        *self.browser.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn begin(
        &self,
        owner: DbPool,
        caller: &str,
        runtime: &str,
        conversation: &str,
        turn: &str,
    ) -> DbResult<ChatAdmissionContext> {
        self.open_browser(owner.clone(), caller, runtime).await?;
        self.begin_root(
            owner,
            caller,
            runtime,
            conversation,
            turn,
            turn,
            RootWorkKind::Turn,
        )
        .await
    }

    pub(crate) async fn begin_root(
        &self,
        owner: DbPool,
        caller: &str,
        runtime: &str,
        conversation: &str,
        turn: &str,
        attempt: &str,
        purpose: RootWorkKind,
    ) -> DbResult<ChatAdmissionContext> {
        let _lifecycle = self.lifecycle.lock().await;
        self.check_browser(caller, runtime)?;
        if caller.is_empty() || runtime.is_empty() || attempt.is_empty() {
            return Err(invalid("chat_admission_runtime_missing"));
        }
        if let Some(handle) = self.turns.lock().await.iter().find_map(|(handle, entry)| {
            (entry.caller == caller
                && entry.runtime == runtime
                && entry.conversation == conversation
                && entry.turn == turn
                && entry.attempt == attempt
                && entry.purpose == purpose
                && entry.permit.is_some())
            .then(|| handle.clone())
        }) {
            return Ok(ChatAdmissionContext {
                handle,
                runtime: runtime.into(),
            });
        }
        let permit =
            Arc::new(OperationPermit::begin_root_owned(owner, conversation, turn, purpose, Some((caller, runtime, attempt))).await?);
        let handle = permit.operation.clone();
        self.turns.lock().await.insert(
            handle.clone(),
            Turn {
                caller: caller.into(),
                runtime: runtime.into(),
                conversation: conversation.into(),
                turn: turn.into(),
                attempt: attempt.into(),
                purpose,
                permit: Some(permit),
                completion_receipt: None,
                finalization: Arc::new(Mutex::new(())),
            },
        );
        Ok(ChatAdmissionContext {
            handle,
            runtime: runtime.into(),
        })
    }

    pub(crate) async fn begin_intent(&self, owner: &DbPool, caller: &str, runtime: &str,
        identity: super::intents::IntentIdentity, mutation: super::intents::IntentMutation) -> DbResult<super::intents::IntentReceipt> {
        let _lifecycle = self.lifecycle.lock().await;
        self.check_browser(caller, runtime)?;
        super::intents::begin(owner, caller, runtime, identity, mutation).await
    }

    pub(crate) async fn finish_intent(&self, owner: &DbPool, caller: &str,
        receipt: &super::intents::IntentReceipt) -> DbResult<()> {
        let _lifecycle = self.lifecycle.lock().await;
        // The durable completed receipt is still readable after retirement.
        super::intents::finish(owner, caller, receipt).await
    }

    pub(crate) async fn parent(
        &self,
        caller: &str,
        context: &ChatAdmissionContext,
        conversation: &str,
    ) -> DbResult<Arc<OperationPermit>> {
        self.check_browser(caller, &context.runtime)?;
        let turns = self.turns.lock().await;
        let turn = turns
            .get(&context.handle)
            .filter(|turn| {
                turn.caller == caller
                    && turn.runtime == context.runtime
                    && turn.conversation == conversation
            })
            .ok_or_else(|| invalid("chat_admission_invalid_handle"))?;
        turn.permit
            .clone()
            .ok_or_else(|| invalid("chat_admission_parent_closed"))
    }
    async fn finalization_guard(
        &self,
        caller: &str,
        context: &ChatAdmissionContext,
        conversation: &str,
    ) -> DbResult<tokio::sync::OwnedMutexGuard<()>> {
        let lock = self
            .turns
            .lock()
            .await
            .get(&context.handle)
            .filter(|turn| {
                turn.caller == caller
                    && turn.runtime == context.runtime
                    && turn.conversation == conversation
            })
            .map(|turn| turn.finalization.clone())
            .ok_or_else(|| invalid("chat_admission_invalid_handle"))?;
        // Serialize only this parent's final writes and receipt publication.
        // No SQLite transaction or registry lock is held while waiting.
        Ok(lock.lock_owned().await)
    }

    pub(crate) async fn finish_response(
        &self,
        caller: &str,
        context: &ChatAdmissionContext,
        conversation: &str,
        input: crate::db::repository::UpdateMessageContentInput<'_>,
    ) -> DbResult<()> {
        let _finalization = self
            .finalization_guard(caller, context, conversation)
            .await?;
        let fingerprint = completion_fingerprint("response", &input)?;
        let permit = {
            let turns = self.turns.lock().await;
            let turn = turns
                .get(&context.handle)
                .filter(|turn| {
                    turn.caller == caller
                        && turn.runtime == context.runtime
                        && turn.conversation == conversation
                })
                .ok_or_else(|| invalid("chat_admission_invalid_handle"))?;
            if let Some(receipt) = &turn.completion_receipt {
                return if receipt == &fingerprint {
                    Ok(())
                } else {
                    Err(invalid("chat_admission_completion_receipt_conflict"))
                };
            }
            turn.permit
                .clone()
                .ok_or_else(|| invalid("chat_admission_parent_closed"))?
        };
        permit.finish_response(input).await?;
        if let Some(turn) = self.turns.lock().await.get_mut(&context.handle) {
            turn.completion_receipt = Some(fingerprint);
            turn.permit = None;
        }
        Ok(())
    }

    pub(crate) async fn finish_compaction(
        &self,
        caller: &str,
        context: &ChatAdmissionContext,
        conversation: &str,
        input: Option<crate::db::models::UpsertConversationCompactionStateInput>,
    ) -> DbResult<()> {
        let _finalization = self
            .finalization_guard(caller, context, conversation)
            .await?;
        let fingerprint = completion_fingerprint("compaction", &input)?;
        let permit = {
            let turns = self.turns.lock().await;
            let turn = turns
                .get(&context.handle)
                .filter(|turn| {
                    turn.caller == caller
                        && turn.runtime == context.runtime
                        && turn.conversation == conversation
                })
                .ok_or_else(|| invalid("chat_admission_invalid_handle"))?;
            if let Some(receipt) = &turn.completion_receipt {
                return if receipt == &fingerprint {
                    Ok(())
                } else {
                    Err(invalid("chat_admission_compaction_receipt_conflict"))
                };
            }
            turn.permit
                .clone()
                .ok_or_else(|| invalid("chat_admission_parent_closed"))?
        };
        permit.finish_compaction(input).await?;
        if let Some(turn) = self.turns.lock().await.get_mut(&context.handle) {
            turn.completion_receipt = Some(fingerprint);
            turn.permit = None;
        }
        Ok(())
    }

    pub(crate) async fn acknowledge_completion(
        &self,
        owner: &DbPool,
        caller: &str,
        context: &ChatAdmissionContext,
        conversation: &str,
    ) -> DbResult<()> {
        let guard = owner.source_ready(None).await
            .map_err(|_| invalid("chat_admission_unavailable"))?;
        let mut db = guard.ready.pool.acquire().await?;
        guard.ready.check_source_schema(&mut db).await?;
        let complete: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_admission_operations WHERE operation_id=? AND conversation_id=? AND browser_caller=? AND browser_runtime=? AND phase='completed' AND completion_receipt IS NOT NULL)")
            .bind(&context.handle).bind(conversation).bind(caller).bind(&context.runtime)
            .fetch_one(&mut *db).await?;
        if complete == 0 { return Err(invalid("chat_admission_completion_missing")); }
        // The journal is authoritative after the ACK. Replays never need a live
        // permit, and removing the map entry cannot authorize another effect.
        self.turns.lock().await.remove(&context.handle);
        Ok(())
    }

    pub(crate) async fn close_preparation(
        &self,
        caller: &str,
        context: &ChatAdmissionContext,
        conversation: &str,
    ) -> DbResult<()> {
        let _finalization = self
            .finalization_guard(caller, context, conversation)
            .await?;
        let permit = {
            let turns = self.turns.lock().await;
            let turn = turns
                .get(&context.handle)
                .filter(|turn| {
                    turn.caller == caller
                        && turn.runtime == context.runtime
                        && turn.conversation == conversation
                })
                .ok_or_else(|| invalid("chat_admission_invalid_handle"))?;
            match &turn.permit {
                Some(permit) => permit.clone(),
                None => return Ok(()),
            }
        };
        permit.no_effect().await?;
        if let Some(turn) = self.turns.lock().await.get_mut(&context.handle) {
            turn.permit = None;
        }
        Ok(())
    }
}
