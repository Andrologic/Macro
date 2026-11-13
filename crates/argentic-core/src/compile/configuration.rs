//! Detached native observations and frozen configurations, ported from Macro's
//! configuration030.ts. Neither a module nor a shape check qualifies an adapter.
use super::metadata as m;
use crate::argentic_core::{
    exact::{self, Object, Value as E},
    graph::{
        analyse_joins,
        ordered::{OrderedMap, OrderedSet},
        Graph, InBranch,
    },
    native::{self, a, fail, o, s, Error, Text, Value},
    reader::{self, Modules},
    validate::ModuleMap,
    valueschema::{self, PointerPart},
};
type Result<T> = std::result::Result<T, Error>;
fn unique(names: impl IntoIterator<Item = Text>, pointer: &str) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for (i, name) in names.into_iter().enumerate() {
        if !seen.insert(name) {
            return fail(
                "CORRELATION",
                format!("{pointer}/{i}"),
                "Duplicate observation identity.",
            );
        }
    }
    Ok(())
}
pub(crate) fn json(value: &Value, p: &str) -> Result<String> {
    if value.text().is_some_and(|t| t.utf8().is_none()) {
        return fail("PARSE", p, "Invalid UTF-16 in JSON transport text.");
    }
    m::json(value, p)
}
pub(crate) fn nonempty(value: &E) -> bool {
    match value {
        E::String(v) => !Text::from(v.as_str()).trimmed_empty(),
        E::Array(v) => !v.is_empty(),
        E::Object(v) => v.len() > 0,
        _ => false,
    }
}
fn receipt(value: &Value, p: &str) -> Result<String> {
    let captured = json(value, p)?;
    if !nonempty(&exact::decode(&captured)?) {
        return fail(
            "CORRELATION",
            p,
            "A nonempty native authority receipt or envelope is required.",
        );
    }
    Ok(captured)
}
fn nullable(v: &Value, p: &str) -> Result<Value> {
    if matches!(v, Value::Null) {
        Ok(Value::Null)
    } else {
        Ok(s(m::identity(v, p, "UNSUPPORTED")?))
    }
}
fn identities(value: &Value, p: &str) -> Result<Value> {
    let items = m::array(value, p)?
        .iter()
        .enumerate()
        .map(|(i, v)| m::identity(v, &format!("{p}/{i}"), "UNSUPPORTED"))
        .collect::<Result<Vec<_>>>()?;
    unique(items.iter().cloned(), p)?;
    Ok(a(items.into_iter().map(s)))
}
fn objects<'a>(v: &'a Value, p: &str) -> Result<Vec<(&'a Value, String)>> {
    m::array(v, p)?
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let p = format!("{p}/{i}");
            m::object(v, &p, "UNSUPPORTED")?;
            Ok((v, p))
        })
        .collect()
}
fn capabilities(v: &Value, p: &str) -> Result<Value> {
    let mut result = vec![];
    for (entry, p) in objects(v, p)? {
        let name = m::identity(entry.get("name"), &format!("{p}/name"), "UNSUPPORTED")?;
        if !["native", "approximate", "absent"]
            .iter()
            .any(|s| entry.get("support").eq_str(s))
        {
            return fail(
                "UNSUPPORTED",
                format!("{p}/support"),
                "Unknown observed support level.",
            );
        }
        let evidence = if entry.get("support").eq_str("absent") {
            json(entry.get("evidenceJson"), &format!("{p}/evidenceJson"))?
        } else {
            receipt(entry.get("evidenceJson"), &format!("{p}/evidenceJson"))?
        };
        result.push(o([
            ("name", s(name)),
            ("support", entry.get("support").clone()),
            ("evidenceJson", s(evidence)),
        ]));
    }
    unique(
        result.iter().map(|v| v.get("name").text().unwrap().clone()),
        p,
    )?;
    Ok(a(result))
}
pub(crate) fn no_credentials(value: &E, pointer: &str) -> Result<()> {
    static PRIVATE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static TOKEN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let private = PRIVATE
        .get_or_init(|| regex::Regex::new(r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----").unwrap());
    let token=TOKEN.get_or_init(||regex::Regex::new(r"\A(?:(?i-u:Bearer)[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+[^\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+|(?i-u:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}))\z").unwrap());
    enum Task<'a> {
        Visit(&'a E, String),
        Field(String, &'a E, String),
    }
    let mut todo = vec![Task::Visit(value, pointer.to_owned())];
    while let Some(task) = todo.pop() {
        match task {
            Task::Visit(v, p) => {
                if let E::String(v) = v {
                    if private.is_match(v) || token.is_match(v) {
                        return fail(
                            "SECRET_SETTINGS",
                            p,
                            "Credential material cannot enter a frozen configuration.",
                        );
                    }
                }
                let fields: Vec<(String, &E)> = match v {
                    E::Object(v) => v.iter().map(|(k, v)| (k.to_owned(), v)).collect(),
                    E::Array(v) => v
                        .iter()
                        .enumerate()
                        .map(|(i, v)| (i.to_string(), v))
                        .collect(),
                    _ => vec![],
                };
                for (k, v) in fields.into_iter().rev() {
                    let child = exact::at(&p, &k);
                    todo.push(Task::Field(k, v, child));
                }
            }
            Task::Field(key, v, p) => {
                let normalized = key.replace(['-', '_'], "").to_lowercase();
                if [
                    "apikey",
                    "secret",
                    "clientsecret",
                    "password",
                    "passwd",
                    "token",
                    "accesstoken",
                    "refreshtoken",
                    "authorization",
                    "credential",
                    "credentials",
                    "privatekey",
                ]
                .contains(&normalized.as_str())
                {
                    return fail(
                        "SECRET_SETTINGS",
                        p,
                        "Credentials belong outside captured settings.",
                    );
                }
                todo.push(Task::Visit(v, p));
            }
        }
    }
    Ok(())
}
fn settings(v: &Value, p: &str) -> Result<String> {
    let captured = json(v, p)?;
    let value = exact::decode(&captured)?;
    exact::record(Some(&value), p)?;
    no_credentials(&value, p)?;
    Ok(captured)
}
pub(crate) fn module(json: &str, p: &str) -> Result<E> {
    reader::load_harness_module(json.as_bytes())
        .map_err(|_| Error::new("HARNESS_MODULE", p, "Invalid AgSDL 0.3 harness module."))
}
pub(crate) fn capture_registry(input: &Value) -> Result<Value> {
    m::object(input, "/registry", "UNSUPPORTED")?;
    if !input.get("format").eq_str("macro-agsdl-registry/030") {
        return fail(
            "CORRELATION",
            "/registry/format",
            "Unknown captured registry format.",
        );
    }
    let version = m::identity(input.get("version"), "/registry/version", "UNSUPPORTED")?;
    let mut modules = vec![];
    for (entry, p) in objects(input.get("modules"), "/registry/modules")? {
        let harness = m::identity(entry.get("harness"), &format!("{p}/harness"), "UNSUPPORTED")?;
        let raw = json(entry.get("moduleJson"), &format!("{p}/moduleJson"))?;
        let loaded = module(&raw, &format!("{p}/moduleJson"))?;
        if !harness.eq_str(exact::text(
            exact::record(Some(&loaded), "")?.get("name"),
            "",
        )?) {
            return fail(
                "CORRELATION",
                format!("{p}/harness"),
                "Module name differs from its registry identity.",
            );
        }
        modules.push(o([("harness", s(harness)), ("moduleJson", s(raw))]));
    }
    unique(
        modules
            .iter()
            .map(|v| v.get("harness").text().unwrap().clone()),
        "/registry/modules",
    )?;
    let host = if matches!(input.get("hostCapabilities"), Value::Undefined) {
        None
    } else {
        Some(capabilities(
            input.get("hostCapabilities"),
            "/registry/hostCapabilities",
        )?)
    };
    let mut harnesses = vec![];
    for (entry, p) in objects(input.get("harnesses"), "/registry/harnesses")? {
        let harness = m::identity(entry.get("harness"), &format!("{p}/harness"), "UNSUPPORTED")?;
        if !entry.get("installation").eq_str("available")
            && !entry.get("installation").eq_str("missing")
        {
            return fail(
                "UNSUPPORTED",
                format!("{p}/installation"),
                "Expected an installation observation.",
            );
        }
        if !matches!(entry.get("qualified"), Value::Bool(_)) {
            return fail(
                "UNSUPPORTED",
                format!("{p}/qualified"),
                "Expected a qualification observation.",
            );
        }
        let caps = capabilities(entry.get("capabilities"), &format!("{p}/capabilities"))?;
        let mut models = vec![];
        for (model, p) in objects(entry.get("models"), &format!("{p}/models"))? {
            let name = m::identity(model.get("name"), &format!("{p}/name"), "UNSUPPORTED")?;
            let efforts = identities(model.get("efforts"), &format!("{p}/efforts"))?;
            let default = nullable(model.get("defaultEffort"), &format!("{p}/defaultEffort"))?;
            if !matches!(default, Value::Null)
                && !efforts
                    .array()
                    .unwrap()
                    .iter()
                    .any(|v| native::equal(v, &default))
            {
                return fail(
                    "MODEL_UNAVAILABLE",
                    format!("{p}/defaultEffort"),
                    "Default effort is absent from the observed model catalogue.",
                );
            }
            models.push(o([
                ("name", s(name)),
                ("efforts", efforts),
                ("defaultEffort", default),
            ]));
        }
        unique(
            models.iter().map(|v| v.get("name").text().unwrap().clone()),
            &format!("{p}/models"),
        )?;
        let default = nullable(entry.get("defaultModel"), &format!("{p}/defaultModel"))?;
        if !matches!(default, Value::Null)
            && !models
                .iter()
                .any(|v| native::equal(v.get("name"), &default))
        {
            return fail(
                "MODEL_UNAVAILABLE",
                format!("{p}/defaultModel"),
                "Default model is absent from the observed catalogue.",
            );
        }
        let version = nullable(entry.get("version"), &format!("{p}/version"))?;
        let adapter = nullable(entry.get("adapterId"), &format!("{p}/adapterId"))?;
        harnesses.push(o([
            ("harness", s(harness)),
            ("version", version),
            ("installation", entry.get("installation").clone()),
            ("adapterId", adapter),
            ("qualified", entry.get("qualified").clone()),
            ("capabilities", caps),
            ("models", a(models)),
            ("defaultModel", default),
        ]));
    }
    unique(
        harnesses
            .iter()
            .map(|v| v.get("harness").text().unwrap().clone()),
        "/registry/harnesses",
    )?;
    let mut agents = vec![];
    for (entry, p) in objects(input.get("agents"), "/registry/agents")? {
        let raw = json(
            entry.get("agentDeclarationJson"),
            &format!("{p}/agentDeclarationJson"),
        )?;
        let value = exact::decode(&raw)?;
        let declaration = exact::record(Some(&value), &format!("{p}/agentDeclarationJson"))?;
        if let Some(v) = declaration.get("harnessSettings") {
            no_credentials(v, &format!("{p}/agentDeclarationJson/harnessSettings"))?;
        }
        agents.push(o([
            (
                "agentName",
                s(m::identity(
                    entry.get("agentName"),
                    &format!("{p}/agentName"),
                    "UNSUPPORTED",
                )?),
            ),
            ("agentDeclarationJson", s(raw)),
            (
                "settingsJson",
                s(settings(
                    entry.get("settingsJson"),
                    &format!("{p}/settingsJson"),
                )?),
            ),
            (
                "permissionsJson",
                s(receipt(
                    entry.get("permissionsJson"),
                    &format!("{p}/permissionsJson"),
                )?),
            ),
            (
                "scopeJson",
                s(receipt(entry.get("scopeJson"), &format!("{p}/scopeJson"))?),
            ),
            (
                "evidenceJson",
                s(receipt(
                    entry.get("evidenceJson"),
                    &format!("{p}/evidenceJson"),
                )?),
            ),
            (
                "provenanceJson",
                s(receipt(
                    entry.get("provenanceJson"),
                    &format!("{p}/provenanceJson"),
                )?),
            ),
        ]));
    }
    unique(
        agents
            .iter()
            .map(|v| v.get("agentName").text().unwrap().clone()),
        "/registry/agents",
    )?;
    let mut captured = o([
        ("format", s("macro-agsdl-registry/030")),
        ("version", s(version)),
        ("modules", a(modules)),
        ("harnesses", a(harnesses)),
        ("agents", a(agents)),
    ]);
    if let Some(host) = host {
        captured.set("hostCapabilities", host);
    }
    Ok(captured)
}
pub(crate) fn modules(registry: &Value) -> Result<ModuleMap> {
    let mut map = ModuleMap::new();
    for entry in registry.get("modules").array().unwrap() {
        let name = entry.get("harness").text().and_then(Text::utf8).unwrap();
        let raw = entry.get("moduleJson").text().and_then(Text::utf8).unwrap();
        map.set(name, module(&raw, "/registry/modules")?);
    }
    Ok(map)
}
fn capability(observation: &Value, name: &str, p: &str, native: bool) -> Result<()> {
    let cap = observation
        .get("capabilities")
        .array()
        .unwrap()
        .iter()
        .find(|v| v.get("name").eq_str(name));
    if cap.is_none()
        || cap.unwrap().get("support").eq_str("absent")
        || native && !cap.unwrap().get("support").eq_str("native")
    {
        return fail(
            "HARNESS_CAPABILITY",
            p,
            format!(
                "The observed adapter lacks {}qualification for {name}.",
                if native { "native " } else { "" }
            ),
        );
    }
    Ok(())
}
fn range(observation: &Value, range: &str, p: &str) -> Result<()> {
    for cap in observation.get("capabilities").array().unwrap() {
        if !cap.get("support").eq_str("native") {
            continue;
        }
        let raw = cap.get("evidenceJson").text().and_then(Text::utf8).unwrap();
        let value = exact::decode(&raw)?;
        let Some(proof) = value.as_object() else {
            continue;
        };
        if proof.get("kind").and_then(E::as_str) == Some("harness-version-range")
            && proof
                .get("harness")
                .and_then(E::as_str)
                .is_some_and(|s| observation.get("harness").eq_str(s))
            && proof
                .get("version")
                .and_then(E::as_str)
                .is_some_and(|s| observation.get("version").eq_str(s))
            && proof.get("range").and_then(E::as_str) == Some(range)
            && matches!(proof.get("satisfied"), Some(E::Bool(true)))
            && proof.get("receipt").is_some_and(nonempty)
        {
            return Ok(());
        }
    }
    let mut message = Text::from("No native range evaluation binds harness ");
    message.push(observation.get("harness").text().unwrap());
    message.push(&Text::from(", version "));
    if let Some(v) = observation.get("version").text() {
        message.push(v)
    } else {
        message.push(&Text::from("null"));
    }
    message.push(&Text::from(format!(", and range {range}.")));
    fail("HARNESS_VERSION_UNVERIFIED", p, message)
}
fn internal<T>(_: T) -> Error {
    Error::new(
        "COMPILATION",
        "",
        "Invalid compilation input or inconsistent dependency contract.",
    )
}
fn empty() -> &'static Object {
    crate::argentic_core::graph::empty_object()
}
fn optional_object<'a>(v: Option<&'a E>, p: &str) -> Result<&'a Object> {
    match v {
        None | Some(E::Null) => Ok(empty()),
        v => Ok(exact::record(v, p)?),
    }
}
fn covered(document: &Object) -> Result<OrderedSet<String>> {
    let graph = Graph::for_scope(document, None, None).map_err(internal)?;
    let (initial, _) = analyse_joins(&graph).map_err(internal)?;
    let members = initial
        .values()
        .flat_map(|info| info.branches.values().flat_map(|v| v.iter().cloned()))
        .collect();
    Graph::flow_error_covered(document, &members).map_err(internal)
}
fn receivers(document: &Object) -> Result<OrderedSet<String>> {
    if !document.contains_key("flow") {
        return Ok(OrderedSet::new());
    }
    let covered = covered(document)?;
    let compositions = optional_object(document.get("compositions"), "")?;
    let mut in_branch = InBranch::new();
    for composition in std::iter::once(None).chain(compositions.iter().map(|(name, _)| Some(name)))
    {
        let g = Graph::for_scope(
            document,
            composition,
            composition.is_none().then(|| covered.clone()),
        )
        .map_err(internal)?;
        let (infos, _) = analyse_joins(&g).map_err(internal)?;
        in_branch.set(
            composition.map(str::to_owned),
            infos
                .values()
                .flat_map(|info| info.branches.values().flat_map(|v| v.iter().cloned()))
                .collect(),
        );
    }
    let graph = Graph::for_flow(document, Some(in_branch), Some(covered)).map_err(internal)?;
    let mut receivers = OrderedSet::new();
    if let Some(root) = &graph.root {
        receivers.insert(root.clone());
    }
    loop {
        let mut changed = false;
        for edge in &graph.edges {
            let source = graph.nodes.get(&edge.src);
            let has = if let Some(message) = edge.message {
                let message = exact::record(Some(message), "")?;
                message.contains_key("resources")
                    && exact::record(message.get("resources"), "")?.len() > 0
            } else {
                edge.kind == crate::argentic_core::graph::RouteKind::Error
                    || source.is_some_and(|s| {
                        ["agent", "call", "join"].contains(&s.kind)
                            || s.kind == "approval" && receivers.contains(&edge.src)
                    })
            };
            if has && receivers.insert(edge.dst.clone()) {
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    Ok(receivers)
}
pub(crate) type Use = (String, String, Option<Vec<String>>);
pub(crate) fn used_properties(
    document: &Object,
    agent_name: &str,
    agent: &Object,
    p: &str,
) -> Result<Vec<Use>> {
    let mut used: OrderedMap<String, OrderedMap<String, (String, Option<Vec<String>>)>> =
        OrderedMap::new();
    let mut add = |name: &str, where_: String, step: Option<Vec<String>>| {
        if !used.contains_key(name) {
            used.set(name.to_owned(), OrderedMap::new());
        }
        let key = format!(
            "{where_}\0{}",
            step.as_ref().map(|s| s.join("/")).unwrap_or_default()
        );
        used.get_mut(name).unwrap().set(key, (where_, step));
    };
    for key in ["resources", "skills", "mcpServers"] {
        if agent.get(key).is_some_and(|v| match v {
            E::Object(v) => v.len() > 0,
            E::Array(v) => !v.is_empty(),
            E::Number(_) => true,
            _ => false,
        }) {
            add(key, exact::at(p, key), None);
        }
    }
    let model = optional_object(agent.get("model"), &exact::at(p, "model"))?;
    for key in ["name", "effort"] {
        if model.contains_key(key) {
            add(&format!("model.{key}"), format!("{p}/model/{key}"), None);
        }
    }
    if matches!(agent.get("plan"), Some(E::Bool(true))) {
        add("plan", format!("{p}/plan"), None);
    }
    if let Some(value) = agent.get("planFirst") {
        let value = exact::text(Some(value), "")?;
        add(
            &format!("planFirst.{value}"),
            format!("{p}/planFirst"),
            None,
        );
    }
    if matches!(
        agent.get("permissions"),
        Some(E::Object(_)) | Some(E::Null) | Some(E::Array(_)) | Some(E::Number(_))
    ) {
        let permissions = exact::record(agent.get("permissions"), &format!("{p}/permissions"))?;
        if let Some(v) = permissions.get("reviewer") {
            let reviewer = exact::text(Some(v), "")?;
            add(
                &format!("reviewer.{reviewer}"),
                format!("{p}/permissions/reviewer"),
                None,
            );
        }
        if optional_object(permissions.get("directories"), "")?.len() > 0 {
            add("directories", format!("{p}/permissions/directories"), None);
        }
    }
    let receivers = receivers(document)?;
    let mut graphs = vec![];
    let has_flow = document.contains_key("flow");
    if has_flow {
        graphs.push(Graph::for_flow(document, None, None).map_err(internal)?);
    }
    for (name, _) in optional_object(document.get("compositions"), "")?.iter() {
        graphs.push(Graph::for_composition(document, name, None).map_err(internal)?);
    }
    for (i, graph) in graphs.iter().enumerate() {
        for node in graph.nodes.values() {
            if node.agent.as_deref() != Some(agent_name) {
                continue;
            }
            let Some(decl) = node.decl else {
                continue;
            };
            let where_ = valueschema::path_pointer(&node.pointer);
            let step = if i == 0 && has_flow {
                Some(node.addr.split('/').map(str::to_owned).collect())
            } else {
                None
            };
            if decl.get("instance").and_then(E::as_str) == Some("new") {
                add("instance.new", format!("{where_}/instance"), step.clone());
            } else if decl.get("delivery").and_then(E::as_str) != Some("steer") {
                add("delivery.queue", format!("{where_}/delivery"), step.clone());
            }
            if decl.get("delivery").and_then(E::as_str) == Some("steer") {
                add("delivery.steer", format!("{where_}/delivery"), step.clone());
            }
            if i == 0 && has_flow && receivers.contains(&node.addr) {
                add("resources", where_, step);
            }
        }
    }
    Ok(used
        .iter()
        .flat_map(|(name, paths)| {
            paths
                .values()
                .map(|(where_, step)| (name.clone(), where_.clone(), step.clone()))
        })
        .collect())
}
pub(crate) fn capture_agent(
    document_json: &Value,
    agent_name: &Value,
    registry: &Value,
) -> Result<Value> {
    let captured = capture_registry(registry)?;
    let document = exact::decode(&json(document_json, "/document")?)?;
    let document = exact::record(Some(&document), "")?;
    let modules = modules(&captured)?;
    let validation = reader::validate_exact(
        &E::Object(exact::Object::from_entries(
            document
                .iter()
                .map(|(k, v)| (k.to_owned(), exact::values::clone(v))),
        )),
        Modules::Explicit(&modules),
    )
    .map_err(internal)?;
    if let Some(error) = validation
        .diagnostics
        .iter()
        .find(|d| d.severity == "error")
    {
        return fail(error.code, error.path.clone(), error.message.clone());
    }
    let name = m::identity(agent_name, "/agentName", "UNSUPPORTED")?;
    let pointer = m::at(&Text::from("/agents"), &name);
    let definitions = exact::record(document.get("agents"), "/agents")?;
    let Some(name_utf8) = name.utf8().filter(|name| definitions.contains_key(name)) else {
        return fail("CORRELATION", pointer, "No such agent definition.");
    };
    let p = pointer.utf8().unwrap();
    let agent = exact::record(definitions.get(&name_utf8), &p)?;
    let proof = captured
        .get("agents")
        .array()
        .unwrap()
        .iter()
        .find(|v| v.get("agentName").text() == Some(&name));
    if proof.is_none()
        || !exact::equal(
            &exact::decode(&json(proof.unwrap().get("agentDeclarationJson"), "")?)?,
            definitions.get(&name_utf8).unwrap(),
        )
    {
        return fail(
            "CORRELATION",
            p,
            "No native observation matches the complete agent declaration.",
        );
    }
    let proof = proof.unwrap();
    let harness = exact::text(agent.get("harness"), &format!("{p}/harness"))?;
    let observation = captured
        .get("harnesses")
        .array()
        .unwrap()
        .iter()
        .find(|v| v.get("harness").eq_str(harness));
    if observation.is_none() || !observation.unwrap().get("installation").eq_str("available") {
        return fail(
            "HARNESS_INSTALLATION",
            format!("{p}/harness"),
            "The requested harness is not observed as installed.",
        );
    }
    let observation = observation.unwrap();
    if matches!(observation.get("adapterId"), Value::Null) {
        return fail(
            "HARNESS_ADAPTER",
            format!("{p}/harness"),
            "No native adapter is registered for this harness.",
        );
    }
    if !matches!(observation.get("qualified"), Value::Bool(true)) {
        return fail(
            "HARNESS_QUALIFICATION",
            format!("{p}/harness"),
            "The installed adapter is not qualified.",
        );
    }
    if matches!(observation.get("version"), Value::Null) {
        return fail(
            "HARNESS_VERSION_UNVERIFIED",
            format!("{p}/harness"),
            "The installed harness version was not observed.",
        );
    }
    for name in [
        "result-submission",
        "continuity",
        "permission-enforcement",
        "contained-stop",
        "response-attribution",
    ] {
        capability(observation, name, &format!("{p}/harness"), true)?;
    }
    for (key, cap) in [
        ("completionCheck", "completion-check"),
        ("answerTimeoutMs", "answer-timeout"),
        ("instructions", "instructions"),
    ] {
        if agent.contains_key(key) {
            capability(observation, cap, &format!("{p}/{key}"), true)?;
        }
    }
    if let Some(v) = agent.get("harnessVersion") {
        range(
            observation,
            exact::text(Some(v), "")?,
            &format!("{p}/harnessVersion"),
        )?;
    }
    let module = modules.get(harness);
    for (key, where_, _) in used_properties(document, &name_utf8, agent, &p)? {
        capability(
            observation,
            &key,
            &where_,
            key == "planFirst.ask" || key == "delivery.queue",
        )?;
        if let Some(support) = module
            .and_then(E::as_object)
            .and_then(|m| m.get("properties"))
            .and_then(E::as_object)
            .and_then(|p| p.get(&key))
            .and_then(E::as_object)
        {
            if let Some(v) = support.get("versions") {
                range(observation, exact::text(Some(v), "")?, &where_)?;
            }
        }
    }
    let authored_settings = optional_object(
        agent.get("harnessSettings"),
        &format!("{p}/harnessSettings"),
    )?;
    if let Some(v) = agent.get("harnessSettings") {
        no_credentials(v, &format!("{p}/harnessSettings"))?;
    }
    let effective = exact::decode(&json(proof.get("settingsJson"), "")?)?;
    let effective = exact::record(Some(&effective), "")?;
    if agent.contains_key("harnessSettings") || effective.len() > 0 {
        capability(
            observation,
            "harness-settings",
            &format!("{p}/harnessSettings"),
            true,
        )?;
        if let Some(schema) = module
            .and_then(E::as_object)
            .and_then(|m| m.get("settings"))
        {
            let value = E::Object(exact::Object::from_entries(
                effective
                    .iter()
                    .map(|(k, v)| (k.to_owned(), exact::values::clone(v))),
            ));
            let problems = valueschema::validate(
                &value,
                schema,
                &[
                    PointerPart::Key("agents".into()),
                    PointerPart::Key(name_utf8.clone()),
                    PointerPart::Key("harnessSettings".into()),
                ],
            )
            .map_err(internal)?;
            if let Some((pointer, message)) = problems.first() {
                return fail("HARNESS_SETTINGS", pointer.clone(), message.clone());
            }
        } else if module.is_some() {
            return fail(
                "HARNESS_SETTINGS",
                format!("{p}/harnessSettings"),
                "The module declares no effective settings schema.",
            );
        }
    }
    for (key, v) in authored_settings.iter() {
        if !effective.get(key).is_some_and(|e| exact::equal(e, v)) {
            return fail(
                "CORRELATION",
                exact::at(&format!("{p}/harnessSettings"), key),
                "Effective settings differ from the requested settings.",
            );
        }
    }
    let requested = optional_object(agent.get("model"), &format!("{p}/model"))?;
    let model_name = if let Some(v) = requested.get("name") {
        s(exact::text(Some(v), "")?)
    } else {
        observation.get("defaultModel").clone()
    };
    let model = observation
        .get("models")
        .array()
        .unwrap()
        .iter()
        .find(|v| native::equal(v.get("name"), &model_name));
    let Some(model) = model else {
        return fail(
            "MODEL_UNAVAILABLE",
            format!("{p}/model/name"),
            "The requested or default model is not observed as available.",
        );
    };
    let effort = if let Some(v) = requested.get("effort") {
        s(exact::text(Some(v), "")?)
    } else {
        model.get("defaultEffort").clone()
    };
    if !matches!(effort, Value::Null)
        && !model
            .get("efforts")
            .array()
            .unwrap()
            .iter()
            .any(|v| native::equal(v, &effort))
    {
        return fail(
            "MODEL_UNAVAILABLE",
            format!("{p}/model/effort"),
            "The requested or default effort is not advertised by the observed model.",
        );
    }
    let mut frozen = proof.clone();
    frozen.set("harness", s(harness));
    frozen.set("harnessVersion", observation.get("version").clone());
    frozen.set("adapterId", observation.get("adapterId").clone());
    frozen.set("modelName", model.get("name").clone());
    frozen.set("modelEffort", effort);
    Ok(frozen)
}
