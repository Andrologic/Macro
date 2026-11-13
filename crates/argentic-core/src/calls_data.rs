//! Pure call data. Native admission, transports and physical receipts remain with
//! the host. Ordinary UTF-16 metadata is separate from authored exact JSON.
use super::{
    error::Failure,
    exact::{
        self,
        values::{clone, decimal},
        Object, Value as E,
    },
    messages,
    native::{self, o, s, Text, Value},
};
#[derive(Clone, Debug)]
pub(crate) enum Error {
    Failure(native::Error),
    Exception { name: Text, message: Text },
}
pub(crate) type Result<T> = std::result::Result<T, Error>;
impl From<Failure> for Error {
    fn from(e: Failure) -> Self {
        Self::Failure(e.into())
    }
}
impl From<native::Error> for Error {
    fn from(e: native::Error) -> Self {
        Self::Failure(e)
    }
}
impl From<native::SyntaxError> for Error {
    fn from(e: native::SyntaxError) -> Self {
        Self::Exception {
            name: Text::from("SyntaxError"),
            message: e.message,
        }
    }
}
pub(crate) fn exception<T>(name: &str, message: &str) -> Result<T> {
    Err(Error::Exception {
        name: Text::from(name),
        message: Text::from(message),
    })
}
pub(crate) fn fail<T>(code: &'static str, p: &str, message: &str) -> Result<T> {
    Err(Failure::new(code, p, message).into())
}
pub(crate) fn text(v: &Value) -> Result<&Text> {
    v.text().ok_or_else(|| Error::Exception {
        name: Text::from("TypeError"),
        message: Text::from("Expected text."),
    })
}
pub(crate) fn decode(v: &Value) -> Result<E> {
    let raw = match v {
        Value::String(t) => t.utf8(),
        Value::Undefined => Some(String::new()),
        _ => Some(v.stringify()),
    };
    Ok(exact::decode(&raw.ok_or_else(|| {
        Failure::new("PARSE", "", "Invalid or unsupported exact JSON.")
    })?)?)
}
pub(crate) fn dto<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T> {
    serde_json::from_str(&v.stringify()).map_err(|_| Error::Exception {
        name: Text::from("TypeError"),
        message: Text::from("Invalid captured data."),
    })
}
pub(crate) fn encoded(v: &E) -> Value {
    s(exact::encode(v))
}
pub(crate) fn prepare_call(step_json: &Value, source: &Value) -> Result<Value> {
    let step = decode(step_json)?;
    let step = exact::record(Some(&step), "")?;
    let has = |k| step.contains_key(k);
    if step.get("type").and_then(E::as_str) != Some("call") || has("command") == has("mcp") {
        return fail("SHAPE", "", "A call has exactly one command or MCP tool.");
    }
    if has("command") {
        if has("arguments") || has("answerTimeoutMs") {
            return fail("SHAPE", "", "MCP-only fields on command.");
        }
        let command = exact::text(step.get("command"), "")?;
        if has("parse")
            && !matches!(
                step.get("parse").and_then(E::as_str),
                Some("lines" | "json")
            )
        {
            return fail("SHAPE", "/parse", "Unknown command parser.");
        }
        let mut result = o([("kind", s("command")), ("command", s(command))]);
        if let Some(parse) = step.get("parse") {
            result.set("parse", s(exact::text(Some(parse), "")?));
        }
        return Ok(result);
    }
    if has("parse") {
        return fail("SHAPE", "/parse", "parse applies only to commands.");
    }
    let mcp = exact::record(step.get("mcp"), "")?;
    if mcp.iter().any(|(k, _)| !matches!(k, "server" | "tool")) {
        return fail("SHAPE", "/mcp", "Invalid MCP target.");
    }
    let output = decode(source.get("outputJson"))?;
    let empty = E::Object(Object::default());
    let arguments = step
        .get("arguments")
        .filter(|v| !matches!(v, E::Null))
        .unwrap_or(&empty);
    let mut args = Object::default();
    for (name, raw) in exact::record(Some(arguments), "")?.iter() {
        let operand = exact::record(Some(raw), "")?;
        if operand.len() != 1 || operand.contains_key("value") == operand.contains_key("path") {
            return fail("OPERAND", "", "An operand contains exactly value or path.");
        }
        let value = if let Some(value) = operand.get("value") {
            clone(value)
        } else {
            messages::read_path(&output, operand.get("path").unwrap())?
        };
        args.set(name.to_owned(), value);
    }
    Ok(o([
        ("kind", s("mcp")),
        ("server", s(exact::text(mcp.get("server"), "")?)),
        ("tool", s(exact::text(mcp.get("tool"), "")?)),
        ("argumentsJson", encoded(&E::Object(args))),
    ]))
}
pub(crate) fn command_output(prepared: &Value, receipt: &Value) -> Result<Value> {
    if !receipt.get("complete").truthy() {
        return fail(
            "OUTPUT_INVALID",
            "",
            "Cannot normalize an incomplete command receipt.",
        );
    }
    let exit = decode(receipt.get("exitCodeJson"))?;
    let Some(number) = exit.as_number() else {
        return fail("OUTPUT_INVALID", "", "Expected an integer exit status.");
    };
    let decimal = decimal(number);
    if decimal.exponent.is_negative() {
        return fail("OUTPUT_INVALID", "", "Expected an integer exit status.");
    }
    let mut data = format!(
        "{{\"exitCode\":{},\"output\":{}",
        exact::encode(&exit),
        receipt.get("output").stringify()
    );
    if prepared.get("parse").eq_str("lines") {
        let parts: Vec<_> = text(receipt.get("stdout"))?
            .units()
            .split(|u| *u == 10)
            .collect();
        let values = parts.iter().enumerate().filter_map(|(i, line)| {
            let line = if i + 1 < parts.len() && line.last() == Some(&13) {
                &line[..line.len() - 1]
            } else {
                line
            };
            (!line.is_empty()).then(|| s(Text::from_units(line.to_vec())))
        });
        data.push_str(&format!(",\"value\":{}", native::a(values).stringify()));
    } else if prepared.get("parse").eq_str("json") {
        let value = decode(receipt.get("stdout")).map_err(|_| {
            Error::from(Failure::new(
                "OUTPUT_INVALID",
                "",
                "Command stdout is not one exact JSON value.",
            ))
        })?;
        data.push_str(&format!(",\"value\":{}", exact::encode(&value)));
    }
    data.push('}');
    Ok(s(format!(
        "{{\"outcome\":\"{}\",\"data\":{data}}}",
        if decimal.digits == "0" {
            "passed"
        } else {
            "failed"
        }
    )))
}
pub(crate) fn mcp_output(receipt: &Value) -> Result<Value> {
    let data = if receipt.has("structuredContentJson") {
        exact::encode(&decode(receipt.get("structuredContentJson"))?)
    } else {
        receipt.get("text").stringify()
    };
    Ok(s(format!(
        "{{\"outcome\":\"{}\",\"data\":{data}}}",
        if receipt.get("isError").truthy() {
            "failed"
        } else {
            "passed"
        }
    )))
}
pub(crate) fn evaluate_call_data(input: &Value) -> Result<Value> {
    let result = (|| {
        if input.get("operation").eq_str("prepare") {
            Ok(o([
                ("kind", s("prepared")),
                (
                    "prepared",
                    prepare_call(input.get("stepJson"), input.get("source"))?,
                ),
            ]))
        } else {
            let output = if input.get("prepared").get("kind").eq_str("command") {
                command_output(input.get("prepared"), input.get("receipt"))?
            } else {
                mcp_output(input.get("receipt"))?
            };
            Ok(o([("kind", s("completed")), ("outputJson", output)]))
        }
    })();
    match result {
        Err(Error::Failure(e)) => Ok(s(
            o([("kind", s("failed")), ("code", s(e.code))]).stringify()
        )),
        Ok(v) => Ok(s(v.stringify())),
        Err(e) => Err(e),
    }
}
