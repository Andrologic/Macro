use super::*;
use crate::agsdl_permissions::{
    evaluate_requested, normalize_requested, Action, ActionRequest, Effect, NormalizedPolicy,
    PathContext, RequestedPermissions,
};
use argentic_runtime::host::{McpHttpAuthorizer, McpHttpSecret};
use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION};
use std::{net::SocketAddr, sync::Arc};
use url::{Host, Url};

#[derive(Default)]
pub(super) struct LaunchMcp {
    pub secrets: ServerSecrets,
    pub remote: BTreeMap<String, RemoteGrant>,
    pub remote_setup: BTreeMap<String, RemoteSetup>,
    pub agents: BTreeMap<String, BTreeMap<String, AgentAccess>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentAccess {
    default: Effect,
    tools: BTreeMap<String, Effect>,
    agent_patterns: BTreeMap<String, Effect>,
    host_patterns: BTreeMap<String, Effect>,
    pub(super) equipped: bool,
    agent_default: Effect,
    host_default: Effect,
}

struct ServerPolicy {
    default: Effect,
    patterns: BTreeMap<String, Effect>,
    deny_all: bool,
}

impl ServerPolicy {
    // Mirror Argentic's may_equip_mcp. Permission matching uses '*' as the
    // only metacharacter. A server-wide denial suppresses discovery.
    fn for_server(policy: &NormalizedPolicy, server: &str) -> Result<Self> {
        let request = ActionRequest::Mcp {
            server: server.into(),
            tool: None,
        };
        let default = evaluate_requested(policy, &request).map_err(|_| invalid_policy())?;
        let mut patterns: BTreeMap<String, Effect> = BTreeMap::new();
        let mut explicit_default: Option<Effect> = None;
        let mut tool_grant = false;
        for rule in policy
            .rules()
            .iter()
            .filter(|rule| rule.action == Action::Mcp)
        {
            let tool_pattern = match rule.pattern.as_deref() {
                None => None,
                Some(pattern) => {
                    let (server_pattern, tool_pattern) = pattern
                        .split_once('/')
                        .map_or((pattern, None), |(server, tool)| (server, Some(tool)));
                    if !matches_server(server_pattern, server)? {
                        continue;
                    }
                    tool_pattern
                }
            };
            match tool_pattern {
                Some(pattern) if !pattern.contains('/') => {
                    tool_grant |= rule.effect != Effect::Deny;
                    if pattern.is_empty() {
                        continue;
                    }
                    patterns
                        .entry(pattern.into())
                        .and_modify(|effect| *effect = (*effect).max(rule.effect))
                        .or_insert(rule.effect);
                }
                None => {
                    explicit_default = Some(
                        explicit_default.map_or(rule.effect, |effect| effect.max(rule.effect)),
                    );
                }
                _ => {}
            }
        }
        let deny_all = explicit_default == Some(Effect::Deny)
            || patterns.iter().any(|(pattern, effect)| {
                *effect == Effect::Deny && !pattern.is_empty() && pattern.bytes().all(|b| b == b'*')
            })
            || (default == Effect::Deny && !tool_grant);
        if let Some(effect) = explicit_default {
            for pattern_effect in patterns.values_mut() {
                *pattern_effect = (*pattern_effect).max(effect);
            }
        }
        Ok(Self {
            default,
            patterns,
            deny_all,
        })
    }
}

fn matches_server(pattern: &str, server: &str) -> Result<bool> {
    let expression = format!("(?s)\\A{}\\z", regex::escape(pattern).replace(r"\*", ".*"));
    regex::Regex::new(&expression)
        .map(|regex| regex.is_match(server))
        .map_err(|_| invalid_policy())
}

fn invalid_policy() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure("PERMISSION", "mcp", "MCP permissions cannot be evaluated")
}

fn path_context(root: &Path) -> Result<PathContext> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(invalid_policy)?;
    Ok(PathContext {
        workspace: root.into(),
        home,
    })
}

