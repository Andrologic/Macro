//! Native configuration leases for 0.3 work admission.
//!
//! These leases freeze inputs; they are not an admission, a policy grant, or a
//! provider qualification. The caller must bind them to the authenticated
//! capture and owner before claiming or handing off an effect.
use crate::{
    agsdl_host::HostStartLease,
    agsdl_host_flow030::{FlowWorkAttempt030, NativeFlowInspection030},
    agsdl_host_work::{captured_work_contract030, CapturedWorkPlan030},
    config::{AgsdlHostPermissionsLease, ConfigManager, ExecutionToolsLease},
    db::agsdl_execution::{
        dto::{EngineContext, EngineOwner, EngineWork},
        failure,
        flow030::{FlowEffect030, FlowEffectKind030, FlowIdentity030},
        start030::StartCapture030,
        validate_json, Result,
    },
};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::path::PathBuf;

/// Parsed inputs only. This is not an attestation and cannot authorize work;
/// the writer must authenticate the durable capture, attempt and policy in its
/// admission transaction before deriving a capability from these values.
pub(crate) struct CapturedAgentInputs030 {
    requested: crate::agsdl_permissions::RequestedPermissions,
    contract_json: String,
}

/// Candidate assembled before the attempt exists. The native writer must
/// revalidate every binding against SQL and the subsequently minted attempt;
/// this value is deliberately not an admission or an authority by itself.
pub(crate) struct PreparedAgentWork030 {
    leases: PolicyLeases030,
    identity: FlowIdentity030,
    owner: EngineOwner,
    effect_id: String,
    work: EngineWork,
    agent: String,
    capture_sha256: String,
    registry_json: String,
    agent_harness: String,
    inputs: CapturedAgentInputs030,
}

/// Normalized native inputs prepared outside the admission transaction. This
/// still grants nothing: the writer must authenticate the SQL capture, owner,
/// effect and attempt before it can turn the candidate into an admission.
pub(crate) struct PreparedEffectiveAgentWork030 {
    work: PreparedAgentWork030,
    policy: crate::agsdl_permissions::EffectivePolicy,
}

/// A native adapter must supply the supported controller options before this
/// capability can be constructed. The configuration leases remain owned here
/// until the handoff transaction has either committed or failed.
pub(crate) struct AttestedWorkPolicy030 {
    prepared: PreparedEffectiveAgentWork030,
    options_json: String,
    plan_lock: Option<std::sync::Arc<NativePlanLock030>>,
}

impl AttestedWorkPolicy030 {
    pub(crate) fn from_codex(prepared: PreparedEffectiveAgentWork030) -> Result<Self> {
        let work = &prepared.work;
        let registry: serde_json::Value = serde_json::from_str(&work.registry_json)?;
        validate_codex_registry030(&registry, &work.agent, &work.agent_harness)?;
        codex_read_only030(&prepared.policy)?;
        let contract: serde_json::Value = serde_json::from_str(&work.inputs.contract_json)?;
        for key in ["planFirst"] {
            if !contract.get(key).is_none_or(serde_json::Value::is_null)
                && !(key == "planFirst" && contract[key] == "auto")
            {
                return Err(failure(
                    "HARNESS_CAPABILITY",
                    &format!("/agents/{}/{key}", pointer_token030(&work.agent)),
                    if key == "planFirst" {
                        "agsdl.execution.codexPlanAsk030"
                    } else {
                        "This Codex option is not connected"
                    },
                ));
            }
        }
        if let Some(command) = contract
            .pointer("/completionCheck/command")
            .and_then(serde_json::Value::as_str)
        {
            crate::agsdl_host_completion030::grant(&prepared.policy, command)?;
        }
        Ok(Self { prepared, plan_lock: None, options_json: serde_json::json!({"checkTimeoutMs":"30000","maxCheckOutputBytes":65536,"enforcedPlanLock":false}).to_string() })
    }
}

