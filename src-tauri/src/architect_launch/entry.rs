use super::{failure, LaunchFields, Result};
use serde_json::{json, Value};

/// Validate the input against the chosen version and encode Argentic's entry
/// message. Scheduled and interactive launches use the same encoding.
pub(crate) fn encode_message(
    has_entry: bool,
    requires_message: bool,
    fields: Option<&LaunchFields>,
    start_message: Option<&str>,
    launch_values: Option<&Value>,
) -> Result<Option<String>> {
    let invalid_values = |key: &str| {
        let pointer = if key.is_empty() {
            "/launchValues".into()
        } else {
            format!("/launchValues/{key}")
        };
        failure(
            "INVALID_LAUNCH_VALUES",
            &pointer,
            "The launch values do not match the version's field definitions",
        )
    };
    if has_entry {
        if let Some(fields) = fields {
            let values = launch_values.ok_or_else(|| invalid_values(""))?;
            let values = fields
                .validate_values(values)
                .map_err(|key| invalid_values(&key))?;
            // Argentic accepts a text prompt. JSON inside that prompt preserves
            // field names and types and is delivered to the entry agent.
            return Ok(Some(json!({ "prompt": values.to_string() }).to_string()));
        }
    }
    if launch_values.is_some() {
        return Err(invalid_values(""));
    }
    if !has_entry {
        return Ok(None);
    }
    if !requires_message {
        return Ok(Some("{}".into()));
    }
    let message = start_message
        .filter(|message| !message.trim().is_empty())
        .ok_or_else(|| {
            failure(
                "START_MESSAGE_REQUIRED",
                "startMessage",
                "A start message is required",
            )
        })?;
    Ok(Some(json!({ "prompt": message }).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition() -> Value {
        json!({
            "version": "macro-launch-fields/1",
            "fields": [
                {"key": "ticket", "label": "Ticket", "type": "text", "required": true},
                {"key": "number", "label": "Number", "type": "number", "required": false},
                {"key": "send", "label": "Send", "type": "boolean", "required": true}
            ]
        })
    }

    #[test]
    fn rejects_invalid_launch_fields_and_recognizes_legacy_settings() {
        assert!(LaunchFields::read(None).unwrap().is_none());
        assert!(LaunchFields::read(Some(&json!({"legacy": ["opaque"]})))
            .unwrap()
            .is_none());
        let mut duplicate = definition();
        duplicate["fields"][1]["key"] = json!("ticket");
        assert!(LaunchFields::read(Some(&duplicate)).is_err());
        duplicate["fields"][1]["key"] = json!("invalid/key");
        assert!(LaunchFields::read(Some(&duplicate)).is_err());
    }

    #[test]
    fn checks_values_and_encodes_json_in_the_entry_prompt() {
        let fields = LaunchFields::read(Some(&definition())).unwrap().unwrap();
        let send =
            |values: Option<&Value>| encode_message(true, false, Some(&fields), None, values);
        let good = json!({"ticket":"Équipe \"A\"\n#", "number":0.5, "send":false});
        let entry: Value = serde_json::from_str(&send(Some(&good)).unwrap().unwrap()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(entry["prompt"].as_str().unwrap()).unwrap(),
            good
        );
        assert!(send(Some(&json!({"ticket":"a","send":false}))).is_ok());
        assert!(send(None).is_err());
        for (bad, pointer) in [
            (json!({}), "/launchValues/ticket"),
            (
                json!({"ticket":"\u{a0}", "send":false}),
                "/launchValues/ticket",
            ),
            (
                json!({"ticket":"a", "number":"1", "send":false}),
                "/launchValues/number",
            ),
            (json!({"ticket":"a", "send":"false"}), "/launchValues/send"),
            (json!({"ticket":"a", "send":null}), "/launchValues/send"),
            (
                json!({"ticket":"a", "send":false, "extra":0}),
                "/launchValues",
            ),
            (
                json!({"ticket":"é".repeat(2049), "send":false}),
                "/launchValues/ticket",
            ),
        ] {
            let error = send(Some(&bad)).unwrap_err();
            assert_eq!(error.code, "INVALID_LAUNCH_VALUES");
            assert_eq!(error.pointer, pointer);
        }
    }

    #[test]
    fn keeps_text_and_empty_messages_for_legacy_versions() {
        assert_eq!(encode_message(false, true, None, None, None).unwrap(), None);
        assert_eq!(
            encode_message(true, false, None, None, None)
                .unwrap()
                .as_deref(),
            Some("{}")
        );
        assert_eq!(
            encode_message(true, true, None, Some("  text  "), None).unwrap(),
            Some(json!({"prompt":"  text  "}).to_string())
        );
        assert_eq!(
            encode_message(true, true, None, Some(" "), None)
                .unwrap_err()
                .code,
            "START_MESSAGE_REQUIRED"
        );
        assert!(encode_message(true, false, None, None, Some(&json!({}))).is_err());
    }
}
