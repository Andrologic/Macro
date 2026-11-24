use super::*;
use crate::agsdl_permissions::{
    evaluate_requested, normalize_requested, Action, ActionRequest, Effect, NormalizedPolicy,
    PathContext, RequestedPermissions,
};
use argentic_runtime::{
    api::McpServerQualification,
    host::{McpHttpAuthorizer, McpHttpSecret},
};
use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
use url::{Host, Url};

#[derive(Default)]
pub(super) struct LaunchMcp {
    pub secrets: ServerSecrets,
    pub remote: BTreeMap<String, RemoteGrant>,
    pub remote_setup: BTreeMap<String, RemoteSetup>,
    pub agents: BTreeMap<String, BTreeMap<String, AgentAccess>>,
    pub qualification: BTreeMap<String, McpServerQualification>,
    pub direct_tools: BTreeMap<String, BTreeSet<String>>,
    pub notes: Vec<UnusedServer>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UnusedServer {
    pub server: String,
    pub unsupported_endpoint: bool,
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
}

impl ServerPolicy {
    // Summarize tool rules for display. Argentic determines equipment eligibility.
    fn for_server(policy: &NormalizedPolicy, server: &str) -> Result<Self> {
        let request = ActionRequest::Mcp {
            server: server.into(),
            tool: None,
        };
        let default = evaluate_requested(policy, &request).map_err(|_| invalid_policy())?;
        let mut patterns: BTreeMap<String, Effect> = BTreeMap::new();
        let mut explicit_default: Option<Effect> = None;
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
        if let Some(effect) = explicit_default {
            for pattern_effect in patterns.values_mut() {
                *pattern_effect = (*pattern_effect).max(effect);
            }
        }
        Ok(Self { default, patterns })
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
    document: &Value,
    preview: &ImportPreview,
    host: &RequestedPermissions,
    root: &Path,
    qualification: &BTreeMap<String, McpServerQualification>,
) -> Result<BTreeMap<String, BTreeMap<String, AgentAccess>>> {
    let mut result = BTreeMap::new();
    if !preview
        .agents
        .values()
        .any(|agent| agent.harness == "codex" && !agent.mcp_servers.is_empty())
    {
        return Ok(result);
    }
    let context = path_context(root)?;
    let host = normalize_requested(host.clone(), context.clone()).map_err(|_| invalid_policy())?;
    for (agent_id, agent) in &preview.agents {
        if agent.harness != "codex" || agent.mcp_servers.is_empty() {
            continue;
        }
        let authored = serde_json::from_value(document["agents"][agent_id]["permissions"].clone())?;
        let requested =
            normalize_requested(authored, context.clone()).map_err(|_| invalid_policy())?;
        let mut servers = BTreeMap::new();
        for server in &agent.mcp_servers {
            let a = ServerPolicy::for_server(&requested, server)?;
            let h = ServerPolicy::for_server(&host, server)?;
            let equipped = qualification
                .get(server)
                .is_some_and(|entry| entry.agent_equipment.contains(agent_id));
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
                            address_scope: Some(grant.address_scope),
                        },
                    )]),
                )
            })
            .collect()
    }
}

pub(crate) type RemoteConfigurations = BTreeMap<String, BTreeMap<String, RemoteSettings>>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSettings {
    #[serde(default)]
    pub delivery: BTreeMap<String, SecretDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_scope: Option<AddressScope>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AddressScope {
    Public,
    PrivateNetwork,
    ThisComputer,
}

fn address_scope(address: IpAddr) -> Option<AddressScope> {
    let address = address.to_canonical();
    if address.is_unspecified() || address.is_multicast() {
        return None;
    }
    if address.is_loopback() {
        return Some(AddressScope::ThisComputer);
    }
    let private = match address {
        IpAddr::V4(ip) => {
            let [first, second, ..] = ip.octets();
            ip.is_private() || ip.is_link_local() || (first == 100 && (64..=127).contains(&second))
        }
        IpAddr::V6(ip) => ip.is_unique_local() || ip.is_unicast_link_local(),
    };
    if private {
        Some(AddressScope::PrivateNetwork)
    } else {
        crate::commands::mcp::ip_is_public(address).then_some(AddressScope::Public)
    }
}

fn literal_address(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(ip) => Some(ip.into()),
        Host::Ipv6(ip) => Some(IpAddr::from(ip).to_canonical()),
        Host::Domain(_) => None,
    }
}

fn fixed_address_scope(url: &Url) -> std::result::Result<Option<AddressScope>, &'static str> {
    if let Some(address) = literal_address(url) {
        return address_scope(address)
            .map(Some)
            .ok_or("mcpAddressUnsupported");
    }
    let host = url.host_str().unwrap_or_default().trim_end_matches('.');
    Ok((host == "localhost" || host.ends_with(".localhost")).then_some(AddressScope::ThisComputer))
}

fn default_scope(url: &Url) -> AddressScope {
    if fixed_address_scope(url) == Ok(Some(AddressScope::ThisComputer)) {
        AddressScope::ThisComputer
    } else {
        AddressScope::Public
    }
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
    address_scope: AddressScope,
}

impl RemoteSetup {
    pub(super) fn new(url: &Url, names: &[String], settings: &RemoteSettings) -> Self {
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
            address_scope: settings.address_scope.unwrap_or_else(|| default_scope(url)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteGrant {
    url: String,
    #[serde(skip)]
    parsed_url: Url,
    address_scope: AddressScope,
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
        let address_scope = settings
            .address_scope
            .unwrap_or_else(|| default_scope(&parsed_url));
        if let Some(fixed) = fixed_address_scope(&parsed_url)? {
            if fixed != address_scope {
                return Err(if fixed == AddressScope::PrivateNetwork {
                    "mcpPrivateNetworkRequired"
                } else {
                    "mcpAddressScopeMismatch"
                });
            }
        }
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
            address_scope,
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
        let literal = literal_address(url);
        url == &self.parsed_url
            && !addresses.is_empty()
            && addresses.iter().all(|address| {
                let ip = address.ip().to_canonical();
                url.port_or_known_default() == Some(address.port())
                    && literal.is_none_or(|literal| literal == ip)
                    && address_scope(ip) == Some(self.address_scope)
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
