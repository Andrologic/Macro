// SPDX-License-Identifier: Apache-2.0
//! Flow graphs, dominators and join analysis. Rust translation of
//! `src/vendor/agsdl/v0.3/graph.mjs` (port of AgSDL v0.3.0
//! tooling/agsdl/graph.py, upstream commit
//! bd9f8a5b16923476fd20ac2650bd1729ee151917, modified for Macro: slash
//! addresses, insertion-ordered collections, exact quorum comparison). Provenance
//! and license: `src/vendor/agsdl/NOTICE.md`, `src/vendor/agsdl/v0.3/LICENSE`.
//!
//! Precondition: the document has the published shape of `agsdl.schema.json`
//! (every caller checks it first). A shape the JS code would trip over is
//! refused with [`Unshaped`] instead of being guessed. Sets and maps keep the
//! JS insertion order; sorting compares UTF-16 code units like JS strings.
pub(crate) mod ordered;

use super::{
    exact::{
        values::{compare_numbers, Num},
        Object, Value,
    },
    valueschema::PointerPart,
};
use ordered::{OrderedMap, OrderedSet};
use std::{
    cell::OnceCell,
    cmp::Ordering,
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

/// A document outside the shape the graph code assumes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Unshaped {
    pub(crate) message: String,
}

pub(crate) type GraphResult<T> = Result<T, Unshaped>;

fn unshaped<T>(message: impl Into<String>) -> GraphResult<T> {
    Err(Unshaped {
        message: message.into(),
    })
}

pub(crate) fn empty_object() -> &'static Object {
    static EMPTY: OnceLock<Object> = OnceLock::new();
    EMPTY.get_or_init(Object::default)
}

pub(crate) fn object_of<'a>(value: &'a Value, what: &str) -> GraphResult<&'a Object> {
    match value {
        Value::Object(object) => Ok(object),
        _ => unshaped(format!("{what} is not an object")),
    }
}

pub(crate) fn string_of<'a>(value: &'a Value, what: &str) -> GraphResult<&'a str> {
    match value {
        Value::String(text) => Ok(text),
        _ => unshaped(format!("{what} is not a string")),
    }
}

fn member<'a>(object: &'a Object, key: &str, what: &str) -> GraphResult<&'a Value> {
    match object.get(key) {
        Some(value) => Ok(value),
        None => unshaped(format!("{what} has no {key}")),
    }
}

/// JS `<` on strings: UTF-16 code units.
pub(crate) fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `[...strings].sort()` with the default comparator.
pub(crate) fn sort_utf16(values: &mut [String]) {
    values.sort_by(|a, b| compare_utf16(a, b));
}

pub(crate) fn address(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{prefix}/{name}")
    }
}

/// `addressParts(addr)`.
pub(crate) fn address_parts(addr: &str) -> Vec<&str> {
    if addr.is_empty() {
        Vec::new()
    } else {
        addr.split('/').collect()
    }
}

/// `last(addr)`: `undefined` for the empty address.
pub(crate) fn last(addr: &str) -> Option<&str> {
    if addr.is_empty() {
        None
    } else {
        Some(addr.rsplit('/').next().unwrap_or(addr))
    }
}

/// `compare_addresses(left, right)`: by segment, shorter first.
pub(crate) fn compare_addresses(left: &str, right: &str) -> Ordering {
    let (a, b) = (address_parts(left), address_parts(right));
    for (x, y) in a.iter().zip(&b) {
        if x != y {
            return compare_utf16(x, y);
        }
    }
    a.len().cmp(&b.len())
}

pub(crate) fn sorted_addresses<'s>(values: impl IntoIterator<Item = &'s String>) -> Vec<String> {
    let mut sorted: Vec<String> = values.into_iter().cloned().collect();
    sorted.sort_by(|a, b| compare_addresses(a, b));
    sorted
}

/// `local_name(addr, prefix)`.
pub(crate) fn local_name(addr: &str, prefix: &str) -> Option<String> {
    let (parts, before) = (address_parts(addr), address_parts(prefix));
    if parts.len() > before.len() && before.iter().zip(&parts).all(|(a, b)| a == b) {
        return Some(parts[before.len()].to_owned());
    }
    parts.last().map(|part| (*part).to_owned())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum RouteKind {
    Normal,
    Error,
}

impl RouteKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            RouteKind::Normal => "normal",
            RouteKind::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum TargetKind {
    Step,
    Output,
}

/// `[kind, name, message, where, each]` of `route_items`. `fanout` is the
/// route item object when it has `each`.
#[derive(Clone)]
pub(crate) struct RouteItem<'a> {
    pub(crate) kind: TargetKind,
    pub(crate) name: &'a str,
    pub(crate) message: Option<&'a Value>,
    pub(crate) pointer: Vec<PointerPart>,
    pub(crate) fanout: Option<&'a Object>,
}

/// `[kind, key, route, pointer]` of `step_routes`.
#[derive(Clone)]
pub(crate) struct StepRoute<'a> {
    pub(crate) kind: RouteKind,
    pub(crate) key: Option<&'a str>,
    pub(crate) route: &'a Value,
    pub(crate) pointer: Vec<PointerPart>,
}

fn with(pointer: &[PointerPart], extra: impl IntoIterator<Item = PointerPart>) -> Vec<PointerPart> {
    let mut out = pointer.to_vec();
    out.extend(extra);
    out
}

pub(crate) fn key(name: &str) -> PointerPart {
    PointerPart::Key(name.to_owned())
}

/// `item.message ?? null`.
fn message_of(item: &Object) -> Option<&Value> {
    item.get("message")
        .filter(|value| !matches!(value, Value::Null))
}

