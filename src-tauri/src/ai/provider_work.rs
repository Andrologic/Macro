//! A native provider owns its journal through the real transport and cleanup.
use crate::db::chat_admission::{
    runtime::{ChatAdmissionContext, ChatAdmissionRuntime},
    OperationPermit, ProviderBoundary,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ProviderAdmission {
    GlobalChat { context: ChatAdmissionContext },
    Conversation,
    Utility,
}

pub(crate) enum ProviderWork {
    GlobalChat {
        invocation: Arc<OperationPermit>,
        attempts: Mutex<Vec<Arc<OperationPermit>>>,
    },
    Other,
}

impl ProviderWork {
    pub(crate) async fn admit(
        pool: &SqlitePool,
        runtime: &ChatAdmissionRuntime,
        caller: &str,
        admission: ProviderAdmission,
        conversation: Option<&str>,
        request: &str,
    ) -> Result<Self, String> {
        match admission {
            ProviderAdmission::GlobalChat { context } => {
                let conversation = conversation.ok_or("chat_admission_conversation_missing")?;
                let parent = runtime
                    .parent(caller, &context, conversation)
                    .await
                    .map_err(|e| e.to_string())?;
                let invocation = Arc::new(
                    parent
                        .provider_invocation(request)
                        .await
                        .map_err(|e| e.to_string())?,
                );
                Ok(Self::GlobalChat {
                    invocation,
                    attempts: Mutex::new(Vec::new()),
                })
            }
            ProviderAdmission::Conversation => {
                let conversation = conversation.ok_or("chat_admission_conversation_missing")?;
                let global: Option<i64> = sqlx::query_scalar("SELECT CASE WHEN scope_mode='Chat' AND project_id IS NULL AND group_id IS NULL AND task_id IS NULL THEN 1 ELSE 0 END FROM conversations WHERE id=?")
                    .bind(conversation).fetch_optional(pool).await.map_err(|e| e.to_string())?;
                match global {
                    Some(0) => Ok(Self::Other),
                    _ => Err("chat_admission_parent_required".into()),
                }
            }
            ProviderAdmission::Utility if conversation.is_none() => Ok(Self::Other),
            ProviderAdmission::Utility => Err("chat_admission_utility_has_conversation".into()),
        }
    }

    pub(crate) fn configure_http_client(
        &self,
        builder: reqwest::ClientBuilder,
    ) -> reqwest::ClientBuilder {
        match self {
            Self::GlobalChat { .. } => builder
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never()),
            Self::Other => builder,
        }
    }

    pub(crate) async fn attempt(&self, provider: &str, transport: &str) -> Result<ProviderAttempt,String> {
        self.attempt_at_boundary(provider,transport,ProviderBoundary::ExistingContext).await
    }

    /// Only native HTTP codecs constructing complete requests call this.
    /// No browser DTO or opaque bridge session selects it.
    pub(crate) async fn independent_request_attempt(&self, provider: &str, transport: &str) -> Result<ProviderAttempt,String> {
        self.attempt_at_boundary(provider,transport,ProviderBoundary::IndependentRequest).await
    }

    async fn attempt_at_boundary(&self, provider: &str, transport: &str, boundary: ProviderBoundary) -> Result<ProviderAttempt,String> {
        match self {
            Self::GlobalChat { invocation, attempts } => {
                let context=format!("{:x}",Sha256::digest(transport.as_bytes()));
                invocation.dispatched().await.map_err(|e|e.to_string())?;
                let permit=Arc::new(invocation.provider_attempt_with_boundary(&uuid::Uuid::new_v4().to_string(),provider,&context,boundary).await.map_err(|e|e.to_string())?);
                attempts.lock().await.push(permit.clone());
                Ok(ProviderAttempt::GlobalChat(permit))
            }
            Self::Other => Ok(ProviderAttempt::Other),
        }
    }

    pub(crate) async fn settle(&self, result: &Result<(), String>) -> Result<(), String> {
        if let Self::GlobalChat {
            invocation,
            attempts,
        } = self
        {
            let attempts = attempts.lock().await.clone();
            for attempt in attempts {
                attempt
                    .settle_provider_return(result)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            invocation
                .settle_provider_return(result)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

pub(crate) enum ProviderAttempt {
    GlobalChat(Arc<OperationPermit>),
    Other,
}

impl ProviderAttempt {
    pub(crate) async fn dispatched(&self) -> Result<(), String> {
        if let Self::GlobalChat(permit) = self {
            permit.dispatched().await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub(crate) async fn uncertain(&self) -> Result<(), String> {
        if let Self::GlobalChat(permit) = self {
            permit.unknown().await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// The caller supplies the received HTTP status, never a parsed error string.
    /// Timeouts, server failures and partial successes do not establish rejection.
    pub(crate) async fn http_rejection(&self, status: reqwest::StatusCode) -> Result<(), String> {
        if matches!(status.as_u16(), 400 | 401 | 403 | 404 | 422 | 429) {
            if let Self::GlobalChat(permit) = self {
                permit
                    .rejected_before_prompt()
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "provider_work_tests.rs"]
pub(crate) mod tests;
