// SPDX-License-Identifier: Apache-2.0
//! JSON Schema subset checker. Rust translation of
//! `src/vendor/agsdl/v0.3/schemacheck.mjs` (port of AgSDL v0.3.0
//! tooling/agsdl/schemacheck.py, upstream commit
//! bd9f8a5b16923476fd20ac2650bd1729ee151917). Provenance and license:
//! `src/vendor/agsdl/NOTICE.md`, `src/vendor/agsdl/v0.3/LICENSE`.
//!
//! The JS checker suspends a generator at each child check. Here each frame is
//! an explicit state machine on a heap stack, so problems are produced in the
//! same order without native recursion. The pinned schemas are embedded with
//! `include_str!` from their vendored files, bytes unchanged.
pub(crate) mod pattern;

use super::exact::{
    quote,
    scan::{parse_shared, pointer},
    stringify,
    values::{compare_numbers, equal_v030, json_type_matches, Num},
    Object, Value,
};
use regex::Regex;
use std::{
    cmp::Ordering,
    collections::HashMap,
    rc::Rc,
    sync::{Mutex, OnceLock},
};

/// `[pointer, message]`.
pub(crate) type Problem = (String, String);

/// An exception the JS checker throws (`Error`, `TypeError`, `SyntaxError`):
/// an unsupported or unresolved `$ref`, a malformed keyword value or a refused
/// pattern. None is reachable from the pinned schemas.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SchemaError {
    pub(crate) message: String,
}

fn refuse<T>(message: impl Into<String>) -> Result<T, SchemaError> {
    Err(SchemaError {
        message: message.into(),
    })
}

pub(crate) const DOCUMENT_SCHEMA_JSON: &str =
    include_str!("../../assets/schema/agsdl.schema.json");
pub(crate) const MODULE_SCHEMA_JSON: &str =
    include_str!("../../assets/schema/harness-module.schema.json");

/// JS truthiness of a JSON value. A `NumberToken` is an object, so truthy.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(_) | Value::Array(_) | Value::Object(_) => true,
    }
}

/// `pointer(parts)` for one property name.
fn child_path(path: &str, key: &str) -> String {
    pointer(path, key)
}

/// `best(results)`: deepest location, then fewest problems, first wins.
fn best(results: &[Vec<Problem>]) -> Vec<Problem> {
    let mut chosen: &[Problem] = &[];
    let mut depth: isize = -1;
    for errors in results {
        let mut d: isize = -1;
        for (at, _) in errors {
            d = d.max(at.split('/').count() as isize);
        }
        if d > depth || (d == depth && errors.len() < chosen.len()) {
            chosen = errors;
            depth = d;
        }
    }
    chosen.to_vec()
}

#[derive(Clone)]
enum Subject<'v> {
    Borrowed(&'v Value),
    /// A property name checked against `propertyNames`.
    Key(Rc<Value>),
}

impl<'v> Subject<'v> {
    fn borrowed(&self) -> Option<&'v Value> {
        match self {
            Subject::Borrowed(value) => Some(*value),
            Subject::Key(_) => None,
        }
    }

    fn get(&self) -> &Value {
        match self {
            Subject::Borrowed(value) => value,
            Subject::Key(value) => value,
        }
    }
}

enum Stage {
    Start,
    AfterRef,
    Items(usize),
    Required,
    Entry(usize),
    AfterNames(usize, usize),
    Property(usize),
    Not,
    AfterNot(usize),
    Combinator {
        keyword: usize,
        option: usize,
        results: Vec<usize>,
    },
}

struct Frame<'v, 's> {
    subject: Subject<'v>,
    schema: &'s Value,
    path: String,
    sink: usize,
    stage: Stage,
    /// Object members, collected when the object stages start.
    entries: Vec<(&'v str, &'v Value)>,
}

const COMBINATORS: [&str; 2] = ["anyOf", "oneOf"];

pub(crate) struct SchemaChecker {
    root: Value,
    patterns: Mutex<HashMap<String, Regex>>,
}

