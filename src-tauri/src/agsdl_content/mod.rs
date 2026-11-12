//! Host-owned content effects. A receipt records bytes; it never grants access.
pub(crate) mod file_helper;
#[cfg(target_os = "macos")]
mod macos_launcher;
#[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
pub(crate) mod qa;
#[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
mod qa_cases;
#[cfg(all(
    test,
    target_os = "macos",
    feature = "agsdl-content-qa",
    debug_assertions
))]
mod qa_runner_tests;
mod resolve;
mod skills;
#[cfg(all(test, feature = "agsdl-content-qa"))]
mod tests;

pub(crate) use resolve::*;
pub(crate) use skills::*;

use crate::agsdl_permissions::{evaluate_effective, ActionRequest, Effect};
use crate::agsdl_permissions::{EffectivePolicy, ExecutionPurpose, PermissionDecision};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContentError {
    pub code: String,
    pub pointer: String,
    pub message: String,
}
pub(crate) type ContentResult<T> = std::result::Result<T, ContentError>;
/// The host attaches physical reader cleanup to the existing work owner.
/// This port has no dependency on a window, application or database.
pub(crate) type ContentResourceOwner = Arc<
    dyn Fn(
            tokio::task::JoinHandle<std::result::Result<(), String>>,
        ) -> std::result::Result<(), String>
        + Send
        + Sync,