fn pointer_token030(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

pub(crate) fn validate_codex_registry030(
    registry: &serde_json::Value,
    agent: &str,
    harness: &str,
) -> Result<()> {
    let pointer = format!("/agents/{}/harness", pointer_token030(agent));
    let entries = registry["harnesses"]
        .as_array()
        .ok_or_else(|| failure("HARNESS_REFUSED", &pointer, "Codex observation is absent"))?;
    let matches = entries
        .iter()
        .filter(|entry| entry["harness"] == "codex")
        .collect::<Vec<_>>();
    let observed = matches
        .first()
        .copied()
        .ok_or_else(|| failure("HARNESS_REFUSED", &pointer, "Codex observation is absent"))?;
    if harness != "codex"
        || matches.len() != 1
        || observed["adapterId"] != crate::agsdl_host_codex::ADAPTER
        || observed["installation"] != "available"
        || observed["qualified"] != true
        || !observed["version"]
            .as_str()
            .is_some_and(crate::agsdl_host_codex::qualified_version030)
        || observed["models"].as_array().is_none_or(Vec::is_empty)
        || registry["agents"].as_array().is_none_or(|entries| {
            entries
                .iter()
                .filter(|entry| entry["agentName"] == agent)
                .count()
                != 1
        })
    {
        return Err(failure(
            "HARNESS_REFUSED",
            &pointer,
            "The captured Codex adapter is not qualified",
        ));
    }
    Ok(())
}

pub(crate) fn codex_permissions030(value: &serde_json::Value, pointer: &str) -> Result<()> {
    use crate::agsdl_permissions::{
        Action, Effect, Outside, Preset, RequestedPermissions, Reviewer,
    };
    let parsed = serde_json::from_value::<RequestedPermissions>(value.clone()).map_err(|_| {
        failure(
            "HARNESS_CAPABILITY",
            pointer,
            "Codex permissions are invalid",
        )
    })?;
    if value.get("reviewer").and_then(serde_json::Value::as_str) == Some("model") {
        return Err(failure(
            "HARNESS_CAPABILITY",
            &format!("{pointer}/reviewer"),
            "agsdl.execution.codexReviewer030",
        ));
    }
    let supported = match parsed {
        RequestedPermissions::Preset(Preset::ReadOnly | Preset::Workspace) => true,
        RequestedPermissions::Object(p) => {
            matches!(p.preset, Some(Preset::ReadOnly | Preset::Workspace))
                && p.directories.is_empty()
                && p.outside.is_none_or(|o| o == Outside::Deny)
                && p.reviewer != Some(Reviewer::Model)
                && p.rules.iter().all(|r| {
                    r.action == Action::Write && r.effect == Effect::Ask && r.pattern.is_none()
                })
        }
        _ => false,
    };
    if supported {
        return Ok(());
    }
    if let Some(rules) = value.get("rules").and_then(serde_json::Value::as_array) {
        for (index, rule) in rules.iter().enumerate() {
            if rule["effect"] == "ask" {
                return Err(failure(
                    "HARNESS_CAPABILITY",
                    &format!("{pointer}/rules/{index}/effect"),
                    "agsdl.execution.codexAsk030",
                ));
            }
        }
    }
    if !matches!(value.as_str(), Some("read-only" | "workspace")) {
        return Err(failure(
            "HARNESS_CAPABILITY",
            pointer,
            "agsdl.execution.codexPermissions030",
        ));
    }
    Ok(())
}

/// All ceilings must be expressible by the qualified named native profiles.
/// A restrictive custom rule is refused rather than silently dropped.
pub(crate) fn codex_read_only030(
    policy: &crate::agsdl_permissions::EffectivePolicy,
) -> Result<bool> {
    use crate::agsdl_permissions::{Action, Effect, Outside, Preset, Reviewer};
    let mut read_only = false;
    for ceiling in policy.policies() {
        if !matches!(ceiling.preset(), Some(Preset::ReadOnly | Preset::Workspace))
            || ceiling.rules().iter().any(|r| {
                r.action != Action::Write || r.effect != Effect::Ask || r.pattern.is_some()
            })
            || !ceiling.directories().is_empty()
            || ceiling.reviewer() == Some(Reviewer::Model)
            || ceiling.outside() != Outside::Deny
        {
            return Err(failure(
                "HARNESS_CAPABILITY",
                "/permissions",
                "The effective Codex permission ceiling cannot be represented by this slice",
            ));
        }
        read_only |= ceiling.preset() == Some(Preset::ReadOnly) || !ceiling.rules().is_empty();
    }
    Ok(read_only)
}

/// Shared native preflight/admission restriction. Inline values are payloads,
/// so data containing keys such as uri or timeoutMs is never treated as code.
pub(crate) fn validate_codex_document030(document: &serde_json::Value) -> Result<()> {
    use serde_json::Value;
    let agents = document.get("agents").and_then(Value::as_object);
    if !agents.is_some_and(|agents| agents.values().any(|agent| agent["harness"] == "codex")) {
        return Ok(());
    }
    if let Some(agents) = agents {
        for (name, agent) in agents
            .iter()
            .filter(|(_, agent)| agent["harness"] == "codex")
        {
            let pointer = format!("/agents/{}", pointer_token030(name));
            codex_permissions030(&agent["permissions"], &format!("{pointer}/permissions"))?;
            if agent.get("completionCheck").is_some()
                && !cfg!(all(target_os = "macos", target_arch = "aarch64"))
            {
                return Err(failure(
                    "HARNESS_CAPABILITY",
                    &format!("{pointer}/completionCheck"),
                    "The confined completion-check executor is qualified only on macOS ARM64",
                ));
            }
            if agent.get("completionCheck").is_some()
                && (agent["permissions"] == "read-only"
                    || agent["permissions"]["preset"] == "read-only")
            {
                return Err(failure(
                    "HARNESS_CAPABILITY",
                    &format!("{pointer}/completionCheck"),
                    "Completion checks require shell permission; the read-only preset denies shell",
                ));
            }
            for key in ["planFirst"] {
                if agent.get(key).is_some() && !(key == "planFirst" && agent[key] == "auto") {
                    return Err(failure(
                        "HARNESS_CAPABILITY",
                        &format!("{pointer}/{key}"),
                        if key == "planFirst" {
                            "agsdl.execution.codexPlanAsk030"
                        } else {
                            "This Codex option is not connected"
                        },
                    ));
                }
            }
            for key in ["mcpServers", "harnessSettings"] {
                if agent.get(key).is_some_and(|value| {
                    value.as_array().is_some_and(|v| !v.is_empty())
                        || value.as_object().is_some_and(|v| !v.is_empty())
                }) {
                    return Err(failure(
                        "HARNESS_CAPABILITY",
                        &format!("{pointer}/{key}"),
                        if key == "mcpServers" {
                            "Agent MCP equipment is not qualified for correlated human waits and physical completion in this Codex adapter. Local MCP call steps remain available."
                        } else {
                            "This Codex option is not connected"
                        },
                    ));
                }
            }
            if agent["plan"] == true {
                return Err(failure(
                    "HARNESS_CAPABILITY",
                    &format!("{pointer}/plan"),
                    "Codex plans are not connected",
                ));
            }
        }
    }
    fn visit(value: &Value, pointer: &str) -> Result<()> {
        if let Some(object) = value.as_object() {
            if object.get("uri").is_some_and(Value::is_string)
                && object
                    .keys()
                    .all(|key| matches!(key.as_str(), "uri" | "mediaType"))
            {
                let uri = object["uri"].as_str().unwrap();
                let parsed = url::Url::parse(uri).map_err(|_| {
                    failure(
                        "CONTENT_SOURCE_UNSUPPORTED",
                        &format!("{pointer}/uri"),
                        "Relative content requires a native document origin; this source has none",
                    )
                })?;
                if !crate::agsdl_content::file_helper::qualified_platform()
                    || parsed.scheme() != "file"
                    || parsed.to_file_path().is_err()
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                {
                    return Err(failure("CONTENT_SOURCE_UNSUPPORTED",&format!("{pointer}/uri"),"Only absolute local file content on the qualified macOS ARM64 reader, macOS 14.4 or later, is supported"));
                }
            }
            if (object.contains_key("uri") || object.contains_key("value"))
                && object
                    .keys()
                    .all(|key| matches!(key.as_str(), "uri" | "value" | "mediaType"))
            {
                if let Some(media) = object.get("mediaType").and_then(Value::as_str) {
                    let mime = media
                        .split(';')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase();
                    if !mime.starts_with("text/")
                        && mime != "application/json"
                        && !mime.ends_with("+json")
                    {
                        return Err(failure("CONTENT_SOURCE_UNSUPPORTED",&format!("{pointer}/mediaType"),"This Codex adapter supports text and JSON context; this media type is not represented"));
                    }
                }
            }
            let step = object.get("type").and_then(Value::as_str);
            if matches!(step, Some("compose")) {
                return Err(failure(
                    "HOST_CAPABILITY",
                    &format!("{pointer}/type"),
                    "This flow step is not connected in this slice",
                ));
            }
            for (key, child) in object {
                let segments: Vec<&str> = pointer.split('/').skip(1).collect();
                let agent_definition = segments.len() == 2 && segments[0] == "agents";
                let source_position = segments.len() >= 2
                    && (matches!(segments[segments.len() - 2], "content" | "resources")
                        || segments
                            .last()
                            .is_some_and(|part| part.parse::<usize>().is_ok()));
                let inline_source = source_position
                    && object.contains_key("value")
                    && object
                        .keys()
                        .all(|name| matches!(name.as_str(), "value" | "mediaType"));
                let literal_operand = segments.len() >= 2
                    && segments[segments.len() - 2] == "arguments"
                    && object.len() == 1
                    && object.contains_key("value");
                if (key == "value" && (inline_source || literal_operand))
                    || (agent_definition
                        && ["results", "harnessSettings", "permissions"].contains(&key.as_str()))
                {
                    continue;
                }
                let location = format!("{pointer}/{}", pointer_token030(key));
                visit(child, &location)?;
            }
        } else if let Some(array) = value.as_array() {
            for (index, child) in array.iter().enumerate() {
                visit(child, &format!("{pointer}/{index}"))?;
            }
        }
        Ok(())
    }
    visit(document, "")
}

#[cfg(test)]
impl AttestedWorkPolicy030 {
    /// The QA executor must retain plan_lock() and guard every change, including
    /// shell, MCP, checks and delegation. Completion checks remain unsupported.
    pub(crate) fn from_example(
        prepared: PreparedEffectiveAgentWork030,
        observation: &crate::agsdl_host_example030::ExampleObservation030,
    ) -> Result<Self> {
        let work = &prepared.work;
        let registry: serde_json::Value = serde_json::from_str(&work.registry_json)?;
        let matches = registry
            .get("harnesses")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter(|entry| {
                entry.get("harness").and_then(serde_json::Value::as_str) == Some("example")
                    && entry.get("adapterId").and_then(serde_json::Value::as_str)
                        == Some(observation.adapter_id())
                    && entry.get("version").and_then(serde_json::Value::as_str)
                        == Some(observation.version())
                    && entry
                        .get("installation")
                        .and_then(serde_json::Value::as_str)
                        == Some("available")
                    && entry.get("qualified").and_then(serde_json::Value::as_bool) == Some(true)
            })
            .count();
        let contract: serde_json::Value = serde_json::from_str(&work.inputs.contract_json)?;
        if work.agent_harness != "example"
            || matches != 1
            || contract.get("completionCheck") != Some(&serde_json::Value::Null)
            || !matches!(contract.get("planFirst"), Some(serde_json::Value::Null))
                && contract
                    .get("planFirst")
                    .and_then(serde_json::Value::as_str)
                    != Some("ask")
        {
            return Err(failure(
                "HARNESS_REFUSED",
                "example",
                "Example adapter observation or contract differs",
            ));
        }
        let plan_lock = (contract
            .get("planFirst")
            .and_then(serde_json::Value::as_str)
            == Some("ask"))
        .then(|| std::sync::Arc::new(NativePlanLock030::new(&prepared.work)));
        let enforced = plan_lock.is_some();
        Ok(Self { prepared, plan_lock, options_json: serde_json::json!({"checkTimeoutMs":"1000","maxCheckOutputBytes":1024,"enforcedPlanLock":enforced}).to_string() })
    }
}

/// Reauthenticate a prepared agent against the same SQL transaction which
/// records the owned handoff. No operation is dispatched by this writer.
pub(crate) async fn admit_agent_work_tx(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    attempt: &FlowWorkAttempt030,
    policy: &AttestedWorkPolicy030,
) -> Result<()> {
    let prepared = &policy.prepared.work;
    prepared.verify_attempt(attempt)?;
    lease.ensure_live()?;
    if lease.owner(&attempt.identity().system_start_id)? != *attempt.owner()
        || lease.generation() != attempt.generation()
    {
        return Err(failure("AUTHORITY", "work", "Native owner differs"));
    }
    let id = attempt.identity();
    let row = sqlx::query("SELECT invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256 FROM engine_flow030_owners WHERE system_id=?")
        .bind(&id.system_start_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| failure("AUTHORITY", "work", "Native owner is absent"))?;
    if row.get::<&str, _>("invocation_id") != id.flow_invocation_id
        || row.get::<&str, _>("snapshot_id") != id.snapshot_id
        || row.get::<&str, _>("capture_epoch") != id.epoch
        || row.get::<&str, _>("owner_epoch") != attempt.owner().owner_epoch
        || row.get::<&str, _>("generation") != attempt.generation()
        || row.get::<&str, _>("status") != "live"
        || row.get::<&str, _>("capture_sha256") != prepared.capture_sha256
    {
        return Err(failure("AUTHORITY", "work", "Native owner changed"));
    }
    let raw: String = sqlx::query_scalar(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&id.system_start_id)
    .bind(&id.flow_invocation_id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(|| failure("CORRELATION", "capture", "Native capture is absent"))?;
    let capture: StartCapture030 = serde_json::from_str(&raw)?;
    if capture.identity != *id
        || format!("{:x}", Sha256::digest(serde_json::to_vec(&capture)?)) != prepared.capture_sha256
    {
        return Err(failure("CORRELATION", "capture", "Native capture changed"));
    }
    if prepared.agent_harness == "codex" {
        let document: serde_json::Value = serde_json::from_str(&capture.authored_source)?;
        validate_codex_document030(&document)?;
        validate_codex_registry030(
            &serde_json::from_str(&capture.registry_json)?,
            &prepared.agent,
            &prepared.agent_harness,
        )?;
        codex_read_only030(&policy.prepared.policy)?;
    }
    let current = prepared.leases.captured_agent_inputs(&capture, attempt)?;
    if current.contract_json != prepared.inputs.contract_json
        || serde_json::to_value(&current.requested)?
            != serde_json::to_value(&prepared.inputs.requested)?
    {
        return Err(failure(
            "CORRELATION",
            "policy",
            "Agent policy or contract changed",
        ));
    }
    let run = sqlx::query("SELECT snapshot_id,epoch,plan_json,state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| failure("CORRELATION", "work", "Flow is absent"))?;
    if run.get::<&str, _>("snapshot_id") != id.snapshot_id
        || run.get::<&str, _>("epoch") != id.epoch
        || run.get::<&str, _>("plan_json") != capture.compiled_plan_json
    {
        return Err(failure("CORRELATION", "work", "Flow capture differs"));
    }
    let state: crate::db::agsdl_execution::flow030::FlowState030 =
        serde_json::from_str(run.get("state_json"))?;
    let activation = state
        .activations
        .iter()
        .find(|a| a.id == attempt.work().activation_id)
        .ok_or_else(|| failure("CORRELATION", "work", "Activation is absent"))?;
    if state.identity != *id
        || state.stopping
        || state.verdict.is_some()
        || activation.phase != "running"
        || !activation.physical
        || activation.result.is_some()
        || activation.stop_effect_id.is_some()
        || activation.start_effect_id.as_deref() != Some(attempt.start_effect_id())
        || activation.instance_id != attempt.work().agent_instance_id
        || activation.step != attempt.work().step
        || activation.agent.as_deref() != Some(attempt.agent())
    {
        return Err(failure("CORRELATION", "work", "Activation changed"));
    }
    let outbox = sqlx::query("SELECT effect_json,status,owner_epoch FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(attempt.start_effect_id())
        .fetch_optional(&mut *db).await?.ok_or_else(|| failure("CORRELATION", "work", "Start effect is absent"))?;
    let effect: FlowEffect030 = serde_json::from_str(outbox.get("effect_json"))?;
    let matches_effect = matches!(&effect.kind, FlowEffectKind030::Start { work, step, agent: Some(agent), .. }
        if work.activation_id == attempt.work().activation_id
            && work.start_effect_id == attempt.start_effect_id()
            && work.agent_instance_id == attempt.work().agent_instance_id
            && step == &attempt.work().step && agent == attempt.agent());
    if outbox.get::<&str, _>("status") != "uncertain"
        || outbox.get::<&str, _>("owner_epoch") != attempt.owner().owner_epoch
        || effect.identity != *id
        || effect.id != attempt.start_effect_id()
        || !matches_effect
    {
        return Err(failure("CORRELATION", "work", "Claimed start differs"));
    }
    let raw_handoff: String = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND generation=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(attempt.start_effect_id())
        .bind(&attempt.owner().owner_epoch).bind(attempt.generation()).fetch_optional(&mut *db).await?
        .ok_or_else(|| failure("CORRELATION", "work", "Owned handoff is absent"))?;
    let handoff: serde_json::Value = serde_json::from_str(&raw_handoff)?;
    let expected_request = format!(
        "flow030:{}:{}",
        id.system_start_id,
        attempt.start_effect_id()
    );
    if handoff.get("kind").and_then(serde_json::Value::as_str) != Some("nativeOwnedHandoff030")
        || handoff.get("identity") != Some(&serde_json::to_value(id)?)
        || handoff.get("effectId").and_then(serde_json::Value::as_str)
            != Some(attempt.start_effect_id())
        || handoff
            .get("ownerEpoch")
            .and_then(serde_json::Value::as_str)
            != Some(attempt.owner().owner_epoch.as_str())
        || handoff
            .get("generation")
            .and_then(serde_json::Value::as_str)
            != Some(attempt.generation())
        || handoff.get("requestId").and_then(serde_json::Value::as_str)
            != Some(expected_request.as_str())
        || handoff.get("workAttempt") != Some(&serde_json::to_value(attempt)?)
    {
        return Err(failure("CORRELATION", "work", "Owned handoff differs"));
    }
    let private: serde_json::Value = serde_json::from_str(&capture.private_capture_json)?;
    let permissions = private
        .get("callPermissionsJson")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| failure("CORRELATION", "policy", "Captured permissions are absent"))?;
    let scope = private
        .get("callScopeJson")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| failure("CORRELATION", "scope", "Captured scope is absent"))?;
    validate_json(permissions)?;
    validate_json(scope)?;
    validate_json(&policy.options_json)?;
    let context = EngineContext {
        owner: attempt.owner().clone(),
        work: attempt.work().clone(),
        permissions_json: permissions.into(),
        scope_json: scope.into(),
        registry_version: capture.versions.registry.clone(),
    };
    let evidence = serde_json::json!({"effectivePolicy": &policy.prepared.policy,
        "policyDigest": policy.prepared.policy.fingerprint(), "hostCeilingDigest": prepared.leases.ceiling_fingerprint()});
    lease.ensure_live()?;
    sqlx::query("INSERT INTO engine_flow030_work_admissions(system_id,invocation_id,activation_id,start_effect_id,owner_epoch,generation,capture_sha256,context_json,contract_json,options_json,policy_evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&attempt.work().activation_id)
        .bind(attempt.start_effect_id()).bind(&attempt.owner().owner_epoch).bind(attempt.generation())
        .bind(&prepared.capture_sha256).bind(serde_json::to_string(&context)?)
        .bind(&prepared.inputs.contract_json).bind(&policy.options_json).bind(serde_json::to_string(&evidence)?)
        .execute(&mut *db).await?;
    Ok(())
}

impl PreparedEffectiveAgentWork030 {
    pub(crate) fn work(&self) -> &PreparedAgentWork030 {
        &self.work
    }

    pub(crate) fn policy(&self) -> &crate::agsdl_permissions::EffectivePolicy {
        &self.policy
    }
}

impl PreparedAgentWork030 {
    /// Compare the capability minted at handoff with the inspected pending
    /// effect. The caller must separately authenticate both against SQL.
    pub(crate) fn verify_attempt(&self, attempt: &FlowWorkAttempt030) -> Result<()> {
        if attempt.identity() != &self.identity
            || attempt.owner() != &self.owner
            || attempt.start_effect_id() != self.effect_id
            || attempt.work() != &self.work
            || attempt.agent() != self.agent
        {
            return Err(failure(
                "CORRELATION",
                "work",
                "Native work attempt differs from the prepared effect",
            ));
        }
        Ok(())
    }

    pub(crate) fn leases(&self) -> &PolicyLeases030 {
        &self.leases
    }

    pub(crate) fn identity(&self) -> &FlowIdentity030 {
        &self.identity
    }

    pub(crate) fn owner(&self) -> &EngineOwner {
        &self.owner
    }

    pub(crate) fn effect_id(&self) -> &str {
        &self.effect_id
    }

    pub(crate) fn work(&self) -> &EngineWork {
        &self.work
    }

    pub(crate) fn agent(&self) -> &str {
        &self.agent
    }

    pub(crate) fn capture_sha256(&self) -> &str {
        &self.capture_sha256
    }

    pub(crate) fn inputs(&self) -> &CapturedAgentInputs030 {
        &self.inputs
    }
}

impl CapturedAgentInputs030 {
    pub(crate) fn requested(&self) -> &crate::agsdl_permissions::RequestedPermissions {
        &self.requested
    }

    pub(crate) fn contract_json(&self) -> &str {
        &self.contract_json
    }
}

/// Held only across the short native admission transaction. It cannot be
/// deserialized or cloned, and must be dropped before configuration mutation,
/// human interaction, provider IO, or recursive configuration acquisition.
pub(crate) struct PolicyLeases030 {
    project_id: String,
    ceiling: AgsdlHostPermissionsLease,
    project: ExecutionToolsLease,
}

impl PolicyLeases030 {
    /// The project identity must come from the authenticated source owner.
    /// Acquisition order is global ceiling, then project tools; the caller
    /// acquires the host lifecycle and admission locks only after this returns.
    pub(crate) async fn acquire(manager: &ConfigManager, project_id: &str) -> Result<Self> {
        if project_id.is_empty() || project_id.trim() != project_id {
            return Err(failure(
                "CORRELATION",
                "project",
                "Invalid project identity",
            ));
        }
        let ceiling = manager.lock_agsdl_host_permissions().await.map_err(|_| {
            failure(
                "PERMISSION",
                "policy",
                "Approved host permissions are unavailable",
            )
        })?;
        let project = manager
            .lock_execution_tools(project_id)
            .await
            .map_err(|_| {
                failure(
                    "PERMISSION",
                    "project",
                    "Approved project configuration is unavailable",
                )
            })?;
        Ok(Self {
            project_id: project_id.to_owned(),
            ceiling,
            project,
        })
    }

    pub(crate) fn project_id(&self) -> &str {
        &self.project_id
    }

    pub(crate) fn ceiling(&self) -> &crate::agsdl_permissions::RequestedPermissions {
        self.ceiling.permissions()
    }

    pub(crate) fn ceiling_fingerprint(&self) -> &str {
        self.ceiling.fingerprint()
    }

    pub(crate) fn project_tools(&self) -> &serde_json::Value {
        &self.project.tools
    }

    /// Extract the named agent's authored request and the existing compiler's
    /// work contract. These checks do not authenticate `capture`: the native
    /// admission transaction must still compare it to the durable owner row.
    pub(crate) fn captured_agent_inputs(
        &self,
        capture: &StartCapture030,
        attempt: &FlowWorkAttempt030,
    ) -> Result<CapturedAgentInputs030> {
        if capture.identity != *attempt.identity() {
            return Err(failure(
                "CORRELATION",
                "capture",
                "Agent work differs from the captured source",
            ));
        }
        agent_inputs(capture, attempt.work(), attempt.agent(), &self.project_id)
    }

    /// Bind the candidate to the native snapshot and its pending Start before
    /// `handoff_agent` mints the attempt. No model or IPC value grants access.
    pub(crate) fn prepare_agent_work(
        self,
        inspection: &NativeFlowInspection030,
        effect: &FlowEffect030,
    ) -> Result<PreparedAgentWork030> {
        let capture = &inspection.capture;
        let state = &inspection.flow.state;
        if capture.identity != effect.identity
            || state.identity != capture.identity
            || inspection.owner.system_start_id != capture.identity.system_start_id
            || state.stopping
            || state.verdict.is_some()
        {
            return Err(failure("CORRELATION", "work", "Flow snapshot differs"));
        }
        let FlowEffectKind030::Start {
            work,
            step,
            agent: Some(agent),
            ..
        } = &effect.kind
        else {
            return Err(failure(
                "CORRELATION",
                "work",
                "Effect is not an agent start",
            ));
        };
        if agent.is_empty()
            || work.activation_id.is_empty()
            || work.start_effect_id != effect.id
            || work.agent_instance_id.as_ref().is_none_or(String::is_empty)
        {
            return Err(failure(
                "CORRELATION",
                "work",
                "Agent start identity is incomplete",
            ));
        }
        let activation = state
            .activations
            .iter()
            .find(|a| a.id == work.activation_id)
            .ok_or_else(|| failure("CORRELATION", "work", "Activation is absent"))?;
        if activation.phase != "running"
            || !activation.physical
            || activation.result.is_some()
            || activation.stop_effect_id.is_some()
            || activation.start_effect_id.as_deref() != Some(effect.id.as_str())
            || activation.instance_id != work.agent_instance_id
            || activation.step != *step
            || activation.agent.as_deref() != Some(agent.as_str())
        {
            return Err(failure("CORRELATION", "work", "Agent activation differs"));
        }
        let encoded = serde_json::to_value(effect)?;
        let matching = inspection
            .flow
            .effects
            .iter()
            .filter(|entry| {
                entry.get("status").and_then(serde_json::Value::as_str) == Some("pending")
                    && entry.get("effect") == Some(&encoded)
            })
            .count();
        if matching != 1 {
            return Err(failure(
                "CORRELATION",
                "work",
                "Pending agent start is not unique",
            ));
        }
        let engine_work = EngineWork {
            system_start_id: capture.identity.system_start_id.clone(),
            flow_invocation_id: capture.identity.flow_invocation_id.clone(),
            activation_id: work.activation_id.clone(),
            step: step.clone(),
            agent_instance_id: work.agent_instance_id.clone(),
        };
        let inputs = agent_inputs(capture, &engine_work, agent, &self.project_id)?;
        let capture_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(capture)?));
        let document: serde_json::Value = serde_json::from_str(&capture.authored_source)?;
        let agent_harness = document
            .get("agents")
            .and_then(|v| v.get(agent))
            .and_then(|v| v.get("harness"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| failure("CORRELATION", "agent", "Agent harness is absent"))?
            .to_owned();
        Ok(PreparedAgentWork030 {
            leases: self,
            identity: capture.identity.clone(),
            owner: inspection.owner.clone(),
            effect_id: effect.id.clone(),
            work: engine_work,
            agent: agent.clone(),
            capture_sha256,
            registry_json: capture.registry_json.clone(),
            agent_harness,
            inputs,
        })
    }
}

fn agent_inputs(
    capture: &StartCapture030,
    work: &EngineWork,
    agent: &str,
    project_id: &str,
) -> Result<CapturedAgentInputs030> {
    if capture.source.owner.project_id != project_id
        || format!("{:x}", Sha256::digest(capture.authored_source.as_bytes()))
            != capture.source.source_sha256
    {
        return Err(failure("CORRELATION", "capture", "Agent source differs"));
    }
    validate_json(&capture.authored_source)?;
    let document: serde_json::Value = serde_json::from_str(&capture.authored_source)?;
    if document["agents"][agent]["harness"] == "codex" {
        validate_codex_document030(&document)?;
    }
    let value = document
        .get("agents")
        .and_then(serde_json::Value::as_object)
        .and_then(|agents| agents.get(agent))
        .and_then(|agent| agent.get("permissions"))
        .ok_or_else(|| failure("PERMISSION", "agent", "Agent permissions are missing"))?;
    let requested = serde_json::from_value(value.clone())
        .map_err(|_| failure("PERMISSION", "agent", "Agent permissions are invalid"))?;
    let contract_json = captured_work_contract030(
        &CapturedWorkPlan030 {
            system_start_id: &capture.identity.system_start_id,
            source: &capture.source,
            versions: &capture.versions,
            compiled_plan_json: &capture.compiled_plan_json,
        },
        work,
        agent,
    )?;
    Ok(CapturedAgentInputs030 {
        requested,
        contract_json,
    })
}

/// Resolve and normalize filesystem-dependent policy inputs before acquiring
/// the long-lived admission leases. Reacquiring the exact approved ceiling
/// detects a configuration change during normalization. The result remains a
/// candidate until the handoff transaction revalidates its native bindings.
pub(crate) async fn prepare_effective_agent_work030(
    manager: &ConfigManager,
    inspection: &NativeFlowInspection030,
    effect: &FlowEffect030,
) -> Result<PreparedEffectiveAgentWork030> {
    let capture = &inspection.capture;
    let FlowEffectKind030::Start {
        work,
        step,
        agent: Some(agent),
        ..
    } = &effect.kind
    else {
        return Err(failure(
            "CORRELATION",
            "work",
            "Effect is not an agent start",
        ));
    };
    let native_work = EngineWork {
        system_start_id: capture.identity.system_start_id.clone(),
        flow_invocation_id: capture.identity.flow_invocation_id.clone(),
        activation_id: work.activation_id.clone(),
        step: step.clone(),
        agent_instance_id: work.agent_instance_id.clone(),
    };
    let requested = agent_inputs(
        capture,
        &native_work,
        agent,
        &capture.source.owner.project_id,
    )?;
    let (host_permissions, host_fingerprint) = {
        let ceiling = manager.lock_agsdl_host_permissions().await.map_err(|_| {
            failure(
                "PERMISSION",
                "policy",
                "Approved host permissions are unavailable",
            )
        })?;
        (
            ceiling.permissions().clone(),
            ceiling.fingerprint().to_owned(),
        )
    };

    validate_json(&capture.private_capture_json)?;
    let private: serde_json::Value = serde_json::from_str(&capture.private_capture_json)?;
    if private.get("format").and_then(serde_json::Value::as_str)
        != Some("macro-native-flow-capture/030")
    {
        return Err(failure(
            "CORRELATION",
            "capture",
            "Native capture format differs",
        ));
    }
    let raw_scope = private
        .get("callScopeJson")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| failure("CORRELATION", "scope", "Native project scope is absent"))?;
    validate_json(raw_scope)?;
    let scope: serde_json::Value = serde_json::from_str(raw_scope)?;
    if scope.get("projectId").and_then(serde_json::Value::as_str)
        != Some(capture.source.owner.project_id.as_str())
        || scope.get("sourceOwner") != Some(&serde_json::to_value(&capture.source.owner)?)
    {
        return Err(failure(
            "CORRELATION",
            "scope",
            "Native project owner differs",
        ));
    }
    let root = scope
        .get("root")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| failure("CORRELATION", "scope", "Native project root is absent"))?;
    let expected_root_identity = scope
        .get("rootIdentity")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| failure("CORRELATION", "scope", "Native root identity is absent"))?;
    let root_identity = crate::fs::operations::workspace_root_identity(&root)
        .map_err(|_| failure("SOURCE_UNAVAILABLE", "scope", "Project root is unavailable"))?
        .observation_key()
        .ok_or_else(|| {
            failure(
                "SOURCE_UNAVAILABLE",
                "scope",
                "Project identity is unavailable",
            )
        })?;
    if root_identity != expected_root_identity {
        return Err(failure(
            "CORRELATION",
            "scope",
            "Native project root was replaced",
        ));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| {
            failure(
                "PERMISSION",
                "policy",
                "Native home directory is unavailable",
            )
        })?;
    let context = crate::agsdl_permissions::PathContext {
        workspace: root,
        home,
    };
    let requested_policy = crate::agsdl_permissions::normalize_requested(
        requested.requested().clone(),
        context.clone(),
    )
    .map_err(|_| failure("PERMISSION", "agent", "Agent policy cannot be normalized"))?;
    let host_policy = crate::agsdl_permissions::normalize_requested(host_permissions, context)
        .map_err(|_| failure("PERMISSION", "policy", "Host policy cannot be normalized"))?;
    let policy = crate::agsdl_permissions::EffectivePolicy::new(
        requested_policy,
        host_policy.clone(),
        host_policy,
    );

    let leases = PolicyLeases030::acquire(manager, &capture.source.owner.project_id).await?;
    if leases.ceiling_fingerprint() != host_fingerprint {
        return Err(failure(
            "CORRELATION",
            "policy",
            "Approved host policy changed",
        ));
    }
    let work = leases.prepare_agent_work(inspection, effect)?;
    if serde_json::to_value(work.inputs().requested())?
        != serde_json::to_value(requested.requested())?
    {
        return Err(failure("CORRELATION", "agent", "Agent permissions changed"));
    }
    Ok(PreparedEffectiveAgentWork030 { work, policy })
}