impl SchemaChecker {
    pub(crate) fn new(root: Value) -> Self {
        Self {
            root,
            patterns: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn root(&self) -> &Value {
        &self.root
    }

    /// `check(value)`: every problem, in the JS traversal order.
    pub(crate) fn check(&self, value: &Value) -> Result<Vec<Problem>, SchemaError> {
        let mut sinks: Vec<Vec<Problem>> = vec![Vec::new()];
        let mut stack = vec![Frame {
            subject: Subject::Borrowed(value),
            schema: &self.root,
            path: String::new(),
            sink: 0,
            stage: Stage::Start,
            entries: Vec::new(),
        }];
        while let Some(mut frame) = stack.pop() {
            if let Some(child) = self.advance(&mut frame, &mut sinks)? {
                stack.push(frame);
                stack.push(child);
            }
        }
        Ok(sinks.swap_remove(0))
    }

    fn resolve(&self, reference: &Value) -> Result<&Value, SchemaError> {
        let Value::String(reference) = reference else {
            return refuse("$ref must be a string");
        };
        if reference == "#" {
            return Ok(&self.root);
        }
        let Some(rest) = reference.strip_prefix("#/") else {
            return refuse(format!("Unsupported reference {reference}"));
        };
        let mut node = &self.root;
        for encoded in rest.split('/') {
            let part = encoded.replace("~1", "/").replace("~0", "~");
            let next = match node {
                Value::Object(object) => object.get(&part),
                Value::Array(items) => part
                    .parse::<usize>()
                    .ok()
                    .filter(|index| index.to_string() == part)
                    .and_then(|index| items.get(index)),
                _ => None,
            };
            node = match next {
                Some(next) => next,
                None => return refuse(format!("Unresolved reference {reference}")),
            };
        }
        Ok(node)
    }

    fn matches(&self, source: &str, text: &str) -> Result<bool, SchemaError> {
        let mut cache = self
            .patterns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !cache.contains_key(source) {
            let compiled = pattern::compile(source).map_err(|message| SchemaError {
                message: format!("Invalid regular expression /{source}/u: {message}"),
            })?;
            cache.insert(source.to_owned(), compiled);
        }
        Ok(cache[source].is_match(text))
    }

    /// One resumption of the JS generator `_check`. Returns a child frame to
    /// run before this one resumes, or `None` when the frame is finished.
    fn advance<'v, 's>(
        &'s self,
        frame: &mut Frame<'v, 's>,
        sinks: &mut Vec<Vec<Problem>>,
    ) -> Result<Option<Frame<'v, 's>>, SchemaError> {
        let subject = frame.subject.clone();
        let value = subject.get();
        let at = frame.path.clone();
        let sink = frame.sink;
        let schema: &'s Object = match frame.schema {
            Value::Bool(true) => return Ok(None),
            Value::Bool(false) => {
                sinks[sink].push((at, "no value is allowed here".to_owned()));
                return Ok(None);
            }
            Value::Object(object) => object,
            // `Object.hasOwn` throws only on null; other primitives own none
            // of the keywords, so the JS frame finishes without a problem.
            Value::Null => return refuse("Cannot convert undefined or null to object"),
            _ => empty_object(),
        };
        let child = |subject: Subject<'v>, schema: &'s Value, path: String, sink: usize| {
            Some(Frame {
                subject,
                schema,
                path,
                sink,
                stage: Stage::Start,
                entries: Vec::new(),
            })
        };
        loop {
            match &mut frame.stage {
                Stage::Start => {
                    frame.stage = Stage::AfterRef;
                    if let Some(reference) = schema.get("$ref") {
                        let target = self.resolve(reference)?;
                        return Ok(child(subject.clone(), target, at, sink));
                    }
                }
                Stage::AfterRef => {
                    if let Some(kind) = schema.get("type") {
                        let names: Vec<&Value> = match kind {
                            Value::Array(items) => items.iter().collect(),
                            other => vec![other],
                        };
                        let mut texts = Vec::with_capacity(names.len());
                        for name in &names {
                            match name {
                                Value::String(text) => texts.push(text.as_str()),
                                _ => return refuse("type names must be strings"),
                            }
                        }
                        if !texts.iter().any(|name| json_type_matches(value, name)) {
                            sinks[sink].push((at, format!("expected {}", texts.join(" or "))));
                            return Ok(None);
                        }
                    }
                    if let Some(constant) = schema.get("const") {
                        if !equal_v030(value, constant) {
                            sinks[sink]
                                .push((at.clone(), format!("expected {}", stringify(constant))));
                        }
                    }
                    if let Some(options) = schema.get("enum") {
                        let Value::Array(options) = options else {
                            return refuse("enum must be an array");
                        };
                        if !options.iter().any(|option| equal_v030(value, option)) {
                            let shown: Vec<String> = options.iter().map(stringify).collect();
                            sinks[sink].push((
                                at.clone(),
                                format!("expected one of {}", shown.join(", ")),
                            ));
                        }
                    }
                    if let Value::String(text) = value {
                        if let Some(minimum) = schema.get("minLength") {
                            let length = Num::Host(text.chars().count());
                            if compare_numbers(length, number(minimum)?) == Ordering::Less {
                                sinks[sink]
                                    .push((at.clone(), "the string is too short".to_owned()));
                            }
                        }
                        if let Some(source) = schema.get("pattern") {
                            let Value::String(source) = source else {
                                return refuse("pattern must be a string");
                            };
                            if !self.matches(source, text)? {
                                let shown = if source.encode_utf16().count() <= 80 {
                                    source.as_str()
                                } else {
                                    "the expected syntax"
                                };
                                sinks[sink].push((
                                    at.clone(),
                                    format!("{} does not match {shown}", quote(text)),
                                ));
                            }
                        }
                    }
                    if let (Value::Number(token), Some(minimum)) = (value, schema.get("minimum")) {
                        if compare_numbers(Num::Token(token), number(minimum)?) == Ordering::Less {
                            sinks[sink].push((
                                at.clone(),
                                format!("expected at least {}", stringify(minimum)),
                            ));
                        }
                    }
                    if let Value::Array(items) = value {
                        if let Some(minimum) = schema.get("minItems") {
                            if compare_numbers(Num::Host(items.len()), number(minimum)?)
                                == Ordering::Less
                            {
                                sinks[sink].push((
                                    at.clone(),
                                    format!("expected at least {} items", stringify(minimum)),
                                ));
                            }
                        }
                        if let Some(maximum) = schema.get("maxItems") {
                            if compare_numbers(Num::Host(items.len()), number(maximum)?)
                                == Ordering::Greater
                            {
                                sinks[sink].push((
                                    at.clone(),
                                    format!("expected at most {} items", stringify(maximum)),
                                ));
                            }
                        }
                        if schema.get("uniqueItems").is_some_and(truthy) {
                            for i in 0..items.len() {
                                for j in 0..i {
                                    if equal_v030(&items[i], &items[j]) {
                                        sinks[sink].push((
                                            format!("{at}/{i}"),
                                            "duplicate item".to_owned(),
                                        ));
                                        break;
                                    }
                                }
                            }
                        }
                        frame.stage = Stage::Items(0);
                    } else {
                        frame.stage = Stage::Required;
                    }
                }
                Stage::Items(index) => {
                    let Some(Value::Array(items)) = subject.borrowed() else {
                        return refuse("internal: array stage without an array");
                    };
                    let prefix: &[Value] = match schema.get("prefixItems") {
                        Some(found) if truthy(found) => match found {
                            Value::Array(prefix) => prefix,
                            _ => return refuse("prefixItems must be an array"),
                        },
                        _ => &[],
                    };
                    while *index < items.len() {
                        let i = *index;
                        *index += 1;
                        let path = format!("{at}/{i}");
                        if i < prefix.len() {
                            return Ok(child(Subject::Borrowed(&items[i]), &prefix[i], path, sink));
                        }
                        if let Some(each) = schema.get("items") {
                            return Ok(child(Subject::Borrowed(&items[i]), each, path, sink));
                        }
                    }
                    frame.stage = Stage::Required;
                }
                Stage::Required => {
                    let Some(Value::Object(object)) = subject.borrowed() else {
                        frame.stage = Stage::Not;
                        continue;
                    };
                    frame.entries = object.iter().collect();
                    if let Some(required) = schema.get("required") {
                        if truthy(required) {
                            let Value::Array(required) = required else {
                                return refuse("required must be an array");
                            };
                            for name in required {
                                let present = matches!(name, Value::String(name) if object.contains_key(name));
                                if !present {
                                    sinks[sink].push((
                                        at.clone(),
                                        format!("missing field {}", stringify(name)),
                                    ));
                                }
                            }
                        }
                    }
                    frame.stage = Stage::Entry(0);
                }
                Stage::Entry(index) => {
                    let i = *index;
                    let Some(&(key, _)) = frame.entries.get(i) else {
                        frame.stage = Stage::Not;
                        continue;
                    };
                    if let Some(names) = schema.get("propertyNames") {
                        let probe = sinks.len();
                        sinks.push(Vec::new());
                        frame.stage = Stage::AfterNames(i, probe);
                        let name = Subject::Key(Rc::new(Value::String(key.to_owned())));
                        return Ok(child(name, names, child_path(&at, key), probe));
                    }
                    frame.stage = Stage::Property(i);
                }
                Stage::AfterNames(i, probe) => {
                    let (i, probe) = (*i, *probe);
                    let (key, _) = frame.entries[i];
                    if !sinks[probe].is_empty() {
                        sinks[sink]
                            .push((child_path(&at, key), format!("invalid name {}", quote(key))));
                        frame.stage = Stage::Entry(i + 1);
                    } else {
                        frame.stage = Stage::Property(i);
                    }
                }
                Stage::Property(i) => {
                    let i = *i;
                    let (key, item) = frame.entries[i];
                    frame.stage = Stage::Entry(i + 1);
                    let path = child_path(&at, key);
                    let properties = match schema.get("properties") {
                        Some(found) if truthy(found) => match found {
                            Value::Object(properties) => Some(properties),
                            _ => return refuse("properties must be an object"),
                        },
                        _ => None,
                    };
                    if let Some(declared) = properties.and_then(|properties| properties.get(key)) {
                        return Ok(child(Subject::Borrowed(item), declared, path, sink));
                    }
                    match schema.get("additionalProperties") {
                        Some(Value::Bool(false)) => {
                            sinks[sink].push((path, format!("unknown field {}", quote(key))));
                        }
                        Some(Value::Bool(true)) | None => {}
                        Some(additional) => {
                            return Ok(child(Subject::Borrowed(item), additional, path, sink));
                        }
                    }
                }
                Stage::Not => {
                    if let Some(negated) = schema.get("not") {
                        let probe = sinks.len();
                        sinks.push(Vec::new());
                        frame.stage = Stage::AfterNot(probe);
                        return Ok(child(subject.clone(), negated, at, probe));
                    }
                    frame.stage = Stage::Combinator {
                        keyword: 0,
                        option: 0,
                        results: Vec::new(),
                    };
                }
                Stage::AfterNot(probe) => {
                    if sinks[*probe].is_empty() {
                        sinks[sink].push((
                            at.clone(),
                            "this combination of fields is not allowed".to_owned(),
                        ));
                    }
                    frame.stage = Stage::Combinator {
                        keyword: 0,
                        option: 0,
                        results: Vec::new(),
                    };
                }
                Stage::Combinator {
                    keyword,
                    option,
                    results,
                } => {
                    let Some(name) = COMBINATORS.get(*keyword) else {
                        return Ok(None);
                    };
                    let Some(options) = schema.get(name) else {
                        *keyword += 1;
                        continue;
                    };
                    let Value::Array(options) = options else {
                        return refuse(format!("{name} must be an array"));
                    };
                    if *option < options.len() {
                        let probe = sinks.len();
                        sinks.push(Vec::new());
                        results.push(probe);
                        let target = &options[*option];
                        *option += 1;
                        return Ok(child(subject.clone(), target, at, probe));
                    }
                    let outcomes: Vec<Vec<Problem>> =
                        results.iter().map(|&probe| sinks[probe].clone()).collect();
                    let passing = outcomes.iter().filter(|result| result.is_empty()).count();
                    if passing == 0 {
                        sinks[sink].extend(best(&outcomes));
                    } else if *keyword == 1 && passing > 1 {
                        sinks[sink].push((
                            at.clone(),
                            "the value matches several alternatives".to_owned(),
                        ));
                    }
                    *keyword += 1;
                    *option = 0;
                    results.clear();
                }
            }
        }
    }
}

fn empty_object() -> &'static Object {
    static EMPTY: OnceLock<Object> = OnceLock::new();
    EMPTY.get_or_init(Object::default)
}