/// `route_items(route, pointer)`.
pub(crate) fn route_items<'a>(
    route: &'a Value,
    pointer: &[PointerPart],
) -> GraphResult<Vec<RouteItem<'a>>> {
    let (items, listed): (Vec<&Value>, bool) = match route {
        Value::Array(items) => (items.iter().collect(), true),
        single => (vec![single], false),
    };
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        let at = if listed {
            with(pointer, [PointerPart::Index(index)])
        } else {
            pointer.to_vec()
        };
        match item {
            Value::String(name) => out.push(RouteItem {
                kind: TargetKind::Step,
                name,
                message: None,
                pointer: at,
                fanout: None,
            }),
            Value::Object(object) if object.contains_key("step") => out.push(RouteItem {
                kind: TargetKind::Step,
                name: string_of(member(object, "step", "route item")?, "route step")?,
                message: message_of(object),
                pointer: at,
                fanout: object.contains_key("each").then_some(object),
            }),
            Value::Object(object) => out.push(RouteItem {
                kind: TargetKind::Output,
                name: string_of(member(object, "output", "route item")?, "route output")?,
                message: message_of(object),
                pointer: at,
                fanout: None,
            }),
            _ => return unshaped("route item is neither a name nor an object"),
        }
    }
    Ok(out)
}

/// `route_targets(route, pointer)`: the items without their fan-out.
pub(crate) fn route_targets<'a>(
    route: &'a Value,
    pointer: &[PointerPart],
) -> GraphResult<Vec<RouteItem<'a>>> {
    route_items(route, pointer).map(|items| {
        items
            .into_iter()
            .map(|item| RouteItem {
                fanout: None,
                ..item
            })
            .collect()
    })
}

/// `object(next) && !own(next, 'step') && !own(next, 'output')`.
pub(crate) fn is_route_map(next: &Value) -> bool {
    matches!(next, Value::Object(map) if !map.contains_key("step") && !map.contains_key("output"))
}

/// `step_routes(decl, pointer)`.
pub(crate) fn step_routes<'a>(decl: &'a Object, pointer: &[PointerPart]) -> Vec<StepRoute<'a>> {
    let mut out = Vec::new();
    if let Some(next) = decl.get("next") {
        match next {
            Value::Object(map) if is_route_map(next) => {
                for (choice, route) in map.iter() {
                    out.push(StepRoute {
                        kind: RouteKind::Normal,
                        key: Some(choice),
                        route,
                        pointer: with(pointer, [key("next"), key(choice)]),
                    });
                }
            }
            _ => out.push(StepRoute {
                kind: RouteKind::Normal,
                key: None,
                route: next,
                pointer: with(pointer, [key("next")]),
            }),
        }
    }
    if let Some(route) = decl.get("onError") {
        out.push(StepRoute {
            kind: RouteKind::Error,
            key: None,
            route,
            pointer: with(pointer, [key("onError")]),
        });
    }
    out
}

pub(crate) struct Scope<'a> {
    pub(crate) steps: &'a Object,
    pub(crate) pointer: Vec<PointerPart>,
    pub(crate) prefix: String,
    pub(crate) composition: Option<String>,
    pub(crate) bindings: OrderedMap<String, Option<String>>,
    pub(crate) compose: Option<String>,
    pub(crate) parent: Option<usize>,
    pub(crate) compose_name: Option<String>,
}

pub(crate) struct Node<'a> {
    pub(crate) addr: String,
    pub(crate) decl: Option<&'a Object>,
    pub(crate) scope: usize,
    pub(crate) name: String,
    pub(crate) kind: &'a str,
    pub(crate) pointer: Vec<PointerPart>,
    pub(crate) agent: Option<String>,
}

pub(crate) struct Edge<'a> {
    pub(crate) src: String,
    pub(crate) dst: String,
    pub(crate) kind: RouteKind,
    pub(crate) key: Option<String>,
    pub(crate) message: Option<&'a Value>,
    pub(crate) pointer: Vec<PointerPart>,
    pub(crate) fanout: Option<&'a Object>,
    pub(crate) each: Option<&'a Value>,
}

impl<'a> Edge<'a> {
    fn new(
        src: String,
        dst: String,
        kind: RouteKind,
        key: Option<String>,
        message: Option<&'a Value>,
        pointer: Vec<PointerPart>,
        fanout: Option<&'a Object>,
    ) -> Self {
        // `fanout.each`: `undefined` reads as absent here, as in every caller.
        let each = fanout.and_then(|item| item.get("each"));
        Self {
            src,
            dst,
            kind,
            key,
            message,
            pointer,
            fanout,
            each,
        }
    }

    /// `JSON.stringify([edge.kind, edge.key])` as a comparable value.
    pub(crate) fn group(&self) -> (RouteKind, Option<String>) {
        (self.kind, self.key.clone())
    }
}

/// `[decl, child scope or null, parent scope]`.
pub(crate) struct Compose<'a> {
    pub(crate) decl: &'a Object,
    pub(crate) child: Option<usize>,
    pub(crate) parent: usize,
}

/// Composition name (`None` for the flow) to the steps inside join branches.
pub(crate) type InBranch = OrderedMap<Option<String>, OrderedSet<String>>;

/// Edge indices by node address.
pub(crate) type Adjacency = HashMap<String, Vec<usize>>;

pub(crate) struct Graph<'a> {
    pub(crate) document: &'a Object,
    pub(crate) in_branch: InBranch,
    pub(crate) covered: OrderedSet<String>,
    pub(crate) compositions: &'a Object,
    pub(crate) scopes: Vec<Scope<'a>>,
    pub(crate) nodes: OrderedMap<String, Node<'a>>,
    pub(crate) composes: OrderedMap<String, Compose<'a>>,
    pub(crate) edges: Vec<Edge<'a>>,
    pub(crate) root: Option<String>,
    successors: OnceCell<Adjacency>,
    predecessors: OnceCell<Adjacency>,
}

fn compositions_of(document: &Object) -> GraphResult<&Object> {
    match document.get("compositions") {
        None | Some(Value::Null) => Ok(empty_object()),
        Some(value) => object_of(value, "compositions"),
    }
}

impl<'a> Graph<'a> {
    fn new(
        document: &'a Object,
        in_branch: Option<InBranch>,
        covered: Option<OrderedSet<String>>,
    ) -> GraphResult<Self> {
        Ok(Self {
            document,
            in_branch: in_branch.unwrap_or_default(),
            covered: covered.unwrap_or_default(),
            compositions: compositions_of(document)?,
            scopes: Vec::new(),
            nodes: OrderedMap::new(),
            composes: OrderedMap::new(),
            edges: Vec::new(),
            root: None,
            successors: OnceCell::new(),
            predecessors: OnceCell::new(),
        })
    }

