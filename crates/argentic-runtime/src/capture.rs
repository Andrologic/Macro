//! Observed Codex registry preparation shared by native hosts.
use crate::persistence::{failure, Result};
use serde_json::{json, Value};
use std::path::Path;

/// Describe only the installed adapter observed through the native profile.
/// This prepares compiler inputs and never authorizes execution.
pub fn codex_registry(
    document: &Value,
    source_sha256: &str,
    scope: &Value,
    observed: &crate::api::CodexObservation,
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
    if !crate::api::qualified_codex_version(&observed.version) || observed.models.is_empty() {
        return Err(failure(
            "CODEX_VERSION_UNQUALIFIED",
            "/agents",
            "Codex observation is outside the qualified version or catalogue",
        ));
    }
    let adapter = crate::agsdl_host_codex::ADAPTER;
    let evidence = json!({"adapterId":adapter,"version":observed.version,"profileDigest":observed.profile.digest,"accountDigest":observed.account_digest,"kind":"native-codex"}).to_string();
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
