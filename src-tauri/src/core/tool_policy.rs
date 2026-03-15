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
}

fn architect_allowed_tool_ids() -> &'static [&'static str] {
    &[
        "mark_source_passage",
        "read_sources",
        "edit_source_passage",
        "read_file",
        "web_search",
        "web_fetch",
        "list",
        "read",
        "glob",
        "grep",
        "write",
        "edit",
        "git_status",
        "git_log",
        "git_branch_list",
        "git_diff",
        "git_get_tree",
        "need_add",
        "strategy_generate",
        "plan_create",
        "plan_list",
        "plan_get",
        "plan_update",
        "plan_delete",
        "plan_restore",
        "plan_set_active",
        "strategy_get",
        "strategy_update",
        "strategy_delete",
    ]
}

fn normalize_architect_tool_id(tool_id: &str) -> &str {
    match tool_id {
        "add_need" => "need_add",
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
    &["read_sources", "read_file", "web_search", "web_fetch"]
}

fn implement_and_debug_allowed_tool_ids() -> &'static [&'static str] {
    &[
        "mark_source_passage",
        "read_sources",
        "edit_source_passage",
        "read_file",
        "web_search",
        "web_fetch",
        "list",
        "read",
        "glob",
        "grep",
        "write",
        "edit",
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
    matches!(tool_id, "write" | "edit")
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
        "Debug" => Some((implement_and_debug_allowed_tool_ids(), false)),
        "Implement" => Some((implement_and_debug_allowed_tool_ids(), false)),
        _ => None,
    }
}

pub fn get_mode_policy(mode: &str) -> ToolModePolicyResult {
    let Some((allowed_tool_ids, enforce_macro_only_writes)) = resolve_mode_policy(mode) else {
        return ToolModePolicyResult {
            allowed_tool_ids: vec![],
            enforce_macro_only_writes: false,
        };
    };

    ToolModePolicyResult {
        allowed_tool_ids: allowed_tool_ids.iter().map(|id| id.to_string()).collect(),
        enforce_macro_only_writes,
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

    if !allowed_tool_ids.contains(&tool_id) {
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
                return ToolValidationResult {
                    allowed: false,
                    reason: Some(
                        "Architect mode requires a target path for write/edit tools".to_string(),
                    ),
                    enforce_macro_only_writes,
                }
            }
        }
    }

    ToolValidationResult {
        allowed: true,
        reason: None,
        enforce_macro_only_writes,
    }
}
