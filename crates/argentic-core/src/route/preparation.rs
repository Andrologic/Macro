//! Preparation of the reducer-selected route. Captured facts are inputs, never
//! permission to read content, execute calls, or commit a route.
use crate::argentic_core::{
    calls_data::{self as c, Error, Result},
    exact::{self, Value as E},
    messages::{
        self,
        captured::{CapturedOccurrences, CapturedReceipts},
        CapturedContent,
    },
    native::{self, a, o, s, Value},
    route::{
        self, Expansion, ItemContext, RouteSource, RouteTarget, Scope, ScopeStep, TargetBatch,
    },
};
use std::collections::HashSet;
pub(crate) enum Content<'a> {
    None,
    Shared(&'a mut CapturedReceipts),
    Occurrences(&'a mut CapturedOccurrences),
}
fn get<'a>(v: &'a E, k: &str) -> Option<&'a E> {
    v.as_object().and_then(|o| o.get(k))
}
fn field<'a>(v: &'a E, k: &str) -> Result<&'a E> {
    get(v, k).ok_or_else(|| {
        crate::argentic_core::error::Failure::new("INVALID_RECORD", "", "Expected an object.")
            .into()
    })
}
fn list(v: Option<&E>) -> Result<&[E]> {
    Ok(exact::list(v, "")?)
}
fn txt(v: Option<&E>) -> Result<&str> {
    Ok(exact::text(v, "")?)
}
fn eq_native(e: Option<&E>, v: &Value) -> bool {
    e.is_some_and(|e| exact::decode(&v.stringify()).is_ok_and(|v| exact::equal(e, &v)))
}
fn correlation<T>(p: &str, message: &str) -> Result<T> {
    c::fail("CORRELATION", p, message)
}
fn remap(e: Error, codes: &[&str]) -> Error {
    match e {
        Error::Failure(mut e) if codes.contains(&e.code) => {
            e.code = "CORRELATION";
            Error::Failure(e)
        }
        e => e,
    }
}
fn serialize(v: &impl serde::Serialize) -> Value {
    // These integrated DTOs contain exact JSON in strings, not native numbers.
    // Convert through their explicit serialized contract using the caller's codec
    // only in prepare below; this helper returns its text.
    s(serde_json::to_string(v).expect("pure route DTO"))
}
pub(crate) fn prepare_flow_route(
    input: &Value,
    content: &mut Content<'_>,
    decoder: &impl native::JsonDecoder,
) -> Result<Value> {
    prepare(input, content, decoder).map_err(|e| {
        remap(
            e,
            &[
                "PARSE",
                "INVALID_RECORD",
                "REFERENCE",
                "DUPLICATE",
                "ROUTES",
                "MESSAGE_PATH",
            ],
        )
    })
}
fn prepare(
    input: &Value,
    content: &mut Content<'_>,
    decoder: &impl native::JsonDecoder,
) -> Result<Value> {
    let reference = input.get("reference").get("route");
    let producer = input.get("producer");
    let source = input.get("source");
    let receipt = input.get("nativeReceiptId");
    if !receipt.truthy()
        || !producer.get("activationId").truthy()
        || !native::equal(source.get("terminalId"), producer.get("activationId"))
        || !native::equal(source.get("outputJson"), producer.get("outputJson"))
        || !native::equal(source.get("producerStep"), producer.get("step"))
    {
        return correlation("", "Producer and attested source disagree.");
    }
    let plan = c::decode(input.get("planJson"))?;
    exact::record(Some(&plan), "")?;
    if get(&plan, "format").and_then(E::as_str) != Some("macro-agsdl-compiled-plan/2") {
        return correlation("", "Expected a captured 0.3 plan.");
    }
    let steps = list(get(&plan, "steps"))?;
    for step in steps {
        exact::record(Some(step), "")?;
    }
    let source_step = steps
        .iter()
        .find(|step| eq_native(get(step, "address"), reference.get("source")));
    let producer_step = steps
        .iter()
        .find(|step| eq_native(get(step, "address"), producer.get("step")));
    let (Some(source_step), Some(producer_step)) = (source_step, producer_step) else {
        return correlation("", "The captured producer is not a declared step.");
    };
    if !eq_native(get(producer_step, "type"), producer.get("kind"))
        || !producer.get("step").truthy()
    {
        return correlation("", "The captured producer is not a declared step.");
    }
    let direct = native::equal(reference.get("source"), producer.get("step"));
    let compose = get(source_step, "type").and_then(E::as_str) == Some("compose")
        && match (
            producer.get("step").array(),
            reference.get("source").array(),
        ) {
            (Some(p), Some(r)) => {
                p.len() > r.len() && r.iter().zip(p).all(|(a, b)| native::equal(a, b))
            }
            _ => false,
        };
    if !direct && !compose {
        return correlation("", "The producer is outside the selected route.");
    }
    if if reference.get("kind").eq_str("error") {
        !source.get("kind").eq_str("error")
    } else {
        !native::equal(source.get("kind"), producer.get("kind"))
            && !(compose && source.get("kind").eq_str("error"))
    } {
        return correlation("", "Producer kind contradicts the selected route.");
    }
    if source.get("kind").eq_str("agent")
        && (get(producer_step, "agent").and_then(E::as_str).is_none()
            || !eq_native(get(producer_step, "agent"), source.get("producerAgent")))
    {
        return correlation("", "The agent does not match the captured producer.");
    }
    if source.get("kind").eq_str("approval") {
        let output = c::decode(producer.get("outputJson"))?;
        exact::record(Some(&output), "")?;
        if matches!(producer.get("messageJson"), Value::Null) {
            return correlation("", "Approval output differs from its received message.");
        }
        let message = c::decode(producer.get("messageJson"))?;
        if !get(&output, "message").is_some_and(|value| exact::equal(value, &message)) {
            return correlation("", "Approval output differs from its received message.");
        }
    }
    let routes = list(get(&plan, "routes"))?;
    for r in routes {
        exact::record(Some(r), "")?;
    }
    let routes = routes
        .iter()
        .filter(|r| {
            eq_native(get(r, "source"), reference.get("source"))
                && eq_native(get(r, "kind"), reference.get("kind"))
                && eq_native(get(r, "key"), reference.get("key"))
        })
        .collect::<Vec<_>>();
    if routes.len() != 1 {
        return correlation(
            "",
            "Selected route is missing or ambiguous in the captured plan.",
        );
    }
    if direct
        && reference.get("kind").eq_str("normal")
        && !matches!(reference.get("key"), Value::Null)
    {
        let output = c::decode(producer.get("outputJson"))?;
        exact::record(Some(&output), "")?;
        let kind = producer.get("kind");
        let field = if kind.eq_str("agent") || kind.eq_str("approval") {
            Some("choice")
        } else if kind.eq_str("call") || kind.eq_str("join") {
            Some("outcome")
        } else {
            None
        };
        if field.is_some_and(|field| !eq_native(get(&output, field), reference.get("key"))) {
            return correlation(
                "",
                "The selected route key contradicts the accepted output.",
            );
        }
    }
    let route = routes[0];
    let scope_address = list(get(source_step, "scope"))?
        .iter()
        .map(|v| txt(Some(v)).map(str::to_owned))
        .collect::<Result<Vec<_>>>()?;
    let scopes = list(get(&plan, "scopes"))?;
    for scope in scopes {
        exact::record(Some(scope), "")?;
    }
    let address = route::array(&scope_address);
    let matching = scopes
        .iter()
        .filter(|scope| get(scope, "address").is_some_and(|v| exact::equal(v, &address)))
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return correlation("", "Captured route scope is missing or ambiguous.");
    }
    let scope = Scope {
        prefix: scope_address.clone(),
        outputs: Some(
            list(get(matching[0], "outputs"))?
                .iter()
                .map(|v| txt(Some(v)).map(str::to_owned))
                .collect::<Result<_>>()?,
        ),
        steps: steps
            .iter()
            .filter(|step| get(step, "scope").is_some_and(|v| exact::equal(v, &address)))
            .map(|step| {
                Ok(ScopeStep {
                    address: list(get(step, "address"))?
                        .iter()
                        .map(|v| txt(Some(v)).map(str::to_owned))
                        .collect::<Result<_>>()?,
                    declaration_json: txt(get(step, "declarationJson"))?.into(),
                })
            })
            .collect::<Result<_>>()?,
        output_routes: None,
    };
    let targets = route::normalize_route(txt(get(route, "declarationJson"))?, &scope)?;
    let captured = list(get(route, "targets"))?;
    for target in captured {
        exact::record(Some(target), "")?;
    }
    let expected = E::Array(
        targets
            .iter()
            .map(|target| match target {
                RouteTarget::Output { name } => route::object([
                    ("kind", route::string("output")),
                    ("scope", route::array(&scope_address)),
                    ("name", route::string(name)),
                ]),
                RouteTarget::Step {
                    address,
                    message_json,
                    each_path_json,
                    concurrency_json,
                    max_json,
                    ..
                } => route::object([
                    ("kind", route::string("step")),
                    ("address", route::array(address)),
                    (
                        "messageJson",
                        message_json
                            .as_deref()
                            .map(route::string)
                            .unwrap_or(E::Null),
                    ),
                    (
                        "eachPathJson",
                        each_path_json
                            .as_deref()
                            .map(route::string)
                            .unwrap_or(E::Null),
                    ),
                    (
                        "concurrencyJson",
                        concurrency_json
                            .as_deref()
                            .map(route::string)
                            .unwrap_or(E::Null),
                    ),
                    (
                        "maxJson",
                        max_json.as_deref().map(route::string).unwrap_or(E::Null),
                    ),
                ]),
            })
            .collect(),
    );
    if !exact::equal(
        &E::Array(captured.iter().map(exact::values::clone).collect()),
        &expected,
    ) || targets
        .iter()
        .any(|t| matches!(t, RouteTarget::Output { .. }))
    {
        return correlation(
            "",
            "Captured targets contradict the selected route or contain an unresolved output.",
        );
    }
    let document_json = txt(get(&plan, "documentJson"))?;
    let document = exact::decode(document_json)?;
    exact::record(Some(&document), "")?;
    let typed_source: RouteSource = c::dto(source)?;
    if source.get("kind").eq_str("agent") {
        let agents = exact::record(get(&document, "agents"), "")?;
        let name = c::text(source.get("producerAgent"))?
            .utf8()
            .unwrap_or_default();
        let Some(agent) = agents.get(&name) else {
            return c::exception("TypeError", "Cannot encode an absent agent.");
        };
        for (i, target) in targets.iter().enumerate() {
            if let RouteTarget::Step {
                declaration_json, ..
            } = target
            {
                if route::instructions_expectation(
                    &exact::encode(agent),
                    declaration_json,
                    std::slice::from_ref(&scope),
                    Some(0),
                )? != "none"
                    && messages::instruction_authority(&typed_source, r#"["instructions"]"#)?
                        .is_none()
                {
                    return correlation(
                        &format!("/targets/{i}"),
                        "The selected mission has no attested instruction provenance.",
                    );
                }
            }
        }
    }
    let batches = match route::preflight_expansion(&targets, &typed_source)? {
        Expansion::Failed {
            target_index,
            error_json,
            ..
        } => {
            let error = exact::decode(&error_json)?;
            let error = field(&error, "error")?;
            return Ok(o([
                ("kind", s("failed")),
                ("targetOrdinal", number(target_index)),
                (
                    "error",
                    o([
                        ("code", s(txt(get(error, "code"))?)),
                        ("message", s(txt(get(error, "message"))?)),
                        ("details", a([])),
                    ]),
                ),
            ]));
        }
        Expansion::Ready { batches } => batches,
    };
    let mut prepared = vec![];
    let mut provenance = vec![];
    for (ordinal, batch) in batches.iter().enumerate() {
        let target = match batch {
            TargetBatch::Fixed { target } | TargetBatch::Fanout { target, .. } => target,
        };
        let RouteTarget::Step {
            address, step_json, ..
        } = target
        else {
            return correlation(
                "",
                "Reducer must resolve composition outputs before preparation.",
            );
        };
        let values = match batch {
            TargetBatch::Fixed { .. } => vec![E::Null],
            TargetBatch::Fanout { list_json, .. } => list(Some(&exact::decode(list_json)?))?
                .iter()
                .map(exact::values::clone)
                .collect(),
        };
        let mut items = vec![];
        for (index, value) in values.iter().enumerate() {
            let occurrence = o([
                ("nativeReceiptId", receipt.clone()),
                ("targetOrdinal", number(ordinal)),
                ("itemIndex", s(index.to_string())),
            ]);
            let item = match batch {
                TargetBatch::Fixed { .. } => ItemContext::Absent,
                TargetBatch::Fanout {
                    mission,
                    instruction_authority,
                    ..
                } => ItemContext::Element {
                    index: index.to_string(),
                    value_json: exact::encode(value),
                    mission: *mission,
                    instruction_authority: instruction_authority.clone(),
                },
            };
            let resolved = (|| {
                let mut recipient = steps.iter().find(|step| {
                    get(step, "address").is_some_and(|v| exact::equal(v, &route::array(address)))
                });
                let mut visited = HashSet::new();
                while recipient
                    .is_some_and(|step| get(step, "type").and_then(E::as_str) == Some("compose"))
                {
                    let r = recipient.unwrap();
                    let addr = field(r, "address")?;
                    if !visited.insert(exact::encode(addr)) {
                        return correlation("", "Composition entry cycle.");
                    }
                    let body = scopes
                        .iter()
                        .find(|scope| get(scope, "address").is_some_and(|v| exact::equal(v, addr)));
                    recipient = body.and_then(|body| {
                        steps
                            .iter()
                            .find(|step| match (get(step, "address"), get(body, "entry")) {
                                (Some(a), Some(b)) => exact::equal(a, b),
                                _ => false,
                            })
                    });
                }
                let Some(recipient) = recipient else {
                    return correlation("", "Composition message recipient is absent.");
                };
                let recipient_type = txt(get(recipient, "type"))?;
                let target_step = exact::decode(step_json)?;
                let receives = matches!(
                    txt(get(&target_step, "type"))?,
                    "agent" | "approval" | "compose"
                );
                if !receives {
                    return Ok(None);
                }
                let mut resolver: Option<&mut CapturedReceipts> = match content {
                    Content::None => None,
                    Content::Shared(r) => Some(&mut **r),
                    Content::Occurrences(c) => c.select(ordinal, &index.to_string()),
                };
                let mut context = CapturedContent {
                    defer_prompt_uris: matches!(input.get("deferPromptUris"), Value::Bool(true))
                        && recipient_type == "agent",
                    resolve_source: resolver
                        .as_deref_mut()
                        .map(|r| r as &mut dyn messages::CapturedSource),
                };
                let resolved = messages::resolve_route_message(
                    document_json,
                    target,
                    &typed_source,
                    &item,
                    &mut context,
                );
                if let Some(e) = resolver.and_then(CapturedReceipts::take_exception) {
                    return Err(e);
                }
                Ok(Some(resolved?))
            })();
            let resolved = match resolved {
                Ok(v) => v,
                Err(e) => {
                    if matches!(&e, Error::Failure(e) if ["MESSAGE_PATH", "INVALID_RECORD", "REFERENCE", "PARSE", "ROUTES"].contains(&e.code))
                    {
                        return Err(remap(
                            e,
                            &[
                                "MESSAGE_PATH",
                                "INVALID_RECORD",
                                "REFERENCE",
                                "PARSE",
                                "ROUTES",
                            ],
                        ));
                    }
                    if let Error::Failure(e) = e {
                        return Ok(o([
                            ("kind", s("failed")),
                            ("targetOrdinal", number(ordinal)),
                            (
                                "error",
                                o([
                                    ("code", s(e.code)),
                                    ("message", s(e.message)),
                                    (
                                        "details",
                                        if e.pointer.units().is_empty() {
                                            a([])
                                        } else {
                                            a([o([("path", s(e.pointer))])])
                                        },
                                    ),
                                ]),
                            ),
                        ]));
                    }
                    return Err(e);
                }
            };
            let prompt = if let Some(resolved) = &resolved {
                decoder.parse(c::text(&serialize(&resolved.prompt_provenance))?)?
            } else {
                o([("kind", s("none"))])
            };
            items.push(o([
                (
                    "messageJson",
                    resolved.map(|r| s(r.message_json)).unwrap_or(Value::Null),
                ),
                (
                    "itemJson",
                    if matches!(item, ItemContext::Element { .. }) {
                        c::encoded(value)
                    } else {
                        Value::Null
                    },
                ),
                ("occurrence", occurrence.clone()),
            ]));
            provenance.push(o([
                ("occurrence", occurrence),
                ("prompt", prompt),
                ("source", source.clone()),
                ("producer", producer.clone()),
            ]));
        }
        prepared.push(o([
            ("targetOrdinal", number(ordinal)),
            (
                "target",
                decoder.parse(&native::Text::from(exact::encode(&captured[ordinal])))?,
            ),
            ("items", a(items)),
        ]));
    }
    Ok(o([
        ("kind", s("ready")),
        ("batches", a(prepared)),
        ("provenance", a(provenance)),
    ]))
}
fn number(n: usize) -> Value {
    Value::Number(native::Number::Finite(n.to_string()))
}