/// Admission evidence is derived from an actual gate, never supplied as a bool.
impl AttestedWorkPolicy030 {
    pub(crate) fn plan_lock(&self) -> Option<std::sync::Arc<NativePlanLock030>> {
        self.plan_lock.clone()
    }
}
#[derive(Debug)]
enum PlanGate030 {
    AwaitingPlan,
    Waiting(String),
    Unlocked,
    Rejected,
}
/// The owned executor retains this gate across its entire work lifetime. Every
/// non-read operation must hold a permit until physical completion, including
/// nested tools. Unknown operations are changes. Policy checks still apply.
pub(crate) struct NativePlanLock030 {
    identity: FlowIdentity030,
    owner: EngineOwner,
    activation_id: String,
    start_effect_id: String,
    state: std::sync::Arc<tokio::sync::RwLock<PlanGate030>>,
}
pub(crate) struct PlanEffectPermit030 {
    _guard: Option<tokio::sync::OwnedRwLockReadGuard<PlanGate030>>,
}
impl NativePlanLock030 {
    fn new(work: &PreparedAgentWork030) -> Self {
        Self {
            identity: work.identity.clone(),
            owner: work.owner.clone(),
            activation_id: work.work.activation_id.clone(),
            start_effect_id: work.effect_id.clone(),
            state: std::sync::Arc::new(tokio::sync::RwLock::new(PlanGate030::AwaitingPlan)),
        }
    }
    fn verify(&self, work: &FlowWorkAttempt030) -> Result<()> {
        if self.identity != *work.identity()
            || self.owner != *work.owner()
            || self.activation_id != work.work().activation_id
            || self.start_effect_id != work.start_effect_id()
        {
            return Err(failure("CORRELATION", "plan", "Plan lock work differs"));
        }
        Ok(())
    }
    pub(crate) async fn authorize(
        &self,
        work: &FlowWorkAttempt030,
        read_only: bool,
    ) -> Result<PlanEffectPermit030> {
        self.verify(work)?;
        let guard = self.state.clone().read_owned().await;
        if matches!(*guard, PlanGate030::Rejected)
            || !read_only && !matches!(*guard, PlanGate030::Unlocked)
        {
            return Err(failure(
                "PERMISSION",
                "plan",
                "Plan lock blocks this effect",
            ));
        }
        // A read may itself wait for a person. It must not keep a shared
        // state guard that blocks presentation or resolution of the plan.
        let guard = if read_only {
            drop(guard);
            None
        } else {
            Some(guard)
        };
        Ok(PlanEffectPermit030 { _guard: guard })
    }
    pub(crate) async fn presented(&self, work: &FlowWorkAttempt030, plan_id: &str) -> Result<()> {
        self.verify(work)?;
        let mut state = self.state.write().await;
        if plan_id.is_empty() || !matches!(*state, PlanGate030::AwaitingPlan) {
            return Err(failure("CORRELATION", "plan", "Plan presentation differs"));
        }
        *state = PlanGate030::Waiting(plan_id.into());
        Ok(())
    }
    pub(crate) async fn resolve(
        &self,
        work: &FlowWorkAttempt030,
        decision: &crate::agsdl_host_human030::ResolvedHumanDecision030,
    ) -> Result<()> {
        self.verify(work)?;
        let mut state = self.state.write().await;
        let PlanGate030::Waiting(plan_id) = &*state else {
            return Err(failure(
                "CORRELATION",
                "plan",
                "No plan is awaiting a decision",
            ));
        };
        if !decision.verifies_plan(work, plan_id) {
            return Err(failure(
                "CORRELATION",
                "plan",
                "Foreign or stale plan decision",
            ));
        }
        let answer = &decision.resolution()["answer"];
        *state = if answer["decision"] == "yes" {
            PlanGate030::Unlocked
        } else if answer["comment"]
            .as_str()
            .is_some_and(|s| !crate::agsdl_host_human030::human_comment_is_empty030(s))
        {
            PlanGate030::AwaitingPlan
        } else {
            PlanGate030::Rejected
        };
        Ok(())
    }
}

