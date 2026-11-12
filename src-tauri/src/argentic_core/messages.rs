//! Pure port of Macro's messages030.ts. Accepted instruction provenance and
//! captured content are inputs. A value's shape never supplies that provenance.
use super::{
    error::{fail, Failure},
    exact::{
        self,
        values::{clone, decimal},
        Object, Value,
    },
    route::{
        object, object_path, string, InstructionAuthority, ItemContext, PromptProvenance,
        ResultMetadata, RouteSource, RouteTarget, SourceKind,
    },
};
use serde::Serialize;
type Result<T> = std::result::Result<T, Failure>;

/// The existing TS CapturedContent030.resolveSource contract. Implementations
/// consult captured data only. Resource URIs bypass this port, as in TS.
pub(crate) trait CapturedSource {
    fn resolve_source(&mut self, source_json: &str, usage: &str, pointer: &str) -> Result<String>;
}
#[derive(Default)]
pub(crate) struct CapturedContent<'a> {
    pub(crate) defer_prompt_uris: bool,
    pub(crate) resolve_source: Option<&'a mut dyn CapturedSource>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SelectedValue {
    Inline {
        value_json: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<ResultMetadata>,
    },
    File {
        source_json: String,
        media_type: String,
        metadata: ResultMetadata,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedMessage {
    pub(crate) message_json: String,
    pub(crate) prompt_provenance: PromptProvenance,
}
fn json_media(media: &str) -> bool {
    if media == "application/json" {
        return true;
    }
    let Some((head, tail)) = media.split_once('/') else {
        return false;
    };
    !head.is_empty()
        && !tail.contains('/')
        && tail
            .strip_suffix("+json")
            .is_some_and(|prefix| !prefix.is_empty())
}
/// Raw traversal deliberately has no item namespace.
pub(crate) fn read_path(current: &Value, path: &Value) -> Result<Value> {
    let Some(parts) = path.as_array() else {
        return fail("OPERAND", "", "Selection path must be a list.");
    };
    let mut value = current;
    for part in parts {
        match (part, value) {
            (Value::String(key), Value::Object(object)) => {
                value = object
                    .get(key)
                    .ok_or_else(|| Failure::new("OPERAND", "", "Missing selection property."))?;
            }
            (Value::Number(number), Value::Array(items)) => {
                let d = decimal(number);
                if !d.sign().is_empty()
                    || d.exponent.is_negative()
                    || d.exponent > exact::BigInteger::from_usize(items.len().to_string().len())
                {
                    return fail("OPERAND", "", "Invalid selection index.");
                }
                // Even zero with an enormous exponent is rejected above, as TS
                // checks the normalized exponent before indexing.
                if super::integers::compare_integers030(number.raw(), &items.len().to_string())?
                    .is_ge()
                {
                    return fail("OPERAND", "", "Missing selection index.");
                }
                let index = super::integers::bounded_integer030(
                    number.raw(),
                    &exact::BigInteger::from_usize(items.len()),
                )?
                .to_usize()
                .expect("index bounded by materialized array");
                value = &items[index];
            }
            _ => {
                return fail(
                    "OPERAND",
                    "",
                    "Selection container does not match its path.",
                )
            }
        }
    }
    Ok(clone(value))
}
pub(crate) fn select_value(
    output_json: &str,
    path_json: &str,
    item: &ItemContext,
    metadata: &[ResultMetadata],
) -> Result<SelectedValue> {
    let path_value = exact::decode(path_json)?;
    let path = exact::list(Some(&path_value), "")?;
    let from_item = path.first().and_then(Value::as_str) == Some("item");
    if from_item && matches!(item, ItemContext::Absent) {
        return fail("OPERAND", "", "No fan-out item in this message context.");
    }
    let value = if let ItemContext::Element { value_json, .. } = item {
        if from_item {
            read_path(
                &exact::decode(value_json)?,
                &Value::Array(path[1..].iter().map(clone).collect()),
            )?
        } else {
            read_path(&exact::decode(output_json)?, &path_value)?
        }
    } else {
        read_path(&exact::decode(output_json)?, &path_value)?
    };
    let mut result = None;
    if !from_item {
        for entry in metadata {
            if exact::equal(&exact::decode(&entry.path_json)?, &path_value) {
                result = Some(entry.clone());
                break;
            }
        }
    }
    if let Some(entry) = &result {
        if !json_media(&entry.media_type) && !entry.media_type.starts_with("text/") {
            let uri = exact::text(Some(&value), "")?;
            // Only acceptance is observed. Never emit the parser's normalized URL.
            if url::Url::parse(uri).is_err() {
                return fail(
                    "OPERAND",
                    "",
                    "Media result requires an absolute file reference.",
                );
            }
            return Ok(SelectedValue::File {
                source_json: exact::encode(&object([
                    ("uri", string(uri)),
                    ("mediaType", string(&entry.media_type)),
                ])),
                media_type: entry.media_type.clone(),
                metadata: entry.clone(),
            });
        }
    }
    Ok(SelectedValue::Inline {
        value_json: exact::encode(&value),
        media_type: result.as_ref().map(|entry| entry.media_type.clone()),
        metadata: result,
    })
}
pub(crate) fn instruction_authority(
    source: &RouteSource,
    path_json: &str,
) -> Result<Option<InstructionAuthority>> {
    let path_value = exact::decode(path_json)?;
    let path = exact::list(Some(&path_value), "")?;
    let valid = if source.kind == SourceKind::Agent {
        exact::equal(&path_value, &object_path(&["instructions"]))
    } else {
        source.kind == SourceKind::Join
            && path.len() == 3
            && path[0].as_str() == Some("branches")
            && path[1].as_str().is_some()
            && path[2].as_str() == Some("instructions")
    };
    if !valid {
        return Ok(None);
    }
    for entry in &source.provenance.instructions {
        if exact::equal(&exact::decode(&entry.path_json)?, &path_value)
            && (source.kind != SourceKind::Agent
                || source.producer_agent.as_deref() == Some(&entry.producer_agent)
                    && entry.terminal_id == source.terminal_id)
        {
            return Ok(Some(entry.clone()));
        }
    }
    Ok(None)
}
fn nullish<'a>(value: Option<&'a Value>, fallback: &'a Value) -> Option<&'a Value> {
    Some(match value {
        None | Some(Value::Null) => fallback,
        Some(value) => value,
    })
}
fn result_metadata(document: &Object, source: &RouteSource) -> Result<Vec<ResultMetadata>> {
    let mut declared = Vec::new();
    if source.kind == SourceKind::Agent {
        if let Some(agent) = source.producer_agent.as_ref().filter(|s| !s.is_empty()) {
            let empty = object([]);
            let agents = exact::record(nullish(document.get("agents"), &empty), "")?;
            if let Some(agent) = agents.get(agent) {
                let definition = exact::record(Some(agent), "")?;
                let results = exact::record(nullish(definition.get("results"), &empty), "")?;
                for (name, definition) in results.iter() {
                    let definition = exact::record(Some(definition), "")?;
                    let default = string("application/json");
                    let media = match definition.get("mediaType") {
                        None | Some(Value::Null) => &default,
                        Some(value) => value,
                    };
                    declared.push(ResultMetadata::declared(
                        exact::encode(&object_path(&["results", name])),
                        exact::text(Some(media), "")?.to_owned(),
                    ));
                }
            }
        }
    }
    let mut result = Vec::new();
    for entry in declared {
        let mut replaced = false;
        if let Some(captured) = &source.provenance.results {
            for candidate in captured {
                if exact::equal(
                    &exact::decode(&candidate.path_json)?,
                    &exact::decode(&entry.path_json)?,
                ) {
                    replaced = true;
                    break;
                }
            }
        }
        if !replaced {
            result.push(entry);
        }
    }
    result.extend(source.provenance.results.iter().flatten().cloned());
    Ok(result)
}
struct Resolver<'a, 'b, 'c> {
    document: &'a Object,
    source: &'a RouteSource,
    output: &'a Value,
    item: &'a ItemContext,
    each: Option<&'a str>,
    metadata: &'a [ResultMetadata],
    content: &'b mut CapturedContent<'c>,
    prompt: PromptProvenance,
}
impl Resolver<'_, '_, '_> {
    fn resolve_source(&mut self, raw: &Value, usage: &str, pointer: &str) -> Result<Value> {
        let mut resolved = exact::record(Some(raw), "")?;
        let empty = object([]);
        if resolved.contains_key("ref") {
            if resolved.len() != 1 {
                return fail(
                    "REFERENCE",
                    pointer,
                    "A content reference contains only ref.",
                );
            }
            let name = exact::text(resolved.get("ref"), "")?;
            let catalog = exact::record(nullish(self.document.get("content"), &empty), "")?;
            let Some(value) = catalog.get(name) else {
                return fail("REFERENCE", pointer, "Unknown authored content reference.");
            };
            resolved = exact::record(Some(value), "")?;
        }
        if resolved
            .iter()
            .any(|(key, _)| !["value", "uri", "mediaType"].contains(&key))
            || resolved.contains_key("value") == resolved.contains_key("uri")
        {
            return fail(
                "CONTENT_UNAVAILABLE",
                pointer,
                "Expected one inline value or URI source.",
            );
        }
        if let Some(value) = resolved.get("mediaType") {
            exact::text(Some(value), "")?;
        }
        if let Some(value) = resolved.get("uri") {
            exact::text(Some(value), "")?;
        }
        let resolved = Value::Object(exact::Object::from_entries(
            resolved.iter().map(|(k, v)| (k.to_owned(), clone(v))),
        ));
        if usage == "resource" && exact::record(Some(&resolved), "")?.contains_key("uri") {
            return Ok(clone(&resolved));
        }
        let captured = if let Some(port) = &mut self.content.resolve_source {
            exact::decode(&port.resolve_source(&exact::encode(&resolved), usage, pointer)?)?
        } else {
            clone(&resolved)
        };
        let object = exact::record(Some(&captured), "")?;
        if object.contains_key("value") == object.contains_key("uri") || object.contains_key("ref")
        {
            return fail(
                "CONTENT_UNAVAILABLE",
                pointer,
                "Captured content must be a resolved source.",
            );
        }
        if usage == "prompt" && object.contains_key("uri") && !self.content.defer_prompt_uris {
            return fail(
                "CONTENT_UNAVAILABLE",
                pointer,
                "Prompt URI has not been captured as content.",
            );
        }
        Ok(captured)
    }
    fn authored_prompt(&mut self, raw: &Value, pointer: &str) -> Result<Value> {
        match raw {
            Value::String(_) => Ok(clone(raw)),
            Value::Array(uses) => Ok(Value::Array(
                uses.iter()
                    .enumerate()
                    .map(|(i, v)| self.resolve_source(v, "prompt", &format!("{pointer}/{i}")))
                    .collect::<Result<_>>()?,
            )),
            _ => fail(
                "MESSAGE_PATH",
                pointer,
                "Expected authored prompt text or sources.",
            ),
        }
    }
    fn selected_resource(&self, path: &str, override_media: Option<&Value>) -> Result<Value> {
        let selected = select_value(&self.source.output_json, path, self.item, self.metadata)?;
        let mut resource = match selected {
            SelectedValue::File { source_json, .. } => exact::decode(&source_json)?,
            SelectedValue::Inline {
                value_json,
                media_type,
                ..
            } => {
                let mut resource =
                    Object::from_entries([("value".to_owned(), exact::decode(&value_json)?)]);
                if let Some(media) = media_type {
                    resource.set("mediaType".to_owned(), string(&media));
                }
                Value::Object(resource)
            }
        };
        if let Some(media) = override_media {
            let media = exact::text(Some(media), "")?;
            if let Value::Object(resource) = &mut resource {
                resource.set("mediaType".to_owned(), string(media));
            }
        }
        Ok(resource)
    }
    fn mission_authority(&self) -> Result<InstructionAuthority> {
        let authority = instruction_authority(self.source, r#"["instructions"]"#)?;
        let ItemContext::Element {
            index,
            value_json,
            mission: true,
            instruction_authority: Some(item_authority),
        } = self.item
        else {
            return fail(
                "MESSAGE_PATH",
                "",
                "Item has no authorized mission provenance.",
            );
        };
        let Some(authority) = authority else {
            return fail(
                "MESSAGE_PATH",
                "",
                "Item has no authorized mission provenance.",
            );
        };
        if item_authority.terminal_id != authority.terminal_id
            || item_authority.producer_agent != authority.producer_agent
            || !exact::equal(
                &exact::decode(&item_authority.path_json)?,
                &exact::decode(&authority.path_json)?,
            )
            || self.each.is_none()
            || !exact::equal(
                &exact::decode(self.each.unwrap())?,
                &object_path(&["instructions"]),
            )
        {
            return fail(
                "MESSAGE_PATH",
                "",
                "Item has no authorized mission provenance.",
            );
        }
        let values = read_path(self.output, &object_path(&["instructions"]))?;
        let values = values.as_array();
        let canonical = index == "0"
            || index
                .as_bytes()
                .first()
                .is_some_and(|b| (b'1'..=b'9').contains(b))
                && index.bytes().all(|b| b.is_ascii_digit());
        let entry = index
            .parse::<usize>()
            .ok()
            .and_then(|i| values.and_then(|v| v.get(i)));
        if !canonical
            || entry.is_none()
            || !exact::equal(entry.unwrap(), &exact::decode(value_json)?)
        {
            return fail(
                "MESSAGE_PATH",
                "",
                "Mission item differs from the accepted instructions.",
            );
        }
        Ok(authority)
    }
    fn selected_prompt(&mut self, path: &Value) -> Result<Value> {
        if exact::equal(path, &object_path(&["item"])) {
            let authority = self.mission_authority()?;
            self.prompt = PromptProvenance::Agent { authority };
            let ItemContext::Element { value_json, .. } = self.item else {
                unreachable!()
            };
            return Ok(string(exact::text(Some(&exact::decode(value_json)?), "")?));
        }
        let Some(authority) = instruction_authority(self.source, &exact::encode(path))? else {
            return fail(
                "MESSAGE_PATH",
                "",
                "Prompt selection requires authorized instructions.",
            );
        };
        self.prompt = PromptProvenance::Agent { authority };
        Ok(string(exact::text(
            Some(&read_path(self.output, path)?),
            "",
        )?))
    }
}
pub(crate) fn resolve_route_message(
    document_json: &str,
    target: &RouteTarget,
    source: &RouteSource,
    item: &ItemContext,
    content: &mut CapturedContent<'_>,
) -> Result<ResolvedMessage> {
    let RouteTarget::Step {
        step_json,
        message_json,
        each_path_json,
        ..
    } = target
    else {
        return fail(
            "ROUTES",
            "",
            "A composition output has no delivery message.",
        );
    };
    let step_value = exact::decode(step_json)?;
    let step = exact::record(Some(&step_value), "")?;
    if !["agent", "approval", "compose"].contains(&exact::text(step.get("type"), "")?) {
        return fail("ROUTES", "", "This target receives no message.");
    }
    let document_value = exact::decode(document_json)?;
    let document = exact::record(Some(&document_value), "")?;
    let output_value = exact::decode(&source.output_json)?;
    let output = exact::record(Some(&output_value), "")?;
    let metadata = result_metadata(document, source)?;
    let mut r = Resolver {
        document,
        source,
        output: &output_value,
        item,
        each: each_path_json.as_deref(),
        metadata: &metadata,
        content,
        prompt: PromptProvenance::None,
    };
    let mut message = if let Some(message_json) = message_json {
        let authored_value = exact::decode(message_json)?;
        let authored = exact::record(Some(&authored_value), "")?;
        if authored
            .iter()
            .any(|(k, _)| !["prompt", "resources"].contains(&k))
        {
            return fail("ROUTES", "", "Authored message cannot add host fields.");
        }
        let mut message = Object::default();
        if let Some(prompt) = authored.get("prompt") {
            let value = if let Value::Object(selection) = prompt {
                if selection.len() != 1 || !selection.contains_key("from") {
                    return fail("MESSAGE_PATH", "", "Invalid prompt selection.");
                }
                r.selected_prompt(selection.get("from").unwrap())?
            } else {
                let prompt = r.authored_prompt(prompt, "/message/prompt")?;
                r.prompt = PromptProvenance::Author {
                    pointer: "/message/prompt".to_owned(),
                };
                prompt
            };
            message.set("prompt".to_owned(), value);
        }
        if let Some(resources) = authored.get("resources") {
            let mut result = Object::default();
            for (name, raw) in exact::record(Some(resources), "")?.iter() {
                let resource = exact::record(Some(raw), "")?;
                let value = if let Some(path) = resource.get("from") {
                    if resource
                        .iter()
                        .any(|(k, _)| !["from", "mediaType"].contains(&k))
                    {
                        return fail("MESSAGE_PATH", "", "Invalid resource selection.");
                    }
                    r.selected_resource(&exact::encode(path), resource.get("mediaType"))?
                } else {
                    r.resolve_source(raw, "resource", &format!("/message/resources/{name}"))?
                };
                result.set(name.to_owned(), value);
            }
            message.set("resources".to_owned(), Value::Object(result));
        }
        message
    } else {
        match source.kind {
            SourceKind::Entry => {
                let mut message =
                    Object::from_entries(output.iter().map(|(k, v)| (k.to_owned(), clone(v))));
                if let Some(prompt) = message.get("prompt") {
                    let prompt = r.authored_prompt(prompt, "/entry/prompt")?;
                    message.set("prompt".to_owned(), prompt);
                    r.prompt = PromptProvenance::Host;
                }
                if let Some(resources) = message.get("resources") {
                    let mut result = Object::default();
                    for (name, raw) in exact::record(Some(resources), "")?.iter() {
                        result.set(
                            name.to_owned(),
                            r.resolve_source(raw, "resource", &format!("/entry/resources/{name}"))?,
                        );
                    }
                    message.set("resources".to_owned(), Value::Object(result));
                }
                message
            }
            SourceKind::Approval => {
                let raw = exact::record(output.get("message"), "")?;
                let mut message =
                    Object::from_entries(raw.iter().map(|(k, v)| (k.to_owned(), clone(v))));
                if message.contains_key("prompt") {
                    r.prompt = source
                        .provenance
                        .prompt
                        .clone()
                        .unwrap_or(PromptProvenance::None);
                    if r.prompt.is_none() {
                        return fail(
                            "MESSAGE_PATH",
                            "",
                            "Approval prompt requires inherited provenance.",
                        );
                    }
                }
                let comment = exact::text(output.get("comment"), "")?;
                if !comment.is_empty() {
                    let Some(step) = &source.producer_step else {
                        return fail(
                            "OPERAND",
                            "",
                            "Approval comment requires its expanded step address.",
                        );
                    };
                    let empty = Value::Array(vec![]);
                    let comments = match message.get("comments") {
                        None | Some(Value::Null) => &empty,
                        Some(v) => v,
                    };
                    let mut comments: Vec<Value> =
                        exact::list(Some(comments), "")?.iter().map(clone).collect();
                    comments.push(object([
                        ("step", string(&step.join("/"))),
                        ("comment", string(comment)),
                    ]));
                    message.set("comments".to_owned(), Value::Array(comments));
                }
                message
            }
            SourceKind::Agent => {
                let empty = object([]);
                let results = match output.get("results") {
                    None | Some(Value::Null) => &empty,
                    Some(value) => value,
                };
                let mut resources = Object::default();
                for (name, _) in exact::record(Some(results), "")?.iter() {
                    resources.set(
                        name.to_owned(),
                        r.selected_resource(
                            &exact::encode(&object_path(&["results", name])),
                            None,
                        )?,
                    );
                }
                if resources.contains_key("text") {
                    return fail("OPERAND", "", "Agent result cannot be named text.");
                }
                let default = string("");
                let visible = match output.get("text") {
                    None | Some(Value::Null) => &default,
                    Some(value) => value,
                };
                resources.set(
                    "text".to_owned(),
                    object([
                        ("value", string(exact::text(Some(visible), "")?)),
                        ("mediaType", string("text/plain")),
                    ]),
                );
                let mut message =
                    Object::from_entries([("resources".to_owned(), Value::Object(resources))]);
                if let Some(authority) = instruction_authority(source, r#"["instructions"]"#)? {
                    let prompt = if let ItemContext::Element {
                        value_json,
                        mission: true,
                        ..
                    } = item
                    {
                        r.mission_authority()?;
                        string(exact::text(Some(&exact::decode(value_json)?), "")?)
                    } else {
                        string(exact::text(output.get("instructions"), "")?)
                    };
                    message.set("prompt".to_owned(), prompt);
                    r.prompt = PromptProvenance::Agent { authority };
                }
                message
            }
            SourceKind::Call => Object::from_entries([(
                "resources".to_owned(),
                object([(
                    "result",
                    object([("value", read_path(&output_value, &object_path(&["data"]))?)]),
                )]),
            )]),
            SourceKind::Join => {
                let mut resources = Object::default();
                for (name, value) in exact::record(output.get("branches"), "")?.iter() {
                    resources.set(name.to_owned(), object([("value", clone(value))]));
                }
                Object::from_entries([("resources".to_owned(), Value::Object(resources))])
            }
            SourceKind::Error => Object::from_entries([(
                "resources".to_owned(),
                object([(
                    "error",
                    object([("value", read_path(&output_value, &object_path(&["error"]))?)]),
                )]),
            )]),
        }
    };
    if !message.contains_key("prompt") {
        if let Some(prompt) = step.get("prompt") {
            message.set(
                "prompt".to_owned(),
                r.authored_prompt(prompt, "/step/prompt")?,
            );
            r.prompt = PromptProvenance::Author {
                pointer: "/step/prompt".to_owned(),
            };
        }
    }
    if let ItemContext::Element { value_json, .. } = item {
        message.set("item".to_owned(), exact::decode(value_json)?);
    }
    Ok(ResolvedMessage {
        message_json: exact::encode(&Value::Object(message)),
        prompt_provenance: r.prompt,
    })
}
