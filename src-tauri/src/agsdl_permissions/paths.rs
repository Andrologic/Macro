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
                let pattern = pattern.to_ascii_lowercase();
                let pattern = pattern.trim_end_matches('.');
                pattern
                    .parse::<std::net::IpAddr>()
                    .map_or_else(|_| pattern.to_owned(), |ip| ip.to_string())
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
        if action == Action::Network {
            if let Ok(ip) = subject.logical.parse::<std::net::IpAddr>() {
                return network_ip_matches(pattern, ip);
            }
        }
        let subject = if action == Action::Mcp && !pattern.contains('/') {
            &subject.server
        } else {
            &subject.logical
        };
        glob(pattern, subject, false, action == Action::Shell)
    }
    /// Identical scopes give the same match set for asks and denies, including
    /// both logical and physical path patterns captured under their contexts.
    pub(super) fn same_scope(&self, other: &Self) -> bool {
        self.action == other.action
            && self.pattern == other.pattern
            && self.logical == other.logical
            && self.physical == other.physical
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
                let ip = host.parse::<std::net::IpAddr>();
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
                if ip.is_err() && !domain {
                    return Err(invalid(
                        "Network subject must be a destination IP or ASCII/IDNA host without port",
                    ));
                }
                subject.logical = ip.map_or_else(|_| host.to_owned(), |ip| ip.to_string());
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

/// Match every legal textual spelling of an IP. An IPv6 address has optional
/// hextet zero padding, one optional compressed zero run, and possibly a dotted
/// IPv4 tail. Using a set of glob states avoids generating all padded strings.
/// This ensures a restrictive authored pattern cannot be evaded by spelling.
fn network_ip_matches(pattern: &str, ip: std::net::IpAddr) -> Result<bool> {
    use std::net::IpAddr;
    // Adjacent stars are equivalent to one star. Collapse them before the
    // state machine so its epsilon closure has at most one transition.
    let mut compact = Vec::with_capacity(pattern.len());
    for byte in pattern.bytes() {
        if byte != b'*' || compact.last() != Some(&b'*') {
            compact.push(byte);
        }
    }
    let matches_v6 = |ip: std::net::Ipv6Addr| ipv6_glob(&compact, ip);
    match ip {
        IpAddr::V4(ip) => {
            Ok(glob(pattern, &ip.to_string(), false, false)? || matches_v6(ip.to_ipv6_mapped()))
        }
        IpAddr::V6(ip) => {
            let v4_match = if let Some(mapped) = ip.to_ipv4_mapped() {
                glob(pattern, &mapped.to_string(), false, false)?
            } else {
                false
            };
            Ok(v4_match || matches_v6(ip))
        }
    }
}

fn glob_advance(pattern: &[u8], states: &[usize], value: &[u8]) -> Vec<usize> {
    fn closure(pattern: &[u8], states: &mut Vec<usize>) {
        let skips: Vec<_> = states
            .iter()
            .copied()
            .filter(|&state| pattern.get(state) == Some(&b'*'))
            .map(|state| state + 1)
            .collect();
        states.extend(skips);
        states.sort_unstable();
        states.dedup();
    }
    let mut states = states.to_vec();
    closure(pattern, &mut states);
    for &byte in value {
        let mut next = Vec::new();
        for &state in &states {
            match pattern.get(state) {
                Some(b'*') => next.push(state),
                Some(&literal) if literal == byte => next.push(state + 1),
                _ => {}
            }
        }
        next.sort_unstable();
        next.dedup();
        closure(pattern, &mut next);
        states = next;
        if states.is_empty() {
            break;
        }
    }
    states
}

fn ipv6_form_matches(
    pattern: &[u8],
    groups: &[u16],
    compressed: Option<(usize, usize)>,
    dotted: Option<&str>,
) -> bool {
    let mut states = glob_advance(pattern, &[0], b"");
    let mut group = 0;
    let mut previous_compressed = false;
    while group < groups.len() {
        if let Some((start, end)) = compressed {
            if group == start {
                states = glob_advance(pattern, &states, b"::");
                group = end;
                previous_compressed = true;
                continue;
            }
        }
        if group > 0 && !previous_compressed {
            states = glob_advance(pattern, &states, b":");
        }
        previous_compressed = false;
        let width = format!("{:x}", groups[group]).len();
        let mut combined = Vec::new();
        for width in width..=4 {
            let text = format!("{:0width$x}", groups[group], width = width);
            combined.extend(glob_advance(pattern, &states, text.as_bytes()));
        }
        combined.sort_unstable();
        combined.dedup();
        states = combined;
        group += 1;
    }
    if let Some(dotted) = dotted {
        if !previous_compressed {
            states = glob_advance(pattern, &states, b":");
        }
        states = glob_advance(pattern, &states, dotted.as_bytes());
    }
    states.contains(&pattern.len())
}

fn ipv6_glob(pattern: &[u8], ip: std::net::Ipv6Addr) -> bool {
    let groups = ip.segments();
    let octets = ip.octets();
    let dotted = format!(
        "{}.{}.{}.{}",
        octets[12], octets[13], octets[14], octets[15]
    );
    for (groups, tail) in [(&groups[..], None), (&groups[..6], Some(dotted.as_str()))] {
        if ipv6_form_matches(pattern, groups, None, tail) {
            return true;
        }
        for start in 0..groups.len() {
            for end in start + 1..=groups.len() {
                if groups[end - 1] != 0 {
                    break;
                }
                if ipv6_form_matches(pattern, groups, Some((start, end)), tail) {
                    return true;
                }
            }
        }
    }
    false
}
