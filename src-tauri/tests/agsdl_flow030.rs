// Portable production-module target; no application registry or Tauri runtime required.
#[path = "../src/db/agsdl_execution/v030/flow.rs"]
mod flow;
use flow::*;
use serde_json::{json, Value};

fn plan() -> FlowPlan030 {
    serde_json::from_value(json!({"format":"macro-agsdl-compiled-plan/2","versions":{"snapshot":"2","contract":"agsdl-0.3.0","compiler":"test","runtime":"test","registry":"test","profile":"macro-agsdl-030-v1"},"source":{},"documentJson":"{}","agents":[],"entry":["start"],"scopes":[],"steps":[],"routes":[],"joins":[],"handlers":[],"graphlessSubmissionContracts":{}})).unwrap()
}
fn address(s: &str) -> Vec<String> {
    s.split('/').map(str::to_string).collect()
}
fn step(p: &mut FlowPlan030, name: &str, kind: &str) {
    p.steps.push(Step030 {
        address: address(name),
        scope: address(name)
            .into_iter()
            .take(name.split('/').count() - 1)
            .collect(),
        r#type: kind.into(),
        declaration_json: "{}".into(),
        agent: if kind == "agent" {
            Some(name.into())
        } else {
            None
        },
        instance: if kind == "agent" {
            Some(Instance030::New)
        } else {
            None
        },
        delivery: None,
        max_visits_json: None,
        timeout_ms_json: None,
        submission_contract_json: None,
    });
    route(p, name, None, &[]);
}
fn target(name: &str) -> Target030 {
    Target030::Step {
        address: address(name),
        message_json: None,
        each_path_json: None,
        concurrency_json: None,
        max_json: None,
    }
}
fn route(p: &mut FlowPlan030, source: &str, key: Option<&str>, targets: &[&str]) {
    p.routes.retain(|r| {
        r.source != address(source) || r.kind != "normal" || r.key != key.map(str::to_string)
    });
    p.routes.push(Route030 {
        source: address(source),
        kind: "normal".into(),
        key: key.map(str::to_string),
        declaration_json: "[]".into(),
        targets: targets.iter().map(|s| target(s)).collect(),
        inherited: false,
    });
}
fn state() -> FlowState030 {
    FlowState030::new(FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "run".into(),
        snapshot_id: "snapshot".into(),
        epoch: "1".into(),
    })
}
struct Test {
    p: FlowPlan030,
    s: FlowState030,
    n: usize,
    effects: Vec<FlowEffect030>,
}
impl Test {
    fn new(p: FlowPlan030) -> Self {
        Self {
            p,
            s: state(),
            n: 0,
            effects: vec![],
        }
    }
    fn send(&mut self, kind: FlowEventKind030) -> FlowTransition030 {
        self.n += 1;
        let t = reduce(
            &self.p,
            &self.s,
            &FlowEvent030 {
                identity: self.s.identity.clone(),
                event_id: self.n.to_string(),
                expected_revision: self.s.revision.clone(),
                kind,
            },
        )
        .unwrap();
        self.s = t.state.clone();
        self.effects.extend(t.effects.clone());
        t
    }
    fn enter(&mut self) {
        self.send(FlowEventKind030::Enter {
            message_json: "{}".into(),
        });
    }
    fn work(&self, name: &str) -> WorkRef030 {
        let a = self
            .s
            .activations
            .iter()
            .find(|a| a.step == Some(address(name)) && a.phase == "running")
            .unwrap_or_else(|| panic!("missing running {name}: {:?}", self.s.activations));
        WorkRef030 {
            activation_id: a.id.clone(),
            start_effect_id: a.start_effect_id.clone().unwrap(),
            agent_instance_id: a.instance_id.clone(),
        }
    }
    fn finish(&mut self, name: &str, output: Value, key: Option<&str>) {
        let work = self.work(name);
        self.send(FlowEventKind030::WorkResult {
            work,
            result: WorkResult030::Completed {
                output_json: output.to_string(),
                route_key: key.map(str::to_string),
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: format!("proof{}", self.n),
                descendants_joined: true,
            }),
        });
    }
    fn fail(&mut self, name: &str) {
        let work = self.work(name);
        self.send(FlowEventKind030::WorkResult {
            work,
            result: WorkResult030::Failed {
                error: Failure030::new("AGENT_FAILED"),
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: format!("proof{}", self.n),
                descendants_joined: true,
            }),
        });
    }
    fn prepare(&mut self, items: Option<Vec<Value>>) {
        self.send(self.preparation(items));
    }
    fn preparation(&self, items: Option<Vec<Value>>) -> FlowEventKind030 {
        let native_receipt_id = format!("native-prepare-{}", self.n + 1);
        let p = self
            .s
            .preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap()
            .clone();
        let route = self
            .p
            .routes
            .iter()
            .find(|r| {
                r.source == p.reference.route.source
                    && r.kind == p.reference.route.kind
                    && r.key == p.reference.route.key
            })
            .unwrap();
        let batches = route
            .targets
            .iter()
            .enumerate()
            .map(|(n, t)| {
                let Target030::Step {
                    address,
                    each_path_json,
                    ..
                } = t
                else {
                    panic!()
                };
                let is_work = !matches!(
                    self.p
                        .steps
                        .iter()
                        .find(|s| &s.address == address)
                        .unwrap()
                        .r#type
                        .as_str(),
                    "call" | "join"
                );
                let values = if each_path_json.is_some() {
                    items.clone().unwrap()
                } else {
                    vec![Value::Null]
                };
                PreparedBatch030 {
                    target_ordinal: n,
                    target: t.clone(),
                    items: values
                        .into_iter()
                        .enumerate()
                        .map(|(index, v)| PreparedItem030 {
                            message_json: is_work.then(|| "{}".into()),
                            item_json: each_path_json.as_ref().map(|_| v.to_string()),
                            occurrence: DeliveryOccurrence030 {
                                native_receipt_id: native_receipt_id.clone(),
                                target_ordinal: n,
                                item_index: index.to_string(),
                            },
                        })
                        .collect(),
                }
            })
            .collect();
        FlowEventKind030::Prepared {
            reference: p.reference,
            native_receipt_id,
            result: PreparedResult030::Ready { batches },
        }
    }
    fn running(&self, name: &str) -> usize {
        self.s
            .activations
            .iter()
            .filter(|a| a.step == Some(address(name)) && a.phase == "running")
            .count()
    }
    fn physical_stops(&mut self) {
        let pending = self
            .s
            .activations
            .iter()
            .filter(|a| a.physical && a.stop_effect_id.is_some())
            .cloned()
            .collect::<Vec<_>>();
        for a in pending {
            self.send(FlowEventKind030::PhysicalEnded {
                work: WorkRef030 {
                    activation_id: a.id,
                    start_effect_id: a.start_effect_id.unwrap(),
                    agent_instance_id: a.instance_id,
                },
                stop_effect_id: a.stop_effect_id,
                evidence: PhysicalEvidence030 {
                    native_receipt_id: "joined".into(),
                    descendants_joined: true,
                },
            });
        }
    }
}
#[test]
fn sequence_and_replay() {
    let mut p = plan();
    step(&mut p, "start", "agent");
    step(&mut p, "end", "call");
    route(&mut p, "start", None, &["end"]);
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({"text":"ok"}), None);
    t.prepare(None);
    assert_eq!(t.running("end"), 1);
    t.finish("end", json!({"outcome":"passed"}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
    assert_eq!(t.s.visits_at(&address("end")), "1");
    let roundtrip: FlowState030 =
        serde_json::from_str(&serde_json::to_string(&t.s).unwrap()).unwrap();
    assert_eq!(roundtrip, t.s);
}

#[test]
fn actual_compiler_ir_can_drive_native_reducer() {
    // Synthetic document compiled by compiler030 at the pinned integration SHA;
    // no provider or native runtime is exercised by this test.
    let plan: FlowPlan030 =
        serde_json::from_str(include_str!("fixtures/agsdl030_compiled_plan.json")).unwrap();
    let mut t = Test::new(plan);
    t.enter();
    t.finish(
        "fork",
        json!({"outcome":"passed","data":{"exitCode":0,"output":""}}),
        Some("passed"),
    );
    t.prepare(None);
    assert_eq!(t.running("left"), 1);
    assert_eq!(t.running("right"), 1);
    t.finish("left", json!({"text":"left","results":{}}), None);
    t.finish("right", json!({"text":"right","results":{}}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}

#[test]
fn actual_compiler_ir_keeps_shared_fanout_needed_by_open_join() {
    for compiled in [
        include_str!("fixtures/agsdl030_shared_compiled_plan.json"),
        include_str!("fixtures/agsdl030_shared_wait_compiled_plan.json"),
    ] {
        let plan: FlowPlan030 = serde_json::from_str(compiled).unwrap();
        let mut t = Test::new(plan);
        t.enter();
        t.finish(
            "o",
            json!({"text":"","choice":"approve","results":{"items":["x","y","z"]}}),
            Some("approve"),
        );
        t.prepare(Some(vec![json!("x"), json!("y"), json!("z")]));
        let first = t.s.groups.iter().find(|g| g.join == address("j1")).unwrap();
        assert_eq!(first.decision.as_deref(), Some("reached"));
        assert!(
            first.released,
            "a wait join has no already-running work here"
        );
        let first_output = first.output_json.clone();
        assert_eq!(t.running("a"), 1);
        t.finish(
            "a",
            json!({"text":"","results":{},"choice":"two"}),
            Some("two"),
        );
        assert_eq!(t.running("a"), 1);
        t.finish(
            "a",
            json!({"text":"","results":{},"choice":"two"}),
            Some("two"),
        );
        assert_eq!(
            t.s.groups
                .iter()
                .find(|g| g.join == address("j2"))
                .unwrap()
                .decision
                .as_deref(),
            Some("reached")
        );
        assert_eq!(
            t.s.groups
                .iter()
                .find(|g| g.join == address("j1"))
                .unwrap()
                .output_json,
            first_output
        );
        assert_eq!(t.s.visits_at(&address("a")), "2");
        assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
    }
}

fn joined(mode: &str, remaining: &str) -> FlowPlan030 {
    let mut p = plan();
    for n in ["start", "a", "b", "after", "handler"] {
        step(&mut p, n, "agent");
    }
    step(&mut p, "join", "join");
    route(&mut p, "start", None, &["a", "b"]);
    route(&mut p, "a", None, &["join"]);
    route(&mut p, "b", None, &["join"]);
    route(&mut p, "join", None, &["after"]);
    p.joins.push(Join030 {
        address: address("join"),
        scope: vec![],
        origin: address("start"),
        branches: ["a", "b"]
            .iter()
            .map(|n| Branch030 {
                name: n.to_string(),
                target: address(n),
                members: vec![address(n)],
                fanout: false,
            })
            .collect(),
        mode: mode.into(),
        failures: "fail".into(),
        max_failures_json: None,
        quorum_count_json: (mode == "quorum").then(|| "1".into()),
        accept: vec!["yes".into()],
        remaining: remaining.into(),
    });
    p
}
fn error_route(p: &mut FlowPlan030, source: &str, target_name: &str, inherited: bool) {
    p.routes.push(Route030 {
        source: address(source),
        kind: "error".into(),
        key: None,
        declaration_json: "[]".into(),
        targets: vec![target(target_name)],
        inherited,
    });
}
fn launch(p: FlowPlan030) -> Test {
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({}), None);
    t.prepare(None);
    t
}
fn fanout(mode: &str, concurrency: Option<&str>) -> FlowPlan030 {
    let mut p = joined(mode, "stop");
    route(&mut p, "start", None, &["a"]);
    let r = p
        .routes
        .iter_mut()
        .find(|r| r.source == address("start"))
        .unwrap();
    r.targets[0] = Target030::Step {
        address: address("a"),
        message_json: None,
        each_path_json: Some("[\"items\"]".into()),
        concurrency_json: concurrency.map(str::to_string),
        max_json: None,
    };
    p.joins[0].branches[0].fanout = true;
    p
}
fn launch_fanout(p: FlowPlan030, items: Vec<Value>) -> Test {
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({"items":items}), None);
    t.prepare(Some(items));
    t
}
fn completed_group(t: &Test) -> Value {
    serde_json::from_str(t.s.groups.last().unwrap().output_json.as_ref().unwrap()).unwrap()
}
#[test]
fn idempotence_contradiction_revision_and_plan_binding() {
    let mut p = plan();
    step(&mut p, "start", "agent");
    let s = state();
    let mut e = FlowEvent030 {
        identity: s.identity.clone(),
        event_id: "entry".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let t = reduce(&p, &s, &e).unwrap();
    let replay = reduce(&p, &t.state, &e).unwrap();
    assert_eq!(replay.state, t.state);
    assert_eq!(replay.receipt, t.receipt);
    assert!(replay.effects.is_empty());
    let mut changed_plan = p.clone();
    changed_plan.document_json = "{\"different\":true}".into();
    assert_eq!(
        reduce(&changed_plan, &t.state, &e).unwrap_err(),
        FlowInputError030::Identity
    );
    e.kind = FlowEventKind030::Stop;
    assert_eq!(
        reduce(&p, &t.state, &e).unwrap_err(),
        FlowInputError030::Contradiction
    );
    e.event_id = "new".into();
    assert_eq!(
        reduce(&p, &t.state, &e).unwrap_err(),
        FlowInputError030::Revision
    );
    e.expected_revision = "1".into();
    let mut other = p.clone();
    other.document_json = "{\"changed\":true}".into();
    assert_eq!(
        reduce(&other, &t.state, &e).unwrap_err(),
        FlowInputError030::Identity
    );
}
#[test]
fn all_join_orders_branches_and_only_continues_once() {
    let mut t = launch(joined("all", "stop"));
    t.finish("b", json!({"text":"B"}), None);
    assert_eq!(t.s.groups[0].decision, None);
    t.finish("a", json!({"text":"A"}), None);
    assert_eq!(
        completed_group(&t),
        json!({"outcome":"done","branches":{"a":{"text":"A"},"b":{"text":"B"}}})
    );
    assert_eq!(t.s.visits_at(&address("join")), "1");
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}
#[test]
fn quorum_stop_requires_physical_evidence() {
    let mut t = launch(joined("quorum", "stop"));
    t.finish("a", json!({"choice":"yes"}), Some("yes"));
    assert_eq!(t.s.groups[0].decision.as_deref(), Some("reached"));
    assert!(!t.s.groups[0].released);
    assert_eq!(t.running("b"), 0);
    assert_eq!(t.running("after"), 0);
    assert!(t.s.preparations.iter().all(|p| p.status != "pending"));
    let stop = t
        .effects
        .iter()
        .find(|e| matches!(e.kind, FlowEffectKind030::StopWork { .. }))
        .unwrap();
    assert!(matches!(
        stop.kind,
        FlowEffectKind030::StopWork {
            include_descendants: true,
            ..
        }
    ));
    t.physical_stops();
    assert!(t.s.groups[0].released);
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
    assert_eq!(
        completed_group(&t)["branches"],
        json!({"a":{"choice":"yes"}})
    );
}
#[test]
fn quorum_wait_decides_now_continues_after_late_work() {
    let mut t = launch(joined("quorum", "wait"));
    t.finish("a", json!({"choice":"yes"}), Some("yes"));
    assert!(!t.s.groups[0].released);
    assert_eq!(t.running("b"), 1);
    t.fail("b");
    assert!(t.s.groups[0].released);
    assert!(!t.s.unhandled_failure);
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}
#[test]
fn finish_loop_has_no_contribution_but_keeps_run_alive() {
    let mut p = joined("quorum", "finish");
    p.routes.retain(|r| r.source != address("b"));
    route(&mut p, "b", Some("again"), &["b"]);
    route(&mut p, "b", Some("end"), &["join"]);
    let mut t = launch(p);
    t.finish("a", json!({"choice":"yes"}), Some("yes"));
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict, None);
    t.finish("b", json!({"choice":"again"}), Some("again"));
    t.prepare(None);
    assert_eq!(t.s.visits_at(&address("b")), "2");
    t.fail("b");
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
    assert_eq!(
        completed_group(&t)["branches"],
        json!({"a":{"choice":"yes"}})
    );
}
#[test]
fn quorum_impossible_at_open_consumes_join_visit_only() {
    let mut p = joined("quorum", "stop");
    p.joins[0].quorum_count_json = Some("2e0".into());
    route(&mut p, "start", None, &["a"]);
    let mut t = launch(p);
    assert_eq!(t.running("a"), 0);
    assert_eq!(t.s.visits_at(&address("a")), "0");
    assert_eq!(t.s.visits_at(&address("join")), "1");
    assert_eq!(
        completed_group(&t),
        json!({"outcome":"missed","branches":{}})
    );
    t.prepare(None);
    t.finish("after", json!({}), None);
}
#[test]
fn quorum_missed_and_failed_branch_is_handled() {
    let mut p = joined("quorum", "stop");
    p.joins[0].quorum_count_json = Some("2".into());
    let mut t = launch(p);
    t.fail("a");
    assert_eq!(t.s.groups[0].decision.as_deref(), Some("missed"));
    assert!(!t.s.unhandled_failure);
    t.physical_stops();
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}
#[test]
fn fanout_order_keep_and_empty() {
    let mut p = fanout("all", None);
    p.joins[0].failures = "keep".into();
    let mut t = launch_fanout(p, vec![json!("first"), json!("second")]);
    let a =
        t.s.activations
            .iter()
            .find(|a| a.item_json.as_deref() == Some("\"second\""))
            .unwrap()
            .clone();
    t.send(FlowEventKind030::WorkResult {
        work: WorkRef030 {
            activation_id: a.id,
            start_effect_id: a.start_effect_id.unwrap(),
            agent_instance_id: a.instance_id,
        },
        result: WorkResult030::Completed {
            output_json: "{\"text\":\"second\"}".into(),
            route_key: None,
        },
        physical: Some(PhysicalEvidence030 {
            native_receipt_id: "second-proof".into(),
            descendants_joined: true,
        }),
    });
    t.fail("a");
    let output = completed_group(&t);
    assert_eq!(output["outcome"], "incomplete");
    assert_eq!(output["branches"]["a"][0]["item"], "first");
    assert_eq!(output["branches"]["a"][0]["ended"], "failed");
    assert_eq!(output["branches"]["a"][1]["text"], "second");
    for mode in ["all", "quorum"] {
        let t = launch_fanout(fanout(mode, None), vec![]);
        assert_eq!(t.s.visits_at(&address("a")), "0");
        assert_eq!(completed_group(&t)["branches"]["a"], json!([]));
        assert_eq!(
            completed_group(&t)["outcome"],
            if mode == "all" { "done" } else { "missed" }
        );
    }
}
#[test]
fn concurrency_bounds_whole_paths_and_withdraws_unstarted_items() {
    let mut p = fanout("quorum", Some("1.0"));
    step(&mut p, "tail", "agent");
    route(&mut p, "a", None, &["tail"]);
    route(&mut p, "tail", None, &["join"]);
    p.joins[0].branches[0].members.push(address("tail"));
    let mut t = launch_fanout(p, vec![json!(1), json!(2), json!(3)]);
    assert_eq!(t.running("a"), 1);
    t.finish("a", json!({}), None);
    assert_eq!(t.s.visits_at(&address("a")), "1");
    t.prepare(None);
    assert_eq!(t.running("tail"), 1);
    assert_eq!(t.running("a"), 0);
    t.finish("tail", json!({"choice":"no"}), Some("no"));
    assert_eq!(t.running("a"), 1);
    t.finish("a", json!({}), None);
    t.prepare(None);
    t.finish("tail", json!({"choice":"yes"}), Some("yes"));
    assert_eq!(t.s.visits_at(&address("a")), "2");
    assert_eq!(
        t.s.paths.iter().filter(|p| p.phase == "withdrawn").count(),
        1
    );
    assert_eq!(
        completed_group(&t)["branches"]["a"],
        json!([{"item":2,"choice":"yes"}])
    );
}

#[test]
fn identical_fanout_items_keep_distinct_occurrences_after_waiting() {
    let mut t = launch_fanout(fanout("all", Some("1")), vec![json!("same"), json!("same")]);
    let starts = |effects: &[FlowEffect030]| -> Vec<DeliveryOccurrence030> {
        effects
            .iter()
            .filter_map(|effect| match &effect.kind {
                FlowEffectKind030::Start {
                    step: Some(step),
                    occurrence: Some(occurrence),
                    ..
                } if *step == address("a") => Some(occurrence.clone()),
                _ => None,
            })
            .collect()
    };
    let first = starts(&t.effects);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].item_index, "0");
    t.finish("a", json!({}), None);
    let all = starts(&t.effects);
    assert_eq!(all.len(), 2);
    assert_eq!(all[1].item_index, "1");
    assert_eq!(all[0].native_receipt_id, all[1].native_receipt_id);
    assert_eq!(all[0].target_ordinal, all[1].target_ordinal);
    assert_ne!(all[0], all[1]);
}