pub(super) fn agent_access(
    input: &VersionInput,
    preview: &ImportPreview,
    host: &RequestedPermissions,
    root: &Path,
) -> Result<BTreeMap<String, BTreeMap<String, AgentAccess>>> {
    let mut result = BTreeMap::new();
    if !preview.agents.values().any(|agent| {
        agent.usage == Usage::Reachable && agent.harness == "codex" && !agent.mcp_servers.is_empty()
    }) {
        return Ok(result);
    }
    let doc: Value = serde_json::from_str(input.archive.source().authored_json())?;
    let context = path_context(root)?;
    let host = normalize_requested(host.clone(), context.clone()).map_err(|_| invalid_policy())?;
    for (agent_id, agent) in &preview.agents {
        if agent.usage != Usage::Reachable
            || agent.harness != "codex"
            || agent.mcp_servers.is_empty()
        {
            continue;
        }
        let authored = serde_json::from_value(doc["agents"][agent_id]["permissions"].clone())?;
        let requested =
            normalize_requested(authored, context.clone()).map_err(|_| invalid_policy())?;
        let mut servers = BTreeMap::new();
        for server in &agent.mcp_servers {
            let a = ServerPolicy::for_server(&requested, server)?;
            let h = ServerPolicy::for_server(&host, server)?;
            let equipped = !a.deny_all && !h.deny_all;
            let mut tools = BTreeMap::new();
            let mut agent_patterns = BTreeMap::new();
            let mut host_patterns = BTreeMap::new();
            if equipped {
                if a.patterns
                    .keys()
                    .chain(h.patterns.keys())
                    .any(|p| p.contains('*'))
                {
                    agent_patterns = a.patterns;
                    host_patterns = h.patterns;
                } else {
                    for tool in a.patterns.keys().chain(h.patterns.keys()) {
                        let request = ActionRequest::Mcp {
                            server: server.clone(),
                            tool: Some(tool.clone()),
                        };
                        let effect = evaluate_requested(&requested, &request)
                            .and_then(|a| evaluate_requested(&host, &request).map(|h| a.max(h)))
                            .map_err(|_| invalid_policy())?;
                        tools.insert(tool.clone(), effect);
                    }
                }
            }
            servers.insert(
                server.clone(),
                AgentAccess {
                    default: if equipped {
                        a.default.max(h.default)
                    } else {
                        Effect::Deny
                    },
                    tools,
                    agent_patterns,
                    host_patterns,
                    equipped,
                    agent_default: a.default,
                    host_default: h.default,
                },
            );
        }
        result.insert(agent_id.clone(), servers);
    }
    Ok(result)
}

impl LaunchMcp {
    pub(super) fn remote_configuration(&self) -> RemoteConfigurations {
        self.remote
            .iter()
            .map(|(id, grant)| {
                (
                    id.clone(),
                    BTreeMap::from([(
                        grant.url.clone(),
                        RemoteSettings {
                            delivery: grant.delivery.clone(),
                        },
                    )]),
                )
            })
            .collect()
    }

    pub fn equips(&self, server: &str) -> bool {
        self.agents
            .values()
            .any(|servers| servers.get(server).is_some_and(|access| access.equipped))
    }
}

