// SPDX-License-Identifier: Apache-2.0
//! Static validation of AgSDL 0.3 documents. Rust translation of
//! `src/vendor/agsdl/v0.3/validator.mjs` (port of AgSDL v0.3.0
//! tooling/agsdl/validator.py, upstream commit
//! bd9f8a5b16923476fd20ac2650bd1729ee151917). Provenance and license:
//! `src/vendor/agsdl/NOTICE.md`, `src/vendor/agsdl/v0.3/LICENSE`.
//!
//! Diagnostics keep the JS order, deduplication, pointers and messages. The JS
//! helpers that recurse on author-controlled depth (`brings_prompt`,
//! `received_resources`, `selection_problem`) run here on explicit stacks with
//! the same visiting order, so a deep document cannot exhaust the native stack.
//! [`Internal`] stands for an exception other than `ModuleError` in the JS
//! code; none is reachable from a shape-valid document and pinned schemas.
pub(crate) mod permissions;

use super::{
    exact::{
        quote,
        scan::array_index,
        stringify,
        values::{compare_numbers, is_integer_number, Num},
        Object, Value,
    },
    graph::{
        address_parts, analyse_joins, empty_object, is_route_map, key, open_body_forks,
        ordered::{OrderedMap, OrderedSet},
        route_items, route_targets, sort_utf16, sorted_addresses, step_routes, Edge, Graph,
        InBranch, Node, RouteKind, TargetKind, Unshaped,
    },
    schema::{self, truthy, SchemaError},
    valueschema::{self, path_pointer, Descent, OutsideShape, PointerPart},
};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

pub(crate) const CONTRACT: &str = "agsdl-0.3.0";

/// The JS `ModuleError`, with its message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModuleError {
    pub(crate) message: String,
}

/// Any other JS exception, with its message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Internal {
    pub(crate) message: String,
}

impl From<SchemaError> for Internal {
    fn from(error: SchemaError) -> Self {
        Self {
            message: error.message,
        }
    }
}

impl From<Unshaped> for Internal {
    fn from(error: Unshaped) -> Self {
        Self {
            message: error.message,
        }
    }
}

impl From<OutsideShape> for Internal {
    fn from(error: OutsideShape) -> Self {
        Self {
            message: format!(
                "value schema outside the published shape at {}",
                error.pointer
            ),
        }
    }
}

/// Failure of a reader entry point: a `ModuleError` or another exception.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReadError {
    Module(ModuleError),
    Internal(Internal),
}

impl From<Internal> for ReadError {
    fn from(error: Internal) -> Self {
        ReadError::Internal(error)
    }
}

impl From<SchemaError> for ReadError {
    fn from(error: SchemaError) -> Self {
        ReadError::Internal(error.into())
    }
}

impl From<ModuleError> for ReadError {
    fn from(error: ModuleError) -> Self {
        ReadError::Module(error)
    }
}

fn internal<T>(message: impl Into<String>) -> Result<T, Internal> {
    Err(Internal {
        message: message.into(),
    })
}

/// Harness modules by name with the semantics of a JS `Map`: `set` on a known
/// name replaces the module in place, so an overwritten module is never seen.
#[derive(Default)]
pub(crate) struct ModuleMap {
    entries: OrderedMap<String, Value>,
}

impl ModuleMap {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn set(&mut self, name: String, module: Value) {
        self.entries.set(name, module);
    }

    pub(crate) fn get(&self, name: &str) -> Option<&Value> {
        self.entries.get(name)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.entries.iter()
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Diagnostic {
    pub(crate) severity: &'static str,
    pub(crate) code: &'static str,
    pub(crate) path: String,
    pub(crate) message: String,
    pub(crate) step: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReportJoin {
    pub(crate) origin: String,
    pub(crate) branches: Vec<String>,
}

type BaseKey = (&'static str, &'static str, String, String);

/// The JS `Report`.
#[derive(Default)]
pub(crate) struct Report {
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) joins: OrderedMap<String, ReportJoin>,
    seen: HashSet<(BaseKey, Vec<String>)>,
    seen_base: HashSet<BaseKey>,
}

impl Report {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// `report.add(severity, code, where, message, step)`.
    pub(crate) fn add(
        &mut self,
        severity: &'static str,
        code: &'static str,
        path: String,
        message: String,
        step: Option<Vec<String>>,
    ) {
        let base: BaseKey = (severity, code, path.clone(), message.clone());
        let full = (base.clone(), step.clone().unwrap_or_default());
        if self.seen.contains(&full) || (step.is_none() && self.seen_base.contains(&base)) {
            return;
        }
        self.seen.insert(full);
        self.seen_base.insert(base);
        self.diagnostics.push(Diagnostic {
            severity,
            code,
            path,
            message,
            step,
        });
    }

    pub(crate) fn error(&mut self, code: &'static str, parts: &[PointerPart], message: String) {
        self.add("error", code, path_pointer(parts), message, None);
    }

    fn error_step(
        &mut self,
        code: &'static str,
        parts: &[PointerPart],
        message: String,
        step: Option<Vec<String>>,
    ) {
        self.add("error", code, path_pointer(parts), message, step);
    }

    fn warning_step(
        &mut self,
        code: &'static str,
        parts: &[PointerPart],
        message: String,
        step: Option<Vec<String>>,
    ) {
        self.add("warning", code, path_pointer(parts), message, step);
    }

    pub(crate) fn error_at(&mut self, code: &'static str, path: &str, message: String) {
        self.add("error", code, path.to_owned(), message, None);
    }

    /// `report.valid`.
    pub(crate) fn valid(&self) -> bool {
        !self.diagnostics.iter().any(|item| item.severity == "error")
    }

    /// `JSON.stringify(report.as_json())`. `joins` is an ordinary JS object:
    /// array-index names first, ascending, then insertion order.
    pub(crate) fn to_json(&self) -> String {
        let mut out = format!(
            "{{\"contract\":{},\"valid\":{},\"diagnostics\":[",
            quote(CONTRACT),
            self.valid()
        );
        for (index, item) in self.diagnostics.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"severity\":{},\"code\":{},\"path\":{},\"message\":{}",
                quote(item.severity),
                quote(item.code),
                quote(&item.path),
                quote(&item.message)
            ));
            if let Some(step) = &item.step {
                out.push_str(",\"step\":");
                out.push_str(&string_array(step));
            }
            out.push('}');
        }
        out.push_str("],\"joins\":{");
        let mut names: Vec<&String> = self.joins.keys().collect();
        let (mut indexed, named): (Vec<&String>, Vec<&String>) = names
            .drain(..)
            .partition(|name| array_index(name).is_some());
        indexed.sort_by_key(|name| array_index(name));
        for (index, name) in indexed.into_iter().chain(named).enumerate() {
            if index > 0 {
                out.push(',');
            }
            let join = self.joins.get(name).expect("join name");
            out.push_str(&format!(
                "{}:{{\"origin\":{},\"branches\":{}}}",
                quote(name),
                quote(&join.origin),
                string_array(&join.branches)
            ));
        }
        out.push_str("}}");
        out
    }
}

fn string_array(values: &[String]) -> String {
    let items: Vec<String> = values.iter().map(|value| quote(value)).collect();
    format!("[{}]", items.join(","))
}

/// `check_module(module)`: the module itself, or the first problem.
pub(crate) fn check_module(module: Value) -> Result<Value, ReadError> {
    let problems = schema::module_schema()?.check(&module)?;
    if let Some((at, message)) = problems.first() {
        let at = if at.is_empty() { "/" } else { at.as_str() };
        return Err(ModuleError {
            message: format!("{at}: {message}"),
        }
        .into());
    }
    if let Some(settings) = module.as_object().and_then(|object| object.get("settings")) {
        let shape = schema::value_schema_shape()?.check(settings)?;
        let consistency = if shape.is_empty() {
            valueschema::consistency(settings, &[key("settings")]).map_err(Internal::from)?
        } else {
            Vec::new()
        };
        let first = if shape.is_empty() {
            consistency.first()
        } else {
            shape.first()
        };
        if let Some((at, message)) = first {
            return Err(ModuleError {
                message: format!("settings {at}: {message}"),
            }
            .into());
        }
    }
    Ok(module)
}

/// `validate_document(document, modules)`.
pub(crate) fn validate_document(document: &Value, modules: &ModuleMap) -> Result<Report, Internal> {
    let mut report = Report::new();
    let problems = schema::document_schema()?.check(document)?;
    if !problems.is_empty() {
        for (at, message) in problems {
            report.error_at("SHAPE", &at, message);
        }
        return Ok(report);
    }
    let Value::Object(document) = document else {
        return internal("a shape-valid document is an object");
    };
    Checker::new(document, modules, &mut report)?.run()?;
    Ok(report)
}

/// `validate_bytes(bytes, modules)`.
pub(crate) fn validate_bytes(bytes: &[u8], modules: &ModuleMap) -> Result<Report, Internal> {
    match super::exact::scan::parse_v030(bytes) {
        Err(error) => {
            let mut report = Report::new();
            report.error_at("PARSE", "", error.message());
            Ok(report)
        }
        Ok(parsed) => validate_document(&parsed.tree, modules),
    }
}

fn article(word: &str) -> String {
    let an = word.chars().next().is_some_and(|c| "aeiou".contains(c));
    format!("{}{word}", if an { "an " } else { "a " })
}

/// `repr` of a string: Python-like single quotes.
fn repr_str(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("'{escaped}'")
}

fn repr_value(value: &Value) -> String {
    match value {
        Value::String(text) => repr_str(text),
        other => stringify(other),
    }
}

fn repr_part(part: &PointerPart) -> String {
    match part {
        PointerPart::Key(name) => repr_str(name),
        PointerPart::Index(index) => index.to_string(),
        PointerPart::Number(token) => token.raw().to_owned(),
    }
}

fn is_json_media(media: &str) -> bool {
    media == "application/json" || media.ends_with("+json")
}

fn instance_label(instance: Option<&str>) -> String {
    match instance {
        Some(name) if !name.is_empty() => format!("instance '{name}'"),
        _ => "shared instance".to_owned(),
    }
}

/// `expanded(addr)`: the address parts, or `null` for local and exit nodes.
fn expanded(addr: &str) -> Option<Vec<String>> {
    let parts = address_parts(addr);
    if parts.len() < 2 || parts[0].starts_with('#') {
        None
    } else {
        Some(parts.into_iter().map(str::to_owned).collect())
    }
}

/// `scope_member(addr, prefix)`.
fn scope_member(addr: &str, prefix: &str) -> Option<String> {
    let parts = address_parts(addr);
    let scope = address_parts(prefix);
    if parts.len() > scope.len() && scope.iter().zip(&parts).all(|(a, b)| a == b) {
        Some(parts[scope.len()].to_owned())
    } else {
        None
    }
}

fn first_part(addr: &str) -> Result<String, Internal> {
    match address_parts(addr).first() {
        Some(part) => Ok((*part).to_owned()),
        None => internal("empty graph address"),
    }
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Object, Internal> {
    match value {
        Value::Object(object) => Ok(object),
        _ => internal(format!("{what} is not an object")),
    }
}

fn text<'a>(value: &'a Value, what: &str) -> Result<&'a str, Internal> {
    match value {
        Value::String(text) => Ok(text),
        _ => internal(format!("{what} is not a string")),
    }
}

fn required<'a>(object: &'a Object, key: &str) -> Result<&'a Value, Internal> {
    match object.get(key) {
        Some(value) => Ok(value),
        None => internal(format!("missing {key}")),
    }
}

/// `get(value, key, {})` for an object-valued member.
fn object_or_empty<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a Object, Internal> {
    match value {
        None => Ok(empty_object()),
        Some(value) => object(value, what),
    }
}

fn list_or_empty<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a [Value], Internal> {
    match value {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => internal(format!("{what} is not an array")),
    }
}

