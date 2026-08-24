use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolValidationResult {
    pub allowed: bool,
    pub reason: Option<String>,
    pub enforce_macro_only_writes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
        "strategy_generate",
        "plan_list",
        "plan_get",
        "plan_update",
        "strategy_get",
        "strategy_update",
        "strategy_delete",
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