/// Numeric keyword operand; JS `decimal` throws a `TypeError` otherwise.
fn number(value: &Value) -> Result<Num<'_>, SchemaError> {
    match value {
        Value::Number(token) => Ok(Num::Token(token)),
        _ => refuse("Expected a finite JSON number"),
    }
}

fn parse_pinned(name: &str, text: &str) -> Result<Value, SchemaError> {
    // The TS code imports these files with `JSON.parse`, which builds ordinary
    // JS objects: the shared scanner keeps the same member order.
    parse_shared(text.as_bytes())
        .map(|parsed| parsed.tree)
        .map_err(|error| SchemaError {
            message: format!("pinned {name} is not exact JSON: {}", error.message()),
        })
}

fn pinned(
    cell: &'static OnceLock<Result<SchemaChecker, SchemaError>>,
    build: impl FnOnce() -> Result<Value, SchemaError>,
) -> Result<&'static SchemaChecker, SchemaError> {
    cell.get_or_init(|| build().map(SchemaChecker::new))
        .as_ref()
        .map_err(Clone::clone)
}

/// The document schema root, `agsdl.schema.json`.
pub(crate) fn document_schema() -> Result<&'static SchemaChecker, SchemaError> {
    static CELL: OnceLock<Result<SchemaChecker, SchemaError>> = OnceLock::new();
    pinned(&CELL, || {
        parse_pinned("agsdl.schema.json", DOCUMENT_SCHEMA_JSON)
    })
}

