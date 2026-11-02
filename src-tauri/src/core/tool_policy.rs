use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct ToolValidationResult {
    pub allowed: bool,
    pub reason: Option<String>,
    pub enforce_macro_only_writes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct ToolModePolicyResult {
    pub allowed_tool_ids: Vec<String>,
    pub enforce_macro_only_writes: bool,
    pub capabilities: Vec<String>,
}

const TOOL_MODE_CAPABILITIES: &[&str] = &[
    "content_revisions_v1",
    "bounded_tool_output_v1",
    "bounded_git_output_v1",
    "structural_search_v1",
    "recoverable_checkpoints_v1",
    "idempotent_tool_execution_v1",
];

fn architect_allowed_tool_ids() -> &'static [&'static str] {
    &[
        "question",
        "config_list",
        "config_get",
        "config_validate",
        "config_patch",
        "skill_activate",
        "skill_read_resource",
        "skill_run_script",
        "read_file",
        "web_search",
        "web_fetch",
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
        "plan_create",
        "plan_list",
        "plan_get",
        "plan_update",
        "agsdl_get",
        "agsdl_update",
    ]
}

fn normalize_architect_tool_id(tool_id: &str) -> &str {
    match tool_id {
        "generate_plan" => "strategy_generate",
        "create_plan" => "plan_create",
        "list_plans" => "plan_list",
        "get_plan" => "plan_get",
        "update_plan" => "plan_update",
        "delete_plan" => "plan_delete",
        "restore_plan" => "plan_restore",
        "set_active_plan" => "plan_set_active",
        "get_strategy" => "strategy_get",
        "update_strategy" => "strategy_update",
        "delete_strategy" => "strategy_delete",
        _ => tool_id,
    }
}

fn chat_allowed_tool_ids() -> &'static [&'static str] {
    &[
        "question",
        "config_list",
        "config_get",
        "config_validate",
        "config_patch",
        "skill_activate",
        "skill_read_resource",
        "skill_run_script",
        "mark_source_passage",
        "read_sources",
        "edit_source_passage",
        "read_file",
        "web_search",
        "web_fetch",
        "terminal_create_session",
        "terminal_run",
        "terminal_read",
        "terminal_kill",
    ]
}

fn implement_allowed_tool_ids() -> &'static [&'static str] {
    &[
        "question",
        "config_list",
        "config_get",
        "config_validate",
        "config_patch",
        "skill_activate",
        "skill_read_resource",
        "skill_run_script",
        "read_file",
        "web_search",
        "web_fetch",
        "list",
        "read",
        "glob",
        "grep",
        "ast_grep",
        "write",
        "edit",
        "delete",
        "apply_patch",
        "task_todo_get",
        "task_todo_update",
        "task_artifact_list",
        "task_artifact_get",
        "task_artifact_put",
        "git_status",
        "git_log",
        "git_branch_list",
        "git_diff",
        "git_get_tree",
        "git_add",
        "git_commit",
        "git_checkout",
        "git_merge",
        "git_reset",
        "git_stash",
        "terminal_create_session",
        "terminal_run",
        "terminal_read",
        "terminal_kill",
    ]
}

fn is_write_tool(tool_id: &str) -> bool {
    matches!(tool_id, "write" | "edit" | "delete" | "apply_patch")
}

fn is_mcp_tool_id(tool_id: &str) -> bool {
    let parts: Vec<&str> = tool_id.split("__").collect();
    parts.len() >= 3 && parts.first() == Some(&"mcp") && parts[1].len() > 0 && parts[2].len() > 0
}

fn normalize_relative_path_parts(raw_path: &str) -> Option<Vec<String>> {
    let mut normalized = raw_path.trim().replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }

    if normalized.is_empty() {
        return None;
    }

    if normalized.starts_with('/') || normalized.get(1..3) == Some(":/") {
        return None;
    }

    let mut resolved = Vec::new();
    for part in normalized.split('/').filter(|part| !part.is_empty()) {
        match part {
            "." => {}
            ".." => {
                if resolved.is_empty() {
                    return None;
                }
                resolved.pop();
            }
            _ => resolved.push(part.to_string()),
        }
    }

    if resolved.is_empty() {
        None
    } else {
        Some(resolved)
    }
}

