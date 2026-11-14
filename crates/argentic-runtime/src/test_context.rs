//! Synthetic host policies for native fixtures. No application configuration store.
use crate::{host::*, persistence::Result};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
#[derive(Default)]
pub(crate) struct Policy {
    ceiling: Arc<tokio::sync::RwLock<bool>>,
}
impl Policy {
    pub(crate) async fn workspace(&self) {
        *self.ceiling.write().await = true;
    }
    fn permissions(allowed: bool) -> crate::permissions::RequestedPermissions {
        serde_json::from_value(json!(if allowed { "workspace" } else { "read-only" })).unwrap()
    }
}
impl PolicySource for Policy {
    fn lock_project<'a>(&'a self, _: &'a str) -> PolicyFuture<'a, ProjectPolicyLease> {
        Box::pin(async move {
            let guard = self.ceiling.clone().read_owned().await;
            Ok(ProjectPolicyLease::new(
                json!({"riskLevel":"balanced"}),
                Self::permissions(*guard),
                guard,
            ))
        })
    }
    fn lock_ceiling(&self) -> PolicyFuture<'_, HostPolicyLease> {
        Box::pin(async move {
            let guard = self.ceiling.clone().read_owned().await;
            Ok(HostPolicyLease::new(
                Self::permissions(*guard),
                format!("synthetic-ceiling:{}", *guard),
                guard,
            ))
        })
    }
}
pub(crate) fn context(root: PathBuf) -> HostContext {
    context_with_policy(root).0
}
pub(crate) fn context_with_policy(root: PathBuf) -> (HostContext, Arc<Policy>) {
    std::fs::create_dir_all(&root).unwrap();
    let policy = Arc::new(Policy::default());
    (HostContext::new(root, policy.clone()), policy)
}
/// Explicit captured tool projection used by the old native fixtures. Macro's
/// projection/configuration behavior remains tested in Macro.
pub(crate) fn captured_permissions() -> Value {
    json!({"mode":"Implement","readOnly":false,"riskLevel":"balanced","allowedToolIds":["list","read","glob","grep","ast_grep","write","edit","delete","apply_patch","git_status","git_log","git_branch_list","git_diff","git_get_tree"]})
}

use crate::persistence::failure;
use std::path::Path;
pub(crate) fn codex_registry030(
    document: &Value,
    source_sha256: &str,
    scope: &Value,
    observed: &crate::agsdl_host_codex::CodexObservation030,
) -> Result<(Value, Vec<Value>)> {
    crate::agsdl_host_work_admission030::validate_codex_document030(document)?;
    if document["agents"].as_object().is_some_and(|agents| {
        agents.values().any(|agent| {
            agent["skills"]
                .as_array()
                .is_some_and(|skills| !skills.is_empty())
        })
    }) {
        crate::api::qualify_skill_folders(
            document,
            Path::new(scope["root"].as_str().ok_or_else(|| {
                failure("CORRELATION", "skills", "Native project scope is absent")
            })?),
        )?;
    }
    if !crate::agsdl_host_codex::qualified_version030(&observed.version)
        || observed.models.is_empty()
    {
        return Err(failure(
            "CODEX_VERSION_UNQUALIFIED",
            "/agents",
            "Codex observation is outside the qualified version or catalogue",
        ));
    }
    let adapter = crate::agsdl_host_codex::ADAPTER;
    let evidence = json!({"adapterId":adapter,"version":observed.version,"profileDigest":observed.profile.digest,"kind":"native-codex"}).to_string();
    let capabilities = ["result-submission", "continuity", "permission-enforcement", "contained-stop", "response-attribution", "instructions", "resources", "model.name", "model.effort", "instance.new", "delivery.queue", "delivery.steer", "answer-timeout", "reviewer.person", "planFirst.auto", "completion-check", "skills"]
        .into_iter().filter(|name| (!matches!(*name,"completion-check"|"skills") || cfg!(all(target_os="macos",target_arch="aarch64"))) && (*name!="skills" || observed.version=="0.167.0" && crate::content_io::file_helper::qualified_platform())).map(|name| json!({"name":name,"support":if matches!(name, "resources" | "planFirst.auto") {"approximate"} else {"native"},"evidenceJson":evidence})).collect::<Vec<_>>();
    let default = observed
        .models
        .iter()
        .find(|model| model["isDefault"] == true)
        .and_then(|model| model["name"].as_str());
    let models = observed.models.iter().map(|model| json!({"name":model["name"],"efforts":model["efforts"],"defaultEffort":model["defaultEffort"]})).collect::<Vec<_>>();
    let agents = document["agents"].as_object().into_iter().flatten().filter(|(_, agent)| agent["harness"] == "codex").map(|(name, agent)| {
        json!({"agentName":name,"agentDeclarationJson":agent.to_string(),"settingsJson":"{}",
            "permissionsJson":json!({"requested":agent["permissions"],"authority":"native-03-at-handoff"}).to_string(),
            "scopeJson":scope.to_string(),"evidenceJson":evidence,"provenanceJson":json!({"sourceSha256":source_sha256,"agent":name}).to_string()})
    }).collect();
    Ok((
        json!({"harness":"codex","version":observed.version,"installation":"available","adapterId":adapter,"qualified":true,"capabilities":capabilities,"models":models,"defaultModel":default}),
        agents,
    ))
}
