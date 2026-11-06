use super::*;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathContext {
    pub workspace: PathBuf,
    pub home: PathBuf,
}
impl PathContext {
    pub(super) fn normalize(self) -> Result<Self> {
        if !self.workspace.is_absolute() || !self.home.is_absolute() {
            return Err(invalid("Workspace and home must be absolute"));
        }
        let workspace = std::fs::canonicalize(self.workspace)
            .map_err(|e| invalid(format!("Workspace: {e}")))?;
        let home = std::fs::canonicalize(self.home).map_err(|e| invalid(format!("Home: {e}")))?;
        if !workspace.is_dir() || !home.is_dir() {
            return Err(invalid("Workspace and home must be directories"));
        }
        text(&workspace)?;
        text(&home)?;
        Ok(Self { workspace, home })
    }
}
pub(super) fn text(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid("Non-UTF-8 paths require an explicit native adapter"))
}
pub(super) fn contains(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}
fn expand(context: &PathContext, input: &str) -> Result<PathBuf> {
    if input.is_empty()
        || input.contains('\0')
        || input.contains('\\')
        || input.starts_with('~') && !input.starts_with("~/")
    {
        return Err(invalid("Invalid or unsupported path spelling"));
    }
    let path = if let Some(relative) = input.strip_prefix("~/") {
        context.home.join(relative)
    } else if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        context.workspace.join(input)
    };
    Ok(path)
}
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(component.as_os_str()),
        }
    }
    out
}
/// Resolve each existing prefix before processing `..`: link/.. is the parent
/// of the link target, not of the link name. Missing tails support file creation.
fn physical(path: &Path) -> Result<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::Prefix(_) => out.push(component.as_os_str()),
            Component::Normal(name) => {
                out.push(name);
                match std::fs::symlink_metadata(&out) {
                    Ok(_) => {
                        out = std::fs::canonicalize(&out)
                            .map_err(|e| invalid(format!("Path cannot be resolved: {e}")))?
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(invalid(format!("Path cannot be inspected: {error}")))
                    }
                }
            }
        }
    }
    Ok(out)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryGrant {
    pub canonical: PathBuf,
    pub access: DirectoryAccess,
}
impl DirectoryGrant {
    pub(super) fn new(context: &PathContext, input: &str, access: DirectoryAccess) -> Result<Self> {
        let expanded = expand(context, input)?;
        if input.contains('*') {
            return Err(invalid("Directory roots cannot be patterns"));
        }
        let canonical = physical(&expanded)?;
        if !canonical.is_dir() {
            return Err(invalid(
                "Permission directory does not exist or is not a directory",
            ));
        }
        Ok(Self { canonical, access })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedRule {
    pub action: Action,
    pub effect: Effect,
    pub pattern: Option<String>,
    logical: Option<String>,
    physical: Option<String>,
}
fn pattern_paths(context: &PathContext, pattern: &str) -> Result<(String, String)> {
    let expanded = expand(context, pattern)?;
    // Resolve only complete literal path components before the first wildcard.
    let components: Vec<_> = expanded.components().collect();
    let first_glob = components
        .iter()
        .position(|c| c.as_os_str().to_string_lossy().contains('*'))
        .unwrap_or(components.len());
    let prefix: PathBuf = components[..first_glob]
        .iter()
        .map(|c| c.as_os_str())
        .collect();
    let mut canonical = physical(&prefix)?;
    for c in &components[first_glob..] {
        // A parent component after a glob is ambiguous: do not invent its meaning.
        if *c == Component::ParentDir {
            return Err(invalid("A path pattern cannot contain .. after a wildcard"));
        }
        canonical.push(c.as_os_str());
    }
    Ok((text(&lexical(&expanded))?, text(&canonical)?))
}
impl NormalizedRule {
    pub fn logical_pattern(&self) -> Option<&str> {
        self.logical.as_deref()
    }
    pub fn physical_pattern(&self) -> Option<&str> {
        self.physical.as_deref()
    }
    pub(super) fn new(context: &PathContext, mut rule: PermissionRule) -> Result<Self> {
        if rule.action == Action::Delegate && rule.pattern.is_some() {
            return Err(invalid("delegate does not take match"));
        }
        if rule.action == Action::Network {
            rule.pattern = rule.pattern.map(|pattern| {
                pattern
                    .to_ascii_lowercase()
                    .trim_end_matches('.')
                    .to_owned()
            });
        }
        let (logical, physical) = match (&rule.pattern, rule.action) {
            (Some(pattern), Action::Read | Action::Write) => {
                let (a, b) = pattern_paths(context, pattern)?;
                (Some(a), Some(b))
            }
            (Some(pattern), _) if pattern.is_empty() || pattern.contains('\0') => {
                return Err(invalid("Empty or NUL pattern"))
            }
            _ => (None, None),
        };
        Ok(Self {
            action: rule.action,
            effect: rule.effect,
            pattern: rule.pattern,
            logical,
            physical,
        })
    }
    pub(super) fn matches(&self, action: Action, subject: &Subject) -> Result<bool> {
        if action != self.action {
            return Ok(false);
        }
        let Some(pattern) = &self.pattern else {
            return Ok(true);
        };
        if let Some(physical_pattern) = &self.physical {
            let a = glob(
                self.logical.as_ref().unwrap(),
                &subject.logical,
                true,
                false,
            )?;
            let b = glob(
                physical_pattern,
                &text(subject.physical.as_ref().unwrap())?,
                true,
                false,
            )?;
            return Ok(if self.effect == Effect::Allow {
                a && b
            } else {
                a || b
            });
        }
        let subject = if action == Action::Mcp && !pattern.contains('/') {
            &subject.server
        } else {
            &subject.logical
        };
        glob(pattern, subject, false, action == Action::Shell)
    }
    pub(super) fn covers_all(&self) -> bool {
        match &self.pattern {
            None => true,
            Some(p) if matches!(self.action, Action::Read | Action::Write) => p == "/**",
            Some(p) => !p.is_empty() && p.chars().all(|c| c == '*'),
        }
    }
}
pub(super) struct Subject {
    pub logical: String,
    pub physical: Option<PathBuf>,
    server: String,
}
impl Subject {
    pub(super) fn new(context: &PathContext, request: &ActionRequest) -> Result<Self> {
        let mut subject = Self {
            logical: String::new(),
            physical: None,
            server: String::new(),
        };
        match request {
            ActionRequest::Read { path } | ActionRequest::Write { path } => {
                let path = expand(context, path)?;
                subject.logical = text(&lexical(&path))?;
                subject.physical = Some(physical(&path)?);
            }
            ActionRequest::Shell { command } => {
                if command.is_empty() || command.contains('\0') {
                    return Err(invalid("Invalid command"));
                }
                subject.logical = command.clone();
            }
            ActionRequest::Network { host } => {
                let host = host.to_ascii_lowercase();
                let host = host.strip_suffix('.').unwrap_or(&host);
                // Ports, URLs and userinfo are not destination hosts.09 must
                // supply the actual host again at each redirect/connection.
                let ip = host.parse::<std::net::IpAddr>().is_ok();
                let domain = !host.is_empty()
                    && host.len() <= 253
                    && host.split('.').all(|label| {
                        !label.is_empty()
                            && label.len() <= 63
                            && !label.starts_with('-')
                            && !label.ends_with('-')
                            && label
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    });
                if !ip && !domain {
                    return Err(invalid(
                        "Network subject must be a destination IP or ASCII/IDNA host without port",
                    ));
                }
                subject.logical = host.into();
            }
            ActionRequest::Mcp { server, tool } => {
                if server.is_empty()
                    || server.contains(['/', '*', '\0'])
                    || tool
                        .as_ref()
                        .is_some_and(|t| t.is_empty() || t.contains(['/', '*', '\0']))
                {
                    return Err(invalid(
                        "MCP identity requires separate unambiguous server and tool names",
                    ));
                }
                subject.server = server.clone();
                subject.logical = tool
                    .as_ref()
                    .map_or_else(|| server.clone(), |t| format!("{server}/{t}"));
            }
            ActionRequest::Delegate {} => {}
        }
        Ok(subject)
    }
}
/// Text matching only. This is never a parser or confinement for shell effects.
pub(super) fn glob(pattern: &str, subject: &str, paths: bool, command: bool) -> Result<bool> {
    if command
        && pattern
            .strip_suffix(" *")
            .is_some_and(|base| base == subject)
    {
        return Ok(true);
    }
    let mut expression = String::from("(?s)\\A");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '*' {
            if paths && chars.peek() == Some(&'*') {
                chars.next();
                expression.push_str(".*");
            } else {
                expression.push_str(if paths { "[^/]*" } else { ".*" });
            }
        } else {
            expression.push_str(&regex::escape(&c.to_string()));
        }
    }
    expression.push_str("\\z");
    regex::Regex::new(&expression)
        .map(|r| r.is_match(subject))
        .map_err(|_| invalid("Permission pattern exceeds matcher limits"))
}