pub fn is_macro_scoped_path(raw_path: &str) -> bool {
    normalize_relative_path_parts(raw_path)
        .map(|resolved| {
            resolved
                .first()
                .map(|part| part == ".macro")
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn is_metadata_relative_path(raw_path: &str) -> bool {
    // Architect mutations select the metadata workspace before FS resolution,
    // so this contract is root-relative. `.macro/...` is reserved for the
    // virtual project-root addressing used by reads/listings and FS callers.
    normalize_relative_path_parts(raw_path)
        .map(
            |resolved| match resolved.first().map(|part| part.as_str()) {
                Some("workspace.json") => resolved.len() == 1,
                Some("branches") => true,
                _ => false,
            },
        )
        .unwrap_or(false)
}

fn resolve_mode_policy(mode: &str) -> Option<(&'static [&'static str], bool)> {
    match mode.trim() {
        "Architect" => Some((architect_allowed_tool_ids(), true)),
        "Chat" => Some((chat_allowed_tool_ids(), false)),
        "Implement" => Some((implement_allowed_tool_ids(), false)),
        _ => None,
    }
}

pub fn get_mode_policy(mode: &str) -> ToolModePolicyResult {
    let Some((allowed_tool_ids, enforce_macro_only_writes)) = resolve_mode_policy(mode) else {
        return ToolModePolicyResult {
            allowed_tool_ids: vec![],
            enforce_macro_only_writes: false,
            capabilities: TOOL_MODE_CAPABILITIES
                .iter()
                .map(|value| value.to_string())
                .collect(),
        };
    };

    ToolModePolicyResult {
        allowed_tool_ids: allowed_tool_ids.iter().map(|id| id.to_string()).collect(),
        enforce_macro_only_writes,
        capabilities: TOOL_MODE_CAPABILITIES
            .iter()
            .map(|value| value.to_string())
            .collect(),
    }
}

pub fn validate_tool_execution(
    mode: &str,
    tool_id: &str,
    path: Option<&str>,
) -> ToolValidationResult {
    let mode = mode.trim();
    let tool_id = normalize_architect_tool_id(tool_id.trim());

    let Some((allowed_tool_ids, enforce_macro_only_writes)) = resolve_mode_policy(mode) else {
        return ToolValidationResult {
            allowed: false,
            reason: Some(format!("Unknown mode: {}", mode)),
            enforce_macro_only_writes: false,
        };
    };

    if !allowed_tool_ids.contains(&tool_id) && !is_mcp_tool_id(tool_id) {
        return ToolValidationResult {
            allowed: false,
            reason: Some(format!(
                "Tool '{}' is not allowed in mode '{}'",
                tool_id, mode
            )),
            enforce_macro_only_writes,
        };
    }

    if enforce_macro_only_writes && is_write_tool(tool_id) {
        match path {
            Some(candidate_path) if is_metadata_relative_path(candidate_path) => {}
            Some(candidate_path) => {
                return ToolValidationResult {
                    allowed: false,
                    reason: Some(format!(
                    "Architect mode can only edit metadata files in the @macro root. Received: {}",
                    candidate_path
                )),
                    enforce_macro_only_writes,
                }
            }
            None => {
                if tool_id == "apply_patch" {
                    return ToolValidationResult {
                        allowed: true,
                        reason: None,
                        enforce_macro_only_writes,
                    };
                }
                return ToolValidationResult {
                    allowed: false,
                    reason: Some(
                        "Architect mode requires a target path for write/edit/apply_patch tools"
                            .to_string(),
                    ),
                    enforce_macro_only_writes,
                };
            }
        }
    }

    ToolValidationResult {
        allowed: true,
        reason: None,
        enforce_macro_only_writes,
    }
}

#[cfg(test)]
mod tests {
    use super::{get_mode_policy, validate_tool_execution};

    #[test]
    fn chat_policy_exposes_question_and_terminal_tools() {
        let policy = get_mode_policy("Chat");
        assert_eq!(
            policy.allowed_tool_ids,
            vec![
                "question".to_string(),
                "config_list".to_string(),
                "config_get".to_string(),
                "config_validate".to_string(),
                "config_patch".to_string(),
                "skill_activate".to_string(),
                "skill_read_resource".to_string(),
                "skill_run_script".to_string(),
                "mark_source_passage".to_string(),
                "read_sources".to_string(),
                "edit_source_passage".to_string(),
                "read_file".to_string(),
                "web_search".to_string(),
                "web_fetch".to_string(),
                "terminal_create_session".to_string(),
                "terminal_run".to_string(),
                "terminal_read".to_string(),
                "terminal_kill".to_string()
            ]
        );
        assert!(policy.allowed_tool_ids.contains(&"question".to_string()));
        assert!(policy
            .allowed_tool_ids
            .contains(&"skill_activate".to_string()));
        assert!(policy
            .allowed_tool_ids
            .contains(&"skill_read_resource".to_string()));
        assert!(policy
            .allowed_tool_ids
            .contains(&"skill_run_script".to_string()));
        assert!(policy
            .allowed_tool_ids
            .contains(&"mark_source_passage".to_string()));
        assert!(policy
            .allowed_tool_ids
            .contains(&"read_sources".to_string()));
        assert!(policy
            .allowed_tool_ids
            .contains(&"edit_source_passage".to_string()));
        assert!(!policy.allowed_tool_ids.contains(&"write".to_string()));
        assert!(!policy.allowed_tool_ids.contains(&"git_commit".to_string()));
        assert!(policy
            .allowed_tool_ids
            .contains(&"terminal_run".to_string()));
        assert!(!policy.allowed_tool_ids.contains(&"plan_create".to_string()));
        assert!(!policy
            .allowed_tool_ids
            .contains(&"strategy_generate".to_string()));
    }

    #[test]
    fn agsdl_authoring_is_scoped_to_architect() {
        for tool in ["agsdl_get", "agsdl_update"] {
            assert!(get_mode_policy("Architect")
                .allowed_tool_ids
                .contains(&tool.to_string()));
            assert!(!get_mode_policy("Chat")
                .allowed_tool_ids
                .contains(&tool.to_string()));
            assert!(!get_mode_policy("Implement")
                .allowed_tool_ids
                .contains(&tool.to_string()));
        }
    }

    #[test]
    fn architect_policy_exposes_question_tool() {
        let policy = get_mode_policy("Architect");
        assert!(policy.allowed_tool_ids.contains(&"question".to_string()));
        assert!(policy.allowed_tool_ids.contains(&"ast_grep".to_string()));
        assert!(policy
            .capabilities
            .contains(&"structural_search_v1".to_string()));
    }

    #[test]
    fn implement_policy_exposes_question_tool() {
        let policy = get_mode_policy("Implement");
        assert!(policy.allowed_tool_ids.contains(&"question".to_string()));
        assert!(policy.allowed_tool_ids.contains(&"ast_grep".to_string()));
    }

    #[test]
    fn metadata_path_policy_accepts_only_root_relative_architect_writes() {
        for tool_id in ["write", "edit", "delete", "apply_patch"] {
            for path in [
                "workspace.json",
                "./workspace.json",
                "branches/main/plans/index.json",
                "./branches/main/plans/plan-1/plan.md",
                "branches/main/../develop/plans/index.json",
            ] {
                assert!(
                    validate_tool_execution("Architect", tool_id, Some(path)).allowed,
                    "expected metadata path to be allowed for {tool_id}: {path}"
                );
            }

            for path in [
                ".macro/workspace.json",
                ".macro/branches/main/plan.md",
                "workspace.json/neighbor",
                "workspace.json.bak",
                "branch/main/plan.md",
                "branches/../../src/App.tsx",
                "branches/main/../../../src/App.tsx",
                ".git/config",
                "../src/App.tsx",
                "/branches/main/plan.md",
                "C:/repo/branches/main/plan.md",
                "src/App.tsx",
            ] {
                assert!(
                    !validate_tool_execution("Architect", tool_id, Some(path)).allowed,
                    "expected non-metadata path to be rejected for {tool_id}: {path}"
                );
            }
        }
    }
}

/// Resolve existing ancestors as well as existing files, preserving OS symlink/.. semantics.
fn permission_path(root: &std::path::Path, raw: &str) -> Option<std::path::PathBuf> {
    use std::path::{Component, PathBuf};
    let input = if let Some(rest) = raw.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?)
            .join(rest)
    } else {
        root.join(raw)
    };
    let mut resolved = PathBuf::new();
    for component in input.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => {
                resolved.push(other.as_os_str());
                match std::fs::canonicalize(&resolved) {
                    Ok(path) => resolved = path,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        if std::fs::symlink_metadata(&resolved)
                            .is_ok_and(|meta| meta.file_type().is_symlink())
                        {
                            return None;
                        }
                    }
                    Err(_) => return None,
                }
            }
        }
    }
    Some(resolved)
}