#[test]
fn delayed_occurrence_survives_state_serialization() {
    let mut t = launch_fanout(fanout("all", Some("1")), vec![json!("same"), json!("same")]);
    let saved = serde_json::to_string(&t.s).unwrap();
    t.s = serde_json::from_str(&saved).unwrap();
    t.finish("a", json!({}), None);
    let occurrence = t
        .effects
        .iter()
        .rev()
        .find_map(|effect| match &effect.kind {
            FlowEffectKind030::Start {
                step: Some(step),
                occurrence: Some(occurrence),
                ..
            } if *step == address("a") => Some(occurrence),
            _ => None,
        })
        .unwrap();
    assert_eq!(occurrence.item_index, "1");
    assert!(!occurrence.native_receipt_id.is_empty());
}

#[test]
fn empty_fanout_creates_no_occurrence_and_stop_withdraws_unstarted_items() {
    let empty = launch_fanout(fanout("all", Some("1")), vec![]);
    let batch = empty
        .s
        .batches
        .iter()
        .find(|b| b.target == address("a"))
        .unwrap();
    assert!(batch.items.is_empty());
    assert!(batch.path_ids.is_empty());
    assert!(!empty.effects.iter().any(|effect| matches!(&effect.kind,
        FlowEffectKind030::Start { step: Some(step), .. } if *step == address("a"))));

    let mut t = launch_fanout(fanout("all", Some("1")), vec![json!("same"), json!("same")]);
    let before = t.effects.len();
    t.send(FlowEventKind030::Stop);
    t.physical_stops();
    assert!(!t.effects[before..].iter().any(|effect| matches!(&effect.kind,
        FlowEffectKind030::Start { occurrence: Some(occurrence), .. } if occurrence.item_index == "1")));
}

