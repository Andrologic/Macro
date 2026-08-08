const MCP_ENV_SECRET_REF_PREFIX: &str = "macro-secret://mcp-env/";

pub(crate) fn normalize_identifier(value: &str, fallback: &str) -> String {
    let mut output = String::new();
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            output.push(ch);
        } else if !output.ends_with('_') {
            output.push('_');
        }
        if output.len() >= 64 {
            break;
        }
    }
    let trimmed = output.trim_matches('_').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

pub(crate) fn build_mcp_tool_id(server_id: &str, tool_name: &str) -> String {
    format!(
        "mcp__{}__{}",
        normalize_identifier(server_id, "server"),
        normalize_identifier(tool_name, "tool")
    )
}

pub(crate) fn build_mcp_env_secret_id(server_id: &str, key: &str) -> String {
    format!(
        "mcp-env:{}:{}",
        normalize_identifier(server_id, "server"),
        key.trim()
    )
}

pub(crate) fn build_mcp_env_secret_ref(server_id: &str, key: &str) -> String {
    format!(
        "{}{}/{}",
        MCP_ENV_SECRET_REF_PREFIX,
        normalize_identifier(server_id, "server"),
        key.trim()
    )
}

pub(crate) fn parse_mcp_env_secret_ref(value: &str) -> Option<(&str, &str)> {
    let suffix = value.strip_prefix(MCP_ENV_SECRET_REF_PREFIX)?;
    let (server_id, key) = suffix.split_once('/')?;
    if server_id.trim().is_empty() || key.trim().is_empty() {
        return None;
    }
    Some((server_id, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_stable_mcp_tool_ids() {
        assert_eq!(
            build_mcp_tool_id("GitHub Server", "issues/list"),
            "mcp__github_server__issues_list"
        );
    }
}
