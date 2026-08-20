use super::ids::{build_mcp_env_secret_id, normalize_identifier, parse_mcp_env_secret_ref};
use super::types::McpServerDto;
use crate::commands::{command_error, CommandResult};
use crate::secrets;
use std::collections::HashMap;

pub(crate) fn resolve_env_secrets(
    server: &McpServerDto,
    env: &HashMap<String, String>,
) -> CommandResult<HashMap<String, String>> {
    let mut resolved = HashMap::new();
    for (key, value) in env {
        if let Some((secret_server_id, secret_key)) = parse_mcp_env_secret_ref(value) {
            let expected_server_id = normalize_identifier(&server.id, "server");
            if secret_server_id != expected_server_id || secret_key != key {
                return Err(command_error(format!(
                    "MCP env secret reference for '{}' must target the same server and environment key.",
                    key
                )));
            }
            let secret_id = build_mcp_env_secret_id(secret_server_id, secret_key);
            let secret = secrets::get_api_key(&secret_id).map_err(|error| {
                command_error(format!(
                    "Failed to read MCP env secret '{}' for '{}': {}",
                    key, server.name, error
                ))
            })?;
            let Some(secret) = secret else {
                return Err(command_error(format!(
                    "MCP env secret '{}' is missing for '{}'.",
                    key, server.name
                )));
            };
            resolved.insert(key.clone(), secret);
        } else if value.starts_with("macro-secret://") {
            return Err(command_error(format!(
                "MCP env secret reference for '{}' is malformed.",
                key
            )));
        } else {
            resolved.insert(key.clone(), value.clone());
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::super::stdio::resolve_stdio_transport;
    use super::super::types::{McpServerDto, McpTransportDto};
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn resolves_env_secret_refs_from_secret_store() {
        let dir = tempfile::tempdir().expect("secret temp dir");
        crate::secrets::init(dir.path()).expect("initialize secret store");
        crate::secrets::set_api_key("mcp-env:secret_server:API_TOKEN", "hidden-token")
            .expect("store MCP env secret");

        let mut env = HashMap::new();
        env.insert(
            "API_TOKEN".to_string(),
            "macro-secret://mcp-env/secret_server/API_TOKEN".to_string(),
        );
        let server = McpServerDto {
            id: "Secret Server".to_string(),
            name: "Secret Server".to_string(),
            transport: Some(McpTransportDto::Stdio {
                command: "echo".to_string(),
                args: Vec::new(),
                env,
            }),
            config: Some(json!({ "enabled": true })),
        };

        let (_command, _args, resolved_env) =
            resolve_stdio_transport(&server).expect("resolve stdio transport");
        assert_eq!(
            resolved_env.get("API_TOKEN").map(String::as_str),
            Some("hidden-token")
        );
    }

    #[test]
    fn rejects_cross_server_cross_key_and_malformed_secret_refs() {
        let dir = tempfile::tempdir().expect("secret temp dir");
        crate::secrets::init(dir.path()).expect("initialize secret store");
        for secret_id in [
            "mcp-env:secret_server:OTHER_TOKEN",
            "mcp-env:other_server:API_TOKEN",
        ] {
            crate::secrets::set_api_key(secret_id, "hidden-token").expect("store MCP env secret");
        }

        for reference in [
            "macro-secret://mcp-env/secret_server/OTHER_TOKEN",
            "macro-secret://mcp-env/other_server/API_TOKEN",
            "macro-secret://mcp-env:secret_server:API_TOKEN",
        ] {
            let server = McpServerDto {
                id: "Secret Server".to_string(),
                name: "Secret Server".to_string(),
                transport: Some(McpTransportDto::Stdio {
                    command: "echo".to_string(),
                    args: Vec::new(),
                    env: HashMap::from([("API_TOKEN".to_string(), reference.to_string())]),
                }),
                config: Some(json!({ "enabled": true })),
            };

            assert!(resolve_stdio_transport(&server).is_err(), "{reference}");
        }
    }
}
