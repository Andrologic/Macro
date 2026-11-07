//! Pure AgSDL 0.3 flow reducer. The transaction host owns authentication, durable
//! event identity, physical-effect claims and atomic persistence of this transition.
//! This module never executes an effect or accepts a model-selected destination.
#[path = "flow_number.rs"]
mod number;
#[path = "flow_types.rs"]
mod types;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::BTreeSet;
pub use types::*;

type Result<T> = std::result::Result<T, FlowInputError030>;
fn invalid(message: &str) -> FlowInputError030 {
    FlowInputError030::InvalidEvent(message.into())
}
fn exact(s: &str) -> Result<Value> {
    serde_json::from_str(s).map_err(|_| invalid("Invalid exact JSON"))
}
fn encoded<T: serde::Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).expect("serializable flow value")
}
fn route_ref(r: &Route030) -> RouteRef030 {
    RouteRef030 {
        source: r.source.clone(),
        kind: r.kind.clone(),
        key: r.key.clone(),
    }
}
fn prefix(context: &[Frame030], ancestor: &[Frame030]) -> bool {
    context.len() >= ancestor.len()
        && context.iter().zip(ancestor).all(|(a, b)| match (a, b) {
            (Frame030::Path { path_id: a, .. }, Frame030::Path { path_id: b, .. }) => a == b,
            _ => a == b,
        })
}

/// Replayed events return the original receipt and no new effects, with the current
/// state unchanged. A new event must name the current revision exactly. The host
/// authenticates every receipt before this call and rechecks its claim before IO.
pub fn reduce(
    plan: &FlowPlan030,
    state: &FlowState030,
    event: &FlowEvent030,
) -> Result<FlowTransition030> {
    if state.identity != event.identity || event.event_id.is_empty() {
        return Err(FlowInputError030::Identity);
    }
    let plan_json = encoded(plan);
    if state.plan_json.as_ref().is_some_and(|p| p != &plan_json) {
        return Err(FlowInputError030::Identity);
    }
    let event_json = encoded(event);
    if let Some(old) = state.events.get(&event.event_id) {
        return if old.event_json == event_json {
            Ok(FlowTransition030 {
                state: state.clone(),
                receipt: old.receipt.clone(),
                effects: vec![],
            })
        } else {
            Err(FlowInputError030::Contradiction)
        };
    }
    if !number::canonical(&state.revision) || event.expected_revision != state.revision {
        return Err(FlowInputError030::Revision);
    }
    validate_plan(plan)?;
    if state.visits.values().any(|v| !number::canonical(v)) {
        return Err(FlowInputError030::InvalidState(
            "Noncanonical visit counter".into(),
        ));
    }
    let mut engine = Engine {
        plan,
        state: state.clone(),
        event_id: &event.event_id,
        ordinal: 0,
        effects: vec![],
    };
    engine.state.plan_json = Some(plan_json);
    engine.state.revision = number::increment(&state.revision);
    engine.apply(&event.kind)?;
    engine.settle()?;
    let receipt = FlowReceipt030 {
        event_id: event.event_id.clone(),
        revision: engine.state.revision.clone(),
        effect_ids: engine.effects.iter().map(|e| e.id.clone()).collect(),
    };
    engine.state.events.insert(
        event.event_id.clone(),
        EventRecord030 {
            event_json,
            receipt: receipt.clone(),
        },
    );
    Ok(FlowTransition030 {
        state: engine.state,
        receipt,
        effects: engine.effects,
    })
}

fn validate_plan(plan: &FlowPlan030) -> Result<()> {
    let bad = |s: &str| FlowInputError030::InvalidPlan(s.into());
    if plan.format != "macro-agsdl-compiled-plan/2"
        || plan.versions.snapshot != "2"
        || plan.versions.contract != "agsdl-0.3.0"
        || plan.versions.profile != "macro-agsdl-030-v1"
    {
        return Err(bad("Unsupported plan version"));
    }
    let mut addresses = BTreeSet::new();
    for s in &plan.steps {
        if s.address.is_empty()
            || !addresses.insert(s.address.clone())
            || !["agent", "approval", "call", "join", "compose"].contains(&s.r#type.as_str())
        {
            return Err(bad("Invalid step"));
        }
        if s.r#type == "agent" && (s.agent.is_none() || s.instance.is_none()) {
            return Err(bad("Agent binding missing"));
        }
        if s.instance == Some(Instance030::New) && s.delivery.is_some() {
            return Err(bad("Delivery on new instance"));
        }
        for l in [&s.max_visits_json, &s.timeout_ms_json]
            .into_iter()
            .flatten()
        {
            if number::Limit::parse(l).is_none() {
                return Err(bad("Invalid exact integer limit"));
            }
        }
    }
    if plan.entry.as_ref().is_some_and(|a| !addresses.contains(a)) {
        return Err(bad("Missing entry"));
    }
    let mut routes = BTreeSet::new();
    for r in &plan.routes {
        if !addresses.contains(&r.source)
            || !["normal", "error"].contains(&r.kind.as_str())
            || !routes.insert(encoded(&route_ref(r)))
        {
            return Err(bad("Invalid route reference"));
        }
        for t in &r.targets {
            match t {
                Target030::Step {
                    address,
                    each_path_json,
                    concurrency_json,
                    max_json,
                    ..
                } => {
                    if !addresses.contains(address) {
                        return Err(bad("Missing target"));
                    }
                    if each_path_json.is_none()
                        && (concurrency_json.is_some() || max_json.is_some())
                    {
                        return Err(bad("Fanout limits without each"));
                    }
                    for l in [concurrency_json, max_json].into_iter().flatten() {
                        if number::Limit::parse(l).is_none() {
                            return Err(bad("Invalid fanout limit"));
                        }
                    }
                }
                Target030::Output { scope, name } => {
                    if !plan
                        .scopes
                        .iter()
                        .any(|s| &s.address == scope && s.outputs.contains(name))
                    {
                        return Err(bad("Missing output"));
                    }
                }
            }
        }
    }
    for j in &plan.joins {
        if !addresses.contains(&j.address)
            || !addresses.contains(&j.origin)
            || !["all", "quorum"].contains(&j.mode.as_str())
            || !["fail", "keep"].contains(&j.failures.as_str())
            || !["stop", "finish", "wait"].contains(&j.remaining.as_str())
        {
            return Err(bad("Invalid join"));
        }
        for l in [&j.max_failures_json, &j.quorum_count_json]
            .into_iter()
            .flatten()
        {
            if number::Limit::parse(l).is_none() {
                return Err(bad("Invalid join limit"));
            }
        }
        if j.mode == "quorum" && j.quorum_count_json.is_none() {
            return Err(bad("Missing quorum count"));
        }
        if j.branches.iter().any(|b| {
            !addresses.contains(&b.target) || b.members.iter().any(|m| !addresses.contains(m))
        }) {
            return Err(bad("Invalid branch"));
        }
    }
    for scope in &plan.scopes {
        if !addresses.contains(&scope.entry) {
            return Err(bad("Missing scope entry"));
        }
    }
    Ok(())
}

