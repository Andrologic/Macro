use super::{project, project::PROJECT_FORMAT, Result};
use argentic_runtime::source::OpenedSource;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Static use relative to the flow. Reachable work may still be conditional.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Usage {
    DeclaredOnly,
    Unknown,
    Reachable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub title: Option<String>,
    pub authored_id: String,
    pub contract: String,
    pub package_format: &'static str,
    pub project_format: &'static str,
    /// Archive bytes, or the ordered paths, executable flags and bytes of a project.
    pub staged_sha256: String,
    pub history_will_be_removed: bool,
    pub entry_point: Option<String>,
    pub agents: BTreeMap<String, AgentRequirement>,
    pub direct_calls: Vec<DirectCall>,
    pub mcp_servers: BTreeMap<String, McpServer>,
    pub files: Vec<PackagedFile>,
    pub external_references: Vec<ExternalReference>,
    pub warnings: Vec<PreviewWarning>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequirement {
    pub usage: Usage,
    pub harness: String,
    pub harness_version: Option<String>,
    pub model: Option<ModelRequirement>,
    pub permissions: RequestedPermissions,
    pub mcp_servers: Vec<String>,
    pub completion_check: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequirement {
    pub name: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedPermissions {
    pub preset: Option<String>,
    pub directories: BTreeMap<String, String>,
    pub outside: Option<String>,
    pub reviewer: Option<String>,
    pub rules: Vec<PermissionRule>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub action: String,
    #[serde(rename = "match")]
    pub pattern: Option<String>,
    pub effect: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub file: String,
    pub pointer: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectCall {
    pub location: Location,
    pub usage: Usage,
    pub target: CallTarget,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CallTarget {
    Shell { command: String },
    Mcp { server: String, tool: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub usage: Usage,
    pub transport: McpTransport,
    pub packaged_files: Vec<String>,
    pub required_secrets: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpTransport {
    Local { command: Vec<String> },
    Remote { url: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagedFile {
    pub path: String,
    pub size: u64,
    pub executable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceKind {
    Content,
    Skill,
    McpEndpoint,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReference {
    pub uri: String,
    pub kind: ReferenceKind,
    pub usage: Usage,
    pub location: Location,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWarning {
    pub code: String,
    pub message: String,
    pub launch_blocker: bool,
    pub location: Location,
}

pub(crate) fn inspect(
    source: &OpenedSource,
    package_format: &'static str,
    staged_sha256: String,
    history_will_be_removed: bool,
) -> Result<ImportPreview> {
    let doc: Value = serde_json::from_str(source.authored_json())?;
    let (reachable_agents, reachable_compositions) = reachable(&doc);
    let mut refs = References {
        source,
        external: Vec::new(),
        content_uses: BTreeMap::new(),
    };
    let mut direct_calls = Vec::new();
    let mut mcp_uses = BTreeMap::new();
    let mut skill_uses = BTreeMap::new();
    let has_flow = doc.get("flow").is_some();

    let agents = fields(&doc["agents"])
        .map(|(id, agent)| {
            let usage = if reachable_agents.contains(id.as_str()) {
                Usage::Reachable
            } else if has_flow {
                Usage::DeclaredOnly
            } else {
                Usage::Unknown // The host can address agents directly without a flow.
            };
            refs.message(agent, &pointer("/agents", id), "instructions", usage);
            for skill in strings(&agent["skills"]) {
                record_use(&mut skill_uses, skill, usage);
            }
            let mcp_servers = strings(&agent["mcpServers"]);
            for server in &mcp_servers {
                record_use(&mut mcp_uses, server.clone(), usage.min(Usage::Unknown));
            }
            (
                id.clone(),
                AgentRequirement {
                    usage,
                    harness: text(&agent["harness"]),
                    harness_version: optional_text(&agent["harnessVersion"]),
                    model: agent.get("model").map(|model| ModelRequirement {
                        name: optional_text(&model["name"]),
                        effort: optional_text(&model["effort"]),
                    }),
                    permissions: permissions(&agent["permissions"]),
                    mcp_servers,
                    completion_check: optional_text(&agent["completionCheck"]["command"]),
                },
            )
        })
        .collect();

    let scopes = fields(&doc["compositions"]).map(|(name, body)| {
        let usage = if reachable_compositions.contains(name.as_str()) {
            Usage::Reachable
        } else {
            Usage::DeclaredOnly
        };
        (pointer("/compositions", name), body, usage)
    });
    for (base, body, usage) in
        std::iter::once(("/flow".to_owned(), &doc["flow"], Usage::Reachable)).chain(scopes)
    {
        refs.route(&body["onError"], &pointer(&base, "onError"), usage);
        for (id, step) in fields(&body["steps"]) {
            let at = pointer(&pointer(&base, "steps"), id);
            refs.message(step, &at, "prompt", usage);
            refs.route(&step["onError"], &pointer(&at, "onError"), usage);
            let next = &step["next"];
            let next_at = pointer(&at, "next");
            if next.is_object() && next.get("step").is_none() && next.get("output").is_none() {
                for (name, route) in fields(next) {
                    refs.route(route, &pointer(&next_at, name), usage);
                }
            } else {
                refs.route(next, &next_at, usage);
            }

            if step["type"] == "call" {
                let target = if let Some(command) = optional_text(&step["command"]) {
                    CallTarget::Shell { command }
                } else {
                    let server = text(&step["mcp"]["server"]);
                    record_use(&mut mcp_uses, server.clone(), usage);
                    CallTarget::Mcp {
                        server,
                        tool: text(&step["mcp"]["tool"]),
                    }
                };
                direct_calls.push(DirectCall {
                    location: location(source, &at),
                    usage,
                    target,
                });
            }
        }
    }

    for (id, content) in fields(&doc["content"]) {
        refs.uri(
            content,
            &pointer("/content", id),
            ReferenceKind::Content,
            usage_of(&refs.content_uses, id),
        );
    }
    for (id, skill) in fields(&doc["skills"]) {
        refs.uri(
            skill,
            &pointer("/skills", id),
            ReferenceKind::Skill,
            usage_of(&skill_uses, id),
        );
    }
    let mcp_servers = fields(&doc["mcpServers"])
        .map(|(id, server)| {
            let usage = usage_of(&mcp_uses, id);
            let transport = if let Some(url) = optional_text(&server["url"]) {
                refs.external.push(ExternalReference {
                    uri: url.clone(),
                    kind: ReferenceKind::McpEndpoint,
                    usage,
                    location: location(source, &pointer(&pointer("/mcpServers", id), "url")),
                });
                McpTransport::Remote { url }
            } else {
                McpTransport::Local {
                    command: strings(&server["command"]),
                }
            };
            let declared = |map: Option<&BTreeMap<String, Vec<String>>>| {
                map.and_then(|map| map.get(id)).cloned().unwrap_or_default()
            };
            (
                id.clone(),
                McpServer {
                    usage,
                    transport,
                    packaged_files: declared(source.mcp_files()),
                    required_secrets: declared(source.secrets()),
                },
            )
        })
        .collect();

    let mut warnings: Vec<_> = refs
        .external
        .iter()
        .filter(|entry| entry.kind == ReferenceKind::Skill)
        .map(|entry| PreviewWarning {
            code: "EXTERNAL_SKILL".into(),
            message: "Replace this external skill with a packaged skill before launch.".into(),
            launch_blocker: true,
            location: entry.location.clone(),
        })
        .collect();
    let report = argentic_core::validate_document_json(source.authored_json().as_bytes(), None)
        .map_err(|error| super::Error::Agsdl {
            code: error.code,
            file: None,
            pointer: error.pointer,
            message: error.message,
        })?;
    let report: Value = serde_json::from_str(&report)?;
    warnings.extend(
        items(&report["diagnostics"])
            .filter(|diagnostic| diagnostic["severity"] == "warning")
            .map(|diagnostic| PreviewWarning {
                code: text(&diagnostic["code"]),
                message: text(&diagnostic["message"]),
                launch_blocker: false,
                location: location(source, diagnostic["path"].as_str().unwrap_or("")),
            }),
    );

    Ok(ImportPreview {
        title: optional_text(&doc["title"]),
        authored_id: text(&doc["id"]),
        contract: text(&doc["contract"]),
        package_format,
        project_format: PROJECT_FORMAT,
        staged_sha256,
        history_will_be_removed,
        entry_point: optional_text(&doc["flow"]["entry"]),
        agents,
        direct_calls,
        mcp_servers,
        files: project::members(source)?
            .map(|member| PackagedFile {
                path: member.path.into(),
                size: member.bytes.len() as u64,
                executable: member.executable,
            })
            .collect(),
        external_references: refs.external,
        warnings,
    })
}

fn permissions(value: &Value) -> RequestedPermissions {
    RequestedPermissions {
        preset: optional_text(value).or_else(|| optional_text(&value["preset"])),
        directories: fields(&value["directories"])
            .map(|(path, access)| (path.clone(), text(access)))
            .collect(),
        outside: optional_text(&value["outside"]),
        reviewer: optional_text(&value["reviewer"]),
        rules: items(&value["rules"])
            .map(|rule| PermissionRule {
                action: text(&rule["action"]),
                pattern: optional_text(&rule["match"]),
                effect: text(&rule["effect"]),
            })
            .collect(),
    }
}

type Bindings<'a> = BTreeMap<&'a str, &'a str>;

fn reachable(doc: &Value) -> (BTreeSet<&str>, BTreeSet<&str>) {
    let mut agents = BTreeSet::new();
    let mut compositions = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut pending = vec![(&doc["flow"], Bindings::new())];
    // Argentic has validated reachability of every step in a scope and rejected
    // recursive compositions. Inspect each distinct parameter binding once.
    while let Some((body, bindings)) = pending.pop() {
        let resolve = |agent: &Value| {
            bindings
                .get(agent["parameter"].as_str().unwrap_or(""))
                .copied()
        };
        for (_, step) in fields(&body["steps"]) {
            match step["type"].as_str() {
                Some("agent") => {
                    if let Some(agent) = step["agent"].as_str().or_else(|| resolve(&step["agent"]))
                    {
                        agents.insert(agent);
                    }
                }
                Some("compose") => {
                    if let Some(name) = step["composition"].as_str() {
                        compositions.insert(name);
                        let bindings: Bindings<'_> = fields(&step["agents"])
                            .filter_map(|(id, agent)| {
                                agent
                                    .as_str()
                                    .or_else(|| resolve(agent))
                                    .map(|agent| (id.as_str(), agent))
                            })
                            .collect();
                        if seen.insert((name, bindings.clone())) {
                            pending.push((&doc["compositions"][name], bindings));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    (agents, compositions)
}

struct References<'a> {
    source: &'a OpenedSource,
    external: Vec<ExternalReference>,
    content_uses: BTreeMap<String, Usage>,
}

impl References<'_> {
    fn message(&mut self, message: &Value, at: &str, prompt: &str, usage: Usage) {
        for (i, source) in items(&message[prompt]).enumerate() {
            self.content(
                source,
                &pointer(&pointer(at, prompt), &i.to_string()),
                usage,
            );
        }
        for (id, source) in fields(&message["resources"]) {
            self.content(source, &pointer(&pointer(at, "resources"), id), usage);
        }
    }

    fn route(&mut self, route: &Value, at: &str, usage: Usage) {
        if route.is_array() {
            for (i, target) in items(route).enumerate() {
                self.message(
                    &target["message"],
                    &pointer(&pointer(at, &i.to_string()), "message"),
                    "prompt",
                    usage,
                );
            }
        } else {
            self.message(&route["message"], &pointer(at, "message"), "prompt", usage);
        }
    }

    fn content(&mut self, source: &Value, at: &str, usage: Usage) {
        if let Some(name) = optional_text(&source["ref"]) {
            record_use(&mut self.content_uses, name, usage);
        }
        self.uri(source, at, ReferenceKind::Content, usage);
    }

    fn uri(&mut self, value: &Value, at: &str, kind: ReferenceKind, usage: Usage) {
        if let Some(uri) = value["uri"].as_str().filter(|uri| has_uri_scheme(uri)) {
            self.external.push(ExternalReference {
                uri: uri.into(),
                kind,
                usage,
                location: location(self.source, &pointer(at, "uri")),
            });
        }
    }
}

fn has_uri_scheme(uri: &str) -> bool {
    uri.split_once(':').is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b))
    })
}

fn pointer(base: &str, key: &str) -> String {
    format!("{base}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn location(source: &OpenedSource, at: &str) -> Location {
    let (file, pointer) = source
        .component_origin(at)
        .unwrap_or((project::MANIFEST, at));
    Location {
        file: file.into(),
        pointer: pointer.into(),
    }
}

fn record_use(uses: &mut BTreeMap<String, Usage>, id: String, usage: Usage) {
    let current = uses.entry(id).or_insert(usage);
    *current = (*current).max(usage);
}

fn usage_of(uses: &BTreeMap<String, Usage>, id: &str) -> Usage {
    uses.get(id).copied().unwrap_or(Usage::DeclaredOnly)
}

fn fields(value: &Value) -> impl Iterator<Item = (&String, &Value)> {
    value.as_object().into_iter().flatten()
}

fn items(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn optional_text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn text(value: &Value) -> String {
    optional_text(value).unwrap_or_default()
}

fn strings(value: &Value) -> Vec<String> {
    items(value).filter_map(optional_text).collect()
}
