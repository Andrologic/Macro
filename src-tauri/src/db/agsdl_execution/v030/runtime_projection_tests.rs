use super::super::flow030::{
    Activation030, Batch030, DeliveryOccurrence030, FlowIdentity030, Group030, GroupBranch030,
    Instance030, InstanceState030, Membership030, Path030, PreparedItem030, Producer030,
};
use super::*;
use serde_json::json;

fn setup() -> (FlowPlan030, FlowState030) {
    let plan = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/agsdl030_compiled_plan.json"
    ))
    .unwrap();
    let state = FlowState030::new(FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "run".into(),
        snapshot_id: "snapshot".into(),
        epoch: "private-epoch".into(),
    });
    (plan, state)
}
fn producer() -> Producer030 {
    Producer030 {
        activation_id: "origin".into(),
        step: Some(vec!["source".into()]),
        kind: "agent".into(),
        input_json: "\"PRIVATE_INPUT\"".into(),
        message_json: Some("\"PRIVATE_MESSAGE\"".into()),
        item_json: None,
        output_json: "\"PRIVATE_OUTPUT\"".into(),
    }
}
fn make_batch(
    state: &mut FlowState030,
    batch_id: &str,
    parent: &[Frame030],
    fanout: bool,
    count: usize,
) -> Vec<Vec<Frame030>> {
    let mut contexts = Vec::new();
    let mut ids = Vec::new();
    let mut items = Vec::new();
    for i in 0..count {
        let id = format!("{batch_id}-path-{i}");
        let mut context = parent.to_vec();
        context.push(Frame030::Path {
            path_id: id.clone(),
            departed_groups: vec![],
        });
        let item = fanout.then(|| "\"PRIVATE_EQUAL_VALUE\"".to_owned());
        state.paths.push(Path030 {
            id: id.clone(),
            memberships: vec![],
            batch_id: Some(batch_id.into()),
            item_json: item.clone(),
            context: context.clone(),
            phase: "live".into(),
        });
        ids.push(id);
        contexts.push(context);
        items.push(PreparedItem030 {
            message_json: Some("\"PRIVATE_MESSAGE\"".into()),
            item_json: item,
            occurrence: DeliveryOccurrence030 {
                native_receipt_id: format!("{batch_id}-receipt"),
                target_ordinal: 0,
                item_index: i.to_string(),
            },
        });
    }
    state.batches.push(Batch030 {
        id: batch_id.into(),
        target: vec!["worker".into()],
        items,
        path_ids: ids,
        concurrency_json: None,
        context: parent.to_vec(),
        producer: producer(),
    });
    contexts
}
fn activation(id: &str, context: Vec<Frame030>, phase: &str, physical: bool) -> Activation030 {
    Activation030 {
        id: id.into(),
        step: Some(vec!["worker".into()]),
        agent: Some("worker".into()),
        selector: Some(Instance030::New),
        delivery: "queue".into(),
        instance_id: Some("instance".into()),
        sender: None,
        context,
        phase: phase.into(),
        physical,
        physical_wait_groups: vec![],
        start_effect_id: None,
        stop_effect_id: None,
        input_json: "\"PRIVATE_INPUT\"".into(),
        message_json: Some("\"PUBLIC_MESSAGE\"".into()),
        item_json: None,
        occurrence: None,
        producer: Some(producer()),
        result: None,
    }
}
#[test]
fn nearest_fanout_ignores_fixed_routes_and_equal_values_remain_distinct() {
    let (plan, mut state) = setup();
    let outer = make_batch(&mut state, "outer", &[], true, 2);
    let fixed = make_batch(&mut state, "fixed", &outer[1], false, 1);
    let inner = make_batch(&mut state, "inner", &fixed[0], true, 2);
    let tail = make_batch(&mut state, "tail", &inner[1], false, 1);
    state.activations.push(activation(
        "outer-worker",
        fixed[0].clone(),
        "running",
        true,
    ));
    state
        .activations
        .push(activation("inner-worker", tail[0].clone(), "running", true));
    state.activations.push(activation(
        "second-inner",
        inner[0].clone(),
        "running",
        true,
    ));
    let p = project_runtime030(&plan, &state).unwrap();
    let index = |id: &str| {
        p.activations
            .iter()
            .find(|a| a.id == id)
            .unwrap()
            .nearest_fanout_index
            .clone()
    };
    assert_eq!(index("outer-worker"), Some("1".into()));
    assert_eq!(index("inner-worker"), Some("1".into()));
    assert_eq!(index("second-inner"), Some("0".into()));
    assert_eq!(
        p.paths
            .iter()
            .find(|p| p.id == "tail-path-0")
            .unwrap()
            .nearest_fanout_index
            .as_deref(),
        Some("1")
    );
    assert!(!serde_json::to_string(&p).unwrap().contains("PRIVATE_"));
}
#[test]
fn phases_physical_barriers_groups_and_fifo_are_retained() {
    let (plan, mut state) = setup();
    let ctx = make_batch(&mut state, "fan", &[], true, 1).remove(0);
    state.instances.push(InstanceState030 {
        id: "z".into(),
        agent: "a".into(),
        selector: Instance030::Shared,
        current: None,
        queue: vec!["q2".into(), "q1".into()],
        discarded: false,
    });
    state.instances.push(InstanceState030 {
        id: "a".into(),
        agent: "b".into(),
        selector: Instance030::Named {
            name: "review".into(),
        },
        current: Some("q1".into()),
        queue: vec![],
        discarded: false,
    });
    state
        .activations
        .push(activation("q2", ctx.clone(), "queued", false));
    state
        .activations
        .push(activation("q1", ctx.clone(), "done", true));
    state.activations[1].physical_wait_groups.push("g".into());
    if let Frame030::Path {
        departed_groups, ..
    } = &mut state.activations[1].context[0]
    {
        departed_groups.push("g".into());
    } else {
        panic!("expected path frame");
    }
    state.paths[0].memberships.push(Membership030 {
        group_id: "g".into(),
        branch: "a".into(),
        phase: "excluded".into(),
        result_json: Some("\"PRIVATE_OUTPUT\"".into()),
        producer: Some(producer()),
        accepted: false,
        failed: false,
    });
    state.groups.push(Group030 {
        id: "g".into(),
        join: vec!["join".into()],
        origin_activation_id: "o".into(),
        activation_id: "j".into(),
        context: vec![],
        branches: vec![GroupBranch030 {
            name: "a".into(),
            fanout: true,
            path_ids: vec!["fan-path-0".into()],
        }],
        decision: Some("closed".into()),
        decided_ordinal: None,
        output_json: Some("\"PRIVATE_OUTPUT\"".into()),
        error: None,
        continuation: None,
        released: false,
    });
    let p = project_runtime030(&plan, &state).unwrap();
    assert_eq!(
        p.instances
            .iter()
            .map(|i| i.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "z"]
    );
    assert_eq!(p.instances[1].queue_activation_ids, vec!["q2", "q1"]);
    let a = p.activations.iter().find(|a| a.id == "q1").unwrap();
    assert_eq!(a.phase, "done");
    assert!(a.physical);
    assert_eq!(a.physical_wait_group_ids, vec!["g"]);
    assert!(
        matches!(&a.context[0], RuntimeFrame030::Path { departed_groups, .. } if departed_groups == &vec!["g".to_string()])
    );
    assert_eq!(
        p.activations.iter().find(|a| a.id == "q2").unwrap().phase,
        "queued"
    );
    assert_eq!(p.groups[0].decision.as_deref(), Some("closed"));
    assert!(!p.groups[0].released);
    assert_eq!(p.paths[0].memberships[0].phase, "excluded");
    assert!(!serde_json::to_string(&p).unwrap().contains("PRIVATE_"));
}
#[test]
fn invalid_batch_reference_and_wrong_plan_are_rejected() {
    let (plan, mut state) = setup();
    let contexts = make_batch(&mut state, "batch", &[], true, 1);
    state
        .activations
        .push(activation("a", contexts[0].clone(), "done", false));
    state.batches[0].items[0].occurrence.item_index = "1".into();
    assert_eq!(
        project_runtime030(&plan, &state).unwrap_err(),
        ProjectionError030::InvalidState
    );
    state.batches[0].items[0].occurrence.item_index = "0".into();
    state.plan_json = Some(json!({"different":true}).to_string());
    assert_eq!(
        project_runtime030(&plan, &state).unwrap_err(),
        ProjectionError030::PlanMismatch
    );
}
#[test]
fn no_fanout_is_none_and_output_json_is_stable() {
    let (plan, mut state) = setup();
    let context = make_batch(&mut state, "fixed", &[], false, 1).remove(0);
    state
        .activations
        .push(activation("a", context, "done", false));
    let a = serde_json::to_string(&project_runtime030(&plan, &state).unwrap()).unwrap();
    let b = serde_json::to_string(&project_runtime030(&plan, &state).unwrap()).unwrap();
    assert_eq!(a, b);
    assert!(a.contains("\"nearestFanoutIndex\":null"));
    assert!(!a.contains("PRIVATE_") && !a.contains("private-epoch"));
}

