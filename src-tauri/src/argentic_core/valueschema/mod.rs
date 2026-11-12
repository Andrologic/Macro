// SPDX-License-Identifier: Apache-2.0
//! Value schemas. Rust translation of `src/vendor/agsdl/v0.3/valueschema.mjs`
//! (port of AgSDL 0.3.0 tooling/agsdl/valueschema.py) and of the `pointer`
//! helper of `v0.3/schemacheck.mjs`. Provenance and license:
//! `src/vendor/agsdl/NOTICE.md`, `src/vendor/agsdl/v0.3/LICENSE`.
//!
//! Precondition: every schema has the published `#/$defs/valueSchema` shape
//! of `agsdl.schema.json`. All TS callers check that shape first (document
//! schema, harness module schema, statically validated agent declarations).
//! A schema with another shape is refused with [`OutsideShape`], an internal
//! refusal that is not an AgSDL diagnostic. Shape-valid schemas may still be
//! inconsistent; `consistency` reports those exactly like the TS helper.
pub(crate) mod port;

use super::exact::{
    quote,
    scan::pointer,
    stringify,
    values::{compare_numbers, equal_v030, is_integer_number, json_type_matches, Num},
    NumberToken, Object, Value,
};
use std::cmp::Ordering;

/// `[pointer, message]` of the TS helpers.
pub(crate) type Problem = (String, String);

/// A schema outside the published value-schema shape, located by a JSON
/// pointer relative to the schema root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OutsideShape {
    pub(crate) pointer: String,
}

/// One element of a TS pointer path: a property name, an internal JS index,
/// or an authored number token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PointerPart {
    Key(String),
    Index(usize),
    Number(NumberToken),
}

impl PointerPart {
    /// Text used by `schemacheck.pointer`: `stringify` for numbers, the name
    /// itself for strings.
    fn segment(&self) -> String {
        match self {
            PointerPart::Key(name) => name.clone(),
            PointerPart::Index(index) => index.to_string(),
            PointerPart::Number(token) => token.raw().to_owned(),
        }
    }

    /// 0.3 `stringify(part)`.
    fn stringified(&self) -> String {
        match self {
            PointerPart::Key(name) => quote(name),
            _ => self.segment(),
        }
    }

    fn number(&self) -> Option<Num<'_>> {
        match self {
            PointerPart::Key(_) => None,
            PointerPart::Index(index) => Some(Num::Host(*index)),
            PointerPart::Number(token) => Some(Num::Token(token)),
        }
    }

    /// `is_index(part)`: an integer-valued number, of any sign or size.
    fn is_index(&self) -> bool {
        self.number().is_some_and(is_integer_number)
    }
}

/// `schemacheck.pointer(parts)`.
pub(crate) fn path_pointer(path: &[PointerPart]) -> String {
    path.iter()
        .fold(String::new(), |here, part| pointer(&here, &part.segment()))
}

const KINDS: [&str; 7] = [
    "null", "boolean", "number", "integer", "string", "array", "object",
];

fn nonnegative_integer(value: &Value) -> bool {
    matches!(value, Value::Number(token)
        if is_integer_number(Num::Token(token)) && compare_numbers(Num::Token(token), Num::Host(0)) != Ordering::Less)
}

