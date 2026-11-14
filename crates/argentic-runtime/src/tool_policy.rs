//! Frozen native write ceiling shared with host tool admission.
/// Narrow host-specific transport used while the document reader remains at 0.2.
pub fn validate_agsdl_write_rules(rules: &serde_json::Value) -> Result<(), &'static str> {
    let Some(rules) = rules.as_array() else {
        return Err("writeRules must be an array");
    };
    for rule in rules {
        let Some(fields) = rule.as_object() else {
            return Err("Write rules must be objects");
        };
        if rule["action"] != "write"
            || !matches!(rule["effect"].as_str(), Some("allow" | "deny"))
            || rule.get("match").is_some_and(|value| !value.is_string())
            || fields
                .keys()
                .any(|key| !matches!(key.as_str(), "action" | "effect" | "match"))
        {
            return Err("Only write allow/deny rules with an optional string match are supported");
        }
    }
    Ok(())
}

/// Native Codex tools cannot consult Macro's per-invocation policy. Grant less
/// by making the entire workspace read-only whenever a write denial is frozen.
pub fn agsdl_native_read_only(permissions: &serde_json::Value) -> bool {
    permissions["readOnly"] == true
        || permissions["mode"] != "Implement"
        || permissions.get("writeRules").is_some_and(|rules| {
            validate_agsdl_write_rules(rules).is_err()
                || rules
                    .as_array()
                    .is_some_and(|rules| rules.iter().any(|rule| rule["effect"] == "deny"))
        })
}