#[test]
fn malformed_occurrence_is_rejected_before_any_admission() {
    let mut p = plan();
    step(&mut p, "start", "agent");
    step(&mut p, "next", "agent");
    route(&mut p, "start", None, &["next"]);
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({}), None);
    let prep =
        t.s.preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap()
            .clone();
    let target =
        t.p.routes
            .iter()
            .find(|r| r.source == address("start"))
            .unwrap()
            .targets[0]
            .clone();
    let invalid = FlowEvent030 {
        identity: t.s.identity.clone(),
        event_id: "invalid-occurrence".into(),
        expected_revision: t.s.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference: prep.reference,
            native_receipt_id: "receipt".into(),
            result: PreparedResult030::Ready {
                batches: vec![PreparedBatch030 {
                    target_ordinal: 0,
                    target,
                    items: vec![PreparedItem030 {
                        message_json: Some("{}".into()),
                        item_json: None,
                        occurrence: DeliveryOccurrence030 {
                            native_receipt_id: "receipt".into(),
                            target_ordinal: 0,
                            item_index: "00".into(),
                        },
                    }],
                }],
            },
        },
    };
    assert!(matches!(
        reduce(&t.p, &t.s, &invalid),
        Err(FlowInputError030::InvalidEvent(_))
    ));
    assert_eq!(t.s.visits_at(&address("next")), "0");
}

#[test]
fn repeated_occurrence_and_wrong_receipt_are_rejected() {
    let p = fanout("all", None);
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({"items":["same","same"]}), None);
    let prep =
        t.s.preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap()
            .clone();
    let target =
        t.p.routes
            .iter()
            .find(|r| r.source == address("start"))
            .unwrap()
            .targets[0]
            .clone();
    let item = PreparedItem030 {
        message_json: Some("{}".into()),
        item_json: Some("\"same\"".into()),
        occurrence: DeliveryOccurrence030 {
            native_receipt_id: "receipt".into(),
            target_ordinal: 0,
            item_index: "0".into(),
        },
    };
    for items in [
        vec![item.clone(), item.clone()],
        vec![PreparedItem030 {
            occurrence: DeliveryOccurrence030 {
                native_receipt_id: "other".into(),
                ..item.occurrence.clone()
            },
            ..item.clone()
        }],
    ] {
        let event = FlowEvent030 {
            identity: t.s.identity.clone(),
            event_id: "invalid".into(),
            expected_revision: t.s.revision.clone(),
            kind: FlowEventKind030::Prepared {
                reference: prep.reference.clone(),
                native_receipt_id: "receipt".into(),
                result: PreparedResult030::Ready {
                    batches: vec![PreparedBatch030 {
                        target_ordinal: 0,
                        target: target.clone(),
                        items,
                    }],
                },
            },
        };
        assert!(matches!(
            reduce(&t.p, &t.s, &event),
            Err(FlowInputError030::InvalidEvent(_))
        ));
    }
    assert_eq!(t.s.visits_at(&address("a")), "0");
}