/// `get(value, key)` on an object value; `null` members read as absent where
/// the JS compares with `null`.
fn member<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(object)) => object.get(key),
        _ => None,
    }
}

fn is_text(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !matches!(value, Value::Null))
}

/// `equal(value, [name])` for a one-string path.
fn is_single_path(value: &Value, name: &str) -> bool {
    matches!(value, Value::Array(items) if items.len() == 1 && matches!(&items[0], Value::String(text) if text == name))
}

fn path_parts(value: &Value) -> Result<Vec<PointerPart>, Internal> {
    let Value::Array(items) = value else {
        return internal("a path is not an array");
    };
    items
        .iter()
        .map(|item| match item {
            Value::String(name) => Ok(PointerPart::Key(name.clone())),
            Value::Number(token) => Ok(PointerPart::Number(token.clone())),
            _ => internal("a path part is neither a string nor a number"),
        })
        .collect()
}

fn part_is(part: Option<&PointerPart>, name: &str) -> bool {
    matches!(part, Some(PointerPart::Key(text)) if text == name)
}

fn part_text(part: &PointerPart) -> Option<&str> {
    match part {
        PointerPart::Key(text) => Some(text),
        _ => None,
    }
}

/// `valueschema.is_index(part)`: an integer-valued number.
fn is_index(part: Option<&PointerPart>) -> bool {
    match part {
        Some(PointerPart::Index(_)) => true,
        Some(PointerPart::Number(token)) => is_integer_number(Num::Token(token)),
        _ => false,
    }
}

fn parts_are(parts: &[PointerPart], names: &[&str]) -> bool {
    parts.len() == names.len()
        && parts
            .iter()
            .zip(names)
            .all(|(part, name)| part_is(Some(part), name))
}

fn with(parts: &[PointerPart], extra: impl IntoIterator<Item = PointerPart>) -> Vec<PointerPart> {
    let mut out = parts.to_vec();
    out.extend(extra);
    out
}

/// Join information as the validator keeps it per scope: branch and fan-out
/// names instead of addresses, origin and members as local names.
#[derive(Clone)]
struct LocalJoin {
    origin: String,
    branches: OrderedMap<String, OrderedSet<String>>,
    fanout: OrderedSet<String>,
    prefix: String,
}

struct Usage {
    new: bool,
    steer: bool,
    choices: OrderedSet<String>,
    used: bool,
}

/// One pending loop of `selection_problem` over candidate producers.
struct Scan {
    candidates: Vec<usize>,
    next: usize,
    rest: Vec<PointerPart>,
    prefix: String,
}

enum SelectionStep {
    Done(Option<String>),
    Tail(usize, Vec<PointerPart>, bool),
    Scan(Scan),
}

struct Checker<'a, 'r> {
    doc: &'a Object,
    modules: &'r ModuleMap,
    report: &'r mut Report,
    agents: &'a Object,
    compositions: &'a Object,
    content: &'a Object,
    uses: HashMap<String, Usage>,
    cycle: bool,
}

impl<'a, 'r> Checker<'a, 'r> {
    fn new(
        doc: &'a Object,
        modules: &'r ModuleMap,
        report: &'r mut Report,
    ) -> Result<Self, Internal> {
        let agents = object(required(doc, "agents")?, "agents")?;
        let uses = agents
            .iter()
            .map(|(name, _)| {
                (
                    name.to_owned(),
                    Usage {
                        new: false,
                        steer: false,
                        choices: OrderedSet::new(),
                        used: false,
                    },
                )
            })
            .collect();
        Ok(Self {
            doc,
            modules,
            report,
            agents,
            compositions: object_or_empty(doc.get("compositions"), "compositions")?,
            content: object_or_empty(doc.get("content"), "content")?,
            uses,
            cycle: false,
        })
    }

    fn run(&mut self) -> Result<(), Internal> {
        let mut scopes: Vec<(&'a Object, Vec<PointerPart>, Option<&'a str>)> = Vec::new();
        if let Some(flow) = self.doc.get("flow") {
            scopes.push((object(flow, "flow")?, vec![key("flow")], None));
        }
        let compositions: &'a Object = self.compositions;
        for (name, composition) in compositions.iter() {
            scopes.push((
                object(composition, "composition")?,
                vec![key("compositions"), key(name)],
                Some(name),
            ));
        }
        self.check_compositions()?;
        for (container, at, composition) in scopes {
            self.check_scope(container, &at, composition)?;
        }
        self.check_agents()?;
        if !self.cycle {
            self.check_graphs()?;
        }
        self.check_completion_choices()?;
        self.check_harnesses()
    }

    fn check_content_uses(
        &mut self,
        uses: &'a Value,
        parts: &[PointerPart],
    ) -> Result<(), Internal> {
        let items: Vec<(PointerPart, &'a Value)> = match uses {
            Value::String(_) => return Ok(()),
            Value::Array(items) => items
                .iter()
                .enumerate()
                .map(|(index, item)| (PointerPart::Index(index), item))
                .collect(),
            Value::Object(object) => object
                .iter()
                .map(|(name, item)| (key(name), item))
                .collect(),
            Value::Null => return internal("content uses are null"),
            _ => Vec::new(),
        };
        for (part, item) in items {
            if let Some(reference) = member(Some(item), "ref") {
                let reference = text(reference, "content ref")?;
                if !self.content.contains_key(reference) {
                    self.report.error(
                        "REFERENCE",
                        &with(parts, [part, key("ref")]),
                        format!("no content named '{reference}'"),
                    );
                }
            }
        }
        Ok(())
    }

    fn check_message(&mut self, message: &'a Value, parts: &[PointerPart]) -> Result<(), Internal> {
        if let Some(prompt) = member(Some(message), "prompt") {
            self.check_content_uses(prompt, &with(parts, [key("prompt")]))?;
        }
        if let Some(resources) = member(Some(message), "resources") {
            self.check_content_uses(resources, &with(parts, [key("resources")]))?;
        }
        Ok(())
    }

    fn check_compositions(&mut self) -> Result<(), Internal> {
        let compositions: &'a Object = self.compositions;
        let mut uses: OrderedMap<String, Vec<(String, Vec<PointerPart>)>> = OrderedMap::new();
        for (name, composition) in compositions.iter() {
            let composition = object(composition, "composition")?;
            let steps = object(required(composition, "steps")?, "steps")?;
            let mut dependencies = Vec::new();
            for (step_name, step) in steps.iter() {
                let step = object(step, "step")?;
                if is_text(step.get("type"), "compose") {
                    dependencies.push((
                        text(required(step, "composition")?, "composition")?.to_owned(),
                        vec![
                            key("compositions"),
                            key(name),
                            key("steps"),
                            key(step_name),
                            key("composition"),
                        ],
                    ));
                }
            }
            uses.set(name.to_owned(), dependencies);
            let mut exported = HashSet::new();
            for (_, step) in steps.iter() {
                for route in step_routes(object(step, "step")?, &[]) {
                    for item in route_targets(route.route, &[])? {
                        if item.kind == TargetKind::Output {
                            exported.insert(item.name);
                        }
                    }
                }
            }
            for (index, output) in list_or_empty(composition.get("outputs"), "outputs")?
                .iter()
                .enumerate()
            {
                let output = text(output, "output")?;
                if !exported.contains(output) {
                    self.report.error(
                        "COMPOSITION",
                        &[
                            key("compositions"),
                            key(name),
                            key("outputs"),
                            PointerPart::Index(index),
                        ],
                        format!(
                            "no route of composition '{name}' leaves through output '{output}'"
                        ),
                    );
                }
            }
        }
        #[derive(PartialEq)]
        enum State {
            Active,
            Done,
        }
        let mut state: HashMap<String, State> = HashMap::new();
        for name in uses.keys() {
            if state.contains_key(name) {
                continue;
            }
            state.insert(name.clone(), State::Active);
            let mut stack: Vec<(String, usize)> = vec![(name.clone(), 0)];
            while let Some(frame) = stack.last_mut() {
                let dependencies = uses.get(&frame.0).expect("composition dependencies");
                if frame.1 == dependencies.len() {
                    state.insert(frame.0.clone(), State::Done);
                    stack.pop();
                    continue;
                }
                let (target, at) = &dependencies[frame.1];
                frame.1 += 1;
                if !uses.contains_key(target) {
                    continue;
                }
                match state.get(target) {
                    Some(State::Active) => {
                        self.cycle = true;
                        self.report.error(
                            "COMPOSITION",
                            at,
                            format!("composition '{target}' uses itself, directly or through other compositions"),
                        );
                    }
                    Some(State::Done) => {}
                    None => {
                        state.insert(target.clone(), State::Active);
                        stack.push((target.clone(), 0));
                    }
                }
            }
        }
        Ok(())
    }