    fn flow(document: &'a Object) -> GraphResult<&'a Object> {
        object_of(member(document, "flow", "document")?, "flow")
    }

    fn composition(&self, name: &str) -> GraphResult<&'a Object> {
        object_of(
            member(self.compositions, name, "compositions")?,
            "composition",
        )
    }

    fn add_scope_record(&mut self, scope: Scope<'a>) -> usize {
        self.scopes.push(scope);
        self.scopes.len() - 1
    }

    fn node(
        &self,
        addr: &str,
        decl: Option<&'a Object>,
        scope: usize,
        name: &str,
    ) -> GraphResult<Node<'a>> {
        let kind: &'a str = match decl {
            None => "exit",
            Some(decl) => string_of(member(decl, "type", "step")?, "step type")?,
        };
        let pointer = match decl {
            None => Vec::new(),
            Some(_) => with(&self.scopes[scope].pointer, [key(name)]),
        };
        let mut agent = None;
        if kind == "agent" {
            let reference = member(decl.expect("agent step"), "agent", "agent step")?;
            agent = match reference {
                Value::String(name) => Some(name.clone()),
                Value::Object(reference) => {
                    let parameter = string_of(
                        member(reference, "parameter", "agent reference")?,
                        "parameter",
                    )?;
                    self.scopes[scope]
                        .bindings
                        .get(parameter)
                        .cloned()
                        .flatten()
                }
                _ => return unshaped("agent reference is neither a name nor an object"),
            };
        }
        Ok(Node {
            addr: addr.to_owned(),
            decl,
            scope,
            name: name.to_owned(),
            kind,
            pointer,
            agent,
        })
    }

    /// `Graph.for_flow(document, in_branch, covered)`.
    pub(crate) fn for_flow(
        document: &'a Object,
        in_branch: Option<InBranch>,
        covered: Option<OrderedSet<String>>,
    ) -> GraphResult<Self> {
        let mut graph = Graph::new(document, in_branch, covered)?;
        let flow = Self::flow(document)?;
        let scope = graph.add_scope_record(Scope {
            steps: object_of(member(flow, "steps", "flow")?, "steps")?,
            pointer: vec![key("flow"), key("steps")],
            prefix: String::new(),
            composition: None,
            bindings: OrderedMap::new(),
            compose: None,
            parent: None,
            compose_name: None,
        });
        graph.add_scope(scope, &[])?;
        graph.connect()?;
        let entry = string_of(member(flow, "entry", "flow")?, "entry")?;
        graph.root = graph.resolve(scope, entry)?;
        Ok(graph)
    }

    /// `Graph.flow_error_covered(document, branch_members)`.
    pub(crate) fn flow_error_covered(
        document: &'a Object,
        branch_members: &OrderedSet<String>,
    ) -> GraphResult<OrderedSet<String>> {
        let flow = Self::flow(document)?;
        let steps = object_of(member(flow, "steps", "flow")?, "steps")?;
        let entry = string_of(member(flow, "entry", "flow")?, "entry")?;
        let Some(on_error) = flow.get("onError") else {
            return Ok(OrderedSet::new());
        };
        if !steps.contains_key(entry) {
            return Ok(OrderedSet::new());
        }
        let targets: HashSet<&str> = route_targets(on_error, &[])?
            .into_iter()
            .filter(|item| item.kind == TargetKind::Step)
            .map(|item| item.name)
            .collect();
        let mut seen = OrderedSet::new();
        seen.insert(entry.to_owned());
        let mut queue = vec![entry.to_owned()];
        let mut i = 0;
        while i < queue.len() {
            let decl = object_of(member(steps, &queue[i], "steps")?, "step")?;
            for route in step_routes(decl, &[]) {
                for item in route_targets(route.route, &[])? {
                    if item.kind == TargetKind::Step
                        && steps.contains_key(item.name)
                        && seen.insert(item.name.to_owned())
                    {
                        queue.push(item.name.to_owned());
                    }
                }
            }
            i += 1;
        }
        let mut covered = OrderedSet::new();
        for name in &seen {
            let decl = object_of(member(steps, name, "steps")?, "step")?;
            if !targets.contains(name.as_str())
                && !branch_members.contains(name)
                && !decl.contains_key("onError")
            {
                covered.insert(name.clone());
            }
        }
        Ok(covered)
    }

    /// `Graph.for_scope(document, composition, covered)`.
    pub(crate) fn for_scope(
        document: &'a Object,
        composition: Option<&str>,
        covered: Option<OrderedSet<String>>,
    ) -> GraphResult<Self> {
        let mut graph = Graph::new(
            document,
            None,
            if composition.is_none() { covered } else { None },
        )?;
        let (container, pointer) = match composition {
            None => (Self::flow(document)?, vec![key("flow"), key("steps")]),
            Some(name) => (
                graph.composition(name)?,
                vec![key("compositions"), key(name), key("steps")],
            ),
        };
        let steps = object_of(member(container, "steps", "container")?, "steps")?;
        let scope = graph.add_scope_record(Scope {
            steps,
            pointer,
            prefix: String::new(),
            composition: composition.map(str::to_owned),
            bindings: OrderedMap::new(),
            compose: None,
            parent: None,
            compose_name: None,
        });
        for (name, decl) in steps.iter() {
            let node = graph.node(name, Some(object_of(decl, "step")?), scope, name)?;
            graph.nodes.set(name.to_owned(), node);
        }
        let snapshot: Vec<String> = graph.nodes.keys().cloned().collect();
        for addr in snapshot {
            let (decl, pointer) = {
                let node = graph.nodes.get(&addr).expect("snapshot node");
                (node.decl.expect("step node"), node.pointer.clone())
            };
            for route in step_routes(decl, &pointer) {
                for item in route_items(route.route, &route.pointer)? {
                    if let Some(dst) = graph.local_target(scope, item.kind, item.name)? {
                        graph.edges.push(Edge::new(
                            addr.clone(),
                            dst,
                            route.kind,
                            route.key.map(str::to_owned),
                            item.message,
                            item.pointer,
                            item.fanout,
                        ));
                    }
                }
            }
        }
        let mut covered: Vec<String> = graph.covered.iter().cloned().collect();
        sort_utf16(&mut covered);
        for name in covered {
            let on_error = member(container, "onError", "flow")?;
            for item in route_items(on_error, &[key("flow"), key("onError")])? {
                if let Some(dst) = graph.local_target(scope, item.kind, item.name)? {
                    graph.edges.push(Edge::new(
                        name.clone(),
                        dst,
                        RouteKind::Error,
                        None,
                        item.message,
                        item.pointer,
                        item.fanout,
                    ));
                }
            }
        }
        let entry = string_of(member(container, "entry", "container")?, "entry")?;
        graph.root = graph.nodes.contains_key(entry).then(|| entry.to_owned());
        Ok(graph)
    }

    fn exit_node(&mut self, scope: usize, name: &str) -> GraphResult<String> {
        let addr = format!("#exit/{name}");
        if !self.nodes.contains_key(&addr) {
            let node = self.node(&addr, None, scope, name)?;
            self.nodes.set(addr.clone(), node);
        }
        Ok(addr)
    }

    fn local_target(
        &mut self,
        scope: usize,
        kind: TargetKind,
        name: &str,
    ) -> GraphResult<Option<String>> {
        if kind == TargetKind::Step {
            return Ok(self.nodes.contains_key(name).then(|| name.to_owned()));
        }
        if self.scopes[scope].composition.is_none() {
            return Ok(None);
        }
        self.exit_node(scope, name).map(Some)
    }

    /// `Graph.for_composition(document, name, in_branch)`.
    pub(crate) fn for_composition(
        document: &'a Object,
        name: &str,
        in_branch: Option<InBranch>,
    ) -> GraphResult<Self> {
        let mut graph = Graph::new(document, in_branch, None)?;
        let composition = graph.composition(name)?;
        let scope = graph.add_scope_record(Scope {
            steps: object_of(member(composition, "steps", "composition")?, "steps")?,
            pointer: vec![key("compositions"), key(name), key("steps")],
            prefix: format!("#{name}"),
            composition: Some(name.to_owned()),
            bindings: OrderedMap::new(),
            compose: None,
            parent: None,
            compose_name: None,
        });
        graph.add_scope(scope, &[name.to_owned()])?;
        graph.connect()?;
        let entry = string_of(member(composition, "entry", "composition")?, "entry")?;
        graph.root = graph.resolve(scope, entry)?;
        Ok(graph)
    }

    fn add_scope(&mut self, scope: usize, stack: &[String]) -> GraphResult<()> {
        struct Frame<'a> {
            scope: usize,
            entries: Vec<(&'a str, &'a Value)>,
            index: usize,
            target: Option<String>,
        }
        let mut active: HashSet<String> = stack.iter().cloned().collect();
        let steps: &'a Object = self.scopes[scope].steps;
        let mut frames = vec![Frame {
            scope,
            entries: steps.iter().collect(),
            index: 0,
            target: None,
        }];
        while let Some(frame) = frames.last_mut() {
            if frame.index == frame.entries.len() {
                if let Some(target) = &frame.target {
                    active.remove(target);
                }
                frames.pop();
                continue;
            }
            let scope = frame.scope;
            let (name, decl) = frame.entries[frame.index];
            frame.index += 1;
            let decl = object_of(decl, "step")?;
            let addr = address(&self.scopes[scope].prefix, name);
            if string_of(member(decl, "type", "step")?, "step type")? != "compose" {
                let node = self.node(&addr, Some(decl), scope, name)?;
                self.nodes.set(addr, node);
                continue;
            }
            let target = string_of(member(decl, "composition", "compose step")?, "composition")?;
            let composition = match self.compositions.get(target) {
                Some(found) => Some(object_of(found, "composition")?),
                None => None,
            };
            let Some(composition) = composition.filter(|_| !active.contains(target)) else {
                self.composes.set(
                    addr,
                    Compose {
                        decl,
                        child: None,
                        parent: scope,
                    },
                );
                continue;
            };
            let mut bindings = OrderedMap::new();
            let agents = match decl.get("agents") {
                None | Some(Value::Null) => empty_object(),
                Some(value) => object_of(value, "compose agents")?,
            };
            for (parameter, value) in agents.iter() {
                let bound = match value {
                    Value::String(name) => Some(name.clone()),
                    Value::Object(reference) => {
                        let name = string_of(
                            member(reference, "parameter", "agent reference")?,
                            "parameter",
                        )?;
                        self.scopes[scope].bindings.get(name).cloned().flatten()
                    }
                    _ => return unshaped("agent binding is neither a name nor an object"),
                };
                bindings.set(parameter.to_owned(), bound);
            }
            let prefix = &self.scopes[scope].prefix;
            let compose_name = (!name.is_empty() || !prefix.is_empty())
                .then(|| name.rsplit('/').next().unwrap_or(name).to_owned());
            let child = self.add_scope_record(Scope {
                steps: object_of(member(composition, "steps", "composition")?, "steps")?,
                pointer: vec![key("compositions"), key(target), key("steps")],
                prefix: addr.clone(),
                composition: Some(target.to_owned()),
                bindings,
                compose: Some(addr.clone()),
                parent: Some(scope),
                compose_name,
            });
            self.composes.set(
                addr,
                Compose {
                    decl,
                    child: Some(child),
                    parent: scope,
                },
            );
            active.insert(target.to_owned());
            let child_steps: &'a Object = self.scopes[child].steps;
            frames.push(Frame {
                scope: child,
                entries: child_steps.iter().collect(),
                index: 0,
                target: Some(target.to_owned()),
            });
        }
        Ok(())
    }

    /// `graph.resolve(scope, name)`.
    pub(crate) fn resolve(&self, scope: usize, name: &str) -> GraphResult<Option<String>> {
        let mut scope = scope;
        let mut addr = address(&self.scopes[scope].prefix, name);
        while let Some(compose) = self.composes.get(&addr) {
            let Some(child) = compose.child else {
                return Ok(None);
            };
            scope = child;
            let target = string_of(
                member(compose.decl, "composition", "compose step")?,
                "composition",
            )?;
            let entry = string_of(
                member(self.composition(target)?, "entry", "composition")?,
                "entry",
            )?;
            addr = address(&self.scopes[scope].prefix, entry);
        }
        Ok(self.nodes.contains_key(&addr).then_some(addr))
    }

    /// `graph._targets(...)`: `[addr, message, pointer, fanout]` in order.
    #[allow(clippy::type_complexity)]
    fn targets(
        &mut self,
        scope: usize,
        item: RouteItem<'a>,
    ) -> GraphResult<
        Vec<(
            String,
            Option<&'a Value>,
            Vec<PointerPart>,
            Option<&'a Object>,
        )>,
    > {
        let mut found = Vec::new();
        let mut pending = vec![(scope, item)];
        while let Some((scope, item)) = pending.pop() {
            if item.kind == TargetKind::Step {
                if let Some(addr) = self.resolve(scope, item.name)? {
                    found.push((addr, item.message, item.pointer, item.fanout));
                }
                continue;
            }
            let Some(compose) = self.scopes[scope].compose.clone() else {
                if self.scopes[scope].composition.is_none() {
                    continue;
                }
                let addr = self.exit_node(scope, item.name)?;
                found.push((addr, item.message, item.pointer, item.fanout));
                continue;
            };
            let record = self.composes.get(&compose).expect("compose scope record");
            let (decl, parent): (&'a Object, usize) = (record.decl, record.parent);
            let next = match decl.get("next") {
                None | Some(Value::Null) => empty_object(),
                Some(value) => object_of(value, "compose next")?,
            };
            let Some(route) = next.get(item.name) else {
                continue;
            };
            let segment = match &self.scopes[scope].compose_name {
                Some(name) => name.clone(),
                None => last(&compose).unwrap_or_default().to_owned(),
            };
            let outer = with(
                &self.scopes[parent].pointer,
                [key(&segment), key("next"), key(item.name)],
            );
            let items = route_items(route, &outer)?;
            for item in items.into_iter().rev() {
                pending.push((parent, item));
            }
        }
        Ok(found)
    }

    /// `graph._inherited_error(scope, name)`: `[scope, route, pointer]`.
    fn inherited_error(
        &self,
        scope: usize,
        name: &str,
    ) -> GraphResult<Option<(usize, &'a Value, Vec<PointerPart>)>> {
        let mut scope = scope;
        let mut name = name.to_owned();
        while let Some(compose) = self.scopes[scope].compose.clone() {
            let composition = self.scopes[scope].composition.clone();
            if self
                .in_branch
                .get(&composition)
                .is_some_and(|members| members.contains(&name))
            {
                return Ok(None);
            }
            let record = self.composes.get(&compose).expect("compose scope record");
            let (decl, parent): (&'a Object, usize) = (record.decl, record.parent);
            let last_segment = last(&compose).unwrap_or_default().to_owned();
            if let Some(route) = decl.get("onError") {
                let pointer = with(
                    &self.scopes[parent].pointer,
                    [key(&last_segment), key("onError")],
                );
                return Ok(Some((parent, route, pointer)));
            }
            name = self.scopes[scope]
                .compose_name
                .clone()
                .unwrap_or(last_segment);
            scope = parent;
        }
        if self.scopes[scope].composition.is_none() && self.covered.contains(&name) {
            let route = member(Self::flow(self.document)?, "onError", "flow")?;
            return Ok(Some((scope, route, vec![key("flow"), key("onError")])));
        }
        Ok(None)
    }

    fn connect(&mut self) -> GraphResult<()> {
        let snapshot: Vec<String> = self.nodes.keys().cloned().collect();
        for addr in snapshot {
            let (decl, pointer, scope, name) = {
                let node = self.nodes.get(&addr).expect("snapshot node");
                let Some(decl) = node.decl else { continue };
                (decl, node.pointer.clone(), node.scope, node.name.clone())
            };
            let mut routes: Vec<(StepRoute<'a>, usize)> = step_routes(decl, &pointer)
                .into_iter()
                .map(|route| (route, scope))
                .collect();
            if !decl.contains_key("onError") {
                if let Some((inherited_scope, route, at)) = self.inherited_error(scope, &name)? {
                    routes.push((
                        StepRoute {
                            kind: RouteKind::Error,
                            key: None,
                            route,
                            pointer: at,
                        },
                        inherited_scope,
                    ));
                }
            }
            for (route, scope) in routes {
                for item in route_items(route.route, &route.pointer)? {
                    for (dst, carried, at, fanout) in self.targets(scope, item)? {
                        self.edges.push(Edge::new(
                            addr.clone(),
                            dst,
                            route.kind,
                            route.key.map(str::to_owned),
                            carried,
                            at,
                            fanout,
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    fn adjacency(&self, source: bool) -> GraphResult<Adjacency> {
        let mut result: Adjacency = self
            .nodes
            .keys()
            .map(|addr| (addr.clone(), Vec::new()))
            .collect();
        for (index, edge) in self.edges.iter().enumerate() {
            let end = if source { &edge.src } else { &edge.dst };
            match result.get_mut(end) {
                Some(list) => list.push(index),
                None => return unshaped(format!("edge end {end} is not a node")),
            }
        }
        Ok(result)
    }

    /// `graph.successors()`: outgoing edge indices in edge order.
    pub(crate) fn successors(&self) -> GraphResult<&Adjacency> {
        if self.successors.get().is_none() {
            let built = self.adjacency(true)?;
            let _ = self.successors.set(built);
        }
        Ok(self.successors.get().expect("successors"))
    }

    /// `graph.predecessors()`: incoming edge indices in edge order.
    pub(crate) fn predecessors(&self) -> GraphResult<&Adjacency> {
        if self.predecessors.get().is_none() {
            let built = self.adjacency(false)?;
            let _ = self.predecessors.set(built);
        }
        Ok(self.predecessors.get().expect("predecessors"))
    }

    fn adjacent<'g>(adjacency: &'g Adjacency, addr: &str) -> GraphResult<&'g [usize]> {
        match adjacency.get(addr) {
            Some(list) => Ok(list),
            None => unshaped(format!("{addr} is not a node")),
        }
    }

    pub(crate) fn outgoing(&self, addr: &str) -> GraphResult<&[usize]> {
        Self::adjacent(self.successors()?, addr)
    }

    pub(crate) fn incoming(&self, addr: &str) -> GraphResult<&[usize]> {
        Self::adjacent(self.predecessors()?, addr)
    }

    /// `graph.reachable(start, blocked)`.
    pub(crate) fn reachable(
        &self,
        start: &str,
        blocked: &OrderedSet<String>,
    ) -> GraphResult<OrderedSet<String>> {
        let mut seen = OrderedSet::new();
        seen.insert(start.to_owned());
        let mut queue = vec![start.to_owned()];
        let mut i = 0;
        while i < queue.len() {
            for &edge in self.outgoing(&queue[i])? {
                let dst = &self.edges[edge].dst;
                if blocked.contains(dst) || seen.contains(dst) {
                    continue;
                }
                seen.insert(dst.clone());
                queue.push(dst.clone());
            }
            i += 1;
        }
        Ok(seen)
    }

    /// `graph.reaching(target, blocked)`.
    pub(crate) fn reaching(
        &self,
        target: &str,
        blocked: &OrderedSet<String>,
    ) -> GraphResult<OrderedSet<String>> {
        let mut seen = OrderedSet::new();
        let mut queue = vec![target.to_owned()];
        let mut i = 0;
        while i < queue.len() {
            for &edge in self.incoming(&queue[i])? {
                let src = &self.edges[edge].src;
                if blocked.contains(src) || seen.contains(src) || src == target {
                    continue;
                }
                seen.insert(src.clone());
                queue.push(src.clone());
            }
            i += 1;
        }
        Ok(seen)
    }

    /// `graph.dominators()`.
    pub(crate) fn dominators(&self) -> GraphResult<OrderedMap<String, OrderedSet<String>>> {
        let mut dom = OrderedMap::new();
        let Some(root) = self.root.clone() else {
            return Ok(dom);
        };
        let reach = self.reachable(&root, &OrderedSet::new())?;
        for n in &reach {
            dom.set(n.clone(), reach.clone());
        }
        dom.set(root.clone(), [root.clone()].into_iter().collect());
        let mut changed = true;
        while changed {
            changed = false;
            for n in &reach {
                if *n == root {
                    continue;
                }
                let incoming: Vec<&String> = self
                    .incoming(n)?
                    .iter()
                    .map(|&edge| &self.edges[edge].src)
                    .filter(|src| reach.contains(*src))
                    .collect();
                let mut next = match incoming.split_first() {
                    None => OrderedSet::new(),
                    Some((first, rest)) => {
                        let mut acc: OrderedSet<String> =
                            dom.get(*first).expect("dominator set").clone();
                        for src in rest {
                            acc = acc.intersection(dom.get(*src).expect("dominator set"));
                        }
                        acc
                    }
                };
                next.insert(n.clone());
                if !next.same_set(dom.get(n).expect("dominator set")) {
                    dom.set(n.clone(), next);
                    changed = true;
                }
            }
        }
        Ok(dom)
    }

    /// `graph.immediate_dominators()`.
    pub(crate) fn immediate_dominators(&self) -> GraphResult<OrderedMap<String, String>> {
        let dom = self.dominators()?;
        let mut idom = OrderedMap::new();
        for (n, ds) in dom.iter() {
            let strict: Vec<&String> = ds.iter().filter(|d| *d != n).collect();
            if let Some((first, rest)) = strict.split_first() {
                let size = |d: &String| dom.get(d).expect("dominator set").len();
                let mut best = *first;
                for d in rest {
                    if size(d) > size(best) {
                        best = d;
                    }
                }
                idom.set(n.clone(), best.clone());
            }
        }
        Ok(idom)
    }

    pub(crate) fn node_at(&self, addr: &str) -> GraphResult<&Node<'a>> {
        match self.nodes.get(addr) {
            Some(node) => Ok(node),
            None => unshaped(format!("{addr} is not a node")),
        }
    }
}

/// `route_groups(graph, addr, succ)`: destinations by `[kind, key]`.
pub(crate) fn route_groups(
    graph: &Graph<'_>,
    addr: &str,
) -> GraphResult<OrderedMap<(RouteKind, Option<String>), Vec<String>>> {
    let mut groups: OrderedMap<(RouteKind, Option<String>), Vec<String>> = OrderedMap::new();
    for &edge in graph.outgoing(addr)? {
        let edge = &graph.edges[edge];
        match groups.get_mut(&edge.group()) {
            Some(list) => list.push(edge.dst.clone()),
            None => groups.set(edge.group(), vec![edge.dst.clone()]),
        }
    }
    Ok(groups)
}

/// `analyse_joins` information for one join.
#[derive(Clone, Debug)]
pub(crate) struct JoinInfo {
    pub(crate) origin: String,
    pub(crate) branches: OrderedMap<String, OrderedSet<String>>,
    pub(crate) names: OrderedMap<String, Option<String>>,
    pub(crate) fanout: OrderedSet<String>,
}

/// `['JOIN', pointer, addr, message]` or `[pointer, addr, message]`.
#[derive(Clone, Debug)]
pub(crate) struct GraphProblem {
    pub(crate) pointer: Vec<PointerPart>,
    pub(crate) addr: String,
    pub(crate) message: String,
}

/// `open_body_forks(graph, infos)`.
pub(crate) fn open_body_forks(
    graph: &Graph<'_>,
    infos: &OrderedMap<String, JoinInfo>,
) -> GraphResult<Vec<GraphProblem>> {
    let mut problems = Vec::new();
    let Some(root) = &graph.root else {
        return Ok(problems);
    };
    let reach = graph.reachable(root, &OrderedSet::new())?;
    for addr in sorted_addresses(&reach) {
        let node = graph.node_at(&addr)?;
        if node.decl.is_none() {
            continue;
        }
        for (group, dsts) in route_groups(graph, &addr)?.iter() {
            let targets: OrderedSet<String> = dsts.iter().cloned().collect();
            let fans = graph.outgoing(&addr)?.iter().any(|&edge| {
                let edge = &graph.edges[edge];
                edge.group() == *group && edge.each.is_some()
            });
            if targets.len() < 2 && !fans {
                continue;
            }
            if infos.values().any(|info| {
                info.origin == addr
                    && targets
                        .iter()
                        .all(|target| info.branches.contains_key(target))
            }) {
                continue;
            }
            problems.push(GraphProblem {
                pointer: node.pointer.clone(),
                addr: addr.clone(),
                message: format!(
                    "the fork at '{}' does not start the branches of one join; a composition leaves at most once",
                    node.name
                ),
            });
            break;
        }
    }
    Ok(problems)
}

/// `join_origin(graph, join, idom, succ)`.
pub(crate) fn join_origin(
    graph: &Graph<'_>,
    join: &str,
    idom: &OrderedMap<String, String>,
) -> GraphResult<String> {
    let Some(first) = idom.get(join).cloned() else {
        return unshaped(format!("join {join} has no immediate dominator"));
    };
    let mut chain = Vec::new();
    let mut current = Some(first.clone());
    while let Some(step) = current {
        current = idom.get(&step).cloned();
        chain.push(step);
    }
    let dominators: HashSet<&String> = chain.iter().collect();
    let fork = |step: &str, fanout_only: bool| -> GraphResult<bool> {
        let mut groups: OrderedMap<(RouteKind, Option<String>), Vec<usize>> = OrderedMap::new();
        for &edge in graph.outgoing(step)? {
            let group = graph.edges[edge].group();
            match groups.get_mut(&group) {
                Some(list) => list.push(edge),
                None => groups.set(group, vec![edge]),
            }
        }
        for edges in groups.values() {
            if edges.iter().any(|&edge| {
                let edge = &graph.edges[edge];
                edge.each.is_some() && (dominators.contains(&edge.dst) || edge.dst == join)
            }) {
                return Ok(true);
            }
            if !fanout_only {
                let blocked: OrderedSet<String> = [step.to_owned()].into_iter().collect();
                let mut reaching = OrderedSet::new();
                for &edge in edges {
                    let dst = &graph.edges[edge].dst;
                    if dst == join || graph.reachable(dst, &blocked)?.contains(join) {
                        reaching.insert(dst.clone());
                    }
                }
                if reaching.len() >= 2 {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    };
    if fork(&first, false)? {
        return Ok(first);
    }
    let mut closed = 0usize;
    for step in &chain {
        if graph.node_at(step)?.kind == "join" {
            closed += 1;
        } else if fork(step, false)? {
            if closed == 0 {
                return Ok(if fork(step, true)? {
                    step.clone()
                } else {
                    first
                });
            }
            closed -= 1;
        }
    }
    Ok(first)
}

/// `analyse_joins(graph)`: join information in node order, then problems.
pub(crate) fn analyse_joins(
    graph: &Graph<'_>,
) -> GraphResult<(OrderedMap<String, JoinInfo>, Vec<GraphProblem>)> {
    let mut infos = OrderedMap::new();
    let mut problems = Vec::new();
    let Some(root) = &graph.root else {
        return Ok((infos, problems));
    };
    let idom = graph.immediate_dominators()?;
    let reach = graph.reachable(root, &OrderedSet::new())?;
    let mut origins: OrderedMap<String, String> = OrderedMap::new();
    for (addr, node) in graph.nodes.iter() {
        if node.kind == "join" && reach.contains(addr) && idom.contains_key(addr) {
            origins.set(addr.clone(), join_origin(graph, addr, &idom)?);
        }
    }
    let one = |value: &str| -> OrderedSet<String> { [value.to_owned()].into_iter().collect() };
    for (addr, origin) in origins.iter() {
        let node = graph.node_at(addr)?;
        let joins_to_j = graph.reaching(addr, &one(origin))?;
        let mut starts: Vec<String> = Vec::new();
        for dsts in route_groups(graph, origin)?.values() {
            for dst in dsts {
                if !starts.contains(dst) && (dst == addr || joins_to_j.contains(dst)) {
                    starts.push(dst.clone());
                }
            }
        }
        let mut branches: OrderedMap<String, OrderedSet<String>> = OrderedMap::new();
        for start in &starts {
            let members = if start == addr {
                OrderedSet::new()
            } else {
                let blocked: OrderedSet<String> =
                    [origin.clone(), addr.clone()].into_iter().collect();
                let mut allowed = joins_to_j.clone();
                allowed.insert(start.clone());
                graph.reachable(start, &blocked)?.intersection(&allowed)
            };
            branches.set(start.clone(), members);
        }
        let prefix = &graph.scopes[node.scope].prefix;
        let mut names: OrderedMap<String, Option<String>> = OrderedMap::new();
        for start in &starts {
            let at = if start == addr { origin } else { start };
            names.set(start.clone(), local_name(at, prefix));
        }
        let started: Vec<usize> = graph
            .outgoing(origin)?
            .iter()
            .copied()
            .filter(|&edge| branches.contains_key(&graph.edges[edge].dst))
            .collect();
        let fanout: OrderedSet<String> = started
            .iter()
            .filter(|&&edge| graph.edges[edge].each.is_some())
            .map(|&edge| graph.edges[edge].dst.clone())
            .collect();
        let name_of = |start: &str| {
            names
                .get(start)
                .cloned()
                .flatten()
                .unwrap_or_else(|| "undefined".to_owned())
        };
        let last_of = |addr: &str| last(addr).unwrap_or("undefined").to_owned();
        let groups = route_groups(graph, origin)?;
        if fanout.is_empty()
            && !groups.values().any(|dsts| {
                dsts.iter()
                    .filter(|dst| branches.contains_key(*dst))
                    .collect::<HashSet<_>>()
                    .len()
                    >= 2
            })
        {
            problems.push(GraphProblem {
                pointer: node.pointer.clone(),
                addr: addr.clone(),
                message: format!(
                    "no route of the origin '{}' starts two branches or more at once",
                    last_of(origin)
                ),
            });
        }
        for &edge in &started {
            let edge = &graph.edges[edge];
            if fanout.contains(&edge.dst) && edge.each.is_none() {
                problems.push(GraphProblem {
                    pointer: edge.pointer.clone(),
                    addr: origin.clone(),
                    message: format!(
                        "branch '{}' of join '{}' is a fan-out on another route; start it with each on every route",
                        name_of(&edge.dst),
                        last_of(addr)
                    ),
                });
            }
        }
        let listed: Vec<(&String, &OrderedSet<String>)> = branches.iter().collect();
        for i in 0..listed.len() {
            for j in 0..i {
                let shared = listed[i].1.intersection(listed[j].1);
                if !shared.is_empty() {
                    let step = sorted_addresses(&shared).remove(0);
                    problems.push(GraphProblem {
                        pointer: graph.node_at(&step)?.pointer.clone(),
                        addr: step.clone(),
                        message: format!(
                            "step '{}' belongs to two branches of join '{}'",
                            last_of(&step),
                            last_of(addr)
                        ),
                    });
                }
            }
        }
        for (start, members) in branches.iter() {
            for member in members {
                for &edge in graph.incoming(member)? {
                    let edge = &graph.edges[edge];
                    if members.contains(&edge.src) || (edge.src == *origin && member == start) {
                        continue;
                    }
                    problems.push(GraphProblem {
                        pointer: edge.pointer.clone(),
                        addr: edge.src.clone(),
                        message: format!(
                            "a route from '{}' enters branch '{}' of join '{}' from outside",
                            last_of(&edge.src),
                            name_of(start),
                            last_of(addr)
                        ),
                    });
                }
            }
        }
        let all_members: HashSet<&String> = branches
            .values()
            .flat_map(|members| members.iter())
            .collect();
        for &edge in graph.incoming(addr)? {
            let edge = &graph.edges[edge];
            if edge.kind == RouteKind::Normal
                && (edge.src == *origin || all_members.contains(&edge.src))
            {
                continue;
            }
            problems.push(GraphProblem {
                pointer: edge.pointer.clone(),
                addr: edge.src.clone(),
                message: format!(
                    "join '{}' receives a route from '{}', which is not one of its branches",
                    last_of(addr),
                    last_of(&edge.src)
                ),
            });
        }
        for (start, members) in branches.iter() {
            for member in members {
                for (group, dsts) in route_groups(graph, member)?.iter() {
                    let inside: Vec<&String> = dsts
                        .iter()
                        .filter(|dst| members.contains(*dst) || *dst == addr)
                        .collect();
                    if !inside.is_empty() && inside.len() < dsts.len() {
                        problems.push(GraphProblem {
                            pointer: graph.node_at(member)?.pointer.clone(),
                            addr: member.clone(),
                            message: format!(
                                "a route of '{}' starts targets inside and outside branch '{}' of join '{}' at once",
                                last_of(member),
                                name_of(start),
                                last_of(addr)
                            ),
                        });
                        continue;
                    }
                    let fans = graph.outgoing(member)?.iter().any(|&edge| {
                        let edge = &graph.edges[edge];
                        edge.group() == *group && edge.each.is_some() && inside.contains(&&edge.dst)
                    });
                    if inside.iter().collect::<HashSet<_>>().len() < 2 && !fans {
                        continue;
                    }
                    let mut blocked: OrderedSet<String> = members
                        .iter()
                        .filter(|k| origins.get(*k) == Some(member))
                        .cloned()
                        .collect();
                    blocked.insert(origin.clone());
                    let mut open_fork = false;
                    for dst in &inside {
                        if *dst == addr || graph.reachable(dst, &blocked)?.contains(addr) {
                            open_fork = true;
                            break;
                        }
                    }
                    if open_fork {
                        problems.push(GraphProblem {
                            pointer: graph.node_at(member)?.pointer.clone(),
                            addr: member.clone(),
                            message: format!(
                                "the fork at '{}' is not closed by its own join before join '{}'",
                                last_of(member),
                                last_of(addr)
                            ),
                        });
                    }
                }
            }
        }
        if let Some(quorum) = node.decl.and_then(|decl| decl.get("quorum")) {
            if super::schema::truthy(quorum) && fanout.is_empty() {
                let count = member(object_of(quorum, "quorum")?, "count", "quorum")?;
                let Value::Number(count) = count else {
                    return unshaped("quorum count is not a number");
                };
                if compare_numbers(Num::Token(count), Num::Host(starts.len())) == Ordering::Greater
                {
                    let mut pointer = node.pointer.clone();
                    pointer.extend([key("quorum"), key("count")]);
                    problems.push(GraphProblem {
                        pointer,
                        addr: addr.clone(),
                        message: format!(
                            "count {} exceeds the {} branches of join '{}'",
                            count.raw(),
                            starts.len(),
                            last_of(addr)
                        ),
                    });
                }
            }
        }
        infos.set(
            addr.clone(),
            JoinInfo {
                origin: origin.clone(),
                branches,
                names,
                fanout,
            },
        );
    }
    Ok((infos, problems))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::argentic_core::exact::scan::parse_v030;

    #[test]
    fn utf16_order_differs_from_utf8_for_astral_characters() {
        let mut values = vec![
            "\u{FF61}".to_owned(),
            "\u{1F600}".to_owned(),
            "a".to_owned(),
        ];
        sort_utf16(&mut values);
        assert_eq!(values, ["a", "\u{1F600}", "\u{FF61}"]);
        assert_eq!(compare_addresses("a/b", "a"), Ordering::Greater);
        assert_eq!(local_name("#exit/x", ""), Some("#exit".to_owned()));
    }

    #[test]
    fn parallel_join_has_branches_in_route_order() {
        let text = r#"{"contract":"agsdl-0.3.0","id":"j","agents":{"a":{"harness":"x"}},"flow":{"entry":"s","steps":{
            "s":{"type":"agent","agent":"a","next":["l","r"]},
            "l":{"type":"agent","agent":"a","next":"j"},
            "r":{"type":"agent","agent":"a","next":"j"},
            "j":{"type":"join"}}}}"#;
        let parsed = parse_v030(text.as_bytes()).unwrap();
        let document = parsed.tree.as_object().unwrap();
        let graph = Graph::for_scope(document, None, None).unwrap();
        let (infos, problems) = analyse_joins(&graph).unwrap();
        assert!(problems.is_empty());
        let info = infos.get("j").unwrap();
        assert_eq!(info.origin, "s");
        assert_eq!(
            info.branches.keys().cloned().collect::<Vec<_>>(),
            ["l", "r"]
        );
    }
}
