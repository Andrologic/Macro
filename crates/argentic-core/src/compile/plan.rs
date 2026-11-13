//! compiler030.ts, with an owned pre-digest capture and a separate pure finish.
use super::{configuration as c, graph, metadata as m};
use crate::argentic_core::{
    exact::{self, Value as E},
    native::{self, a, o, s, Error, Text, Value},
    reader::{self, Modules},
    validate::{ModuleMap, Report},
};
use sha2::{Digest, Sha256};
pub(crate) const PROFILE: &str = "macro-agsdl-030-v1";
pub(crate) const COMPILER: &str = "macro-agsdl-compiler/030";
pub(crate) const RUNTIME: &str = "macro-agsdl-runtime/030";
pub(crate) struct Prepared {
    assessment: Value,
    runtime: Value,
    document: Option<E>,
    registry: Option<Value>,
    source: Option<Value>,
    bytes: Vec<u8>,
    ready: bool,
}
fn diagnostic(code: &str, pointer: Value, message: Value, severity: bool) -> Value {
    let mut d = o([
        ("code", s(code)),
        ("pointer", pointer),
        ("message", message),
    ]);
    if severity {
        d.set("severity", s("error"));
    }
    d
}
fn report(report: Report) -> Value {
    o([
        ("valid", Value::Bool(report.valid())),
        (
            "diagnostics",
            a(report.diagnostics.into_iter().map(|d| {
                let mut out = o([
                    ("code", s(d.code)),
                    ("pointer", s(d.path)),
                    ("message", s(d.message)),
                    ("severity", s(d.severity)),
                ]);
                if let Some(step) = d.step.filter(|s| !s.is_empty()) {
                    out.set("step", a(step.into_iter().map(s)));
                }
                out
            })),
        ),
    ])
}
fn internal<T>(_: T) -> Error {
    Error::new(
        "COMPILATION",
        "",
        "Invalid compilation input or inconsistent dependency contract.",
    )
}
impl Prepared {
    fn catch(&mut self, error: Error) {
        let mut d = diagnostic(error.code, s(error.pointer), s(error.message), true);
        if self
            .assessment
            .get("diagnostics")
            .array()
            .unwrap()
            .is_empty()
            && !self.assessment.get("valid").truthy()
        {
            d.set("code", s("PARSE"));
            self.assessment = o([("valid", Value::Bool(false)), ("diagnostics", a([d]))]);
        } else {
            self.runtime.set("supported", Value::Bool(false));
            self.runtime.set("diagnostics", a([d]));
        }
        self.ready = false;
    }
    fn unavailable(self) -> Value {
        o([
            ("static", self.assessment),
            ("runtime", self.runtime),
            ("plan", Value::Null),
            ("compiledPlanJson", Value::Null),
            ("productRuntimeAvailable", Value::Bool(false)),
        ])
    }
}
/// Every caller-owned input needed after the digest is copied before returning.
pub(crate) fn prepare(authored: &Value, source: &Value, input: &Value) -> Prepared {
    let mut state = Prepared {
        assessment: o([("valid", Value::Bool(false)), ("diagnostics", a([]))]),
        runtime: o([
            ("profile", s(PROFILE)),
            ("registryVersion", s("")),
            ("source", Value::Null),
            ("supported", Value::Bool(false)),
            ("diagnostics", a([])),
            ("unassessed", a([])),
        ]),
        document: None,
        registry: None,
        source: None,
        bytes: vec![],
        ready: false,
    };
    let result = (|| -> Result<(), Error> {
        let Some(text) = authored.text() else {
            return native::fail("PARSE", "", "Authored source must be primitive text.");
        };
        state.bytes = text.lossy().into_bytes();
        let document = super::source::read_text(text).ok();
        if !document.as_ref().is_some_and(|v| v.as_object().is_some()) {
            state.assessment = report(
                reader::read(&state.bytes, Modules::Explicit(&ModuleMap::new()))
                    .map_err(internal)?,
            );
            if state.assessment.get("valid").truthy() {
                state.assessment = o([
                    ("valid", Value::Bool(false)),
                    (
                        "diagnostics",
                        a([o([
                            ("code", s("PARSE")),
                            ("pointer", s("")),
                            ("severity", s("error")),
                            ("message", s("Invalid exact JSON source.")),
                        ])]),
                    ),
                ]);
            }
            return Ok(());
        }
        state.document = document;
        state.assessment = report(
            reader::read(&state.bytes, Modules::Explicit(&ModuleMap::new())).map_err(internal)?,
        );
        let source = m::capture_source(source)?;
        state.runtime.set("source", source.clone());
        state.source = Some(source);
        let registry = c::capture_registry(input)?;
        state
            .runtime
            .set("registryVersion", registry.get("version").clone());
        let modules = c::modules(&registry)?;
        let mut unassessed = vec![];
        for observation in registry.get("harnesses").array().unwrap() {
            if let Some(module) = observation
                .get("harness")
                .text()
                .and_then(Text::utf8)
                .and_then(|name| modules.get(&name))
            {
                if observation.get("installation").eq_str("available") {
                    let mut line = Text::from("Harness ");
                    line.push(observation.get("harness").text().unwrap());
                    line.push(&Text::from(" version "));
                    line.push(
                        observation
                            .get("version")
                            .text()
                            .unwrap_or(&Text::from("unknown")),
                    );
                    line.push(&Text::from(" against module range "));
                    line.push(&Text::from(exact::text(
                        module.as_object().unwrap().get("harnessVersions"),
                        "",
                    )?));
                    unassessed.push(s(line));
                }
            }
        }
        unassessed.push(s(
            "Native admission of resources in later graphless messages",
        ));
        state.runtime.set("unassessed", a(unassessed));
        state.assessment =
            report(reader::read(&state.bytes, Modules::Explicit(&modules)).map_err(internal)?);
        state.ready = state.assessment.get("valid").truthy();
        state.registry = Some(registry);
        Ok(())
    })();
    if let Err(error) = result {
        state.catch(error);
    }
    state
}
pub(crate) fn finish(mut state: Prepared) -> Value {
    if !state.ready {
        return state.unavailable();
    }
    let result = (|| -> Result<(Value, Value, bool), Error> {
        let source = state.source.as_ref().unwrap();
        let digest = format!("{:x}", Sha256::digest(&state.bytes));
        if !source.get("sourceSha256").eq_str(&digest) {
            return native::fail(
                "CORRELATION",
                "/source/sourceSha256",
                "Captured SHA does not match authored bytes.",
            );
        }
        let document = state.document.as_ref().unwrap();
        let document_json = exact::encode(document);
        let document = exact::record(Some(document), "")?;
        let registry = state.registry.as_ref().unwrap();
        let mut agents = vec![];
        for (name, _) in exact::record(document.get("agents"), "")?.iter() {
            agents.push(c::capture_agent(
                &s(document_json.clone()),
                &s(name),
                registry,
            )?);
        }
        let mut warnings = vec![];
        for agent in &agents {
            let name = agent.get("agentName").text().unwrap().utf8().unwrap();
            let definition =
                exact::record(exact::record(document.get("agents"), "")?.get(&name), "")?;
            let observation = registry
                .get("harnesses")
                .array()
                .unwrap()
                .iter()
                .find(|v| native::equal(v.get("harness"), agent.get("harness")))
                .ok_or_else(|| internal(()))?;
            let uses =
                c::used_properties(document, &name, definition, &exact::at("/agents", &name))?;
            let concrete: std::collections::HashSet<_> = uses
                .iter()
                .filter(|(_, _, step)| step.is_some())
                .map(|(name, p, _)| format!("{name}\0{p}"))
                .collect();
            for (name, p, step) in uses {
                if step.is_none() && concrete.contains(&format!("{name}\0{p}")) {
                    continue;
                }
                let capability = observation
                    .get("capabilities")
                    .array()
                    .unwrap()
                    .iter()
                    .find(|v| v.get("name").eq_str(&name));
                let reported = state
                    .assessment
                    .get("diagnostics")
                    .array()
                    .unwrap()
                    .iter()
                    .any(|d| {
                        d.get("code").eq_str("HARNESS_APPROXIMATE")
                            && d.get("severity").eq_str("warning")
                            && d.get("pointer").eq_str(&p)
                            && step.as_ref().is_none_or(|step| {
                                d.get("step").array().is_some_and(|v| {
                                    v.iter()
                                        .map(|s| s.text().unwrap().utf8().unwrap())
                                        .collect::<Vec<_>>()
                                        .join("/")
                                        == step.join("/")
                                })
                            })
                    });
                if capability.is_some_and(|v| v.get("support").eq_str("approximate")) && !reported {
                    let harness = agent.get("harness").text().unwrap().utf8().unwrap();
                    let mut d = o([
                        ("code", s("HARNESS_APPROXIMATE")),
                        ("pointer", s(p)),
                        ("severity", s("warning")),
                        (
                            "message",
                            s(format!(
                                "The observed {harness} adapter approximates {name}."
                            )),
                        ),
                    ]);
                    if let Some(step) = step {
                        d.set("step", a(step.into_iter().map(s)));
                    }
                    warnings.push(d);
                }
            }
        }
        let graph = graph::compile(document)?;
        for step in &graph.steps {
            let raw = step.get("declarationJson").text().unwrap().utf8().unwrap();
            let value = exact::decode(&raw)?;
            let declaration = exact::record(Some(&value), "")?;
            let required = if step.get("type").eq_str("call") {
                Some(if declaration.contains_key("command") {
                    "call.command"
                } else {
                    "call.mcp"
                })
            } else if step.get("type").eq_str("approval") {
                Some("approval")
            } else {
                None
            };
            if let Some(required) = required {
                if !registry
                    .get("hostCapabilities")
                    .array()
                    .is_some_and(|caps| {
                        caps.iter().any(|v| {
                            v.get("name").eq_str(required) && v.get("support").eq_str("native")
                        })
                    })
                {
                    let scope = graph
                        .scopes
                        .iter()
                        .find(|v| native::equal(v.get("address"), step.get("scope")));
                    let owner = scope
                        .and_then(|v| v.get("composition").text())
                        .and_then(Text::utf8)
                        .map(|c| format!("/compositions/{c}"))
                        .unwrap_or("/flow".into());
                    let name = step
                        .get("address")
                        .array()
                        .unwrap()
                        .last()
                        .unwrap()
                        .text()
                        .unwrap()
                        .utf8()
                        .unwrap();
                    return native::fail(
                        "HOST_CAPABILITY",
                        format!("{owner}/steps/{name}"),
                        format!("No native host qualification for {required}."),
                    );
                }
            }
        }
        let product = (!agents.is_empty()
            || graph.steps.iter().any(|s| s.get("type").eq_str("call")))
            && agents.iter().all(|agent| {
                registry.get("harnesses").array().unwrap().iter().any(|v| {
                    native::equal(v.get("harness"), agent.get("harness"))
                        && v.get("harness").eq_str("codex")
                        && v.get("installation").eq_str("available")
                        && v.get("qualified").truthy()
                        && v.get("adapterId").eq_str("codex-app-server-v1")
                })
            });
        let versions = o([
            ("snapshot", s("2")),
            ("contract", s("agsdl-0.3.0")),
            ("compiler", s(COMPILER)),
            ("runtime", s(RUNTIME)),
            ("registry", registry.get("version").clone()),
            ("profile", s(PROFILE)),
        ]);
        let mut plan = o([
            ("format", s("macro-agsdl-compiled-plan/2")),
            ("versions", versions),
            ("source", source.clone()),
            ("documentJson", s(document_json)),
            ("agents", a(agents)),
        ]);
        let graph = graph.value();
        for (k, v) in graph.object().unwrap() {
            plan.set(k.clone(), v.clone());
        }
        Ok((plan, a(warnings), product))
    })();
    match result {
        Err(error) => {
            state.catch(error);
            state.unavailable()
        }
        Ok((plan, warnings, product)) => {
            state.runtime.set("supported", Value::Bool(true));
            state.runtime.set("diagnostics", warnings);
            let encoded = plan.stringify();
            o([
                ("static", state.assessment),
                ("runtime", state.runtime),
                ("plan", plan),
                ("compiledPlanJson", s(encoded)),
                ("productRuntimeAvailable", Value::Bool(product)),
            ])
        }
    }
}
pub(crate) fn compile(authored: &Value, source: &Value, registry: &Value) -> Value {
    finish(prepare(authored, source, registry))
}
