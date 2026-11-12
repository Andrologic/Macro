//! Pure port of Macro's routes030.ts. Scheduling and accepted provenance are
//! supplied by the caller; this module creates no execution authority.
pub(crate) mod data;
pub(crate) mod preparation;
use super::{
    error::{fail, Failure},
    exact::{
        self,
        values::{clone, decimal},
        Value,
    },
    messages,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

type Result<T> = std::result::Result<T, Failure>;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InstructionAuthority {
    pub(crate) path_json: String,
    pub(crate) producer_agent: String,
    pub(crate) terminal_id: String,
    snapshot_json: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResultMetadata {
    pub(crate) path_json: String,
    pub(crate) media_type: String,
    snapshot_json: String,
}

// These objects are returned by reference/spread in TS. Preserve their complete
// captured serialization, including extension fields and member order. The host
// supplies native snapshots; authored NumberToken trees stay a separate path.
macro_rules! captured_dto {
    ($ty:ident, $($field:ident : $fieldty:ty),+ $(,)?) => {
        impl Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok,S::Error> {
                let raw = serde_json::value::RawValue::from_string(self.snapshot_json.clone()).map_err(serde::ser::Error::custom)?;
                raw.serialize(serializer)
            }
        }
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer:D)->std::result::Result<Self,D::Error> {
                let raw=Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
                #[derive(Deserialize)] #[serde(rename_all="camelCase")]
                struct Fields { $($field:$fieldty),+ }
                let fields:Fields=serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                Ok(Self { $($field:fields.$field),+, snapshot_json:raw.get().to_owned() })
            }
        }
    }
}
captured_dto!(InstructionAuthority,path_json:String,producer_agent:String,terminal_id:String);
captured_dto!(ResultMetadata,path_json:String,media_type:String);
impl ResultMetadata {
    pub(crate) fn declared(path_json: String, media_type: String) -> Self {
        let snapshot_json = exact::encode(&object([
            ("pathJson", string(&path_json)),
            ("mediaType", string(&media_type)),
        ]));
        Self {
            path_json,
            media_type,
            snapshot_json,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PromptProvenance {
    None,
    Host,
    Author {
        pointer: String,
    },
    Agent {
        authority: InstructionAuthority,
    },
    /// The approval default forwards its complete previously captured object.
    Captured {
        snapshot_json: String,
        none: bool,
    },
}
impl PromptProvenance {
    pub(crate) fn is_none(&self) -> bool {
        matches!(self, Self::None | Self::Captured { none: true, .. })
    }
}
impl Serialize for PromptProvenance {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        if let Self::Captured { snapshot_json, .. } = self {
            return serde_json::value::RawValue::from_string(snapshot_json.clone())
                .map_err(serde::ser::Error::custom)?
                .serialize(serializer);
        }
        let mut object = serializer.serialize_struct(
            "PromptProvenance",
            if matches!(self, Self::Author { .. } | Self::Agent { .. }) {
                2
            } else {
                1
            },
        )?;
        match self {
            Self::None => object.serialize_field("kind", "none")?,
            Self::Host => object.serialize_field("kind", "host")?,
            Self::Author { pointer } => {
                object.serialize_field("kind", "author")?;
                object.serialize_field("pointer", pointer)?;
            }
            Self::Agent { authority } => {
                object.serialize_field("kind", "agent")?;
                object.serialize_field("authority", authority)?;
            }
            Self::Captured { .. } => unreachable!(),
        }
        object.end()
    }
}
impl<'de> Deserialize<'de> for PromptProvenance {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Kind {
            kind: String,
        }
        let kind: Kind = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        Ok(Self::Captured {
            snapshot_json: raw.get().to_owned(),
            none: kind.kind == "none",
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Provenance {
    pub(crate) instructions: Vec<InstructionAuthority>,
    pub(crate) results: Option<Vec<ResultMetadata>>,
    pub(crate) prompt: Option<PromptProvenance>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceKind {
    Entry,
    Agent,
    Call,
    Approval,
    Join,
    Error,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteSource {
    pub(crate) terminal_id: String,
    pub(crate) producer_step: Option<Vec<String>>,
    pub(crate) producer_agent: Option<String>,
    pub(crate) kind: SourceKind,
    pub(crate) output_json: String,
    pub(crate) provenance: Provenance,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ItemContext {
    Absent,
    Element {
        index: String,
        value_json: String,
        mission: bool,
        instruction_authority: Option<InstructionAuthority>,
    },
}
impl<'de> Deserialize<'de> for ItemContext {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields {
            kind: String,
            index: Option<String>,
            value_json: Option<String>,
            mission: Option<bool>,
            instruction_authority: Option<InstructionAuthority>,
        }
        let fields: Fields = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        if fields.kind == "absent" {
            return Ok(Self::Absent);
        }
        if fields.kind != "element" {
            return Err(serde::de::Error::custom("Unknown item kind"));
        }
        Ok(Self::Element {
            index: fields
                .index
                .ok_or_else(|| serde::de::Error::missing_field("index"))?,
            value_json: fields
                .value_json
                .ok_or_else(|| serde::de::Error::missing_field("valueJson"))?,
            mission: fields
                .mission
                .ok_or_else(|| serde::de::Error::missing_field("mission"))?,
            instruction_authority: fields.instruction_authority,
        })
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeStep {
    pub(crate) address: Vec<String>,
    pub(crate) declaration_json: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Continuation {
    pub(crate) route_json: String,
    pub(crate) scope: usize,
}
/// An arena preserves shared scope identity, including cycles, without imposing
/// ownership-tree semantics on TS Scope030.outputRoutes.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Scope {
    #[serde(default)]
    pub(crate) prefix: Vec<String>,
    pub(crate) steps: Vec<ScopeStep>,
    pub(crate) outputs: Option<Vec<String>>,
    pub(crate) output_routes: Option<Vec<(String, Continuation)>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum RouteTarget {
    Step {
        address: Vec<String>,
        step_json: String,
        declaration_json: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message_json: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        each_path_json: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        concurrency_json: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_json: Option<String>,
    },
    Output {
        name: String,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TargetBatch {
    Fixed {
        target: RouteTarget,
    },
    Fanout {
        target: RouteTarget,
        list_json: String,
        length: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        concurrency_json: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_json: Option<String>,
        mission: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        instruction_authority: Option<InstructionAuthority>,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Expansion {
    Ready {
        batches: Vec<TargetBatch>,
    },
    Failed {
        target_index: usize,
        code: &'static str,
        error_json: String,
    },
}

pub(super) fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(exact::Object::from_entries(
        fields.into_iter().map(|(k, v)| (k.to_owned(), v)),
    ))
}
pub(super) fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}
pub(super) fn array(strings: &[String]) -> Value {
    Value::Array(strings.iter().map(|s| string(s)).collect())
}
fn positive_integer(value: &Value) -> Result<()> {
    let Some(number) = value.as_number() else {
        return fail("ROUTES", "", "Expected a positive integer.");
    };
    let d = decimal(number);
    if !d.sign().is_empty() || d.digits == "0" || d.exponent.is_negative() {
        return fail("ROUTES", "", "Expected a positive integer.");
    }
    Ok(())
}
fn path(value: &Value) -> Result<()> {
    for part in exact::list(Some(value), "")? {
        if part.as_str().is_some() {
            continue;
        }
        let Some(number) = part.as_number() else {
            return fail("MESSAGE_PATH", "", "Invalid selection segment.");
        };
        let d = decimal(number);
        if !d.sign().is_empty() || d.exponent.is_negative() {
            return fail("MESSAGE_PATH", "", "Invalid selection index.");
        }
    }
    Ok(())
}
pub(crate) fn normalize_route(route_json: &str, scope: &Scope) -> Result<Vec<RouteTarget>> {
    let route = exact::decode(route_json)?;
    let mut seen = HashSet::new();
    let raws: Vec<&Value> = match &route {
        Value::Array(v) => v.iter().collect(),
        _ => vec![&route],
    };
    let mut targets = Vec::new();
    for raw in raws {
        let shorthand = raw.as_str().map(|name| object([("step", string(name))]));
        let target = exact::record(shorthand.as_ref().or(Some(raw)), "")?;
        if target.contains_key("output") {
            if target.iter().any(|(k, _)| k != "output") {
                return fail(
                    "ROUTES",
                    "",
                    "Composition output cannot carry a message or fan-out.",
                );
            }
            let name = exact::text(target.get("output"), "")?;
            if !scope
                .outputs
                .as_ref()
                .is_some_and(|outputs| outputs.iter().any(|s| s == name))
            {
                return fail("ROUTES", "", "Output is outside this composition body.");
            }
            if !seen.insert(format!("output:{name}")) {
                return fail("DUPLICATE", "", "Repeated route target.");
            }
            targets.push(RouteTarget::Output {
                name: name.to_owned(),
            });
            continue;
        }
        if target
            .iter()
            .any(|(k, _)| !["step", "message", "each", "concurrency", "max"].contains(&k))
        {
            return fail("ROUTES", "", "Invalid route target fields.");
        }
        let name = exact::text(target.get("step"), "")?;
        let mut address = scope.prefix.clone();
        address.push(name.to_owned());
        let Some(definition) = scope.steps.iter().find(|s| s.address == address) else {
            return fail("REFERENCE", "", "Unknown step in route scope.");
        };
        if !seen.insert(exact::encode(&array(&address))) {
            return fail("DUPLICATE", "", "Repeated route target.");
        }
        let step_value = exact::decode(&definition.declaration_json)?;
        let step = exact::record(Some(&step_value), "")?;
        let receives =
            ["agent", "approval", "compose"].contains(&exact::text(step.get("type"), "")?);
        if (target.contains_key("message") || target.contains_key("each")) && !receives {
            return fail("ROUTES", "", "This step receives no message or item.");
        }
        if (target.contains_key("concurrency") || target.contains_key("max"))
            && !target.contains_key("each")
        {
            return fail("ROUTES", "", "Fan-out limits require each.");
        }
        if let Some(each) = target.get("each") {
            path(each)?;
            if exact::list(Some(each), "")?.first().and_then(Value::as_str) == Some("item") {
                return fail("MESSAGE_PATH", "", "each reads the source, not an item.");
            }
        }
        for name in ["concurrency", "max"] {
            if let Some(value) = target.get(name) {
                positive_integer(value)?;
            }
        }
        targets.push(RouteTarget::Step {
            address,
            step_json: definition.declaration_json.clone(),
            declaration_json: exact::encode(raw),
            message_json: target.get("message").map(exact::encode),
            each_path_json: target.get("each").map(exact::encode),
            concurrency_json: target.get("concurrency").map(exact::encode),
            max_json: target.get("max").map(exact::encode),
        });
    }
    Ok(targets)
}
fn exceeds(count: usize, maximum: &str) -> Result<bool> {
    let value = exact::decode(maximum)?;
    positive_integer(&value)?;
    // Comparing exact nonnegative integers never expands an unbounded exponent.
    Ok(super::integers::compare_integers030(&count.to_string(), maximum)?.is_gt())
}
pub(crate) fn preflight_expansion(
    targets: &[RouteTarget],
    source: &RouteSource,
) -> Result<Expansion> {
    let mut batches = Vec::new();
    for (target_index, target) in targets.iter().enumerate() {
        let RouteTarget::Step {
            each_path_json: Some(each),
            concurrency_json,
            max_json,
            ..
        } = target
        else {
            batches.push(TargetBatch::Fixed {
                target: target.clone(),
            });
            continue;
        };
        let batch = (|| {
            let selected = messages::select_value(
                &source.output_json,
                each,
                &ItemContext::Absent,
                source.provenance.results.as_deref().unwrap_or(&[]),
            )?;
            let messages::SelectedValue::Inline { value_json, .. } = selected else {
                return fail("OPERAND", "", "Fan-out requires a list, not a media file.");
            };
            let value = exact::decode(&value_json)?;
            let Some(values) = value.as_array() else {
                return fail("OPERAND", "", "Fan-out requires a list.");
            };
            if let Some(max) = max_json {
                if exceeds(values.len(), max)? {
                    return fail("FANOUT_LIMIT", "", "Fan-out exceeds max.");
                }
            }
            let mission = exact::equal(&exact::decode(each)?, &object_path(&["instructions"]));
            let authority = if mission {
                messages::instruction_authority(source, each)?
            } else {
                None
            };
            if mission && (authority.is_none() || values.iter().any(|v| v.as_str().is_none())) {
                return fail(
                    "OPERAND",
                    "",
                    "Fan-out missions require accepted instructing-agent instructions.",
                );
            }
            Ok(TargetBatch::Fanout {
                target: target.clone(),
                list_json: value_json,
                length: values.len().to_string(),
                concurrency_json: concurrency_json.clone(),
                max_json: max_json.clone(),
                mission,
                instruction_authority: authority,
            })
        })();
        match batch {
            Ok(batch) => batches.push(batch),
            Err(error) if ["OPERAND", "FANOUT_LIMIT"].contains(&error.code) => {
                return Ok(Expansion::Failed {
                    target_index,
                    code: error.code,
                    error_json: exact::encode(&object([(
                        "error",
                        object([
                            ("code", string(error.code)),
                            ("message", string(&error.message)),
                            ("details", Value::Array(vec![])),
                        ]),
                    )])),
                })
            }
            Err(error) => return Err(error),
        }
    }
    Ok(Expansion::Ready { batches })
}
pub(super) fn object_path(parts: &[&str]) -> Value {
    Value::Array(parts.iter().map(|s| string(s)).collect())
}
pub(crate) fn instructions_expectation(
    agent_json: &str,
    route_json: &str,
    scopes: &[Scope],
    scope: Option<usize>,
) -> Result<&'static str> {
    let Some(root) = scope else {
        return fail(
            "ROUTES",
            "",
            "A captured route scope is required to classify destinations.",
        );
    };
    let agent = exact::decode(agent_json)?;
    let instructs = matches!(
        exact::record(Some(&agent), "")?.get("instructs"),
        Some(Value::Bool(true))
    );
    enum Task {
        Visit(String, usize),
        Target(RouteTarget, usize),
        Leave(usize),
    }
    let mut tasks = vec![Task::Visit(route_json.to_owned(), root)];
    let mut active = HashSet::new();
    let mut targets = Vec::new();
    while let Some(task) = tasks.pop() {
        match task {
            Task::Leave(index) => {
                active.remove(&index);
            }
            Task::Visit(json, index) => {
                if !active.insert(index) {
                    return fail(
                        "ROUTES",
                        "",
                        "Composition output continuations contain a cycle.",
                    );
                }
                let current = scopes.get(index).ok_or_else(|| {
                    Failure::new(
                        "ROUTES",
                        "",
                        "A captured route scope is required to classify destinations.",
                    )
                })?;
                let normalized = normalize_route(&json, current)?;
                tasks.push(Task::Leave(index));
                tasks.extend(
                    normalized
                        .into_iter()
                        .rev()
                        .map(|target| Task::Target(target, index)),
                );
            }
            Task::Target(RouteTarget::Output { name }, index) => {
                let continuation = scopes[index]
                    .output_routes
                    .as_ref()
                    .and_then(|routes| routes.iter().find(|(key, _)| key == &name))
                    .map(|(_, value)| value)
                    .ok_or_else(|| {
                        Failure::new(
                            "ROUTES",
                            "",
                            "Composition output requires its captured outer route and scope.",
                        )
                    })?;
                tasks.push(Task::Visit(
                    continuation.route_json.clone(),
                    continuation.scope,
                ));
            }
            Task::Target(
                RouteTarget::Step {
                    step_json,
                    declaration_json,
                    ..
                },
                _,
            ) => {
                let step = exact::decode(&step_json)?;
                if ["agent", "approval", "compose"].contains(&exact::text(
                    exact::record(Some(&step), "")?.get("type"),
                    "",
                )?) {
                    let decl = exact::decode(&declaration_json)?;
                    targets.push(if let Some(name) = decl.as_str() {
                        object([("step", string(name))])
                    } else {
                        exact::record(Some(&decl), "")?;
                        clone(&decl)
                    });
                }
            }
        }
    }
    if !instructs {
        return Ok("none");
    }
    let mut expects = false;
    let mut fanout = false;
    let mut single = false;
    for target in &targets {
        let target = exact::record(Some(target), "")?;
        let each_instructions = target
            .get("each")
            .is_some_and(|v| exact::equal(v, &object_path(&["instructions"])));
        fanout |= each_instructions;
        if each_instructions {
            expects = true;
        }
        if !target.contains_key("message") {
            expects = true;
            single |= !each_instructions;
            continue;
        }
        let message = exact::record(target.get("message"), "")?;
        // NumberToken also satisfies the TS object test, then record rejects it.
        if let Some(prompt @ (Value::Object(_) | Value::Number(_))) = message.get("prompt") {
            let selected = exact::record(Some(prompt), "")?;
            if selected
                .get("from")
                .is_some_and(|v| exact::equal(v, &object_path(&["instructions"])))
            {
                expects = true;
                single = true;
            }
            if selected
                .get("from")
                .is_some_and(|v| exact::equal(v, &object_path(&["item"])))
                && each_instructions
            {
                expects = true;
            }
        }
    }
    if fanout && single {
        return fail(
            "MESSAGE_PATH",
            "",
            "A list of missions cannot also be one prompt.",
        );
    }
    Ok(if !expects {
        "none"
    } else if fanout {
        "list"
    } else {
        "string"
    })
}
