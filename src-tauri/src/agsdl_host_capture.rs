//! Canonical, effect-free input capture for the resident compiler.
use crate::agsdl_host::HostState;
use crate::agsdl_host_catalogue::{self, ModelCapture};
use crate::config::ConfigManager;
use crate::db::agsdl_execution::{dto::*, failure, Result};
use crate::db::exact_json;
use crate::workspace::architect::{lock_execution_source_owner, LockedExecutionSource};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPreflightRequest {
    pub owner: EngineSourceOwner,
    pub expected: Option<EngineSourceRevision>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightDiagnostic {
    pub code: String,
    pub pointer: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPreflight {
    pub source: EngineSourceRevision,
    pub authored_source: String,
    pub static_valid: bool,
    pub runtime_supported: bool,
    pub registry_version: String,
    pub diagnostics: Vec<PreflightDiagnostic>,
    pub incomplete: bool,
    pub product_runtime_available: bool,
}

pub(crate) fn metadata_root(workspace: &Path) -> Result<PathBuf> {
    if git2::Repository::open_ext(
        workspace,
        git2::RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&Path>(),
    )
    .is_ok()
    {
        crate::git::find_existing_macro_metadata_worktree_root(workspace).ok_or_else(|| {
            failure(
                "SOURCE_UNAVAILABLE",
                "source",
                "Metadata worktree is unavailable",
            )
        })
    } else {
        let root = workspace.join(".macro");
        if !root.is_dir() {
            return Err(failure(
                "SOURCE_UNAVAILABLE",
                "source",
                "Metadata directory is unavailable",
            ));
        }
        Ok(root)
    }
}

pub(crate) struct CompilationCapture {
    pub source: EngineSourceRevision,
    pub authored_source: String,
    pub native_registry_json: String,
    pub display_cards_json: String,
    pub native_catalogue: ModelCapture,
    pub result: Value,
    pub generation: String,
    pub call_permissions_json: String,
    pub call_scope_json: String,
    permission_notice030: bool,
}

// The 0.2 reader accepts host-specific configuration settings. Keep this
// transport explicit until the document reader supports Agent.permissions.
fn captured_write_permissions(mut native: Value, settings: &Value) -> Result<Value> {
    let rules = settings
        .get("writeRules")
        .cloned()
        .unwrap_or_else(|| json!([]));
    crate::core::tool_policy::validate_agsdl_write_rules(&rules)
        .map_err(|message| failure("UNSUPPORTED", "settings.writeRules", message))?;
    native["writeRules"] = rules;
    Ok(native)
}

#[cfg(test)]
mod write_capture_tests {
    use super::*;
    #[tokio::test]
    async fn fresh_install_and_project_read_only_ceilings_are_announced() {
        use crate::agsdl_permissions::{Preset, RequestedPermissions};
        let temp = tempfile::tempdir().unwrap();
        let config = ConfigManager::initialize(temp.path().join("config"))
            .await
            .unwrap();
        config
            .register_project_root("fresh-project", temp.path().join("metadata"))
            .await
            .unwrap();
        let lease = config.lock_execution_tools("fresh-project").await.unwrap();
        let mut document =
            json!({"agents":{"writer":{"harness":"codex","permissions":"workspace"}}});
        assert!(read_only_ceiling030(
            &document,
            &lease.agsdl_host_permissions,
            &json!({"mode":"Implement","readOnly":false})
        ));
        let workspace = RequestedPermissions::Preset(Preset::Workspace);
        assert!(!read_only_ceiling030(
            &document,
            &workspace,
            &json!({"mode":"Implement","readOnly":false})
        ));
        assert!(read_only_ceiling030(
            &document,
            &workspace,
            &json!({"mode":"Implement","readOnly":true})
        ));
        document["agents"]["writer"]["permissions"] = json!("read-only");
        assert!(!read_only_ceiling030(
            &document,
            &lease.agsdl_host_permissions,
            &json!({"mode":"Implement","readOnly":true})
        ));
    }
    #[test]
    fn captures_write_rules_without_interpreting_or_widening_them() {
        let native = json!({"mode":"Implement","allowedToolIds":["write"],"riskLevel":"balanced"});
        let rules = json!([{"action":"write","match":".env*","effect":"deny"}, {"action":"write","effect":"deny"}]);
        let captured =
            captured_write_permissions(native.clone(), &json!({"writeRules":rules})).unwrap();
        assert_eq!(captured["writeRules"], rules);
        assert_eq!(captured["allowedToolIds"], native["allowedToolIds"]);
        assert_eq!(
            captured_write_permissions(native.clone(), &json!({})).unwrap()["writeRules"],
            json!([])
        );
        for rules in [
            json!(null),
            json!({}),
            json!([{"action":"read","effect":"deny"}]),
            json!([{"action":"write","effect":"ask"}]),
            json!([{"action":"write","effect":"deny","match":false}]),
            json!([{"action":"write","effect":"deny","extra":true}]),
        ] {
            assert!(
                captured_write_permissions(native.clone(), &json!({"writeRules":rules})).is_err()
            );
        }
    }
}

pub(crate) fn project_scope(workspace: &Path, source: &LockedExecutionSource) -> Result<Value> {
    let project = &source.project;
    if crate::project_path::parse_wsl_unc_path(&project.path).is_some() {
        return Err(failure(
            "UNSUPPORTED",
            "source.owner",
            "This project transport is not qualified",
        ));
    }
    let project_path = PathBuf::from(&project.path);
    let root = if project_path.is_absolute() {
        project_path
    } else {
        workspace.join(project_path)
    }
    .canonicalize()
    .map_err(|_| {
        failure(
            "SOURCE_UNAVAILABLE",
            "source.owner",
            "Project root is unavailable",
        )
    })?;
    if !root.is_dir() {
        return Err(failure(
            "SOURCE_UNAVAILABLE",
            "source.owner",
            "Project root is not a directory",
        ));
    }
    let metadata = metadata_root(workspace)?.canonicalize().map_err(|_| {
        failure(
            "SOURCE_UNAVAILABLE",
            "source.owner",
            "Metadata root is unavailable",
        )
    })?;
    if root.starts_with(&metadata) {
        return Err(failure(
            "PERMISSION",
            "source.owner",
            "Project root points into Macro metadata",
        ));
    }

    let root_identity = crate::fs::operations::workspace_root_identity(&root)
        .map_err(|_| {
            failure(
                "SOURCE_UNAVAILABLE",
                "source.owner",
                "Project root identity is unavailable",
            )
        })?
        .observation_key()
        .ok_or_else(|| {
            failure(
                "UNSUPPORTED",
                "source.owner",
                "Project identity cannot be observed",
            )
        })?;
    Ok(
        json!({"projectId":project.id,"root":root,"rootIdentity":root_identity,"sourceOwner":source.revision.owner}),
    )
}
pub(crate) fn execution_scope(
    workspace: &Path,
    source: &LockedExecutionSource,
    task: Option<(&str, &crate::git::GitState)>,
) -> Result<Value> {
    let mut scope = project_scope(workspace, source)?;
    if let Some((task_id, git)) = task {
        let reference = crate::db::agsdl_execution::card_associations::CardAssociation {
            path: String::new(),
            task_id: Some(task_id.into()),
            legacy_node_id: None,
        };
        let (resolved_id, target, root) =
            crate::agsdl_host_tasks::resolve_target(workspace, source, &reference, git)?
                .ok_or_else(|| {
                    failure(
                        "PERMISSION",
                        "associations.taskId",
                        "Task has no current target in the captured source scope",
                    )
                })?;
        let identity = crate::fs::operations::workspace_root_identity(&root)
            .map_err(|_| {
                failure(
                    "SOURCE_UNAVAILABLE",
                    "scope",
                    "Task target identity is unavailable",
                )
            })?
            .observation_key()
            .ok_or_else(|| {
                failure(
                    "UNSUPPORTED",
                    "scope",
                    "Task target identity cannot be observed",
                )
            })?;
        scope["root"] = serde_json::to_value(root)?;
        scope["rootIdentity"] = Value::String(identity);
        scope["taskId"] = Value::String(resolved_id);
        scope["taskTarget"] = serde_json::to_value(target)?;
    }
    Ok(scope)
}

#[cfg(test)]
pub(crate) fn test_codex_observations030() -> &'static std::sync::Mutex<
    std::collections::HashMap<PathBuf, crate::agsdl_host_codex::CodexObservation030>,
> {
    static OBSERVATIONS: std::sync::OnceLock<
        std::sync::Mutex<
            std::collections::HashMap<PathBuf, crate::agsdl_host_codex::CodexObservation030>,
        >,
    > = std::sync::OnceLock::new();
    OBSERVATIONS.get_or_init(Default::default)
}

pub(crate) async fn observation(
    manager: &ConfigManager,
    workspace: &Path,
    source: &LockedExecutionSource,
    catalogue: &ModelCapture,
    tools: &Value,
    host_permissions: &crate::agsdl_permissions::RequestedPermissions,
    task: Option<(&str, &crate::git::GitState)>,
) -> Result<(Value, Option<String>, Option<String>)> {
    let scope = execution_scope(workspace, source, task)?;
    let project = &source.project;
    let document = exact_json::value(&source.source).unwrap_or(Value::Null);
    let is_030 = document.get("contract").and_then(Value::as_str) == Some("agsdl-0.3.0");
    // Report unsupported product features before attempting Codex account discovery.
    if let Some(diagnostic) = product_slice030(&source.source, None) {
        return Err(failure(
            &diagnostic.code,
            &diagnostic.pointer,
            &diagnostic.message,
        ));
    }
    let uses_calls030 = is_030
        && document
            .pointer("/flow/steps")
            .and_then(Value::as_object)
            .is_some_and(|steps| steps.values().any(|step| step["type"] == "call"));
    if uses_calls030 {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err(failure(
                "CALL_PLATFORM_UNQUALIFIED",
                "/flow/steps",
                "Local calls require the qualified macOS ARM64 confinement backend",
            ));
        }
        if !matches!(
            host_permissions,
            crate::agsdl_permissions::RequestedPermissions::Preset(
                crate::agsdl_permissions::Preset::Workspace
            )
        ) || project.user_read_only
            || project.is_read_only
        {
            return Err(failure(
                "CALL_PERMISSIONS_UNSUPPORTED",
                "/flow/steps",
                "Local calls require approved workspace permissions and a writable project",
            ));
        }
    }
    let uses_codex030 = is_030
        && document
            .get("agents")
            .and_then(Value::as_object)
            .is_some_and(|agents| agents.values().any(|agent| agent["harness"] == "codex"));
    let codex030 = if uses_codex030 {
        crate::agsdl_host_work_admission030::validate_codex_document030(&document)?;
        // The caller already owns the project configuration read lease.
        // Use that snapshot rather than acquiring a configuration lock again.
        crate::agsdl_host_work_admission030::codex_permissions030(
            &serde_json::to_value(host_permissions)?,
            "/agsdlHostPermissions",
        )?;
        #[cfg(test)]
        let synthetic = test_codex_observations030()
            .lock()
            .unwrap()
            .get(workspace)
            .cloned();
        #[cfg(not(test))]
        let synthetic: Option<crate::agsdl_host_codex::CodexObservation030> = None;
        let observed = if synthetic.is_some() {
            synthetic
        } else {
            crate::agsdl_host_codex::observe_catalogue030(
                manager,
                &scope,
                project.user_read_only || project.is_read_only,
            )
            .await?
        };
        if observed.is_none() {
            let status = crate::agsdl_host_codex::profile_status(manager).await;
            return Err(failure(
                &status.code,
                "/agents",
                "Codex is not available in Macro's private profile",
            ));
        }
        observed
    } else {
        None
    };
    let has_codex = !is_030
        && document
            .get("bindings")
            .and_then(Value::as_object)
            .is_some_and(|bindings| {
                bindings
                    .values()
                    .any(|binding| binding["implementation"]["identity"] == "openai/codex")
            });
    let codex = if has_codex {
        crate::agsdl_host_codex::observe(
            manager,
            &scope,
            project.user_read_only || project.is_read_only,
        )
        .await?
    } else {
        None
    };
    let has_claude = !is_030
        && document
            .get("bindings")
            .and_then(Value::as_object)
            .is_some_and(|bindings| {
                bindings.values().any(|binding| {
                    binding["implementation"]["identity"] == "anthropic/claude-agent-sdk"
                })
            });
    let claude = if has_claude {
        crate::agsdl_host_claude::observe(manager, &scope).await?
    } else {
        None
    };
    let mut configurations = Vec::new();
    if let Some(agents) = document.get("agents").and_then(Value::as_object) {
        for (name, agent) in agents {
            let Some(configuration) = agent
                .get("configuration")
                .and_then(Value::as_str)
                .and_then(|key| document.get("configurations").and_then(|v| v.get(key)))
            else {
                continue;
            };
            let settings = configuration
                .get("settings")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let Some(settings_object) = settings.as_object() else {
                continue;
            };
            // Only implemented settings are captured, with exact numeric JSON values.
            if settings_object.keys().any(|key| {
                ![
                    "providerId",
                    "modelId",
                    "mode",
                    "maxTurns",
                    "reasoningEffort",
                    "writeRules",
                ]
                .contains(&key.as_str())
            }) {
                continue;
            }
            if settings.get("mode").is_some_and(|value| !value.is_string())
                || settings.get("maxTurns").is_some_and(|value| {
                    value
                        .as_u64()
                        .is_none_or(|turns| turns == 0 || turns > u32::MAX as u64)
                })
                || settings
                    .get("reasoningEffort")
                    .is_some_and(|value| !value.is_null() && !value.is_string())
            {
                continue;
            }
            let mode = match settings.get("mode").and_then(Value::as_str) {
                None | Some("build") | Some("Implement") => "Implement",
                Some("Chat") => "Chat",
                Some("Architect") => "Architect",
                _ => continue,
            };
            let engine = configuration
                .get("engine")
                .and_then(Value::as_str)
                .and_then(|key| {
                    document
                        .get("bindings")
                        .and_then(|bindings| bindings.get(key))
                });
            let captured_permissions = captured_write_permissions(
                crate::agsdl_host_tools::permissions(
                    mode,
                    project.user_read_only || project.is_read_only,
                    tools,
                )?,
                &settings,
            )?;
            let mut settings = settings.clone();
            if engine.is_some_and(|engine| engine["implementation"]["identity"] == "openai/codex") {
                let Some((profile, _, _)) = &codex else {
                    continue;
                };
                if settings.get("maxTurns").is_some() {
                    continue;
                }
                settings["nativeProfileJson"] = json!(profile.attestation(
                    crate::core::tool_policy::agsdl_native_read_only(&captured_permissions),
                    &scope
                )?);
            }
            if engine.is_some_and(|engine| {
                engine["implementation"]["identity"] == "anthropic/claude-agent-sdk"
            }) {
                let Some((profile, _, _)) = &claude else {
                    continue;
                };
                settings["nativeProfileJson"] = json!(profile.attestation(&scope)?);
            }
            configurations.push(json!({
                "agentName": name, "verifiedRequirementsJson": [],
                "effectiveSettingsJson": serde_json::to_string(&settings)?,
                "permissionsJson": serde_json::to_string(&captured_permissions)?,
                "scopeJson": serde_json::to_string(&scope)?
            }));
        }
    }
    let mut models = catalogue.catalogue.models.iter().map(|model| Ok(json!({
        "editionJson":serde_json::to_string(&model.edition)?,"providerId":model.provider_id,"modelId":model.model_id
    }))).collect::<Result<Vec<_>>>()?;
    if let Some((_, ids, _)) = &codex {
        for id in ids {
            models.push(json!({"editionJson":serde_json::to_string(&agsdl_host_catalogue::edition("codex-native",id)?)?, "providerId":"codex-native","modelId":id}));
        }
    }
    if let Some((_, ids, _)) = &claude {
        for id in ids {
            models.push(json!({"editionJson":serde_json::to_string(&agsdl_host_catalogue::edition("claude-native",id)?)?,"providerId":"claude-native","modelId":id}));
        }
    }
    let mut observation = json!({"format":"macro-native-registry-observation/1","models":models,"tools":crate::agsdl_host_tools::observations(),"configurations":configurations,
        "callPermissions":crate::agsdl_host_tools::permissions("Implement", project.user_read_only || project.is_read_only, tools)?,"callScope":scope});
    if is_030 {
        observation["callPermissions"]["agsdlHostPermissions"] =
            serde_json::to_value(host_permissions)?;
    }
    let account = codex030
        .as_ref()
        .map(|observed| observed.account_digest.clone())
        .or_else(|| codex.as_ref().map(|(_, _, account)| account.clone()));
    if let Some(observed) = &codex030 {
        observation["codexProfileJson"] = json!(observed.profile.identity());
    }
    if let Some((profile, _, _)) = codex {
        observation["codexProfileJson"] = json!(profile.identity())
    }
    let claude_account = claude.as_ref().map(|(_, _, account)| account.clone());
    if let Some((profile, _, _)) = claude {
        observation["claudeProfileJson"] = json!(profile.identity());
    }
    let version_bytes = if claude_account.is_some() {
        serde_json::to_vec(&(
            &observation,
            &catalogue.providers,
            &account,
            &claude_account,
        ))?
    } else {
        serde_json::to_vec(&(&observation, &catalogue.providers, &account))?
    };
    let version = format!("sha256:{:x}", Sha256::digest(version_bytes));
    observation["version"] = Value::String(version);
    if is_030 {
        let (mut harnesses, agents) = match &codex030 {
            Some(observed) => {
                let (harness, agents) =
                    codex_registry030(&document, &source.revision.source_sha256, &scope, observed)?;
                (vec![harness], agents)
            }
            None => (Vec::new(), Vec::new()),
        };
        for name in ["opencode", "pi"] {
            let used = document
                .get("agents")
                .and_then(Value::as_object)
                .is_some_and(|agents| {
                    agents
                        .values()
                        .any(|agent| agent.get("harness").and_then(Value::as_str) == Some(name))
                });
            if used {
                if let Some(observation) = crate::agsdl_host_harness030::observe(name).await {
                    harnesses.push(observation);
                }
            }
        }
        // Modules describe the language; the native Codex observation supplies
        // the separate installed version, model catalogue and qualified slice.
        let mut registry = json!({
            "format":"macro-agsdl-registry/030",
            "modules":[
                {"harness":"codex", "moduleJson":include_str!("../../src/vendor/agsdl/v0.3/harnesses/codex/module.json")},
                {"harness":"claude-code", "moduleJson":include_str!("../../src/vendor/agsdl/v0.3/harnesses/claude-code/module.json")},
                {"harness":"opencode", "moduleJson":include_str!("../../src/vendor/agsdl/v0.3/harnesses/opencode/module.json")},
                {"harness":"pi", "moduleJson":include_str!("../../src/vendor/agsdl/v0.3/harnesses/pi/module.json")}
            ],
            "harnesses":harnesses, "agents":agents, "hostCapabilities": if cfg!(all(target_os="macos", target_arch="aarch64")) {
                json!([{"name":"approval","support":"native","evidenceJson":"{\"runtime\":\"flow-human-clock\"}"},{"name":"call.command","support":"native","evidenceJson":"{\"transport\":\"confined-local\"}"},{"name":"call.mcp","support":"native","evidenceJson":"{\"transport\":\"confined-stdio\"}"}])
            } else { json!([]) }
        });
        let digest = Sha256::digest(serde_json::to_vec(&(&observation, &registry))?);
        registry["version"] = json!(format!("sha256:{digest:x}"));
        // These are transport-only inputs, not part of the captured registry.
        registry["callPermissions"] = observation["callPermissions"].clone();
        registry["callScope"] = observation["callScope"].clone();
        return Ok((registry, account, claude_account));
    }
    Ok((observation, account, claude_account))
}

fn read_only_ceiling030(
    document: &Value,
    host_permissions: &crate::agsdl_permissions::RequestedPermissions,
    call_permissions: &Value,
) -> bool {
    use crate::agsdl_permissions::{Preset, RequestedPermissions};
    document
        .get("agents")
        .and_then(Value::as_object)
        .is_some_and(|agents| {
            agents
                .values()
                .any(|agent| agent["harness"] == "codex" && agent["permissions"] == "workspace")
        })
        && (matches!(
            host_permissions,
            RequestedPermissions::Preset(Preset::ReadOnly)
        ) || crate::core::tool_policy::agsdl_native_read_only(call_permissions))
}

/// Transport of a native app-server observation. It adds no provider work and
/// uses the same private profile qualification as the existing native adapter.
pub(crate) fn codex_registry030(
    document: &Value,
    source_sha256: &str,
    scope: &Value,
    observed: &crate::agsdl_host_codex::CodexObservation030,
) -> Result<(Value, Vec<Value>)> {
    crate::agsdl_host_work_admission030::validate_codex_document030(document)?;
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
    let capabilities = ["result-submission", "continuity", "permission-enforcement", "contained-stop", "response-attribution", "instructions", "resources", "model.name", "model.effort", "instance.new", "delivery.queue", "delivery.steer", "answer-timeout"]
        .into_iter().map(|name| json!({"name":name,"support":if name == "resources" {"approximate"} else {"native"},"evidenceJson":evidence})).collect::<Vec<_>>();
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

pub(crate) async fn compile(
    host: &HostState,
    manager: &ConfigManager,
    pool: &sqlx::SqlitePool,
    workspace: &Path,
    request: &ExecutionPreflightRequest,
) -> Result<CompilationCapture> {
    compile_input(host, manager, pool, workspace, request, None, None).await
}

pub(crate) async fn compile_input(
    host: &HostState,
    manager: &ConfigManager,
    pool: &sqlx::SqlitePool,
    workspace: &Path,
    request: &ExecutionPreflightRequest,
    start_entry: Option<Option<&EngineEntry>>,
    task: Option<(&str, &crate::git::GitState)>,
) -> Result<CompilationCapture> {
    let metadata = metadata_root(workspace)?;
    let locked = lock_execution_source_owner(
        workspace,
        &metadata,
        &request.owner,
        request.expected.as_ref(),
    )
    .await?;
    let mut native_catalogue = agsdl_host_catalogue::capture(manager, pool).await?;
    let policy = manager
        .lock_execution_tools(&locked.revision.owner.project_id)
        .await
        .map_err(|_| failure("PERMISSION", "policy", "Project tool policy is unavailable"))?;
    let (mut registry, account, claude_account) = observation(
        manager,
        workspace,
        &locked,
        &native_catalogue,
        &policy.tools,
        &policy.agsdl_host_permissions,
        task,
    )
    .await?;
    native_catalogue.codex_account_digest = account;
    native_catalogue.claude_account_digest = claude_account;
    let call_permissions_json = serde_json::to_string(&registry["callPermissions"])?;
    let call_scope_json = serde_json::to_string(&registry["callScope"])?;
    let permission_notice030 = read_only_ceiling030(
        &exact_json::value(&locked.source).unwrap_or(Value::Null),
        &policy.agsdl_host_permissions,
        &registry["callPermissions"],
    );
    if let Some(entry) = start_entry {
        registry["startEntry"] = serde_json::to_value(entry)?;
    }
    let source = locked.revision.clone();
    let authored_source = locked.source.clone();
    let display_cards_json = locked.display_cards_json.clone();
    let registry_json = serde_json::to_string(&registry)?;
    drop(policy);
    drop(locked);
    let receipt = host
        .compile(
            source.clone(),
            authored_source.clone(),
            registry_json.clone(),
        )
        .await?;
    Ok(CompilationCapture {
        source,
        authored_source,
        native_registry_json: registry_json,
        display_cards_json,
        native_catalogue,
        result: serde_json::from_str(&receipt.result_json)?,
        generation: receipt.generation,
        call_permissions_json,
        call_scope_json,
        permission_notice030,
    })
}

/// Correlated material for 09 to turn into StartCapture030 after it creates
/// native identity, private capture and authorization. No field is a grant.
pub(crate) struct StartCaptureMaterial030 {
    pub source: EngineSourceRevision,
    pub versions: EngineVersions,
    pub authored_source: String,
    pub compiled_plan_json: String,
    pub registry_json: String,
    pub native_catalogue_json: String,
    pub call_permissions_json: String,
    pub call_scope_json: String,
    pub display_cards_json: String,
    pub entry_unassessed: Vec<String>,
    pub generation: String,
}

pub(crate) fn product_slice030(
    authored: &str,
    compiled: Option<&str>,
) -> Option<PreflightDiagnostic> {
    let document = exact_json::value(authored).ok()?;
    if document.get("contract").and_then(Value::as_str) != Some("agsdl-0.3.0") {
        return None;
    }
    let issue = |pointer: String, message: &str| {
        Some(PreflightDiagnostic {
            code: "UNSUPPORTED_030_FEATURE".into(),
            pointer,
            message: message.into(),
        })
    };
    for field in ["skills"] {
        if document.get(field).is_some() {
            return issue(
                format!("/{field}"),
                "This document feature is not yet supported.",
            );
        }
    }
    for (name, server) in document
        .get("mcpServers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if server.get("url").is_some() {
            return issue(format!("/mcpServers/{name}/url"), "Remote MCP calls are not supported because their physical cancellation cannot be confirmed. Use a local stdio server.");
        }
    }
    for (name, agent) in document.get("agents")?.as_object()? {
        let pointer = format!("/agents/{}", name.replace('~', "~0").replace('/', "~1"));
        if agent.get("harness").and_then(Value::as_str) != Some("codex") {
            return issue(
                format!("{pointer}/harness"),
                "Only the Codex harness is supported for this run.",
            );
        }
        for field in ["completionCheck", "skills", "mcpServers"] {
            if agent.get(field).is_some() {
                return issue(
                    format!("{pointer}/{field}"),
                    "This agent feature is not yet supported.",
                );
            }
        }
        if agent.pointer("/permissions/reviewer").is_some()
            || agent
                .pointer("/permissions/rules")
                .and_then(Value::as_array)
                .is_some_and(|rules| {
                    rules
                        .iter()
                        .any(|rule| rule.get("effect").and_then(Value::as_str) == Some("ask"))
                })
        {
            return issue(
                format!("{pointer}/permissions"),
                "Human approval is not yet supported.",
            );
        }
        if agent.get("planFirst").and_then(Value::as_str) == Some("ask") {
            return issue(
                format!("{pointer}/planFirst"),
                "Human approval is not yet supported.",
            );
        }
    }
    for (name, step) in document
        .pointer("/flow/steps")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let pointer = format!("/flow/steps/{}", name.replace('~', "~0").replace('/', "~1"));
        if !matches!(
            step.get("type").and_then(Value::as_str),
            Some("agent" | "call" | "approval")
        ) {
            return issue(
                pointer,
                "Only agent, call and approval steps are supported for this run.",
            );
        }
    }
    let plan = exact_json::value(compiled?).ok()?;
    for step in plan.get("steps")?.as_array()? {
        let pointer = format!(
            "/flow/steps/{}",
            step.get("address")?
                .as_array()?
                .last()?
                .as_str()?
                .replace('~', "~0")
                .replace('/', "~1")
        );
        if !matches!(
            step.get("type").and_then(Value::as_str),
            Some("agent" | "call" | "approval")
        ) {
            return issue(
                pointer,
                "Only agent, call and approval steps are supported for this run.",
            );
        }
    }
    for route in plan.get("routes")?.as_array()? {
        let targets = route.get("targets")?.as_array()?;
        if targets.len() > 1
            || targets.iter().any(|target| {
                !target.get("eachPathJson").is_none_or(Value::is_null)
                    || !target.get("concurrencyJson").is_none_or(Value::is_null)
                    || !target.get("maxJson").is_none_or(Value::is_null)
            })
        {
            return issue(
                "/flow".into(),
                "Parallel routes and fan-out are not yet supported.",
            );
        }
    }
    None
}

