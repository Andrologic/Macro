//! Strict, bounded subset of MCP form elicitation schemas and submitted values.
//! Schema and content are never included in errors or diagnostics.
use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, NaiveDate};
use serde_json::{Map, Value};
use url::Url;

use super::runtime::McpRuntimeError;

const INVALID_SCHEMA: &str = "MCP_INTERACTION_INVALID_REQUEST";
const INVALID_CONTENT: &str = "MCP_INTERACTION_INVALID_RESPONSE";

fn invalid_schema() -> McpRuntimeError {
    McpRuntimeError::new(
        INVALID_SCHEMA,
        "The MCP form schema is invalid or unsupported.",
    )
}

fn invalid_content() -> McpRuntimeError {
    McpRuntimeError::new(
        INVALID_CONTENT,
        "The submitted MCP form does not match its schema.",
    )
}

#[derive(Debug)]
pub(super) struct FormSchema {
    properties: BTreeMap<String, FieldSchema>,
    required: BTreeSet<String>,
}

#[derive(Debug)]
enum FieldSchema {
    String {
        min_length: Option<u64>,
        max_length: Option<u64>,
        format: Option<StringFormat>,
        choices: Option<Vec<String>>,
    },
    Number {
        minimum: Option<f64>,
        maximum: Option<f64>,
    },
    Integer {
        minimum: Option<i64>,
        maximum: Option<i64>,
    },
    Boolean,
    MultiSelect {
        choices: Vec<String>,
        min_items: Option<u64>,
        max_items: Option<u64>,
    },
}

#[derive(Debug)]
enum StringFormat {
    Email,
    Uri,
    Date,
    DateTime,
}

fn only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn optional_u64(object: &Map<String, Value>, name: &str) -> Result<Option<u64>, McpRuntimeError> {
    object
        .get(name)
        .map(|value| value.as_u64().ok_or_else(invalid_schema))
        .transpose()
}

fn exact_f64(value: &Value) -> Option<f64> {
    let number = value.as_number()?;
    // JSON integers beyond 2^53 can round when converted to f64. Refuse
    // them rather than accepting an out-of-range IPC value by approximation.
    const MAX_EXACT_INTEGER: u64 = 1 << 53;
    if number.is_i64() && number.as_i64()?.unsigned_abs() > MAX_EXACT_INTEGER {
        return None;
    }
    if number.is_u64() && number.as_u64()? > MAX_EXACT_INTEGER {
        return None;
    }
    number.as_f64().filter(|number| number.is_finite())
}

fn optional_f64(object: &Map<String, Value>, name: &str) -> Result<Option<f64>, McpRuntimeError> {
    object
        .get(name)
        .map(|value| exact_f64(value).ok_or_else(invalid_schema))
        .transpose()
}

fn optional_i64(object: &Map<String, Value>, name: &str) -> Result<Option<i64>, McpRuntimeError> {
    object
        .get(name)
        .map(|value| value.as_i64().ok_or_else(invalid_schema))
        .transpose()
}

fn string_choices(value: &Value) -> Result<Vec<String>, McpRuntimeError> {
    let choices = value.as_array().ok_or_else(invalid_schema)?;
    if choices.is_empty() {
        return Err(invalid_schema());
    }
    let mut unique = BTreeSet::new();
    for choice in choices {
        let choice = choice.as_str().ok_or_else(invalid_schema)?;
        if !unique.insert(choice.to_owned()) {
            return Err(invalid_schema());
        }
    }
    Ok(unique.into_iter().collect())
}

fn titled_choices(value: &Value) -> Result<Vec<String>, McpRuntimeError> {
    let options = value.as_array().ok_or_else(invalid_schema)?;
    if options.is_empty() {
        return Err(invalid_schema());
    }
    let mut values = Vec::with_capacity(options.len());
    for option in options {
        let option = option.as_object().ok_or_else(invalid_schema)?;
        if !only_keys(option, &["const", "title"])
            || option.len() != 2
            || option.get("title").and_then(Value::as_str).is_none()
        {
            return Err(invalid_schema());
        }
        values.push(Value::String(
            option
                .get("const")
                .and_then(Value::as_str)
                .ok_or_else(invalid_schema)?
                .to_owned(),
        ));
    }
    string_choices(&Value::Array(values))
}