#[test]
fn projects_a_real_reducer_transition_without_exposing_input() {
    use super::super::flow030::{reduce, FlowEvent030, FlowEventKind030};
    let (plan, state) = setup();
    let event = FlowEvent030 {
        identity: state.identity.clone(),
        event_id: "event".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{\"private\":\"PRIVATE_SECRET\"}".into(),
        },
    };
    let next = reduce(&plan, &state, &event).unwrap().state;
    let view = project_runtime030(&plan, &next).unwrap();
    let start = view
        .activations
        .iter()
        .find(|a| a.step.as_deref() == Some(&["fork".to_string()][..]))
        .unwrap();
    assert_eq!(start.phase, "running");
    assert!(start.physical);
    assert_eq!(view.revision, next.revision);
    assert!(!serde_json::to_string(&view)
        .unwrap()
        .contains("PRIVATE_SECRET"));
}

#[test]
fn preserve_declared_fanout_order_and_sort_top_level_ids() {
    let (plan, mut state) = setup();
    let contexts = make_batch(&mut state, "b", &[], true, 12);
    state.groups.push(Group030 {
        id: "z".into(),
        join: vec!["join".into()],
        origin_activation_id: "origin".into(),
        activation_id: "join-work".into(),
        context: vec![],
        branches: vec![GroupBranch030 {
            name: "fan".into(),
            fanout: true,
            path_ids: (0..12).map(|i| format!("b-path-{i}")).collect(),
        }],
        decision: None,
        decided_ordinal: None,
        output_json: None,
        error: None,
        continuation: None,
        released: false,
    });
    state
        .activations
        .push(activation("z", contexts[10].clone(), "done", false));
    state
        .activations
        .push(activation("a", contexts[2].clone(), "done", false));
    let view = project_runtime030(&plan, &state).unwrap();
    assert_eq!(
        view.groups[0].branches[0].path_ids,
        (0..12).map(|i| format!("b-path-{i}")).collect::<Vec<_>>()
    );
    assert_eq!(
        view.activations
            .iter()
            .map(|a| a.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "z"]
    );
    assert_eq!(
        view.activations[0].nearest_fanout_index.as_deref(),
        Some("2")
    );
    assert_eq!(
        view.activations[1].nearest_fanout_index.as_deref(),
        Some("10")
    );
    let ts = RuntimeProjection030::decl(&ts_rs::Config::default());
    assert!(ts.contains("flowInvocationId"));
    assert!(ts.contains("activations"));
    let frame = RuntimeFrame030::decl(&ts_rs::Config::default());
    assert!(frame.contains("activationId"));
    assert!(frame.contains("departedGroups"));
}

