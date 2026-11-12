//! Complete compileHost030 facade, including entry/delivery checks and the
//! original UTF-8 transport refusal. No broker, discovery or execution occurs.
use super::{graph, plan};
use crate::argentic_core::{
    exact::{self, Object, Value as E},
    messages::{self, CapturedContent},
    native::{a, o, s, Error, Text, Value},
    route::{ItemContext, Provenance, RouteSource, RouteTarget, SourceKind},
    schema::{self, SchemaChecker},
};
pub(crate) const RESULT_LIMIT: usize = 8_000_000;
fn invalid() -> Value {
    o([
        ("valid", Value::Bool(false)),
        ("shapeValid", Value::Bool(false)),
        ("unassessed", a([])),
    ])
}
fn empty() -> &'static Object {
    crate::argentic_core::graph::empty_object()
}
fn host_message(raw: &Value, document: &Object) -> Value {
    let result = (|| -> Result<Value, Error> {
        let Some(raw) = raw.text().and_then(Text::utf8) else {
            return Ok(invalid());
        };
        let message = exact::decode(&raw)?;
        let message = exact::record(Some(&message), "")?;
        static ROOT: std::sync::OnceLock<SchemaChecker> = std::sync::OnceLock::new();
        let root=ROOT.get_or_init(||SchemaChecker::new(schema::root_with_document_defs(r##""type":"object","additionalProperties":false,"properties":{"prompt":{"$ref":"#/$defs/instructions"},"resources":{"$ref":"#/$defs/resources"}}"##).expect("code-defined host message schema")));
        let value = E::Object(exact::Object::from_entries(
            message
                .iter()
                .map(|(k, v)| (k.to_owned(), exact::values::clone(v))),
        ));
        if !root
            .check(&value)
            .map_err(|_| {
                Error::new(
                    "COMPILATION",
                    "",
                    "Invalid compilation input or inconsistent dependency contract.",
                )
            })?
            .is_empty()
        {
            return Ok(invalid());
        }
        let mut unassessed = vec![];
        let mut source = |v: &E| -> Result<(), Error> {
            let mut source = exact::record(Some(v), "")?;
            if let Some(reference) = source.get("ref") {
                let content = match document.get("content") {
                    None | Some(E::Null) => empty(),
                    value => exact::record(value, "")?,
                };
                let name = reference.as_str().filter(|name| content.contains_key(name));
                let Some(name) = name else {
                    return Err(Error::new("REFERENCE", "", "Unknown content reference."));
                };
                source = exact::record(content.get(name), "")?;
            }
            if source.contains_key("uri") {
                unassessed.push("Native content capture for URI");
            }
            Ok(())
        };
        if let Some(E::Array(prompt)) = message.get("prompt") {
            for item in prompt {
                source(item)?;
            }
        }
        if message.contains_key("resources") {
            let resources = exact::record(message.get("resources"), "")?;
            for (_, v) in resources.iter() {
                source(v)?;
            }
            if resources.len() > 0 {
                unassessed.push("Native resource delivery qualification");
            }
        }
        let mut unique = vec![];
        for item in unassessed {
            if !unique.contains(&item) {
                unique.push(item);
            }
        }
        Ok(o([
            ("valid", Value::Bool(unique.is_empty())),
            ("shapeValid", Value::Bool(true)),
            ("unassessed", a(unique.into_iter().map(s))),
        ]))
    })();
    result.unwrap_or_else(|_| invalid())
}
pub(crate) fn encode(result: &Value, registry: &Value, validations: &Value) -> String {
    let mut all = result.clone();
    all.set("capturedRegistryJson", s(registry.stringify()));
    if let Some(fields) = validations.object() {
        for (k, v) in fields {
            all.set(k.clone(), v.clone());
        }
    }
    let encoded = all.stringify();
    if encoded.len() <= RESULT_LIMIT {
        return encoded;
    }
    let mut runtime = result.get("runtime").clone();
    runtime.set("supported", Value::Bool(false));
    runtime.set(
        "diagnostics",
        a([o([
            ("code", s("INPUT_LIMIT")),
            ("pointer", s("")),
            (
                "message",
                s("Expanded compilation exceeds the native result limit."),
            ),
        ])]),
    );
    runtime.set("unassessed", a([]));
    let mut refusal = o([
        (
            "static",
            o([
                ("valid", result.get("static").get("valid").clone()),
                ("diagnostics", a([])),
            ]),
        ),
        ("runtime", runtime),
        ("plan", Value::Null),
        ("compiledPlanJson", Value::Null),
        ("productRuntimeAvailable", Value::Bool(false)),
    ]);
    for (field, property) in [
        ("entryValidation", "messageJson"),
        ("deliveryValidation", "input"),
        ("callValidation", "input"),
    ] {
        let validation = validations.get(field);
        let value = if validation.truthy() {
            if field == "callValidation" {
                o([
                    ("input", validation.get(property).clone()),
                    ("prepared", Value::Null),
                ])
            } else {
                o([
                    (property, validation.get(property).clone()),
                    ("valid", Value::Bool(false)),
                ])
            }
        } else {
            validation.clone()
        };
        refusal.set(field, value);
    }
    refusal.stringify()
}
pub(crate) fn compile(
    authored: &Value,
    source: &Value,
    observation: &Value,
) -> Result<String, Error> {
    let mut registry = o([]);
    for field in ["format", "version", "modules", "harnesses", "agents"] {
        registry.set(field, observation.get(field).clone());
    }
    if !matches!(observation.get("hostCapabilities"), Value::Undefined) {
        registry.set(
            "hostCapabilities",
            observation.get("hostCapabilities").clone(),
        );
    }
    let mut result = plan::compile(authored, source, &registry);
    let mut runtime = result.get("runtime").clone();
    runtime.set("source", source.clone());
    runtime.set("registryVersion", observation.get("version").clone());
    result.set("runtime", runtime);
    let mut document = None;
    let mut graph = None;
    if result.get("static").get("valid").truthy() {
        if let Some(raw) = authored.text().and_then(Text::utf8) {
            if let Ok(value) = exact::decode(&raw) {
                if let Some(record) = value.as_object() {
                    graph = graph::compile(record).ok();
                    document = Some(value);
                }
            }
        }
    }
    let entry = observation.get("startEntry").get("messageJson");
    let entry = if entry.is_nullish() {
        &Value::Null
    } else {
        entry
    };
    let mut check = if let (Some(document), Some(graph)) = (&document, &graph) {
        if !matches!(graph.entry, Value::Null) {
            host_message(entry, document.as_object().unwrap())
        } else if matches!(observation.get("startEntry"), Value::Null) {
            o([
                ("valid", Value::Bool(true)),
                ("shapeValid", Value::Bool(true)),
                ("unassessed", a([])),
            ])
        } else {
            invalid()
        }
    } else {
        invalid()
    };
    if let (Some(_document), Some(graph)) = (&document, &graph) {
        if let Some(step) = graph
            .steps
            .iter()
            .find(|step| crate::argentic_core::native::equal(step.get("address"), &graph.entry))
        {
            if check.get("valid").truthy()
                && entry.text().is_some()
                && ["agent", "approval", "compose"]
                    .iter()
                    .any(|kind| step.get("type").eq_str(kind))
            {
                let parts = step
                    .get("address")
                    .array()
                    .unwrap()
                    .iter()
                    .map(|v| v.text().unwrap().utf8().unwrap())
                    .collect();
                let raw = step.get("declarationJson").text().unwrap().utf8().unwrap();
                let target = RouteTarget::Step {
                    address: parts,
                    step_json: raw.clone(),
                    declaration_json: raw,
                    message_json: None,
                    each_path_json: None,
                    concurrency_json: None,
                    max_json: None,
                };
                let source = RouteSource {
                    kind: SourceKind::Entry,
                    terminal_id: "".into(),
                    producer_step: None,
                    producer_agent: None,
                    output_json: entry.text().unwrap().utf8().unwrap(),
                    provenance: Provenance {
                        instructions: vec![],
                        results: None,
                        prompt: None,
                    },
                };
                if messages::resolve_route_message(
                    &authored.text().unwrap().utf8().unwrap(),
                    &target,
                    &source,
                    &ItemContext::Absent,
                    &mut CapturedContent::default(),
                )
                .is_err()
                {
                    check = invalid();
                }
            }
        }
    }
    let input = observation.get("deliveryInput");
    let delivery = if input.object().is_some() {
        input
    } else {
        &Value::Undefined
    };
    let delivery_check = if let (Some(document), Some(graph)) = (&document, &graph) {
        let valid = matches!(graph.entry, Value::Null)
            && delivery
                .get("agentName")
                .text()
                .and_then(Text::utf8)
                .is_some_and(|name| {
                    document
                        .as_object()
                        .unwrap()
                        .get("agents")
                        .and_then(E::as_object)
                        .is_some_and(|a| a.contains_key(&name))
                });
        if valid {
            host_message(delivery.get("messageJson"), document.as_object().unwrap())
        } else {
            invalid()
        }
    } else {
        invalid()
    };
    let mut validations = o([]);
    if observation.has("startEntry") {
        let mut validation = o([("messageJson", entry.clone())]);
        for (k, v) in check.object().unwrap() {
            validation.set(k.clone(), v.clone());
        }
        validations.set("entryValidation", validation);
    }
    if observation.has("deliveryInput") {
        let mut validation = o([("input", input.clone())]);
        for (k, v) in delivery_check.object().unwrap() {
            validation.set(k.clone(), v.clone());
        }
        validations.set("deliveryValidation", validation);
    }
    if observation.has("callInput") {
        validations.set(
            "callValidation",
            o([
                ("input", observation.get("callInput").clone()),
                ("prepared", Value::Null),
            ]),
        );
    }
    Ok(encode(&result, &registry, &validations))
}