#[test]
fn one_receipt_cannot_identify_two_different_preparations() {
    let mut p = plan();
    for name in ["start", "a", "b", "c", "d"] {
        step(&mut p, name, "agent");
    }
    route(&mut p, "start", None, &["a", "b"]);
    route(&mut p, "a", None, &["c"]);
    route(&mut p, "b", None, &["d"]);
    let mut t = launch(p);
    t.finish("a", json!({}), None);
    t.finish("b", json!({}), None);
    let first_id =
        t.s.preparations
            .iter()
            .find(|p| p.status == "pending" && p.reference.route.source == address("a"))
            .unwrap()
            .reference
            .prepare_id
            .clone();
    t.prepare(None);
    let used_receipt =
        t.s.preparation_receipts
            .iter()
            .find(|(_, id)| **id == first_id)
            .unwrap()
            .0
            .clone();
    let pending =
        t.s.preparations
            .iter()
            .find(|p| p.status == "pending" && p.reference.route.source == address("b"))
            .unwrap();
    let event = FlowEvent030 {
        identity: t.s.identity.clone(),
        event_id: "reused-receipt".into(),
        expected_revision: t.s.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference: pending.reference.clone(),
            native_receipt_id: used_receipt,
            result: PreparedResult030::Ready { batches: vec![] },
        },
    };
    assert_eq!(
        reduce(&t.p, &t.s, &event).unwrap_err(),
        FlowInputError030::Contradiction
    );
    assert_eq!(t.s.visits_at(&address("d")), "0");
}
#[test]
fn fanout_limit_blocks_fixed_target_and_fails_join_original_code() {
    let mut p = fanout("all", None);
    let r = p
        .routes
        .iter_mut()
        .find(|r| r.source == address("start"))
        .unwrap();
    if let Target030::Step { max_json, .. } = &mut r.targets[0] {
        *max_json = Some("1e0".into());
    }
    r.targets.push(target("b"));
    error_route(&mut p, "join", "handler", false);
    let mut t = launch_fanout(p, vec![json!(1), json!(2)]);
    assert_eq!(t.running("a"), 0);
    assert_eq!(t.running("b"), 0);
    assert_eq!(t.s.visits_at(&address("a")), "0");
    assert!(t.effects.iter().any(|e|matches!(&e.kind,FlowEffectKind030::Failure {step:Some(s),error,..} if s==&address("join") && error.code=="FANOUT_LIMIT")));
    t.prepare(None);
    t.finish("handler", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}
#[test]
fn prepared_operand_failure_without_join_fails_target_once() {
    let mut p = fanout("all", None);
    p.joins.clear();
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({"items":false}), None);
    let prep = t.s.preparations[0].reference.clone();
    t.send(FlowEventKind030::Prepared {
        reference: prep,
        native_receipt_id: "operand".into(),
        result: PreparedResult030::Failed {
            target_ordinal: 0,
            error: Failure030::new("OPERAND"),
        },
    });
    assert_eq!(t.s.verdict.as_deref(), Some("failed"));
    assert_eq!(t.s.visits_at(&address("a")), "0");
    assert_eq!(t.effects.iter().filter(|e|matches!(&e.kind,FlowEffectKind030::Failure {step:Some(s),..} if s==&address("a"))).count(),1);
}
#[test]
fn max_failures_fails_join_and_waits_for_stop() {
    let mut p = fanout("all", None);
    p.joins[0].failures = "keep".into();
    p.joins[0].max_failures_json = Some("0.1e1".into());
    error_route(&mut p, "join", "handler", false);
    let mut t = launch_fanout(p, vec![json!(1), json!(2), json!(3)]);
    t.fail("a");
    assert!(t.s.groups[0].decision.is_none());
    t.fail("a");
    assert_eq!(t.s.groups[0].decision.as_deref(), Some("failed"));
    assert!(!t.s.groups[0].released);
    t.physical_stops();
    t.prepare(None);
    t.finish("handler", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}
#[test]
fn branch_exit_wait_and_stop_close_group_without_join_result() {
    for remaining in ["stop", "wait", "finish"] {
        let mut p = joined("all", remaining);
        route(&mut p, "a", None, &["handler"]);
        let mut t = launch(p);
        t.finish("a", json!({"text":"real producer"}), None);
        assert_eq!(t.s.groups[0].decision.as_deref(), Some("closed"));
        assert_eq!(t.s.groups[0].output_json, None);
        if remaining == "stop" {
            t.physical_stops();
        } else if remaining == "wait" {
            assert!(!t.s.groups[0].released);
            t.finish("b", json!({}), None);
        }
        let prep =
            t.s.preparations
                .iter()
                .find(|p| p.status == "pending")
                .unwrap();
        assert_eq!(prep.producer.step, Some(address("a")));
        assert_eq!(prep.producer.output_json, "{\"text\":\"real producer\"}");
        t.prepare(None);
        t.finish("handler", json!({}), None);
        if remaining == "finish" {
            assert_eq!(t.s.verdict, None);
            t.finish("b", json!({}), None);
        }
        assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
        assert_eq!(t.s.visits_at(&address("after")), "0");
    }
}
#[test]
fn local_error_route_closes_branch_and_flow_handler_cannot_loop() {
    let mut p = joined("all", "stop");
    error_route(&mut p, "a", "handler", false);
    error_route(&mut p, "join", "after", true);
    let mut t = launch(p);
    t.fail("a");
    assert_eq!(t.s.groups[0].decision.as_deref(), Some("closed"));
    t.physical_stops();
    t.prepare(None);
    t.fail("handler");
    assert_eq!(t.s.verdict.as_deref(), Some("failed"));
    assert_eq!(t.s.visits_at(&address("after")), "0");
}
#[test]
fn stale_prepare_after_stop_or_group_close_cannot_admit() {
    for mode in ["stop", "finish", "wait"] {
        let mut p = joined("quorum", mode);
        step(&mut p, "tail", "agent");
        route(&mut p, "b", None, &["tail"]);
        route(&mut p, "tail", None, &["join"]);
        p.joins[0].branches[1].members.push(address("tail"));
        let mut t = launch(p);
        t.finish("b", json!({}), None);
        let reference =
            t.s.preparations
                .iter()
                .find(|p| p.status == "pending")
                .unwrap()
                .reference
                .clone();
        t.finish("a", json!({"choice":"yes"}), Some("yes"));
        let before = t.s.clone();
        let e = FlowEvent030 {
            identity: t.s.identity.clone(),
            event_id: "late".into(),
            expected_revision: t.s.revision.clone(),
            kind: FlowEventKind030::Prepared {
                reference,
                native_receipt_id: "late-proof".into(),
                result: PreparedResult030::Ready { batches: vec![] },
            },
        };
        assert_eq!(
            reduce(&t.p, &t.s, &e).unwrap_err(),
            FlowInputError030::StaleReference
        );
        assert_eq!(t.s, before);
    }
    let mut p = plan();
    step(&mut p, "start", "agent");
    step(&mut p, "a", "agent");
    route(&mut p, "start", None, &["a"]);
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({}), None);
    let reference = t.s.preparations[0].reference.clone();
    t.send(FlowEventKind030::Stop);
    let e = FlowEvent030 {
        identity: t.s.identity.clone(),
        event_id: "late".into(),
        expected_revision: t.s.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference,
            native_receipt_id: "late".into(),
            result: PreparedResult030::Ready { batches: vec![] },
        },
    };
    assert_eq!(
        reduce(&t.p, &t.s, &e).unwrap_err(),
        FlowInputError030::StaleReference
    );
}
fn shared(p: &mut FlowPlan030, name: &str, agent: &str, delivery: &str) {
    let s = p
        .steps
        .iter_mut()
        .find(|s| s.address == address(name))
        .unwrap();
    s.agent = Some(agent.into());
    s.instance = Some(Instance030::Shared);
    s.delivery = Some(delivery.into());
}
#[test]
fn shared_fifo_steer_bypasses_queue_and_does_not_visit() {
    let mut p = plan();
    for n in ["start", "work", "q1", "q2", "steer"] {
        step(&mut p, n, "agent");
    }
    route(&mut p, "start", None, &["work", "q1", "q2", "steer"]);
    for n in ["work", "q1", "q2"] {
        shared(&mut p, n, "dev", "queue");
    }
    shared(&mut p, "steer", "dev", "steer");
    let mut t = launch(p);
    assert_eq!(t.running("work"), 1);
    assert_eq!(t.s.visits_at(&address("steer")), "0");
    assert!(t
        .effects
        .iter()
        .any(|e| matches!(e.kind, FlowEffectKind030::Steer { .. })));
    let steer_occurrence = t
        .effects
        .iter()
        .find_map(|effect| match &effect.kind {
            FlowEffectKind030::Steer {
                occurrence: Some(value),
                ..
            } => Some(value),
            _ => None,
        })
        .unwrap();
    assert_eq!(steer_occurrence.target_ordinal, 3);
    assert_eq!(steer_occurrence.item_index, "0");
    assert_eq!(
        t.s.activations
            .iter()
            .filter(|a| a.phase == "queued")
            .count(),
        2
    );
    t.finish("work", json!({}), None);
    assert_eq!(t.running("q1"), 1);
    assert_eq!(t.running("q2"), 0);
    t.finish("q1", json!({}), None);
    assert_eq!(t.running("q2"), 1);
    t.finish("q2", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}
#[test]
fn graphless_queue_steer_and_named_instance() {
    let mut p = plan();
    p.entry = None;
    p.graphless_submission_contracts
        .insert("dev".into(), "{}".into());
    let mut t = Test::new(p);
    let deliver = |instance, delivery: &str, sender: &str| FlowEventKind030::Deliver {
        agent: "dev".into(),
        instance,
        delivery: delivery.into(),
        message_json: "{}".into(),
        sender: sender.into(),
    };
    t.send(deliver(Instance030::Shared, "queue", "first"));
    t.send(deliver(Instance030::Shared, "queue", "second"));
    t.send(deliver(Instance030::Shared, "steer", "third"));
    t.send(deliver(
        Instance030::Named {
            name: "other".into(),
        },
        "queue",
        "fourth",
    ));
    assert_eq!(t.s.instances.len(), 2);
    assert_eq!(
        t.s.activations
            .iter()
            .filter(|a| a.phase == "running")
            .count(),
        2
    );
    assert_eq!(
        t.s.activations
            .iter()
            .filter(|a| a.phase == "queued")
            .count(),
        1
    );
    assert!(t
        .effects
        .iter()
        .any(|e| matches!(e.kind, FlowEffectKind030::Steer { .. })));
    let a =
        t.s.activations
            .iter()
            .find(|a| a.sender.as_deref() == Some("first"))
            .unwrap()
            .clone();
    t.send(FlowEventKind030::WorkResult {
        work: WorkRef030 {
            activation_id: a.id,
            start_effect_id: a.start_effect_id.unwrap(),
            agent_instance_id: a.instance_id,
        },
        result: WorkResult030::Completed {
            output_json: "{}".into(),
            route_key: None,
        },
        physical: Some(PhysicalEvidence030 {
            native_receipt_id: "p".into(),
            descendants_joined: true,
        }),
    });
    assert_eq!(
        t.s.activations
            .iter()
            .find(|a| a.sender.as_deref() == Some("second"))
            .unwrap()
            .phase,
        "running"
    );
}
fn compose(p: &mut FlowPlan030, name: &str, entry: &str, outputs: &[&str]) {
    step(p, name, "compose");
    p.scopes.push(Scope030 {
        address: address(name),
        parent: Some(vec![]),
        composition: Some("fragment".into()),
        entry: address(entry),
        outputs: outputs.iter().map(|s| s.to_string()).collect(),
        agents: Default::default(),
    });
}
fn output_route(p: &mut FlowPlan030, source: &str, scope: &str, name: &str) {
    let r = p
        .routes
        .iter_mut()
        .find(|r| r.source == address(source) && r.kind == "normal")
        .unwrap();
    r.targets = vec![Target030::Output {
        scope: address(scope),
        name: name.into(),
    }];
}
#[test]
fn nested_compositions_count_visits_and_preserve_actual_producer() {
    let mut p = plan();
    step(&mut p, "start", "agent");
    compose(&mut p, "outer", "outer/inner", &["done"]);
    compose(&mut p, "outer/inner", "outer/inner/work", &["ok"]);
    step(&mut p, "outer/inner/work", "agent");
    step(&mut p, "after", "agent");
    route(&mut p, "start", None, &["outer"]);
    output_route(&mut p, "outer/inner/work", "outer/inner", "ok");
    output_route(&mut p, "outer/inner", "outer", "done");
    route(&mut p, "outer", Some("done"), &["after"]);
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({"text":"input"}), None);
    t.prepare(None);
    assert_eq!(t.s.visits_at(&address("outer")), "1");
    assert_eq!(t.s.visits_at(&address("outer/inner")), "1");
    let outer =
        t.s.activations
            .iter()
            .find(|a| a.step == Some(address("outer")))
            .unwrap();
    let inner_work =
        t.s.activations
            .iter()
            .find(|a| a.step == Some(address("outer/inner/work")))
            .unwrap();
    assert!(outer.occurrence.is_some());
    assert_eq!(inner_work.occurrence, outer.occurrence);
    t.finish("outer/inner/work", json!({"text":"actual"}), None);
    let prep =
        t.s.preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap();
    assert_eq!(prep.reference.route.source, address("outer"));
    assert_eq!(prep.producer.step, Some(address("outer/inner/work")));
    assert_eq!(prep.producer.output_json, "{\"text\":\"actual\"}");
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}
#[test]
fn composition_failure_propagates_to_nearest_parent_handler() {
    let mut p = plan();
    step(&mut p, "start", "agent");
    compose(&mut p, "outer", "outer/inner", &["done"]);
    compose(&mut p, "outer/inner", "outer/inner/work", &["ok"]);
    step(&mut p, "outer/inner/work", "agent");
    step(&mut p, "local", "agent");
    step(&mut p, "global", "agent");
    route(&mut p, "start", None, &["outer"]);
    error_route(&mut p, "outer/inner", "local", false);
    error_route(&mut p, "outer", "global", true);
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({}), None);
    t.prepare(None);
    t.fail("outer/inner/work");
    let pending =
        t.s.preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap();
    assert_eq!(pending.reference.route.source, address("outer/inner"));
    t.prepare(None);
    t.finish("local", json!({}), None);
    assert_eq!(t.s.visits_at(&address("global")), "0");
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}