#[test]
fn message_projection_distinguishes_queue_consumption_and_steer_fallback() {
    use super::super::flow030::{SteerRecord030, WorkRef030, WorkResultRecord030};
    let (plan, mut state) = setup();
    let mut first = activation("first", vec![], "done", false);
    first.start_effect_id = Some("start-first".into());
    first.result = Some(WorkResultRecord030::Completed {
        output_json: r#"{"text":"Mission accomplie","results":{}}"#.into(),
        route_key: None,
    });
    let queued = activation("queued", vec![], "queued", false);
    let mut steer = activation("steer", vec![], "absorbed", false);
    steer.delivery = "steer".into();
    state.activations = vec![first, queued, steer];
    state.steer_deliveries.push(SteerRecord030 {
        effect_id: "offer".into(),
        work: WorkRef030 {
            activation_id: "first".into(),
            start_effect_id: "start-first".into(),
            agent_instance_id: Some("instance".into()),
        },
        delivery_activation_id: "steer".into(),
        status: "consumed".into(),
        resolved_event_id: Some("ack".into()),
        reason: None,
    });
    let view = project_runtime030(&plan, &state).unwrap();
    let statuses = |id: &str| {
        view.activations
            .iter()
            .find(|a| a.id == id)
            .unwrap()
            .message
            .as_ref()
            .unwrap()
            .statuses
            .clone()
    };
    assert_eq!(statuses("first"), vec!["sent", "delivered", "consumed"]);
    assert_eq!(statuses("queued"), vec!["sent", "queued"]);
    assert_eq!(statuses("steer"), vec!["sent", "delivered", "consumed"]);
    assert_eq!(
        view.activations[0].work_text.as_deref(),
        Some("Mission accomplie")
    );
    assert_eq!(
        view.activations[2]
            .message
            .as_ref()
            .unwrap()
            .target_activation_id
            .as_deref(),
        Some("first")
    );
    state.steer_deliveries[0].status = "fallback".into();
    state.activations[2].start_effect_id = Some("start-fallback".into());
    state.activations[2].phase = "running".into();
    let view = project_runtime030(&plan, &state).unwrap();
    assert_eq!(
        view.activations[2].message.as_ref().unwrap().statuses,
        vec!["sent", "fallback", "delivered"]
    );
}
