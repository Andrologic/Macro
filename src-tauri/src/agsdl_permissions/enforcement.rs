//! Requirements for09's observed adapter qualification. A module.json declaration
//! is deliberately not an input. Evidence references are host-owned probe records;
//! checking this envelope does not itself prove or install an OS sandbox.
use super::*;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum EnforcementMechanism {
    Sandbox,
    Harness,
    Unavailable,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum ShellMatching {
    CommandText,
    Prefix,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedGuarantee {
    pub action: Action,
    pub effect: Effect,
    pub mechanism: EnforcementMechanism,
    /// Probe must cover the entire action, all corresponding native tools and
    /// aliases. For sandbox ask, shell has no bypass while mediated tools ask.
    pub evidence: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnforcementObservation {
    pub policy_digest: String,
    pub qualification_id: String,
    pub platform: String,
    pub harness_version: String,
    pub guarantees: Vec<ObservedGuarantee>,
    pub shell_matching: ShellMatching,
    /// Empty when shell exists. Otherwise an observed absence of every shell
    /// entry point, not merely a missing tool in a catalogue.
    pub shell_absent_evidence: Option<String>,
    /// Native observation that no MCP server, tool or resource is exposed.
    #[serde(default)]
    pub mcp_absent_evidence: Option<String>,
    pub outside_read_evidence: Option<String>,
    pub path_race_evidence: Option<String>,
    pub descendant_ceiling_evidence: Option<String>,
    pub plan_lock_evidence: Option<String>,
    pub completion_check_evidence: Option<String>,
    pub person_reviewer_evidence: Option<String>,
    pub model_reviewer_evidence: Option<String>,
    /// Model may fall back to a person, never the reverse.
    pub model_fallback_to_person: bool,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementRequirement {
    pub action: Action,
    pub effect: Effect,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementPlan {
    pub policy_digest: String,
    pub qualification_id: String,
    pub requirements: Vec<EnforcementRequirement>,
    pub evidence: Vec<String>,
    pub reviewer: Reviewer,
    pub purpose: ExecutionPurpose,
}
fn present(value: &Option<String>) -> bool {
    value.as_ref().is_some_and(|s| !s.trim().is_empty())
}
fn need(value: &Option<String>, name: &str, evidence: &mut Vec<String>) -> Result<()> {
    if !present(value) {
        return Err(invalid(format!("Missing observed {name}")));
    }
    evidence.push(value.as_ref().unwrap().clone());
    Ok(())
}
fn shell_possible(policy: &NormalizedPolicy) -> bool {
    let rules: Vec<_> = policy
        .rules
        .iter()
        .filter(|r| r.action == Action::Shell)
        .collect();
    if rules
        .iter()
        .any(|r| r.effect == Effect::Deny && r.covers_all())
    {
        return false;
    }
    rules.iter().any(|r| r.effect != Effect::Deny)
        || matches!(policy.preset, Some(Preset::Workspace | Preset::Full))
}
fn default_denies_action(preset: Option<Preset>, action: Action) -> bool {
    matches!(
        (preset, action),
        (None, _)
            | (
                Some(Preset::ReadOnly),
                Action::Write | Action::Shell | Action::Network | Action::Mcp | Action::Delegate
            )
            | (Some(Preset::Workspace), Action::Network)
    )
}
fn universally_denies(policy: &NormalizedPolicy, action: Action) -> bool {
    let rules: Vec<_> = policy
        .rules
        .iter()
        .filter(|rule| rule.action == action)
        .collect();
    rules
        .iter()
        .any(|rule| rule.effect == Effect::Deny && rule.covers_all())
        || (default_denies_action(policy.preset, action)
            && rules.iter().all(|rule| rule.effect == Effect::Deny))
}

fn requirements(policy: &NormalizedPolicy, action: Action) -> BTreeSet<Effect> {
    let rules: Vec<_> = policy.rules.iter().filter(|r| r.action == action).collect();
    let mut effects: BTreeSet<_> = rules.iter().map(|r| r.effect).collect();
    if !rules.iter().any(|r| r.covers_all()) {
        let default = if default_denies_action(policy.preset, action) {
            Effect::Deny
        } else {
            Effect::Allow
        };
        effects.insert(default);
        if action == Action::Write && policy.preset != Some(Preset::Full) {
            effects.insert(Effect::Deny);
        }
        if action == Action::Read && policy.outside == Outside::Deny {
            effects.insert(Effect::Deny);
        }
        if action == Action::Write
            && policy
                .directories
                .iter()
                .any(|d| d.access == DirectoryAccess::Read)
        {
            effects.insert(Effect::Deny);
        }
    }
    effects.remove(&Effect::Allow);
    effects
}
fn prefix(pattern: &str) -> bool {
    let words = pattern.strip_suffix(" *").unwrap_or(pattern);
    !words.is_empty() && words.trim() == words && !words.contains('*')
}

pub fn check_enforcement(
    policy: &EffectivePolicy,
    observed: &EnforcementObservation,
    purpose: ExecutionPurpose,
) -> Result<EnforcementPlan> {
    if observed.policy_digest != policy.fingerprint()
        || observed.qualification_id.trim().is_empty()
        || observed.platform.trim().is_empty()
        || observed.harness_version.trim().is_empty()
    {
        return Err(invalid(
            "Qualification is absent or belongs to another policy",
        ));
    }
    // A verified plan lock denies every shell action during this purpose only.
    let shell = purpose != ExecutionPurpose::PlanLocked
        && !present(&observed.shell_absent_evidence)
        && policy.policies().all(shell_possible);
    let mut required = BTreeSet::new();
    for layer in policy.policies() {
        for action in ACTIONS {
            for effect in requirements(layer, action) {
                required.insert((action, effect));
            }
        }
    }
    // A universal denial in any ceiling makes all less restrictive effects
    // unreachable, even when another layer has an ask rule for the action.
    for action in ACTIONS {
        let denied = (purpose == ExecutionPurpose::PlanLocked && action != Action::Read)
            || policy
                .policies()
                .any(|layer| universally_denies(layer, action));
        if denied {
            required.remove(&(action, Effect::Ask));
            required.insert((action, Effect::Deny));
        }
    }
    if present(&observed.mcp_absent_evidence) {
        required.retain(|(action, _)| *action != Action::Mcp);
    }
    let mut evidence = Vec::new();
    if let Some(absent) = &observed.mcp_absent_evidence {
        if !absent.trim().is_empty() {
            evidence.push(absent.clone());
        }
    }
    if let Some(absent) = &observed.shell_absent_evidence {
        if !absent.trim().is_empty() {
            evidence.push(absent.clone());
        }
    }
    for &(action, effect) in &required {
        let guarantee = observed
            .guarantees
            .iter()
            .find(|g| {
                g.action == action
                    && g.effect == effect
                    && !g.evidence.trim().is_empty()
                    && (g.mechanism != EnforcementMechanism::Unavailable || effect == Effect::Deny)
                    && !(shell
                        && matches!(action, Action::Read | Action::Write | Action::Network)
                        && g.mechanism != EnforcementMechanism::Sandbox)
                    && !(action == Action::Shell
                        && g.mechanism == EnforcementMechanism::Harness
                        && observed.shell_matching == ShellMatching::Prefix
                        && !(effect == Effect::Deny
                            && (purpose == ExecutionPurpose::PlanLocked
                                || policy
                                    .policies()
                                    .any(|layer| universally_denies(layer, action))))
                        && policy.policies().any(|layer| {
                            layer.rules.iter().any(|r| {
                                r.action == action
                                    && r.effect == effect
                                    && r.pattern
                                        .as_ref()
                                        .is_some_and(|p| !r.covers_all() && !prefix(p))
                            })
                        }))
            })
            .ok_or_else(|| invalid(format!("No observed enforcement for {action:?}/{effect:?}")))?;
        evidence.push(guarantee.evidence.clone());
    }
    let filesystem_restricted = required
        .iter()
        .any(|(a, _)| matches!(a, Action::Read | Action::Write));
    if filesystem_restricted {
        need(
            &observed.path_race_evidence,
            "race-safe filesystem confinement",
            &mut evidence,
        )?;
    }
    if policy.policies().any(|p| {
        p.preset.is_some()
            && p.outside == Outside::Deny
            && !p
                .rules
                .iter()
                .any(|r| r.action == Action::Read && r.covers_all())
    }) {
        need(
            &observed.outside_read_evidence,
            "outside-read confinement",
            &mut evidence,
        )?;
    }
    if shell
        || !policy
            .policies()
            .any(|p| requirements(p, Action::Delegate).contains(&Effect::Deny))
    {
        need(
            &observed.descendant_ceiling_evidence,
            "descendant ceiling confinement",
            &mut evidence,
        )?;
    }
    if purpose == ExecutionPurpose::PlanLocked {
        need(&observed.plan_lock_evidence, "plan lock", &mut evidence)?;
    }
    if purpose == ExecutionPurpose::CompletionCheck {
        need(
            &observed.completion_check_evidence,
            "completion-check ceiling",
            &mut evidence,
        )?;
    }
    let asks = required.iter().any(|(_, e)| *e == Effect::Ask);
    let person = policy
        .policies()
        .any(|p| p.reviewer == Some(Reviewer::Person));
    let model = policy
        .policies()
        .any(|p| p.reviewer == Some(Reviewer::Model));
    let reviewer = if asks && !person && model && present(&observed.model_reviewer_evidence) {
        Reviewer::Model
    } else {
        Reviewer::Person
    };
    if asks {
        if !person && model && reviewer == Reviewer::Person && !observed.model_fallback_to_person {
            return Err(invalid(
                "Model reviewer unavailable; fallback to person not declared",
            ));
        }
        need(
            if reviewer == Reviewer::Person {
                &observed.person_reviewer_evidence
            } else {
                &observed.model_reviewer_evidence
            },
            "reviewer mediation",
            &mut evidence,
        )?;
    }
    Ok(EnforcementPlan {
        policy_digest: policy.fingerprint(),
        qualification_id: observed.qualification_id.clone(),
        requirements: required
            .into_iter()
            .map(|(action, effect)| EnforcementRequirement { action, effect })
            .collect(),
        evidence,
        reviewer,
        purpose,
    })
}
