//! Claude uses captured Macro tools only. The native result is never physical end evidence.
mod profile;
mod protocol;
use crate::config::ConfigManager;
use crate::core::process::ContainedBackgroundProcess;
use crate::db::agsdl_execution::{failure, Result};
pub use profile::ClaudeStatus;
pub(crate) use profile::Profile;
use profile::{CLI_VERSION, PROVIDER, VERSION};
use protocol::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;
fn required(value: &Value, field: &str) -> Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .map(str::to_owned)
        .ok_or_else(|| {
            failure(
                "CORRELATION",
                field,
                "Claude reference is absent or invalid",
            )
        })
}
fn names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn same_names(actual: &Value, expected: &[&str]) -> bool {
    if actual
        .as_array()
        .is_none_or(|items| items.iter().any(|item| !item.is_string()))
    {
        return false;
    }
    let mut actual = names(actual);
    actual.sort();
    let mut expected: Vec<_> = expected.iter().map(|s| s.to_string()).collect();
    expected.sort();
    actual == expected
}
pub(crate) const AGENTS: &[&str] = &[];
pub(crate) const COMMANDS: &[&str] = &[
    "agents",
    "auto-mode-setup",
    "autocompact",
    "clear",
    "color",
    "compact",
    "config",
    "output-style",
    "context",
    "effort",
    "fast",
    "focus",
    "heapdump",
    "init",
    "mcp",
    "model",
    "__remote-workflow",
    "workflow-launch-exec",
    "reload-plugins",
    "reload-skills",
    "rename",
    "security-review",
    "usage",
    "insights",
    "recap",
    "goal",
    "list-agents",
    "team-onboarding",
];
fn qualified_commands(value: &Value) -> bool {
    // Both catalogues were observed with this pinned CLI. No extra command is
    // admitted, and each query's init must match its own ready catalogue.
    let reduced: Vec<_> = COMMANDS
        .iter()
        .copied()
        .filter(|name| !["heapdump", "team-onboarding"].contains(name))
        .collect();
    same_names(value, COMMANDS) || same_names(value, &reduced)
}
fn qualified_mcp_sources(value: &Value, has_tools: bool) -> bool {
    value.as_array().is_some_and(|servers| {
        if !has_tools {
            servers.is_empty()
        } else {
            servers.len() == 1
                && servers[0]["name"] == "macro"
                && servers[0]["status"] == "connected"
                && servers[0]["source"] == "sdk"
        }
    })
}
fn verify_ready(value: &Value, tools: &[String]) -> Result<Vec<String>> {
    let init = &value["initialized"];
    let command_names = Value::Array(
        init["commands"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| v["name"].clone())
            .collect(),
    );
    let agent_names = Value::Array(
        init["agents"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| v["name"].clone())
            .collect(),
    );
    let status = value["mcpStatus"].as_array().ok_or_else(|| {
        failure(
            "CLAUDE_PROFILE_UNQUALIFIED",
            "mcp",
            "Missing SDK MCP status",
        )
    })?;
    let status_names = status
        .first()
        .map(|server| {
            Value::Array(
                server["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|tool| tool["name"].clone())
                    .collect(),
            )
        })
        .unwrap_or(json!([]));
    let mut actual_tools = names(&status_names);
    actual_tools.sort();
    let mut sorted_tools = tools.to_vec();
    sorted_tools.sort();
    if value["nodeVersion"]
        .as_str()
        .and_then(|v| v.split('.').next())
        .and_then(|v| v.parse::<u32>().ok())
        .is_none_or(|v| v < 18)
        || init["claude_code_version"] != CLI_VERSION
        || init["current_permission_mode"] != "default"
        || init["hooks_applied"] != true
        || init["account"]["apiKeySource"] != "ANTHROPIC_API_KEY"
        || init["account"]["apiProvider"] != "firstParty"
        || !qualified_commands(&command_names)
        || init["commands"]
            .as_array()
            .is_none_or(|commands| commands.iter().any(|c| c["builtin"] != true))
        || !same_names(&agent_names, AGENTS)
        || !qualified_mcp_sources(&value["mcpStatus"], !tools.is_empty())
        || actual_tools != sorted_tools
        || value["settings"]["tools"] != json!([])
        || value["settings"]["verbatimPrompts"] != true
    {
        return Err(failure(
            "CLAUDE_PROFILE_UNQUALIFIED",
            "catalogue",
            "Claude initialized an unqualified native capability or configuration",
        ));
    }
    let models = value["models"].as_array().ok_or_else(|| {
        failure(
            "CLAUDE_PROFILE_UNQUALIFIED",
            "models",
            "Native models unavailable",
        )
    })?;
    Ok(models
        .iter()
        .filter_map(|m| {
            m.get("resolvedModel")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect())
}
fn verify_init(
    frame: &Value,
    profile: &Profile,
    session: &str,
    model: &str,
    tools: &[String],
    commands: &[String],
) -> Result<String> {
    let expected: Vec<_> = tools
        .iter()
        .map(|name| format!("mcp__macro__{name}"))
        .collect();
    let mut actual = names(&frame["tools"]);
    actual.sort();
    let mut expected = expected;
    expected.sort();
    let plugins = frame["plugins"].as_array().ok_or_else(|| {
        failure(
            "CLAUDE_CONTEXT_UNQUALIFIED",
            "plugins",
            "Native plugins absent",
        )
    })?;
    let plugin_names = Value::Array(plugins.iter().map(|p| p["name"].clone()).collect());
    if frame["session_id"] != session
        || frame["claude_code_version"] != CLI_VERSION
        || frame["model"] != model
        || frame["cwd"] != json!(profile.bootstrap)
        || frame["permissionMode"] != "default"
        || frame["apiKeySource"] != "ANTHROPIC_API_KEY"
        || actual != expected
        || !same_names(
            &frame["slash_commands"],
            &commands.iter().map(String::as_str).collect::<Vec<_>>(),
        )
        || frame["output_style"] != "default"
        || !same_names(&frame["agents"], AGENTS)
        || !same_names(&frame["skills"], &[])
        || !same_names(&plugin_names, &[])
        || frame["plugin_errors"]
            .as_array()
            .is_some_and(|e| !e.is_empty())
        || !qualified_mcp_sources(&frame["mcp_servers"], !tools.is_empty())
    {
        return Err(failure(
            "CLAUDE_CONTEXT_UNQUALIFIED",
            "init",
            "Claude native context differs from the qualified controlled profile",
        ));
    }
    required(frame, "uuid")
}
fn key() -> Result<String> {
    crate::secrets::get_api_key(PROVIDER)
        .map_err(|_| {
            failure(
                "CLAUDE_KEY_REQUIRED",
                "account",
                "Claude API key is unavailable",
            )
        })?
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            failure(
                "CLAUDE_KEY_REQUIRED",
                "account",
                "Store a Claude API key in Macro's existing secret store",
            )
        })
}
fn account(key: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(key.as_bytes()))
}
fn params(profile: &Profile, model: &str) -> Value {
    json!({"sdk":profile.sdk,"zod":profile.zod,"cli":profile.cli,"sdkVersion":VERSION,"cliVersion":CLI_VERSION,"cwd":profile.bootstrap,"sessionId":uuid::Uuid::new_v4().to_string(),"resume":false,"userMessageUuid":uuid::Uuid::new_v4().to_string(),"model":model,"initialization":"Macro controlled capability diagnostic.","input":"","tools":[],"publication":false,"maxTurns":null,"effort":null,"qa":false,"diagnostic":true})
}
pub(crate) async fn observe(
    manager: &ConfigManager,
    scope: &Value,
) -> Result<Option<(Profile, Vec<String>, String)>> {
    let profile = match profile::prepare(manager) {
        Ok(p) => p,
        Err(error)
            if ["CLAUDE_NOT_INSTALLED", "CLAUDE_PLATFORM_UNQUALIFIED"]
                .contains(&error.code.as_str()) =>
        {
            return Ok(None)
        }
        Err(e) => return Err(e),
    };
    profile.attestation(scope)?;
    let api_key = key()?;
    let digest = account(&api_key);
    let command = profile.command(&api_key, false);
    tokio::spawn(async move {
        let mut process = ContainedBackgroundProcess::spawn(command).map_err(|_| {
            failure(
                "CLAUDE_PROFILE_UNQUALIFIED",
                "runner",
                "Cannot launch external Claude runtime",
            )
        })?;
        let mut client = Client::new(
            process
                .take_stdin()
                .ok_or_else(|| failure("CORRELATION", "stdio", "Runner stdin absent"))?,
            process
                .take_stdout()
                .ok_or_else(|| failure("CORRELATION", "stdio", "Runner stdout absent"))?,
        );
        let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            client
                .send(&json!({"method":"configure","params":params(&profile,"claude-haiku-5-5")}))
                .await?;
            let ready = client.next().await?;
            if ready["method"] != "ready" {
                return Err(failure(
                    "CLAUDE_PROFILE_UNQUALIFIED",
                    "runner",
                    "Claude diagnostic failed before readiness",
                ));
            }
            let models = verify_ready(&ready["params"], &[])?;
            client.send(&json!({"id":ready["id"],"result":{}})).await?;
            let end = client.next().await?;
            if end["method"] != "diagnosticEnd" {
                return Err(failure(
                    "CLAUDE_PROFILE_UNQUALIFIED",
                    "runner",
                    "Claude diagnostic did not finish",
                ));
            }
            Ok(models)
        })
        .await
        .map_err(|_| {
            failure(
                "CLAUDE_PROFILE_UNQUALIFIED",
                "runner",
                "Claude diagnostic timed out",
            )
        });
        process.terminate_bounded().await.map_err(|_| {
            failure(
                "STOP_PENDING",
                "runner",
                "Claude diagnostic physical end is unconfirmed",
            )
        })?;
        let models = result??;
        Ok(Some((profile, models, digest)))
    })
    .await
    .map_err(|_| {
        failure(
            "STOP_PENDING",
            "runner",
            "Claude diagnostic supervisor did not acknowledge",
        )
    })?
}
#[tauri::command]
pub(crate) async fn execution_claude_status(
    manager: State<'_, ConfigManager>,
) -> Result<ClaudeStatus> {
    let scope = json!({"root":manager.root().join("native-discovery/claude")});
    match observe(&manager, &scope).await {
        Ok(Some(_)) => Ok(ClaudeStatus {
            available: true,
            code: "CLAUDE_CONTROLLED_READY".into(),
            version: Some(VERSION.into()),
            tool_policy: "macro-controlled".into(),
            installation_url: profile::INSTALL_URL.into(),
        }),
        Ok(None) => Ok(profile::unavailable("CLAUDE_NOT_INSTALLED")),
        Err(e) => Ok(profile::unavailable(&e.code)),
    }
}
#[tauri::command]
pub(crate) async fn execution_claude_set_api_key(api_key: String) -> Result<()> {
    if api_key.trim().is_empty() || api_key.len() > 4096 {
        return Err(failure("CORRELATION", "apiKey", "Invalid Claude API key"));
    }
    crate::secrets::set_api_key(PROVIDER, api_key.trim())
        .map_err(|_| failure("STORAGE", "apiKey", "Cannot store Claude API key"))
}
#[cfg(test)]
mod result_tests {
    use super::*;

