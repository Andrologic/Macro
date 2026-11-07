use super::*;
use serde_json::json;
use std::fs;

struct Fixture {
    _temp: tempfile::TempDir,
    context: PathContext,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let home = temp.path().join("home");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&home).unwrap();
        Self {
            _temp: temp,
            context: PathContext {
                workspace: fs::canonicalize(root).unwrap(),
                home: fs::canonicalize(home).unwrap(),
            },
        }
    }
    fn policy(&self, value: serde_json::Value) -> NormalizedPolicy {
        normalize_requested(serde_json::from_value(value).unwrap(), self.context.clone()).unwrap()
    }
    fn effective(&self, value: serde_json::Value) -> EffectivePolicy {
        EffectivePolicy::new(
            self.policy(value),
            self.policy(json!("full")),
            self.policy(json!("full")),
        )
    }
    fn read(&self, path: &str) -> ActionRequest {
        ActionRequest::Read { path: path.into() }
    }
    fn write(&self, path: &str) -> ActionRequest {
        ActionRequest::Write { path: path.into() }
    }
}
fn effect(p: &NormalizedPolicy, request: ActionRequest) -> Effect {
    evaluate_requested(p, &request).unwrap()
}
fn observed(p: &EffectivePolicy) -> EnforcementObservation {
    EnforcementObservation {
        policy_digest: p.fingerprint(),
        qualification_id: "synthetic-unit-fixture-not-platform-proof".into(),
        platform: "test".into(),
        harness_version: "test".into(),
        guarantees: ACTIONS
            .into_iter()
            .flat_map(|action| {
                [Effect::Deny, Effect::Ask].map(move |effect| ObservedGuarantee {
                    action,
                    effect,
                    mechanism: EnforcementMechanism::Sandbox,
                    evidence: "synthetic-unit-observation".into(),
                })
            })
            .collect(),
        shell_matching: ShellMatching::CommandText,
        shell_absent_evidence: None,
        mcp_absent_evidence: None,
        outside_read_evidence: Some("test-outside".into()),
        path_race_evidence: Some("test-path-race".into()),
        descendant_ceiling_evidence: Some("test-child".into()),
        plan_lock_evidence: Some("test-plan".into()),
        completion_check_evidence: Some("test-check".into()),
        person_reviewer_evidence: Some("test-person".into()),
        model_reviewer_evidence: Some("test-model".into()),
        model_fallback_to_person: false,
    }
}