impl CompilationCapture {
    /// Called only under the fresh metadata lock.
    /// This prepares data; the host still authenticates content and authority.
    pub(crate) fn start_material030(
        &self,
        locked: &LockedExecutionSource,
        request: &EngineStartRequest,
        generation: &str,
    ) -> Result<StartCaptureMaterial030> {
        self.start_material030_checked(
            &locked.revision,
            &locked.source,
            &locked.display_cards_json,
            request,
            generation,
        )
    }

    fn start_material030_checked(
        &self,
        locked_revision: &EngineSourceRevision,
        locked_source: &str,
        locked_cards: &str,
        request: &EngineStartRequest,
        generation: &str,
    ) -> Result<StartCaptureMaterial030> {
        let refuse = || {
            failure(
                "CORRELATION",
                "capture",
                "Start 0.3 capture is not correlated",
            )
        };
        if generation.is_empty()
            || self.generation != generation
            || request.profile != "macro-agsdl-030-v1"
            || request.source != self.source
            || locked_revision != &self.source
            || locked_source != self.authored_source
            || locked_cards != self.display_cards_json
            || format!("{:x}", Sha256::digest(self.authored_source.as_bytes()))
                != self.source.source_sha256
            || self
                .result
                .pointer("/static/valid")
                .and_then(Value::as_bool)
                != Some(true)
            || self
                .result
                .pointer("/runtime/supported")
                .and_then(Value::as_bool)
                != Some(true)
            || self
                .result
                .pointer("/runtime/profile")
                .and_then(Value::as_str)
                != Some("macro-agsdl-030-v1")
            || self.result.pointer("/runtime/source") != Some(&serde_json::to_value(&self.source)?)
        {
            return Err(refuse());
        }
        let mut ticket = exact_json::value(&self.native_registry_json)?;
        let expected_entry = serde_json::to_value(&request.entry)?;
        if ticket.get("startEntry") != Some(&expected_entry)
            || self.result.pointer("/entryValidation/messageJson")
                != Some(expected_entry.get("messageJson").unwrap_or(&Value::Null))
            || self
                .result
                .pointer("/entryValidation/shapeValid")
                .and_then(Value::as_bool)
                != Some(true)
        {
            return Err(refuse());
        }
        for (field, captured) in [
            ("callPermissions", &self.call_permissions_json),
            ("callScope", &self.call_scope_json),
        ] {
            let observed = ticket.get(field).ok_or_else(refuse)?.to_string();
            if !crate::db::agsdl_execution::json_lexemes030::document_tokens_equal(
                &observed, captured,
            )? {
                return Err(refuse());
            }
        }
        let unassessed = self
            .result
            .pointer("/entryValidation/unassessed")
            .and_then(Value::as_array)
            .ok_or_else(refuse)?
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or_else(refuse))
            .collect::<Result<Vec<_>>>()?;
        let entry_valid = self
            .result
            .pointer("/entryValidation/valid")
            .and_then(Value::as_bool)
            .ok_or_else(refuse)?;
        if entry_valid != unassessed.is_empty()
            || unassessed.iter().any(|item| item.trim().is_empty())
        {
            return Err(refuse());
        }
        for field in [
            "startEntry",
            "deliveryInput",
            "callInput",
            "toolPolicyInput",
            "callPermissions",
            "callScope",
        ] {
            ticket.as_object_mut().ok_or_else(refuse)?.remove(field);
        }
        let registry_json = self
            .result
            .get("capturedRegistryJson")
            .and_then(Value::as_str)
            .ok_or_else(refuse)?;
        if !crate::db::agsdl_execution::json_lexemes030::document_tokens_equal(
            registry_json,
            &ticket.to_string(),
        )? {
            return Err(refuse());
        }
        let registry = exact_json::value(registry_json)?;
        let plan_json = self
            .result
            .get("compiledPlanJson")
            .and_then(Value::as_str)
            .ok_or_else(refuse)?;
        let plan = exact_json::value(plan_json)?;
        let versions: EngineVersions =
            serde_json::from_value(plan.get("versions").cloned().ok_or_else(refuse)?)?;
        let document = plan
            .get("documentJson")
            .and_then(Value::as_str)
            .ok_or_else(refuse)?;
        let authored = exact_json::value(&self.authored_source)?;
        if registry.get("format").and_then(Value::as_str) != Some("macro-agsdl-registry/030")
            || registry.get("version").and_then(Value::as_str) != Some(versions.registry.as_str())
            || self
                .result
                .pointer("/runtime/registryVersion")
                .and_then(Value::as_str)
                != Some(versions.registry.as_str())
            || plan.get("format").and_then(Value::as_str) != Some("macro-agsdl-compiled-plan/2")
            || versions.snapshot != "2"
            || versions.contract != "agsdl-0.3.0"
            || versions.profile != request.profile
            || authored.get("contract").and_then(Value::as_str) != Some("agsdl-0.3.0")
            || plan
                .get("entry")
                .is_none_or(|entry| entry.is_null() != request.entry.is_none())
            || plan.get("source") != Some(&serde_json::to_value(&self.source)?)
            || !crate::db::agsdl_execution::json_lexemes030::document_tokens_equal(
                document,
                &self.authored_source,
            )?
        {
            return Err(refuse());
        }
        if let Some(diagnostic) = product_slice030(&self.authored_source, Some(plan_json)) {
            return Err(failure(
                &diagnostic.code,
                &diagnostic.pointer,
                &diagnostic.message,
            ));
        }
        Ok(StartCaptureMaterial030 {
            source: self.source.clone(),
            versions,
            authored_source: self.authored_source.clone(),
            compiled_plan_json: plan_json.to_owned(),
            registry_json: registry_json.to_owned(),
            native_catalogue_json: serde_json::to_string(&self.native_catalogue)?,
            call_permissions_json: self.call_permissions_json.clone(),
            call_scope_json: self.call_scope_json.clone(),
            display_cards_json: self.display_cards_json.clone(),
            entry_unassessed: unassessed,
            generation: self.generation.clone(),
        })
    }
}