/// Checks the `#/$defs/valueSchema` shape, iteratively.
pub(crate) fn check_shape(schema: &Value) -> Result<(), OutsideShape> {
    let mut pending = vec![(schema, String::new())];
    while let Some((node, here)) = pending.pop() {
        let outside = |at: &str| {
            Err(OutsideShape {
                pointer: at.to_owned(),
            })
        };
        let Value::Object(object) = node else {
            return outside(&here);
        };
        if !object.contains_key("type") {
            return outside(&here);
        }
        for (key, value) in object.iter() {
            let at = pointer(&here, key);
            let valid = match key {
                "type" => value.as_str().is_some_and(|kind| KINDS.contains(&kind)),
                "description" => value.as_str().is_some(),
                "enum" => value.as_array().is_some_and(|values| !values.is_empty()),
                "items" => {
                    pending.push((value, at.clone()));
                    true
                }
                "minItems" | "maxItems" => nonnegative_integer(value),
                "properties" => match value {
                    Value::Object(properties) => {
                        pending.extend(
                            properties
                                .iter()
                                .map(|(name, child)| (child, pointer(&at, name))),
                        );
                        true
                    }
                    _ => false,
                },
                "required" => value.as_array().is_some_and(|names| {
                    names.iter().enumerate().all(|(index, name)| {
                        name.as_str().is_some_and(|name| {
                            !names[..index]
                                .iter()
                                .any(|earlier| earlier.as_str() == Some(name))
                        })
                    })
                }),
                "additionalProperties" => matches!(value, Value::Bool(_)),
                _ => false,
            };
            if !valid {
                return outside(&at);
            }
        }
    }
    Ok(())
}

fn schema_object(value: &Value) -> Option<&Object> {
    value.as_object()
}

/// The `type` of a shape-checked schema node.
fn kind_of(node: &Object) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn properties(node: &Object) -> Option<&Object> {
    node.get("properties").and_then(Value::as_object)
}

fn additional_properties_refused(node: &Object) -> bool {
    matches!(node.get("additionalProperties"), Some(Value::Bool(false)))
}

/// `consistency(schema, path)`: object children before the parent bounds,
/// array items after them, problems in visit order.
pub(crate) fn consistency(
    schema: &Value,
    path: &[PointerPart],
) -> Result<Vec<Problem>, OutsideShape> {
    check_shape(schema)?;
    let mut problems = Vec::new();
    let mut pending: Vec<(&Object, String, bool)> = schema_object(schema)
        .map(|node| (node, path_pointer(path), false))
        .into_iter()
        .collect();
    while let Some((node, here, children_done)) = pending.pop() {
        let kind = kind_of(node);
        if children_done {
            let minimum = node
                .get("minItems")
                .and_then(Value::as_number)
                .map_or(Num::Host(0), Num::Token);
            let maximum = node
                .get("maxItems")
                .and_then(Value::as_number)
                .map_or(minimum, Num::Token);
            if compare_numbers(minimum, maximum) == Ordering::Greater {
                problems.push((
                    pointer(&here, "minItems"),
                    "minItems exceeds maxItems".to_owned(),
                ));
            }
            if kind == "array" {
                if let Some(items) = node.get("items").and_then(schema_object) {
                    pending.push((items, pointer(&here, "items"), false));
                }
            }
            continue;
        }
        pending.push((node, here.clone(), true));
        for key in ["items", "minItems", "maxItems"] {
            if node.contains_key(key) && kind != "array" {
                problems.push((
                    pointer(&here, key),
                    format!("{key} is allowed only on arrays"),
                ));
            }
        }
        for key in ["properties", "required", "additionalProperties"] {
            if node.contains_key(key) && kind != "object" {
                problems.push((
                    pointer(&here, key),
                    format!("{key} is allowed only on objects"),
                ));
            }
        }
        if let Some(values) = node.get("enum").and_then(Value::as_array) {
            let base = pointer(&here, "enum");
            for (index, value) in values.iter().enumerate() {
                let at = pointer(&base, &index.to_string());
                if !json_type_matches(value, kind) {
                    problems.push((at.clone(), format!("enum value is not of type {kind}")));
                }
                if values[..index]
                    .iter()
                    .any(|earlier| equal_v030(value, earlier))
                {
                    problems.push((at, "duplicate enum value".to_owned()));
                }
            }
        }
        if kind == "object" {
            let declared = properties(node);
            if let Some(required) = node.get("required").and_then(Value::as_array) {
                let base = pointer(&here, "required");
                for (index, name) in required.iter().enumerate() {
                    let name = name.as_str().unwrap_or_default();
                    if !declared.is_some_and(|declared| declared.contains_key(name)) {
                        problems.push((
                            pointer(&base, &index.to_string()),
                            format!("{} is not a declared property", quote(name)),
                        ));
                    }
                }
            }
            if let Some(declared) = declared {
                let base = pointer(&here, "properties");
                for (name, child) in declared.iter().rev() {
                    if let Some(child) = schema_object(child) {
                        pending.push((child, pointer(&base, name), false));
                    }
                }
            }
        }
    }
    Ok(problems)
}

