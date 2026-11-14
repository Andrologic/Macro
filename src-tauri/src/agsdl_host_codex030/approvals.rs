//! One native command, one bounded filesystem overlay, one human answer.
use super::*;
use crate::{agsdl_host_flow030::FlowWorkAttempt030, agsdl_permissions::*};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

pub(crate) type Respond030<'a> = Box<dyn FnOnce(bool) -> BoxFuture<'a, HostResult<()>> + Send + 'a>;

/// The existing human broker owns identity, deadlines and the final send gate.
pub(crate) trait CommandApprovals030: Send + Sync {
    fn answer<'a>(
        &'a self,
        work: &'a FlowWorkAttempt030,
        payload: Value,
        cancel: &'a CancellationToken,
        respond: Respond030<'a>,
    ) -> BoxFuture<'a, HostResult<()>>;
}

/// The upstream module describes generic patch approvals. This adapter instead
/// denies writes in the native sandbox until a bounded command overlay is granted.
/// Document/admission gates still reject every other write-ask configuration.
pub(crate) fn module030() -> String {
    let mut module: Value =
        serde_json::from_str(argentic_core::harness_module("codex").expect("bundled Codex module"))
            .expect("bundled Codex module");
    module["permissions"]["write"]["ask"] = json!("sandbox");
    module["permissions"]["write"]["note"] = json!("Macro's qualified profile keeps workspace writes denied by the native sandbox. A person may grant one command access to one existing regular workspace file, after native request correlation and ceiling checks. Other write grants and rule shapes are refused by native preflight and admission.");
    module["properties"]["skills"]["note"]=json!("Macro admits selected single-file local skills through scoped native reads. The native agsdl_load_skill tool returns captured bytes only for the current work's selected names, without extra filesystem grants. Folders with resources, scripts or links remain unsupported.");
    module["properties"]["mcpServers"] = json!({"support":"absent","note":"Agent MCP equipment is not qualified for correlated human waits and physical completion in this adapter. Local stdio MCP flow calls use the separate confined native call port."});
    module.to_string()
}

pub(super) fn enabled(policy: &EffectivePolicy) -> bool {
    policy.policies().any(|p| {
        p.rules()
            .iter()
            .any(|r| r.action == Action::Write && r.effect == Effect::Ask)
    })
}