/// Use only the native observation retained before crossing the compiler host.
/// A module declares version coverage; it never proves installation or a grant.
fn local_harness_diagnostics030(authored: &str, registry_json: &str) -> Vec<PreflightDiagnostic> {
    let Ok(document) = exact_json::value(authored) else {
        return vec![];
    };
    let Ok(registry) = exact_json::value(registry_json) else {
        return vec![];
    };
    if document.get("contract").and_then(Value::as_str) != Some("agsdl-0.3.0") {
        return vec![];
    }
    let Some(agents) = document.get("agents").and_then(Value::as_object) else {
        return vec![];
    };
    agents
        .iter()
        .filter_map(|(agent_name, agent)| {
            let name = agent.get("harness").and_then(Value::as_str)?;
            if !matches!(name, "opencode" | "pi") {
                return None;
            }
            let observed = registry
                .get("harnesses")
                .and_then(Value::as_array)
                .and_then(|entries| {
                    entries
                        .iter()
                        .find(|entry| entry.get("harness").and_then(Value::as_str) == Some(name))
                });
            let (code, message) = match observed {
                None => (
                    "HARNESS_INSTALLATION_UNASSESSED",
                    "The local harness installation could not be assessed.",
                ),
                Some(entry)
                    if entry.get("installation").and_then(Value::as_str) == Some("missing") =>
                {
                    (
                        "HARNESS_NOT_INSTALLED",
                        "The named harness executable was not found in PATH.",
                    )
                }
                Some(entry) => {
                    let version = entry
                        .get("version")
                        .and_then(Value::as_str)
                        .and_then(|s| semver::Version::parse(s).ok());
                    let requirement = registry
                        .get("modules")
                        .and_then(Value::as_array)
                        .and_then(|modules| {
                            modules.iter().find(|module| {
                                module.get("harness").and_then(Value::as_str) == Some(name)
                            })
                        })
                        .and_then(|module| module.get("moduleJson").and_then(Value::as_str))
                        .and_then(|module| exact_json::value(module).ok())
                        .and_then(|module| {
                            module
                                .get("harnessVersions")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .and_then(|range| {
                            semver::VersionReq::parse(
                                &range.replace(" <", ", <").replace(" >", ", >"),
                            )
                            .ok()
                        });
                    match (version, requirement) {
                        (Some(version), Some(range)) if !range.matches(&version) => (
                            "HARNESS_VERSION_UNSUPPORTED",
                            "The installed harness version is outside the bundled module range.",
                        ),
                        (Some(_), Some(_)) => (
                            "HARNESS_ADAPTER_UNAVAILABLE",
                            "No qualified native adapter is registered for this harness.",
                        ),
                        _ => (
                            "HARNESS_VERSION_UNASSESSED",
                            "The harness version or its supported range could not be assessed.",
                        ),
                    }
                }
            };
            Some(PreflightDiagnostic {
                code: code.into(),
                pointer: format!(
                    "/agents/{}/harness",
                    agent_name.replace('~', "~0").replace('/', "~1")
                ),
                message: message.into(),
            })
        })
        .collect()
}

impl CompilationCapture {
    pub(crate) fn public(&self) -> ExecutionPreflight {
        let findings: Vec<_> = ["/static/diagnostics", "/runtime/diagnostics"]
            .into_iter()
            .flat_map(|path| {
                self.result
                    .pointer(path)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .collect();
        let diagnostics: Vec<PreflightDiagnostic> = findings
            .iter()
            .take(64)
            .map(|finding| {
                let code = finding
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("UNSUPPORTED");
                let code = if [
                    "PARSE",
                    "SCHEMA",
                    "REFERENCE",
                    "UNSUPPORTED",
                    "CORRELATION",
                    "INPUT_CONSTRAINT",
                ]
                .contains(&code)
                {
                    code
                } else {
                    "UNSUPPORTED"
                };
                PreflightDiagnostic {
                    code: code.into(),
                    pointer: finding
                        .get("pointer")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .take(2048)
                        .collect(),
                    message: if self
                        .result
                        .pointer("/runtime/profile")
                        .and_then(Value::as_str)
                        == Some("macro-agsdl-030-v1")
                        && finding.get("message").and_then(Value::as_str)
                            == Some("No native observation matches the complete agent declaration.")
                    {
                        "No qualified native 0.3 agent capture is available.".into()
                    } else if self
                        .result
                        .pointer("/runtime/profile")
                        .and_then(Value::as_str)
                        == Some("macro-agsdl-030-v1")
                    {
                        "AgSDL 0.3 validation or native qualification failed.".into()
                    } else {
                        "The captured document cannot execute in the native inline profile.".into()
                    },
                }
            })
            .collect();
        let mut native_diagnostics =
            local_harness_diagnostics030(&self.authored_source, &self.native_registry_json);
        if self.permission_notice030 {
            native_diagnostics.push(PreflightDiagnostic {
                code: "READ_ONLY_CEILING".into(),
                pointer: "/agsdlHostPermissions".into(),
                message: "Host or project settings limit this run to read-only access, including agents requesting workspace writes.".into(),
            });
        }
        let product_diagnostic = product_slice030(
            &self.authored_source,
            self.result.get("compiledPlanJson").and_then(Value::as_str),
        );
        let product_supported = product_diagnostic.is_none();
        native_diagnostics.extend(product_diagnostic);
        let incomplete = findings.len().saturating_add(native_diagnostics.len()) > 64;
        let mut combined: Vec<_> = native_diagnostics.into_iter().take(64).collect();
        let remaining = 64usize.saturating_sub(combined.len());
        combined.extend(diagnostics.into_iter().take(remaining));
        let diagnostics = combined;
        ExecutionPreflight {
            source: self.source.clone(),
            authored_source: self.authored_source.clone(),
            static_valid: self
                .result
                .pointer("/static/valid")
                .and_then(Value::as_bool)
                == Some(true),
            runtime_supported: self
                .result
                .pointer("/runtime/supported")
                .and_then(Value::as_bool)
                == Some(true)
                && product_supported,
            registry_version: self
                .result
                .pointer("/runtime/registryVersion")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            diagnostics,
            incomplete,
            product_runtime_available: self
                .result
                .get("productRuntimeAvailable")
                .and_then(Value::as_bool)
                == Some(true),
        }
    }
}

struct StartAuthority<'a> {
    host: &'a HostState,
    lease: &'a crate::agsdl_host::HostStartLease,
    manager: &'a ConfigManager,
    pool: &'a sqlx::SqlitePool,
    workspace: &'a Path,
    git: &'a crate::git::GitState,
    captured: std::sync::Mutex<Option<(String, String, String, String)>>,
    intent_scope: Option<&'a crate::db::agsdl_execution::intents::ExecutionIntentScope>,
}

struct StartCommitGuard {
    _source: LockedExecutionSource,
    _policy: crate::config::ExecutionToolsLease,
}
impl crate::db::agsdl_execution::CaptureAuthority for StartAuthority<'_> {
    type CommitGuard = StartCommitGuard;
    async fn capture(
        &self,
        request: &EngineStartRequest,
        system_id: &str,
    ) -> Result<crate::db::agsdl_execution::TrustedCapture> {
        use crate::db::agsdl_execution::{
            capture::{CallScope, PrivateCapture},
            StepPolicy, TrustedCapture,
        };
        if request.profile != "macro-serial-inline-v1"
            || request.associations.workspace_id.is_some()
            || request.associations.conversation_id.is_some()
        {
            return Err(failure(
                "UNSUPPORTED",
                "associations",
                "Execution association is not qualified",
            ));
        }
        self.lease.ensure_live()?;
        let captured = compile_input(
            self.host,
            self.manager,
            self.pool,
            self.workspace,
            &ExecutionPreflightRequest {
                owner: request.source.owner.clone(),
                expected: Some(request.source.clone()),
            },
            Some(request.entry.as_ref()),
            request
                .associations
                .task_id
                .as_deref()
                .map(|id| (id, self.git)),
        )
        .await?;
        if captured.generation != self.lease.generation()
            || !captured.public().runtime_supported
            || (captured
                .result
                .pointer("/runtime/profile")
                .and_then(Value::as_str)
                == Some("macro-agsdl-030-v1")
                && !captured.public().product_runtime_available)
            || captured
                .result
                .pointer("/entryValidation/valid")
                .and_then(Value::as_bool)
                != Some(true)
        {
            return Err(failure(
                "UNSUPPORTED",
                "source",
                "Captured execution or entry is not supported",
            ));
        }
        let compiled_plan_json = captured
            .result
            .get("compiledPlanJson")
            .and_then(Value::as_str)
            .ok_or_else(|| failure("CORRELATION", "compiler", "Compiled plan is absent"))?
            .to_owned();
        let plan = exact_json::value(&compiled_plan_json)?;
        let registry_json = captured
            .result
            .get("capturedRegistryJson")
            .and_then(Value::as_str)
            .ok_or_else(|| failure("CORRELATION", "registry", "Captured registry is absent"))?
            .to_owned();
        let agents: Vec<EngineAgentConfiguration> =
            serde_json::from_value(plan.get("agents").cloned().unwrap_or(Value::Null))?;
        let versions: EngineVersions =
            serde_json::from_value(plan.get("versions").cloned().unwrap_or(Value::Null))?;
        let entry_step: Option<Vec<String>> =
            serde_json::from_value(plan.get("entry").cloned().unwrap_or(Value::Null))?;
        let steps = plan
            .get("steps")
            .and_then(Value::as_array)
            .ok_or_else(|| failure("CORRELATION", "compiler", "Compiled steps are absent"))?;
        let mut policies = Vec::new();
        let mut call_scopes: Vec<CallScope> = Vec::new();
        for step in steps {
            let declaration = exact_json::value(
                step.get("declarationJson")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        failure("CORRELATION", "compiler", "Step declaration is absent")
                    })?,
            )?;
            let max_visits = step
                .get("maxVisitsJson")
                .and_then(Value::as_str)
                .map(|token| {
                    crate::db::exact_json::positive_integer(token).ok_or_else(|| {
                        failure(
                            "UNSUPPORTED",
                            "maxVisits",
                            "Visit limit exceeds native counter bounds",
                        )
                    })
                })
                .transpose()?;
            if declaration.get("type").and_then(Value::as_str) == Some("call") {
                call_scopes.push(CallScope {
                    step: serde_json::from_value(
                        step.get("address").cloned().unwrap_or(Value::Null),
                    )?,
                    permissions_json: captured.call_permissions_json.clone(),
                    scope_json: captured.call_scope_json.clone(),
                });
            }
            policies.push(StepPolicy {
                step: serde_json::from_value(step.get("address").cloned().unwrap_or(Value::Null))?,
                agent_name: if declaration.get("type").and_then(Value::as_str) == Some("agent") {
                    Some(
                        declaration
                            .get("agent")
                            .and_then(Value::as_str)
                            .ok_or_else(|| failure("CORRELATION", "agent", "Agent is absent"))?
                            .into(),
                    )
                } else {
                    None
                },
                max_visits,
            });
        }
        let card_associations = crate::db::agsdl_execution::card_associations::capture(
            &captured.authored_source,
            &captured.display_cards_json,
        )?;
        let native_catalogue_json = serde_json::to_string(&captured.native_catalogue)?;
        *self
            .captured
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Capture state unavailable"))? =
            Some((
                system_id.into(),
                native_catalogue_json.clone(),
                captured.display_cards_json,
                versions.registry.clone(),
            ));
        Ok(TrustedCapture {
            snapshot: EngineSnapshot {
                system_start_id: system_id.into(),
                source: captured.source,
                authored_source: captured.authored_source,
                versions,
                agents,
                compiled_plan_json,
                associations: request.associations.clone(),
            },
            private: PrivateCapture {
                registry_json,
                native_catalogue_json,
                card_associations,
                implementation_digest: "macro-native-host/1".into(),
                call_scopes,
            },
            policies,
            entry_step,
        })
    }
    async fn recheck(&self, request: &EngineStartRequest) -> Result<Self::CommitGuard> {
        self.lease.ensure_live()?;
        let metadata = metadata_root(self.workspace)?;
        let locked = if let Some(scope) = self.intent_scope {
            crate::workspace::architect::lock_execution_intent_scope(
                self.workspace,
                &metadata,
                scope,
                Some(&request.source),
            )
            .await?
        } else {
            lock_execution_source_owner(
                self.workspace,
                &metadata,
                &request.source.owner,
                Some(&request.source),
            )
            .await?
        };
        let mut current_catalogue = agsdl_host_catalogue::capture(self.manager, self.pool).await?;
        let policy = self
            .manager
            .lock_execution_tools(&locked.revision.owner.project_id)
            .await
            .map_err(|_| failure("PERMISSION", "policy", "Project tool policy is unavailable"))?;
        let (current_observation, account, claude_account) = observation(
            self.manager,
            self.workspace,
            &locked,
            &current_catalogue,
            &policy.tools,
            &policy.agsdl_host_permissions,
            request
                .associations
                .task_id
                .as_deref()
                .map(|id| (id, self.git)),
        )
        .await?;
        current_catalogue.codex_account_digest = account;
        current_catalogue.claude_account_digest = claude_account;
        let catalogue = serde_json::to_string(&current_catalogue)?;
        let prior = self
            .captured
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Capture state unavailable"))?;
        if prior.as_ref().is_none_or(|(_, previous, cards, version)| {
            previous != &catalogue
                || cards != &locked.display_cards_json
                || current_observation.get("version").and_then(Value::as_str)
                    != Some(version.as_str())
        }) {
            return Err(failure(
                "CAPTURE_CHANGED",
                "source",
                "Capture observations changed before commit",
            ));
        }
        self.lease.ensure_live()?;
        Ok(StartCommitGuard {
            _source: locked,
            _policy: policy,
        })
    }
}