#[cfg(test)]
impl NativePlanLock030 {
    pub(crate) fn fixture030(work: &FlowWorkAttempt030) -> Self {
        Self {
            identity: work.identity().clone(),
            owner: work.owner().clone(),
            activation_id: work.work().activation_id.clone(),
            start_effect_id: work.start_effect_id().into(),
            state: std::sync::Arc::new(tokio::sync::RwLock::new(PlanGate030::AwaitingPlan)),
        }
    }
}

#[cfg(test)]
mod codex030_tests {
    use super::*;
    use serde_json::{json, Value};
    fn document() -> Value {
        json!({"agents":{"worker":{"harness":"codex","permissions":"workspace"}},"flow":{"entry":"work","steps":{"work":{"type":"agent","agent":"worker","next":[]}}}})
    }
    #[test]
    fn codex_documents_accept_host_calls_but_keep_unsupported_call_features_closed() {
        let mut doc = document();
        doc["mcpServers"] = json!({"local":{"command":["/bin/sh","server.sh"]}});
        doc["flow"]["steps"]["call"] = json!({"type":"call","command":"true","parse":"json","next":{"passed":[],"failed":"work"}});
        doc["flow"]["steps"]["tool"] = json!({"type":"call","mcp":{"server":"local","tool":"check"},"arguments":{"data":{"value":{"type":"approval","timeoutMs":1,"uri":"literal"}}}});
        assert!(validate_codex_document030(&doc).is_ok());
        doc["flow"]["steps"]["call"]["timeoutMs"] = json!(1);
        assert!(validate_codex_document030(&doc).is_ok());
        doc["flow"]["steps"]["call"]
            .as_object_mut()
            .unwrap()
            .remove("timeoutMs");
        doc["flow"]["steps"]["call"]["next"] = json!({"step":"work","each":["data"]});
        assert!(validate_codex_document030(&doc).is_ok());
    }

