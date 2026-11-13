use super::*;
use crate::argentic_core::{
    contract,
    exact::BigInteger,
    native::{a, JsonDecoder},
};
pub(crate) const EMPTY_JOURNAL: &str = "{\"format\":\"macro-agsdl-work-journal/1\",\"events\":[]}";

pub(crate) fn evaluate_journal(
    state_json: &Value,
    expected_revision: &Value,
    event_json: &Value,
    owner: &Value,
    contract: &Value,
    options: &Value,
    decoder: &impl JsonDecoder,
) -> Result<Value> {
    let revision = native_string(expected_revision);
    let revision = revision.utf8().unwrap_or_default();
    let digits = revision.as_str();
    let canonical = digits == "0"
        || !digits.starts_with('0')
            && !digits.is_empty()
            && digits.bytes().all(|b| b.is_ascii_digit());
    if !canonical {
        return plain("Invalid work journal revision.");
    }
    let state = parse(decoder, state_json)?;
    let Some(fields) = state.object() else {
        return plain("Invalid work journal.");
    };
    let events = state.get("events").array();
    if !state.get("format").eq_str("macro-agsdl-work-journal/1")
        || events.is_none()
        || fields
            .iter()
            .any(|(k, _)| !k.eq_str("format") && !k.eq_str("events"))
        || BigInteger::from_canonical_unsigned(digits)
            != Some(BigInteger::from_usize(events.map_or(0, |a| a.len())))
    {
        return plain("Work journal and native revision differ.");
    }
    let mut entries = vec![];
    let mut controller = Controller::new(owner, contract, options)?;
    for raw in events.unwrap() {
        let Some(fields) = raw.object() else {
            return plain("Invalid work journal entry.");
        };
        if raw.get("eventJson").text().is_none()
            || raw.get("receiptJson").text().is_none()
            || fields
                .iter()
                .any(|(k, _)| !k.eq_str("eventJson") && !k.eq_str("receiptJson"))
        {
            return plain("Invalid work journal entry.");
        }
        let event = parse(decoder, raw.get("eventJson"))?;
        let receipt = controller.dispatch(&event)?;
        if !raw.get("receiptJson").eq_str(&receipt.stringify()) {
            return plain("Work journal receipt cannot be reproduced.");
        }
        entries.push(o([
            ("eventJson", raw.get("eventJson").clone()),
            ("receiptJson", raw.get("receiptJson").clone()),
        ]));
    }
    let event = parse(decoder, event_json)?;
    let receipt = controller.dispatch(&event)?.stringify();
    entries.push(o([
        ("eventJson", event_json.clone()),
        ("receiptJson", s(receipt.clone())),
    ]));
    let journal = o([
        ("format", s("macro-agsdl-work-journal/1")),
        ("events", a(entries)),
    ]);
    Ok(o([
        ("stateJson", s(journal.stringify())),
        ("receiptJson", s(receipt)),
    ]))
}

/// The context is explicit native data, never an application-generated type.
/// This evaluator checks correlation only; the caller supplies native authority.
pub(crate) fn evaluate_host(input: &Value, decoder: &impl JsonDecoder) -> Result<Value> {
    let context = input.get("context");
    access(context, "context.work")?;
    access(context.get("work"), "context.work.agentInstanceId")?;
    if !context.get("work").get("agentInstanceId").truthy() {
        return plain("Work context has no attributed agent instance.");
    }
    access(context.get("owner"), "context.owner.systemStartId")?;
    if !context.get("work").get("agentInstanceId").truthy()
        || !same(
            context.get("owner").get("systemStartId"),
            context.get("work").get("systemStartId"),
        )
    {
        return plain("Work context has no attributed agent instance.");
    }
    let owner = o([
        (
            "systemStartId",
            context.get("owner").get("systemStartId").clone(),
        ),
        (
            "activationId",
            context.get("work").get("activationId").clone(),
        ),
        (
            "agentInstanceId",
            context.get("work").get("agentInstanceId").clone(),
        ),
        ("ownerEpoch", context.get("owner").get("ownerEpoch").clone()),
    ]);
    let event = parse(decoder, input.get("eventJson"))?;
    if event.object().is_none() || !event.has("owner") || !event.has("eventId") {
        return plain("Invalid work event envelope.");
    }
    let event_owner = event.get("owner");
    if !same(event.get("eventId"), input.get("eventId"))
        || event_owner.object().is_none()
        || owner.object().unwrap().iter().any(|(k, v)| {
            !same(v, event_owner.get_text(k)) || matches!(event_owner.get_text(k), Value::Undefined)
        })
    {
        return plain("Work event attribution differs from the native job.");
    }
    let contract = contract::copy(&parse(decoder, input.get("contractJson"))?)?;
    let options = parse(decoder, input.get("optionsJson"))?;
    evaluate_journal(
        input.get("stateJson"),
        input.get("expectedRevision"),
        input.get("eventJson"),
        &owner,
        &contract,
        &options,
        decoder,
    )
}