struct Engine<'a> {
    plan: &'a FlowPlan030,
    state: FlowState030,
    event_id: &'a str,
    ordinal: usize,
    effects: Vec<FlowEffect030>,
}
impl Engine<'_> {
    fn id(&mut self, kind: &str) -> String {
        // JSON tuple framing is injective even when native IDs contain delimiters.
        let id = encoded(&(
            &self.state.identity.system_start_id,
            &self.state.identity.flow_invocation_id,
            self.event_id,
            kind,
            self.ordinal,
        ));
        self.ordinal += 1;
        id
    }
    fn effect(&mut self, kind: FlowEffectKind030) -> String {
        let id = self.id("effect");
        self.push_effect(id.clone(), kind);
        id
    }
    fn push_effect(&mut self, id: String, kind: FlowEffectKind030) {
        self.effects.push(FlowEffect030 {
            id,
            identity: self.state.identity.clone(),
            revision: self.state.revision.clone(),
            kind,
        });
    }
    fn ai(&self, id: &str) -> Result<usize> {
        self.state
            .activations
            .iter()
            .position(|a| a.id == id)
            .ok_or(FlowInputError030::StaleReference)
    }
    fn pi(&self, id: &str) -> usize {
        self.state
            .paths
            .iter()
            .position(|p| p.id == id)
            .expect("stored path")
    }
    fn gi(&self, id: &str) -> usize {
        self.state
            .groups
            .iter()
            .position(|g| g.id == id)
            .expect("stored group")
    }
    fn step(&self, address: &Address030) -> &Step030 {
        self.plan
            .steps
            .iter()
            .find(|s| &s.address == address)
            .expect("validated step")
    }
    fn join(&self, address: &Address030) -> &Join030 {
        self.plan
            .joins
            .iter()
            .find(|s| &s.address == address)
            .expect("validated join")
    }
    fn route(&self, r: &RouteRef030) -> Result<Route030> {
        self.plan
            .routes
            .iter()
            .find(|x| route_ref(x) == *r)
            .cloned()
            .ok_or_else(|| invalid("Undeclared route"))
    }
    fn counted(&self, context: &[Frame030]) -> bool {
        !self.state.stopping
            && context.iter().all(|f| match f {
                Frame030::Path {
                    path_id,
                    departed_groups,
                } => {
                    let memberships = &self.state.paths[self.pi(path_id)].memberships;
                    memberships.is_empty()
                        || memberships.iter().any(|membership| {
                            !departed_groups.contains(&membership.group_id)
                                && self.state.groups[self.gi(&membership.group_id)]
                                    .decision
                                    .is_none()
                        })
                }
                Frame030::Compose { .. } => true,
            })
    }
    fn membership(&self, path: usize, group: &str) -> &Membership030 {
        self.state.paths[path]
            .memberships
            .iter()
            .find(|m| m.group_id == group)
            .expect("group references its path membership")
    }
    fn work_ref(&self, i: usize) -> WorkRef030 {
        let a = &self.state.activations[i];
        WorkRef030 {
            activation_id: a.id.clone(),
            start_effect_id: a.start_effect_id.clone().expect("started work"),
            agent_instance_id: a.instance_id.clone(),
        }
    }
    fn checked_work(&self, w: &WorkRef030) -> Result<usize> {
        let i = self.ai(&w.activation_id)?;
        if self.state.activations[i].start_effect_id.as_ref() != Some(&w.start_effect_id)
            || self.state.activations[i].instance_id != w.agent_instance_id
        {
            return Err(FlowInputError030::StaleReference);
        }
        Ok(i)
    }
    fn evidence(e: &PhysicalEvidence030) -> Result<()> {
        if e.native_receipt_id.is_empty() || !e.descendants_joined {
            Err(invalid("Physical evidence must join work and descendants"))
        } else {
            Ok(())
        }
    }
    fn apply(&mut self, event: &FlowEventKind030) -> Result<()> {
        match event {
            FlowEventKind030::Enter { message_json } => {
                if self.state.entered || self.state.verdict.is_some() || self.state.stopping {
                    return Err(FlowInputError030::StaleReference);
                }
                exact(message_json)?;
                let entry = self
                    .plan
                    .entry
                    .clone()
                    .ok_or_else(|| invalid("No flow entry"))?;
                self.state.entered = true;
                let a = self.allocate(
                    Some(entry),
                    vec![],
                    "null".into(),
                    Some(message_json.clone()),
                    None,
                    None,
                );
                self.admit(a)?;
            }
            FlowEventKind030::Deliver {
                agent,
                instance,
                delivery,
                message_json,
                sender,
            } => {
                if self.plan.entry.is_some()
                    || *instance == Instance030::New
                    || !["queue", "steer"].contains(&delivery.as_str())
                    || !self.plan.graphless_submission_contracts.contains_key(agent)
                    || self.state.stopping
                    || self.state.verdict.is_some()
                {
                    return Err(invalid("Invalid graphless delivery"));
                }
                exact(message_json)?;
                self.state.entered = true;
                let i = self.allocate(
                    None,
                    vec![],
                    "null".into(),
                    Some(message_json.clone()),
                    None,
                    None,
                );
                let a = &mut self.state.activations[i];
                a.agent = Some(agent.clone());
                a.selector = Some(instance.clone());
                a.delivery = delivery.clone();
                a.sender = Some(sender.clone());
                self.admit(i)?;
            }
            FlowEventKind030::WorkResult {
                work,
                result,
                physical,
            } => {
                let i = self.checked_work(work)?;
                if self.state.activations[i].phase != "running" {
                    return Err(FlowInputError030::StaleReference);
                }
                if let Some(p) = physical {
                    Self::evidence(p)?;
                    self.physical_end(i);
                }
                match result {
                    WorkResult030::Completed {
                        output_json,
                        route_key,
                    } => {
                        let output = exact(output_json)?;
                        if !output.is_object() {
                            return Err(invalid("Work output must be an object"));
                        }
                        // Approval outputs forward their input choice and calls route by
                        // outcome. Only an agent's own choice selects its normal route.
                        let agent_output = self.state.activations[i]
                            .step
                            .as_ref()
                            .map(|step| self.step(step).r#type == "agent")
                            .unwrap_or(true);
                        if agent_output {
                            let choice = match output.get("choice") {
                                None => None,
                                Some(Value::String(choice)) => Some(choice.as_str()),
                                Some(_) => return Err(invalid("Agent choice must be a string")),
                            };
                            if choice != route_key.as_deref() {
                                return Err(FlowInputError030::ResultRouteMismatch);
                            }
                        }
                        self.state.activations[i].result = Some(WorkResultRecord030::Completed {
                            output_json: output_json.clone(),
                            route_key: route_key.clone(),
                        });
                        if let Some(step) = self.state.activations[i].step.clone() {
                            let r = self.select(&step, "normal", route_key.as_deref())?;
                            let p = self.producer(i, output_json.clone());
                            self.follow(i, r, p)?;
                        } else {
                            self.effect(FlowEffectKind030::Return {
                                activation_id: self.state.activations[i].id.clone(),
                                sender: self.state.activations[i]
                                    .sender
                                    .clone()
                                    .unwrap_or_default(),
                                output_json: output_json.clone(),
                            });
                            self.end(i, None)?;
                        }
                    }
                    WorkResult030::Failed { error } => {
                        self.state.activations[i].result = Some(WorkResultRecord030::Failed {
                            error: error.clone(),
                        });
                        self.fail(i, error.clone())?;
                    }
                }
            }
            FlowEventKind030::Prepared {
                reference,
                native_receipt_id,
                result,
            } => {
                if native_receipt_id.is_empty() || reference.identity != self.state.identity {
                    return Err(FlowInputError030::Identity);
                }
                if self
                    .state
                    .preparation_receipts
                    .contains_key(native_receipt_id)
                {
                    return Err(FlowInputError030::Contradiction);
                }
                let p = self
                    .state
                    .preparations
                    .iter()
                    .position(|p| p.reference == *reference && p.status == "pending")
                    .ok_or(FlowInputError030::StaleReference)?;
                let i = self.ai(&reference.activation_id)?;
                if self.state.activations[i].phase != "preparing"
                    || self.state.activations[i].context != reference.context
                    || self.state.stopping
                {
                    return Err(FlowInputError030::StaleReference);
                }
                let route = self.route(&reference.route)?;
                let producer = self.state.preparations[p].producer.clone();
                self.state.preparations[p].status = "consumed".into();
                self.state
                    .preparation_receipts
                    .insert(native_receipt_id.clone(), reference.prepare_id.clone());
                match result {
                    PreparedResult030::Ready { batches } => {
                        self.commit_route(i, route, producer, batches, native_receipt_id)?
                    }
                    PreparedResult030::Failed {
                        target_ordinal,
                        error,
                    } => {
                        if *target_ordinal >= route.targets.len() {
                            return Err(invalid("Unknown failed target"));
                        }
                        self.route_failure(i, &route, *target_ordinal, error.clone())?;
                    }
                }
            }
            FlowEventKind030::PhysicalEnded {
                work,
                stop_effect_id,
                evidence,
            } => {
                let i = self.checked_work(work)?;
                Self::evidence(evidence)?;
                if !self.state.activations[i].physical
                    || self.state.activations[i].stop_effect_id != *stop_effect_id
                {
                    return Err(FlowInputError030::StaleReference);
                }
                if self.state.activations[i].phase == "running" {
                    return Err(invalid("Physical end requires result or stop"));
                }
                self.physical_end(i);
                if self.state.activations[i].phase == "stopping" {
                    self.end(i, None)?;
                }
            }
            FlowEventKind030::Stop => {
                if self.state.verdict.is_some() || self.state.stopping {
                    return Err(FlowInputError030::StaleReference);
                }
                self.state.stopping = true;
                self.state.route_barriers.clear();
                for p in &mut self.state.paths {
                    if p.phase == "pending" {
                        p.phase = "withdrawn".into();
                    }
                }
                for g in &mut self.state.groups {
                    g.decision.get_or_insert("stopped".into());
                    g.released = true;
                    g.continuation = None;
                }
                let ids = (0..self.state.activations.len()).collect::<Vec<_>>();
                for i in ids {
                    self.cancel(i)?;
                }
            }
        }
        Ok(())
    }
    fn allocate(
        &mut self,
        step: Option<Address030>,
        context: Vec<Frame030>,
        input_json: String,
        message_json: Option<String>,
        item_json: Option<String>,
        producer: Option<Producer030>,
    ) -> usize {
        let declaration = step.as_ref().map(|s| self.step(s).clone());
        let id = self.id("activation");
        let i = self.state.activations.len();
        self.state.activations.push(Activation030 {
            id,
            step,
            agent: declaration.as_ref().and_then(|s| s.agent.clone()),
            selector: declaration.as_ref().and_then(|s| s.instance.clone()),
            delivery: declaration
                .as_ref()
                .and_then(|s| s.delivery.clone())
                .unwrap_or("queue".into()),
            instance_id: None,
            sender: None,
            context,
            phase: "ready".into(),
            physical: false,
            physical_wait_groups: Vec::new(),
            start_effect_id: None,
            stop_effect_id: None,
            input_json,
            message_json,
            item_json,
            occurrence: None,
            producer,
            result: None,
        });
        i
    }
    fn visit(&mut self, address: &Address030) -> bool {
        let next = number::increment(self.state.visits_at(address));
        if number::exceeds(&next, &self.step(address).max_visits_json) {
            return false;
        }
        self.state.visits.insert(encoded(address), next);
        true
    }
    fn admit(&mut self, i: usize) -> Result<()> {
        if let Some(agent) = self.state.activations[i].agent.clone() {
            let selector = self.state.activations[i]
                .selector
                .clone()
                .unwrap_or(Instance030::Shared);
            let existing = if selector == Instance030::New {
                None
            } else {
                self.state
                    .instances
                    .iter()
                    .position(|s| s.agent == agent && s.selector == selector && !s.discarded)
            };
            let instance = existing.unwrap_or_else(|| {
                let id = self.id("instance");
                let n = self.state.instances.len();
                self.state.instances.push(InstanceState030 {
                    id,
                    agent,
                    selector,
                    current: None,
                    queue: vec![],
                    discarded: false,
                });
                n
            });
            self.state.activations[i].instance_id = Some(self.state.instances[instance].id.clone());
            if let Some(current) = self.state.instances[instance].current.clone() {
                let c = self.ai(&current)?;
                if self.state.activations[i].delivery == "steer"
                    && self.state.activations[c].phase == "running"
                    && self.counted(&self.state.activations[c].context)
                {
                    self.effect(FlowEffectKind030::Steer {
                        work: self.work_ref(c),
                        delivery_activation_id: self.state.activations[i].id.clone(),
                        message_json: self.state.activations[i]
                            .message_json
                            .clone()
                            .unwrap_or("{}".into()),
                        occurrence: self.state.activations[i].occurrence.clone(),
                        sender: self.state.activations[i].producer.clone(),
                    });
                    let by = self.state.activations[c]
                        .step
                        .as_ref()
                        .map(|s| s.join("/"))
                        .unwrap_or(current);
                    return self.end(i, Some(encoded(&json!({"ended":"absorbed","by":by}))));
                }
                self.state.activations[i].phase = "queued".into();
                self.state.instances[instance]
                    .queue
                    .push(self.state.activations[i].id.clone());
                return Ok(());
            }
        }
        self.start(i)
    }
    fn start(&mut self, i: usize) -> Result<()> {
        if let Some(address) = self.state.activations[i].step.clone() {
            if !self.visit(&address) {
                return self.fail(i, Failure030::new("VISIT_LIMIT"));
            }
            let s = self.step(&address).clone();
            if s.r#type == "compose" {
                self.state.activations[i].phase = "body".into();
                let entry = self
                    .plan
                    .scopes
                    .iter()
                    .find(|s| s.address == address)
                    .ok_or_else(|| FlowInputError030::InvalidPlan("Missing compose scope".into()))?
                    .entry
                    .clone();
                let a = self.state.activations[i].clone();
                let mut context = a.context;
                context.push(Frame030::Compose {
                    activation_id: a.id,
                });
                let child = self.allocate(
                    Some(entry),
                    context,
                    a.input_json,
                    a.message_json,
                    a.item_json,
                    a.producer,
                );
                self.state.activations[child].occurrence = a.occurrence;
                return self.admit(child);
            }
            if s.r#type == "join" {
                return Err(invalid("Join requires a group"));
            }
        }
        let id = self.id("effect");
        self.state.activations[i].start_effect_id = Some(id.clone());
        self.state.activations[i].phase = "running".into();
        self.state.activations[i].physical = true;
        let a = self.state.activations[i].clone();
        if let Some(instance) = &a.instance_id {
            let inst = self
                .state
                .instances
                .iter_mut()
                .find(|s| &s.id == instance)
                .unwrap();
            inst.current = Some(a.id.clone());
        }
        self.push_effect(
            id,
            FlowEffectKind030::Start {
                work: self.work_ref(i),
                step: a.step,
                agent: a.agent,
                input_json: a.input_json,
                message_json: a.message_json,
                item_json: a.item_json,
                occurrence: a.occurrence,
                sender: a.producer,
            },
        );
        Ok(())
    }
    fn physical_end(&mut self, i: usize) {
        self.state.activations[i].physical = false;
        self.state.activations[i].physical_wait_groups.clear();
        if let Some(id) = &self.state.activations[i].instance_id {
            let instance = self
                .state
                .instances
                .iter_mut()
                .find(|s| &s.id == id)
                .unwrap();
            if instance.current.as_ref() == Some(&self.state.activations[i].id) {
                instance.current = None;
                if instance.selector == Instance030::New {
                    instance.discarded = true;
                }
            }
        }
    }
    fn producer(&self, i: usize, output_json: String) -> Producer030 {
        let a = &self.state.activations[i];
        Producer030 {
            activation_id: a.id.clone(),
            step: a.step.clone(),
            kind: a
                .step
                .as_ref()
                .map(|s| self.step(s).r#type.clone())
                .unwrap_or("agent".into()),
            input_json: a.input_json.clone(),
            message_json: a.message_json.clone(),
            item_json: a.item_json.clone(),
            output_json,
        }
    }
    fn select(&self, address: &Address030, kind: &str, key: Option<&str>) -> Result<Route030> {
        self.plan
            .routes
            .iter()
            .find(|r| &r.source == address && r.kind == kind && r.key.as_deref() == key)
            .or_else(|| {
                self.plan
                    .routes
                    .iter()
                    .find(|r| &r.source == address && r.kind == kind && r.key.is_none())
            })
            .cloned()
            .ok_or_else(|| invalid("Output does not select a declared route"))
    }
    fn invalidate_prepare(&mut self, i: usize) {
        let id = &self.state.activations[i].id;
        for p in &mut self.state.preparations {
            if &p.reference.activation_id == id && p.status == "pending" {
                p.status = "revoked".into();
            }
        }
    }
    fn end(&mut self, i: usize, result: Option<String>) -> Result<()> {
        self.invalidate_prepare(i);
        self.state.activations[i].phase = "done".into();
        let context = self.state.activations[i].context.clone();
        self.end_context(context, result)
    }
    fn context_busy(&self, context: &[Frame030]) -> bool {
        self.state
            .activations
            .iter()
            .any(|a| a.phase != "done" && prefix(&a.context, context) && self.counted(&a.context))
            || self
                .state
                .groups
                .iter()
                .any(|g| !g.released && prefix(&g.context, context) && self.counted(&g.context))
            || self.state.paths.iter().any(|p| {
                p.phase == "pending" && prefix(&p.context, context) && self.counted(&p.context)
            })
    }
    fn end_context(&mut self, mut context: Vec<Frame030>, result: Option<String>) -> Result<()> {
        if context.is_empty() || self.context_busy(&context) {
            return Ok(());
        }
        match context.pop().unwrap() {
            Frame030::Compose { activation_id } => {
                let i = self.ai(&activation_id)?;
                if self.state.activations[i].phase == "body" {
                    self.end(i, None)?;
                }
            }
            Frame030::Path { path_id, .. } => {
                let p = self.pi(&path_id);
                if self.state.paths[p].phase == "live" {
                    self.state.paths[p].phase = "ended".into();
                    let output =
                        Some(result.unwrap_or_else(|| encoded(&json!({"ended":"without-result"}))));
                    for membership in &mut self.state.paths[p].memberships {
                        if membership.phase == "live" {
                            membership.phase = "ended".into();
                            membership.result_json = output.clone();
                        }
                    }
                }
                if self.state.paths[p].memberships.is_empty() {
                    self.end_context(context, None)?;
                }
            }
        };
        Ok(())
    }
    fn fail(&mut self, i: usize, error: Failure030) -> Result<()> {
        let a = self.state.activations[i].clone();
        let counted = self.counted(&a.context);
        self.effect(FlowEffectKind030::Failure {
            activation_id: a.id.clone(),
            step: a.step.clone(),
            error: error.clone(),
            counted,
        });
        if !counted {
            return self.end(i, None);
        }
        if let Some(address) = &a.step {
            if let Some(r) = self
                .plan
                .routes
                .iter()
                .find(|r| &r.source == address && r.kind == "error" && !r.inherited)
                .cloned()
            {
                let p = self.producer(i, encoded(&json!({"error":error})));
                return self.follow(i, r, p);
            }
        }
        for frame in a.context.iter().rev() {
            match frame {
                Frame030::Path { path_id, .. } => {
                    let p = self.pi(path_id);
                    let active_memberships = self.state.paths[p]
                        .memberships
                        .iter()
                        .filter(|membership| {
                            self.state.groups[self.gi(&membership.group_id)]
                                .decision
                                .is_none()
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if !active_memberships.is_empty() {
                        let groups = active_memberships
                            .iter()
                            .map(|m| m.group_id.clone())
                            .collect::<Vec<_>>();
                        self.state.paths[p].phase = "ended".into();
                        self.state.activations[i].phase = "done".into();
                        self.invalidate_prepare(i);
                        // Record the same failure for every nearest sibling group
                        // before any one group's effects can alter the others.
                        for active_membership in active_memberships {
                            let g = active_membership.group_id;
                            let gi = self.gi(&g);
                            let join = self.join(&self.state.groups[gi].join).clone();
                            let failures = self.state.groups[gi]
                                .branches
                                .iter()
                                .flat_map(|b| &b.path_ids)
                                .filter(|id| self.membership(self.pi(id), &g).failed)
                                .count()
                                + 1;
                            if join.mode == "all"
                                && (join.failures == "fail"
                                    || number::exceeds(
                                        &failures.to_string(),
                                        &join.max_failures_json,
                                    ))
                            {
                                let mut branch_error = Failure030::new("BRANCH_FAILED");
                                branch_error.details =
                                    json!([{ "branch": active_membership.branch, "error": error }]);
                                self.state.groups[gi].error = Some(branch_error);
                            }
                            let membership = self.state.paths[p]
                                .memberships
                                .iter_mut()
                                .find(|m| m.group_id == g)
                                .expect("group membership");
                            membership.failed = true;
                            membership.phase = "ended".into();
                            membership.result_json =
                                Some(encoded(&json!({"ended":"failed","error":error})));
                        }
                        for g in groups {
                            self.evaluate(self.gi(&g))?;
                        }
                        return Ok(());
                    }
                }
                Frame030::Compose { activation_id } => {
                    self.state.activations[i].phase = "done".into();
                    self.invalidate_prepare(i);
                    let parent = self.ai(activation_id)?;
                    // Several joins can fail on the same admission barrier.
                    // Their common compose is still one work and may leave
                    // through its error route only once.
                    if self.state.activations[parent].phase != "body" {
                        return Ok(());
                    }
                    return self.fail(parent, error);
                }
            }
        }
        if let Some(address) = &a.step {
            if let Some(r) = self
                .plan
                .routes
                .iter()
                .find(|r| &r.source == address && r.kind == "error" && r.inherited)
                .cloned()
            {
                let p = self.producer(i, encoded(&json!({"error":error})));
                return self.follow(i, r, p);
            }
        }
        self.state.unhandled_failure = true;
        self.end(i, None)
    }
    fn follow(&mut self, i: usize, route: Route030, producer: Producer030) -> Result<()> {
        self.invalidate_prepare(i);
        if route.targets.is_empty() {
            return self.end(i, None);
        }
        // A shared path can leave a finished group while continuing in another.
        // Detach only this continuation; other activations on the path keep
        // their own contexts and the departing work still needs physical proof.
        let context = self.state.activations[i].context.clone();
        let scope = self.step(&route.source).scope.clone();
        let mut departures = Vec::new();
        for (frame_index, frame) in context.iter().enumerate() {
            let Frame030::Path {
                path_id,
                departed_groups,
            } = frame
            else {
                continue;
            };
            let path = &self.state.paths[self.pi(path_id)];
            let has_open_sibling = path.memberships.iter().any(|m| {
                let g = &self.state.groups[self.gi(&m.group_id)];
                g.decision.is_none()
                    && self.join(&g.join).scope == scope
                    && !departed_groups.contains(&m.group_id)
            });
            if !has_open_sibling {
                continue;
            }
            for m in &path.memberships {
                let g = &self.state.groups[self.gi(&m.group_id)];
                let j = self.join(&g.join);
                if m.phase != "excluded"
                    || j.scope != scope
                    || departed_groups.contains(&g.id)
                    || !matches!(j.remaining.as_str(), "finish" | "wait")
                {
                    continue;
                }
                let branch = j
                    .branches
                    .iter()
                    .find(|b| b.name == m.branch)
                    .expect("group branch");
                let inside = route.targets.iter().all(|t| matches!(t, Target030::Step { address, .. } if branch.members.contains(address)));
                if !inside {
                    departures.push((frame_index, g.id.clone(), j.remaining == "wait"));
                }
            }
        }
        for (frame_index, group_id, wait) in departures {
            if let Frame030::Path {
                departed_groups, ..
            } = &mut self.state.activations[i].context[frame_index]
            {
                departed_groups.push(group_id.clone());
            }
            if wait && self.state.activations[i].physical {
                self.state.activations[i]
                    .physical_wait_groups
                    .push(group_id);
            }
        }
        let a = self.state.activations[i].clone();
        // One route may close several sibling groups. Record one continuation
        // and wait until every affected physical barrier has been released.
        for frame in a.context.iter().rev() {
            let Frame030::Path { path_id, .. } = frame else {
                continue;
            };
            let pi = self.pi(path_id);
            let path = self.state.paths[pi].clone();
            if path.memberships.len() < 2 {
                continue;
            }
            let mut reached = Vec::new();
            let mut closed = Vec::new();
            let mut inside = Vec::new();
            for membership in &path.memberships {
                let gi = self.gi(&membership.group_id);
                let group = &self.state.groups[gi];
                let join = self.join(&group.join);
                if group.decision.is_some() || join.scope != scope {
                    continue;
                }
                let branch = join
                    .branches
                    .iter()
                    .find(|b| b.name == membership.branch)
                    .expect("group branch");
                if route.targets.iter().all(|t| matches!(t, Target030::Step { address, .. } if *address == join.address)) {
                    reached.push(gi);
                } else if !route.targets.iter().all(|t| matches!(t, Target030::Step { address, .. } if branch.members.contains(address))) {
                    closed.push(gi);
                } else {
                    inside.push(gi);
                }
            }
            // The sibling groups opened by this path have the same parent.
            // Nested paths continue to be handled by their own context frames.
            if !closed.is_empty()
                && reached.len() <= 1
                && closed.iter().all(|gi| {
                    self.state.groups[*gi].context == self.state.groups[closed[0]].context
                })
            {
                let groups = closed
                    .iter()
                    .map(|gi| self.state.groups[*gi].id.clone())
                    .collect::<Vec<_>>();
                let parent_context = if inside.is_empty() {
                    self.state.groups[closed[0]].context.clone()
                } else {
                    // The same path still belongs to an open sibling branch.
                    a.context.clone()
                };
                let arrival_group = reached.first().map(|gi| self.state.groups[*gi].id.clone());
                for membership in &mut self.state.paths[pi].memberships {
                    if groups.contains(&membership.group_id) {
                        membership.phase = "escaped".into();
                    }
                }
                self.state.activations[i].phase = "barrier".into();
                self.state.route_barriers.push(RouteBarrier030 {
                    activation_id: a.id.clone(),
                    path_id: path_id.clone(),
                    groups: groups.clone(),
                    arrival_group,
                    route: route_ref(&route),
                    producer,
                    parent_context,
                });
                for gi in &closed {
                    self.state.groups[*gi].decision = Some("closed".into());
                    self.state.groups[*gi].continuation = None;
                    let join_activation = self.ai(&self.state.groups[*gi].activation_id.clone())?;
                    self.state.activations[join_activation].phase = "done".into();
                }
                for gi in closed {
                    self.exclude(gi, false)?;
                    self.release(gi)?;
                }
                self.refresh_preparations(&groups)?;
                return Ok(());
            }
        }
        // Scope-local membership: a compose body does not escape its parent's branch.
        for frame in a.context.iter().rev() {
            let Frame030::Path { path_id, .. } = frame else {
                continue;
            };
            let p = self.state.paths[self.pi(path_id)].clone();
            // Prefer the still-open membership. A previous sibling group may
            // have closed in finish mode while this path remains active.
            let selected = p
                .memberships
                .iter()
                .find(|membership| {
                    let group = &self.state.groups[self.gi(&membership.group_id)];
                    group.decision.is_none() && self.join(&group.join).scope == scope
                })
                .or_else(|| {
                    p.memberships.iter().find(|membership| {
                        let group = &self.state.groups[self.gi(&membership.group_id)];
                        membership.phase != "escaped" && self.join(&group.join).scope == scope
                    })
                });
            let Some(membership) = selected else { continue };
            let group_id = membership.group_id.clone();
            let gi = self.gi(&group_id);
            let g = self.state.groups[gi].clone();
            let j = self.join(&g.join).clone();
            if j.scope != scope {
                continue;
            }
            let branch = j
                .branches
                .iter()
                .find(|b| b.name == membership.branch)
                .unwrap();
            let reaches = route
                .targets
                .iter()
                .all(|t| matches!(t,Target030::Step {address,..} if *address==j.address));
            let inside = route.targets.iter().all(
                |t| matches!(t,Target030::Step {address,..} if branch.members.contains(address)),
            );
            if g.decision.is_some() {
                if !inside {
                    return self.end(i, None);
                }
                continue;
            }
            if reaches {
                let pi = self.pi(path_id);
                let accepted = exact(&producer.output_json)?
                    .get("choice")
                    .and_then(Value::as_str)
                    .is_some_and(|c| j.accept.iter().any(|v| v == c));
                let membership = self.state.paths[pi]
                    .memberships
                    .iter_mut()
                    .find(|m| m.group_id == group_id)
                    .expect("group membership");
                membership.accepted = accepted;
                membership.producer = Some(producer.clone());
                return self.end(i, Some(producer.output_json));
            }
            if !inside {
                self.state.activations[i].context = g.context.clone();
                self.state.activations[i].phase = "barrier".into();
                self.state.groups[gi].decision = Some("closed".into());
                self.state.groups[gi].continuation = Some(Continuation030::Route {
                    activation_id: a.id,
                    route: route_ref(&route),
                    producer,
                });
                let ji = self.ai(&g.activation_id)?;
                self.state.activations[ji].phase = "done".into();
                self.exclude(gi, true)?;
                return self.release(gi);
            }
        }
        if route.targets.len() == 1 {
            if let Target030::Output { scope, name } = &route.targets[0] {
                let owner = a
                    .context
                    .iter()
                    .rev()
                    .find_map(|f| match f {
                        Frame030::Compose { activation_id } => {
                            self.ai(activation_id).ok().filter(|idx| {
                                self.state.activations[*idx].step.as_ref() == Some(scope)
                            })
                        }
                        _ => None,
                    })
                    .ok_or(FlowInputError030::StaleReference)?;
                if self.state.activations[owner].phase != "body" {
                    return Err(FlowInputError030::StaleReference);
                }
                self.state.activations[i].phase = "done".into();
                let next = self.select(scope, "normal", Some(name))?;
                return self.follow(owner, next, producer);
            }
        }
        let reference = PrepareRef030 {
            identity: self.state.identity.clone(),
            prepare_id: self.id("prepare"),
            activation_id: a.id,
            revision: self.state.revision.clone(),
            route: route_ref(&route),
            context: self.state.activations[i].context.clone(),
        };
        self.state.activations[i].phase = "preparing".into();
        self.state.preparations.push(Preparation030 {
            reference: reference.clone(),
            producer: producer.clone(),
            status: "pending".into(),
        });
        self.effect(FlowEffectKind030::PrepareRoute {
            reference,
            producer,
        });
        Ok(())
    }
    fn opening_joins(&self, route: &Route030) -> Vec<Join030> {
        self.plan.joins.iter().filter(|j|j.origin==route.source && route.targets.iter().any(|t|matches!(t,Target030::Step {address,..} if j.branches.iter().any(|b|b.target==*address)))).cloned().collect()
    }
    fn route_failure(
        &mut self,
        i: usize,
        route: &Route030,
        target: usize,
        error: Failure030,
    ) -> Result<()> {
        let a = self.state.activations[i].clone();
        self.state.activations[i].phase = "done".into();
        let joins = self.opening_joins(route);
        let affected = joins.iter().filter(|j|matches!(&route.targets[target],Target030::Step{address,..} if j.branches.iter().any(|b|b.target==*address))).collect::<Vec<_>>();
        if !affected.is_empty() {
            for join in affected {
                let ji = self.allocate(
                    Some(join.address.clone()),
                    a.context.clone(),
                    a.input_json.clone(),
                    None,
                    None,
                    None,
                );
                // A refused opening consumes no work visit. Each affected join
                // handles its failure without admitting any route target.
                self.fail(ji, error.clone())?;
            }
            Ok(())
        } else if let Target030::Step { address, .. } = &route.targets[target] {
            let ti = self.allocate(
                Some(address.clone()),
                a.context,
                a.input_json,
                None,
                None,
                None,
            );
            self.fail(ti, error)
        } else {
            self.fail(i, error)
        }
    }
    fn validate_batches(
        &self,
        route: &Route030,
        batches: &[PreparedBatch030],
        native_receipt_id: &str,
    ) -> Result<Option<(usize, Failure030)>> {
        if route.targets.len() != batches.len() {
            return Err(invalid("Preparation must include every target"));
        }
        // Authenticate every batch position before interpreting a semantic
        // fan-out failure from any individual target.
        for (ordinal, (target, batch)) in route.targets.iter().zip(batches).enumerate() {
            if batch.target_ordinal != ordinal || batch.target != *target {
                return Err(invalid("Prepared destination differs from selected route"));
            }
            for (item_index, item) in batch.items.iter().enumerate() {
                if item.occurrence.native_receipt_id != native_receipt_id
                    || item.occurrence.target_ordinal != ordinal
                    || item.occurrence.item_index != item_index.to_string()
                {
                    return Err(invalid(
                        "Prepared occurrence differs from authenticated batch position",
                    ));
                }
            }
        }
        for (ordinal, (target, batch)) in route.targets.iter().zip(batches).enumerate() {
            match target {
                Target030::Step {
                    address,
                    each_path_json,
                    max_json,
                    ..
                } => {
                    if each_path_json.is_none()
                        && (batch.items.len() != 1 || batch.items[0].item_json.is_some())
                    {
                        return Err(invalid("Fixed target must have one delivery"));
                    }
                    if each_path_json.is_some()
                        && number::exceeds(&batch.items.len().to_string(), max_json)
                    {
                        return Ok(Some((ordinal, Failure030::new("FANOUT_LIMIT"))));
                    }
                    for item in &batch.items {
                        if each_path_json.is_some() && item.item_json.is_none() {
                            return Err(invalid("Missing fanout item"));
                        }
                        if let Some(s) = &item.item_json {
                            exact(s)?;
                        }
                        if let Some(s) = &item.message_json {
                            if !exact(s)?.is_object() {
                                return Err(invalid("Message must be object"));
                            }
                        }
                        let work_type = &self.step(address).r#type;
                        if ["call", "join"].contains(&work_type.as_str())
                            && item.message_json.is_some()
                        {
                            return Err(invalid("Message for call or join"));
                        }
                        if ["agent", "approval", "compose"].contains(&work_type.as_str())
                            && item.message_json.is_none()
                        {
                            return Err(invalid("Missing prepared message"));
                        }
                    }
                }
                Target030::Output { .. } => {
                    return Err(invalid("Outputs are resolved by the reducer"))
                }
            }
        }
        Ok(None)
    }
    fn commit_route(
        &mut self,
        i: usize,
        route: Route030,
        producer: Producer030,
        batches: &[PreparedBatch030],
        native_receipt_id: &str,
    ) -> Result<()> {
        if let Some((t, e)) = self.validate_batches(&route, batches, native_receipt_id)? {
            return self.route_failure(i, &route, t, e);
        }
        let joins = self.opening_joins(&route);
        // Join visits form an admission barrier for the entire selected route.
        let limited = joins
            .iter()
            .filter(|j| {
                number::exceeds(
                    &number::increment(self.state.visits_at(&j.address)),
                    &self.step(&j.address).max_visits_json,
                )
            })
            .collect::<Vec<_>>();
        if !limited.is_empty() {
            let a = self.state.activations[i].clone();
            self.state.activations[i].phase = "done".into();
            for j in limited {
                let ji = self.allocate(
                    Some(j.address.clone()),
                    a.context.clone(),
                    a.input_json.clone(),
                    None,
                    None,
                    None,
                );
                self.fail(ji, Failure030::new("VISIT_LIMIT"))?;
            }
            return Ok(());
        }
        // Fixed immediately-starting targets are checked before any target is admitted.
        // Queued deliveries and concurrency-pending elements only consume visits on start.
        let mut prospective = self.state.visits.clone();
        let mut instances = BTreeSet::new();
        for (t, batch) in batches.iter().enumerate() {
            let Target030::Step {
                address,
                concurrency_json,
                ..
            } = &batch.target
            else {
                unreachable!()
            };
            let s = self.step(address);
            if s.r#type == "join" {
                continue;
            }
            let impossible=joins.iter().any(|j| {
                if j.mode!="quorum" || !j.branches.iter().any(|b|b.target==*address) {return false;}
                let paths:usize=batches.iter().filter(|b|matches!(&b.target,Target030::Step {address,..} if j.branches.iter().any(|branch|branch.target==*address))).map(|b|b.items.len()).sum();
                number::Limit::parse(j.quorum_count_json.as_ref().unwrap()).unwrap().compare_counter(&paths.to_string())==Ordering::Less
            });
            if impossible {
                continue;
            }
            for (n, _) in batch.items.iter().enumerate() {
                if number::exceeds(&(n + 1).to_string(), concurrency_json) {
                    break;
                }
                if let Some(agent) = &s.agent {
                    if s.instance != Some(Instance030::New) {
                        let key = encoded(&(agent, &s.instance));
                        if !instances.insert(key)
                            || self.state.instances.iter().any(|a| {
                                &a.agent == agent
                                    && Some(&a.selector) == s.instance.as_ref()
                                    && (a.current.is_some() || !a.queue.is_empty())
                            })
                        {
                            continue;
                        }
                    }
                }
                let key = encoded(address);
                let next =
                    number::increment(prospective.get(&key).map(String::as_str).unwrap_or("0"));
                if number::exceeds(&next, &s.max_visits_json) {
                    return self.route_failure(i, &route, t, Failure030::new("VISIT_LIMIT"));
                }
                prospective.insert(key, next);
            }
        }
        let context = self.state.activations[i].context.clone();
        self.state.activations[i].phase = "done".into();
        let mut opened = Vec::new();
        for j in &joins {
            let ji = self.allocate(
                Some(j.address.clone()),
                context.clone(),
                producer.output_json.clone(),
                None,
                None,
                Some(producer.clone()),
            );
            self.visit(&j.address);
            self.state.activations[ji].phase = "group".into();
            let id = self.id("group");
            let gi = self.state.groups.len();
            let branches = j
                .branches
                .iter()
                .filter(|b| {
                    route
                        .targets
                        .iter()
                        .any(|t| matches!(t,Target030::Step{address,..} if *address==b.target))
                })
                .map(|b| GroupBranch030 {
                    name: b.name.clone(),
                    fanout: b.fanout,
                    path_ids: vec![],
                })
                .collect();
            self.state.groups.push(Group030 {
                id,
                join: j.address.clone(),
                origin_activation_id: self.state.activations[i].id.clone(),
                activation_id: self.state.activations[ji].id.clone(),
                context: context.clone(),
                branches,
                decision: None,
                output_json: None,
                error: None,
                continuation: None,
                released: false,
            });
            opened.push(gi);
        }
        let mut direct = Vec::new();
        let mut plain = Vec::new();
        for batch in batches {
            let Target030::Step {
                address,
                each_path_json,
                concurrency_json,
                ..
            } = &batch.target
            else {
                unreachable!()
            };
            let owning = opened
                .iter()
                .filter_map(|g| {
                    self.join(&self.state.groups[*g].join)
                        .branches
                        .iter()
                        .find(|b| b.target == *address)
                        .map(|b| (*g, b.name.clone()))
                })
                .collect::<Vec<_>>();
            if each_path_json.is_none() && owning.is_empty() {
                plain.push((address.clone(), batch.items[0].clone()));
                continue;
            }
            let batch_id = self.id("batch");
            let mut path_ids = vec![];
            for item in &batch.items {
                let id = self.id("path");
                let mut pc = context.clone();
                pc.push(Frame030::Path {
                    path_id: id.clone(),
                    departed_groups: Vec::new(),
                });
                self.state.paths.push(Path030 {
                    id: id.clone(),
                    memberships: owning
                        .iter()
                        .map(|(g, branch)| Membership030 {
                            group_id: self.state.groups[*g].id.clone(),
                            branch: branch.clone(),
                            phase: "pending".into(),
                            result_json: None,
                            producer: None,
                            accepted: false,
                            failed: false,
                        })
                        .collect(),
                    batch_id: Some(batch_id.clone()),
                    item_json: item.item_json.clone(),
                    context: pc,
                    phase: "pending".into(),
                });
                for (g, b) in &owning {
                    self.state.groups[*g]
                        .branches
                        .iter_mut()
                        .find(|x| &x.name == b)
                        .unwrap()
                        .path_ids
                        .push(id.clone());
                }
                path_ids.push(id);
            }
            let bi = self.state.batches.len();
            self.state.batches.push(Batch030 {
                id: batch_id,
                target: address.clone(),
                items: batch.items.clone(),
                path_ids,
                concurrency_json: concurrency_json.clone(),
                context: context.clone(),
                producer: producer.clone(),
            });
            if self.step(address).r#type == "join" {
                direct.push(bi);
            }
        }
        // Empty and unreachable quorum groups decide before any work is started.
        for g in &opened {
            self.evaluate(*g)?;
        }
        for bi in direct {
            let batch = self.state.batches[bi].clone();
            for id in batch.path_ids {
                let pi = self.pi(&id);
                let group = self.state.paths[pi]
                    .memberships
                    .iter()
                    .find(|m| self.state.groups[self.gi(&m.group_id)].join == batch.target)
                    .map(|m| m.group_id.clone())
                    .ok_or_else(|| invalid("Direct join without group"))?;
                if self.state.groups[self.gi(&group)].decision.is_some() {
                    continue;
                }
                let j = self.join(&self.state.groups[self.gi(&group)].join);
                let accepted = exact(&producer.output_json)?
                    .get("choice")
                    .and_then(Value::as_str)
                    .is_some_and(|c| j.accept.iter().any(|v| v == c));
                self.state.paths[pi].phase = "ended".into();
                let membership = self.state.paths[pi]
                    .memberships
                    .iter_mut()
                    .find(|m| m.group_id == group)
                    .expect("group membership");
                membership.phase = "ended".into();
                membership.result_json = Some(producer.output_json.clone());
                membership.producer = Some(producer.clone());
                membership.accepted = accepted;
                self.evaluate(self.gi(&group))?;
            }
        }
        for (address, item) in plain {
            let occurrence = item.occurrence.clone();
            let ai = self.allocate(
                Some(address),
                context.clone(),
                producer.output_json.clone(),
                item.message_json,
                item.item_json,
                Some(producer.clone()),
            );
            self.state.activations[ai].occurrence = Some(occurrence);
            self.admit(ai)?;
        }
        self.end_context(context, None)?;
        Ok(())
    }
    fn evaluate(&mut self, gi: usize) -> Result<()> {
        let g = self.state.groups[gi].clone();
        if g.decision.is_some() {
            return Ok(());
        }
        let j = self.join(&g.join).clone();
        let ids = g
            .branches
            .iter()
            .flat_map(|b| b.path_ids.iter())
            .collect::<Vec<_>>();
        let accepted = ids
            .iter()
            .filter(|id| self.membership(self.pi(id), &g.id).accepted)
            .count();
        let failures = ids
            .iter()
            .filter(|id| self.membership(self.pi(id), &g.id).failed)
            .count();
        let pending = ids
            .iter()
            .filter(|id| {
                ["pending", "live"].contains(&self.membership(self.pi(id), &g.id).phase.as_str())
            })
            .count();
        let decision = if j.mode == "quorum" {
            let limit = number::Limit::parse(j.quorum_count_json.as_ref().unwrap()).unwrap();
            if limit.compare_counter(&accepted.to_string()) != Ordering::Less {
                Some("reached")
            } else if limit.compare_counter(&(accepted + pending).to_string()) == Ordering::Less {
                Some("missed")
            } else {
                None
            }
        } else if failures > 0
            && (j.failures == "fail"
                || number::exceeds(&failures.to_string(), &j.max_failures_json))
        {
            Some("failed")
        } else if pending == 0 {
            Some(if failures == 0 { "done" } else { "incomplete" })
        } else {
            None
        };
        let Some(decision) = decision else {
            return Ok(());
        };
        let mut branches = serde_json::Map::new();
        for b in &g.branches {
            let mut outputs = vec![];
            for id in &b.path_ids {
                let p = &self.state.paths[self.pi(id)];
                let membership = self.membership(self.pi(id), &g.id);
                if decision == "reached" && !membership.accepted {
                    continue;
                }
                if let Some(output) = &membership.result_json {
                    let mut v = exact(output)?;
                    if b.fanout {
                        v.as_object_mut()
                            .ok_or_else(|| invalid("Branch output must be object"))?
                            .insert("item".into(), exact(p.item_json.as_ref().unwrap())?);
                    }
                    outputs.push(v);
                }
            }
            if b.fanout {
                branches.insert(b.name.clone(), Value::Array(outputs));
            } else if let Some(output) = outputs.into_iter().next() {
                branches.insert(b.name.clone(), output);
            }
        }
        let group = &mut self.state.groups[gi];
        group.decision = Some(decision.into());
        group.continuation = Some(Continuation030::Join);
        if decision == "failed" {
            // `fail` records the failure that triggered the threshold.
            debug_assert!(self.state.groups[gi].error.is_some());
        } else {
            group.output_json = Some(encoded(&json!({"outcome":decision,"branches":branches})));
        }
        self.exclude(gi, true)?;
        self.release(gi)
    }
    fn belongs(&self, context: &[Frame030], group: &str) -> bool {
        context.iter().any(|f|matches!(f,Frame030::Path{path_id, departed_groups} if !departed_groups.iter().any(|id| id == group) && self.state.paths[self.pi(path_id)].memberships.iter().any(|m| m.group_id == group && m.phase != "escaped" && m.phase != "withdrawn")))
    }
    fn cancel(&mut self, i: usize) -> Result<()> {
        self.invalidate_prepare(i);
        let activation_id = self.state.activations[i].id.clone();
        self.state
            .route_barriers
            .retain(|b| b.activation_id != activation_id);
        if self.state.activations[i].physical {
            if self.state.activations[i].stop_effect_id.is_none() {
                let id = self.effect(FlowEffectKind030::StopWork {
                    work: self.work_ref(i),
                    include_descendants: true,
                });
                self.state.activations[i].stop_effect_id = Some(id);
            }
            if self.state.activations[i].phase != "done" {
                self.state.activations[i].phase = "stopping".into();
            }
        } else {
            self.state.activations[i].phase = "done".into();
        }
        let id = &self.state.activations[i].id;
        for instance in &mut self.state.instances {
            instance.queue.retain(|x| x != id);
        }
        Ok(())
    }
    fn shared_stop_error(&self, group: &Group030) -> Option<FlowInputError030> {
        let mut affected = BTreeSet::new();
        for path in &self.state.paths {
            if !self.belongs(&path.context, &group.id) {
                continue;
            }
            let withdraws_pending = path.phase == "pending";
            let cancels_work = self.state.activations.iter().any(|activation| {
                (activation.physical || activation.phase != "done")
                    && self.belongs(&activation.context, &group.id)
                    && activation.context.iter().any(|frame| {
                        matches!(frame, Frame030::Path { path_id, .. } if path_id == &path.id)
                    })
            });
            if !withdraws_pending && !cancels_work {
                continue;
            }
            // A descendant group is cancelled by this same stop. Only an
            // open group outside that cancellation subtree can still need
            // the shared occurrence independently.
            for membership in &path.memberships {
                if membership.group_id != group.id
                    && matches!(membership.phase.as_str(), "pending" | "live")
                {
                    let other = &self.state.groups[self.gi(&membership.group_id)];
                    if other.decision.is_none() && !self.belongs(&other.context, &group.id) {
                        affected.insert(other.join.clone());
                    }
                }
            }
        }
        if affected.is_empty() {
            None
        } else {
            Some(FlowInputError030::UnspecifiedSharedCancellation {
                closing_join: group.join.clone(),
                affected_joins: affected.into_iter().collect(),
            })
        }
    }
    fn exclude(&mut self, gi: usize, refresh: bool) -> Result<()> {
        let g = self.state.groups[gi].clone();
        let remaining = self.join(&g.join).remaining.clone();
        if remaining == "stop" {
            if let Some(error) = self.shared_stop_error(&g) {
                return Err(error);
            }
        }
        let path_ids = self
            .state
            .paths
            .iter()
            .filter(|p| self.belongs(&p.context, &g.id))
            .map(|p| p.id.clone())
            .collect::<Vec<_>>();
        for id in path_ids {
            let pi = self.pi(&id);
            if let Some(membership) = self.state.paths[pi]
                .memberships
                .iter_mut()
                .find(|m| m.group_id == g.id)
            {
                if membership.phase == "pending" {
                    // This occurrence never started for this group. Another
                    // open group may still require the same physical path.
                    membership.phase = "withdrawn".into();
                } else if membership.phase == "live" {
                    membership.phase = "excluded".into();
                }
            }
            let needed_by_open_group = self.state.paths[pi].memberships.iter().any(|membership| {
                membership.phase == "pending"
                    && self.state.groups[self.gi(&membership.group_id)]
                        .decision
                        .is_none()
            });
            if self.state.paths[pi].phase == "pending"
                && (remaining == "stop" || !needed_by_open_group)
            {
                self.state.paths[pi].phase = "withdrawn".into();
            }
        }
        let indices = self
            .state
            .activations
            .iter()
            .enumerate()
            .filter(|(_, a)| self.belongs(&a.context, &g.id))
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if remaining == "stop" {
            for i in indices {
                self.cancel(i)?;
            }
            let nested = self
                .state
                .groups
                .iter()
                .enumerate()
                .filter(|(_, n)| self.belongs(&n.context, &g.id))
                .map(|(i, _)| i)
                .collect::<Vec<_>>();
            for n in nested {
                self.state.groups[n]
                    .decision
                    .get_or_insert("stopped".into());
                self.state.groups[n].continuation = None;
                self.state.groups[n].released = true;
            }
        } else if refresh {
            self.refresh_preparations(&[g.id])?;
        }
        Ok(())
    }
    fn refresh_preparations(&mut self, groups: &[String]) -> Result<()> {
        // The entire batch of closures is visible before any preparation is
        // replaced. A work shared by two groups is refreshed at most once.
        let indices = self
            .state
            .activations
            .iter()
            .enumerate()
            .filter(|(_, a)| {
                a.phase == "preparing" && groups.iter().any(|g| self.belongs(&a.context, g))
            })
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        for i in indices {
            // A preceding refresh may close another group and cancel this work.
            if self.state.activations[i].phase != "preparing"
                || !groups
                    .iter()
                    .any(|g| self.belongs(&self.state.activations[i].context, g))
            {
                continue;
            }
            let p = self
                .state
                .preparations
                .iter()
                .find(|p| {
                    p.reference.activation_id == self.state.activations[i].id
                        && p.status == "pending"
                })
                .cloned()
                .ok_or_else(|| invalid("Missing active preparation"))?;
            self.follow(i, self.route(&p.reference.route)?, p.producer)?;
        }
        Ok(())
    }
    fn group_busy(&self, g: &Group030) -> bool {
        self.state.activations.iter().any(|a| {
            (self.belongs(&a.context, &g.id) && (a.physical || a.phase != "done"))
                || (a.physical && a.physical_wait_groups.contains(&g.id))
        }) || self
            .state
            .groups
            .iter()
            .any(|n| !n.released && self.belongs(&n.context, &g.id))
    }
    fn release(&mut self, gi: usize) -> Result<()> {
        let g = self.state.groups[gi].clone();
        if g.decision.is_none() || g.released {
            return Ok(());
        }
        if self.join(&g.join).remaining != "finish" && self.group_busy(&g) {
            return Ok(());
        }
        self.state.groups[gi].released = true;
        match g.continuation {
            Some(Continuation030::Join) => {
                let i = self.ai(&g.activation_id)?;
                if let Some(e) = g.error {
                    self.fail(i, e)?;
                } else if let Some(output) = g.output_json {
                    let route = self.select(&g.join, "normal", g.decision.as_deref())?;
                    let producer = self.producer(i, output.clone());
                    self.state.activations[i].result = Some(WorkResultRecord030::Completed {
                        output_json: output,
                        route_key: g.decision,
                    });
                    self.follow(i, route, producer)?;
                }
            }
            Some(Continuation030::Route {
                activation_id,
                route,
                producer,
            }) => {
                let i = self.ai(&activation_id)?;
                self.follow(i, self.route(&route)?, producer)?;
            }
            None => {}
        };
        Ok(())
    }
    fn settle(&mut self) -> Result<()> {
        loop {
            let mut changed = false;
            for g in 0..self.state.groups.len() {
                let old = (
                    self.state.groups[g].decision.clone(),
                    self.state.groups[g].released,
                );
                self.evaluate(g)?;
                self.release(g)?;
                changed |= old
                    != (
                        self.state.groups[g].decision.clone(),
                        self.state.groups[g].released,
                    );
            }
            let mut pending = 0;
            while pending < self.state.route_barriers.len() {
                let ready = self.state.route_barriers[pending]
                    .groups
                    .iter()
                    .all(|id| self.state.groups[self.gi(id)].released);
                if !ready {
                    pending += 1;
                    continue;
                }
                let barrier = self.state.route_barriers.remove(pending);
                let i = self.ai(&barrier.activation_id)?;
                if let Some(group_id) = barrier.arrival_group {
                    let pi = self.pi(&barrier.path_id);
                    let gi = self.gi(&group_id);
                    let join = self.join(&self.state.groups[gi].join);
                    let accepted = exact(&barrier.producer.output_json)?
                        .get("choice")
                        .and_then(Value::as_str)
                        .is_some_and(|choice| join.accept.iter().any(|a| a == choice));
                    let membership = self.state.paths[pi]
                        .memberships
                        .iter_mut()
                        .find(|m| m.group_id == group_id)
                        .expect("group membership");
                    membership.accepted = accepted;
                    membership.producer = Some(barrier.producer.clone());
                    self.end(i, Some(barrier.producer.output_json))?;
                } else {
                    self.state.activations[i].context = barrier.parent_context;
                    self.follow(i, self.route(&barrier.route)?, barrier.producer)?;
                }
                changed = true;
            }
            for b in 0..self.state.batches.len() {
                let batch = self.state.batches[b].clone();
                if self.step(&batch.target).r#type == "join" {
                    continue;
                }
                let mut active = batch
                    .path_ids
                    .iter()
                    .filter(|id| {
                        self.state.paths[self.pi(id)].phase == "live"
                            || self.state.activations.iter().any(|a| {
                                a.physical
                                    && a.context.iter().any(
                                        |f| matches!(f,Frame030::Path {path_id, ..} if path_id==*id),
                                    )
                            })
                    })
                    .count();
                for (n, id) in batch.path_ids.iter().enumerate() {
                    let pi = self.pi(id);
                    if self.state.paths[pi].phase != "pending" {
                        continue;
                    }
                    if number::exceeds(&(active + 1).to_string(), &batch.concurrency_json) {
                        break;
                    }
                    // A pending fanout is never started after any enclosing group closes.
                    if self.state.stopping
                        || (!self.state.paths[pi].memberships.is_empty()
                            && self.state.paths[pi].memberships.iter().all(|m| {
                                self.state.groups[self.gi(&m.group_id)].decision.is_some()
                            }))
                    {
                        self.state.paths[pi].phase = "withdrawn".into();
                        changed = true;
                        continue;
                    }
                    self.state.paths[pi].phase = "live".into();
                    for membership in &mut self.state.paths[pi].memberships {
                        if membership.phase == "pending" {
                            membership.phase = "live".into();
                        }
                    }
                    active += 1;
                    changed = true;
                    let item = &batch.items[n];
                    let i = self.allocate(
                        Some(batch.target.clone()),
                        self.state.paths[pi].context.clone(),
                        batch.producer.output_json.clone(),
                        item.message_json.clone(),
                        item.item_json.clone(),
                        Some(batch.producer.clone()),
                    );
                    self.state.activations[i].occurrence = Some(item.occurrence.clone());
                    self.admit(i)?;
                    // Absorption or an immediate failure may decide the group.
                    let groups = self.state.paths[pi]
                        .memberships
                        .iter()
                        .map(|m| m.group_id.clone())
                        .collect::<Vec<_>>();
                    for group in groups {
                        self.evaluate(self.gi(&group))?;
                    }
                }
            }
            for instance in 0..self.state.instances.len() {
                if self.state.instances[instance].current.is_none()
                    && !self.state.instances[instance].queue.is_empty()
                {
                    let id = self.state.instances[instance].queue.remove(0);
                    let i = self.ai(&id)?;
                    if self.state.activations[i].phase == "queued" {
                        self.start(i)?;
                    }
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        let busy = self
            .state
            .activations
            .iter()
            .any(|a| a.physical || a.phase != "done")
            || self.state.groups.iter().any(|g| !g.released)
            || self.state.paths.iter().any(|p| p.phase == "pending");
        if self.state.entered && !busy && self.state.verdict.is_none() {
            let verdict = if self.state.stopping {
                "cancelled"
            } else if self.state.unhandled_failure {
                "failed"
            } else {
                "succeeded"
            };
            self.state.verdict = Some(verdict.into());
            self.effect(FlowEffectKind030::RunEnded {
                verdict: verdict.into(),
            });
        }
        Ok(())
    }
}
