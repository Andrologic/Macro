//! Pure captured AgentWorkContract030. The input agent is an expanded, statically
//! validated declaration, as in the TS contract. No native execution is admitted.
use crate::argentic_core::{
    exact::{self, Object, Value as E},
    integers,
    native::{self, a, fail, o, s, Error, Text, Value},
};
type Result<T> = std::result::Result<T, Error>;
pub(crate) fn decode_input(v: &Value) -> Result<E> {
    let Some(text) = v.text().and_then(Text::utf8) else {
        return fail("PARSE", "", "Invalid or unsupported exact JSON.");
    };
    Ok(exact::decode(&text)?)
}
fn kind(v: &Value) -> Result<Value> {
    if ["none", "string", "list"].iter().any(|s| v.eq_str(s)) {
        Ok(v.clone())
    } else {
        fail("CORRELATION", "", "Unknown route instruction cardinality.")
    }
}
fn names(v: &Value) -> Result<Value> {
    let Some(names) = v.array() else {
        return fail(
            "CORRELATION",
            "",
            "Choice names must be distinct nonempty strings.",
        );
    };
    let mut seen = std::collections::HashSet::new();
    for name in names {
        let Some(name) = name.text() else {
            return fail(
                "CORRELATION",
                "",
                "Choice names must be distinct nonempty strings.",
            );
        };
        if name.units().is_empty() || !seen.insert(name.clone()) {
            return fail(
                "CORRELATION",
                "",
                "Choice names must be distinct nonempty strings.",
            );
        }
    }
    Ok(v.clone())
}
fn import_number(value: &E) -> Result<&str> {
    value.as_number().map(|n| n.raw()).ok_or_else(|| {
        Error::new(
            "CORRELATION",
            "",
            "An authored limit must be a JSON number.",
        )
    })
}
fn number_field(agent: &Object, key: &str, fallback: Value, positive: bool) -> Result<Value> {
    if let Some(v) = agent.get(key) {
        Ok(s(integers::integer030(import_number(v)?, positive)?))
    } else {
        Ok(fallback)
    }
}
pub(crate) fn create(input: &Value) -> Result<Value> {
    let agent_value = decode_input(input.get("agentJson"))?;
    let agent = exact::record(Some(&agent_value), "")?;
    let choices = if input.get("choices").is_nullish() {
        Value::Null
    } else {
        names(input.get("choices"))?
    };
    if choices.array().is_some_and(|a| a.is_empty()) {
        return fail(
            "CORRELATION",
            "/choices",
            "A choice-routed step needs at least one choice.",
        );
    }
    let mut routes = o([]);
    if let Some(fields) = input.get("instructionsByChoice").object() {
        for (choice, value) in fields {
            if !choices
                .array()
                .is_some_and(|names| names.iter().any(|n| n.text() == Some(choice)))
            {
                return fail(
                    "CORRELATION",
                    "/instructionsByChoice",
                    "Instruction requirements refer to an unknown choice.",
                );
            }
            routes.set(choice.clone(), kind(value)?);
        }
    }
    let none = s_none();
    let default = kind(if input.get("defaultInstructions").is_nullish() {
        &none
    } else {
        input.get("defaultInstructions")
    })?;
    if (!default.eq_str("none")
        || routes
            .object()
            .unwrap()
            .iter()
            .any(|(_, v)| !v.eq_str("none")))
        && !matches!(agent.get("instructs"), Some(E::Bool(true)))
    {
        return fail(
            "CORRELATION",
            "/instructs",
            "The route requires instructions from an agent that cannot instruct.",
        );
    }
    let mut check = Value::Null;
    if let Some(v) = agent.get("completionCheck") {
        let value = exact::record(Some(v), "")?;
        let command = exact::text(value.get("command"), "")?;
        if Text::from(command).trimmed_empty() {
            return fail(
                "CORRELATION",
                "/completionCheck/command",
                "A completion check needs a command.",
            );
        }
        let filter = if let Some(filter) = value.get("choices") {
            let filter = exact::list(Some(filter), "")?;
            let items = filter
                .iter()
                .map(|v| exact::text(Some(v), "").map(|s| s.to_owned()))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            names(&a(items.into_iter().map(s)))?
        } else {
            Value::Null
        };
        let max = if let Some(v) = value.get("maxFailures") {
            s(integers::integer030(import_number(v)?, false)?)
        } else {
            s("3")
        };
        check = o([
            ("command", s(command)),
            ("choices", filter),
            ("maxFailures", max),
        ]);
    }
    let plan = match agent.get("planFirst") {
        None | Some(E::Null) => Value::Null,
        Some(E::String(v)) if v == "auto" || v == "ask" => s(v.clone()),
        _ => return fail("CORRELATION", "/planFirst", "Unknown plan-first mode."),
    };
    let max = number_field(agent, "maxCorrections", s("2"), false)?;
    let timeout = if input.get("timeoutMs").is_nullish() {
        Value::Null
    } else {
        let Some(raw) = input.get("timeoutMs").text().and_then(Text::utf8) else {
            return fail("CORRELATION", "", "Expected an exact integer lexeme.");
        };
        s(integers::integer030(&raw, true)?)
    };
    let answer = number_field(agent, "answerTimeoutMs", Value::Null, true)?;
    Ok(o([
        ("version", s("macro-agsdl-agent-work/030")),
        ("agentJson", input.get("agentJson").clone()),
        ("choices", choices),
        ("instructionsByChoice", routes),
        ("defaultInstructions", default),
        ("maxCorrections", max),
        ("completionCheck", check),
        ("timeoutMs", timeout),
        ("answerTimeoutMs", answer),
        ("planFirst", plan),
    ]))
}
fn s_none() -> Value {
    s("none")
}
pub(crate) fn copy(input: &Value) -> Result<Value> {
    let captured = create(&o([
        ("agentJson", input.get("agentJson").clone()),
        ("choices", input.get("choices").clone()),
        (
            "instructionsByChoice",
            input.get("instructionsByChoice").clone(),
        ),
        (
            "defaultInstructions",
            input.get("defaultInstructions").clone(),
        ),
        ("timeoutMs", input.get("timeoutMs").clone()),
    ]))?;
    for field in [
        "version",
        "maxCorrections",
        "answerTimeoutMs",
        "planFirst",
        "completionCheck",
    ] {
        if !native::equal(input.get(field), captured.get(field)) {
            return fail(
                "CORRELATION",
                "",
                "Work contract differs from the captured agent declaration.",
            );
        }
    }
    Ok(captured)
}