/// `validate(value, schema, path)`: problems in the published traversal order.
pub(crate) fn validate(
    value: &Value,
    schema: &Value,
    path: &[PointerPart],
) -> Result<Vec<Problem>, OutsideShape> {
    check_shape(schema)?;
    enum Task<'a> {
        Check(&'a Value, &'a Object, String),
        Report(String, String),
    }
    let mut problems = Vec::new();
    let mut pending: Vec<Task<'_>> = schema_object(schema)
        .map(|node| Task::Check(value, node, path_pointer(path)))
        .into_iter()
        .collect();
    while let Some(task) = pending.pop() {
        let (item, node, here) = match task {
            Task::Report(at, message) => {
                problems.push((at, message));
                continue;
            }
            Task::Check(item, node, here) => (item, node, here),
        };
        let kind = kind_of(node);
        if !json_type_matches(item, kind) {
            problems.push((here, format!("expected {kind}")));
            continue;
        }
        if let Some(allowed) = node.get("enum").and_then(Value::as_array) {
            if !allowed.iter().any(|candidate| equal_v030(item, candidate)) {
                let listed: Vec<String> = allowed.iter().map(stringify).collect();
                problems.push((
                    here.clone(),
                    format!("expected one of {}", listed.join(", ")),
                ));
            }
        }
        if let Value::Array(items) = item {
            for (key, comparison, qualifier) in [
                ("minItems", Ordering::Less, "least"),
                ("maxItems", Ordering::Greater, "most"),
            ] {
                if let Some(bound) = node.get(key).and_then(Value::as_number) {
                    if compare_numbers(Num::Host(items.len()), Num::Token(bound)) == comparison {
                        let plural = if compare_numbers(Num::Token(bound), Num::Host(1))
                            == Ordering::Equal
                        {
                            ""
                        } else {
                            "s"
                        };
                        problems.push((
                            here.clone(),
                            format!("expected at {qualifier} {} item{plural}", bound.raw()),
                        ));
                    }
                }
            }
            if let Some(items_schema) = node.get("items").and_then(schema_object) {
                for (index, element) in items.iter().enumerate().rev() {
                    pending.push(Task::Check(
                        element,
                        items_schema,
                        pointer(&here, &index.to_string()),
                    ));
                }
            }
        }
        if let Value::Object(object) = item {
            if kind == "object" {
                let declared = properties(node);
                if let Some(required) = node.get("required").and_then(Value::as_array) {
                    for name in required.iter().filter_map(Value::as_str) {
                        if !object.contains_key(name) {
                            problems.push((here.clone(), format!("missing {}", quote(name))));
                        }
                    }
                }
                for (name, child) in object.iter().rev() {
                    match declared
                        .and_then(|declared| declared.get(name))
                        .and_then(schema_object)
                    {
                        Some(child_schema) => {
                            pending.push(Task::Check(child, child_schema, pointer(&here, name)))
                        }
                        None if additional_properties_refused(node) => {
                            pending.push(Task::Report(
                                pointer(&here, name),
                                format!("unknown {}", quote(name)),
                            ));
                        }
                        None => {}
                    }
                }
            }
        }
    }
    Ok(problems)
}

/// Result of `descend(schema, path)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Descent {
    /// `[true, null]`
    Allowed,
    /// `[false, reason]`
    Refused(String),
    /// `[null, null]`: the schema does not decide.
    Unknown,
}