pub(crate) async fn start(
    host: &HostState,
    manager: &ConfigManager,
    pool: &sqlx::SqlitePool,
    workspace: &Path,
    request: EngineStartRequest,
    git: &crate::git::GitState,
) -> Result<EngineStartReceipt> {
    start_linked(host, manager, pool, workspace, request, git, None).await
}
pub(crate) async fn start_linked(
    host: &HostState,
    manager: &ConfigManager,
    pool: &sqlx::SqlitePool,
    workspace: &Path,
    request: EngineStartRequest,
    git: &crate::git::GitState,
    link: Option<&crate::db::agsdl_execution::intents::IntentAdmissionLink>,
) -> Result<EngineStartReceipt> {
    let lease = host.start_lease().await?;
    let authority = StartAuthority {
        host,
        lease: &lease,
        manager,
        pool,
        workspace,
        git,
        captured: Default::default(),
        intent_scope: link.map(|link| &link.key.scope),
    };
    let receipt = crate::db::agsdl_execution::start_linked(pool, request, &authority, link).await?;
    let created_here = authority
        .captured
        .lock()
        .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Capture state unavailable"))?
        .as_ref()
        .is_some_and(|(system, _, _, _)| system == &receipt.system_start_id);
    if created_here {
        let owner = EngineOwner {
            system_start_id: receipt.system_start_id.clone(),
            owner_epoch: "0".into(),
        };
        if let Err(error) = lease.retain_committed_owner(owner.clone()) {
            crate::db::agsdl_execution::revoke_host_owners(pool, &[owner]).await?;
            return Err(error);
        }
    }
    // An idempotent Start receipt never adopts a previous epoch or replays work.
    lease.ensure_live()?;
    Ok(receipt)
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionExternalDelivery {
    pub system_start_id: String,
    pub delivery_id: String,
    pub agent_name: String,
    pub message_json: String,
}

/// The registry is loaded from the native capture, never supplied by the message.
/// Approximate support requires a durable warning in the delivery transaction.
fn graphless_resource_support030(
    registry: &Value,
    agent_name: &str,
    message_json: &str,
) -> Result<Option<&'static str>> {
    let message = exact_json::value(message_json)?;
    let message = message.as_object().ok_or_else(|| {
        failure(
            "INPUT_CONSTRAINT",
            "message",
            "External message must be an object",
        )
    })?;
    if !message.contains_key("resources") {
        return Ok(None);
    }
    let unverified = || {
        failure(
            "HARNESS_UNVERIFIED",
            "message.resources",
            "Resource delivery has no qualified native harness observation",
        )
    };
    if registry.get("format").and_then(Value::as_str) != Some("macro-agsdl-registry/030") {
        return Err(unverified());
    }
    let agents = registry
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(unverified)?;
    let mut matching_agents = agents
        .iter()
        .filter(|agent| agent.get("agentName").and_then(Value::as_str) == Some(agent_name));
    let agent = matching_agents.next().ok_or_else(unverified)?;
    if matching_agents.next().is_some() {
        return Err(unverified());
    }
    let declaration = agent
        .get("agentDeclarationJson")
        .and_then(Value::as_str)
        .ok_or_else(unverified)?;
    let declaration = exact_json::value(declaration).map_err(|_| unverified())?;
    let harness = declaration
        .get("harness")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(unverified)?;
    let observations = registry
        .get("harnesses")
        .and_then(Value::as_array)
        .ok_or_else(unverified)?;
    let mut matching = observations
        .iter()
        .filter(|observation| observation.get("harness").and_then(Value::as_str) == Some(harness));
    let observation = matching.next().ok_or_else(unverified)?;
    if matching.next().is_some()
        || observation.get("qualified").and_then(Value::as_bool) != Some(true)
        || observation.get("installation").and_then(Value::as_str) != Some("available")
        || observation
            .get("version")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || observation
            .get("adapterId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(unverified());
    }
    let capabilities = observation
        .get("capabilities")
        .and_then(Value::as_array)
        .ok_or_else(unverified)?;
    let mut matching = capabilities
        .iter()
        .filter(|capability| capability.get("name").and_then(Value::as_str) == Some("resources"));
    let capability = matching.next().ok_or_else(unverified)?;
    if matching.next().is_some() {
        return Err(unverified());
    }
    let evidence = capability
        .get("evidenceJson")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(unverified)?;
    let evidence = exact_json::value(evidence).map_err(|_| unverified())?;
    if evidence.is_null()
        || evidence.as_object().is_some_and(|object| object.is_empty())
        || evidence.as_array().is_some_and(|array| array.is_empty())
        || evidence.as_str().is_some_and(str::is_empty)
    {
        return Err(unverified());
    }
    match capability.get("support").and_then(Value::as_str) {
        Some("native") => Ok(Some("native")),
        Some("approximate") => Ok(Some("approximate")),
        Some("absent") => Err(failure(
            "HARNESS_UNSUPPORTED",
            "message.resources",
            "The qualified harness cannot receive resources",
        )),
        _ => Err(unverified()),
    }
}
pub(crate) async fn deliver(
    host: &HostState,
    pool: &sqlx::SqlitePool,
    request: ExecutionExternalDelivery,
) -> Result<EngineAcceptedDelivery> {
    deliver_linked(host, pool, request, None).await
}
pub(crate) async fn deliver_linked(
    host: &HostState,
    pool: &sqlx::SqlitePool,
    request: ExecutionExternalDelivery,
    intent: Option<(
        &crate::db::agsdl_execution::intents::IntentAdmissionLink,
        &Path,
    )>,
) -> Result<EngineAcceptedDelivery> {
    let lease = host.start_lease().await?;
    let owner = lease.owner(&request.system_start_id)?;
    let snapshot =
        super::db::agsdl_execution::read_snapshot(pool, &request.system_start_id).await?;
    let capture = super::db::agsdl_execution::capture::read(pool, &owner).await?;
    let mut registry = exact_json::value(&capture.registry_json)?;
    let resources_approximate = snapshot.versions.contract == "agsdl-0.3.0"
        && graphless_resource_support030(&registry, &request.agent_name, &request.message_json)?
            == Some("approximate");
    registry["deliveryInput"] =
        json!({"agentName":request.agent_name,"messageJson":request.message_json});
    let receipt = host
        .compile(
            snapshot.source,
            snapshot.authored_source,
            serde_json::to_string(&registry)?,
        )
        .await?;
    let validation: Value = serde_json::from_str(&receipt.result_json)?;
    if receipt.generation != lease.generation() {
        return Err(failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "Compiler incarnation changed",
        ));
    }
    match validation
        .pointer("/deliveryValidation/valid")
        .and_then(Value::as_bool)
    {
        Some(true) => (),
        Some(false) => {
            return Err(failure(
                "INPUT_CONSTRAINT",
                "message",
                "External Message is invalid for this graphless Agent",
            ))
        }
        None => {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "",
                "Compiler validation acknowledgement is unavailable",
            ))
        }
    }
    lease.ensure_live()?;
    // Retirement waits for this lease; a committed queue item is never adopted by a new host.
    let _scope_guard = if let Some((link, workspace)) = intent {
        Some(
            crate::workspace::architect::lock_execution_intent_scope(
                workspace,
                &metadata_root(workspace)?,
                &link.key.scope,
                None,
            )
            .await?,
        )
    } else {
        None
    };
    super::db::agsdl_execution::accept_external_delivery_with_warning(
        pool,
        &owner,
        &request.delivery_id,
        &request.agent_name,
        &request.message_json,
        intent.map(|(link, _)| link),
        resources_approximate,
    )
    .await
}