#[test]
fn presets_and_no_preset_cover_six_actions_and_outside() {
    let f = Fixture::new();
    let requests = [
        f.read("file"),
        f.write("file"),
        ActionRequest::Shell {
            command: "true".into(),
        },
        ActionRequest::Network {
            host: "example.test".into(),
        },
        ActionRequest::Mcp {
            server: "docs".into(),
            tool: Some("read".into()),
        },
        ActionRequest::Delegate {},
    ];
    for (value, expected) in [
        (
            json!("read-only"),
            [
                Effect::Allow,
                Effect::Deny,
                Effect::Deny,
                Effect::Deny,
                Effect::Deny,
                Effect::Deny,
            ],
        ),
        (
            json!("workspace"),
            [
                Effect::Allow,
                Effect::Allow,
                Effect::Allow,
                Effect::Deny,
                Effect::Allow,
                Effect::Allow,
            ],
        ),
        (json!("full"), [Effect::Allow; 6]),
        (json!({}), [Effect::Deny; 6]),
    ] {
        let p = f.policy(value);
        for (request, expected) in requests.iter().zip(expected) {
            assert_eq!(evaluate_requested(&p, request).unwrap(), expected);
        }
    }
    assert_eq!(
        effect(
            &f.policy(json!("workspace")),
            f.read("../workspace-sibling/file")
        ),
        Effect::Deny
    );
    assert_eq!(
        effect(&f.policy(json!("full")), f.write("../file")),
        Effect::Allow
    );
    assert_eq!(
        effect(
            &f.policy(json!({"preset":"full","outside":"deny"})),
            f.read("../file")
        ),
        Effect::Deny
    );
    assert_eq!(
        effect(
            &f.policy(json!({"outside":"read","directories":{}})),
            f.read("../file")
        ),
        Effect::Deny
    );
}
#[test]
fn rules_override_zone_and_presets_but_never_each_others_denials() {
    let f = Fixture::new();
    let p = f.policy(json!({"preset":"workspace","rules":[
        {"action":"read","match":"**/.env*","effect":"deny"},
        {"action":"read","match":"**","effect":"allow"},
        {"action":"write","match":"*.txt","effect":"ask"},
        {"action":"network","match":"*.test","effect":"allow"},
        {"action":"delegate","effect":"ask"}
    ]}));
    assert_eq!(effect(&p, f.read("sub/.env.local")), Effect::Deny);
    assert_eq!(effect(&p, f.write("file.txt")), Effect::Ask);
    assert_eq!(effect(&p, f.write("sub/file.txt")), Effect::Allow);
    assert_eq!(
        effect(
            &p,
            ActionRequest::Network {
                host: "API.EXAMPLE.TEST.".into()
            }
        ),
        Effect::Allow
    );
    assert_eq!(effect(&p, ActionRequest::Delegate {}), Effect::Ask);
    let p = f.policy(json!({"rules":[{"action":"read","match":"../other/**","effect":"allow"}]}));
    assert_eq!(effect(&p, f.read("../other/file")), Effect::Allow);
    assert_eq!(effect(&p, f.read("file")), Effect::Deny);
}
#[test]
fn home_nested_roots_and_read_only_directory() {
    let f = Fixture::new();
    fs::create_dir(f.context.workspace.join("docs")).unwrap();
    fs::create_dir(f.context.workspace.join("docs/cache")).unwrap();
    let p = f.policy(json!({"preset":"workspace","directories":{"docs":"read","docs/cache":"write","~/":"read"}}));
    assert_eq!(effect(&p, f.write("docs/cache/new")), Effect::Deny);
    assert_eq!(effect(&p, f.read("~/notes")), Effect::Allow);
    assert_eq!(effect(&p, f.write("~/notes")), Effect::Deny);
    let requested =
        serde_json::from_value(json!({"preset":"read-only","directories":{"docs":"write"}}))
            .unwrap();
    assert!(normalize_requested(requested, f.context.clone()).is_err());
    assert!(normalize_requested(
        RequestedPermissions::Preset(Preset::Full),
        PathContext {
            workspace: "relative".into(),
            home: f.context.home.clone()
        }
    )
    .is_err());
}
#[test]
fn shell_final_star_and_mcp_identity_have_no_prefix_collisions() {
    let f = Fixture::new();
    let p = f.policy(json!({"preset":"full","rules":[
        {"action":"shell","match":"git push *","effect":"ask"},
        {"action":"mcp","match":"docs","effect":"deny"},
        {"action":"mcp","match":"other/read","effect":"ask"}
    ]}));
    for command in ["git push", "git push origin main"] {
        assert_eq!(
            effect(
                &p,
                ActionRequest::Shell {
                    command: command.into()
                }
            ),
            Effect::Ask
        );
    }
    assert_eq!(
        effect(
            &p,
            ActionRequest::Shell {
                command: "git pushx".into()
            }
        ),
        Effect::Allow
    );
    assert_eq!(
        effect(
            &p,
            ActionRequest::Mcp {
                server: "docs".into(),
                tool: Some("read".into())
            }
        ),
        Effect::Deny
    );
    assert_eq!(
        effect(
            &p,
            ActionRequest::Mcp {
                server: "docs2".into(),
                tool: Some("read".into())
            }
        ),
        Effect::Allow
    );
    assert_eq!(
        effect(
            &p,
            ActionRequest::Mcp {
                server: "other".into(),
                tool: Some("read".into())
            }
        ),
        Effect::Ask
    );
    assert!(evaluate_requested(
        &p,
        &ActionRequest::Mcp {
            server: "other/read".into(),
            tool: None
        }
    )
    .is_err());
}
#[cfg(unix)]
#[test]
fn symlinks_parent_traversal_denied_targets_and_replacement() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f._temp.path().join("private");
    fs::create_dir(&outside).unwrap();
    fs::create_dir(outside.join("nested")).unwrap();
    symlink(&outside, f.context.workspace.join("alias")).unwrap();
    symlink(&f.context.workspace, f.context.workspace.join("inside")).unwrap();
    let p = f.policy(json!("workspace"));
    assert_eq!(effect(&p, f.read("alias/secret")), Effect::Deny);
    assert_eq!(effect(&p, f.write("alias/nested/../new")), Effect::Deny);
    assert_eq!(effect(&p, f.read("alias/../secret")), Effect::Deny);
    assert_eq!(effect(&p, f.write("inside/new")), Effect::Allow);
    let p = f.policy(json!({"preset":"full","rules":[{"action":"read","match":"../private/**","effect":"deny"}]}));
    assert_eq!(effect(&p, f.read("alias/secret")), Effect::Deny);
    let p = f.policy(json!({"rules":[{"action":"read","match":"inside/**","effect":"allow"}]}));
    assert_eq!(effect(&p, f.read("inside/file")), Effect::Allow);
    fs::remove_file(f.context.workspace.join("inside")).unwrap();
    symlink(&outside, f.context.workspace.join("inside")).unwrap();
    assert_eq!(effect(&p, f.read("inside/file")), Effect::Deny);
    symlink(outside.join("missing"), f.context.workspace.join("broken")).unwrap();
    assert!(evaluate_requested(&p, &f.read("broken/file")).is_err());
}
#[test]
fn effective_intersection_capture_current_child_reviewer_plan_and_check() {
    let f = Fixture::new();
    let p = EffectivePolicy::new(
        f.policy(json!({"preset":"full","reviewer":"person"})),
        f.policy(json!("full")),
        f.policy(json!({"preset":"workspace","rules":[{"action":"shell","effect":"ask"}]})),
    );
    let current = p.with_current(f.policy(json!("full")));
    assert_ne!(p.fingerprint(), current.fingerprint());
    let shell = ActionRequest::Shell {
        command: "true".into(),
    };
    let decision = evaluate_effective(&current, &shell, ExecutionPurpose::Agent).unwrap();
    assert_eq!(decision.effect, Effect::Ask);
    assert_eq!(decision.reviewer, Some(Reviewer::Person));
    assert_eq!(
        evaluate_effective(
            &current,
            &ActionRequest::Network {
                host: "example.test".into()
            },
            ExecutionPurpose::Agent
        )
        .unwrap()
        .effect,
        Effect::Deny
    );
    let child = derive_child_capture(&current, f.policy(json!("full"))).unwrap();
    assert_eq!(
        evaluate_effective(&child, &shell, ExecutionPurpose::CompletionCheck)
            .unwrap()
            .effect,
        Effect::Ask
    );
    assert_eq!(
        evaluate_effective(&child, &shell, ExecutionPurpose::PlanLocked)
            .unwrap()
            .effect,
        Effect::Deny
    );
    assert_eq!(
        evaluate_effective(&child, &f.read("file"), ExecutionPurpose::PlanLocked)
            .unwrap()
            .effect,
        Effect::Allow
    );
    let narrower = child.with_current(f.policy(json!("read-only")));
    assert_eq!(
        evaluate_effective(&narrower, &f.write("file"), ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Deny
    );
}
#[test]
fn enforcement_requires_runtime_evidence_and_rejects_shell_bypass_and_stale_qualification() {
    let f = Fixture::new();
    let p = f.effective(json!("workspace"));
    let mut o = observed(&p);
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_ok());
    for g in &mut o.guarantees {
        if g.action == Action::Read {
            g.mechanism = EnforcementMechanism::Harness;
        }
    }
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    o.shell_absent_evidence = Some("observed-all-shell-absent".into());
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_ok());
    o.path_race_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    let mut o = observed(&p);
    o.policy_digest = "stale".into();
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    let mut o = observed(&p);
    o.completion_check_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::CompletionCheck).is_err());
    let mut o = observed(&p);
    o.plan_lock_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::PlanLocked).is_err());
}
#[test]
fn reviewers_and_shell_prefix_require_the_observed_guarantee() {
    let f = Fixture::new();
    let p = f.effective(json!({"preset":"full","reviewer":"person","rules":[{"action":"shell","match":"git push * --force","effect":"ask"}]}));
    let mut o = observed(&p);
    o.person_reviewer_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    o.person_reviewer_evidence = Some("person".into());
    for g in &mut o.guarantees {
        if g.action == Action::Shell {
            g.mechanism = EnforcementMechanism::Harness;
        }
    }
    o.shell_matching = ShellMatching::Prefix;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    let p = f.effective(
        json!({"preset":"full","reviewer":"model","rules":[{"action":"delegate","effect":"ask"}]}),
    );
    let mut o = observed(&p);
    o.model_reviewer_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    o.model_fallback_to_person = true;
    assert_eq!(
        check_enforcement(&p, &o, ExecutionPurpose::Agent)
            .unwrap()
            .reviewer,
        Reviewer::Person
    );
}
#[test]
fn serde_rejects_unknown_fields_and_illegal_delegate_match() {
    assert!(
        serde_json::from_value::<RequestedPermissions>(json!({"preset":"full","grant":true}))
            .is_err()
    );
    assert!(serde_json::from_value::<ActionRequest>(
        json!({"action":"delegate","permissions":"full"})
    )
    .is_err());
    let f = Fixture::new();
    let requested = serde_json::from_value(
        json!({"rules":[{"action":"delegate","match":"*","effect":"allow"}]}),
    )
    .unwrap();
    assert!(normalize_requested(requested, f.context.clone()).is_err());
}