    fn composition(&self, name: &str) -> Result<&'a Object, Internal> {
        let compositions: &'a Object = self.compositions;
        object(required(compositions, name)?, "composition")
    }

    fn check_scope(
        &mut self,
        container: &'a Object,
        at: &[PointerPart],
        composition: Option<&'a str>,
    ) -> Result<(), Internal> {
        let steps = object(required(container, "steps")?, "steps")?;
        let mut parameters: HashSet<&'a str> = HashSet::new();
        let mut outputs: HashSet<&'a str> = HashSet::new();
        if let Some(name) = composition {
            let declared = self.composition(name)?;
            for parameter in list_or_empty(declared.get("parameters"), "parameters")? {
                parameters.insert(text(parameter, "parameter")?);
            }
            for output in list_or_empty(declared.get("outputs"), "outputs")? {
                outputs.insert(text(output, "output")?);
            }
        }
        let entry = text(required(container, "entry")?, "entry")?;
        match steps.get(entry) {
            None => self.report.error(
                "REFERENCE",
                &with(at, [key("entry")]),
                format!("no step named '{entry}'"),
            ),
            Some(step) => {
                let kind = text(required(object(step, "step")?, "type")?, "type")?;
                if kind == "join" {
                    self.report.error(
                        "ROUTES",
                        &with(at, [key("entry")]),
                        format!("the entry cannot be {}", article(kind)),
                    );
                }
            }
        }
        for (name, step) in steps.iter() {
            self.check_step(
                object(step, "step")?,
                &with(at, [key("steps"), key(name)]),
                steps,
                &parameters,
                &outputs,
                composition,
            )?;
        }
        let mut roots: Vec<&'a str> = Vec::new();
        if composition.is_none() {
            if let Some(on_error) = container.get("onError") {
                self.check_route(
                    on_error,
                    &[key("flow"), key("onError")],
                    steps,
                    &HashSet::new(),
                    None,
                )?;
                roots = route_targets(on_error, &[])?
                    .into_iter()
                    .filter(|item| item.kind == TargetKind::Step)
                    .map(|item| item.name)
                    .collect();
            }
        }
        if steps.contains_key(entry) {
            self.check_reachability(entry, steps, &with(at, [key("steps")]), &roots)?;
        }
        Ok(())
    }

    fn check_agent_ref(
        &mut self,
        reference: &'a Value,
        parts: &[PointerPart],
        parameters: &HashSet<&'a str>,
        composition: Option<&str>,
    ) -> Result<(), Internal> {
        if let Value::String(name) = reference {
            if !self.agents.contains_key(name) {
                self.report
                    .error("REFERENCE", parts, format!("no agent named '{name}'"));
            }
            return Ok(());
        }
        let name = text(
            required(object(reference, "agent reference")?, "parameter")?,
            "parameter",
        )?;
        match composition {
            None => self.report.error(
                "REFERENCE",
                parts,
                "agent parameters exist only inside compositions".to_owned(),
            ),
            Some(composition) if !parameters.contains(name) => self.report.error(
                "REFERENCE",
                parts,
                format!("composition '{composition}' has no parameter '{name}'"),
            ),
            Some(_) => {}
        }
        Ok(())
    }

    fn check_step(
        &mut self,
        step: &'a Object,
        parts: &[PointerPart],
        steps: &'a Object,
        parameters: &HashSet<&'a str>,
        outputs: &HashSet<&'a str>,
        composition: Option<&'a str>,
    ) -> Result<(), Internal> {
        let kind = text(required(step, "type")?, "type")?;
        if kind == "agent" {
            let agent = required(step, "agent")?;
            self.check_agent_ref(agent, &with(parts, [key("agent")]), parameters, composition)?;
            if let Some(prompt) = step.get("prompt") {
                self.check_content_uses(prompt, &with(parts, [key("prompt")]))?;
            }
            if is_text(step.get("instance"), "new") && step.contains_key("delivery") {
                self.report.error(
                    "DELIVERY",
                    &with(parts, [key("delivery")]),
                    "a fresh instance is never working: delivery cannot be used with instance \"new\"".to_owned(),
                );
            }
            if let Value::String(name) = agent {
                if let Some(usage) = self.uses.get_mut(name.as_str()) {
                    usage.used = true;
                    usage.new |= is_text(step.get("instance"), "new");
                    usage.steer |= is_text(step.get("delivery"), "steer");
                }
            }
        } else if kind == "call" && step.contains_key("mcp") {
            let server = text(
                required(object(required(step, "mcp")?, "mcp")?, "server")?,
                "server",
            )?;
            let servers = object_or_empty(self.doc.get("mcpServers"), "mcpServers")?;
            if !servers.contains_key(server) {
                self.report.error(
                    "REFERENCE",
                    &with(parts, [key("mcp"), key("server")]),
                    format!("no MCP server named '{server}'"),
                );
            }
        } else if kind == "compose" {
            self.check_compose(step, parts, parameters, composition)?;
        }
        self.check_routes(step, kind, parts, steps, outputs, composition)
    }

    fn check_compose(
        &mut self,
        step: &'a Object,
        parts: &[PointerPart],
        parameters: &HashSet<&'a str>,
        composition: Option<&'a str>,
    ) -> Result<(), Internal> {
        let target = text(required(step, "composition")?, "composition")?;
        if !self.compositions.contains_key(target) {
            self.report.error(
                "REFERENCE",
                &with(parts, [key("composition")]),
                format!("no composition named '{target}'"),
            );
            return Ok(());
        }
        let declared = self.composition(target)?;
        let mut expected: OrderedSet<String> = OrderedSet::new();
        for parameter in list_or_empty(declared.get("parameters"), "parameters")? {
            expected.insert(text(parameter, "parameter")?.to_owned());
        }
        let given = object_or_empty(step.get("agents"), "agents")?;
        let mut missing: Vec<String> = expected
            .iter()
            .filter(|name| !given.contains_key(name))
            .cloned()
            .collect();
        sort_utf16(&mut missing);
        for name in missing {
            self.report.error(
                "COMPOSITION",
                &with(parts, [key("agents")]),
                format!("missing agent for parameter '{name}'"),
            );
        }
        let mut extra: Vec<String> = given
            .iter()
            .map(|(name, _)| name.to_owned())
            .filter(|name| !expected.contains(name))
            .collect();
        sort_utf16(&mut extra);
        for name in extra {
            self.report.error(
                "COMPOSITION",
                &with(parts, [key("agents"), key(&name)]),
                format!("composition '{target}' has no parameter '{name}'"),
            );
        }
        for (parameter, reference) in given.iter() {
            self.check_agent_ref(
                reference,
                &with(parts, [key("agents"), key(parameter)]),
                parameters,
                composition,
            )?;
        }
        let mut outputs: OrderedSet<String> = OrderedSet::new();
        for output in list_or_empty(declared.get("outputs"), "outputs")? {
            outputs.insert(text(output, "output")?.to_owned());
        }
        let next = object(required(step, "next")?, "compose next")?;
        if !same_keys(next, &outputs) {
            let mut sorted: Vec<String> = outputs.iter().cloned().collect();
            sort_utf16(&mut sorted);
            let shown: Vec<String> = sorted.iter().map(|name| repr_str(name)).collect();
            self.report.error(
                "COMPOSITION",
                &with(parts, [key("next")]),
                format!(
                    "routes must cover exactly the outputs [{}]",
                    shown.join(", ")
                ),
            );
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn check_routes(
        &mut self,
        step: &'a Object,
        kind: &str,
        parts: &[PointerPart],
        steps: &'a Object,
        outputs: &HashSet<&'a str>,
        composition: Option<&'a str>,
    ) -> Result<(), Internal> {
        let next = non_null(step.get("next"));
        let map = next.and_then(|next| match next {
            Value::Object(map) if is_route_map(next) => Some(map),
            _ => None,
        });
        let names = |expected: &[&str]| -> OrderedSet<String> {
            expected.iter().map(|name| (*name).to_owned()).collect()
        };
        let next_at = with(parts, [key("next")]);
        if kind == "call" && map.is_some() {
            if !same_keys(map.expect("map"), &names(&["passed", "failed"])) {
                self.report.error(
                    "ROUTES",
                    &next_at,
                    "a call routes with a route, or a map with exactly passed and failed"
                        .to_owned(),
                );
            }
        } else if kind == "approval" {
            if next.is_none() || matches!(next, Some(Value::Object(map)) if map.len() == 0) {
                self.report.error(
                    "ROUTES",
                    &next_at,
                    "an approval offers at least one choice".to_owned(),
                );
            }
        } else if kind == "join" && (next.is_some() || step.contains_key("quorum")) {
            if step.contains_key("quorum") {
                if map.map_or(true, |map| !same_keys(map, &names(&["reached", "missed"]))) {
                    self.report.error(
                        "ROUTES",
                        &next_at,
                        "a quorum join routes with exactly reached and missed".to_owned(),
                    );
                }
            } else if is_text(step.get("failures"), "keep") {
                if map.is_some_and(|map| !same_keys(map, &names(&["done", "incomplete"]))) {
                    self.report.error(
                        "ROUTES",
                        &next_at,
                        "a join that keeps failures routes with a route, or a map with exactly done and incomplete".to_owned(),
                    );
                }
            } else if map.is_some_and(|map| !same_keys(map, &names(&["done"]))) {
                self.report.error(
                    "ROUTES",
                    &next_at,
                    "a join without quorum routes with a route, or a map with only done".to_owned(),
                );
            }
        }
        if kind == "join" {
            if step.contains_key("quorum")
                && (step.contains_key("failures") || step.contains_key("maxFailures"))
            {
                let field = if step.contains_key("failures") {
                    "failures"
                } else {
                    "maxFailures"
                };
                self.report.error(
                    "JOIN",
                    &with(parts, [key(field)]),
                    "failures and maxFailures apply to all mode only; a quorum already keeps failed branches".to_owned(),
                );
            } else if step.contains_key("maxFailures") && !is_text(step.get("failures"), "keep") {
                self.report.error(
                    "JOIN",
                    &with(parts, [key("maxFailures")]),
                    "maxFailures requires failures: \"keep\"".to_owned(),
                );
            }
        }
        if kind == "agent" {
            if let (Some(map), Some(Value::String(agent))) = (map, step.get("agent")) {
                if let Some(usage) = self.uses.get_mut(agent.as_str()) {
                    for (choice, _) in map.iter() {
                        usage.choices.insert(choice.to_owned());
                    }
                }
            }
        }
        for route in step_routes(step, parts) {
            self.check_route(route.route, &route.pointer, steps, outputs, composition)?;
        }
        Ok(())
    }

    fn check_route(
        &mut self,
        route: &'a Value,
        at: &[PointerPart],
        steps: &'a Object,
        outputs: &HashSet<&'a str>,
        composition: Option<&'a str>,
    ) -> Result<(), Internal> {
        let (items, listed): (Vec<&Value>, bool) = match route {
            Value::Array(items) => (items.iter().collect(), true),
            single => (vec![single], false),
        };
        for (index, item) in items.into_iter().enumerate() {
            let Value::Object(item) = item else { continue };
            if item.contains_key("each") {
                continue;
            }
            let here = if listed {
                with(at, [PointerPart::Index(index)])
            } else {
                at.to_vec()
            };
            for name in ["concurrency", "max"] {
                if item.contains_key(name) {
                    self.report.error(
                        "ROUTES",
                        &with(&here, [key(name)]),
                        format!("{name} limits a fan-out; it requires each"),
                    );
                }
            }
        }
        let mut seen: HashSet<(TargetKind, &'a str)> = HashSet::new();
        for item in route_items(route, at)? {
            let target = item.name;
            if !seen.insert((item.kind, target)) {
                self.report.error(
                    "DUPLICATE",
                    &item.pointer,
                    format!("'{target}' appears twice in this route"),
                );
            }
            if item.kind == TargetKind::Step {
                match steps.get(target) {
                    None => self.report.error(
                        "REFERENCE",
                        &item.pointer,
                        format!("no step named '{target}'"),
                    ),
                    Some(found) => {
                        let kind = text(required(object(found, "step")?, "type")?, "type")?;
                        let silent = kind == "call" || kind == "join";
                        if item.message.is_some() && silent {
                            self.report.error(
                                "ROUTES",
                                &with(&item.pointer, [key("message")]),
                                format!("{} cannot receive a message", article(kind)),
                            );
                        } else if item.fanout.is_some() && silent {
                            self.report.error(
                                "ROUTES",
                                &with(&item.pointer, [key("each")]),
                                format!(
                                    "{} receives no message, so it cannot tell the elements of a fan-out apart",
                                    article(kind)
                                ),
                            );
                        }
                    }
                }
            } else {
                match composition {
                    None => self.report.error(
                        "ROUTES",
                        &item.pointer,
                        "outputs exist only inside compositions".to_owned(),
                    ),
                    Some(composition) if !outputs.contains(target) => self.report.error(
                        "REFERENCE",
                        &item.pointer,
                        format!("composition '{composition}' has no output '{target}'"),
                    ),
                    Some(_) => {}
                }
                if item.message.is_some() {
                    self.report.error(
                        "ROUTES",
                        &with(&item.pointer, [key("message")]),
                        "put the message on the compose step's route, not on the output".to_owned(),
                    );
                }
            }
            if let Some(message) = item.message {
                self.check_message(message, &with(&item.pointer, [key("message")]))?;
            }
        }
        Ok(())
    }

    fn check_reachability(
        &mut self,
        entry: &str,
        steps: &'a Object,
        parts: &[PointerPart],
        roots: &[&'a str],
    ) -> Result<(), Internal> {
        let mut seen: OrderedSet<String> = OrderedSet::new();
        seen.insert(entry.to_owned());
        for root in roots {
            if steps.contains_key(root) {
                seen.insert((*root).to_owned());
            }
        }
        let mut queue: Vec<String> = seen.iter().cloned().collect();
        let mut index = 0;
        while index < queue.len() {
            let step = object(required(steps, &queue[index])?, "step")?;
            for route in step_routes(step, &[]) {
                for item in route_targets(route.route, &[])? {
                    if item.kind == TargetKind::Step
                        && steps.contains_key(item.name)
                        && seen.insert(item.name.to_owned())
                    {
                        queue.push(item.name.to_owned());
                    }
                }
            }
            index += 1;
        }
        let origin = if roots.is_empty() {
            "the entry"
        } else {
            "the entry or the flow's onError"
        };
        for (name, _) in steps.iter() {
            if !seen.contains(name) {
                self.report.error(
                    "UNREACHABLE",
                    &with(parts, [key(name)]),
                    format!("step '{name}' cannot be reached from {origin}"),
                );
            }
        }
        Ok(())
    }

    fn check_agents(&mut self) -> Result<(), Internal> {
        let skills = object_or_empty(self.doc.get("skills"), "skills")?;
        let servers = object_or_empty(self.doc.get("mcpServers"), "mcpServers")?;
        let agents: &'a Object = self.agents;
        for (name, agent) in agents.iter() {
            let parts = vec![key("agents"), key(name)];
            let agent = object(agent, "agent")?;
            if let Some(instructions) = agent.get("instructions") {
                self.check_content_uses(instructions, &with(&parts, [key("instructions")]))?;
            }
            if let Some(resources) = agent.get("resources") {
                self.check_content_uses(resources, &with(&parts, [key("resources")]))?;
            }
            for (index, skill) in list_or_empty(agent.get("skills"), "skills")?
                .iter()
                .enumerate()
            {
                let skill = text(skill, "skill")?;
                if !skills.contains_key(skill) {
                    self.report.error(
                        "REFERENCE",
                        &with(&parts, [key("skills"), PointerPart::Index(index)]),
                        format!("no skill named '{skill}'"),
                    );
                }
            }
            for (index, server) in list_or_empty(agent.get("mcpServers"), "mcpServers")?
                .iter()
                .enumerate()
            {
                let server = text(server, "MCP server")?;
                if !servers.contains_key(server) {
                    self.report.error(
                        "REFERENCE",
                        &with(&parts, [key("mcpServers"), PointerPart::Index(index)]),
                        format!("no MCP server named '{server}'"),
                    );
                }
            }
            for (result_name, result) in object_or_empty(agent.get("results"), "results")?.iter() {
                let at = with(&parts, [key("results"), key(result_name)]);
                if result_name == "text" {
                    self.report.error(
                        "RESULT_NAME",
                        &at,
                        "a result cannot be named 'text'".to_owned(),
                    );
                }
                let result = object(result, "result")?;
                let media = match result.get("mediaType") {
                    None => "application/json",
                    Some(media) => text(media, "mediaType")?,
                };
                if let Some(schema) = result.get("schema") {
                    if !is_json_media(media) {
                        self.report.error(
                            "SCHEMA",
                            &with(&at, [key("schema")]),
                            format!("a schema needs a JSON media type, not {media}"),
                        );
                    }
                    for (pointer, message) in
                        valueschema::consistency(schema, &with(&at, [key("schema")]))?
                    {
                        self.report.error_at("SCHEMA", &pointer, message);
                    }
                }
            }
            let permissions = agent.get("permissions");
            if let Some(Value::Object(object_permissions)) = permissions {
                if is_text(object_permissions.get("preset"), "read-only") {
                    for (path, access) in
                        object_or_empty(object_permissions.get("directories"), "directories")?
                            .iter()
                    {
                        if matches!(access, Value::String(access) if access == "write") {
                            self.report.error(
                                "PERMISSIONS",
                                &with(&parts, [key("permissions"), key("directories"), key(path)]),
                                "read-only never writes; this directory asks for write".to_owned(),
                            );
                        }
                    }
                }
            }
            if let Some(check) = non_null(agent.get("completionCheck")) {
                let command = text(
                    required(object(check, "completionCheck")?, "command")?,
                    "command",
                )?;
                if permissions::effect_for(permissions, "shell", command)? == "deny" {
                    self.report.error(
                        "PERMISSIONS",
                        &with(&parts, [key("completionCheck"), key("command")]),
                        "the agent's own permissions deny this command".to_owned(),
                    );
                }
            }
        }
        Ok(())
    }

    fn check_completion_choices(&mut self) -> Result<(), Internal> {
        let agents: &'a Object = self.agents;
        for (name, agent) in agents.iter() {
            let Some(check) = non_null(object(agent, "agent")?.get("completionCheck")) else {
                continue;
            };
            let usage = self.uses.get(name).expect("agent usage");
            if !usage.used {
                continue;
            }
            let mut missing = Vec::new();
            for (index, choice) in
                list_or_empty(object(check, "completionCheck")?.get("choices"), "choices")?
                    .iter()
                    .enumerate()
            {
                let choice = text(choice, "choice")?;
                if !usage.choices.contains(choice) {
                    missing.push((index, choice));
                }
            }
            for (index, choice) in missing {
                self.report.error(
                    "REFERENCE",
                    &[
                        key("agents"),
                        key(name),
                        key("completionCheck"),
                        key("choices"),
                        PointerPart::Index(index),
                    ],
                    format!("no step using agent '{name}' routes by choice '{choice}'"),
                );
            }
        }
        Ok(())
    }

    fn check_graphs(&mut self) -> Result<(), Internal> {
        let doc: &'a Object = self.doc;
        let compositions: &'a Object = self.compositions;
        let mut scopes: Vec<(Option<String>, Graph<'a>)> = Vec::new();
        let mut covered: OrderedSet<String> = OrderedSet::new();
        if let Some(flow) = doc.get("flow") {
            let flow = object(flow, "flow")?;
            let steps = object(required(flow, "steps")?, "steps")?;
            if steps.contains_key(text(required(flow, "entry")?, "entry")?) {
                let (infos, _) = analyse_joins(&Graph::for_scope(doc, None, None)?)?;
                let mut members = OrderedSet::new();
                for info in infos.values() {
                    for found in info.branches.values() {
                        for member in found {
                            members.insert(first_part(member)?);
                        }
                    }
                }
                covered = Graph::flow_error_covered(doc, &members)?;
                scopes.push((None, Graph::for_scope(doc, None, Some(covered.clone()))?));
            }
        }
        for (name, composition) in compositions.iter() {
            let composition = object(composition, "composition")?;
            let steps = object(required(composition, "steps")?, "steps")?;
            if steps.contains_key(text(required(composition, "entry")?, "entry")?) {
                scopes.push((
                    Some(name.to_owned()),
                    Graph::for_scope(doc, Some(name), None)?,
                ));
            }
        }
        let mut joins: OrderedMap<Option<String>, OrderedMap<String, LocalJoin>> =
            OrderedMap::new();
        for (scope_key, graph) in &scopes {
            let (infos, problems) = analyse_joins(graph)?;
            for problem in problems {
                self.report.error("JOIN", &problem.pointer, problem.message);
            }
            if scope_key.is_some() {
                for problem in open_body_forks(graph, &infos)? {
                    self.report
                        .error("COMPOSITION", &problem.pointer, problem.message);
                }
            }
            let mut local: OrderedMap<String, LocalJoin> = OrderedMap::new();
            for (addr, info) in infos.iter() {
                let name_of = |start: &String| -> Result<String, Internal> {
                    match info.names.get(start).cloned().flatten() {
                        Some(name) => Ok(name),
                        None => internal("a join branch has no name"),
                    }
                };
                let mut branches: OrderedMap<String, OrderedSet<String>> = OrderedMap::new();
                for (start, members) in info.branches.iter() {
                    let mut locals = OrderedSet::new();
                    for member in members {
                        locals.insert(first_part(member)?);
                    }
                    branches.set(name_of(start)?, locals);
                }
                let mut fanout = OrderedSet::new();
                for start in &info.fanout {
                    fanout.insert(name_of(start)?);
                }
                let name = first_part(addr)?;
                let origin = first_part(&info.origin)?;
                if scope_key.is_none() {
                    self.report.joins.set(
                        name.clone(),
                        ReportJoin {
                            origin: origin.clone(),
                            branches: branches.keys().cloned().collect(),
                        },
                    );
                }
                local.set(
                    name,
                    LocalJoin {
                        origin,
                        branches,
                        fanout,
                        prefix: String::new(),
                    },
                );
            }
            joins.set(scope_key.clone(), local);
        }
        let mut in_branch: InBranch = OrderedMap::new();
        for (scope_key, found) in joins.iter() {
            let mut members = OrderedSet::new();
            for info in found.values() {
                for branch in info.branches.values() {
                    for member in branch {
                        members.insert(member.clone());
                    }
                }
            }
            in_branch.set(scope_key.clone(), members);
        }
        let has_flow = scopes.iter().any(|(scope_key, _)| scope_key.is_none());
        let mut graphs: Vec<Graph<'a>> = Vec::new();
        if has_flow {
            graphs.push(Graph::for_flow(
                doc,
                Some(in_branch.clone()),
                Some(covered.clone()),
            )?);
        }
        for (name, _) in compositions.iter() {
            if scopes
                .iter()
                .any(|(scope_key, _)| scope_key.as_deref() == Some(name))
            {
                graphs.push(Graph::for_composition(doc, name, Some(in_branch.clone()))?);
            }
        }
        for (index, graph) in graphs.iter().enumerate() {
            if index == 0 && has_flow {
                for use_addr in sorted_addresses(graph.composes.keys()) {
                    let compose = graph.composes.get(&use_addr).expect("compose");
                    if compose.child.is_none() {
                        continue;
                    }
                    let target = text(required(compose.decl, "composition")?, "composition")?;
                    if let Some(found) = joins.get(&Some(target.to_owned())) {
                        for (name, info) in found.iter() {
                            self.report.joins.set(
                                format!("{use_addr}/{name}"),
                                ReportJoin {
                                    origin: format!("{use_addr}/{}", info.origin),
                                    branches: info.branches.keys().cloned().collect(),
                                },
                            );
                        }
                    }
                }
            }
            let mut infos: OrderedMap<String, LocalJoin> = OrderedMap::new();
            for (addr, node) in graph.nodes.iter() {
                if node.kind != "join" {
                    continue;
                }
                let scope = &graph.scopes[node.scope];
                if let Some(info) = joins
                    .get(&scope.composition)
                    .and_then(|local| local.get(&node.name))
                {
                    let mut info = info.clone();
                    info.prefix = scope.prefix.clone();
                    infos.set(addr.clone(), info);
                }
            }
            if index == 0 && has_flow {
                self.record_uses(graph);
            }
            self.record_choices(graph);
            self.check_selections(graph, &infos)?;
            self.check_missions(graph)?;
            self.check_shared_instances(graph, &infos)?;
        }
        Ok(())
    }

    fn record_uses(&mut self, graph: &Graph<'a>) {
        for node in graph.nodes.values() {
            if node.kind != "agent" {
                continue;
            }
            let Some(agent) = &node.agent else { continue };
            if let (Some(usage), Some(decl)) = (self.uses.get_mut(agent), node.decl) {
                usage.new |= is_text(decl.get("instance"), "new");
                usage.steer |= is_text(decl.get("delivery"), "steer");
            }
        }
    }

    fn record_choices(&mut self, graph: &Graph<'a>) {
        for node in graph.nodes.values() {
            if node.kind != "agent" {
                continue;
            }
            let Some(agent) = &node.agent else { continue };
            let Some(usage) = self.uses.get_mut(agent) else {
                continue;
            };
            usage.used = true;
            if let Some(Value::Object(map)) = node.decl.and_then(|decl| decl.get("next")) {
                if !map.contains_key("step") && !map.contains_key("output") {
                    for (choice, _) in map.iter() {
                        usage.choices.insert(choice.to_owned());
                    }
                }
            }
        }
    }

    fn agent_of(&self, node: &Node<'a>) -> Option<&'a Value> {
        let agents: &'a Object = self.agents;
        node.agent.as_deref().and_then(|name| agents.get(name))
    }

    fn instructs(&self, node: &Node<'a>) -> bool {
        node.kind == "agent" && member(self.agent_of(node), "instructs").is_some_and(truthy)
    }

    /// One edge of `brings_prompt`: a result, or an approval to expand.
    fn prompt_leaf(
        &self,
        graph: &Graph<'a>,
        edge: &Edge<'a>,
        seen: &[String],
    ) -> Result<Result<Option<bool>, String>, Internal> {
        if let Some(message) = edge.message {
            return Ok(Ok(Some(member(Some(message), "prompt").is_some())));
        }
        if edge.kind == RouteKind::Error {
            return Ok(Ok(Some(false)));
        }
        let node = graph.node_at(&edge.src)?;
        if node.kind == "agent" && node.agent.is_none() {
            return Ok(Ok(None));
        }
        if self.instructs(node) {
            return Ok(Ok(Some(true)));
        }
        if node.kind == "approval" && !seen.contains(&node.addr) {
            return Ok(Err(node.addr.clone()));
        }
        Ok(Ok(Some(false)))
    }

    /// `brings_prompt(graph, edge, incoming, new Set())`, on a heap stack.
    fn brings_prompt(
        &self,
        graph: &Graph<'a>,
        edge: usize,
        incoming: &OrderedMap<String, Vec<usize>>,
    ) -> Result<Option<bool>, Internal> {
        struct Frame {
            arriving: Vec<usize>,
            next: usize,
            any_null: bool,
            all_true: bool,
        }
        let frame = |addr: String| Frame {
            arriving: incoming.get(&addr).cloned().unwrap_or_default(),
            next: 0,
            any_null: false,
            all_true: true,
        };
        let mut stack: Vec<Frame> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        match self.prompt_leaf(graph, &graph.edges[edge], &seen)? {
            Ok(result) => return Ok(result),
            Err(addr) => {
                seen.push(addr.clone());
                stack.push(frame(addr));
            }
        }
        loop {
            let top = stack.last_mut().expect("frame");
            if top.next < top.arriving.len() {
                let item = top.arriving[top.next];
                top.next += 1;
                match self.prompt_leaf(graph, &graph.edges[item], &seen)? {
                    Ok(None) => stack.last_mut().expect("frame").any_null = true,
                    Ok(Some(found)) => stack.last_mut().expect("frame").all_true &= found,
                    Err(addr) => {
                        seen.push(addr.clone());
                        stack.push(frame(addr));
                    }
                }
                continue;
            }
            let done = stack.pop().expect("frame");
            seen.pop();
            let result = if done.any_null {
                None
            } else {
                Some(!done.arriving.is_empty() && done.all_true)
            };
            match stack.last_mut() {
                None => return Ok(result),
                Some(parent) => match result {
                    None => parent.any_null = true,
                    Some(found) => parent.all_true &= found,
                },
            }
        }
    }

    fn check_missions(&mut self, graph: &Graph<'a>) -> Result<(), Internal> {
        let mut incoming: OrderedMap<String, Vec<usize>> = OrderedMap::new();
        for (index, edge) in graph.edges.iter().enumerate() {
            match incoming.get_mut(&edge.dst) {
                Some(list) => list.push(index),
                None => incoming.set(edge.dst.clone(), vec![index]),
            }
        }
        for (addr, edges) in incoming.iter() {
            let node = graph.node_at(addr)?;
            if node.kind != "agent" || node.decl.is_some_and(|decl| decl.contains_key("prompt")) {
                continue;
            }
            let mut brings = Vec::with_capacity(edges.len());
            for &edge in edges {
                brings.push(self.brings_prompt(graph, edge, &incoming)?);
            }
            if brings.contains(&None) {
                continue;
            }
            let missing: Vec<usize> = edges
                .iter()
                .zip(&brings)
                .filter(|(_, found)| **found != Some(true))
                .map(|(edge, _)| *edge)
                .collect();
            if !missing.is_empty() && missing.len() < edges.len() {
                let mut sources: Vec<String> = Vec::new();
                for &edge in &missing {
                    let name = graph.node_at(&graph.edges[edge].src)?.name.clone();
                    if !sources.contains(&name) {
                        sources.push(name);
                    }
                }
                sort_utf16(&mut sources);
                self.report.error_step(
                    "PROMPT",
                    &node.pointer,
                    format!(
                        "step '{}' receives a prompt on some routes but not from {}; give it a default prompt",
                        node.name,
                        sources.join(", ")
                    ),
                    expanded(addr),
                );
            }
        }
        Ok(())
    }

    fn check_selections(
        &mut self,
        graph: &Graph<'a>,
        infos: &OrderedMap<String, LocalJoin>,
    ) -> Result<(), Internal> {
        self.check_instruction_fanouts(graph)?;
        let mut reported: HashSet<(String, String)> = HashSet::new();
        for (index, edge) in graph.edges.iter().enumerate() {
            let target = graph.node_at(&edge.dst)?;
            if target.kind == "call" {
                let arguments = object_or_empty(
                    target.decl.and_then(|decl| decl.get("arguments")),
                    "arguments",
                )?;
                for (name, operand) in arguments.iter() {
                    let Some(path) = member(Some(operand), "path") else {
                        continue;
                    };
                    let reason =
                        self.selection_problem(graph, infos, index, path_parts(path)?, false)?;
                    let at = with(&target.pointer, [key("arguments"), key(name), key("path")]);
                    if let Some(reason) = reason {
                        let identity = (parts_identity(&at), reason.clone());
                        if reported.insert(identity) {
                            self.report.error_step(
                                "MESSAGE_PATH",
                                &at,
                                reason,
                                expanded(&edge.src),
                            );
                        }
                    }
                }
            }
            if let Some(each) = edge.each {
                let mut reason =
                    self.selection_problem(graph, infos, index, path_parts(each)?, false)?;
                if reason.is_none() {
                    reason = self.fanout_problem(graph, edge, infos)?;
                }
                if let Some(reason) = reason {
                    self.report.error_step(
                        "MESSAGE_PATH",
                        &with(&edge.pointer, [key("each")]),
                        reason,
                        expanded(&edge.src),
                    );
                }
            }
            let Some(message) = edge.message else {
                continue;
            };
            if let Some(Value::Object(prompt)) = member(Some(message), "prompt") {
                if let Some(path) = prompt.get("from") {
                    let at = with(&edge.pointer, [key("message"), key("prompt"), key("from")]);
                    let source = graph.node_at(&edge.src)?;
                    let parts = path_parts(path)?;
                    let allowed = (source.kind == "agent" && parts_are(&parts, &["instructions"]))
                        || (source.kind == "join"
                            && parts.len() == 3
                            && part_is(parts.first(), "branches")
                            && part_is(parts.get(2), "instructions"))
                        || (parts_are(&parts, &["item"])
                            && edge
                                .each
                                .is_some_and(|each| is_single_path(each, "instructions")));
                    if edge.kind == RouteKind::Error || !allowed {
                        self.report.error_step(
                            "MESSAGE_PATH",
                            &at,
                            "a prompt selects only the instructions of an agent or of a join branch, or an element of instructions in a fan-out".to_owned(),
                            expanded(&edge.src),
                        );
                    } else if let Some(reason) =
                        self.selection_problem(graph, infos, index, parts, true)?
                    {
                        self.report
                            .error_step("MESSAGE_PATH", &at, reason, expanded(&edge.src));
                    }
                }
            }
            let resources = object_or_empty(member(Some(message), "resources"), "resources")?;
            for (name, used) in resources.iter() {
                let Some(path) = member(Some(used), "from") else {
                    continue;
                };
                if let Some(reason) =
                    self.selection_problem(graph, infos, index, path_parts(path)?, true)?
                {
                    self.report.error_step(
                        "MESSAGE_PATH",
                        &with(
                            &edge.pointer,
                            [key("message"), key("resources"), key(name), key("from")],
                        ),
                        reason,
                        expanded(&edge.src),
                    );
                }
            }
        }
        Ok(())
    }

    /// `selection_problem(graph, edge, path, infos, inMessage)`. The JS
    /// recursion becomes a loop over pending producer scans; the first
    /// failing producer wraps its reason, as each JS frame does on return.
    fn selection_problem(
        &self,
        graph: &Graph<'a>,
        infos: &OrderedMap<String, LocalJoin>,
        edge: usize,
        path: Vec<PointerPart>,
        in_message: bool,
    ) -> Result<Option<String>, Internal> {
        let mut stack: Vec<Scan> = Vec::new();
        let mut call = Some((edge, path, in_message));
        let mut returned: Option<Option<String>> = None;
        loop {
            if let Some((edge, path, in_message)) = call.take() {
                match self.selection_step(graph, infos, edge, &path, in_message)? {
                    SelectionStep::Done(result) => returned = Some(result),
                    SelectionStep::Tail(edge, path, in_message) => {
                        call = Some((edge, path, in_message));
                        continue;
                    }
                    SelectionStep::Scan(scan) => {
                        stack.push(scan);
                        returned = None;
                    }
                }
            }
            let Some(top) = stack.last_mut() else {
                return Ok(returned.expect("selection result"));
            };
            if let Some(Some(reason)) = returned.take() {
                let wrapped = format!("{}{reason}", top.prefix);
                stack.pop();
                returned = Some(Some(wrapped));
                continue;
            }
            if top.next < top.candidates.len() {
                let candidate = top.candidates[top.next];
                top.next += 1;
                call = Some((candidate, top.rest.clone(), true));
            } else {
                stack.pop();
                returned = Some(None);
            }
        }
    }

    fn selection_step(
        &self,
        graph: &Graph<'a>,
        infos: &OrderedMap<String, LocalJoin>,
        index: usize,
        path: &[PointerPart],
        in_message: bool,
    ) -> Result<SelectionStep, Internal> {
        use SelectionStep::{Done, Scan as Pending, Tail};
        let say = |text: String| -> Result<SelectionStep, Internal> { Ok(Done(Some(text))) };
        let fine = || -> Result<SelectionStep, Internal> { Ok(Done(None)) };
        let Some(head) = path.first() else {
            return fine();
        };
        let edge = &graph.edges[index];
        if part_is(Some(head), "item") {
            let Some(each) = edge.each.filter(|_| in_message) else {
                return say("'item' exists only in the message of a fan-out".to_owned());
            };
            if is_single_path(each, "instructions") {
                return if path.len() == 1 {
                    fine()
                } else {
                    say("'item' is an instruction, a string".to_owned())
                };
            }
            let mut next = path_parts(each)?;
            next.push(PointerPart::Index(0));
            next.extend(path[1..].iter().cloned());
            return Ok(Tail(index, next, false));
        }
        if edge.kind == RouteKind::Error {
            return Ok(Done(error_path_problem(path)));
        }
        let node = graph.node_at(&edge.src)?;
        match node.kind {
            "agent" => {
                let Some(agent) = self.agent_of(node) else {
                    return fine();
                };
                let agent_name = node.agent.as_deref().unwrap_or_default();
                if part_is(Some(head), "instructions") {
                    if !member(Some(agent), "instructs").is_some_and(truthy) {
                        return say(format!("agent '{agent_name}' does not instruct"));
                    }
                    if edge
                        .each
                        .is_some_and(|each| is_single_path(each, "instructions"))
                    {
                        if path.len() > 1 && !is_index(path.get(1)) {
                            return say(
                                "'instructions' is a list here: select one by its index".to_owned()
                            );
                        }
                        return if path.len() <= 2 {
                            fine()
                        } else {
                            say("an instruction is a string".to_owned())
                        };
                    }
                    return if path.len() == 1 {
                        fine()
                    } else {
                        say("'instructions' is a string".to_owned())
                    };
                }
                if let Some(name @ ("text" | "choice")) = part_text(head) {
                    if path.len() > 1 {
                        return say(format!("'{name}' is a string"));
                    }
                    let next = node.decl.and_then(|decl| decl.get("next"));
                    if name == "choice" && !next.is_some_and(is_route_map) {
                        return say(format!("step '{}' does not route by choice", node.name));
                    }
                    return fine();
                }
                if !part_is(Some(head), "results") {
                    return say(format!(
                        "an agent output has text, results, choice and instructions, not {}",
                        repr_part(head)
                    ));
                }
                if path.len() == 1 {
                    return fine();
                }
                let results = object_or_empty(member(Some(agent), "results"), "results")?;
                let result = part_text(&path[1]).and_then(|name| results.get(name));
                let Some(result) = result else {
                    return say(format!(
                        "agent '{agent_name}' declares no result {}",
                        repr_part(&path[1])
                    ));
                };
                let rest = &path[2..];
                if rest.is_empty() {
                    return fine();
                }
                let media = match member(Some(result), "mediaType") {
                    None => "application/json",
                    Some(media) => text(media, "mediaType")?,
                };
                if !is_json_media(media) {
                    return say(format!(
                        "result {} is not JSON and has no fields",
                        repr_part(&path[1])
                    ));
                }
                if let Some(schema) = member(Some(result), "schema") {
                    if let Descent::Refused(reason) = valueschema::descend(schema, rest)? {
                        return say(reason);
                    }
                }
                fine()
            }
            "call" => {
                if part_is(Some(head), "outcome") {
                    return if path.len() == 1 {
                        fine()
                    } else {
                        say("'outcome' has no fields".to_owned())
                    };
                }
                if !part_is(Some(head), "data") {
                    return say("a call output has only 'outcome' and 'data'".to_owned());
                }
                let decl = node.decl.expect("call step");
                if decl.contains_key("command") && path.len() > 1 {
                    let parse = non_null(decl.get("parse"));
                    if part_is(path.get(1), "value") {
                        let Some(parse) = parse else {
                            return say(format!(
                                "step '{}' declares no parse, so its result has no value",
                                node.name
                            ));
                        };
                        if matches!(parse, Value::String(mode) if mode == "lines") && path.len() > 2
                        {
                            if !is_index(path.get(2)) {
                                return say(
                                    "'value' is a list of lines: select a line by its index"
                                        .to_owned(),
                                );
                            }
                            if path.len() > 3 {
                                return say("a line is a string".to_owned());
                            }
                        }
                        return fine();
                    }
                    let Some(field @ ("exitCode" | "output")) = part_text(&path[1]) else {
                        return say(format!(
                            "a command result has exitCode, output and, with parse, value, not {}",
                            repr_part(&path[1])
                        ));
                    };
                    if path.len() > 2 {
                        return say(format!("'{field}' has no fields"));
                    }
                }
                fine()
            }
            "approval" => {
                let Some(head @ ("choice" | "comment" | "message")) = part_text(head) else {
                    return say(format!(
                        "an approval output has choice, comment and message, not {}",
                        repr_part(head)
                    ));
                };
                if head != "message" {
                    return if path.len() > 1 {
                        say(format!("'{head}' is a string"))
                    } else {
                        fine()
                    };
                }
                if path.len() == 1 {
                    return fine();
                }
                if !matches!(
                    part_text(&path[1]),
                    Some("prompt" | "resources" | "item" | "comments")
                ) {
                    return say(format!(
                        "a message has prompt, resources, item and comments, not {}",
                        repr_part(&path[1])
                    ));
                }
                if part_is(path.get(1), "resources") && path.len() > 2 {
                    if let Some(names) = self.received_resources(graph, &node.addr, infos)? {
                        if !part_text(&path[2]).is_some_and(|name| names.contains(name)) {
                            return say(format!(
                                "approval '{}' receives no resource {}",
                                node.name,
                                repr_part(&path[2])
                            ));
                        }
                    }
                }
                fine()
            }
            "join" => {
                if !matches!(part_text(head), Some("outcome" | "branches")) {
                    return say(format!(
                        "a join output has outcome and branches, not {}",
                        repr_part(head)
                    ));
                }
                if part_is(Some(head), "outcome") && path.len() > 1 {
                    return say("'outcome' is a string".to_owned());
                }
                let info = infos.get(&node.addr);
                let (true, Some(info)) = (part_is(Some(head), "branches") && path.len() > 1, info)
                else {
                    return fine();
                };
                let branch = part_text(&path[1]).filter(|name| info.branches.contains_key(*name));
                let Some(branch) = branch else {
                    return say(format!(
                        "join '{}' has no branch {}",
                        node.name,
                        repr_part(&path[1])
                    ));
                };
                let prefix = format!("branch {}: ", repr_str(branch));
                let mut rest = &path[2..];
                if info.fanout.contains(branch) && !rest.is_empty() {
                    if !is_index(rest.first()) {
                        return say(format!(
                            "branch {} is a fan-out: select an entry by its index",
                            repr_str(branch)
                        ));
                    }
                    rest = &rest[1..];
                    if part_is(rest.first(), "item") {
                        let candidates = graph
                            .edges
                            .iter()
                            .enumerate()
                            .filter(|(_, edge)| {
                                edge.each.is_some()
                                    && scope_member(&edge.src, &info.prefix).as_deref()
                                        == Some(info.origin.as_str())
                                    && scope_member(&edge.dst, &info.prefix).as_deref()
                                        == Some(branch)
                            })
                            .map(|(index, _)| index)
                            .collect();
                        return Ok(Pending(Scan {
                            candidates,
                            next: 0,
                            rest: rest.to_vec(),
                            prefix,
                        }));
                    }
                }
                if let Some(field @ ("ended" | "by")) = rest.first().and_then(part_text) {
                    return if rest.len() > 1 {
                        say(format!("'{field}' is a string"))
                    } else {
                        fine()
                    };
                }
                if part_is(rest.first(), "error") {
                    let decl = node.decl.expect("join step");
                    if !decl.contains_key("quorum") && !is_text(decl.get("failures"), "keep") {
                        return say(
                            "only a quorum or failures: \"keep\" keeps a failed branch".to_owned()
                        );
                    }
                    return Ok(Done(error_path_problem(rest)));
                }
                if !rest.is_empty() {
                    let members = info.branches.get(branch).expect("branch members");
                    let mut candidates = Vec::new();
                    for (index, producer) in graph.edges.iter().enumerate() {
                        if producer.dst != node.addr || producer.kind != RouteKind::Normal {
                            continue;
                        }
                        let local = scope_member(&producer.src, &info.prefix);
                        let direct =
                            local.as_deref() == Some(info.origin.as_str()) && info.origin == branch;
                        if local.as_ref().is_some_and(|local| members.contains(local)) || direct {
                            candidates.push(index);
                        }
                    }
                    return Ok(Pending(Scan {
                        candidates,
                        next: 0,
                        rest: rest.to_vec(),
                        prefix,
                    }));
                }
                fine()
            }
            _ => fine(),
        }
    }

    /// `received_resources(graph, addr, infos, new Set())`, on a heap stack.
    fn received_resources(
        &self,
        graph: &Graph<'a>,
        addr: &str,
        infos: &OrderedMap<String, LocalJoin>,
    ) -> Result<Option<OrderedSet<String>>, Internal> {
        struct Frame {
            addr: String,
            edges: Vec<usize>,
            next: usize,
            names: OrderedSet<String>,
        }
        let frame = |addr: &str| Frame {
            addr: addr.to_owned(),
            edges: graph
                .edges
                .iter()
                .enumerate()
                .filter(|(_, edge)| edge.dst == addr)
                .map(|(index, _)| index)
                .collect(),
            next: 0,
            names: OrderedSet::new(),
        };
        if graph.root.as_deref() == Some(addr) {
            return Ok(None);
        }
        let mut stack = vec![frame(addr)];
        enum Step {
            Add(Vec<String>),
            Push(String),
            Null,
        }
        loop {
            let depth = stack.len();
            let next = {
                let top = stack.last_mut().expect("frame");
                if top.next == top.edges.len() {
                    None
                } else {
                    top.next += 1;
                    Some(top.edges[top.next - 1])
                }
            };
            let Some(index) = next else {
                let done = stack.pop().expect("frame");
                match stack.last_mut() {
                    None => return Ok(Some(done.names)),
                    Some(parent) => {
                        for name in &done.names {
                            parent.names.insert(name.clone());
                        }
                    }
                }
                continue;
            };
            let edge = &graph.edges[index];
            let step = if let Some(message) = edge.message {
                let resources = object_or_empty(member(Some(message), "resources"), "resources")?;
                Step::Add(resources.iter().map(|(name, _)| name.to_owned()).collect())
            } else if edge.kind == RouteKind::Error {
                Step::Add(vec!["error".to_owned()])
            } else {
                let node = graph.node_at(&edge.src)?;
                match node.kind {
                    "agent" => match self.agent_of(node) {
                        None => Step::Null,
                        Some(agent) => {
                            let mut names = vec!["text".to_owned()];
                            for (name, _) in
                                object_or_empty(member(Some(agent), "results"), "results")?.iter()
                            {
                                names.push(name.to_owned());
                            }
                            Step::Add(names)
                        }
                    },
                    "call" => Step::Add(vec!["result".to_owned()]),
                    "join" if infos.contains_key(&node.addr) => Step::Add(
                        infos
                            .get(&node.addr)
                            .expect("join")
                            .branches
                            .keys()
                            .cloned()
                            .collect(),
                    ),
                    "approval"
                        if !stack[..depth - 1]
                            .iter()
                            .any(|frame| frame.addr == node.addr) =>
                    {
                        Step::Push(node.addr.clone())
                    }
                    _ => Step::Null,
                }
            };
            match step {
                Step::Null => return Ok(None),
                Step::Add(names) => {
                    let top = stack.last_mut().expect("frame");
                    for name in names {
                        top.names.insert(name);
                    }
                }
                Step::Push(child) => {
                    if graph.root.as_deref() == Some(child.as_str()) {
                        return Ok(None);
                    }
                    stack.push(frame(&child));
                }
            }
        }
    }

    fn declared_kind(
        &self,
        graph: &Graph<'a>,
        edge: &Edge<'a>,
        path: &[PointerPart],
        infos: &OrderedMap<String, LocalJoin>,
    ) -> Result<Option<String>, Internal> {
        let kind = |name: &str| Ok(Some(name.to_owned()));
        let Some(head) = path.first() else {
            return kind("object");
        };
        if edge.kind == RouteKind::Error {
            if parts_are(path, &["error", "details"]) {
                return kind("array");
            }
            return match path.len() {
                1 => kind("object"),
                2 => kind("string"),
                _ => Ok(None),
            };
        }
        let node = graph.node_at(&edge.src)?;
        match node.kind {
            "agent" => {
                if matches!(part_text(head), Some("text" | "choice" | "instructions")) {
                    return kind("string");
                }
                if path.len() == 1 {
                    return kind("object");
                }
                let results = object_or_empty(member(self.agent_of(node), "results"), "results")?;
                let Some(result) = part_text(&path[1]).and_then(|name| results.get(name)) else {
                    return Ok(None);
                };
                let media = match member(Some(result), "mediaType") {
                    None => "application/json",
                    Some(media) => text(media, "mediaType")?,
                };
                if !is_json_media(media) {
                    return kind("string");
                }
                match member(Some(result), "schema") {
                    Some(schema) => Ok(valueschema::kind_at(schema, &path[2..])?),
                    None => Ok(None),
                }
            }
            "call" => {
                if part_is(Some(head), "outcome") {
                    return kind("string");
                }
                let decl = node.decl.expect("call step");
                if !decl.contains_key("command") {
                    return Ok(None);
                }
                if path.len() == 1 {
                    return kind("object");
                }
                if part_is(path.get(1), "value") && is_text(decl.get("parse"), "lines") {
                    return kind(if path.len() == 2 { "array" } else { "string" });
                }
                match part_text(&path[1]) {
                    Some("exitCode") => kind("integer"),
                    Some("output") => kind("string"),
                    _ => Ok(None),
                }
            }
            "approval" => {
                if !part_is(Some(head), "message") {
                    return kind("string");
                }
                if path.len() == 1 || parts_are(&path[1..], &["resources"]) {
                    return kind("object");
                }
                if parts_are(&path[1..], &["comments"]) {
                    return kind("array");
                }
                Ok(None)
            }
            "join" => {
                if part_is(Some(head), "outcome") {
                    return kind("string");
                }
                if path.len() == 1 {
                    return kind("object");
                }
                match infos.get(&node.addr) {
                    Some(info) if path.len() == 2 => {
                        let fan =
                            part_text(&path[1]).is_some_and(|name| info.fanout.contains(name));
                        kind(if fan { "array" } else { "object" })
                    }
                    _ => Ok(None),
                }
            }
            _ => Ok(None),
        }
    }

    fn fanout_problem(
        &self,
        graph: &Graph<'a>,
        edge: &Edge<'a>,
        infos: &OrderedMap<String, LocalJoin>,
    ) -> Result<Option<String>, Internal> {
        let Some(each) = edge.each else {
            return Ok(None);
        };
        if is_single_path(each, "instructions") {
            return Ok(None);
        }
        Ok(
            match self.declared_kind(graph, edge, &path_parts(each)?, infos)? {
                Some(kind) if kind != "array" => Some(format!(
                    "a fan-out reads a list, and this value is declared as {}",
                    article(&kind)
                )),
                _ => None,
            },
        )
    }

    fn check_instruction_fanouts(&mut self, graph: &Graph<'a>) -> Result<(), Internal> {
        let mut routes: OrderedMap<(String, RouteKind, Option<String>), Vec<usize>> =
            OrderedMap::new();
        for (index, edge) in graph.edges.iter().enumerate() {
            let group = (edge.src.clone(), edge.kind, edge.key.clone());
            match routes.get_mut(&group) {
                Some(list) => list.push(index),
                None => routes.set(group, vec![index]),
            }
        }
        let instructions = |edge: &Edge<'a>| {
            edge.each
                .is_some_and(|each| is_single_path(each, "instructions"))
        };
        for edges in routes.values() {
            if !edges.iter().any(|&edge| instructions(&graph.edges[edge])) {
                continue;
            }
            for &index in edges {
                let edge = &graph.edges[index];
                if instructions(edge) {
                    continue;
                }
                let target = graph.node_at(&edge.dst)?;
                let uses = match edge.message {
                    None => target.kind == "agent" || target.kind == "approval",
                    Some(message) => member(Some(message), "prompt").is_some_and(|prompt| {
                        matches!(prompt, Value::Object(prompt)
                            if prompt.len() == 1 && prompt.get("from").is_some_and(|from| is_single_path(from, "instructions")))
                    }),
                };
                if uses {
                    let source = graph.node_at(&edge.src)?;
                    self.report.error_step(
                        "MESSAGE_PATH",
                        &edge.pointer,
                        format!(
                            "this route fans out over the instructions of '{}', so they are a list; '{}' cannot receive them as one prompt",
                            source.name, target.name
                        ),
                        expanded(&edge.src),
                    );
                }
            }
        }
        Ok(())
    }

    fn instance_of(node: &Node<'a>) -> Result<Option<&'a str>, Internal> {
        match non_null(node.decl.and_then(|decl| decl.get("instance"))) {
            None => Ok(None),
            Some(instance) => Ok(Some(text(instance, "instance")?)),
        }
    }

    fn check_shared_instances(
        &mut self,
        graph: &Graph<'a>,
        infos: &OrderedMap<String, LocalJoin>,
    ) -> Result<(), Internal> {
        let sorted = sorted_addresses(graph.nodes.keys());
        for (addr, info) in infos.iter() {
            let mut seen: HashMap<(String, Option<&'a str>), (String, String)> = HashMap::new();
            let mut finishing: HashMap<(String, Option<&'a str>), String> = HashMap::new();
            for (start, members) in info.branches.iter() {
                for member_addr in &sorted {
                    if !scope_member(member_addr, &info.prefix)
                        .is_some_and(|local| members.contains(&local))
                    {
                        continue;
                    }
                    let node = graph.node_at(member_addr)?;
                    let (true, Some(agent)) = (node.kind == "agent", &node.agent) else {
                        continue;
                    };
                    let instance = Self::instance_of(node)?;
                    if instance == Some("new") {
                        continue;
                    }
                    let identity = (agent.clone(), instance);
                    finishing
                        .entry(identity.clone())
                        .or_insert_with(|| start.clone());
                    if node.decl.is_some_and(|decl| decl.contains_key("delivery")) {
                        continue;
                    }
                    match seen.get(&identity) {
                        Some(other) if other.0 != *start => {
                            let message = format!(
                                "steps '{}' and '{}' use the {} of agent '{}' in parallel branches; their work will be serialized",
                                other.1,
                                node.name,
                                instance_label(instance),
                                agent
                            );
                            self.report.warning_step(
                                "SHARED_INSTANCE_PARALLEL",
                                &node.pointer,
                                message,
                                expanded(member_addr),
                            );
                        }
                        Some(_) => {}
                        None => {
                            seen.insert(identity, (start.clone(), node.name.clone()));
                        }
                    }
                }
            }
            let join = graph.node_at(addr)?;
            if is_text(join.decl.and_then(|decl| decl.get("remaining")), "finish") {
                self.check_after_finish(graph, addr, &finishing)?;
            }
        }
        self.check_fanout_instances(graph, infos)?;
        self.check_open_fork_instances(graph, infos)
    }

    fn check_open_fork_instances(
        &mut self,
        graph: &Graph<'a>,
        infos: &OrderedMap<String, LocalJoin>,
    ) -> Result<(), Internal> {
        let origins: HashSet<String> = infos
            .values()
            .map(|info| {
                if info.prefix.is_empty() {
                    info.origin.clone()
                } else {
                    format!("{}/{}", info.prefix, info.origin)
                }
            })
            .collect();
        let mut warned: HashSet<String> = HashSet::new();
        let none = OrderedSet::new();
        for addr in sorted_addresses(graph.nodes.keys()) {
            if origins.contains(&addr) {
                continue;
            }
            let mut groups: OrderedMap<(RouteKind, Option<String>), OrderedSet<String>> =
                OrderedMap::new();
            for &edge in graph.outgoing(&addr)? {
                let edge = &graph.edges[edge];
                if edge.each.is_some() {
                    continue;
                }
                match groups.get_mut(&edge.group()) {
                    Some(targets) => {
                        targets.insert(edge.dst.clone());
                    }
                    None => groups.set(edge.group(), [edge.dst.clone()].into_iter().collect()),
                }
            }
            for targets in groups.values() {
                if targets.len() < 2 {
                    continue;
                }
                let mut users: HashMap<(String, Option<&'a str>), (String, String)> =
                    HashMap::new();
                for target in sorted_addresses(targets) {
                    for member_addr in sorted_addresses(&graph.reachable(&target, &none)?) {
                        let node = graph.node_at(&member_addr)?;
                        let (true, Some(agent)) = (node.kind == "agent", &node.agent) else {
                            continue;
                        };
                        if warned.contains(&member_addr) {
                            continue;
                        }
                        let instance = Self::instance_of(node)?;
                        if instance == Some("new")
                            || node.decl.is_some_and(|decl| decl.contains_key("delivery"))
                        {
                            continue;
                        }
                        let identity = (agent.clone(), instance);
                        match users.get(&identity) {
                            Some(other) if other.0 != target => {
                                warned.insert(member_addr.clone());
                                let message = format!(
                                    "steps '{}' and '{}' can use the {} of agent '{}' at the same time; their work will be serialized",
                                    other.1,
                                    node.name,
                                    instance_label(instance),
                                    agent
                                );
                                self.report.warning_step(
                                    "SHARED_INSTANCE_PARALLEL",
                                    &node.pointer,
                                    message,
                                    expanded(&member_addr),
                                );
                            }
                            Some(_) => {}
                            None => {
                                users.insert(identity, (target.clone(), node.name.clone()));
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn check_fanout_instances(
        &mut self,
        graph: &Graph<'a>,
        infos: &OrderedMap<String, LocalJoin>,
    ) -> Result<(), Internal> {
        let mut warned: HashSet<String> = HashSet::new();
        let mut bounded: HashSet<String> = HashSet::new();
        for edge in &graph.edges {
            if edge.each.is_none() {
                continue;
            }
            let closing: OrderedSet<String> = infos
                .iter()
                .filter(|(_, info)| {
                    scope_member(&edge.src, &info.prefix).as_deref() == Some(info.origin.as_str())
                        && scope_member(&edge.dst, &info.prefix)
                            .is_some_and(|local| info.fanout.contains(&local))
                })
                .map(|(addr, _)| addr.clone())
                .collect();
            let limit = non_null(edge.fanout.and_then(|fanout| fanout.get("max")));
            let source = graph.node_at(&edge.src)?;
            for member_addr in sorted_addresses(&graph.reachable(&edge.dst, &closing)?) {
                let node = graph.node_at(&member_addr)?;
                let visits = non_null(node.decl.and_then(|decl| decl.get("maxVisits")));
                if let Some(visits) = visits.filter(|_| !bounded.contains(&member_addr)) {
                    let below = match limit {
                        None => true,
                        Some(limit) => compare_values(visits, limit)? == Ordering::Less,
                    };
                    if below {
                        bounded.insert(member_addr.clone());
                        let reason = match limit {
                            Some(limit) => {
                                format!("below the fan-out's max of {}", stringify(limit))
                            }
                            None => "while the fan-out has no max".to_owned(),
                        };
                        self.report.warning_step(
                            "FANOUT_VISITS",
                            &with(&node.pointer, [key("maxVisits")]),
                            format!(
                                "step '{}' runs once per element of the fan-out from '{}', and its maxVisits is {reason}; bound the step that fans out instead",
                                node.name, source.name
                            ),
                            expanded(&member_addr),
                        );
                    }
                }
                let (true, Some(agent)) = (node.kind == "agent", &node.agent) else {
                    continue;
                };
                if warned.contains(&member_addr) {
                    continue;
                }
                let instance = Self::instance_of(node)?;
                if instance == Some("new")
                    || node.decl.is_some_and(|decl| decl.contains_key("delivery"))
                {
                    continue;
                }
                warned.insert(member_addr.clone());
                self.report.warning_step(
                    "SHARED_INSTANCE_PARALLEL",
                    &node.pointer,
                    format!(
                        "step '{}' uses the {} of agent '{}' in every path of the fan-out from '{}'; their work will be serialized",
                        node.name,
                        instance_label(instance),
                        agent,
                        source.name
                    ),
                    expanded(&member_addr),
                );
            }
        }
        Ok(())
    }

    fn check_after_finish(
        &mut self,
        graph: &Graph<'a>,
        join: &str,
        finishing: &HashMap<(String, Option<&'a str>), String>,
    ) -> Result<(), Internal> {
        let join_node = graph.node_at(join)?;
        for later in sorted_addresses(&graph.reachable(join, &OrderedSet::new())?) {
            if later == join {
                continue;
            }
            let node = graph.node_at(&later)?;
            let (true, Some(agent)) = (node.kind == "agent", &node.agent) else {
                continue;
            };
            let instance = Self::instance_of(node)?;
            if instance == Some("new")
                || is_text(node.decl.and_then(|decl| decl.get("delivery")), "queue")
            {
                continue;
            }
            let Some(branch) = finishing.get(&(agent.clone(), instance)) else {
                continue;
            };
            self.report.warning_step(
                "SHARED_INSTANCE_PARALLEL",
                &node.pointer,
                format!(
                    "step '{}' uses the {} of agent '{}', which branch '{}' of join '{}' may still use while it finishes; its work will wait",
                    node.name,
                    instance_label(instance),
                    agent,
                    branch,
                    join_node.name
                ),
                expanded(&later),
            );
        }
        Ok(())
    }

    fn check_harnesses(&mut self) -> Result<(), Internal> {
        let agents: &'a Object = self.agents;
        for (name, agent) in agents.iter() {
            let parts = vec![key("agents"), key(name)];
            let agent = object(agent, "agent")?;
            let harness_name = text(required(agent, "harness")?, "harness")?;
            let modules: &'r ModuleMap = self.modules;
            let Some(module) = modules.get(harness_name) else {
                self.report.add(
                    "warning",
                    "HARNESS_UNVERIFIED",
                    path_pointer(&with(&parts, [key("harness")])),
                    format!("no module for harness '{harness_name}': the agent is not verified"),
                    None,
                );
                continue;
            };
            let module = object(module, "module")?;
            let harness = text(required(module, "name")?, "module name")?;
            let usage = self.uses.get(name).expect("agent usage");
            let (usage_new, usage_steer) = (usage.new, usage.steer);
            let mut used: Vec<(String, Vec<PointerPart>)> = Vec::new();
            if object_or_empty(agent.get("resources"), "resources")?.len() > 0 {
                used.push(("resources".to_owned(), with(&parts, [key("resources")])));
            }
            let model = object_or_empty(agent.get("model"), "model")?;
            if model.contains_key("name") {
                used.push((
                    "model.name".to_owned(),
                    with(&parts, [key("model"), key("name")]),
                ));
            }
            if model.contains_key("effort") {
                used.push((
                    "model.effort".to_owned(),
                    with(&parts, [key("model"), key("effort")]),
                ));
            }
            if !list_or_empty(agent.get("skills"), "skills")?.is_empty() {
                used.push(("skills".to_owned(), with(&parts, [key("skills")])));
            }
            if !list_or_empty(agent.get("mcpServers"), "mcpServers")?.is_empty() {
                used.push(("mcpServers".to_owned(), with(&parts, [key("mcpServers")])));
            }
            if agent.get("plan").is_some_and(truthy) {
                used.push(("plan".to_owned(), with(&parts, [key("plan")])));
            }
            if let Some(plan_first) = agent.get("planFirst") {
                used.push((
                    format!("planFirst.{}", text(plan_first, "planFirst")?),
                    with(&parts, [key("planFirst")]),
                ));
            }
            let permissions = agent.get("permissions");
            if let Some(Value::Object(object_permissions)) = permissions {
                if let Some(reviewer) = object_permissions.get("reviewer") {
                    used.push((
                        format!("reviewer.{}", text(reviewer, "reviewer")?),
                        with(&parts, [key("permissions"), key("reviewer")]),
                    ));
                }
                if object_or_empty(object_permissions.get("directories"), "directories")?.len() > 0
                {
                    used.push((
                        "directories".to_owned(),
                        with(&parts, [key("permissions"), key("directories")]),
                    ));
                }
            }
            if usage_new {
                used.push(("instance.new".to_owned(), parts.clone()));
            }
            if usage_steer {
                used.push(("delivery.steer".to_owned(), parts.clone()));
            }
            for (property, at) in &used {
                self.check_property(module, harness, property, at, agent)?;
            }
            self.check_permissions(module, harness, agent, &parts)?;
            if let Some(settings_value) = agent.get("harnessSettings") {
                let at = with(&parts, [key("harnessSettings")]);
                match non_null(module.get("settings")) {
                    None => self.report.error(
                        "HARNESS_SETTINGS",
                        &at,
                        format!("module '{harness}' declares no settings"),
                    ),
                    Some(settings) => {
                        for (pointer, message) in
                            valueschema::validate(settings_value, settings, &at)?
                        {
                            self.report.error_at("HARNESS_SETTINGS", &pointer, message);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn check_property(
        &mut self,
        module: &Object,
        harness: &str,
        property: &str,
        at: &[PointerPart],
        agent: &Object,
    ) -> Result<(), Internal> {
        let properties = object_or_empty(module.get("properties"), "properties")?;
        let entry = properties.get(property);
        let support = match entry {
            None => "absent",
            Some(entry) => text(
                required(object(entry, "support entry")?, "support")?,
                "support",
            )?,
        };
        let note = match member(entry, "note") {
            Some(note) if truthy(note) => format!(" {}", text(note, "note")?),
            _ => String::new(),
        };
        let label = property.replace('.', " ");
        if support == "absent" {
            self.report.error(
                "HARNESS_UNSUPPORTED",
                at,
                format!("{harness} does not support {label}.{note}"),
            );
            return Ok(());
        }
        if support == "approximate" {
            self.report.add(
                "warning",
                "HARNESS_APPROXIMATE",
                path_pointer(at),
                format!("{harness} approximates {label}.{note}"),
                None,
            );
        }
        if let Some(versions) = member(entry, "versions") {
            self.report.add(
                "warning",
                "HARNESS_VERSION",
                path_pointer(at),
                format!(
                    "{harness} supports {label} only for versions {}.",
                    text(versions, "versions")?
                ),
                None,
            );
        }
        if property == "model.effort" {
            if let Some(values) = member(entry, "values") {
                let Value::Array(values) = values else {
                    return internal("support values are not an array");
                };
                let effort = required(object(required(agent, "model")?, "model")?, "effort")?;
                let accepted = values
                    .iter()
                    .any(|value| matches!((value, effort), (Value::String(a), Value::String(b)) if a == b));
                if !accepted {
                    let mut shown = Vec::with_capacity(values.len());
                    for value in values {
                        shown.push(text(value, "support value")?.to_owned());
                    }
                    self.report.error(
                        "HARNESS_VALUE",
                        at,
                        format!(
                            "{harness} accepts {}; got {}",
                            shown.join(", "),
                            repr_value(effort)
                        ),
                    );
                }
            }
        }
        Ok(())
    }

    fn check_permissions(
        &mut self,
        module: &Object,
        harness: &str,
        agent: &Object,
        parts: &[PointerPart],
    ) -> Result<(), Internal> {
        let at = with(parts, [key("permissions")]);
        let enforcement = object_or_empty(module.get("permissions"), "module permissions")?;
        let permissions = agent.get("permissions");
        let level_of = |action: &str, field: &str| -> Option<&Value> {
            member(enforcement.get(action), field)
        };
        let is_absent = |level: Option<&Value>| level.is_none() || is_text(level, "absent");
        let shell_open =
            !permissions::shell_denied(permissions)? && !is_absent(level_of("shell", "allow"));
        let bypass = format!(
            "shell commands bypass {harness}'s rules for it; deny shell, or use a harness that enforces it with a sandbox"
        );
        let enforced = |action: &str, level: Option<&Value>| {
            !is_absent(level)
                && !(shell_open
                    && is_text(level, "harness")
                    && matches!(action, "read" | "write" | "network"))
        };
        for (action, effects) in permissions::effects_in_use(permissions)? {
            if action == "mcp" && list_or_empty(agent.get("mcpServers"), "mcpServers")?.is_empty() {
                continue;
            }
            for effect in ["deny", "ask"] {
                if !effects.iter().any(|known| known == effect) {
                    continue;
                }
                let level = level_of(action, effect);
                if is_absent(level) {
                    self.report.error(
                        "HARNESS_UNSUPPORTED",
                        &at,
                        format!(
                            "{harness} cannot enforce {} for {}",
                            repr_str(effect),
                            repr_str(action)
                        ),
                    );
                } else if !enforced(action, level) {
                    self.report.error(
                        "HARNESS_UNSUPPORTED",
                        &at,
                        format!(
                            "{harness} cannot enforce {} for {}: {bypass}",
                            repr_str(effect),
                            repr_str(action)
                        ),
                    );
                }
            }
        }
        let (preset, rules) = permissions::normalize(permissions)?;
        if is_text(level_of("shell", "match"), "prefix") {
            for (index, rule) in rules.iter().enumerate() {
                if rule.action != "shell" || rule.effect == "allow" || permissions::covers_all(rule)
                {
                    continue;
                }
                let matcher = rule.matcher.expect("a partial rule has a match");
                if !permissions::command_prefix(matcher) {
                    self.report.error(
                        "HARNESS_UNSUPPORTED",
                        &with(&at, [key("rules"), PointerPart::Index(index), key("match")]),
                        format!("{harness} matches commands by their leading words only; write the words, then \" *\" for any arguments"),
                    );
                }
            }
        }
        if preset.is_some() && permissions::outside(permissions)? == "deny" {
            let level = level_of("read", "outside");
            if is_absent(level) {
                self.report.error(
                    "HARNESS_UNSUPPORTED",
                    &at,
                    format!("{harness} cannot deny reads outside the zone; set \"outside\": \"read\" or use another harness"),
                );
            } else if !enforced("read", level) {
                self.report.error(
                    "HARNESS_UNSUPPORTED",
                    &at,
                    format!("{harness} cannot deny reads outside the zone: {bypass}"),
                );
            }
        }
        Ok(())
    }
}

/// `sameKeys(value, expected)`.
fn same_keys(value: &Object, expected: &OrderedSet<String>) -> bool {
    value.len() == expected.len() && value.iter().all(|(name, _)| expected.contains(name))
}

/// `compareNumbers(a, b)` over two authored numbers.
fn compare_values(left: &Value, right: &Value) -> Result<Ordering, Internal> {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => Ok(compare_numbers(Num::Token(a), Num::Token(b))),
        _ => internal("Expected a finite JSON number"),
    }
}

/// `JSON.stringify(parts)` identity of a pointer path.
fn parts_identity(parts: &[PointerPart]) -> String {
    let items: Vec<String> = parts
        .iter()
        .map(|part| match part {
            PointerPart::Key(name) => quote(name),
            PointerPart::Index(index) => index.to_string(),
            PointerPart::Number(token) => token.raw().to_owned(),
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// `error_path_problem(path)`.
fn error_path_problem(path: &[PointerPart]) -> Option<String> {
    if !part_is(path.first(), "error") {
        return Some("an error route carries only 'error'".to_owned());
    }
    let field = path.get(1)?;
    match part_text(field) {
        Some(name @ ("code" | "message")) => {
            (path.len() > 2).then(|| format!("'{name}' is a string"))
        }
        Some("details") => (path.len() > 2 && !is_index(path.get(2)))
            .then(|| "'details' is a list: select an entry by its index".to_owned()),
        _ => Some(format!("an error has no field {}", repr_part(field))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::argentic_core::exact::scan::parse_v030;

    fn read(text: &str) -> Report {
        validate_bytes(text.as_bytes(), &ModuleMap::new()).unwrap()
    }

    #[test]
    fn directory_errors_keep_source_order() {
        let report = read(
            r#"{"contract":"agsdl-0.3.0","id":"order","agents":{"a":{"harness":"unknown","permissions":{"preset":"read-only","directories":{"2":"write","1":"write"}}}}}"#,
        );
        let found: Vec<(&str, &str)> = report
            .diagnostics
            .iter()
            .map(|d| (d.code, d.path.as_str()))
            .collect();
        assert_eq!(
            found,
            [
                ("PERMISSIONS", "/agents/a/permissions/directories/2"),
                ("PERMISSIONS", "/agents/a/permissions/directories/1"),
                ("HARNESS_UNVERIFIED", "/agents/a/harness"),
            ]
        );
        assert!(!report.valid());
    }

    #[test]
    fn report_json_uses_js_member_order() {
        let mut report = Report::new();
        report.joins.set(
            "b".to_owned(),
            ReportJoin {
                origin: "o".to_owned(),
                branches: vec!["x".to_owned()],
            },
        );
        report.joins.set(
            "1".to_owned(),
            ReportJoin {
                origin: "o".to_owned(),
                branches: vec![],
            },
        );
        report.add(
            "warning",
            "HARNESS_UNVERIFIED",
            "/a".to_owned(),
            "m".to_owned(),
            Some(vec!["a".to_owned(), "b".to_owned()]),
        );
        report.add(
            "warning",
            "HARNESS_UNVERIFIED",
            "/a".to_owned(),
            "m".to_owned(),
            None,
        );
        assert_eq!(
            report.to_json(),
            r#"{"contract":"agsdl-0.3.0","valid":true,"diagnostics":[{"severity":"warning","code":"HARNESS_UNVERIFIED","path":"/a","message":"m","step":["a","b"]}],"joins":{"1":{"origin":"o","branches":[]},"b":{"origin":"o","branches":["x"]}}}"#
        );
    }

    #[test]
    fn module_checks_report_the_first_problem() {
        let module = parse_v030(br#"{"2":0}"#).unwrap().tree;
        let Err(ReadError::Module(error)) = check_module(module) else {
            panic!("module error")
        };
        assert!(
            error.message.starts_with("/: missing field"),
            "{}",
            error.message
        );
    }
}