#[test]
fn simultaneous_join_opening_failures_end_compose_only_once() {
    let mut p = plan();
    step(&mut p, "start", "agent");
    compose(&mut p, "outer", "outer/spread", &["ok"]);
    for name in ["outer/spread", "outer/a", "outer/b", "handler"] {
        step(&mut p, name, "agent");
    }
    for name in ["outer/j1", "outer/j2"] {
        step(&mut p, name, "join");
        output_route(&mut p, name, "outer", "ok");
    }
    route(&mut p, "start", None, &["outer"]);
    route(&mut p, "outer/spread", None, &["outer/a", "outer/b"]);
    for name in ["outer/a", "outer/b"] {
        route(&mut p, name, Some("one"), &["outer/j1"]);
        route(&mut p, name, Some("two"), &["outer/j2"]);
    }
    let spread = p
        .routes
        .iter_mut()
        .find(|r| r.source == address("outer/spread") && r.key.is_none())
        .unwrap();
    spread.targets[0] = Target030::Step {
        address: address("outer/a"),
        message_json: None,
        each_path_json: Some("[\"items\"]".into()),
        concurrency_json: None,
        max_json: Some("1".into()),
    };
    for name in ["outer/j1", "outer/j2"] {
        p.joins.push(Join030 {
            address: address(name),
            scope: address("outer"),
            origin: address("outer/spread"),
            branches: ["a", "b"]
                .iter()
                .map(|branch| Branch030 {
                    name: branch.to_string(),
                    target: address(&format!("outer/{branch}")),
                    members: vec![address(&format!("outer/{branch}"))],
                    fanout: *branch == "a",
                })
                .collect(),
            mode: "all".into(),
            failures: "fail".into(),
            max_failures_json: None,
            quorum_count_json: None,
            accept: vec![],
            remaining: "stop".into(),
        });
    }
    error_route(&mut p, "outer", "handler", false);
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({}), None);
    t.prepare(None);
    t.finish("outer/spread", json!({"items":[1,2]}), None);
    t.prepare(Some(vec![json!(1), json!(2)]));
    assert_eq!(t.effects.iter().filter(|effect| matches!(&effect.kind,
        FlowEffectKind030::Failure { step: Some(step), error, .. } if *step == address("outer") && error.code == "FANOUT_LIMIT")).count(), 1);
    assert_eq!(t.effects.iter().filter(|effect| matches!(&effect.kind,
        FlowEffectKind030::PrepareRoute { reference, .. } if reference.route.source == address("outer") && reference.route.kind == "error")).count(), 1);
    assert_eq!(t.s.visits_at(&address("outer/a")), "0");
    assert_eq!(t.s.visits_at(&address("outer/b")), "0");
}
#[test]
fn exact_visit_limits_and_large_counters_do_not_round() {
    let mut p = plan();
    step(&mut p, "start", "agent");
    p.steps[0].max_visits_json = Some("1.000e0".into());
    let mut s = state();
    s.visits.insert("[\"start\"]".into(), "1".into());
    let e = FlowEvent030 {
        identity: s.identity.clone(),
        event_id: "enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let t = reduce(&p, &s, &e).unwrap();
    assert_eq!(t.state.verdict.as_deref(), Some("failed"));
    assert_eq!(t.state.visits_at(&address("start")), "1");
    p.steps[0].max_visits_json = Some("9007199254740993e+100".into());
    s.visits.insert(
        "[\"start\"]".into(),
        "9007199254740993".to_string() + &"0".repeat(100),
    );
    let t = reduce(&p, &s, &e).unwrap();
    assert_eq!(t.state.verdict.as_deref(), Some("failed"));
}
#[test]
fn nested_join_continues_outer_branch_once() {
    let mut p = joined("all", "stop");
    for n in ["x", "y"] {
        step(&mut p, n, "agent");
    }
    step(&mut p, "inner", "join");
    route(&mut p, "a", None, &["x", "y"]);
    route(&mut p, "x", None, &["inner"]);
    route(&mut p, "y", None, &["inner"]);
    route(&mut p, "inner", None, &["join"]);
    p.joins[0].branches[0]
        .members
        .extend([address("x"), address("y"), address("inner")]);
    p.joins.push(Join030 {
        address: address("inner"),
        scope: vec![],
        origin: address("a"),
        branches: ["x", "y"]
            .iter()
            .map(|n| Branch030 {
                name: n.to_string(),
                target: address(n),
                members: vec![address(n)],
                fanout: false,
            })
            .collect(),
        mode: "all".into(),
        failures: "fail".into(),
        max_failures_json: None,
        quorum_count_json: None,
        accept: vec![],
        remaining: "stop".into(),
    });
    let mut t = launch(p);
    t.finish("a", json!({}), None);
    t.prepare(None);
    t.finish("x", json!({"x":1}), None);
    t.finish("y", json!({"y":2}), None);
    t.finish("b", json!({}), None);
    assert_eq!(t.s.groups[0].decision.as_deref(), Some("done"));
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}

#[test]
fn nested_finish_branch_does_not_block_outer_join_but_delays_run_end() {
    let mut p = joined("all", "finish");
    for name in ["x", "y"] {
        step(&mut p, name, "agent");
    }
    step(&mut p, "inner", "join");
    route(&mut p, "a", None, &["x", "y"]);
    for name in ["x", "y"] {
        route(&mut p, name, Some("yes"), &["inner"]);
        route(&mut p, name, Some("no"), &["inner"]);
    }
    route(&mut p, "inner", Some("reached"), &["join"]);
    route(&mut p, "inner", Some("missed"), &["join"]);
    p.joins[0].branches[0]
        .members
        .extend([address("x"), address("y"), address("inner")]);
    p.joins.push(Join030 {
        address: address("inner"),
        scope: vec![],
        origin: address("a"),
        branches: ["x", "y"]
            .iter()
            .map(|name| Branch030 {
                name: name.to_string(),
                target: address(name),
                members: vec![address(name)],
                fanout: false,
            })
            .collect(),
        mode: "quorum".into(),
        failures: "fail".into(),
        max_failures_json: None,
        quorum_count_json: Some("1".into()),
        accept: vec!["yes".into()],
        remaining: "finish".into(),
    });
    let mut t = launch(p);
    t.finish("a", json!({}), None);
    t.prepare(None);
    t.finish("x", json!({"choice":"yes"}), Some("yes"));
    t.finish("b", json!({}), None);
    assert_eq!(
        t.s.groups
            .iter()
            .find(|g| g.join == address("join"))
            .unwrap()
            .decision
            .as_deref(),
        Some("done")
    );
    assert_eq!(t.running("y"), 1);
    assert_eq!(t.s.verdict, None);
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict, None);
    t.finish("y", json!({"choice":"no"}), Some("no"));
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}

#[test]
fn composition_output_continues_while_inner_finish_work_remains_physical() {
    let mut p = plan();
    step(&mut p, "start", "agent");
    compose(&mut p, "outer", "outer/spread", &["ok"]);
    for name in ["outer/spread", "outer/x", "outer/y", "after"] {
        step(&mut p, name, "agent");
    }
    step(&mut p, "outer/inner", "join");
    route(&mut p, "start", None, &["outer"]);
    route(&mut p, "outer/spread", None, &["outer/x", "outer/y"]);
    for name in ["outer/x", "outer/y"] {
        route(&mut p, name, Some("yes"), &["outer/inner"]);
        route(&mut p, name, Some("no"), &["outer/inner"]);
    }
    output_route(&mut p, "outer/inner", "outer", "ok");
    route(&mut p, "outer", Some("ok"), &["after"]);
    p.joins.push(Join030 {
        address: address("outer/inner"),
        scope: address("outer"),
        origin: address("outer/spread"),
        branches: ["x", "y"]
            .iter()
            .map(|name| Branch030 {
                name: name.to_string(),
                target: address(&format!("outer/{name}")),
                members: vec![address(&format!("outer/{name}"))],
                fanout: false,
            })
            .collect(),
        mode: "quorum".into(),
        failures: "fail".into(),
        max_failures_json: None,
        quorum_count_json: Some("1".into()),
        accept: vec!["yes".into()],
        remaining: "finish".into(),
    });
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({}), None);
    t.prepare(None);
    t.finish("outer/spread", json!({}), None);
    t.prepare(None);
    t.finish("outer/x", json!({"choice":"yes"}), Some("yes"));
    assert_eq!(t.running("outer/y"), 1);
    t.prepare(None);
    assert_eq!(t.running("after"), 1);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict, None);
    t.finish("outer/y", json!({"choice":"no"}), Some("no"));
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}

fn shared_origin_joins() -> FlowPlan030 {
    let mut p = joined("all", "stop");
    step(&mut p, "join2", "join");
    let mut second = p.joins[0].clone();
    second.address = address("join2");
    second.remaining = "finish".into();
    p.joins.push(second);
    for name in ["a", "b"] {
        p.routes
            .retain(|r| r.source != address(name) || r.kind != "normal");
        route(&mut p, name, Some("one"), &["join"]);
        route(&mut p, name, Some("two"), &["join2"]);
    }
    p
}

#[test]
fn shared_origin_joins_both_wait_for_the_same_started_works() {
    // The tagged AgSDL validator accepts both joins with the same origin and branches.
    let t = launch(shared_origin_joins());
    assert_eq!(t.running("a"), 1);
    assert_eq!(t.running("b"), 1);
    assert_eq!(t.s.groups.len(), 2);
    for group in &t.s.groups {
        assert_eq!(
            group.decision, None,
            "join {:?} decided before its branches ended",
            group.join
        );
        assert_eq!(
            group
                .branches
                .iter()
                .map(|b| b.path_ids.len())
                .sum::<usize>(),
            2
        );
    }
    assert_eq!(t.s.paths.len(), 2);
    for path in &t.s.paths {
        assert_eq!(path.memberships.len(), 2);
        assert_ne!(path.memberships[0].group_id, path.memberships[1].group_id);
    }
}