/// `descend(schema, path)`.
pub(crate) fn descend(schema: &Value, path: &[PointerPart]) -> Result<Descent, OutsideShape> {
    check_shape(schema)?;
    let mut node = schema_object(schema);
    for part in path {
        let Some(current) = node else {
            return Ok(Descent::Unknown);
        };
        let kind = kind_of(current);
        match part {
            PointerPart::Key(name) if kind == "object" => {
                match properties(current).and_then(|declared| declared.get(name)) {
                    Some(child) => node = schema_object(child),
                    None if additional_properties_refused(current) => {
                        return Ok(Descent::Refused(format!(
                            "{} is not a declared property",
                            quote(name)
                        )));
                    }
                    None => return Ok(Descent::Unknown),
                }
            }
            _ if kind == "array" && part.is_index() => {
                if let (Some(index), Some(maximum)) = (
                    part.number(),
                    current.get("maxItems").and_then(Value::as_number),
                ) {
                    if compare_numbers(index, Num::Token(maximum)) != Ordering::Less {
                        return Ok(Descent::Refused(format!(
                            "index {} is beyond the {} items the list may have",
                            part.stringified(),
                            maximum.raw()
                        )));
                    }
                }
                node = current.get("items").and_then(schema_object);
            }
            _ => {
                return Ok(Descent::Refused(format!(
                    "cannot select {} in a value of type {kind}",
                    part.stringified()
                )))
            }
        }
    }
    Ok(Descent::Allowed)
}

/// `kind_at(schema, path)`.
pub(crate) fn kind_at(
    schema: &Value,
    path: &[PointerPart],
) -> Result<Option<String>, OutsideShape> {
    check_shape(schema)?;
    let mut node = schema_object(schema);
    for part in path {
        let Some(current) = node else {
            return Ok(None);
        };
        let kind = kind_of(current);
        node = match part {
            PointerPart::Key(name) if kind == "object" => properties(current)
                .and_then(|declared| declared.get(name))
                .and_then(schema_object),
            _ if kind == "array" && part.is_index() => current.get("items").and_then(schema_object),
            _ => return Ok(None),
        };
    }
    Ok(node.map(|node| kind_of(node).to_owned()))
}

#[cfg(test)]
mod tests {
    use super::super::exact::{decode, scan::parse_v030};
    use super::*;

    fn tree(text: &str) -> Value {
        parse_v030(text.as_bytes()).unwrap().tree
    }

    fn token(raw: &str) -> PointerPart {
        PointerPart::Number(NumberToken::lexeme(raw).unwrap())
    }

    fn key(name: &str) -> PointerPart {
        PointerPart::Key(name.to_owned())
    }

    #[test]
    fn consistency_reports_children_before_parent_bounds() {
        // src/vendor/agsdl/v0.3/diagnosticOrder.test.ts and exact.test.ts
        let schema = tree(
            r#"{"type":"object","minItems":2,"maxItems":1,"properties":{"b":{"type":"array","items":{"type":"string","enum":[1,"x","x"]},"minItems":3,"maxItems":2e0},"a":{"type":"string","required":["q"]}},"required":["a","zz"],"enum":[{},{"a":1.0},{"a":1}]}"#,
        );
        let problems = consistency(&schema, &[key("root")]).unwrap();
        assert_eq!(
            problems,
            [
                ("/root/minItems", "minItems is allowed only on arrays"),
                ("/root/maxItems", "maxItems is allowed only on arrays"),
                ("/root/enum/2", "duplicate enum value"),
                ("/root/required/1", "\"zz\" is not a declared property"),
                ("/root/properties/b/minItems", "minItems exceeds maxItems"),
                (
                    "/root/properties/b/items/enum/0",
                    "enum value is not of type string"
                ),
                ("/root/properties/b/items/enum/2", "duplicate enum value"),
                (
                    "/root/properties/a/required",
                    "required is allowed only on objects"
                ),
                ("/root/minItems", "minItems exceeds maxItems"),
            ]
            .map(|(p, m)| (p.to_owned(), m.to_owned()))
        );
    }

