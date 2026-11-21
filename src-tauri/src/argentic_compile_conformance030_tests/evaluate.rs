//! The host test adapter only maps explicit inputs to the public pure exports.
use crate::argentic_core::{
    compile::{configuration as c, graph, host, metadata as m, plan, source},
    contract, exact,
    native::{self, a, o, s, Error, Text, Value},
};
use crate::argentic_runtime::native_json;
fn error(e: Error) -> Value {
    o([
        ("status", s("failure")),
        ("code", s(e.code)),
        ("pointer", s(e.pointer)),
        ("message", s(e.message)),
    ])
}
fn eval(op: &str, input: &Value) -> Result<String, Error> {
    let out = match op {
        "host" => {
            return host::compile(
                input.get("authored"),
                input.get("source"),
                input.get("registry"),
            )
        }
        "plan" => plan::compile(
            input.get("authored"),
            input.get("source"),
            input.get("registry"),
        ),
        "snapshot" => {
            let mut mutated = input.clone();
            let prepared = plan::prepare(
                mutated.get("authored"),
                mutated.get("source"),
                mutated.get("registry"),
            );
            let mut source = mutated.get("source").clone();
            let mut owner = source.get("owner").clone();
            if let Some(fields) = input.get("mutateSourceOwner").object() {
                for (k, v) in fields {
                    owner.set(k.clone(), v.clone());
                }
            }
            source.set("owner", owner);
            mutated.set("source", source);
            let mut registry = mutated.get("registry").clone();
            if let Some(mut agents) = registry.get("agents").array().map(<[Value]>::to_vec) {
                if let Some(agent) = agents.first_mut() {
                    if let Some(fields) = input.get("mutateAgent").object() {
                        for (key, value) in fields {
                            agent.set(key.clone(), value.clone());
                        }
                    }
                }
                registry.set("agents", a(agents));
                mutated.set("registry", registry);
            }
            plan::finish(prepared)
        }
        "graph" => {
            let doc = contract::decode_input(input.get("document"))?;
            graph::compile(exact::record(Some(&doc), "")?)?.value()
        }
        "registry" => c::capture_registry(input.get("registry"))?,
        "agent" => c::capture_agent(
            input.get("document"),
            input.get("agentName"),
            input.get("registry"),
        )?,
        "used" => {
            let doc = contract::decode_input(input.get("document"))?;
            let agent = contract::decode_input(input.get("agent"))?;
            let uses = c::used_properties(
                exact::record(Some(&doc), "")?,
                &input.get("agentName").text().unwrap().utf8().unwrap(),
                exact::record(Some(&agent), "")?,
                &input.get("pointer").text().unwrap().utf8().unwrap(),
            )?;
            a(uses.into_iter().map(|(name, p, step)| {
                a([
                    s(name),
                    s(p),
                    step.map(|v| a(v.into_iter().map(s))).unwrap_or(Value::Null),
                ])
            }))
        }
        "contract" => contract::create(input.get("input"))?,
        "copyContract" => contract::copy(input.get("contract"))?,
        "source" => m::capture_source(input.get("value"))?,
        "nativeCapture" => m::capture_native_json(
            input.get("value"),
            &input.get("pointer").text().unwrap().utf8().unwrap(),
        )?,
        "metadata" => {
            let v = input.get("value");
            let p = input.get("pointer").text().unwrap().utf8().unwrap();
            match input.get("fn").text().unwrap().utf8().unwrap().as_str() {
                "object" => {
                    m::object(v, &p, "UNSUPPORTED")?;
                    v.clone()
                }
                "array" => {
                    m::array(v, &p)?;
                    v.clone()
                }
                "text" => s(m::text(v, &p, "UNSUPPORTED")?),
                "identity" => s(m::identity(v, &p, "UNSUPPORTED")?),
                "json" => s(m::json(v, &p)?),
                _ => unreachable!(),
            }
        }
        "encodeHost" => {
            return Ok(host::encode(
                input.get("result"),
                input.get("registry"),
                input.get("validations"),
            ))
        }
        "addressOrder" => {
            return Ok(match graph::compare_addresses_en(
                &input.get("left").text().unwrap().utf8().unwrap(),
                &input.get("right").text().unwrap().utf8().unwrap(),
            ) {
                std::cmp::Ordering::Less => "-1",
                std::cmp::Ordering::Equal => "0",
                _ => "1",
            }
            .to_owned())
        }
        _ => unreachable!(),
    };
    Ok(out.stringify())
}
pub(super) fn evaluate(op: &str, json: &str) -> String {
    let input = native_json::parse(json).expect("the test input is transport JSON");
    let result = if op == "read" {
        let parsed = if let Some(hex) = input.get("hex").text().and_then(Text::utf8) {
            let bytes: Vec<u8> = hex
                .as_bytes()
                .chunks_exact(2)
                .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
                .collect();
            source::read_bytes(&bytes)
        } else {
            source::read_text(input.get("source").text().unwrap())
        };
        match parsed {
            Ok(v) => o([
                ("status", s("ok")),
                ("json", s(s(exact::encode(&v)).stringify())),
            ]),
            Err(e) => o([
                ("status", s("exception")),
                ("name", s("Error")),
                ("message", s(e)),
            ]),
        }
    } else {
        match eval(op, &input) {
            Ok(json) => o([("status", s("ok")), ("json", s(json))]),
            Err(e) => error(e),
        }
    };
    result.stringify()
}