fn permission_glob(pattern: &[u8], path: &[u8]) -> bool {
    // Dynamic programming avoids exponential backtracking on untrusted patterns.
    let mut row = vec![false; path.len() + 1];
    row[0] = true;
    let mut i = 0;
    while i < pattern.len() {
        let mut next = vec![false; path.len() + 1];
        if pattern[i] == b'*' {
            let cross = pattern.get(i + 1) == Some(&b'*');
            if cross {
                i += 1;
            }
            next[0] = row[0];
            for j in 0..path.len() {
                next[j + 1] = row[j + 1] || (next[j] && (cross || path[j] != b'/'));
            }
            if cross && pattern.get(i + 1) == Some(&b'/') {
                let star = next.clone();
                for j in 1..=path.len() {
                    next[j] = row[j] || (star[j - 1] && path[j - 1] == b'/');
                }
                i += 1;
            }
        } else {
            for j in 0..path.len() {
                next[j + 1] = row[j] && pattern[i] == path[j];
            }
        }
        row = next;
        i += 1;
    }
    row[path.len()]
}

/// All targets are admitted together before the workspace executor can mutate anything.
pub(crate) fn agsdl_write_denied(
    root: &std::path::Path,
    tool: &str,
    args: &serde_json::Value,
    permissions: &serde_json::Value,
) -> bool {
    if !is_write_tool(tool) {
        return false;
    }
    let mut paths = Vec::new();
    if tool == "apply_patch" {
        for line in args["patch_text"].as_str().unwrap_or("").lines() {
            for prefix in [
                "*** Add File: ",
                "*** Update File: ",
                "*** Delete File: ",
                "*** Move to: ",
            ] {
                if let Some(path) = line.strip_prefix(prefix) {
                    paths.push(path.trim());
                }
            }
        }
    } else if let Some(path) = args["path"].as_str() {
        paths.push(path);
    }
    let Some(root) = permission_path(root, ".") else {
        return true;
    };
    for raw in paths {
        let Some(path) = permission_path(&root, raw) else {
            return true;
        };
        if !path.starts_with(&root) {
            return true;
        }
        for rule in permissions["writeRules"].as_array().into_iter().flatten() {
            if rule["action"] != "write" || rule["effect"] != "deny" {
                continue;
            }
            let Some(pattern) = rule.get("match") else {
                return true;
            };
            let Some(pattern) = pattern.as_str() else {
                return true;
            };
            // Resolve the literal prefix, so patterns through symlinked directories agree
            // with normalized targets. Wildcards themselves are never filesystem names.
            // A directory mutation can affect denied descendants. Conservatively
            // reject it rather than trusting a non-atomic recursive enumeration.
            if path.is_dir() {
                return true;
            }
            if !pattern.contains('*') {
                if permission_path(&root, pattern).is_none_or(|candidate| candidate == path) {
                    return true;
                }
                continue;
            }
            let wildcard = pattern.find('*').unwrap_or(pattern.len());
            let prefix_end = pattern[..wildcard].rfind('/').map(|i| i + 1).unwrap_or(0);
            let (prefix, suffix) = pattern.split_at(prefix_end);
            let Some(base) = permission_path(&root, if prefix.is_empty() { "." } else { prefix })
            else {
                return true;
            };
            let absolute_pattern = base.join(suffix).to_string_lossy().replace('\\', "/");
            if permission_glob(
                absolute_pattern.as_bytes(),
                path.to_string_lossy().replace('\\', "/").as_bytes(),
            ) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod agsdl_write_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frozen_write_rules_cover_all_targets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::create_dir(root.join("docs")).unwrap();
        std::fs::write(root.join(".env"), "secret").unwrap();
        let denied = |pattern: Option<&str>, tool: &str, args: serde_json::Value| {
            let rule = match pattern {
                Some(pattern) => json!({"action":"write","effect":"deny","match":pattern}),
                None => json!({"action":"write","effect":"deny"}),
            };
            agsdl_write_denied(
                root,
                tool,
                &args,
                &json!({"writeRules":[rule, {"action":"write","effect":"allow"}]}),
            )
        };
        for tool in ["write", "edit", "delete"] {
            for path in [".env", ".env.local", "sub/../.env"] {
                assert!(denied(Some(".env*"), tool, json!({"path":path})));
            }
            assert!(!denied(Some(".env*"), tool, json!({"path":"config/.env"})));
            assert!(denied(
                Some("**/.env*"),
                tool,
                json!({"path":"config/.env"})
            ));
            assert!(denied(Some("**/.env*"), tool, json!({"path":".env"})));
            assert!(denied(
                Some("src/generated/**"),
                tool,
                json!({"path":"src/generated/a/b.ts"})
            ));
            assert!(!denied(
                Some("src/generated/**"),
                tool,
                json!({"path":"src/gen.ts"})
            ));
            assert!(denied(None, tool, json!({"path":"anything"})));
        }
        for header in [
            "*** Add File: .env",
            "*** Update File: .env",
            "*** Delete File: .env",
            "*** Update File: safe\n*** Move to: .env",
        ] {
            let patch =
                format!("*** Begin Patch\n*** Add File: allowed\n+ok\n{header}\n*** End Patch");
            assert!(denied(
                Some(".env*"),
                "apply_patch",
                json!({"patch_text":patch})
            ));
            assert!(!root.join("allowed").exists());
        }
        assert!(agsdl_write_denied(
            root,
            "write",
            &json!({"path":"../outside"}),
            &json!({"writeRules":[{"action":"write","effect":"allow"}]})
        ));
        assert!(denied(
            Some("unrelated/**"),
            "delete",
            json!({"path":"docs"})
        ));
        assert!(!agsdl_write_denied(
            root,
            "read",
            &json!({"path":".env"}),
            &json!({"writeRules":[{"action":"write","effect":"deny"}]})
        ));
        assert!(denied(
            Some(root.join(".env*").to_str().unwrap()),
            "write",
            json!({"path":".env"})
        ));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("../.env", root.join("docs/link")).unwrap();
            assert!(denied(Some(".env*"), "write", json!({"path":"docs/link"})));
            assert!(denied(Some("docs/link"), "edit", json!({"path":".env"})));
            std::os::unix::fs::symlink("../../outside", root.join("docs/outside")).unwrap();
            assert!(denied(
                Some(".env*"),
                "write",
                json!({"path":"docs/outside"})
            ));
            std::os::unix::fs::symlink("../sub", root.join("docs/dir")).unwrap();
            assert!(denied(
                Some("sub/**"),
                "write",
                json!({"path":"docs/dir/new"})
            ));
        }
    }
}