/// The harness module schema root, `harness-module.schema.json`.
pub(crate) fn module_schema() -> Result<&'static SchemaChecker, SchemaError> {
    static CELL: OnceLock<Result<SchemaChecker, SchemaError>> = OnceLock::new();
    pinned(&CELL, || {
        parse_pinned("harness-module.schema.json", MODULE_SCHEMA_JSON)
    })
}

/// `{ <members>, $defs: documentSchema.$defs }`, the form of the roots that
/// Macro's code builds over the document definitions (`check_module` and the
/// host message shape of `hostCompilation.ts`). `members` is the JSON text of
/// the leading members, without braces.
pub(crate) fn root_with_document_defs(members: &str) -> Result<Value, SchemaError> {
    let document = document_schema()?;
    let defs = match document.root() {
        Value::Object(root) => root.get("$defs"),
        _ => None,
    };
    let Some(defs) = defs else {
        return refuse("document schema has no $defs");
    };
    let text = format!("{{{members},\"$defs\":{}}}", stringify(defs));
    parse_shared(text.as_bytes())
        .map(|parsed| parsed.tree)
        .map_err(|error| SchemaError {
            message: format!("root members are not exact JSON: {}", error.message()),
        })
}

/// `new SchemaChecker({ $ref: '#/$defs/valueSchema', $defs: documentSchema.$defs })`.
pub(crate) fn value_schema_shape() -> Result<&'static SchemaChecker, SchemaError> {
    static CELL: OnceLock<Result<SchemaChecker, SchemaError>> = OnceLock::new();
    pinned(&CELL, || {
        root_with_document_defs(r##""$ref":"#/$defs/valueSchema""##)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(text: &str) -> Value {
        super::super::exact::scan::parse_v030(text.as_bytes())
            .unwrap()
            .tree
    }

    fn patterns(value: &Value, out: &mut Vec<String>) {
        let mut pending = vec![value];
        while let Some(node) = pending.pop() {
            match node {
                Value::Object(object) => {
                    for (key, item) in object.iter() {
                        if let (true, Value::String(source)) = (key == "pattern", item) {
                            out.push(source.clone());
                        }
                        pending.push(item);
                    }
                }
                Value::Array(items) => pending.extend(items),
                _ => {}
            }
        }
    }

    #[test]
    fn pinned_patterns_compile_within_the_explicit_limit() {
        let mut found = Vec::new();
        patterns(document_schema().unwrap().root(), &mut found);
        patterns(module_schema().unwrap().root(), &mut found);
        found.sort();
        found.dedup();
        assert_eq!(found.len(), 5, "distinct pinned patterns: {found:?}");
        let uri = found.iter().find(|source| source.len() > 1000).unwrap();
        let translated = pattern::translate(uri).unwrap();
        let needed = (0..=8)
            .map(|shift| (1usize << 20) << shift)
            .find(|&limit| {
                regex::RegexBuilder::new(&translated)
                    .size_limit(limit)
                    .build()
                    .is_ok()
            })
            .expect("URI pattern compiles within 256 MiB");
        eprintln!("ARGENTIC_URI_PATTERN_SIZE_NEEDED {needed}");
        assert!(needed <= pattern::PATTERN_SIZE_LIMIT);
        for source in &found {
            pattern::compile(source).unwrap_or_else(|error| panic!("{source}: {error}"));
        }
    }

    #[test]
    fn traversal_order_follows_the_generator() {
        let checker = SchemaChecker::new(tree(r#"{"type":"object","additionalProperties":false}"#));
        let found = checker
            .check(&tree(r#"{"other":0,"2":1,"1":0,"nested":{}}"#))
            .unwrap();
        let paths: Vec<_> = found.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(paths, ["/other", "/2", "/1", "/nested"]);
        let document = document_schema().unwrap();
        let problems = document
            .check(&tree(
                r#"{"contract":"agsdl-0.3.0","id":"x\n","agents":{}}"#,
            ))
            .unwrap();
        assert_eq!(
            problems,
            vec![(
                "/id".to_owned(),
                "\"x\\n\" does not match ^[A-Za-z][A-Za-z0-9_-]{0,63}$".to_owned()
            )]
        );
    }

    #[test]
    fn checker_refusals_are_errors_not_problems() {
        let checker = SchemaChecker::new(tree(r##"{"$ref":"#/missing"}"##));
        assert_eq!(
            checker.check(&Value::Null).unwrap_err().message,
            "Unresolved reference #/missing"
        );
        let checker = SchemaChecker::new(tree(r#"{"$ref":"http://x"}"#));
        assert!(checker.check(&Value::Null).is_err());
    }
}
