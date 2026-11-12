//! Effective Macro permission projection shared with native 0.3 capture.
use crate::db::agsdl_execution::{failure, Result};
use serde_json::{json, Value};
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