#[test]
fn host_ceiling_and_child_default_denial_cannot_be_replaced_by_an_allow() {
    let f = Fixture::new();
    let captured = EffectivePolicy::new(f.policy(json!("full")), f.policy(json!({"preset":"workspace","rules":[{"action":"write","match":"secret","effect":"deny"}]})), f.policy(json!("full")));
    let child = derive_child_capture(
        &captured,
        f.policy(
            json!({"preset":"full","rules":[{"action":"write","match":"secret","effect":"allow"}]}),
        ),
    )
    .unwrap();
    assert_eq!(
        evaluate_effective(&child, &f.write("secret"), ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Deny
    );
    assert_eq!(
        evaluate_effective(
            &child,
            &ActionRequest::Network {
                host: "example.test".into()
            },
            ExecutionPurpose::Agent
        )
        .unwrap()
        .effect,
        Effect::Deny
    );
    let child = derive_child_capture(
        &captured,
        f.policy(json!({"rules":[{"action":"read","match":"public","effect":"allow"}]})),
    )
    .unwrap();
    assert_eq!(
        evaluate_effective(&child, &f.read("public"), ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Allow
    );
    assert_eq!(
        evaluate_effective(&child, &f.read("other"), ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Deny
    );
    assert_eq!(
        evaluate_effective(&child, &ActionRequest::Delegate {}, ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Deny
    );
}
#[test]
fn hostnames_are_canonical_but_urls_ports_and_aliases_are_not_hosts() {
    let f = Fixture::new();
    let p = f.policy(json!({"preset":"full","rules":[{"action":"network","match":"API.EXAMPLE.TEST.","effect":"deny"}]}));
    assert_eq!(
        effect(
            &p,
            ActionRequest::Network {
                host: "api.example.test.".into()
            }
        ),
        Effect::Deny
    );
    assert_eq!(
        effect(&p, ActionRequest::Network { host: "::1".into() }),
        Effect::Allow
    );
    for host in [
        "https://example.test",
        "example.test:443",
        "user@example.test",
        "example.test..",
        "a\nb.test",
        "*.example.test",
    ] {
        assert!(
            evaluate_requested(&p, &ActionRequest::Network { host: host.into() }).is_err(),
            "{host}"
        );
    }
}
#[test]
fn qualification_rejects_missing_effects_outside_and_descendant_evidence() {
    let f = Fixture::new();
    let p = f.effective(json!("workspace"));
    let mut o = observed(&p);
    o.guarantees.retain(|g| g.action != Action::Network);
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    let mut o = observed(&p);
    o.outside_read_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    let mut o = observed(&p);
    o.descendant_ceiling_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    let mut o = observed(&p);
    for g in &mut o.guarantees {
        if g.effect == Effect::Ask {
            g.mechanism = EnforcementMechanism::Unavailable;
        }
    }
    let asks = f.effective(json!({"preset":"full","rules":[{"action":"delegate","effect":"ask"}]}));
    o.policy_digest = asks.fingerprint();
    assert!(check_enforcement(&asks, &o, ExecutionPurpose::Agent).is_err());
}

#[cfg(unix)]
#[test]
fn durable_restore_preserves_canonical_capture_and_detects_tampering() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let old = f._temp.path().join("old");
    let new = f._temp.path().join("new");
    fs::create_dir(&old).unwrap();
    fs::create_dir(&new).unwrap();
    symlink(&old, f.context.workspace.join("shared")).unwrap();
    let p = f.effective(json!({"preset":"workspace","directories":{"shared":"read"}}));
    let bytes = serde_json::to_string(&p).unwrap();
    let digest = p.fingerprint();
    fs::remove_file(f.context.workspace.join("shared")).unwrap();
    symlink(&new, f.context.workspace.join("shared")).unwrap();
    let restored = EffectivePolicy::restore_capture(&bytes, &digest).unwrap();
    assert_eq!(restored.fingerprint(), digest);
    let request = f.read("shared/file");
    assert_eq!(
        evaluate_effective(&restored, &request, ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Deny
    );
    assert!(
        EffectivePolicy::restore_capture(&bytes.replace("workspace", "other"), &digest).is_err()
    );
    assert!(EffectivePolicy::restore_capture("{}", &digest).is_err());
}

#[test]
fn ip_rules_match_equivalent_ipv6_spellings_in_both_directions() {
    let f = Fixture::new();
    for (rule, target) in [
        ("::1", "0:0:0:0:0:0:0:1"),
        ("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"),
    ] {
        let p = f.policy(
            json!({"preset":"full", "rules":[{"action":"network","match":rule,"effect":"deny"}]}),
        );
        assert_eq!(
            effect(
                &p,
                ActionRequest::Network {
                    host: target.into()
                }
            ),
            Effect::Deny
        );
    }
    let p = f.policy(json!({"preset":"full", "rules":[{"action":"network","match":"2001:db8:*","effect":"ask"}]}));
    assert_eq!(
        effect(
            &p,
            ActionRequest::Network {
                host: "2001:0db8:0:0:0:0:0:1".into()
            }
        ),
        Effect::Ask
    );
    assert_eq!(
        effect(
            &p,
            ActionRequest::Network {
                host: "2001:db9::1".into()
            }
        ),
        Effect::Allow
    );
}

#[test]
fn outside_evidence_only_applies_to_a_preset_without_a_universal_read_rule() {
    let f = Fixture::new();
    for requested in [
        json!({"rules":[{"action":"read","effect":"allow"}]}),
        json!({"preset":"workspace","rules":[{"action":"read","effect":"allow"}]}),
    ] {
        let p = f.effective(requested);
        let mut o = observed(&p);
        o.outside_read_evidence = None;
        assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_ok());
    }
    let p = f.effective(json!("workspace"));
    let mut o = observed(&p);
    o.outside_read_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
}

#[test]
fn absent_mcp_needs_evidence_and_a_universal_deny_shadows_ask() {
    let f = Fixture::new();
    let p = f.effective(json!({"preset":"read-only","rules":[{"action":"mcp","effect":"ask"}]}));
    let mut o = observed(&p);
    o.guarantees.retain(|g| g.action != Action::Mcp);
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
    o.mcp_absent_evidence = Some("observed-no-mcp-servers-or-resources".into());
    o.person_reviewer_evidence = None;
    let plan = check_enforcement(&p, &o, ExecutionPurpose::Agent).unwrap();
    assert!(plan
        .evidence
        .iter()
        .any(|e| e == "observed-no-mcp-servers-or-resources"));
    assert!(!plan.requirements.iter().any(|r| r.action == Action::Mcp));

    let p = f.effective(json!({"preset":"read-only","rules":[
        {"action":"mcp","effect":"ask"}, {"action":"mcp","effect":"deny"}
    ]}));
    let mut o = observed(&p);
    o.guarantees
        .retain(|g| !(g.action == Action::Mcp && g.effect == Effect::Ask));
    o.person_reviewer_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_ok());
    o.guarantees.retain(|g| g.action != Action::Mcp);
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
}

#[test]
fn plan_lock_closes_shell_bypass_only_when_plan_lock_evidence_exists() {
    let f = Fixture::new();
    let p = f.effective(json!("full"));
    let mut o = observed(&p);
    for g in &mut o.guarantees {
        g.mechanism = EnforcementMechanism::Harness;
    }
    assert!(check_enforcement(&p, &o, ExecutionPurpose::PlanLocked).is_ok());
    o.plan_lock_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::PlanLocked).is_err());
    // Unlocking requires a fresh qualification; the shell can bypass harness rules again.
    let p = f.effective(json!("workspace"));
    let mut o = observed(&p);
    for g in &mut o.guarantees {
        g.mechanism = EnforcementMechanism::Harness;
    }
    assert!(check_enforcement(&p, &o, ExecutionPurpose::PlanLocked).is_ok());
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_err());
}