fn parse_field(value: &Value) -> Result<FieldSchema, McpRuntimeError> {
    let field = value.as_object().ok_or_else(invalid_schema)?;
    for name in ["title", "description"] {
        if field.get(name).is_some_and(|value| !value.is_string()) {
            return Err(invalid_schema());
        }
    }
    let kind = match field.get("type").and_then(Value::as_str) {
        Some("string") => {
            if !only_keys(
                field,
                &[
                    "type",
                    "title",
                    "description",
                    "default",
                    "minLength",
                    "maxLength",
                    "format",
                    "enum",
                    "enumNames",
                    "oneOf",
                ],
            ) {
                return Err(invalid_schema());
            }
            let min_length = optional_u64(field, "minLength")?;
            let max_length = optional_u64(field, "maxLength")?;
            if min_length
                .zip(max_length)
                .is_some_and(|(min, max)| min > max)
            {
                return Err(invalid_schema());
            }
            let format = match field.get("format") {
                None => None,
                Some(Value::String(value)) => Some(match value.as_str() {
                    "email" => StringFormat::Email,
                    "uri" => StringFormat::Uri,
                    "date" => StringFormat::Date,
                    "date-time" => StringFormat::DateTime,
                    _ => return Err(invalid_schema()),
                }),
                Some(_) => return Err(invalid_schema()),
            };
            let choices = match (field.get("enum"), field.get("oneOf")) {
                (Some(_), Some(_)) => return Err(invalid_schema()),
                (Some(values), None) => Some(string_choices(values)?),
                (None, Some(values)) => Some(titled_choices(values)?),
                (None, None) => None,
            };
            if let Some(names) = field.get("enumNames") {
                if field.get("enum").is_none() {
                    return Err(invalid_schema());
                }
                let names = names.as_array().ok_or_else(invalid_schema)?;
                if choices
                    .as_ref()
                    .is_none_or(|choices| names.len() != choices.len())
                    || names.iter().any(|name| !name.is_string())
                {
                    return Err(invalid_schema());
                }
            }
            FieldSchema::String {
                min_length,
                max_length,
                format,
                choices,
            }
        }
        Some("number") => {
            if !only_keys(
                field,
                &[
                    "type",
                    "title",
                    "description",
                    "default",
                    "minimum",
                    "maximum",
                ],
            ) {
                return Err(invalid_schema());
            }
            let minimum = optional_f64(field, "minimum")?;
            let maximum = optional_f64(field, "maximum")?;
            if minimum.zip(maximum).is_some_and(|(min, max)| min > max) {
                return Err(invalid_schema());
            }
            FieldSchema::Number { minimum, maximum }
        }
        Some("integer") => {
            if !only_keys(
                field,
                &[
                    "type",
                    "title",
                    "description",
                    "default",
                    "minimum",
                    "maximum",
                ],
            ) {
                return Err(invalid_schema());
            }
            let minimum = optional_i64(field, "minimum")?;
            let maximum = optional_i64(field, "maximum")?;
            if minimum.zip(maximum).is_some_and(|(min, max)| min > max) {
                return Err(invalid_schema());
            }
            FieldSchema::Integer { minimum, maximum }
        }
        Some("boolean") => {
            if !only_keys(field, &["type", "title", "description", "default"]) {
                return Err(invalid_schema());
            }
            FieldSchema::Boolean
        }
        Some("array") => {
            if !only_keys(
                field,
                &[
                    "type",
                    "title",
                    "description",
                    "default",
                    "items",
                    "minItems",
                    "maxItems",
                ],
            ) {
                return Err(invalid_schema());
            }
            let items = field
                .get("items")
                .and_then(Value::as_object)
                .ok_or_else(invalid_schema)?;
            let choices = if only_keys(items, &["type", "enum"])
                && items.get("type").and_then(Value::as_str) == Some("string")
            {
                string_choices(items.get("enum").ok_or_else(invalid_schema)?)?
            } else if only_keys(items, &["anyOf"]) {
                titled_choices(items.get("anyOf").ok_or_else(invalid_schema)?)?
            } else {
                return Err(invalid_schema());
            };
            let min_items = optional_u64(field, "minItems")?;
            let max_items = optional_u64(field, "maxItems")?;
            if min_items.zip(max_items).is_some_and(|(min, max)| min > max) {
                return Err(invalid_schema());
            }
            FieldSchema::MultiSelect {
                choices,
                min_items,
                max_items,
            }
        }
        _ => return Err(invalid_schema()),
    };
    if field
        .get("default")
        .is_some_and(|value| !kind.matches(value))
    {
        return Err(invalid_schema());
    }
    Ok(kind)
}