    #[test]
    fn native_empty_diagnostic_requires_empty_mcp_and_keeps_tool_catalogues_strict() {
        let mut ready = json!({"nodeVersion":"22.23.3","initialized":{"claude_code_version":CLI_VERSION,"current_permission_mode":"default","hooks_applied":true,"account":{"apiKeySource":"ANTHROPIC_API_KEY","apiProvider":"firstParty"},"commands":COMMANDS.iter().map(|name|json!({"name":name,"builtin":true})).collect::<Vec<_>>(),"agents":[]},"mcpStatus":[],"models":[{"resolvedModel":"claude-haiku-5-5"}],"settings":{"tools":[],"verbatimPrompts":true}});
        assert_eq!(verify_ready(&ready, &[]).unwrap(), ["claude-haiku-5-5"]);
        ready["initialized"]["commands"]
            .as_array_mut()
            .unwrap()
            .retain(|command| {
                !["heapdump", "team-onboarding"].contains(&command["name"].as_str().unwrap())
            });
        assert_eq!(verify_ready(&ready, &[]).unwrap(), ["claude-haiku-5-5"]);
        let reduced = ready["initialized"]["commands"].clone();
        ready["initialized"]["commands"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"foreign-command","builtin":true}));
        assert!(verify_ready(&ready, &[]).is_err());
        ready["initialized"]["commands"] = reduced;
        assert!(verify_ready(&ready, &["write".into()]).is_err());
        ready["mcpStatus"] = json!([{"name":"macro","source":"sdk","status":"connected","tools":[{"name":"write"}]}]);
        assert!(verify_ready(&ready, &[]).is_err());
        assert!(verify_ready(&ready, &["write".into()]).is_ok());
        ready["mcpStatus"][0]["source"] = json!("project");
        assert!(verify_ready(&ready, &["write".into()]).is_err());
    }
}