#[test]
fn captured_default_deny_shadows_ask_from_another_ceiling() {
    let f = Fixture::new();
    let requested = f.policy(json!({"preset":"full", "rules":[{"action":"mcp","effect":"ask"}]}));
    let host = f.policy(json!("read-only"));
    let current = f.policy(json!("full"));
    let p = EffectivePolicy::new(requested, host, current);
    let request = ActionRequest::Mcp {
        server: "docs".into(),
        tool: None,
    };
    assert_eq!(
        evaluate_effective(&p, &request, ExecutionPurpose::Agent)
            .unwrap()
            .effect,
        Effect::Deny
    );
    let mut o = observed(&p);
    o.guarantees
        .retain(|g| !(g.action == Action::Mcp && g.effect == Effect::Ask));
    o.person_reviewer_evidence = None;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_ok());
}

#[test]
fn shell_prefix_matcher_can_enforce_a_universal_default_deny() {
    let f = Fixture::new();
    let p = f.effective(
        json!({"preset":"read-only", "rules":[{"action":"shell","match":"rm*","effect":"deny"}]}),
    );
    let mut o = observed(&p);
    for g in &mut o.guarantees {
        if g.action == Action::Shell {
            g.mechanism = EnforcementMechanism::Harness;
        }
    }
    o.shell_matching = ShellMatching::Prefix;
    assert!(check_enforcement(&p, &o, ExecutionPurpose::Agent).is_ok());
}
