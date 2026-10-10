//! Qualified workspace adapters reuse Macro execution, approvals and owned roots.
use crate::agsdl_host::HostState;
use crate::db::agsdl_execution::{self as repository, dto::*, failure, Result};
use crate::db::exact_json;
use futures::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State, Webview};

const WORKSPACE_TOOLS: &[&str] = &[
    "list",
    "read",
    "glob",
    "grep",
    "ast_grep",
    "write",
    "edit",
    "delete",
    "apply_patch",
    "git_status",
    "git_log",
    "git_branch_list",
    "git_diff",
    "git_get_tree",
];
fn writes(tool: &str) -> bool {
    matches!(tool, "write" | "edit" | "delete" | "apply_patch")
}
pub(crate) fn permissions(mode: &str, read_only: bool, tools: &Value) -> Result<Value> {
    let risk = tools
        .get("riskLevel")
        .and_then(Value::as_str)
        .filter(|risk| matches!(*risk, "balanced" | "strict" | "yolo"))
        .ok_or_else(|| {
            failure(
                "UNSUPPORTED",
                "policy",
                "Current tool risk policy is unavailable",
            )
        })?;
    let base = crate::core::tool_policy::get_mode_policy("Implement");
    let mode_policy = crate::core::tool_policy::get_mode_policy(mode);
    let allowed = WORKSPACE_TOOLS
        .iter()
        .filter(|tool| {
            base.allowed_tool_ids.iter().any(|id| id == **tool)
                && mode_policy.allowed_tool_ids.iter().any(|id| id == **tool)
                && (!read_only || !writes(tool))
                && tools
                    .get("builtIn")
                    .and_then(|map| map.get(**tool))
                    .and_then(Value::as_bool)
                    != Some(false)
                && tools
                    .get("modes")
                    .and_then(|map| map.get(mode))
                    .and_then(|map| map.get(**tool))
                    .and_then(Value::as_bool)
                    != Some(false)
        })
        .copied()
        .collect::<Vec<_>>();
    Ok(json!({"mode":mode,"readOnly":read_only,"allowedToolIds":allowed,"riskLevel":risk}))
}
pub(crate) fn observations() -> Value {
    Value::Array(
        WORKSPACE_TOOLS
            .iter()
            .map(|tool| {
                json!({"toolId":tool,"resultConstraintJson":"{\"type\":\"string\"}",
        "effects":if writes(tool) {"external"} else {"none"},"verifiedRequirementsJson":[]})
            })
            .collect(),
    )
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostToolInvocation {
    pub context: EngineContext,
    pub tool_invocation_id: String,
    pub provider_attempt_id: Option<String>,
    pub binding_json: String,
    pub arguments_json: String,
    pub call_scope_json: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostToolReceipt {
    AwaitingApproval {
        approval: repository::approvals::PublicApproval,
    },
    Pending,
    Ended {
        result_json: String,
        failed: bool,
    },
    Uncertain,
    Rejected {
        code: String,
    },
}
/// This is an executor ownership set, not an admission queue. FIFO stays in SQL.
#[derive(Default)]
pub(crate) struct ToolExecutors(Mutex<BTreeSet<String>>);
impl ToolExecutors {
    fn contains(&self, key: &str) -> bool {
        self.0.lock().expect("tool owners").contains(key)
    }
    fn insert(&self, key: String) -> bool {
        self.0.lock().expect("tool owners").insert(key)
    }
    fn remove(&self, key: &str) {
        self.0.lock().expect("tool owners").remove(key);
    }
}
fn key(request: &HostToolInvocation) -> String {
    json!([
        request.context.owner.system_start_id,
        request.context.owner.owner_epoch,
        request.context.work.activation_id,
        request.tool_invocation_id
    ])
    .to_string()
}
fn bound_tool(
    capture: &repository::capture::PrivateCapture,
    request: &HostToolInvocation,
) -> Result<String> {
    exact_json::validate(&request.arguments_json)?;
    let registry: Value = serde_json::from_str(&capture.registry_json)?;
    let mut matches = Vec::new();
    for binding in registry
        .get("bindings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(declaration) = binding.get("declarationJson").and_then(Value::as_str) {
            if exact_json::equal(declaration, &request.binding_json)? {
                matches.push(binding);
            }
        }
    }
    if matches.len() != 1
        || matches[0].pointer("/target/kind").and_then(Value::as_str) != Some("macro-tool")
    {
        return Err(failure(
            "CORRELATION",
            "binding",
            "Invocation binding has no captured Macro adapter",
        ));
    }
    let tool = matches[0]
        .pointer("/target/toolId")
        .and_then(Value::as_str)
        .filter(|tool| WORKSPACE_TOOLS.contains(tool))
        .ok_or_else(|| failure("UNSUPPORTED", "binding", "Tool adapter is not qualified"))?;
    Ok(tool.into())
}
async fn authorize_binding(pool: &sqlx::SqlitePool, request: &HostToolInvocation) -> Result<()> {
    let declarations: Vec<Value> = if let Some(agent) = &request.context.work.agent_instance_id {
        if request.provider_attempt_id.is_none() {
            return Err(failure(
                "CORRELATION",
                "providerAttemptId",
                "Agent tools require their actual provider attempt",
            ));
        }
        let (configuration, _) =
            repository::read_agent(pool, &request.context.owner.system_start_id, agent).await?;
        let captured: Value = serde_json::from_str(&configuration.configuration_json)?;
        captured
            .pointer("/configuration/tools")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|tools| tools.values())
            .filter_map(|binding| binding.as_str())
            .filter_map(|name| {
                captured
                    .get("bindings")
                    .and_then(|bindings| bindings.get(name))
                    .cloned()
            })
            .collect()
    } else {
        if request.provider_attempt_id.is_some() {
            return Err(failure(
                "CORRELATION",
                "providerAttemptId",
                "A Call cannot borrow an Agent provider attempt",
            ));
        }
        let snapshot =
            repository::read_snapshot(pool, &request.context.owner.system_start_id).await?;
        let plan: Value = serde_json::from_str(&snapshot.compiled_plan_json)?;
        let address = serde_json::to_value(&request.context.work.step)?;
        let step = plan
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|step| step.get("address") == Some(&address))
            .ok_or_else(|| {
                failure(
                    "CORRELATION",
                    "step",
                    "Call step is absent from the captured plan",
                )
            })?;
        let declaration: Value = serde_json::from_str(
            step.get("declarationJson")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("CORRELATION", "step", "Call declaration is absent"))?,
        )?;
        if declaration.get("type").and_then(Value::as_str) != Some("call") {
            return Err(failure(
                "CORRELATION",
                "step",
                "Work is not a captured Call",
            ));
        }
        let document: Value = serde_json::from_str(
            plan.get("documentJson")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("CORRELATION", "plan", "Captured document is absent"))?,
        )?;
        declaration
            .get("binding")
            .and_then(Value::as_str)
            .and_then(|name| {
                document
                    .get("bindings")
                    .and_then(|bindings| bindings.get(name))
            })
            .cloned()
            .into_iter()
            .collect()
    };
    for declaration in declarations {
        if exact_json::equal(&serde_json::to_string(&declaration)?, &request.binding_json)? {
            return Ok(());
        }
    }
    Err(failure(
        "PERMISSION",
        "binding",
        "Binding is not configured for this Agent or Call",
    ))
}
fn effect(request: &HostToolInvocation, tool: &str) -> Result<EngineEffect> {
    if request.tool_invocation_id.is_empty() || request.tool_invocation_id.len() > 512 {
        return Err(failure(
            "CORRELATION",
            "toolInvocationId",
            "Invalid invocation identity",
        ));
    }
    Ok(EngineEffect {
        context: request.context.clone(),
        effect: EngineEffectIdentity::Tool {
            tool_invocation_id: request.tool_invocation_id.clone(),
            provider_attempt_id: request.provider_attempt_id.clone(),
        },
        invocation_json: serde_json::to_string(
            &json!({"toolId":tool,"bindingJson":request.binding_json,"argumentsJson":request.arguments_json,"callScopeJson":request.call_scope_json}),
        )?,
    })
}
async fn retained(
    pool: &sqlx::SqlitePool,
    host: &HostState,
    request: &HostToolInvocation,
    effect: &EngineEffect,
) -> Result<Option<HostToolReceipt>> {
    let found = repository::read_effects(pool, &request.context.work)
        .await?
        .into_iter()
        .find(|stored| stored.registered.effect == effect.effect);
    let Some(found) = found else {
        return Ok(None);
    };
    if !exact_json::record_equal(&found.registered, effect)? {
        return Err(failure(
            "CORRELATION",
            "invocation",
            "Invocation retransmission changed",
        ));
    }
    Ok(Some(if found.status == "ended" {
        HostToolReceipt::Ended {
            result_json: found.result_json.ok_or_else(|| {
                failure("CORRELATION", "result", "Ended Tool has no retained result")
            })?,
            failed: found
                .settlement
                .as_ref()
                .and_then(|settlement| {
                    serde_json::from_str::<Value>(&settlement.evidence_json).ok()
                })
                .and_then(|evidence| evidence.get("failed").and_then(Value::as_bool))
                .ok_or_else(|| {
                    failure(
                        "CORRELATION",
                        "result",
                        "Ended Tool has no outcome evidence",
                    )
                })?,
        }
    } else if found.status == "pending" && host.tools().contains(&key(request)) {
        HostToolReceipt::Pending
    } else {
        HostToolReceipt::Uncertain
    }))
}