impl FieldSchema {
    fn matches(&self, value: &Value) -> bool {
        match self {
            Self::String {
                min_length,
                max_length,
                format,
                choices,
            } => {
                let Some(value) = value.as_str() else {
                    return false;
                };
                let length = value.chars().count() as u64;
                min_length.is_none_or(|min| length >= min)
                    && max_length.is_none_or(|max| length <= max)
                    && choices
                        .as_ref()
                        .is_none_or(|choices| choices.iter().any(|choice| choice == value))
                    && format.as_ref().is_none_or(|format| format.matches(value))
            }
            Self::Number { minimum, maximum } => exact_f64(value).is_some_and(|number| {
                number.is_finite()
                    && minimum.is_none_or(|min| number >= min)
                    && maximum.is_none_or(|max| number <= max)
            }),
            Self::Integer { minimum, maximum } => value.as_i64().is_some_and(|number| {
                minimum.is_none_or(|min| number >= min) && maximum.is_none_or(|max| number <= max)
            }),
            Self::Boolean => value.is_boolean(),
            Self::MultiSelect {
                choices,
                min_items,
                max_items,
            } => value.as_array().is_some_and(|items| {
                let count = items.len() as u64;
                min_items.is_none_or(|min| count >= min)
                    && max_items.is_none_or(|max| count <= max)
                    && items.iter().all(|item| {
                        item.as_str()
                            .is_some_and(|item| choices.iter().any(|choice| choice == item))
                    })
            }),
        }
    }
}

impl StringFormat {
    fn matches(&self, value: &str) -> bool {
        match self {
            Self::Email => valid_email(value),
            Self::Uri => Url::parse(value).is_ok(),
            Self::Date => NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok(),
            Self::DateTime => DateTime::parse_from_rfc3339(value).is_ok(),
        }
    }
}

// A conservative, ASCII-only email subset: reject uncommon syntax instead of
// accepting content that could fail the requested format constraint.
fn valid_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&byte))
    {
        return false;
    }
    domain.len() <= 253
        && domain.split('.').count() >= 2
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .next()
                    .is_some_and(|byte| byte.is_ascii_alphanumeric())
                && label
                    .bytes()
                    .last()
                    .is_some_and(|byte| byte.is_ascii_alphanumeric())
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

impl FormSchema {
    pub(super) fn from_prompt(request: &Value) -> Result<Self, McpRuntimeError> {
        if request.get("method").and_then(Value::as_str) != Some("elicitation/create") {
            return Err(invalid_schema());
        }
        let params = request
            .get("params")
            .and_then(Value::as_object)
            .ok_or_else(invalid_schema)?;
        if !only_keys(params, &["mode", "message", "requestedSchema", "_meta"])
            || params.get("_meta").is_some_and(|meta| !meta.is_object())
            || params
                .get("mode")
                .is_some_and(|mode| mode.as_str() != Some("form"))
            || params.get("message").and_then(Value::as_str).is_none()
        {
            return Err(invalid_schema());
        }
        let schema = params
            .get("requestedSchema")
            .and_then(Value::as_object)
            .ok_or_else(invalid_schema)?;
        if !only_keys(
            schema,
            &[
                "$schema",
                "type",
                "properties",
                "required",
                "title",
                "description",
            ],
        ) || schema.get("type").and_then(Value::as_str) != Some("object")
            || ["title", "description"]
                .iter()
                .any(|name| schema.get(*name).is_some_and(|value| !value.is_string()))
        {
            return Err(invalid_schema());
        }
        if schema.get("$schema").is_some_and(|dialect| {
            dialect.as_str() != Some("https://json-schema.org/draft/2020-12/schema")
                && dialect.as_str() != Some("https://json-schema.org/draft/2020-12/schema#")
        }) {
            return Err(invalid_schema());
        }
        let fields = schema
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(invalid_schema)?;
        let mut properties = BTreeMap::new();
        for (name, definition) in fields {
            properties.insert(name.clone(), parse_field(definition)?);
        }
        let mut required = BTreeSet::new();
        if let Some(values) = schema.get("required") {
            for name in values.as_array().ok_or_else(invalid_schema)? {
                let name = name.as_str().ok_or_else(invalid_schema)?;
                if !properties.contains_key(name) || !required.insert(name.to_owned()) {
                    return Err(invalid_schema());
                }
            }
        }
        Ok(Self {
            properties,
            required,
        })
    }

