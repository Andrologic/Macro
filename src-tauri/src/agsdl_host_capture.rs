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
    if git2::Repository::discover(workspace).is_ok() {
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
    pub display_cards_json: String,
    pub native_catalogue: ModelCapture,
    pub result: Value,
    pub generation: String,
    pub call_permissions_json: String,
    pub call_scope_json: String,
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

async fn observation(
    manager: &ConfigManager,
    workspace: &Path,
    source: &LockedExecutionSource,
    catalogue: &ModelCapture,
    tools: &Value,
    task: Option<(&str, &crate::git::GitState)>,
) -> Result<(Value, Option<String>, Option<String>)> {
    let scope = execution_scope(workspace, source, task)?;
    let project = &source.project;
    let document = exact_json::value(&source.source).unwrap_or(Value::Null);
    let has_codex = document
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
    let has_claude = document
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
            let mut settings = settings.clone();
            if engine.is_some_and(|engine| engine["implementation"]["identity"] == "openai/codex") {
                let Some((profile, _, _)) = &codex else {
                    continue;
                };
                if settings.get("maxTurns").is_some() {
                    continue;
                }
                settings["nativeProfileJson"] = json!(profile.attestation(
                    project.user_read_only || project.is_read_only || mode != "Implement",
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
                "permissionsJson": serde_json::to_string(&crate::agsdl_host_tools::permissions(mode, project.user_read_only || project.is_read_only, tools)?)?,
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
    let account = codex.as_ref().map(|(_, _, account)| account.clone());
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
    Ok((observation, account, claude_account))
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
        task,
    )
    .await?;
    native_catalogue.codex_account_digest = account;
    native_catalogue.claude_account_digest = claude_account;
    let call_permissions_json = serde_json::to_string(&registry["callPermissions"])?;
    let call_scope_json = serde_json::to_string(&registry["callScope"])?;
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
        .compile(source.clone(), authored_source.clone(), registry_json)
        .await?;
    Ok(CompilationCapture {
        source,
        authored_source,
        display_cards_json,
        native_catalogue,
        result: serde_json::from_str(&receipt.result_json)?,
        generation: receipt.generation,
        call_permissions_json,
        call_scope_json,
    })
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
        let diagnostics = findings
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
                    message: "The captured document cannot execute in the native inline profile."
                        .into(),
                }
            })
            .collect();
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
                == Some(true),
            registry_version: self
                .result
                .pointer("/runtime/registryVersion")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            diagnostics,
            incomplete: findings.len() > 64,
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
    super::db::agsdl_execution::accept_external_delivery_linked(
        pool,
        &owner,
        &request.delivery_id,
        &request.agent_name,
        &request.message_json,
        intent.map(|(link, _)| link),
    )
    .await
}

#[cfg(test)]
mod exact_capture_tests {
    use super::*;
    use crate::agsdl_host_catalogue::NativeModelCatalogue;
    use crate::workspace::metadata::{ProjectDto, WorkspaceState};

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
                r#"{{"contract":"agsdl-0.2.0","id":"synthetic","bindings":{{"engine":{{"contract":{{"identity":"macro/agent-engine","version":"1"}},"implementation":{{"identity":"macro/desktop","version":"1"}}}}}},"agents":{{"worker":{{"configuration":"fixed","prompt":[{{"value":"Synthetic."}}]}}}},"configurations":{{"fixed":{{"engine":"engine","model":{{"identity":"macro/native-model/p/cA/m/bQ","version":"1"}}}}}},"flow":{{"entry":"prepare","steps":{{"prepare":{{"type":"prepare","message":{{"resources":{{"opaque":{{"value":{data},"mediaType":"application/json"}}}}}},"next":["work"]}},"work":{{"type":"agent","agent":"worker","next":[]}}}}}}}}"#
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
                None,
            )
            .await
            .unwrap();
            assert_eq!(observed["configurations"].as_array().unwrap().len(), 1);
            assert_eq!(observed["configurations"][0]["agentName"], "worker");
            assert_eq!(locked.source, source);
            assert!(codex.is_none() && claude.is_none());
        }
    }
}