#[cfg(test)]
mod exact_capture_tests {
    use super::*;
    use crate::agsdl_host_catalogue::NativeModelCatalogue;
    use crate::workspace::metadata::{ProjectDto, WorkspaceState};

    #[test]
    fn local_harness_diagnostics_distinguish_missing_version_and_adapter() {
        let document = r#"{"contract":"agsdl-0.3.0","agents":{"a/b":{"harness":"opencode"},"other":{"harness":"pi"}}}"#;
        let registry = json!({"modules":[
            {"harness":"opencode","moduleJson":include_str!("../../src/vendor/agsdl/v0.3/harnesses/opencode/module.json")},
            {"harness":"pi","moduleJson":include_str!("../../src/vendor/agsdl/v0.3/harnesses/pi/module.json")}
        ],"harnesses":[
            {"harness":"opencode","installation":"available","version":"1.19.5"},
            {"harness":"pi","installation":"missing","version":null}
        ]}).to_string();
        let findings = local_harness_diagnostics030(document, &registry);
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].code, "HARNESS_VERSION_UNSUPPORTED");
        assert_eq!(findings[0].pointer, "/agents/a~1b/harness");
        assert_eq!(findings[1].code, "HARNESS_NOT_INSTALLED");
        let unassessed = local_harness_diagnostics030(document, r#"{"modules":[],"harnesses":[]}"#);
        assert!(unassessed
            .iter()
            .all(|d| d.code == "HARNESS_INSTALLATION_UNASSESSED"));
        let compatible = registry.replace("1.19.5", "2.0.28");
        assert_eq!(
            local_harness_diagnostics030(document, &compatible)[0].code,
            "HARNESS_ADAPTER_UNAVAILABLE"
        );
    }

    #[test]
    fn graphless_resources_require_the_captured_qualified_harness() {
        let registry = json!({
            "format":"macro-agsdl-registry/030",
            "agents":[{"agentName":"worker","agentDeclarationJson":"{\"harness\":\"codex\"}"}],
            "harnesses":[{"harness":"codex","qualified":true,"installation":"available",
                "version":"0.166.0","adapterId":"adapter",
                "capabilities":[{"name":"resources","support":"approximate","evidenceJson":"{\"receipt\":\"observed\"}"}]}]
        });
        assert_eq!(
            graphless_resource_support030(&registry, "worker", r#"{"prompt":"x"}"#).unwrap(),
            None
        );
        let message = r#"{"resources":{"input":{"value":9007199254740993}}}"#;
        assert_eq!(
            graphless_resource_support030(&registry, "worker", message).unwrap(),
            Some("approximate")
        );
        let mut native = registry.clone();
        native["harnesses"][0]["capabilities"][0]["support"] = "native".into();
        assert_eq!(
            graphless_resource_support030(&native, "worker", message).unwrap(),
            Some("native")
        );
        let mut unqualified = registry.clone();
        unqualified["harnesses"][0]["qualified"] = false.into();
        assert_eq!(
            graphless_resource_support030(&unqualified, "worker", message)
                .unwrap_err()
                .code,
            "HARNESS_UNVERIFIED"
        );
        let mut missing_evidence = registry.clone();
        missing_evidence["harnesses"][0]["capabilities"][0]["evidenceJson"] = "{}".into();
        assert_eq!(
            graphless_resource_support030(&missing_evidence, "worker", message)
                .unwrap_err()
                .code,
            "HARNESS_UNVERIFIED"
        );
        let mut absent = registry.clone();
        absent["harnesses"][0]["capabilities"][0]["support"] = "absent".into();
        assert_eq!(
            graphless_resource_support030(&absent, "worker", message)
                .unwrap_err()
                .code,
            "HARNESS_UNSUPPORTED"
        );
        assert!(graphless_resource_support030(
            &registry,
            "worker",
            r#"{"resources":{},"resources":{}}"#
        )
        .is_err());
        assert!(graphless_resource_support030(&registry, "other", message).is_err());
    }

    #[tokio::test]
    async fn native_observation_retains_configurations_with_opaque_public_source_data() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        let metadata = workspace.join(".macro");
        let project = workspace.join("project");
        let plan = project.join(".macro/branches/develop/plans/source/plan.json");
        std::fs::create_dir_all(plan.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&metadata).unwrap();
        let registered: ProjectDto = serde_json::from_value(json!({
            "id":"project", "name":"Synthetic", "path":project, "created_at":"2026-01-01", "status":"active",
            "directEdit":true, "gitSetupState":"not_git",
            "metadata":{"description":"", "tags":[], "team_members":[], "api_contracts":[], "dependencies":[]}
        })).unwrap();
        let mut state = WorkspaceState::default();
        state.standalone_projects.push(registered);
        std::fs::write(
            metadata.join("workspace.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        let manager = ConfigManager::initialize(temp.path().join("config"))
            .await
            .unwrap();
        let catalogue = ModelCapture {
            catalogue: NativeModelCatalogue {
                revision: "synthetic".into(),
                models: vec![],
                unavailable_providers: vec![],
            },
            providers: vec![],
            codex_account_digest: None,
            claude_account_digest: None,
        };
        let owner = EngineSourceOwner {
            project_id: "project".into(),
            plan_id: "source".into(),
            branch: "develop".into(),
        };
        for data in [
            r#"{"$serde_json::private::Number":"not a number"}"#,
            r#"{"$serde_json::private::RawValue":"not JSON"}"#,
        ] {
            let source = format!(
                r#"{{"contract":"agsdl-0.2.0","id":"synthetic","bindings":{{"engine":{{"contract":{{"identity":"macro/agent-engine","version":"1"}},"implementation":{{"identity":"macro/desktop","version":"1"}}}}}},"agents":{{"worker":{{"configuration":"fixed","prompt":[{{"value":"Synthetic."}}]}}}},"configurations":{{"fixed":{{"engine":"engine","model":{{"identity":"macro/native-model/p/cA/m/bQ","version":"1"}},"settings":{{"writeRules":[{{"action":"write","effect":"deny","match":".env*"}}]}}}}}},"flow":{{"entry":"prepare","steps":{{"prepare":{{"type":"prepare","message":{{"resources":{{"opaque":{{"value":{data},"mediaType":"application/json"}}}}}},"next":["work"]}},"work":{{"type":"agent","agent":"worker","next":[]}}}}}}}}"#
            );
            std::fs::write(&plan, serde_json::to_vec(&json!({"id":"source", "projectIds":["project"], "revision":1, "agsdl":{"source":source}})).unwrap()).unwrap();
            let locked = lock_execution_source_owner(&workspace, &metadata, &owner, None)
                .await
                .unwrap();
            let (observed, codex, claude) = observation(
                &manager,
                &workspace,
                &locked,
                &catalogue,
                &json!({"riskLevel":"balanced"}),
                &crate::agsdl_permissions::RequestedPermissions::Preset(
                    crate::agsdl_permissions::Preset::ReadOnly,
                ),
                None,
            )
            .await
            .unwrap();
            assert_eq!(observed["configurations"].as_array().unwrap().len(), 1);
            assert_eq!(observed["configurations"][0]["agentName"], "worker");
            let frozen: Value = serde_json::from_str(
                observed["configurations"][0]["permissionsJson"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                frozen["writeRules"],
                json!([{"action":"write","effect":"deny","match":".env*"}])
            );
            assert_eq!(locked.source, source);
            assert!(codex.is_none() && claude.is_none());
        }
    }
}

#[cfg(test)]
mod start_material030_tests {
    use super::*;
    use crate::agsdl_host_catalogue::{ModelCapture, NativeModelCatalogue};

    #[test]
    fn read_only_notice_does_not_close_a_qualified_runtime() {
        let (mut capture, _) = fixture();
        let before = capture.public();
        capture.permission_notice030 = true;
        let after = capture.public();
        assert!(after
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "READ_ONLY_CEILING"));
        assert_eq!(after.runtime_supported, before.runtime_supported);
        assert_eq!(
            after.product_runtime_available,
            before.product_runtime_available
        );
    }

    fn fixture() -> (CompilationCapture, EngineStartRequest) {
        let authored =
            r#"{"contract":"agsdl-0.3.0","id":"fixture","agents":{},"n":9007199254740993}"#;
        let source = EngineSourceRevision {
            owner: EngineSourceOwner {
                project_id: "p".into(),
                plan_id: "plan".into(),
                branch: "feature/test".into(),
            },
            revision: "1".into(),
            source_sha256: format!("{:x}", Sha256::digest(authored.as_bytes())),
        };
        let request = EngineStartRequest {
            source: source.clone(),
            profile: "macro-agsdl-030-v1".into(),
            associations: Default::default(),
            request_id: "request".into(),
            entry: None,
        };
        let registry = json!({"format":"macro-agsdl-registry/030","version":"registry","modules":[],"harnesses":[],"agents":[]});
        let mut ticket = registry.clone();
        ticket["startEntry"] = Value::Null;
        ticket["callPermissions"] = json!({"mode":"Implement"});
        ticket["callScope"] = json!({"root":"/synthetic"});
        let versions = json!({"snapshot":"2","contract":"agsdl-0.3.0","compiler":"compiler","runtime":"runtime","registry":"registry","profile":"macro-agsdl-030-v1"});
        let plan = json!({"format":"macro-agsdl-compiled-plan/2","source":source,"versions":versions,"documentJson":authored,"entry":null});
        let result = json!({"static":{"valid":true},"runtime":{"supported":true,"profile":"macro-agsdl-030-v1","source":source,"registryVersion":"registry"},
            "entryValidation":{"messageJson":null,"shapeValid":true,"valid":false,"unassessed":["native proof"]},
            "capturedRegistryJson":registry.to_string(),"compiledPlanJson":plan.to_string(),"productRuntimeAvailable":false});
        (
            CompilationCapture {
                source,
                authored_source: authored.into(),
                display_cards_json: "[]".into(),
                native_catalogue: ModelCapture {
                    catalogue: NativeModelCatalogue {
                        revision: "catalogue".into(),
                        models: vec![],
                        unavailable_providers: vec![],
                    },
                    providers: vec![],
                    codex_account_digest: None,
                    claude_account_digest: None,
                },
                result,
                generation: "generation".into(),
                call_permissions_json: json!({"mode":"Implement"}).to_string(),
                call_scope_json: json!({"root":"/synthetic"}).to_string(),
                permission_notice030: false,
                native_registry_json: ticket.to_string(),
            },
            request,
        )
    }
    fn prepare(
        capture: &CompilationCapture,
        request: &EngineStartRequest,
    ) -> Result<StartCaptureMaterial030> {
        capture.start_material030_checked(
            &capture.source,
            &capture.authored_source,
            &capture.display_cards_json,
            request,
            "generation",
        )
    }
    #[test]
    fn preserves_native_material_without_promoting_missing_proof() {
        let (capture, request) = fixture();
        let material = prepare(&capture, &request).unwrap();
        assert_eq!(material.source, capture.source);
        assert_eq!(material.authored_source, capture.authored_source);
        assert_eq!(material.entry_unassessed, vec!["native proof"]);
        assert_eq!(
            material.registry_json,
            capture.result["capturedRegistryJson"].as_str().unwrap()
        );
        assert_eq!(material.generation, "generation");
        assert_eq!(material.versions.contract, "agsdl-0.3.0");
        assert_eq!(
            material.call_permissions_json,
            capture.call_permissions_json
        );
        assert_eq!(material.call_scope_json, capture.call_scope_json);
        assert_eq!(material.display_cards_json, capture.display_cards_json);
        assert!(material.native_catalogue_json.contains("catalogue"));
    }
    #[test]
    fn rejects_stale_source_generation_ticket_and_substituted_plan() {
        let (mut capture, request) = fixture();
        assert!(capture
            .start_material030_checked(&capture.source, "changed", "[]", &request, "generation",)
            .is_err());
        assert!(capture
            .start_material030_checked(
                &capture.source,
                &capture.authored_source,
                "[]",
                &request,
                "old-generation",
            )
            .is_err());
        let original = capture.result.clone();
        capture.result["capturedRegistryJson"] =
            r#"{"format":"macro-agsdl-registry/030","version":"other"}"#.into();
        assert!(prepare(&capture, &request).is_err());
        capture.result = original.clone();
        let mut plan: Value =
            serde_json::from_str(original["compiledPlanJson"].as_str().unwrap()).unwrap();
        plan["documentJson"] = capture
            .authored_source
            .replace("9007199254740993", "9007199254740993.0")
            .into();
        capture.result["compiledPlanJson"] = plan.to_string().into();
        assert!(prepare(&capture, &request).is_err());
        capture.result = original;
        capture.result["entryValidation"]["shapeValid"] = false.into();
        assert!(prepare(&capture, &request).is_err());
    }
}

#[cfg(test)]
mod product_slice030_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_out_of_slice_before_native_start() {
        let base = json!({"contract":"agsdl-0.3.0", "agents":{"writer":{"harness":"codex"}},
            "flow":{"entry":"write","steps":{"write":{"type":"agent","agent":"writer"}}}});
        for (pointer, value) in [
            ("/flow/steps/write/type", json!("compose")),
            ("/agents/writer/harness", json!("claude")),
        ] {
            let mut document = base.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            document
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(key.into(), value);
            let diagnostic = product_slice030(&document.to_string(), None).unwrap();
            assert_eq!(diagnostic.code, "UNSUPPORTED_030_FEATURE");
            assert!(diagnostic.pointer.starts_with(parent), "{diagnostic:?}");
        }
        assert!(product_slice030(&base.to_string(), None).is_none());
        let plan = json!({"steps": [], "routes": [{"targets": [{"eachPathJson":"[]"}]}]});
        assert_eq!(
            product_slice030(&base.to_string(), Some(&plan.to_string()))
                .unwrap()
                .code,
            "UNSUPPORTED_030_FEATURE"
        );
    }
}