    pub(super) fn validate_content(&self, value: &Value) -> Result<(), McpRuntimeError> {
        let content = value.as_object().ok_or_else(invalid_content)?;
        if self.required.iter().any(|name| !content.contains_key(name))
            || content.iter().any(|(name, value)| {
                self.properties
                    .get(name)
                    .is_none_or(|field| !field.matches(value))
            })
        {
            return Err(invalid_content());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(schema: Value) -> Value {
        serde_json::json!({"method":"elicitation/create","params":{
            "mode":"form","message":"Profile","requestedSchema":schema
        }})
    }

    #[test]
    fn primitive_constraints_and_titled_enums_validate_submitted_content() {
        let schema = FormSchema::from_prompt(&prompt(serde_json::json!({
            "type":"object","title":"Profile","description":"Contact details","properties":{
                "name":{"type":"string","minLength":2,"maxLength":3},
                "email":{"type":"string","format":"email"},
                "site":{"type":"string","format":"uri"},
                "day":{"type":"string","format":"date"},
                "when":{"type":"string","format":"date-time"},
                "score":{"type":"number","minimum":0.5,"maximum":2.5},
                "count":{"type":"integer","minimum":1,"maximum":3},
                "enabled":{"type":"boolean","default":false},
                "role":{"type":"string","oneOf":[{"const":"r","title":"Reader"},{"const":"w","title":"Writer"}]},
                "tags":{"type":"array","minItems":1,"maxItems":2,"items":{"anyOf":[{"const":"a","title":"A"},{"const":"b","title":"B"}]}}
            },"required":["name","role"]
        }))).unwrap();
        let valid = serde_json::json!({
            "name":"éa","email":"user@example.com","site":"https://example.com/",
            "day":"2026-09-28","when":"2026-09-28T12:00:00Z",
            "score":1.5,"count":2,"enabled":true,"role":"r","tags":["a","b"]
        });
        schema.validate_content(&valid).unwrap();
        for (field, bad) in [
            ("email", serde_json::json!("invalid@")),
            ("site", serde_json::json!("not a uri")),
            ("day", serde_json::json!("2026-02-30")),
            ("when", serde_json::json!("tomorrow")),
            ("score", serde_json::json!(3.0)),
            ("score", serde_json::json!(9007199254740993u64)),
            ("count", serde_json::json!(1.5)),
            ("role", serde_json::json!("admin")),
            ("tags", serde_json::json!(["a", "c"])),
            ("enabled", serde_json::json!("true")),
        ] {
            let mut changed = valid.clone();
            changed[field] = bad;
            assert_eq!(
                schema.validate_content(&changed).unwrap_err().code,
                INVALID_CONTENT
            );
        }
    }

    #[test]
    fn malformed_form_annotations_are_rejected() {
        for annotation in [
            serde_json::json!({"title": 42}),
            serde_json::json!({"description": false}),
        ] {
            let mut schema = serde_json::json!({"type":"object","properties":{}});
            schema
                .as_object_mut()
                .unwrap()
                .extend(annotation.as_object().unwrap().clone());
            assert_eq!(
                FormSchema::from_prompt(&prompt(schema)).unwrap_err().code,
                INVALID_SCHEMA
            );
        }
    }

    #[test]
    fn unsupported_schema_features_fail_at_intake() {
        for field in [
            serde_json::json!({"type":"object","properties":{}}),
            serde_json::json!({"type":"string","pattern":".*"}),
            serde_json::json!({"type":"string","minLength":3,"maxLength":2}),
            serde_json::json!({"type":"string","enum":["a","a"]}),
            serde_json::json!({"type":"string","oneOf":[{"const":"a","title":"A"}],"enumNames":["A"]}),
            serde_json::json!({"type":"array","items":{"type":"object"}}),
            serde_json::json!({"type":"number","minimum":2,"maximum":1}),
            serde_json::json!({"type":"boolean","default":"yes"}),
        ] {
            let schema = serde_json::json!({"type":"object","properties":{"field":field}});
            assert_eq!(
                FormSchema::from_prompt(&prompt(schema)).unwrap_err().code,
                INVALID_SCHEMA
            );
        }
    }
}
