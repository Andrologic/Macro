//! Native completion checks behind the existing work-event port.
use crate::{
    agsdl_host::HostState,
    agsdl_host_calls::{self as calls, CommandGrant, Control, PhysicalEvidence},
    agsdl_host_confinement::{FileAccess, OsCeiling, PathScope, SandboxPolicy},
    agsdl_host_flow030::FlowWorkAttempt030,
    agsdl_host_work_admission030::{codex_read_only030, PolicyLeases030},
    host::HostContext,
    permissions::{evaluate_effective, ActionRequest, Effect, EffectivePolicy, ExecutionPurpose},
    persistence::{failure, flow_work_protocol030, work_dto030::CheckRequest030, Result},
    tasks::StreamTasks,
};
use serde_json::{json, Value};
use sqlx::{Connection, SqlitePool};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

/// The same effective ceiling as the agent, including write-ask regions which
/// an unmediated shell must keep read-only. Runtime files grant no user data.
pub(crate) fn grant(policy: &EffectivePolicy, command: &str) -> Result<CommandGrant> {
    grant_scoped(policy, command, false)
}

fn grant_scoped(
    policy: &EffectivePolicy,
    command: &str,
    project_read_only: bool,
) -> Result<CommandGrant> {
    let read_only = codex_read_only030(policy)? || project_read_only;
    let decision = evaluate_effective(
        policy,
        &ActionRequest::Shell {
            command: command.into(),
        },
        ExecutionPurpose::CompletionCheck,
    )
    .map_err(|_| {
        failure(
            "PERMISSION",
            "completionCheck",
            "Cannot evaluate completion-check permissions",
        )
    })?;
    if decision.effect != Effect::Allow {
        return Err(failure(
            "HARNESS_CAPABILITY",
            "completionCheck",
            "The completion check requires an allowed shell action; shell ask is not represented",
        ));
    }
    let root = policy
        .policies()
        .next()
        .ok_or_else(|| failure("PERMISSION", "completionCheck", "No check ceiling"))?
        .context()
        .workspace
        .clone();
    if root.canonicalize().ok().as_ref() != Some(&root) {
        return Err(failure(
            "PERMISSION",
            "completionCheck",
            "Check workspace changed",
        ));
    }
    let mut read = vec![
        PathScope::Literal(PathBuf::from("/")),
        PathScope::Subtree(root.clone()),
    ];
    for path in [
        "/bin",
        "/usr/bin",
        "/usr/lib",
        "/System/Library",
        "/private/var/select",
    ] {
        if Path::new(path).exists() {
            read.push(PathScope::Subtree(Path::new(path).canonicalize().map_err(
                |_| failure("PERMISSION", "completionCheck", "Runtime path unavailable"),
            )?));
        }
    }
    read.push(PathScope::Literal("/dev/null".into()));
    let mut write = vec![PathScope::Literal("/dev/null".into())];
    if !read_only {
        write.push(PathScope::Subtree(root.clone()));
    }
    let block = [".macro"]
        .into_iter()
        .filter_map(|name| {
            let path = root.join(name);
            path.exists()
                .then(|| path.canonicalize().ok().map(PathScope::Subtree))
                .flatten()
        })
        .collect();
    let write_block = [".macro", ".git", ".agents", ".codex", ".aws"]
        .into_iter()
        .filter_map(|name| {
            let path = root.join(name);
            path.exists()
                .then(|| path.canonicalize().ok().map(PathScope::Subtree))
                .flatten()
        })
        .collect();
    let sandbox = SandboxPolicy::from_authorized_ceilings(
        policy.fingerprint(),
        &[OsCeiling {
            read: FileAccess { allow: read, block },
            write: FileAccess {
                allow: write,
                block: write_block,
            },
            network: false,
        }],
    )
    .map_err(|detail| failure("HOST_CAPABILITY", "completionCheck", &detail))?;
    Ok(CommandGrant {
        workspace: root,
        environment: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        sandbox,
    })
}

