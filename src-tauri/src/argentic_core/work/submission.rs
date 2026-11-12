use super::*;
use crate::argentic_core::{
    contract,
    exact::{Object, Value as E},
    native::a,
    valueschema::port,
};
fn agent(contract: &Value) -> Result<E> {
    Ok(contract::decode_input(contract.get("agentJson"))?)
}
fn results(agent: &Object) -> Result<&Object> {
    static EMPTY: std::sync::OnceLock<E> = std::sync::OnceLock::new();
    let empty = EMPTY.get_or_init(|| E::Object(Object::from_entries([])));
    exact::record(
        Some(match agent.get("results") {
            None | Some(E::Null) => empty,
            Some(v) => v,
        }),
        "",
    )
    .map_err(Into::into)
}
pub(crate) fn requires_submission(contract: &Value) -> Result<bool> {
    let agent = agent(contract)?;
    let declared = results(exact::record(Some(&agent), "")?)?;
    Ok(!matches!(contract.get("choices"), Value::Null)
        || !matches!(contract.get("completionCheck"), Value::Null)
        || !contract.get("defaultInstructions").eq_str("none")
        || contract
            .get("instructionsByChoice")
            .object()
            .is_some_and(|a| a.iter().any(|(_, v)| !v.eq_str("none")))
        || {
            let mut required = false;
            for (_, v) in declared.iter() {
                if matches!(
                    exact::record(Some(v), "")?.get("required"),
                    Some(E::Bool(true))
                ) {
                    required = true;
                    break;
                }
            }
            required
        })
}
pub(crate) fn validate_submission(contract: &Value, raw: &Value) -> Result<Value> {
    let mut diagnostics = vec![];
    let argument_text = if matches!(raw, Value::Undefined) {
        Text::default()
    } else {
        native_string(raw)
    };
    let submission = match exact_text(&argument_text) {
        Ok(v) => v,
        Err(Error::Failure(_)) => {
            return Ok(o([
                ("kind", s("invalid")),
                (
                    "diagnostics",
                    a([diagnostic(
                        "",
                        "JSON",
                        "Result tool arguments must be exact JSON without duplicate keys.",
                    )]),
                ),
            ]))
        }
        Err(e) => return Err(e),
    };
    let Some(submission) = submission.as_object() else {
        return Ok(o([
            ("kind", s("invalid")),
            (
                "diagnostics",
                a([diagnostic(
                    "",
                    "OBJECT",
                    "Result tool arguments must be an object.",
                )]),
            ),
        ]));
    };
    for (key, _) in submission.iter() {
        if !["results", "choice", "instructions"].contains(&key) {
            diagnostics.push(diagnostic(
                &exact::at("", key),
                "UNKNOWN_ARGUMENT",
                "Unknown result tool argument.",
            ));
        }
    }
    let agent = agent(contract)?;
    let agent = exact::record(Some(&agent), "")?;
    let declared = results(agent)?;
    let empty = E::Object(Object::from_entries([]));
    let supplied = submission.get("results").unwrap_or(&empty);
    if let Some(values) = supplied.as_object() {
        for (name, _) in values.iter() {
            if !declared.contains_key(name) {
                diagnostics.push(diagnostic(
                    &exact::at("/results", name),
                    "UNKNOWN_RESULT",
                    "Result name is not declared.",
                ));
            }
        }
        for (name, declaration) in declared.iter() {
            let rule = exact::record(Some(declaration), "")?;
            let p = exact::at("/results", name);
            let Some(value) = values.get(name) else {
                if matches!(rule.get("required"), Some(E::Bool(true))) {
                    diagnostics.push(diagnostic(
                        &p,
                        "REQUIRED_RESULT",
                        "Required result is missing.",
                    ));
                }
                continue;
            };
            let media = rule
                .get("mediaType")
                .and_then(E::as_str)
                .unwrap_or("application/json");
            if media == "application/json" || media.ends_with("+json") {
                if let Some(schema) = rule.get("schema") {
                    let issues =
                        port::validate_value_schema030(value, schema, &p).map_err(|_| {
                            Error::Exception {
                                name: Text::from("Error"),
                                message: Text::from("Value schema is outside its validated shape."),
                            }
                        })?;
                    diagnostics.extend(
                        issues
                            .into_iter()
                            .map(|d| diagnostic(&d.pointer, d.rule, &d.message)),
                    );
                }
            } else if media.starts_with("text/") {
                if value.as_str().is_none() {
                    diagnostics.push(diagnostic(
                        &p,
                        "TEXT_RESULT",
                        "A text result must be a string.",
                    ));
                }
            } else if value.as_str().is_none_or(|v| !absolute_uri(v)) {
                diagnostics.push(diagnostic(
                    &p,
                    "FILE_URI",
                    "A file result must be an absolute URI of the produced file.",
                ));
            }
        }
    } else {
        diagnostics.push(diagnostic(
            "/results",
            "RESULTS_OBJECT",
            "Results must be an object of result names to direct values.",
        ));
    }
    let choice = submission.get("choice").and_then(E::as_str);
    if !matches!(contract.get("choices"), Value::Null) {
        if !choice.is_some_and(|choice| {
            contract
                .get("choices")
                .array()
                .is_some_and(|a| a.iter().any(|v| v.eq_str(choice)))
        }) {
            diagnostics.push(diagnostic(
                "/choice",
                "CHOICE",
                "Choose one of the current step choices.",
            ));
        }
    } else if submission.contains_key("choice") {
        diagnostics.push(diagnostic(
            "/choice",
            "UNEXPECTED_CHOICE",
            "This work does not route by choice.",
        ));
    }
    let by_choice = choice.map(|c| contract.get("instructionsByChoice").get(c));
    let kind = by_choice
        .filter(|v| !matches!(v, Value::Undefined))
        .unwrap_or_else(|| contract.get("defaultInstructions"));
    let mission = submission.get("instructions");
    if let Some(mission) = mission {
        if !matches!(agent.get("instructs"), Some(E::Bool(true))) {
            diagnostics.push(diagnostic(
                "/instructions",
                "INSTRUCTS",
                "This agent is not authorized to write missions.",
            ));
        }
        if kind.eq_str("list") {
            if !matches!(mission,E::Array(a) if a.iter().all(|v|v.as_str().is_some())) {
                diagnostics.push(diagnostic(
                    "/instructions",
                    "INSTRUCTIONS_LIST",
                    "This route expects a list of mission strings.",
                ));
            }
        } else if mission.as_str().is_none() {
            diagnostics.push(diagnostic(
                "/instructions",
                "INSTRUCTIONS_STRING",
                "This route expects a mission string.",
            ));
        }
    } else if !kind.eq_str("none") {
        diagnostics.push(diagnostic(
            "/instructions",
            "INSTRUCTIONS_REQUIRED",
            "The selected route requires instructions.",
        ));
    }
    if !diagnostics.is_empty() {
        return Ok(o([("kind", s("invalid")), ("diagnostics", a(diagnostics))]));
    }
    let check = contract.get("completionCheck");
    let check_required = !matches!(check, Value::Null)
        && (matches!(check.get("choices"), Value::Null)
            || choice.is_some_and(|c| {
                check
                    .get("choices")
                    .array()
                    .is_some_and(|a| a.iter().any(|v| v.eq_str(c)))
            }));
    Ok(o([
        ("kind", s("candidate")),
        (
            "candidate",
            o([
                (
                    "submissionJson",
                    s(exact::encode(&E::Object(Object::from_entries(
                        submission
                            .iter()
                            .map(|(k, v)| (k.to_owned(), exact::values::clone(v))),
                    )))),
                ),
                ("resultsJson", s(exact::encode(supplied))),
                ("choice", choice.map(s).unwrap_or(Value::Null)),
                ("instructions", instructions(mission)),
                ("checkRequired", Value::Bool(check_required)),
            ]),
        ),
    ]))
}
fn absolute_uri(raw: &str) -> bool {
    let Some((scheme, _)) = raw.split_once(':') else {
        return false;
    };
    if scheme.is_empty()
        || !scheme.as_bytes()[0].is_ascii_alphabetic()
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
    {
        return false;
    }
    if raw
        .encode_utf16()
        .any(|u| Text::from_units(vec![u]).trimmed_empty())
        || url::Url::parse(raw).is_err()
    {
        return false;
    }
    let b = raw.as_bytes();
    !b.iter().enumerate().any(|(i, c)| {
        *c == b'%'
            && (b.get(i + 1).is_none_or(|c| !c.is_ascii_hexdigit())
                || b.get(i + 2).is_none_or(|c| !c.is_ascii_hexdigit()))
    })
}
