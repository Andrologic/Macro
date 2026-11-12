//! Pure computation behind the shared route mailbox, including human clocks.
use crate::argentic_core::{
    calls_data::{self as c, Error, Result},
    clock,
    messages::captured::CapturedOccurrences,
    native::{self, o, s, Text, Value},
    route::preparation::{self, Content},
    work,
};
pub(crate) fn evaluate(input_json: &Text, decoder: &impl native::JsonDecoder) -> Result<Value> {
    let evaluated = (|| {
        let parsed = decoder.parse(input_json)?;
        if !matches!(parsed, Value::Object(_) | Value::Array(_)) {
            return c::exception("TypeError", "Invalid route input.");
        }
        if parsed.get("operation").eq_str("humanClock") {
            let input = parsed.get("input");
            let result = (|| -> work::Result<Value> {
                work::access(input, "input.owner")?;
                let options = work::parse(decoder, input.get("optionsJson"))?;
                clock::evaluate_host(
                    input.get("owner"),
                    input.get("eventId"),
                    input.get("expectedRevision"),
                    input.get("stateJson"),
                    input.get("eventJson"),
                    &options,
                    decoder,
                )
            })()
            .map_err(|e| match e {
                work::Error::Failure(e) => Error::Failure(e),
                work::Error::Exception { name, message } => Error::Exception { name, message },
            })?;
            return Ok(o([
                ("kind", s("ready")),
                ("resultJson", s(result.stringify())),
            ]));
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
        Ok(o([("kind", s("ready")), ("resultJson", result)]))
    })();
    match evaluated {
        Err(Error::Failure(e)) => Ok(o([
            ("kind", s("failed")),
            ("code", s(e.code)),
            ("pointer", s(e.pointer)),
        ])),
        Err(_) => Ok(o([
            ("kind", s("failed")),
            ("code", s("ROUTE_PREPARATION_FAILED")),
            ("pointer", s("")),
        ])),
        other => other,
    }
}
