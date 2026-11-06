//! Runtime permission admission. The host must still confine the actual effect.
//! Authored/module validation remains in the AgSDL validator, not this module.
mod enforcement;
mod paths;
#[cfg(test)]
mod tests;

pub use enforcement::*;
pub use paths::{DirectoryGrant, NormalizedRule, PathContext};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Read,
    Write,
    Shell,
    Network,
    Mcp,
    Delegate,
}
pub const ACTIONS: [Action; 6] = [
    Action::Read,
    Action::Write,
    Action::Shell,
    Action::Network,
    Action::Mcp,
    Action::Delegate,
];

/// Declaration order is the restriction order. Intersections use max.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum Effect {
    Allow,
    Ask,
    Deny,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum Preset {
    ReadOnly,
    Workspace,
    Full,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum DirectoryAccess {
    Read,
    Write,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum Outside {
    Read,
    Deny,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum Reviewer {
    Model,
    Person,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct PermissionRule {
    pub action: Action,
    #[serde(rename = "match", default)]
    pub pattern: Option<String>,
    pub effect: Effect,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct PermissionObject {
    pub preset: Option<Preset>,
    #[serde(default)]
    pub directories: BTreeMap<String, DirectoryAccess>,
    pub outside: Option<Outside>,
    #[serde(default)]
    pub rules: Vec<PermissionRule>,
    pub reviewer: Option<Reviewer>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(untagged)]
pub enum RequestedPermissions {
    Preset(Preset),
    Object(PermissionObject),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum ActionRequest {
    Read {
        path: String,
    },
    Write {
        path: String,
    },
    Shell {
        command: String,
    },
    Network {
        host: String,
    },
    Mcp {
        server: String,
        tool: Option<String>,
    },
    Delegate {},
}
impl ActionRequest {
    pub fn action(&self) -> Action {
        match self {
            Self::Read { .. } => Action::Read,
            Self::Write { .. } => Action::Write,
            Self::Shell { .. } => Action::Shell,
            Self::Network { .. } => Action::Network,
            Self::Mcp { .. } => Action::Mcp,
            Self::Delegate {} => Action::Delegate,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionPurpose {
    Agent,
    PlanLocked,
    CompletionCheck,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub policy_digest: String,
    pub request: ActionRequest,
    pub purpose: ExecutionPurpose,
    pub effect: Effect,
    pub reviewer: Option<Reviewer>,
    /// Snapshot for correlation only. It is not a handle or a TOCTOU defense.
    pub resolved_path: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionError {
    pub code: String,
    pub detail: String,
}
pub type Result<T> = std::result::Result<T, PermissionError>;
pub(super) fn invalid(detail: impl Into<String>) -> PermissionError {
    PermissionError {
        code: "PERMISSION".into(),
        detail: detail.into(),
    }
}

/// Native-only construction prevents untrusted deserialization of an authority.
#[derive(Debug, Clone, Serialize)]
pub struct NormalizedPolicy {
    context: PathContext,
    preset: Option<Preset>,
    directories: Vec<DirectoryGrant>,
    outside: Outside,
    rules: Vec<NormalizedRule>,
    reviewer: Option<Reviewer>,
}

impl NormalizedPolicy {
    pub fn context(&self) -> &PathContext {
        &self.context
    }
    pub fn preset(&self) -> Option<Preset> {
        self.preset
    }
    pub fn directories(&self) -> &[DirectoryGrant] {
        &self.directories
    }
    pub fn outside(&self) -> Outside {
        self.outside
    }
    pub fn rules(&self) -> &[NormalizedRule] {
        &self.rules
    }
    pub fn reviewer(&self) -> Option<Reviewer> {
        self.reviewer
    }
}

pub fn normalize_requested(
    requested: RequestedPermissions,
    context: PathContext,
) -> Result<NormalizedPolicy> {
    let object = match requested {
        RequestedPermissions::Preset(preset) => PermissionObject {
            preset: Some(preset),
            ..Default::default()
        },
        RequestedPermissions::Object(object) => object,
    };
    let context = context.normalize()?;
    let mut directories = Vec::new();
    for (path, access) in object.directories {
        if object.preset == Some(Preset::ReadOnly) && access == DirectoryAccess::Write {
            return Err(invalid("read-only cannot contain a write directory"));
        }
        directories.push(DirectoryGrant::new(&context, &path, access)?);
    }
    let rules = object
        .rules
        .into_iter()
        .map(|rule| NormalizedRule::new(&context, rule))
        .collect::<Result<_>>()?;
    Ok(NormalizedPolicy {
        context,
        preset: object.preset,
        directories,
        outside: object
            .outside
            .unwrap_or(if object.preset == Some(Preset::Full) {
                Outside::Read
            } else {
                Outside::Deny
            }),
        rules,
        reviewer: object.reviewer,
    })
}

pub fn evaluate_requested(policy: &NormalizedPolicy, request: &ActionRequest) -> Result<Effect> {
    let subject = paths::Subject::new(&policy.context, request)?;
    evaluate_subject(policy, request.action(), &subject)
}
fn evaluate_subject(
    policy: &NormalizedPolicy,
    action: Action,
    subject: &paths::Subject,
) -> Result<Effect> {
    // Restrictive rules see both the requested name and its physical target.
    // Allows must cover both, so an alias cannot grant access to another target.
    let mut matched = None;
    for rule in &policy.rules {
        if rule.matches(action, subject)? {
            matched = Some(matched.unwrap_or(Effect::Allow).max(rule.effect));
        }
    }
    if let Some(effect) = matched {
        return Ok(effect);
    }
    let Some(preset) = policy.preset else {
        return Ok(Effect::Deny);
    };
    if action == Action::Read || action == Action::Write {
        let path = subject
            .physical
            .as_ref()
            .ok_or_else(|| invalid("Missing resolved path"))?;
        let mut inside = paths::contains(&policy.context.workspace, path);
        let mut read_directory = false;
        // Every containing read root is a ceiling, including a broader root.
        for directory in &policy.directories {
            if paths::contains(&directory.canonical, path) {
                inside = true;
                read_directory |= directory.access == DirectoryAccess::Read;
            }
        }
        return Ok(match action {
            Action::Read if inside || policy.outside == Outside::Read => Effect::Allow,
            Action::Write
                if preset != Preset::ReadOnly
                    && !read_directory
                    && (inside || preset == Preset::Full) =>
            {
                Effect::Allow
            }
            _ => Effect::Deny,
        });
    }
    Ok(match (preset, action) {
        (Preset::ReadOnly, _) | (Preset::Workspace, Action::Network) => Effect::Deny,
        _ => Effect::Allow,
    })
}

/// Each ceiling remains independent: concatenating rule lists could turn a
/// parent's default deny into a child's explicit allow.
#[derive(Debug, Clone, Serialize)]
pub struct EffectivePolicy {
    ceilings: Vec<NormalizedPolicy>,
    current: NormalizedPolicy,
}
// Private decoding shapes keep untrusted authored input out of sealed captures.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredPolicy {
    context: PathContext,
    preset: Option<Preset>,
    directories: Vec<DirectoryGrant>,
    outside: Outside,
    rules: Vec<NormalizedRule>,
    reviewer: Option<Reviewer>,
}
impl StoredPolicy {
    fn restore(self) -> NormalizedPolicy {
        NormalizedPolicy {
            context: self.context,
            preset: self.preset,
            directories: self.directories,
            outside: self.outside,
            rules: self.rules,
            reviewer: self.reviewer,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCapture {
    ceilings: Vec<StoredPolicy>,
    current: StoredPolicy,
}

impl EffectivePolicy {
    /// Restore only from the host's private durable capture. The expected digest
    /// comes from that authority, never from the document/provider alongside JSON.
    /// Preserve captured canonical paths even when symlinks changed since launch.
    pub fn restore_capture(json: &str, expected_digest: &str) -> Result<Self> {
        let stored: StoredCapture = serde_json::from_str(json)
            .map_err(|_| invalid("Malformed native permission capture"))?;
        let policy = Self {
            ceilings: stored
                .ceilings
                .into_iter()
                .map(StoredPolicy::restore)
                .collect(),
            current: stored.current.restore(),
        };
        if policy.ceilings.len() < 3 || policy.fingerprint() != expected_digest {
            return Err(invalid(
                "Native permission capture differs from its trusted digest",
            ));
        }
        Ok(policy)
    }
    pub fn new(
        requested: NormalizedPolicy,
        host: NormalizedPolicy,
        current: NormalizedPolicy,
    ) -> Self {
        Self {
            ceilings: vec![requested, host, current.clone()],
            current,
        }
    }
    /// Replaces only the live policy; the original captured current policy stays.
    pub fn with_current(&self, current: NormalizedPolicy) -> Self {
        Self {
            ceilings: self.ceilings.clone(),
            current,
        }
    }
    pub fn fingerprint(&self) -> String {
        // All fields are native-owned strings/enums/sequences with stable ordering.
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("permission serialization"))
        )
    }
    pub fn policies(&self) -> impl Iterator<Item = &NormalizedPolicy> {
        self.ceilings.iter().chain(std::iter::once(&self.current))
    }
}

pub fn evaluate_effective(
    policy: &EffectivePolicy,
    request: &ActionRequest,
    purpose: ExecutionPurpose,
) -> Result<PermissionDecision> {
    let mut effect = Effect::Allow;
    let mut reviewer = None;
    let mut resolved_path = None;
    for ceiling in policy.policies() {
        let subject = paths::Subject::new(&ceiling.context, request)?;
        if let Some(path) = &subject.physical {
            let path = paths::text(path)?;
            if resolved_path
                .as_ref()
                .is_some_and(|previous| previous != &path)
            {
                return Err(invalid("Permission ceilings resolve the action to different paths; use an absolute path"));
            }
            resolved_path = Some(path);
        }
        let decision = evaluate_subject(ceiling, request.action(), &subject)?;
        effect = effect.max(decision);
        reviewer = match (reviewer, ceiling.reviewer) {
            (Some(Reviewer::Person), _) | (_, Some(Reviewer::Person)) => Some(Reviewer::Person),
            (Some(Reviewer::Model), _) | (_, Some(Reviewer::Model)) => Some(Reviewer::Model),
            _ => None,
        };
    }
    // Opaque shell/MCP/network/delegate can mutate despite a read-looking name.
    if purpose == ExecutionPurpose::PlanLocked && request.action() != Action::Read {
        effect = Effect::Deny;
    }
    if effect != Effect::Ask {
        reviewer = None;
    }
    Ok(PermissionDecision {
        policy_digest: policy.fingerprint(),
        request: request.clone(),
        purpose,
        effect,
        reviewer,
        resolved_path,
    })
}

/// The caller must separately admit the parent's Delegate action before spawn.
/// Copying all parent ceilings also fences shell-launched children when09 applies
/// the resulting confinement to the process tree.
pub fn derive_child_capture(
    parent: &EffectivePolicy,
    requested: NormalizedPolicy,
) -> Result<EffectivePolicy> {
    let mut ceilings = parent.ceilings.clone();
    ceilings.push(parent.current.clone());
    ceilings.push(requested);
    Ok(EffectivePolicy {
        ceilings,
        current: parent.current.clone(),
    })
}