    #[test]
    fn validate_follows_source_property_order_and_exact_bounds() {
        let schema = tree(
            r#"{"type":"object","additionalProperties":false,"required":["a","b~/"],"properties":{"a":{"type":"array","minItems":2.0,"maxItems":1e0,"items":{"type":"integer","enum":[1,2e0]}}}}"#,
        );
        let value = decode(r#"{"x":1,"a":[1.0,3,"s"],"y/~":null}"#).unwrap();
        assert_eq!(
            validate(&value, &schema, &[]).unwrap(),
            [
                ("", "missing \"b~/\""),
                ("/x", "unknown \"x\""),
                ("/a", "expected at most 1e0 item"),
                ("/a/1", "expected one of 1, 2e0"),
                ("/a/2", "expected integer"),
                ("/y~1~0", "unknown \"y/~\""),
            ]
            .map(|(p, m)| (p.to_owned(), m.to_owned()))
        );
    }

    #[test]
    fn descend_and_kind_at_select_exact_indices() {
        let schema = tree(
            r#"{"type":"array","maxItems":1e30,"items":{"type":"object","properties":{"n":{"type":"number"}},"additionalProperties":false}}"#,
        );
        assert_eq!(
            descend(
                &schema,
                &[token("999999999999999999999999999999"), key("n")]
            )
            .unwrap(),
            Descent::Allowed
        );
        assert_eq!(
            descend(&schema, &[token("1e30")]).unwrap(),
            Descent::Refused("index 1e30 is beyond the 1e30 items the list may have".to_owned())
        );
        assert_eq!(
            descend(&schema, &[token("0"), key("m")]).unwrap(),
            Descent::Refused("\"m\" is not a declared property".to_owned())
        );
        assert_eq!(
            descend(&schema, &[key("n")]).unwrap(),
            Descent::Refused("cannot select \"n\" in a value of type array".to_owned())
        );
        assert_eq!(
            descend(&schema, &[token("1.5")]).unwrap(),
            Descent::Refused("cannot select 1.5 in a value of type array".to_owned())
        );
        assert_eq!(
            kind_at(&schema, &[token("2.0"), key("n")])
                .unwrap()
                .as_deref(),
            Some("number")
        );
        assert_eq!(kind_at(&schema, &[token("0"), key("m")]).unwrap(), None);
        let open = tree(r#"{"type":"array"}"#);
        assert_eq!(
            descend(&open, &[token("0"), key("x")]).unwrap(),
            Descent::Unknown
        );
    }

    #[test]
    fn schemas_outside_the_published_shape_are_named() {
        for (schema, at) in [
            ("[]", ""),
            (r#"{"items":{"type":"string"}}"#, ""),
            (r#"{"type":"text"}"#, "/type"),
            (r#"{"type":"array","minItems":-1}"#, "/minItems"),
            (r#"{"type":"array","maxItems":1.5}"#, "/maxItems"),
            (r#"{"type":"array","enum":[]}"#, "/enum"),
            (r#"{"type":"object","required":["a","a"]}"#, "/required"),
            (
                r#"{"type":"object","properties":{"a/b":{"type":"x"}}}"#,
                "/properties/a~1b/type",
            ),
            (r#"{"type":"object","pattern":"x"}"#, "/pattern"),
        ] {
            let schema = tree(schema);
            assert_eq!(
                validate(&Value::Null, &schema, &[]).err(),
                Some(OutsideShape {
                    pointer: at.to_owned()
                })
            );
        }
        assert!(check_shape(&tree(r#"{"type":"array","minItems":-0,"maxItems":2.0e0}"#)).is_ok());
    }
}