#[test]
fn arrival_at_one_shared_join_closes_the_other_once() {
    let mut t = launch(shared_origin_joins());
    t.finish("a", json!({"choice":"one"}), Some("one"));
    let first =
        t.s.groups
            .iter()
            .find(|g| g.join == address("join"))
            .unwrap();
    let other =
        t.s.groups
            .iter()
            .find(|g| g.join == address("join2"))
            .unwrap();
    assert_eq!(first.decision, None);
    assert_eq!(other.decision.as_deref(), Some("closed"));
    assert_eq!(t.running("b"), 1);
    assert_eq!(t.s.visits_at(&address("a")), "1");
    assert_eq!(t.s.visits_at(&address("b")), "1");
    let a =
        t.s.activations
            .iter()
            .find(|a| a.step == Some(address("a")))
            .unwrap();
    let path_id = a
        .context
        .iter()
        .find_map(|frame| match frame {
            Frame030::Path { path_id, .. } => Some(path_id),
            _ => None,
        })
        .unwrap();
    let path = t.s.paths.iter().find(|p| &p.id == path_id).unwrap();
    let membership = path
        .memberships
        .iter()
        .find(|m| m.group_id == first.id)
        .unwrap();
    let producer = membership.producer.as_ref().unwrap();
    assert_eq!(producer.activation_id, a.id);
    assert_eq!(producer.step, Some(address("a")));
}

#[test]
fn shared_path_can_reach_remaining_open_join_after_finish_closes_sibling() {
    for chosen in ["one", "two"] {
        let mut p = shared_origin_joins();
        p.joins[0].remaining = "finish".into();
        let destination = if chosen == "one" { "join" } else { "join2" };
        let mut t = launch(p);
        t.finish("a", json!({"choice": chosen}), Some(chosen));
        t.finish("b", json!({"choice": chosen}), Some(chosen));
        let group =
            t.s.groups
                .iter()
                .find(|g| g.join == address(destination))
                .unwrap();
        assert_eq!(group.decision.as_deref(), Some("done"));
        let other =
            t.s.groups
                .iter()
                .find(|g| g.join != address(destination))
                .unwrap();
        assert_eq!(other.decision.as_deref(), Some("closed"));
        assert_eq!(t.s.visits_at(&address("a")), "1");
        assert_eq!(t.s.visits_at(&address("b")), "1");
    }
}

#[test]
fn shared_path_failure_reaches_the_group_still_open_after_finish() {
    for chosen in ["one", "two"] {
        let mut p = shared_origin_joins();
        p.joins[0].remaining = "finish".into();
        let destination = if chosen == "one" { "join" } else { "join2" };
        let mut t = launch(p);
        t.finish("a", json!({"choice": chosen}), Some(chosen));
        t.fail("b");
        let group =
            t.s.groups
                .iter()
                .find(|g| g.join == address(destination))
                .unwrap();
        assert_eq!(group.decision.as_deref(), Some("failed"));
        assert_eq!(group.error.as_ref().unwrap().details[0]["branch"], "b");
        assert_eq!(
            t.s.groups
                .iter()
                .filter(|g| g.decision.as_deref() == Some("closed"))
                .count(),
            1
        );
    }
}

#[test]
fn one_shared_failure_is_recorded_in_each_open_keep_group() {
    let mut p = shared_origin_joins();
    for join in &mut p.joins {
        join.failures = "keep".into();
        join.remaining = "finish".into();
    }
    let mut t = launch(p);
    t.fail("a");
    assert_eq!(t.running("b"), 1);
    assert!(t.s.groups.iter().all(|group| group.decision.is_none()));
    let activation =
        t.s.activations
            .iter()
            .find(|a| a.step == Some(address("a")))
            .unwrap();
    let path_id = activation
        .context
        .iter()
        .find_map(|frame| match frame {
            Frame030::Path { path_id, .. } => Some(path_id),
            _ => None,
        })
        .unwrap();
    let path = t.s.paths.iter().find(|path| &path.id == path_id).unwrap();
    assert_eq!(path.memberships.len(), 2);
    assert!(path
        .memberships
        .iter()
        .all(|membership| membership.failed && membership.phase == "ended"));
}

#[test]
fn finish_join_does_not_withdraw_pending_items_needed_by_an_open_join() {
    let mut p = shared_origin_joins();
    p.joins[0].mode = "quorum".into();
    p.joins[0].quorum_count_json = Some("1".into());
    p.joins[0].accept = vec!["approve".into()];
    p.joins[0].remaining = "finish".into();
    p.joins[0].branches.retain(|b| b.name == "a");
    p.joins[0].branches[0].fanout = true;
    p.joins[0].branches.push(Branch030 {
        name: "start".into(),
        target: address("join"),
        members: vec![],
        fanout: false,
    });
    p.joins[1].mode = "quorum".into();
    p.joins[1].quorum_count_json = Some("2".into());
    p.joins[1].accept = vec!["two".into()];
    p.joins[1].remaining = "finish".into();
    p.joins[1].branches.retain(|b| b.name == "a");
    p.joins[1].branches[0].fanout = true;
    route(&mut p, "start", Some("approve"), &["a", "join"]);
    let route = p
        .routes
        .iter_mut()
        .find(|r| r.source == address("start") && r.key.as_deref() == Some("approve"))
        .unwrap();
    route.targets[0] = Target030::Step {
        address: address("a"),
        message_json: None,
        each_path_json: Some("[\"results\",\"items\"]".into()),
        concurrency_json: Some("1".into()),
        max_json: Some("3".into()),
    };
    let mut t = Test::new(p);
    t.enter();
    t.finish(
        "start",
        json!({"choice":"approve","results":{"items":["x","y","z"]}}),
        Some("approve"),
    );
    t.prepare(Some(vec![json!("x"), json!("y"), json!("z")]));
    assert_eq!(
        t.s.groups
            .iter()
            .find(|g| g.join == address("join"))
            .unwrap()
            .decision
            .as_deref(),
        Some("reached")
    );
    assert_eq!(
        t.s.groups
            .iter()
            .find(|g| g.join == address("join2"))
            .unwrap()
            .decision,
        None
    );
    assert_eq!(t.running("a"), 1);
    t.finish("a", json!({"choice":"two"}), Some("two"));
    assert_eq!(t.running("a"), 1);
    t.finish("a", json!({"choice":"two"}), Some("two"));
    assert_eq!(
        t.s.groups
            .iter()
            .find(|g| g.join == address("join2"))
            .unwrap()
            .decision
            .as_deref(),
        Some("reached")
    );
    assert_eq!(t.s.visits_at(&address("a")), "2");
}

#[test]
fn fanout_preflight_failure_reaches_every_affected_join() {
    let mut p = shared_origin_joins();
    for join in &mut p.joins {
        join.branches
            .iter_mut()
            .find(|branch| branch.name == "a")
            .unwrap()
            .fanout = true;
    }
    let route = p
        .routes
        .iter_mut()
        .find(|route| route.source == address("start"))
        .unwrap();
    route.targets[0] = Target030::Step {
        address: address("a"),
        message_json: None,
        each_path_json: Some("[\"items\"]".into()),
        concurrency_json: None,
        max_json: Some("1".into()),
    };
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({"items":[1,2]}), None);
    t.prepare(Some(vec![json!(1), json!(2)]));
    for join in ["join", "join2"] {
        assert!(t.effects.iter().any(|effect| matches!(&effect.kind,
            FlowEffectKind030::Failure { step: Some(step), error, .. }
                if *step == address(join) && error.code == "FANOUT_LIMIT")));
    }
    assert_eq!(t.s.visits_at(&address("a")), "0");
    assert_eq!(t.s.visits_at(&address("b")), "0");
}

#[test]
fn multiple_join_visit_limits_fail_before_any_branch_starts() {
    let mut p = shared_origin_joins();
    for step in &mut p.steps {
        if step.address == address("join") || step.address == address("join2") {
            step.max_visits_json = Some("1".into());
        }
    }
    let mut t = Test::new(p);
    t.enter();
    t.finish("start", json!({}), None);
    t.s.visits.insert("[\"join\"]".into(), "1".into());
    t.s.visits.insert("[\"join2\"]".into(), "1".into());
    t.prepare(None);
    for join in ["join", "join2"] {
        assert!(t.effects.iter().any(|effect| matches!(&effect.kind,
            FlowEffectKind030::Failure { step: Some(step), error, .. }
                if *step == address(join) && error.code == "VISIT_LIMIT")));
    }
    assert_eq!(t.s.visits_at(&address("a")), "0");
    assert_eq!(t.s.visits_at(&address("b")), "0");
}