/// Compiler and source/configuration lock waits never own the Stop admission gate.
/// The returned guards must stay alive through reservation and physical dispatch.
pub(crate) async fn policy_admission<G>(
    host: &HostState,
    compilation: impl std::future::Future<Output = Result<crate::agsdl_host_compiler::CompileReceipt>>,
    revalidate: impl std::future::Future<Output = Result<G>>,
) -> Result<(
    crate::agsdl_host_compiler::CompileReceipt,
    G,
    tokio::sync::MutexGuard<'_, ()>,
)> {
    let policy = compilation.await?;
    let guards = revalidate.await?;
    let gate = host.admission_gate().await;
    Ok((policy, guards, gate))
}

#[tauri::command]
pub(crate) async fn execution_host_invoke_tool(
    app: tauri::AppHandle,
    webview: Webview,
    host: State<'_, HostState>,
    request: HostToolInvocation,
) -> Result<HostToolReceipt> {
    host.authenticate_owner(&webview, &request.context.owner)?;
    let database = app.state::<crate::core::db_state::DbPool>();
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let capture = repository::capture::read(&pool, &request.context.owner).await?;
    let tool = bound_tool(&capture, &request)?;
    authorize_binding(&pool, &request).await?;
    let effect = effect(&request, &tool)?;
    if let Some(receipt) = retained(&pool, &host, &request, &effect).await? {
        return Ok(receipt);
    }
    let workspace_state = app.state::<crate::WorkspaceMetadataRoot>();
    let workspace = workspace_state.0.read().await.clone();
    let git = app.state::<crate::git::GitState>();
    let scope_guard =
        crate::agsdl_host_provider::scope_guard(&workspace, &request.context, &git).await?;
    let config = app.state::<crate::config::ConfigManager>();
    let policy_lease = config
        .lock_execution_tools(&scope_guard.revision.owner.project_id)
        .await
        .map_err(|_| {
            failure(
                "PERMISSION",
                "policy",
                "Current project tool configuration is unavailable",
            )
        })?;
    let frozen: Value = serde_json::from_str(&request.context.permissions_json)?;
    let mode = frozen
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| failure("CORRELATION", "mode", "Captured mode is absent"))?;
    let current = permissions(
        mode,
        scope_guard.project.user_read_only || scope_guard.project.is_read_only,
        &policy_lease.tools,
    )?;
    let admitted = |permissions: &Value| {
        permissions
            .get("allowedToolIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&tool)))
    };
    if !admitted(&frozen) || !admitted(&current) {
        return Ok(HostToolReceipt::Rejected {
            code: "PERMISSION".into(),
        });
    }
    let scope: Value = serde_json::from_str(&request.context.scope_json)?;
    let root = PathBuf::from(
        scope
            .get("root")
            .and_then(Value::as_str)
            .ok_or_else(|| failure("CORRELATION", "root", "Captured root is absent"))?,
    );
    let root_identity = crate::fs::operations::workspace_root_identity(&root)
        .map_err(|_| failure("CAPTURE_CHANGED", "root", "Root identity is unavailable"))?;
    if root_identity.observation_key().as_deref()
        != scope.get("rootIdentity").and_then(Value::as_str)
    {
        return Err(failure(
            "CAPTURE_CHANGED",
            "root",
            "Root identity changed before Tool dispatch",
        ));
    }
    let args: Value = serde_json::from_str(&request.arguments_json)?;
    let snapshot = repository::read_snapshot(&pool, &request.context.owner.system_start_id).await?;
    let mut registry: Value = serde_json::from_str(&capture.registry_json)?;
    registry["toolPolicyInput"] = json!({"invocationIdentity":key(&request),"toolId":tool,"bindingJson":request.binding_json,
        "argumentsJson":request.arguments_json,"mode":mode,"riskLevel":current["riskLevel"],"capturedRiskLevel":frozen["riskLevel"],"root":root,"allowedToolIds":current["allowedToolIds"]});
    if request.context.work.agent_instance_id.is_none() {
        let inspection = repository::inspection::read(&pool, &request.context.owner).await?;
        let activation = inspection
            .projection
            .activations
            .iter()
            .find(|activation| activation.delivery.delivery.work == request.context.work)
            .ok_or_else(|| failure("CORRELATION", "work", "Call activation is absent"))?;
        let plan: Value = serde_json::from_str(&snapshot.compiled_plan_json)?;
        let address = serde_json::to_value(&request.context.work.step)?;
        let step = plan
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|step| step.get("address") == Some(&address))
            .ok_or_else(|| failure("CORRELATION", "step", "Call step is absent"))?;
        registry["callInput"] = json!({"work":request.context.work,"input":activation.delivery.delivery.input,"declarationJson":step["declarationJson"]});
    } else if request.call_scope_json.is_some() {
        return Err(failure(
            "CORRELATION",
            "callScopeJson",
            "Agent tool cannot replace its actual invocation scope with a Call scope",
        ));
    }
    let expected_revision = scope_guard.revision.clone();
    // Do not fence source edits or policy updates while JavaScript owns a ticket.
    drop(policy_lease);
    drop(scope_guard);
    let registry_json = serde_json::to_string(&registry)?;
    let (policy, (scope_guard, policy_lease), gate) = policy_admission(
        &host,
        host.compile(snapshot.source, snapshot.authored_source, registry_json),
        async {
            let scope_guard =
                crate::agsdl_host_provider::scope_guard(&workspace, &request.context, &git).await?;
            let policy_lease = config
                .lock_execution_tools(&scope_guard.revision.owner.project_id)
                .await
                .map_err(|_| {
                    failure(
                        "PERMISSION",
                        "policy",
                        "Current project tool configuration is unavailable",
                    )
                })?;
            let fresh = permissions(
                mode,
                scope_guard.project.user_read_only || scope_guard.project.is_read_only,
                &policy_lease.tools,
            )?;
            let fresh_root = crate::fs::operations::workspace_root_identity(&root)
                .map_err(|_| failure("CAPTURE_CHANGED", "root", "Root identity is unavailable"))?;
            if scope_guard.revision != expected_revision
                || fresh != current
                || fresh_root.observation_key() != root_identity.observation_key()
            {
                return Err(failure(
                    "CAPTURE_CHANGED",
                    "policy",
                    "Source, scope or policy changed while the Tool ticket was pending",
                ));
            }
            Ok((scope_guard, policy_lease))
        },
    )
    .await?;
    host.authenticate_owner(&webview, &request.context.owner)?;
    // A concurrent invocation may have reserved this exact effect while compiling.
    if let Some(receipt) = retained(&pool, &host, &request, &effect).await? {
        return Ok(receipt);
    }
    authorize_binding(&pool, &request).await?;
    let result: Value = serde_json::from_str(&policy.result_json)?;
    if request.context.work.agent_instance_id.is_none() {
        let prepared = result
            .pointer("/callValidation/prepared")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                failure(
                    "INPUT_CONSTRAINT",
                    "call",
                    "Call preparation failed for the retained input",
                )
            })?;
        for (field, expected) in [
            ("bindingJson", Some(request.binding_json.as_str())),
            ("argumentsJson", Some(request.arguments_json.as_str())),
            ("scopeJson", request.call_scope_json.as_deref()),
        ] {
            let actual = prepared.get(field).and_then(Value::as_str);
            let equal = match (actual, expected) {
                (None, None) => true,
                (Some(a), Some(b)) => exact_json::equal(a, b)?,
                _ => false,
            };
            if !equal {
                return Err(failure(
                    "CORRELATION",
                    field,
                    "Call differs from its captured declaration and durable input",
                ));
            }
        }
        // Scope action/resources are descriptions, not filesystem capabilities.
        // Exact args remain checked by Macro policy against the separate native root.
    }
    let decision = result
        .pointer("/toolPolicy/decision")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            failure(
                "CORRELATION",
                "policy",
                "Native policy ticket has no decision",
            )
        })?;
    host.authenticate_owner(&webview, &request.context.owner)?;
    if decision == "deny" {
        return Ok(HostToolReceipt::Rejected {
            code: result
                .pointer("/toolPolicy/code")
                .and_then(Value::as_str)
                .unwrap_or("PERMISSION")
                .into(),
        });
    }
    let previous_approval = repository::approvals::existing(&pool, &effect).await?;
    let registered = if decision == "ask" || previous_approval.is_some() {
        let summary = result
            .pointer("/toolPolicy/summary")
            .and_then(Value::as_str)
            .unwrap_or("Tool invocation requires approval");
        let approval = if let Some(previous) = previous_approval {
            previous
        } else {
            repository::approvals::request(
                &pool,
                repository::approvals::Request {
                    effect: effect.clone(),
                    tool_name: tool.clone(),
                    summary: summary.into(),
                },
            )
            .await?
        };
        match approval.status.as_str() {
            "pending" => return Ok(HostToolReceipt::AwaitingApproval { approval }),
            "cancelled" => {
                return Ok(HostToolReceipt::Rejected {
                    code: "STOP_CANCELLED".into(),
                })
            }
            "denied" => {
                return Ok(HostToolReceipt::Rejected {
                    code: "PERMISSION".into(),
                })
            }
            "approved" | "consumed" => {
                repository::approvals::consume_and_register(
                    &pool,
                    &approval.approval_id,
                    effect.clone(),
                )
                .await?
            }
            _ => {
                return Err(failure(
                    "CORRELATION",
                    "approval",
                    "Unexpected approval state",
                ))
            }
        }
    } else {
        repository::register_effect(&pool, effect.clone()).await?
    };
    if !registered {
        return retained(&pool, &host, &request, &effect)
            .await?
            .ok_or_else(|| failure("CORRELATION", "effect", "Reservation receipt is absent"));
    }
    repository::authorize_reserved_effect(&pool, &effect).await?;
    // No fallible await remains between the final caller check and owned dispatch.
    host.authenticate_owner(&webview, &request.context.owner)?;
    let execution_key = key(&request);
    if !host.tools().insert(execution_key.clone()) {
        return Err(failure(
            "CORRELATION",
            "effect",
            "Physical Tool was already admitted",
        ));
    }
    let owned_git = git.inner().clone();
    let mode = mode.to_owned();
    let owned_app = app.clone();
    let metadata_workspace = workspace.clone();
    let expected_roots = Arc::new(BTreeMap::from([(root.clone(), root_identity)]));
    // Spawn before releasing admission. The executor survives a dropped IPC future.
    tokio::spawn(async move {
        let owned_key = execution_key.clone();
        // Guards belong to the owned executor, not the requesting IPC future.
        let result = std::panic::AssertUnwindSafe(async move {
            let _scope_guard = scope_guard;
            let _policy_lease = policy_lease;
            crate::core::workspace_execution::execute_workspace_tool_owned(
                root,
                metadata_workspace,
                owned_git,
                mode,
                tool,
                args,
                owned_key,
                expected_roots,
            )
            .await
        })
        .catch_unwind()
        .await;
        let (result_json, failed) = match result {
            Ok(Ok(value)) => (serde_json::to_string(&value).ok(), false),
            Ok(Err(error)) => (serde_json::to_string(&error.message).ok(), true),
            Err(_) => (None, true),
        };
        let status = if result_json.is_some() {
            "ended"
        } else {
            "uncertain"
        };
        let settlement=EngineSettlement {context:request.context,effect:effect.effect,status:status.into(),
            evidence_json:json!({"kind":"macro-owned-workspace/1","executionId":execution_key,"status":status,"failed":failed}).to_string()};
        let _ = repository::settle_effect(&pool, settlement, result_json).await;
        owned_app
            .state::<HostState>()
            .tools()
            .remove(&execution_key);
    });
    drop(gate);
    Ok(HostToolReceipt::Pending)
}
pub(crate) fn cancel(effect: &EngineEffect) {
    if let EngineEffectIdentity::Tool {
        tool_invocation_id,
        provider_attempt_id,
    } = &effect.effect
    {
        let request = HostToolInvocation {
            context: effect.context.clone(),
            tool_invocation_id: tool_invocation_id.clone(),
            provider_attempt_id: provider_attempt_id.clone(),
            binding_json: String::new(),
            arguments_json: String::new(),
            call_scope_json: None,
        };
        // This is a cancellation request only. Settlement belongs to the owned future.
        crate::core::workspace_execution::tool_cancel_workspace(key(&request));
    }
}
