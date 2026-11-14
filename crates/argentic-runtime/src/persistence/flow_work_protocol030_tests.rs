use super::super::dto::{EngineOwner, EngineWork};
use super::super::flow030::{Activation030, Instance030, WorkResultRecord030};
use super::*;

fn identity() -> FlowIdentity030 {
    FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "run".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture-epoch".into(),
    }
}
fn active() -> FlowState030 {
    let mut flow = FlowState030::new(identity());
    flow.revision = "9007199254740993".into();
    flow.activations.push(Activation030 {
        id: "work".into(),
        step: Some(vec!["step".into()]),
        agent: Some("agent".into()),
        selector: Some(Instance030::Shared),
        delivery: "queue".into(),
        instance_id: Some("instance".into()),
        sender: None,
        context: vec![],
        phase: "running".into(),
        physical: true,
        physical_wait_groups: vec![],
        start_effect_id: Some("start".into()),
        stop_effect_id: None,
        input_json: "{}".into(),
        message_json: None,
        item_json: None,
        occurrence: None,
        producer: None,
        result: None,
    });
    flow
}
fn context() -> EngineContext {
    EngineContext {
        owner: EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "7".into(),
        },
        work: EngineWork {
            system_start_id: "system".into(),
            flow_invocation_id: "run".into(),
            activation_id: "work".into(),
            step: Some(vec!["step".into()]),
            agent_instance_id: Some("instance".into()),
        },
        permissions_json: "[]".into(),
        scope_json: "{}".into(),
        registry_version: "registry".into(),
    }
}

#[test]
fn flow_guard_fences_stop_terminal_old_identity_and_unphysical_work() {
    let state = active();
    assert!(live_activation(&state, &identity(), "work", false).is_ok());
    assert!(live_activation(&state, &identity(), "other", false).is_err());
    let mut wrong = identity();
    wrong.epoch = "other".into();
    assert!(live_activation(&state, &wrong, "work", false).is_err());
    let mut stopped = state.clone();
    stopped.stopping = true;
    assert!(live_activation(&stopped, &identity(), "work", false).is_err());
    stopped.activations[0].phase = "stopping".into();
    assert!(live_activation(&stopped, &identity(), "work", true).is_ok());
    let mut cancelled = state.clone();
    cancelled.activations[0].stop_effect_id = Some("stop".into());
    assert!(live_activation(&cancelled, &identity(), "work", false).is_err());
    let mut ended = state.clone();
    ended.activations[0].physical = false;
    assert!(live_activation(&ended, &identity(), "work", false).is_err());
    let mut finished = state.clone();
    finished.activations[0].phase = "done".into();
    assert!(live_activation(&finished, &identity(), "work", false).is_err());
    let mut result = state.clone();
    result.activations[0].result = Some(WorkResultRecord030::Completed {
        output_json: "{}".into(),
        route_key: None,
    });
    assert!(live_activation(&result, &identity(), "work", false).is_err());
    let mut terminal = state.clone();
    terminal.verdict = Some("finished".into());
    assert!(live_activation(&terminal, &identity(), "work", false).is_err());
    let mut bad_revision = state;
    bad_revision.revision = "01".into();
    assert!(live_activation(&bad_revision, &identity(), "work", false).is_err());
}

#[test]
fn ticket_retains_exact_event_and_attribution_bytes() {
    let input = ProtocolEvent030 {
        context: context(),
        event_id: "event".into(),
        expected_revision: "0".into(),
        event_json: "{ \"value\":9007199254740993 }".into(),
        native_call: None,
        control: false,
    };
    let ticket = FlowWorkTicket030 {
        identity: identity(),
        input,
        ticket_id: "ticket".into(),
        generation: "generation".into(),
        flow_revision: "9007199254740993".into(),
        state_json: EMPTY_JOURNAL.into(),
        contract_json: "{ \"contract\":true }".into(),
        options_json: "{}".into(),
    };
    let raw = serde_json::to_string(&ticket).unwrap();
    assert_eq!(
        serde_json::from_str::<FlowWorkTicket030>(&raw).unwrap(),
        ticket
    );
    let mut changed = ticket.clone();
    changed.input.event_json = "{\"value\":9007199254740993}".into();
    assert_ne!(changed, ticket);
    changed = ticket.clone();
    changed.input.context.owner.owner_epoch = "8".into();
    assert_ne!(changed, ticket);
}

#[test]
fn check_receipt_requires_the_original_native_work_owner() {
    let raw = r#"{"receiptId":"work:1","owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"instance","ownerEpoch":"7"},"revision":"1","decision":{"kind":"checkRequested","check":{"checkId":"check","owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"instance","ownerEpoch":"7"}}}}"#;
    let check = crate::agsdl_host_work::reserved_check030(&context(), raw)
        .unwrap()
        .unwrap();
    assert_eq!(check.check_id, "check");
    let mut foreign = context();
    foreign.owner.owner_epoch = "8".into();
    assert!(crate::agsdl_host_work::reserved_check030(&foreign, raw).is_err());
}