#[test]
fn stopping_a_run_with_shared_paths_requests_each_physical_stop_once() {
    let mut t = launch(shared_origin_joins());
    let transition = t.send(FlowEventKind030::Stop);
    let stops: Vec<_> = transition
        .effects
        .iter()
        .filter_map(|effect| match &effect.kind {
            FlowEffectKind030::StopWork { work, .. } => Some(work.activation_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(stops.len(), 2);
    assert_ne!(stops[0], stops[1]);
    assert_eq!(t.s.verdict, None);
    t.physical_stops();
    assert_eq!(t.s.verdict.as_deref(), Some("cancelled"));
}

#[test]
fn one_route_closing_several_finish_groups_has_one_continuation() {
    let mut p = shared_origin_joins();
    p.joins[0].remaining = "finish".into();
    route(&mut p, "a", Some("leave"), &["after"]);
    let mut t = launch(p);
    t.finish("a", json!({"choice":"leave"}), Some("leave"));
    assert!(t
        .s
        .groups
        .iter()
        .all(|g| g.decision.as_deref() == Some("closed")));
    let pending =
        t.s.preparations
            .iter()
            .filter(|p| p.status == "pending")
            .count();
    assert_eq!(pending, 1);
    t.prepare(None);
    assert_eq!(t.running("after"), 1);
    assert_eq!(t.running("b"), 1);
}

#[test]
fn physical_stop_requests_are_deduplicated_for_a_shared_work() {
    let mut p = shared_origin_joins();
    p.joins[1].remaining = "stop".into();
    route(&mut p, "a", Some("leave"), &["after"]);
    let mut t = launch(p);
    let b = t.work("b");
    let prior = t.effects.len();
    t.finish("a", json!({"choice":"leave"}), Some("leave"));
    let stops = t.effects[prior..]
        .iter()
        .filter(|effect| {
            matches!(&effect.kind,
        FlowEffectKind030::StopWork { work, include_descendants: true } if *work == b)
        })
        .count();
    assert_eq!(stops, 1);
    assert_eq!(t.running("after"), 0, "stop must await physical evidence");
    // The other group's semantic treatment of this cancelled path is issue #4.
}

#[test]
fn one_route_waits_for_every_closed_group_barrier() {
    let mut p = shared_origin_joins();
    p.joins[0].remaining = "stop".into();
    p.joins[1].remaining = "wait".into();
    route(&mut p, "a", Some("leave"), &["after"]);
    let mut t = launch(p);
    t.finish("a", json!({"choice":"leave"}), Some("leave"));
    assert!(t
        .s
        .groups
        .iter()
        .all(|g| g.decision.as_deref() == Some("closed")));
    assert_eq!(t.s.route_barriers.len(), 1);
    assert_eq!(
        t.s.preparations
            .iter()
            .filter(|p| p.status == "pending")
            .count(),
        0
    );
    t.physical_stops();
    assert!(t.s.route_barriers.is_empty());
    assert_eq!(
        t.s.preparations
            .iter()
            .filter(|p| p.status == "pending")
            .count(),
        1
    );
    t.prepare(None);
    assert_eq!(t.running("after"), 1);
}

#[test]
fn shared_wait_excludes_late_result_and_waits_for_physical_evidence() {
    let mut p = shared_origin_joins();
    p.joins[0].remaining = "wait".into();
    p.joins[1].remaining = "finish".into();
    route(&mut p, "a", Some("leave"), &["after"]);
    let mut t = launch(p);
    let b = t.work("b");
    t.finish("a", json!({"choice":"leave"}), Some("leave"));
    assert_eq!(t.s.route_barriers.len(), 1);
    t.send(FlowEventKind030::WorkResult {
        work: b.clone(),
        result: WorkResult030::Completed {
            output_json: "{\"choice\":\"one\"}".into(),
            route_key: Some("one".into()),
        },
        physical: None,
    });
    assert_eq!(t.s.route_barriers.len(), 1);
    assert_eq!(t.running("after"), 0);
    assert!(t
        .s
        .groups
        .iter()
        .find(|g| g.join == address("join"))
        .unwrap()
        .output_json
        .is_none());
    t.send(FlowEventKind030::PhysicalEnded {
        work: b,
        stop_effect_id: None,
        evidence: PhysicalEvidence030 {
            native_receipt_id: "joined-b".into(),
            descendants_joined: true,
        },
    });
    assert!(t.s.route_barriers.is_empty());
    assert!(t
        .s
        .groups
        .iter()
        .find(|g| g.join == address("join"))
        .unwrap()
        .output_json
        .is_none());
    assert_eq!(
        t.s.preparations
            .iter()
            .filter(|p| p.status == "pending" && p.reference.route.source == address("a"))
            .count(),
        1
    );
    t.prepare(None);
    t.finish("after", json!({}), None);
    assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
}

#[test]
fn actual_ir_shared_wait_tracks_physical_branch_boundary() {
    for delayed in [false, true] {
        let plan: FlowPlan030 = serde_json::from_str(include_str!(
            "fixtures/agsdl030_wait_boundary_compiled_plan.json"
        ))
        .unwrap();
        let mut t = Test::new(plan);
        t.enter();
        t.finish(
            "start",
            json!({"choice":"split","results":{"items":["x","y"]}}),
            Some("split"),
        );
        t.prepare(Some(vec![json!("x"), json!("y")]));
        assert_eq!(t.running("a"), 2);
        t.finish("b", json!({"choice":"approve"}), Some("approve"));
        let join = |t: &Test| {
            t.s.groups
                .iter()
                .find(|g| g.join == address("join"))
                .unwrap()
                .clone()
        };
        let frozen = join(&t).output_json;
        assert!(frozen.is_some());
        assert!(!join(&t).released);
        let mut physical = Vec::new();
        for _ in 0..2 {
            let work = t.work("a");
            if delayed {
                t.send(FlowEventKind030::WorkResult {
                    work: work.clone(),
                    result: WorkResult030::Completed {
                        output_json: "{\"choice\":\"continue\"}".into(),
                        route_key: Some("continue".into()),
                    },
                    physical: None,
                });
                physical.push(work);
            } else {
                t.finish("a", json!({"choice":"continue"}), Some("continue"));
            }
            t.prepare(None);
        }
        assert_eq!(t.running("c"), 2);
        if delayed {
            assert!(!join(&t).released);
            // Resume after logical departure must retain every physical barrier.
            let saved_state = serde_json::to_string(&t.s).unwrap();
            t.s = serde_json::from_str(&saved_state).unwrap();
            assert!(!join(&t).released);
            assert_eq!(t.running("c"), 2);
            let incomplete = FlowEvent030 {
                identity: t.s.identity.clone(),
                event_id: "descendants-still-running".into(),
                expected_revision: t.s.revision.clone(),
                kind: FlowEventKind030::PhysicalEnded {
                    work: physical[0].clone(),
                    stop_effect_id: None,
                    evidence: PhysicalEvidence030 {
                        native_receipt_id: "incomplete-evidence".into(),
                        descendants_joined: false,
                    },
                },
            };
            assert!(matches!(
                reduce(&t.p, &t.s, &incomplete),
                Err(FlowInputError030::InvalidEvent(_))
            ));
            assert!(!join(&t).released);
            for (index, work) in physical.into_iter().enumerate() {
                t.send(FlowEventKind030::PhysicalEnded {
                    work,
                    stop_effect_id: None,
                    evidence: PhysicalEvidence030 {
                        native_receipt_id: format!("a-ended-{index}"),
                        descendants_joined: true,
                    },
                });
                if index == 0 {
                    assert!(!join(&t).released);
                }
            }
        }
        assert!(
            join(&t).released,
            "wait must end after both a works and descendants"
        );
        assert_eq!(join(&t).output_json, frozen);
        assert_eq!(t.running("c"), 2);
        t.prepare(None);
        t.finish("after", json!({}), None);
        assert_eq!(t.s.verdict, None);
        t.finish("c", json!({"choice":"two"}), Some("two"));
        t.finish("c", json!({"choice":"two"}), Some("two"));
        assert_eq!(join(&t).output_json, frozen);
        assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
    }
}

#[test]
fn simultaneous_finish_closures_refresh_one_shared_preparation_once() {
    let mut p = shared_origin_joins();
    p.joins[0].remaining = "finish".into();
    step(&mut p, "c", "agent");
    for join in &mut p.joins {
        join.branches
            .iter_mut()
            .find(|b| b.name == "b")
            .unwrap()
            .members
            .push(address("c"));
    }
    p.routes
        .retain(|r| r.source != address("b") || r.kind != "normal");
    route(&mut p, "b", None, &["c"]);
    route(&mut p, "c", Some("one"), &["join"]);
    route(&mut p, "c", Some("two"), &["join2"]);
    route(&mut p, "a", Some("leave"), &["after"]);
    let mut t = launch(p);
    t.finish("b", json!({}), None);
    let old =
        t.s.preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap()
            .reference
            .clone();
    let before = t.effects.len();
    t.finish("a", json!({"choice":"leave"}), Some("leave"));
    let replacements = t.effects[before..]
        .iter()
        .filter(|effect| {
            matches!(&effect.kind,
        FlowEffectKind030::PrepareRoute { reference, .. } if reference.route.source == address("b"))
        })
        .count();
    assert_eq!(replacements, 1);
    let stale = FlowEvent030 {
        identity: t.s.identity.clone(),
        event_id: "old-preparation".into(),
        expected_revision: t.s.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference: old,
            native_receipt_id: "old-proof".into(),
            result: PreparedResult030::Ready { batches: vec![] },
        },
    };
    assert_eq!(
        reduce(&t.p, &t.s, &stale).unwrap_err(),
        FlowInputError030::StaleReference
    );
}

#[test]
fn closing_sibling_groups_retains_path_for_an_open_group() {
    let mut p = shared_origin_joins();
    p.joins[0].remaining = "finish".into();
    step(&mut p, "join3", "join");
    step(&mut p, "c", "agent");
    let mut third = p.joins[0].clone();
    third.address = address("join3");
    third
        .branches
        .iter_mut()
        .find(|b| b.name == "a")
        .unwrap()
        .members
        .push(address("c"));
    p.joins.push(third);
    route(&mut p, "a", Some("continue"), &["c"]);
    route(&mut p, "b", Some("three"), &["join3"]);
    route(&mut p, "c", None, &["join3"]);
    let mut t = launch(p);
    t.finish("a", json!({"choice":"continue"}), Some("continue"));
    assert_eq!(
        t.s.groups
            .iter()
            .filter(|g| g.decision.as_deref() == Some("closed"))
            .count(),
        2
    );
    t.prepare(None);
    assert_eq!(t.running("c"), 1);
    t.finish("c", json!({}), None);
    t.finish("b", json!({"choice":"three"}), Some("three"));
    let group =
        t.s.groups
            .iter()
            .find(|g| g.join == address("join3"))
            .unwrap();
    assert_eq!(group.decision.as_deref(), Some("done"));
}

#[test]
fn max_failures_reports_the_failure_that_crosses_the_limit() {
    let mut p = joined("all", "stop");
    p.joins[0].failures = "keep".into();
    p.joins[0].max_failures_json = Some("1".into());
    let mut t = launch(p);
    t.fail("b");
    t.fail("a");
    let failure = t
        .effects
        .iter()
        .find_map(|effect| match &effect.kind {
            FlowEffectKind030::Failure {
                step: Some(step),
                error,
                ..
            } if *step == address("join") => Some(error),
            _ => None,
        })
        .unwrap();
    assert_eq!(failure.code, "BRANCH_FAILED");
    assert_eq!(failure.details[0]["branch"], "a");
}

#[test]
fn contradictory_agent_choice_and_route_are_rejected_atomically() {
    let plan: FlowPlan030 = serde_json::from_str(include_str!(
        "fixtures/agsdl030_wait_boundary_compiled_plan.json"
    ))
    .unwrap();
    let mut t = Test::new(plan);
    t.enter();
    t.finish(
        "start",
        json!({"choice":"split","results":{"items":["x","y"]}}),
        Some("split"),
    );
    t.prepare(Some(vec![json!("x"), json!("y")]));
    let before = t.s.clone();
    for (output, key) in [
        (json!({"choice":"one"}), Some("two")),
        (json!({"choice":"one"}), None),
        (json!({}), Some("one")),
        (json!({"choice":null}), None),
        (json!({"choice":true}), Some("one")),
    ] {
        let event = FlowEvent030 {
            identity: t.s.identity.clone(),
            event_id: "contradictory-result".into(),
            expected_revision: t.s.revision.clone(),
            kind: FlowEventKind030::WorkResult {
                work: t.work("a"),
                result: WorkResult030::Completed {
                    output_json: output.to_string(),
                    route_key: key.map(str::to_string),
                },
                physical: Some(PhysicalEvidence030 {
                    native_receipt_id: "ended".into(),
                    descendants_joined: true,
                }),
            },
        };
        assert!(matches!(
            reduce(&t.p, &t.s, &event),
            Err(FlowInputError030::ResultRouteMismatch | FlowInputError030::InvalidEvent(_))
        ));
        assert_eq!(t.s, before);
    }
    t.finish("a", json!({"choice":"one"}), Some("one"));
}

#[test]
fn call_outcome_and_approval_decision_use_their_own_routes() {
    for (kind, output, key) in [
        (
            "call",
            json!({"outcome":"passed","data":{"value":{"choice":"reject"}}}),
            "passed",
        ),
        (
            "approval",
            json!({"choice":"approve","comment":"","message":{}}),
            "approve",
        ),
    ] {
        let mut p = plan();
        step(&mut p, "start", kind);
        step(&mut p, "after", "agent");
        route(&mut p, "start", Some(key), &["after"]);
        let mut t = Test::new(p);
        t.enter();
        if kind == "approval" {
            let before = t.s.clone();
            let contradictory = FlowEvent030 {
                identity: t.s.identity.clone(),
                event_id: "contradictory-approval".into(),
                expected_revision: t.s.revision.clone(),
                kind: FlowEventKind030::WorkResult {
                    work: t.work("start"),
                    result: WorkResult030::Completed {
                        output_json: json!({"choice":"reject","comment":"","message":{}})
                            .to_string(),
                        route_key: Some("approve".into()),
                    },
                    physical: Some(PhysicalEvidence030 {
                        native_receipt_id: "approval-physical".into(),
                        descendants_joined: true,
                    }),
                },
            };
            assert_eq!(
                reduce(&t.p, &t.s, &contradictory).unwrap_err(),
                FlowInputError030::ResultRouteMismatch
            );
            assert_eq!(t.s, before);
            assert!(
                t.s.activations
                    .iter()
                    .find(|a| a.id == t.work("start").activation_id)
                    .unwrap()
                    .physical
            );
        }
        t.finish("start", output, Some(key));
        t.prepare(None);
        assert_eq!(t.running("after"), 1);
    }
}

#[test]
fn unresolved_shared_stop_returns_a_diagnostic_without_committing_or_hanging() {
    for (bytes, active, closing, affected) in [
        (
            include_str!("fixtures/agsdl030_shared_stop_pending_compiled_plan.json"),
            false,
            "j1",
            "j2",
        ),
        (
            include_str!("fixtures/agsdl030_shared_stop_active_compiled_plan.json"),
            true,
            "j2",
            "j1",
        ),
    ] {
        let plan: FlowPlan030 = serde_json::from_str(bytes).unwrap();
        let mut t = Test::new(plan);
        t.enter();
        t.finish(
            "o",
            json!({"choice":"approve","results":{"items":["x","y"]}}),
            Some("approve"),
        );
        let kind = if active {
            t.prepare(Some(vec![json!("x"), json!("y")]));
            assert_eq!(t.running("a"), 1);
            FlowEventKind030::WorkResult {
                work: t.work("a"),
                result: WorkResult030::Completed {
                    output_json: "{\"choice\":\"one\"}".into(),
                    route_key: Some("one".into()),
                },
                physical: None,
            }
        } else {
            t.preparation(Some(vec![json!("x"), json!("y")]))
        };
        let before = t.s.clone();
        let event = FlowEvent030 {
            identity: t.s.identity.clone(),
            event_id: "unresolved-stop".into(),
            expected_revision: t.s.revision.clone(),
            kind,
        };
        assert_eq!(
            reduce(&t.p, &t.s, &event).unwrap_err(),
            FlowInputError030::UnspecifiedSharedCancellation {
                closing_join: address(closing),
                affected_joins: vec![address(affected)],
            }
        );
        assert_eq!(t.s, before);
        assert_eq!(t.s.verdict, None);
        // Stop remains explicit and usable; no replacement branch outcome is inferred.
        t.send(FlowEventKind030::Stop);
        t.physical_stops();
        assert_eq!(t.s.verdict.as_deref(), Some("cancelled"));
    }
}

#[test]
fn outer_stop_cancels_nested_groups_and_waits_for_physical_end() {
    for elements in [vec![json!("first")], vec![json!("first"), json!("pending")]] {
        let plan: FlowPlan030 = serde_json::from_str(include_str!(
            "fixtures/agsdl030_nested_stop_compiled_plan.json"
        ))
        .unwrap();
        let mut t = Test::new(plan);
        t.enter();
        t.finish("o", json!({}), None);
        t.prepare(None);
        t.finish("a", json!({"results":{"items":elements}}), None);
        t.prepare(Some(elements.clone()));
        assert_eq!(t.running("x"), 1);
        assert_eq!(t.running("y"), 1);
        let inner =
            t.s.groups
                .iter()
                .find(|g| g.join == address("inner"))
                .unwrap()
                .id
                .clone();
        let pending = t
            .s
            .paths
            .iter()
            .filter(|p| p.phase == "pending" && p.memberships.iter().any(|m| m.group_id == inner))
            .count();
        assert_eq!(pending, elements.len() - 1);

        t.finish("b", json!({"choice":"yes"}), Some("yes"));
        let group =
            t.s.groups
                .iter()
                .find(|g| g.join == address("inner"))
                .unwrap();
        assert_eq!(group.decision.as_deref(), Some("stopped"));
        assert!(group.released);
        assert!(group.continuation.is_none());
        assert!(t
            .s
            .paths
            .iter()
            .filter(|p| p.memberships.iter().any(|m| m.group_id == inner))
            .all(|p| p.phase != "pending"));
        let outer =
            t.s.groups
                .iter()
                .find(|g| g.join == address("outer"))
                .unwrap();
        assert_eq!(outer.decision.as_deref(), Some("reached"));
        assert!(!outer.released);
        assert_eq!(t.s.verdict, None);
        let stops = t
            .effects
            .iter()
            .filter_map(|e| match &e.kind {
                FlowEffectKind030::StopWork { work, .. } => Some(work.activation_id.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(stops.len(), 2);
        assert_ne!(stops[0], stops[1]);
        for name in ["x", "y"] {
            let work =
                t.s.activations
                    .iter()
                    .find(|a| a.step == Some(address(name)) && a.physical)
                    .unwrap();
            assert!(stops.contains(&work.id));
            assert_eq!(work.phase, "stopping");
        }
        t.physical_stops();
        assert_eq!(t.s.verdict.as_deref(), Some("succeeded"));
        assert_eq!(t.s.visits_at(&address("x")), "1");
        assert_eq!(t.s.visits_at(&address("y")), "1");
    }
}

#[test]
fn outer_stop_still_refuses_independent_sharing_beside_nested_groups() {
    let plan: FlowPlan030 = serde_json::from_str(include_str!(
        "fixtures/agsdl030_nested_stop_shared_compiled_plan.json"
    ))
    .unwrap();
    let mut t = Test::new(plan);
    t.enter();
    t.finish("o", json!({}), None);
    t.prepare(None);
    t.finish("a", json!({"results":{"items":["active","pending"]}}), None);
    t.prepare(Some(vec![json!("active"), json!("pending")]));
    assert_eq!(t.running("c"), 1);
    assert!(t
        .s
        .groups
        .iter()
        .find(|g| g.join == address("other"))
        .unwrap()
        .decision
        .is_none());
    let before = t.s.clone();
    let event = FlowEvent030 {
        identity: t.s.identity.clone(),
        event_id: "shared-beside-nested-stop".into(),
        expected_revision: t.s.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: t.work("b"),
            result: WorkResult030::Completed {
                output_json: "{\"choice\":\"yes\"}".into(),
                route_key: Some("yes".into()),
            },
            physical: None,
        },
    };
    assert_eq!(
        reduce(&t.p, &t.s, &event).unwrap_err(),
        FlowInputError030::UnspecifiedSharedCancellation {
            closing_join: address("outer"),
            affected_joins: vec![address("other")],
        }
    );
    assert_eq!(t.s, before);
    t.send(FlowEventKind030::Stop);
    t.physical_stops();
    assert_eq!(t.s.verdict.as_deref(), Some("cancelled"));
}
