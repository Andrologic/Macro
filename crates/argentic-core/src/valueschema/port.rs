//! Submission adapter of `src/services/agsdlExecution/valueSchemaPort030.ts`.
//!
//! The TS port has a second branch that re-parses values when the reader and
//! execution scanners use different `NumberToken` classes. The Rust core has
//! a single token type, so only the direct branch exists here.
use super::{validate, OutsideShape, PointerPart};
use crate::argentic_core::exact::Value;

/// `{ pointer, rule: 'VALUE_SCHEMA', message }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ValueSchemaDiagnostic {
    pub(crate) pointer: String,
    pub(crate) rule: &'static str,
    pub(crate) message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PortRefusal {
    /// The schema breaks the helper precondition.
    OutsideShape(OutsideShape),
    /// The pointer starts with a scalar outside the BMP: JS `slice(1)` would
    /// keep half of it, a string Rust cannot hold.
    SplitScalar,
}

/// Splits the submission pointer like the TS port: drop the first UTF-16
/// unit, split on `/`, then unescape `~1` before `~0`.
fn path(pointer: &str) -> Result<Vec<PointerPart>, PortRefusal> {
    let Some(first) = pointer.chars().next() else {
        return Ok(Vec::new());
    };
    if first.len_utf16() > 1 {
        return Err(PortRefusal::SplitScalar);
    }
    Ok(pointer[first.len_utf8()..]
        .split('/')
        .map(|part| PointerPart::Key(part.replace("~1", "/").replace("~0", "~")))
        .collect())
}

/// `connectValueSchemaValidator030(...)(value, schema, pointer)`.
pub(crate) fn validate_value_schema030(
    value: &Value,
    schema: &Value,
    pointer: &str,
) -> Result<Vec<ValueSchemaDiagnostic>, PortRefusal> {
    let path = path(pointer)?;
    let problems = validate(value, schema, &path).map_err(PortRefusal::OutsideShape)?;
    Ok(problems
        .into_iter()
        .map(|(pointer, message)| ValueSchemaDiagnostic {
            pointer,
            rule: "VALUE_SCHEMA",
            message,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::argentic_core::exact::decode;

    #[test]
    fn diagnostics_keep_the_submission_pointer() {
        let schema = decode(r#"{"type":"object","properties":{"n":{"type":"integer"}},"additionalProperties":false}"#).unwrap();
        let value = decode(r#"{"n":1.5,"x~":0}"#).unwrap();
        let diagnostics = validate_value_schema030(&value, &schema, "/results/a~1b~0").unwrap();
        assert_eq!(
            diagnostics
                .iter()
                .map(|d| (d.pointer.as_str(), d.rule, d.message.as_str()))
                .collect::<Vec<_>>(),
            [
                ("/results/a~1b~0/n", "VALUE_SCHEMA", "expected integer"),
                ("/results/a~1b~0/x~0", "VALUE_SCHEMA", "unknown \"x~\"")
            ]
        );
        assert_eq!(
            validate_value_schema030(&value, &schema, "").unwrap().len(),
            2
        );
        assert_eq!(
            validate_value_schema030(&value, &schema, "𝄞a"),
            Err(PortRefusal::SplitScalar)
        );
    }
}