pub(crate) async fn execute(
    host: &HostState,
    pool: &SqlitePool,
    config: &HostContext,
    tasks: &StreamTasks,
    attempt: &FlowWorkAttempt030,
    project: &str,
    check: &CheckRequest030,
    cancelled: &CancellationToken,
) -> Result<Value> {
    let policies = PolicyLeases030::acquire(config, project).await?;
    let lease = host.start_lease().await?;
    let gate = host.admission_lock().lock_owned().await;
    let parent = format!(
        "flow030:{}:{}",
        attempt.identity().system_start_id,
        attempt.start_effect_id()
    );
    tasks
        .verify_agent_scope030(&parent, attempt)
        .map_err(|_| failure("AUTHORITY", "completionCheck", "Check parent is not owned"))?;
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let (context, policy) =
        flow_work_protocol030::claim_check030(&mut tx, &lease, attempt, check, &policies).await?;
    let scope: Value = serde_json::from_str(&context.scope_json)?;
    let root = policy
        .policies()
        .next()
        .ok_or_else(|| failure("PERMISSION", "completionCheck", "Missing workspace"))?
        .context()
        .workspace
        .clone();
    let identity = crate::content_io::admitted::workspace_root_identity(&root)
        .map_err(|_| failure("PERMISSION", "completionCheck", "Workspace unavailable"))?
        .observation_key();
    if scope["root"] != json!(root)
        || scope["rootIdentity"].as_str() != identity.as_deref()
        || identity.is_none()
        || scope["projectId"] != policies.project_id()
    {
        return Err(failure(
            "CORRELATION",
            "completionCheck",
            "Check workspace identity or project changed",
        ));
    }
    let request: Value = serde_json::from_str(&check.invocation_json)?;
    let command = request["command"]
        .as_str()
        .ok_or_else(|| failure("CORRELATION", "completionCheck", "Missing command"))?;
    let captured_permissions: Value = serde_json::from_str(&context.permissions_json)?;
    let project_read_only = crate::tool_policy::agsdl_native_read_only(&captured_permissions)
        || policies
            .project_tools()
            .get("readOnly")
            .and_then(Value::as_bool)
            == Some(true);
    let grant = grant_scoped(&policy, command, project_read_only)?;
    let limit_ms = request["timeoutMs"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(|| failure("CORRELATION", "completionCheck", "Invalid check duration"))?;
    let output_limit = request["maxOutputBytes"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| {
            failure(
                "CORRELATION",
                "completionCheck",
                "Invalid check output limit",
            )
        })?;
    lease.ensure_live()?;
    tx.commit().await?;
    if cancelled.is_cancelled() {
        return Err(failure(
            "STOPPED",
            "completionCheck",
            "Work stopped before check launch",
        ));
    }
    let child = grant
        .sandbox
        .spawn(
            Path::new("/bin/sh"),
            &["-c".into(), command.into()],
            &grant.workspace,
            &grant.environment,
        )
        .map_err(|detail| failure("HARNESS_REFUSED", "completionCheck", &detail))?;
    let control = Control {
        stop: cancelled.child_token(),
        machine_timeout: CancellationToken::new(),
    };
    let stop_on_drop = control.stop.clone().drop_guard();
    let (send, receive) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        let result = calls::run_command(
            child,
            &grant.sandbox,
            &control,
            Some((output_limit, Duration::from_millis(limit_ms))),
        )
        .await;
        let joined = matches!(
            &result.2,
            PhysicalEvidence::Local {
                leader_reaped: true,
                tree_termination_succeeded: true,
                streams_joined: true,
                ..
            }
        );
        let _ = send.send(result);
        if joined {
            Ok(())
        } else {
            Err("Completion-check physical end is uncertain".into())
        }
    });
    tasks
        .attach_cleanup030(&parent, worker)
        .map_err(|detail| failure("UNCERTAIN", "completionCheck", &detail))?;
    drop(db);
    drop(gate);
    drop(lease);
    drop(policies);
    let (receipt, error, evidence) = receive
        .await
        .map_err(|_| failure("UNCERTAIN", "completionCheck", "Check owner was lost"))?;
    drop(stop_on_drop);
    let ended = matches!(
        evidence,
        PhysicalEvidence::Local {
            leader_reaped: true,
            tree_termination_succeeded: true,
            streams_joined: true,
            ..
        }
    );
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = Value::Null;
    let mut truncated = false;
    if let Some(receipt) = receipt {
        truncated = receipt.truncated;
        stdout = receipt.stdout;
        stderr = receipt.stderr;
        exit_code = serde_json::from_str(&receipt.exit_code_json)?;
    }
    if let Some(error) = error {
        exit_code = Value::Null;
        stderr.push_str(&format!("\n{}: {}", error.code, error.detail));
    }
    Ok(
        json!({"kind":"checkEnded","checkId":check.check_id,"physicalState":if ended {"ended"} else {"uncertain"},"exitCode":exit_code,"stdout":stdout,"stderr":stderr,"truncated":truncated}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{normalize_requested, PathContext};

    fn policy(root: &Path, requested: Value) -> EffectivePolicy {
        let context = PathContext {
            workspace: root.into(),
            home: root.into(),
        };
        let normalize = |value| {
            normalize_requested(serde_json::from_value(value).unwrap(), context.clone()).unwrap()
        };
        let host = normalize(json!("workspace"));
        EffectivePolicy::new(normalize(requested), host.clone(), host)
    }

    #[tokio::test]
    async fn native_check_timeout_output_bounds_stop_and_write_ask_ceiling() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let effective = policy(
            &root,
            json!({"preset":"workspace","rules":[{"action":"write","effect":"ask"}]}),
        );
        for stopped in [false, true] {
            std::fs::remove_file(root.join("started")).ok();
            let command = "printf 123456789; printf abcdefghi >&2; : > started; sleep 30";
            let grant = grant(&policy(&root, json!("workspace")), command).unwrap();
            let child = grant
                .sandbox
                .spawn(
                    Path::new("/bin/sh"),
                    &["-c".into(), command.into()],
                    &grant.workspace,
                    &grant.environment,
                )
                .unwrap();
            let control = Control {
                stop: CancellationToken::new(),
                machine_timeout: CancellationToken::new(),
            };
            if stopped {
                let stop = control.stop.clone();
                let ready = root.join("started");
                tokio::spawn(async move {
                    while !ready.exists() {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    stop.cancel();
                });
            }
            let (receipt, error, evidence) = calls::run_command(
                child,
                &grant.sandbox,
                &control,
                Some((
                    4,
                    if stopped {
                        Duration::from_secs(3)
                    } else {
                        Duration::from_millis(100)
                    },
                )),
            )
            .await;
            assert_eq!(
                error.unwrap().code,
                if stopped { "STOPPED" } else { "CHECK_TIMEOUT" }
            );
            assert!(matches!(
                evidence,
                PhysicalEvidence::Local {
                    leader_reaped: true,
                    tree_termination_succeeded: true,
                    streams_joined: true,
                    ..
                }
            ));
            if let Some(receipt) = receipt {
                assert!(receipt.stdout.len() <= 4 && receipt.stderr.len() <= 4);
            }
        }
        let command = "printf forbidden > marker";
        let grant = grant(&effective, command).unwrap();
        let child = grant
            .sandbox
            .spawn(
                Path::new("/bin/sh"),
                &["-c".into(), command.into()],
                &grant.workspace,
                &grant.environment,
            )
            .unwrap();
        let (receipt, error, _) = calls::run_command(
            child,
            &grant.sandbox,
            &Control {
                stop: CancellationToken::new(),
                machine_timeout: CancellationToken::new(),
            },
            Some((1024, Duration::from_secs(2))),
        )
        .await;
        assert!(error.is_none());
        assert_ne!(receipt.unwrap().exit_code_json, "0");
        assert!(!root.join("marker").exists());
        let readonly = policy(&root, json!("read-only"));
        assert!(super::grant(&readonly, "true").is_err());
    }
}