    #[test]
    fn preflight_and_admission_share_precise_slice_refusals() {
        let cases = [
            (
                "/agents/worker/planFirst",
                json!("ask"),
                "HARNESS_CAPABILITY",
                "/agents/worker/planFirst",
            ),
            (
                "/agents/worker/permissions",
                json!({"rules":[{"action":"write","effect":"ask"}]}),
                "HARNESS_CAPABILITY",
                "/agents/worker/permissions/rules/0/effect",
            ),
            (
                "/flow/steps/work/type",
                json!("compose"),
                "HOST_CAPABILITY",
                "/flow/steps/work/type",
            ),
        ];
        for (pointer, value, code, location) in cases {
            let mut doc = document();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            doc.pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(key.into(), value);
            let failure = validate_codex_document030(&doc).unwrap_err();
            assert_eq!(failure.code, code, "{pointer}");
            assert_eq!(failure.pointer, location, "{pointer}");
        }
        let mut doc = document();
        doc["content"] = json!({"remote":{"uri":"https://example.invalid/source"}});
        let failure = validate_codex_document030(&doc).unwrap_err();
        assert_eq!(failure.code, "CONTENT_SOURCE_UNSUPPORTED");
        assert_eq!(failure.pointer, "/content/remote/uri");
    }
    #[test]
    fn named_entries_do_not_hide_deadlines_or_external_sources() {
        for name in ["value", "results"] {
            let mut doc = document();
            doc["flow"]["steps"] = json!({name: {"type":"agent", "agent":"worker", "timeoutMs":1}});
            assert!(validate_codex_document030(&doc).is_ok());
            let mut doc = document();
            doc["content"] = json!({name: {"uri":"https://example.invalid/source"}});
            let error = validate_codex_document030(&doc).unwrap_err();
            assert_eq!(error.pointer, format!("/content/{name}/uri"));
            let mut doc = document();
            doc["agents"]["worker"]["resources"] =
                json!({name: {"uri":"https://example.invalid/source"}});
            let error = validate_codex_document030(&doc).unwrap_err();
            assert_eq!(
                error.pointer,
                format!("/agents/worker/resources/{name}/uri")
            );
        }
    }
    #[test]
    fn inline_payloads_and_other_harnesses_are_not_mistaken_for_executable_options() {
        let mut doc = document();
        doc["content"] = json!({"inline":{"value":{"uri":"data","timeoutMs":1,"type":"call"}}});
        doc["content"]["timeoutMs"] = json!({"value":"Ordinary named content"});
        doc["agents"]["worker"]["resources"] = json!({"sample":{"ref":"inline"}});
        assert!(validate_codex_document030(&doc).is_ok());
        doc["agents"]["worker"]["harness"] = json!("example");
        doc["agents"]["worker"]["planFirst"] = json!("ask");
        assert!(validate_codex_document030(&doc).is_ok());
    }
    #[test]
    fn native_profile_respects_the_most_restrictive_supported_ceiling() {
        use crate::agsdl_permissions::{normalize_requested, EffectivePolicy, PathContext};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let context = PathContext {
            workspace: root.clone(),
            home: root,
        };
        let normalize = |value| {
            normalize_requested(serde_json::from_value(value).unwrap(), context.clone()).unwrap()
        };
        let workspace = normalize(json!("workspace"));
        let readonly = normalize(json!("read-only"));
        assert!(!codex_read_only030(&EffectivePolicy::new(
            workspace.clone(),
            workspace.clone(),
            workspace.clone()
        ))
        .unwrap());
        assert!(codex_read_only030(&EffectivePolicy::new(
            workspace.clone(),
            readonly.clone(),
            readonly
        ))
        .unwrap());
        let custom =
            normalize(json!({"preset":"workspace","rules":[{"action":"shell","effect":"deny"}]}));
        assert_eq!(
            codex_read_only030(&EffectivePolicy::new(
                workspace.clone(),
                custom.clone(),
                custom
            ))
            .unwrap_err()
            .code,
            "HARNESS_CAPABILITY"
        );
        assert!(codex_permissions030(
            &json!({"preset":"workspace","rules":[{"action":"network","effect":"ask"}]}),
            "/agsdlHostPermissions"
        )
        .is_err());
    }
}