pub(crate) type RemoteConfigurations = BTreeMap<String, BTreeMap<String, RemoteSettings>>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSettings {
    #[serde(default)]
    pub delivery: BTreeMap<String, SecretDelivery>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum SecretDelivery {
    Bearer,
    Header { name: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteSetup {
    url: String,
    suggestions: BTreeMap<String, SecretDelivery>,
}

impl RemoteSetup {
    pub(super) fn new(url: &Url, names: &[String]) -> Self {
        let bearer = names
            .iter()
            .find(|name| *name == "TOKEN" || name.ends_with("_TOKEN"));
        let suggestions = names
            .iter()
            .map(|name| {
                let delivery = if Some(name) == bearer {
                    SecretDelivery::Bearer
                } else {
                    let header = if allowed_header(name).is_some()
                        && !name.eq_ignore_ascii_case("authorization")
                    {
                        name.clone()
                    } else {
                        format!("X-Secret-{}", name.replace('_', "-"))
                    };
                    SecretDelivery::Header { name: header }
                };
                (name.clone(), delivery)
            })
            .collect();
        Self {
            url: url.as_str().into(),
            suggestions,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteGrant {
    url: String,
    #[serde(skip)]
    parsed_url: Url,
    #[serde(serialize_with = "serialize_delivery")]
    delivery: BTreeMap<String, SecretDelivery>,
}

fn serialize_delivery<S: serde::Serializer>(
    delivery: &BTreeMap<String, SecretDelivery>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    let labels: BTreeMap<_, _> = delivery
        .iter()
        .map(|(name, destination)| {
            let header = match destination {
                SecretDelivery::Bearer => "Authorization: Bearer",
                SecretDelivery::Header { name } => name,
            };
            (name, header)
        })
        .collect();
    labels.serialize(serializer)
}

// Match Argentic's Streamable HTTP reserved request headers.
fn allowed_header(name: &str) -> Option<HeaderName> {
    let header = HeaderName::from_bytes(name.as_bytes()).ok()?;
    (!header.as_str().starts_with("mcp-")
        && !matches!(
            header.as_str(),
            "host"
                | "content-length"
                | "accept"
                | "content-type"
                | "last-event-id"
                | "connection"
                | "transfer-encoding"
                | "upgrade"
                | "proxy-authorization"
                | "proxy-connection"
                | "te"
                | "trailer"
                | "expect"
                | "keep-alive"
        ))
    .then_some(header)
}

impl RemoteGrant {
    pub(super) fn new(
        parsed_url: Url,
        names: &[String],
        settings: &RemoteSettings,
    ) -> std::result::Result<Self, &'static str> {
        let mut used = BTreeSet::new();
        let mut delivery = BTreeMap::new();
        for name in names {
            let selected = settings
                .delivery
                .get(name)
                .ok_or("mcpSecretDeliveryRequired")?;
            let header = match selected {
                SecretDelivery::Bearer => AUTHORIZATION,
                SecretDelivery::Header { name } => allowed_header(name).ok_or("mcpSecretHeader")?,
            };
            if !used.insert(header.as_str().to_owned()) {
                return Err("mcpSecretHeaderConflict");
            }
            let destination = match selected {
                SecretDelivery::Bearer => SecretDelivery::Bearer,
                SecretDelivery::Header { .. } => SecretDelivery::Header {
                    name: header.as_str().into(),
                },
            };
            delivery.insert(name.clone(), destination);
        }
        Ok(Self {
            url: parsed_url.as_str().into(),
            parsed_url,
            delivery,
        })
    }

    pub(super) fn credential_binding(&self, name: &str) -> Option<(String, &'static str, String)> {
        let (mode, header) = match self.delivery.get(name)? {
            SecretDelivery::Bearer => ("bearer", AUTHORIZATION.as_str().to_owned()),
            SecretDelivery::Header { name } => ("header", name.clone()),
        };
        Some((self.parsed_url.origin().ascii_serialization(), mode, header))
    }

    fn covers(&self, url: &Url, addresses: &[SocketAddr], names: &[String]) -> bool {
        url == &self.parsed_url
            && !addresses.is_empty()
            && addresses.iter().all(|address| {
                self.parsed_url.port_or_known_default() == Some(address.port())
                    && match self.parsed_url.host() {
                        Some(Host::Ipv4(ip)) => {
                            address.ip() == ip
                                && !ip.is_unspecified()
                                && !ip.is_multicast()
                                && !ip.is_broadcast()
                        }
                        Some(Host::Ipv6(ip)) => {
                            address.ip() == ip && !ip.is_unspecified() && !ip.is_multicast()
                        }
                        Some(Host::Domain("localhost")) => address.ip().is_loopback(),
                        Some(Host::Domain(_)) => crate::commands::mcp::ip_is_public(address.ip()),
                        None => false,
                    }
            })
            && names.len() == self.delivery.len()
            && self.delivery.keys().all(|name| names.contains(name))
    }
}

pub(super) fn authorizer(
    source: EngineSourceRevision,
    grants: BTreeMap<String, RemoteGrant>,
) -> Arc<McpHttpAuthorizer> {
    Arc::new(move |revision, server, url, addresses, names| {
        if revision != &source {
            return None;
        }
        let grant = grants.get(server)?;
        grant.covers(url, addresses, names).then(|| {
            grant
                .delivery
                .iter()
                .map(|(name, delivery)| {
                    let delivery = match delivery {
                        SecretDelivery::Bearer => McpHttpSecret::Bearer,
                        SecretDelivery::Header { name } => McpHttpSecret::Header(name.clone()),
                    };
                    (name.clone(), delivery)
                })
                .collect()
        })
    })
}

pub(super) fn valid_secret(value: &str, remote: bool) -> bool {
    !value.is_empty() && !value.contains('\0') && (!remote || HeaderValue::from_str(value).is_ok())
}

pub(crate) fn current_tool_allowed(
    root: &Path,
    ceiling: &RequestedPermissions,
    project: &RequestedPermissions,
    server: &str,
    tool: &str,
) -> Result<bool> {
    let context = path_context(root)?;
    let request = ActionRequest::Mcp {
        server: server.into(),
        tool: Some(tool.into()),
    };
    for permissions in [ceiling, project] {
        let policy = normalize_requested(permissions.clone(), context.clone())
            .map_err(|_| invalid_policy())?;
        if evaluate_requested(&policy, &request).map_err(|_| invalid_policy())? == Effect::Deny {
            return Ok(false);
        }
    }
    Ok(true)
}
