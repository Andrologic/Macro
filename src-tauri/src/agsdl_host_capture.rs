//! Canonical, effect-free input capture for the resident compiler.
use crate::agsdl_host::HostState;
use crate::agsdl_host_catalogue::{self, ModelCapture};
use crate::config::ConfigManager;
use crate::db::agsdl_execution::{dto::*, failure, Result};
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
fn observation(
    workspace: &Path,
    source: &LockedExecutionSource,
    catalogue: &ModelCapture,
) -> Result<Value> {
    let scope = project_scope(workspace, source)?;
    let project = &source.project;
    let document: Value = serde_json::from_str(&source.source).unwrap_or(Value::Null);
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
            configurations.push(json!({
                "agentName": name, "verifiedRequirementsJson": [],
                "effectiveSettingsJson": serde_json::to_string(&settings)?,
                "permissionsJson": serde_json::to_string(&json!({"mode":mode,"allowedToolIds":[],"readOnly":project.user_read_only || project.is_read_only}))?,
                "scopeJson": serde_json::to_string(&scope)?
            }));
        }
    }
    let models = catalogue.catalogue.models.iter().map(|model| Ok(json!({
        "editionJson":serde_json::to_string(&model.edition)?,"providerId":model.provider_id,"modelId":model.model_id
    }))).collect::<Result<Vec<_>>>()?;
    let mut observation = json!({"format":"macro-native-registry-observation/1","models":models,"tools":[],"configurations":configurations});
    let version = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&(&observation, &catalogue.providers))?)
    );
    observation["version"] = Value::String(version);
    Ok(observation)
}

pub(crate) async fn compile(
    host: &HostState,
    manager: &ConfigManager,
    pool: &sqlx::SqlitePool,
    workspace: &Path,
    request: &ExecutionPreflightRequest,
) -> Result<CompilationCapture> {
    compile_input(host, manager, pool, workspace, request, None).await
}

pub(crate) async fn compile_input(
    host: &HostState,
    manager: &ConfigManager,
    pool: &sqlx::SqlitePool,
    workspace: &Path,
    request: &ExecutionPreflightRequest,
    start_entry: Option<Option<&EngineEntry>>,
) -> Result<CompilationCapture> {
    let metadata = metadata_root(workspace)?;
    let locked = lock_execution_source_owner(
        workspace,
        &metadata,
        &request.owner,
        request.expected.as_ref(),
    )
    .await?;
    let native_catalogue = agsdl_host_catalogue::capture(manager, pool).await?;
    let mut registry = observation(workspace, &locked, &native_catalogue)?;
    if let Some(entry) = start_entry {
        registry["startEntry"] = serde_json::to_value(entry)?;
    }
    let receipt = host
        .compile(
            locked.revision.clone(),
            locked.source.clone(),
            serde_json::to_string(&registry)?,
        )
        .await?;
    Ok(CompilationCapture {
        source: locked.revision.clone(),
        authored_source: locked.source.clone(),
        display_cards_json: locked.display_cards_json.clone(),
        native_catalogue,
        result: serde_json::from_str(&receipt.result_json)?,
        generation: receipt.generation,
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
            product_runtime_available: false,
        }
    }
}

struct StartAuthority<'a> {
    host: &'a HostState,
    lease: &'a crate::agsdl_host::HostStartLease,
    manager: &'a ConfigManager,
    pool: &'a sqlx::SqlitePool,
    workspace: &'a Path,
    captured: std::sync::Mutex<Option<(String, String, String, String)>>,
}

impl crate::db::agsdl_execution::CaptureAuthority for StartAuthority<'_> {
    type CommitGuard = LockedExecutionSource;
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
            || request.associations != EngineAssociations::default()
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
        let plan: Value = serde_json::from_str(&compiled_plan_json)?;
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
        let call_scopes: Vec<CallScope> = Vec::new();
        for step in steps {
            let declaration: Value = serde_json::from_str(
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
        let locked = lock_execution_source_owner(
            self.workspace,
            &metadata,
            &request.source.owner,
            Some(&request.source),
        )
        .await?;
        let current_catalogue = agsdl_host_catalogue::capture(self.manager, self.pool).await?;
        let current_observation = observation(self.workspace, &locked, &current_catalogue)?;
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
        Ok(locked)
    }
}

pub(crate) async fn start(
    host: &HostState,
    manager: &ConfigManager,
    pool: &sqlx::SqlitePool,
    workspace: &Path,
    request: EngineStartRequest,
) -> Result<EngineStartReceipt> {
    let lease = host.start_lease().await?;
    let authority = StartAuthority {
        host,
        lease: &lease,
        manager,
        pool,
        workspace,
        captured: Default::default(),
    };
    let receipt = crate::db::agsdl_execution::start(pool, request, &authority).await?;
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
    let lease = host.start_lease().await?;
    let owner = lease.owner(&request.system_start_id)?;
    let snapshot =
        super::db::agsdl_execution::read_snapshot(pool, &request.system_start_id).await?;
    let capture = super::db::agsdl_execution::capture::read(pool, &owner).await?;
    let mut registry: Value = serde_json::from_str(&capture.registry_json)?;
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
    if receipt.generation != lease.generation()
        || validation
            .pointer("/deliveryValidation/valid")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(failure(
            "INPUT_CONSTRAINT",
            "message",
            "External Message is not valid for this graphless Agent",
        ));
    }
    lease.ensure_live()?;
    // Retirement waits for this lease; a committed queue item is never adopted by a new host.
    super::db::agsdl_execution::accept_external_delivery(
        pool,
        &owner,
        &request.delivery_id,
        &request.agent_name,
        &request.message_json,
    )
    .await
}