/// Unknown commands, grants and filesystem objects never become approvals.
/// A file grant is confined to this command; turn/session grants are not used.
pub(super) fn bounded_file(
    request: &Value,
    thread: &str,
    turn: &str,
    root: &Path,
    policy: &EffectivePolicy,
) -> Option<String> {
    if policy
        .policies()
        .any(|p| p.reviewer() == Some(Reviewer::Model))
    {
        return None;
    }
    if request["method"] != "item/commandExecution/requestApproval"
        || request.get("id").is_none()
        || request["params"]["threadId"] != thread
        || request["params"]["turnId"] != turn
        || request["params"]["kind"] != "command"
        || request["params"]["environmentId"] != "local"
        || request["params"]["itemId"].as_str()?.is_empty()
        || !request["params"]["approvalId"].is_null()
        || !request["params"]["networkApprovalContext"].is_null()
    {
        return None;
    }
    let params = &request["params"];
    let command = params["command"]
        .as_str()
        .filter(|s| !s.trim().is_empty())?;
    let cwd = Path::new(params["cwd"].as_str()?);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return None;
    }
    let file = params
        .pointer("/additionalPermissions/fileSystem/write/0")?
        .as_str()?;
    let path = Path::new(file);
    // Existing regular files only. No directories, aliases or protected metadata.
    if !path.is_absolute()
        || path.canonicalize().ok()? != path
        || !path.is_file()
        || path.symlink_metadata().ok()?.file_type().is_symlink()
    {
        return None;
    }
    #[cfg(unix)]
    if path.metadata().ok()?.nlink() != 1 {
        return None;
    }
    let relative = path.strip_prefix(root).ok()?;
    // Exclude hidden paths altogether, including case aliases of metadata on
    // case-insensitive filesystems. Do not grant a more general metadata rule.
    if relative.components().any(|part| {
        part.as_os_str()
            .to_str()
            .is_none_or(|name| name.starts_with('.'))
    }) {
        return None;
    }
    let expected = json!({"network":null,"fileSystem":{"read":null,"write":[file],"entries":[{"path":{"type":"path","path":file},"access":"write"}]}});
    if params["additionalPermissions"] != expected {
        return None;
    }
    let shell = evaluate_effective(
        policy,
        &ActionRequest::Shell {
            command: command.into(),
        },
        ExecutionPurpose::Agent,
    )
    .ok()?;
    let write = evaluate_effective(
        policy,
        &ActionRequest::Write { path: file.into() },
        ExecutionPurpose::Agent,
    )
    .ok()?;
    if shell.effect != Effect::Allow
        || write.effect != Effect::Ask
        || write.reviewer == Some(Reviewer::Model)
        || write.resolved_path.as_deref() != Some(file)
    {
        return None;
    }
    Some(file.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_overlay_preserves_all_ceilings_and_refuses_unknown_or_broader_requests() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("sentinel");
        std::fs::write(&path, "before").unwrap();
        let file = path.to_str().unwrap();
        let context = PathContext {
            workspace: root.clone(),
            home: root.clone(),
        };
        let normalize =
            |v| normalize_requested(serde_json::from_value(v).unwrap(), context.clone()).unwrap();
        let requested = normalize(
            json!({"preset":"workspace","reviewer":"person","rules":[{"action":"write","effect":"ask"}]}),
        );
        let host = normalize(json!("workspace"));
        let policy = EffectivePolicy::new(requested.clone(), host.clone(), host);
        assert!(crate::agsdl_host_work_admission030::codex_read_only030(&policy).unwrap());
        let native = json!({"method":"item/commandExecution/requestApproval","id":0,"params":{
            "threadId":"thread","turnId":"turn","kind":"command","environmentId":"local","itemId":"item","command":"synthetic command","cwd":root,
            "additionalPermissions":{"network":null,"fileSystem":{"read":null,"write":[file],"entries":[{"path":{"type":"path","path":file},"access":"write"}]}}}});
        assert_eq!(
            bounded_file(&native, "thread", "turn", &root, &policy).as_deref(),
            Some(file)
        );
        for (pointer, value) in [
            ("/params/command", Value::Null),
            ("/params/command", json!(" ")),
            ("/params/threadId", json!("another")),
            ("/params/turnId", json!("another")),
            ("/params/kind", json!("writeStdin")),
            ("/params/approvalId", json!("subcommand")),
            (
                "/params/additionalPermissions/network",
                json!({"enabled":true}),
            ),
            (
                "/params/additionalPermissions/fileSystem/read",
                json!([file]),
            ),
            (
                "/params/additionalPermissions/fileSystem/write",
                json!([file, file]),
            ),
            (
                "/params/additionalPermissions/fileSystem/entries",
                json!([]),
            ),
            ("/method", json!("item/permissions/requestApproval")),
        ] {
            let mut substituted = native.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            substituted
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(key.into(), value);
            assert!(
                bounded_file(&substituted, "thread", "turn", &root, &policy).is_none(),
                "{pointer}"
            );
        }
        let denied = normalize(json!("read-only"));
        let narrowed = EffectivePolicy::new(requested.clone(), denied.clone(), denied);
        assert!(bounded_file(&native, "thread", "turn", &root, &narrowed).is_none());
        let model = normalize(json!({"preset":"workspace","reviewer":"model"}));
        let narrowed = EffectivePolicy::new(requested, model.clone(), model);
        assert!(bounded_file(&native, "thread", "turn", &root, &narrowed).is_none());
        let hidden = root.join(".hidden");
        std::fs::rename(&path, &hidden).unwrap();
        let mut hidden_request = native.clone();
        hidden_request["params"]["additionalPermissions"]["fileSystem"]["write"][0] = json!(hidden);
        hidden_request["params"]["additionalPermissions"]["fileSystem"]["entries"][0]["path"]
            ["path"] = json!(hidden);
        assert!(bounded_file(&hidden_request, "thread", "turn", &root, &policy).is_none());
        std::fs::rename(&hidden, &path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(bounded_file(&native, "thread", "turn", &root, &policy).is_none());
    }
}