>;
fn error(code: &str, message: impl ToString) -> ContentError {
    ContentError {
        code: code.into(),
        pointer: String::new(),
        message: message.to_string(),
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// An additional recipient constraint, checked on each resolved read target.
pub(crate) type ContentReadScope = Arc<dyn Fn(&std::path::Path) -> ContentResult<()> + Send + Sync>;

/// Only the native host constructs this. Do not expose its constructor as IPC.
/// The host supplies the import/read location, never a message's baseUri or cwd.
pub(crate) struct ContentContext {
    resource_owner: Option<ContentResourceOwner>,
    read_scope: Option<ContentReadScope>,
    capture_id: String,
    source_digest: String,
    document_json: String,
    document_location: Option<url::Url>,
    agent: String,
    policy: EffectivePolicy,
    purpose: ExecutionPurpose,
    cancel: CancellationToken,
    // 09 consumes a single-action, correlated approval after revalidation.
    approve: Arc<
        dyn Fn(ContentAdmission) -> Pin<Box<dyn Future<Output = ContentResult<()>> + Send>>
            + Send
            + Sync,
    >,
}

/// Native-only snapshot of a live context. It carries no deserializer and does
/// not itself authorize a read or create a receipt.
pub(crate) struct ContentContextBinding {
    pub(crate) capture_id: String,
    pub(crate) source_digest: String,
    pub(crate) document_json: String,
    pub(crate) agent: String,
    pub(crate) policy_digest: String,
    pub(crate) policy_json: String,
}

pub(crate) struct ContentAdmission {
    pub capture_id: String,
    pub source_digest: String,
    pub agent: String,
    pub decision: PermissionDecision,
    pub effect: ContentEffect,
}

/// Correlates one approval with the actual content use and destination.
#[derive(Clone)]
pub(crate) struct ContentEffect {
    pub usage: ContentUsage,
    pub pointer: String,
    pub source_json_digest: String,
    pub target_uri: String,
    pub phase: ContentEffectPhase,
}

#[derive(Clone, Copy)]
pub(crate) enum ContentEffectPhase {
    FileRead,
    NetworkDns,
    NetworkConnect,
}

impl ContentContext {
    pub(crate) fn with_read_scope(mut self, scope: ContentReadScope) -> Self {
        self.read_scope = Some(scope);
        self
    }

    fn permission(&self, request: &ActionRequest) -> ContentResult<PermissionDecision> {
        let decision = evaluate_effective(&self.policy, request, self.purpose)
            .map_err(|e| error("PERMISSION", e.detail))?;
        if let (ActionRequest::Read { .. }, Some(scope)) = (request, &self.read_scope) {
            let path = decision
                .resolved_path
                .as_deref()
                .ok_or_else(|| error("PERMISSION", "Content read has no resolved target."))?;
            scope(std::path::Path::new(path))?;
        }
        Ok(decision)
    }

    pub(crate) fn with_resource_owner(mut self, owner: ContentResourceOwner) -> Self {
        self.resource_owner = Some(owner);
        self
    }
    /// Serialize the actual captured policy, never policy supplied by a caller.
    /// The host must still revalidate and revoke the context at commit time.
    pub(crate) fn binding(&self) -> ContentResult<ContentContextBinding> {
        self.active()?;
        let policy_json = serde_json::to_string(&self.policy)
            .map_err(|e| error("PERMISSION", format!("Cannot serialize native policy: {e}")))?;
        let policy_digest = self.policy.fingerprint();
        if digest(policy_json.as_bytes()) != policy_digest {
            return Err(error("CORRELATION", "Native policy serialization differs."));
        }
        self.active()?;
        Ok(ContentContextBinding {
            capture_id: self.capture_id.clone(),
            source_digest: self.source_digest.clone(),
            document_json: self.document_json.clone(),
            agent: self.agent.clone(),
            policy_digest,
            policy_json,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture(
        capture_id: String,
        source_digest: String,
        document_json: String,
        document_location: Option<&str>,
        agent: String,
        policy: EffectivePolicy,
        purpose: ExecutionPurpose,
        cancel: CancellationToken,
        approve: Arc<
            dyn Fn(ContentAdmission) -> Pin<Box<dyn Future<Output = ContentResult<()>> + Send>>
                + Send
                + Sync,
        >,
    ) -> ContentResult<Self> {
        crate::db::exact_json::validate(&document_json).map_err(|e| error("PARSE", e))?;
        if capture_id.is_empty() || digest(document_json.as_bytes()) != source_digest {
            return Err(error(
                "CORRELATION",
                "Document differs from the native source capture.",
            ));
        }
        if crate::db::exact_json::at_path(&document_json, &["agents", &agent])
            .map_err(|e| error("PARSE", e))?
            .is_none()
        {
            return Err(error(
                "CORRELATION",
                "Agent is absent from the captured document.",
            ));
        }
        let document_location = document_location.map(resolve::absolute_uri).transpose()?;
        if document_location
            .as_ref()
            .is_some_and(|u| u.cannot_be_a_base() || u.fragment().is_some())
        {
            return Err(error(
                "CONTENT_ORIGIN",
                "Document location must be absolute and hierarchical without a fragment.",
            ));
        }
        Ok(Self {
            resource_owner: None,
            read_scope: None,
            capture_id,
            source_digest,
            document_json,
            document_location,
            agent,
            policy,
            purpose,
            cancel,
            approve,
        })
    }

    fn active(&self) -> ContentResult<()> {
        if self.cancel.is_cancelled() {
            Err(error("CANCELLED", "Content read cancelled."))
        } else {
            Ok(())
        }
    }

    async fn admit(
        &self,
        request: ActionRequest,
        effect: ContentEffect,
    ) -> ContentResult<PermissionDecision> {
        self.active()?;
        let decision = self.permission(&request)?;
        match decision.effect {
            Effect::Deny => {
                return Err(error(
                    "PERMISSION",
                    "Captured permissions refuse this content access.",
                ))
            }
            Effect::Ask => {
                let pending = (self.approve)(ContentAdmission {
                    capture_id: self.capture_id.clone(),
                    source_digest: self.source_digest.clone(),
                    agent: self.agent.clone(),
                    decision: decision.clone(),
                    effect,
                });
                tokio::select! {
                    biased;
                    _ = self.cancel.cancelled() => return Err(error("CANCELLED", "Content read cancelled.")),
                    result = pending => result?,
                }
            }
            Effect::Allow => {}
        }
        self.active()?;
        let current = self.permission(&request)?;
        if current.effect != decision.effect
            || current.resolved_path != decision.resolved_path
            || current.policy_digest != decision.policy_digest
        {
            return Err(error(
                "CORRELATION",
                "Permission decision changed before the effect.",
            ));
        }
        Ok(decision)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ContentUsage {
    Instructions,
    Prompt,
    Resource,
    SkillDiscovery,
    SkillActivation,
    SkillResource,
    Result,
}

/// The host derives usage and pointer from its captured definition/message, not
/// from keys inside literal data or provider-supplied provenance.
pub(crate) struct ContentUse {
    pub source_json: String,
    pub usage: ContentUsage,
    pub pointer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContentProvenance {
    pub capture_id: String,
    pub source_digest: String,
    pub agent: String,
    pub usage: ContentUsage,
    pub pointer: String,
    pub source_json_digest: String,
    pub requested_uri: Option<String>,
    pub final_uri: Option<String>,
    pub file_parent_identity: Option<String>,
    pub declared_media_type: Option<String>,
    pub observed_media_type: Option<String>,
    pub media_type: String,
    pub size_bytes: String,
    pub sha256: String,
    pub policy_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ContentPayload {
    Text { text: String },
    Json { json: String },
    Media { base64: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolvedContentReceipt {
    pub payload: ContentPayload,
    pub provenance: ContentProvenance,
}
