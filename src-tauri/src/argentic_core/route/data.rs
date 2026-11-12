//! Non-clock computation behind the shared mailbox. HumanClock is an internal
//! ownership classification, never a fabricated mailbox reply.
use crate::argentic_core::{
    calls_data::{self as c, Error, Result},
    messages::captured::CapturedOccurrences,
    native::{self, o, s, Text, Value},
    route::preparation::{self, Content},
};
pub(crate) enum Evaluation {
    HumanClock,
    Computed(Value),
}
pub(crate) fn evaluate(
    input_json: &Text,
    decoder: &impl native::JsonDecoder,
) -> Result<Evaluation> {
    let evaluated = (|| {
        let parsed = decoder.parse(input_json)?;
        if !matches!(parsed, Value::Object(_) | Value::Array(_)) {
            return c::exception("TypeError", "Invalid route input.");
        }
        if parsed.get("operation").eq_str("humanClock") {
            return Ok(Evaluation::HumanClock);
        }
        let result = if parsed.get("operation").eq_str("prepare")
            || parsed.get("operation").eq_str("normalize")
        {
            c::evaluate_call_data(&parsed)?
        } else {
            let mut content = CapturedOccurrences::new(parsed.get("contentReceipts"))?;
            s(preparation::prepare_flow_route(
                &parsed,
                &mut Content::Occurrences(&mut content),
                decoder,
            )?
            .stringify())
        };
        Ok(Evaluation::Computed(o([
            ("kind", s("ready")),
            ("resultJson", result),
        ])))
    })();
    match evaluated {
        Err(Error::Failure(e)) => Ok(Evaluation::Computed(o([
            ("kind", s("failed")),
            ("code", s(e.code)),
            ("pointer", s(e.pointer)),
        ]))),
        Err(_) => Ok(Evaluation::Computed(o([
            ("kind", s("failed")),
            ("code", s("ROUTE_PREPARATION_FAILED")),
            ("pointer", s("")),
        ]))),
        other => other,
    }
}
