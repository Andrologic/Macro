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

fn is_valid_mcp_env_key(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

pub(crate) fn parse_mcp_env_secret_ref(value: &str) -> Option<(&str, &str)> {
    let suffix = value.strip_prefix(MCP_ENV_SECRET_REF_PREFIX)?;
    let (server_id, key) = suffix.split_once('/')?;
    if server_id != normalize_identifier(server_id, "server")
        || !is_valid_mcp_env_key(key)
        || key.contains('/')
    {
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

    #[test]
    fn parses_only_canonical_mcp_env_secret_references() {
        assert_eq!(
            parse_mcp_env_secret_ref("macro-secret://mcp-env/github_server/API_TOKEN"),
            Some(("github_server", "API_TOKEN"))
        );
        for invalid in [
            "macro-secret://mcp-env:github_server:API_TOKEN",
            "macro-secret://mcp-env/GitHub Server/API_TOKEN",
            "macro-secret://mcp-env/github_server/API TOKEN",
            "macro-secret://mcp-env/github_server/API_TOKEN/extra",
        ] {
            assert_eq!(parse_mcp_env_secret_ref(invalid), None, "{invalid}");
        }
    }
}
