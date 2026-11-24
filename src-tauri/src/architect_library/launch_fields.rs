use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

const MAX_FIELDS: usize = 16;
const MAX_TEXT_BYTES: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchFields {
    version: String,
    fields: Vec<LaunchField>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchField {
    key: String,
    label: String,
    #[serde(rename = "type")]
    kind: FieldType,
    required: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum FieldType {
    Text,
    Number,
    Boolean,
}

impl LaunchFields {
    /// Earlier settings preserved opaque launchFields values. Only the versioned
    /// form declares fields that take effect at launch.
    pub(crate) fn read(raw: Option<&Value>) -> Result<Option<Self>, &'static str> {
        let Some(raw) = raw.filter(|raw| {
            raw.get("version").and_then(Value::as_str) == Some("macro-launch-fields/1")
        }) else {
            return Ok(None);
        };
        let schema: Self =
            serde_json::from_value(raw.clone()).map_err(|_| "Invalid launch field definition")?;
        let mut keys = BTreeSet::new();
        if schema.fields.is_empty()
            || schema.fields.len() > MAX_FIELDS
            || !schema.fields.iter().all(|field| {
                let key = field.key.as_bytes();
                key.first().is_some_and(u8::is_ascii_alphabetic)
                    && key.len() <= 64
                    && key.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
                    && keys.insert(field.key.as_str())
                    && !field.label.trim().is_empty()
                    && field.label.chars().count() <= 80
                    && !field.label.chars().any(char::is_control)
            })
        {
            return Err("Invalid launch field definition");
        }
        Ok(Some(schema))
    }

    /// Returns the offending field key, or an empty key for a non-object.
    pub(crate) fn validate_values<'a>(&self, values: &'a Value) -> Result<&'a Value, String> {
        let object = values.as_object().ok_or_else(String::new)?;
        for field in &self.fields {
            let valid = match object.get(&field.key) {
                None => !field.required,
                Some(value) => match field.kind {
                    FieldType::Text => value.as_str().is_some_and(|text| {
                        !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES
                    }),
                    FieldType::Number => value.as_f64().is_some_and(f64::is_finite),
                    FieldType::Boolean => value.is_boolean(),
                },
            };
            if !valid {
                return Err(field.key.clone());
            }
        }
        if object.len() > self.fields.len()
            || object
                .keys()
                .any(|key| !self.fields.iter().any(|field| field.key == *key))
        {
            return Err(String::new());
        }
        Ok(values)
    }
}
