//! Live local handles. SQLite remains authoritative for every work transition.
use super::{invalid, OperationPermit, RootWorkKind};
use crate::core::db_state::DbPool;
use crate::db::DbResult;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

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

#[derive(Default)]
pub(crate) struct ChatAdmissionRuntime {
    turns: Mutex<HashMap<String, Turn>>,
}

impl ChatAdmissionRuntime {
    #[cfg(test)]
    pub(crate) async fn begin(
        &self,
        owner: DbPool,
        caller: &str,
        runtime: &str,
        conversation: &str,
        turn: &str,
    ) -> DbResult<ChatAdmissionContext> {
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
            Arc::new(OperationPermit::begin_root(owner, conversation, turn, purpose).await?);
        let handle = uuid::Uuid::new_v4().to_string();
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

    pub(crate) async fn parent(
        &self,
        caller: &str,
        context: &ChatAdmissionContext,
        conversation: &str,
    ) -> DbResult<Arc<OperationPermit>> {
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
        use sha2::{Digest, Sha256};
        let bytes =
            serde_json::to_vec(&input).map_err(|_| invalid("chat_admission_response_encoding"))?;
        let fingerprint = format!("response:{:x}", Sha256::digest(bytes));
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
        use sha2::{Digest, Sha256};
        let bytes = serde_json::to_vec(&input)
            .map_err(|_| invalid("chat_admission_compaction_encoding"))?;
        let fingerprint = format!("compaction:{:x}", Sha256::digest(bytes));
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
