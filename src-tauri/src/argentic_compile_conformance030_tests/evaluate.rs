//! The host test adapter only maps explicit inputs to the public pure exports.
use crate::argentic_core::{
    compile::{configuration as c, graph, host, metadata as m, plan},
    contract, exact,
    native::{self, a, o, s, Error, Text, Value},
    validate::validate_document_with_budget,
    SourceBudget,
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
    let budget = SourceBudget::default();
    let out = match op {
        "host" => {
            return host::compile(
                input.get("authored"),
                input.get("source"),
                input.get("registry"),
                &budget,
            )
        }
        "plan" => plan::finish(&mut plan::prepare(
            input.get("authored"),
            input.get("source"),
            input.get("registry"),
            &budget,
        )),
        "snapshot" => {
            let mut mutated = input.clone();
            let mut prepared = plan::prepare(
                mutated.get("authored"),
                mutated.get("source"),
                mutated.get("registry"),
                &budget,
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
            plan::finish(&mut prepared)
        }
        "graph" => {
            let doc = contract::decode_input(input.get("document"))?;
            let mut result = o([]);
            graph::compile(exact::record(Some(&doc), "")?)?.append_to(&mut result);
            result
        }
        "registry" => c::capture_registry(input.get("registry"), &budget)?.json,
        "agent" => {
            let registry = c::capture_registry(input.get("registry"), &budget)?;
            let document = c::json(input.get("document"), "/document", &budget)?.1;
            let record = exact::record(Some(&document), "")?;
            let validation = validate_document_with_budget(&document, &registry.modules, &budget)
                .map_err(|_| {
                Error::new(
                    "COMPILATION",
                    "",
                    "Invalid compilation input or inconsistent dependency contract.",
                )
            })?;
            if let Some(error) = validation
                .diagnostics
                .into_iter()
                .find(|d| d.severity == "error")
            {
                return Err(Error::new(error.code, error.path, error.message));
            }
            let name = input.get("agentName");
            let uses = c::step_uses(record, &budget)?;
            let name_utf8 = name.text().and_then(Text::utf8).unwrap_or_default();
            c::capture_agent(
                record,
                name,
                &registry.json,
                &registry.modules,
                uses.get(&name_utf8).map(Vec::as_slice).unwrap_or_default(),
                &budget,
                &registry.ranges,
            )?
        }
        "used" => {
            let doc = contract::decode_input(input.get("document"))?;
            let agent = contract::decode_input(input.get("agent"))?;
            let all_uses = c::step_uses(exact::record(Some(&doc), "")?, &budget)?;
            let name = input.get("agentName").text().unwrap().utf8().unwrap();
            let uses = c::used_properties(
                exact::record(Some(&agent), "")?,
                &input.get("pointer").text().unwrap().utf8().unwrap(),
                all_uses.get(&name).map(Vec::as_slice).unwrap_or_default(),
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
                "json" => s(c::json(v, &p, &budget)?.0),
                _ => unreachable!(),
            }
        }
        "encodeHost" => {
            return host::encode(
                input.get("result").clone(),
                input.get("registry"),
                input.get("validations"),
                &budget,
            );
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
fn read_authored(bytes: &[u8]) -> Result<exact::Value, String> {
    let parsed = exact::scan::parse_v030(bytes)
        .map_err(|error| format!("Invalid JSON at byte {}.", error.byte))?;
    if parsed.tree.as_object().is_none() {
        return Err("An AgSDL document must be a JSON object.".into());
    }
    Ok(parsed.tree)
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
            read_authored(&bytes)
        } else {
            input
                .get("source")
                .text()
                .and_then(Text::utf8)
                .ok_or_else(|| "Invalid JSON: unpaired UTF-16 surrogate.".to_owned())
                .and_then(|text| read_authored(text.as_bytes()))
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
