//! Differential reader tests (D15 2.c.2). Process transport and corpus IO
//! belong to Macro's tests, never to the staged pure core. The CI filter
//! `conformance030_tests` selects this module.
//!
//! Reports, graph snapshots and module copies are compared as exact text;
//! spans, problems and permission results as ordered JSON arrays. Nothing is
//! sorted or normalized before the comparison.
use crate::argentic_core::{
    exact::{quote, scan, stringify, Object, Value},
    graph::{analyse_joins, open_body_forks, Graph},
    reader::{self, Modules},
    schema::{self, SchemaChecker},
    validate::{permissions, ModuleMap, ReadError},
    valueschema::PointerPart,
};
use crate::argentic_values_conformance030_tests::Oracle;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::OnceLock, time::Duration};

mod corpus;

fn string<'a>(request: &'a Json, key: &str) -> &'a str {
    request[key].as_str().unwrap()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn ok(output: Json) -> Json {
    json!({"status":"ok","output":output})
}
fn failure(error: ReadError) -> Json {
    match error {
        ReadError::Module(error) => json!({"status":"moduleError","message":error.message}),
        ReadError::Internal(error) => json!({"status":"internal","message":error.message}),
    }
}
fn tree(text: &str) -> Result<Value, String> {
    scan::parse_v030(text.as_bytes())
        .map(|parsed| parsed.tree)
        .map_err(|error| error.message())
}

/// The caller's map, built like the oracle: `loadHarnessModule` or a raw tree.
fn modules(spec: &Json) -> Result<Option<ModuleMap>, Json> {
    if spec["kind"] == "pinned" {
        return Ok(None);
    }
    let mut map = ModuleMap::new();
    for entry in spec["entries"].as_array().unwrap() {
        let json = string(entry, "json");
        let module = if entry["load"] == true {
            reader::load_harness_module(json.as_bytes()).map_err(|error| match error {
                ReadError::Module(error) => error.message,
                ReadError::Internal(error) => error.message,
            })
        } else {
            tree(json)
        };
        match module {
            Ok(module) => map.set(string(entry, "name").to_owned(), module),
            Err(message) => return Err(json!({"status":"setupError","message":message})),
        }
    }
    Ok(Some(map))
}

fn with_modules(spec: &Json, run: impl FnOnce(Modules<'_>) -> Json) -> Json {
    match modules(spec) {
        Err(setup) => setup,
        Ok(None) => run(Modules::Pinned),
        Ok(Some(map)) => run(Modules::Explicit(&map)),
    }
}

fn host_message() -> &'static SchemaChecker {
    static CELL: OnceLock<SchemaChecker> = OnceLock::new();
    CELL.get_or_init(|| {
        // hostCompilation.ts: hostMessageShape030.
        SchemaChecker::new(
            schema::root_with_document_defs(
                r##""type":"object","additionalProperties":false,"properties":{"prompt":{"$ref":"#/$defs/instructions"},"resources":{"$ref":"#/$defs/resources"}}"##,
            )
            .unwrap(),
        )
    })
}

/// Text of the JS snapshot: JSON arrays without spaces, values in exact form.
enum J {
    S(String),
    N(usize),
    Null,
    Raw(String),
    A(Vec<J>),
}
fn render(value: &J, out: &mut String) {
    match value {
        J::S(text) => out.push_str(&quote(text)),
        J::N(number) => out.push_str(&number.to_string()),
        J::Null => out.push_str("null"),
        J::Raw(text) => out.push_str(text),
        J::A(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                render(item, out);
            }
            out.push(']');
        }
    }
}
fn s(text: &str) -> J {
    J::S(text.to_owned())
}
fn opt(text: Option<&str>) -> J {
    text.map_or(J::Null, s)
}
fn pointer(parts: &[PointerPart]) -> J {
    J::A(
        parts
            .iter()
            .map(|part| match part {
                PointerPart::Key(name) => s(name),
                PointerPart::Index(index) => J::N(*index),
                PointerPart::Number(token) => J::Raw(token.raw().to_owned()),
            })
            .collect(),
    )
}
fn object_text(object: &Object) -> String {
    let members: Vec<String> = object
        .iter()
        .map(|(key, value)| format!("{}:{}", quote(key), stringify(value)))
        .collect();
    format!("{{{}}}", members.join(","))
}
fn set(values: impl IntoIterator<Item = impl AsRef<str>>) -> J {
    J::A(values.into_iter().map(|value| s(value.as_ref())).collect())
}

fn describe(graph: &Graph<'_>) -> J {
    let (infos, problems) = analyse_joins(graph).unwrap();
    let forks = open_body_forks(graph, &infos).unwrap();
    let nodes = graph
        .nodes
        .iter()
        .map(|(addr, node)| {
            let scope = &graph.scopes[node.scope];
            J::A(vec![
                s(addr),
                s(node.kind),
                s(&node.name),
                pointer(&node.pointer),
                opt(node.agent.as_deref()),
                opt(scope.composition.as_deref()),
                s(&scope.prefix),
            ])
        })
        .collect();
    let composes = graph
        .composes
        .iter()
        .map(|(addr, compose)| {
            let child = compose.child.map_or(J::Null, |child| {
                let scope = &graph.scopes[child];
                J::A(vec![
                    s(&scope.prefix),
                    opt(scope.composition.as_deref()),
                    opt(scope.compose.as_deref()),
                    opt(scope.compose_name.as_deref()),
                    scope
                        .parent
                        .map_or(J::Null, |parent| s(&graph.scopes[parent].prefix)),
                    J::A(
                        scope
                            .bindings
                            .iter()
                            .map(|(name, bound)| J::A(vec![s(name), opt(bound.as_deref())]))
                            .collect(),
                    ),
                ])
            });
            let target = compose.decl.get("composition").and_then(Value::as_str);
            J::A(vec![
                s(addr),
                opt(target),
                child,
                s(&graph.scopes[compose.parent].prefix),
            ])
        })
        .collect();
    let edges = graph
        .edges
        .iter()
        .map(|edge| {
            J::A(vec![
                s(&edge.src),
                s(&edge.dst),
                s(edge.kind.as_str()),
                opt(edge.key.as_deref()),
                edge.message
                    .map_or(J::Null, |message| J::Raw(stringify(message))),
                pointer(&edge.pointer),
                edge.fanout
                    .map_or(J::Null, |fanout| J::Raw(object_text(fanout))),
            ])
        })
        .collect();
    let idom = graph
        .immediate_dominators()
        .unwrap()
        .iter()
        .map(|(n, d)| J::A(vec![s(n), s(d)]))
        .collect();
    let joins = infos
        .iter()
        .map(|(addr, info)| {
            J::A(vec![
                s(addr),
                s(&info.origin),
                J::A(
                    info.branches
                        .iter()
                        .map(|(start, members)| J::A(vec![s(start), set(members)]))
                        .collect(),
                ),
                J::A(
                    info.names
                        .iter()
                        .map(|(start, name)| J::A(vec![s(start), opt(name.as_deref())]))
                        .collect(),
                ),
                set(&info.fanout),
            ])
        })
        .collect();
    let problems = problems
        .iter()
        .map(|problem| {
            J::A(vec![
                s("JOIN"),
                pointer(&problem.pointer),
                s(&problem.addr),
                s(&problem.message),
            ])
        })
        .collect();
    let forks = forks
        .iter()
        .map(|problem| {
            J::A(vec![
                pointer(&problem.pointer),
                s(&problem.addr),
                s(&problem.message),
            ])
        })
        .collect();
    J::A(vec![
        opt(graph.root.as_deref()),
        J::A(nodes),
        J::A(composes),
        J::A(edges),
        J::A(idom),
        J::A(joins),
        J::A(problems),
        J::A(forks),
    ])
}

fn graph_snapshot(document: &Value) -> Json {
    if !schema::document_schema()
        .unwrap()
        .check(document)
        .unwrap()
        .is_empty()
    {
        return json!({"inDomain":false});
    }
    let doc = document.as_object().unwrap();
    let mut graphs: Vec<(String, Graph<'_>)> = Vec::new();
    let mut covered_list = J::Null;
    let flow = doc.get("flow").and_then(Value::as_object);
    if let Some(flow) = flow {
        let entry = flow.get("entry").and_then(Value::as_str).unwrap();
        if flow
            .get("steps")
            .and_then(Value::as_object)
            .unwrap()
            .contains_key(entry)
        {
            let scope = Graph::for_scope(doc, None, None).unwrap();
            let (initial, _) = analyse_joins(&scope).unwrap();
            let mut members = crate::argentic_core::graph::ordered::OrderedSet::new();
            for info in initial.values() {
                for found in info.branches.values() {
                    for member in found {
                        members.insert(member.split('/').next().unwrap().to_owned());
                    }
                }
            }
            let covered = Graph::flow_error_covered(doc, &members).unwrap();
            covered_list = set(&covered);
            graphs.push(("scope:flow".to_owned(), scope));
            graphs.push((
                "scope:flow:covered".to_owned(),
                Graph::for_scope(doc, None, Some(covered.clone())).unwrap(),
            ));
            graphs.push((
                "flow".to_owned(),
                Graph::for_flow(doc, None, Some(covered)).unwrap(),
            ));
            graphs.push((
                "flow:plain".to_owned(),
                Graph::for_flow(doc, None, None).unwrap(),
            ));
        }
    }
    let compositions = doc.get("compositions").and_then(Value::as_object);
    for (name, composition) in compositions.into_iter().flat_map(Object::iter) {
        let composition = composition.as_object().unwrap();
        let entry = composition.get("entry").and_then(Value::as_str).unwrap();
        if !composition
            .get("steps")
            .and_then(Value::as_object)
            .unwrap()
            .contains_key(entry)
        {
            continue;
        }
        graphs.push((
            format!("scope:{name}"),
            Graph::for_scope(doc, Some(name), None).unwrap(),
        ));
        graphs.push((
            format!("composition:{name}"),
            Graph::for_composition(doc, name, None).unwrap(),
        ));
    }
    let snapshot = J::A(vec![
        covered_list,
        J::A(
            graphs
                .iter()
                .map(|(label, graph)| J::A(vec![s(label), describe(graph)]))
                .collect(),
        ),
    ]);
    let mut text = String::new();
    render(&snapshot, &mut text);
    json!({"inDomain":true,"snapshot":text})
}

fn permission(request: &Json) -> Json {
    let value = match request["permissions"].as_str() {
        None => None,
        Some(text) => Some(tree(text).unwrap()),
    };
    let value = value.as_ref();
    let action = string(request, "action");
    let result = match string(request, "fn") {
        "normalize" => {
            let (preset, rules) = permissions::normalize(value).unwrap();
            let rules: Vec<Json> = rules
                .iter()
                .map(|rule| json!([rule.action, rule.effect, rule.matcher]))
                .collect();
            json!([preset, rules])
        }
        "outside" => json!(permissions::outside(value).unwrap()),
        "shell_denied" => json!(permissions::shell_denied(value).unwrap()),
        "effect_for" => {
            json!(permissions::effect_for(value, action, string(request, "subject")).unwrap())
        }
        "effects_in_use" => json!(permissions::effects_in_use(value).unwrap()),
        "covers_all" => {
            let wrapper = tree(&format!("{{\"rules\":[{}]}}", string(request, "rule"))).unwrap();
            let (_, rules) = permissions::normalize(Some(&wrapper)).unwrap();
            json!(permissions::covers_all(&rules[0]))
        }
        "glob" => json!(permissions::glob_matches(
            string(request, "pattern"),
            string(request, "subject"),
            request["paths"] == true,
            request["command"] == true
        )),
        "command_prefix" => json!(permissions::command_prefix(string(request, "pattern"))),
        other => panic!("unknown permission helper {other}"),
    };
    json!({"result":result})
}

/// Same bytes as `approvalChain030` in the oracle.
pub(crate) fn approval_chain(depth: usize) -> String {
    let mut steps = vec![r#""s":{"type":"agent","agent":"w","next":"a0"}"#.to_owned()];
    for i in 0..depth {
        let step = if i + 1 == depth {
            r#"{"type":"approval","next":{"ok":{"step":"t","message":{"resources":{"r":{"from":["message","resources","zz"]}}}},"retry":"t"}}"#.to_owned()
        } else {
            format!(r#"{{"type":"approval","next":{{"ok":"a{}"}}}}"#, i + 1)
        };
        steps.push(format!("\"a{i}\":{step}"));
    }
    steps.push(r#""t":{"type":"agent","agent":"w"}"#.to_owned());
    format!(
        r#"{{"contract":"agsdl-0.3.0","id":"chain","agents":{{"w":{{"harness":"none","permissions":"full"}}}},"flow":{{"entry":"s","steps":{{{}}}}}}}"#,
        steps.join(",")
    )
}

fn native(request: &Json) -> Json {
    match string(request, "op") {
        "read" => {
            let bytes = unhex(string(request, "hex"));
            with_modules(
                &request["modules"],
                |modules| match reader::read_with_spans(&bytes, modules) {
                    Err(error) => failure(error),
                    Ok(read) => {
                        let spans: Vec<Json> = read
                            .spans
                            .iter()
                            .map(|span| json!([span.pointer, span.start, span.end]))
                            .collect();
                        ok(json!({"report":read.report.to_json(),"spans":spans}))
                    }
                },
            )
        }
        "validateExact" => {
            let text = string(request, "document");
            let parsed = match string(request, "mode") {
                "shared" => scan::parse_shared(text.as_bytes()),
                _ => scan::parse_v030(text.as_bytes()),
            }
            .unwrap();
            with_modules(&request["modules"], |modules| match reader::validate_exact(
                &parsed.tree,
                modules,
            ) {
                Err(error) => failure(error),
                Ok(report) => ok(json!({"report":report.to_json()})),
            })
        }
        "loadModule" => match reader::load_harness_module(&unhex(string(request, "hex"))) {
            Err(error) => failure(error),
            Ok(module) => ok(json!({"module":stringify(&module)})),
        },
        "schema" => {
            let checker = match string(request, "root") {
                "document" => schema::document_schema().unwrap(),
                "module" => schema::module_schema().unwrap(),
                "valueSchema" => schema::value_schema_shape().unwrap(),
                "hostMessage" => host_message(),
                other => panic!("unknown root {other}"),
            };
            match checker.check(&tree(string(request, "value")).unwrap()) {
                Ok(problems) => ok(json!({"problems":problems})),
                Err(error) => json!({"status":"internal","message":error.message}),
            }
        }
        "graph" => ok(graph_snapshot(&tree(string(request, "document")).unwrap())),
        "permissions" => ok(permission(request)),
        "probe" => {
            let depth = request["depth"].as_u64().unwrap() as usize;
            let document = approval_chain(depth);
            match reader::read(document.as_bytes(), Modules::Explicit(&ModuleMap::new())) {
                Err(error) => failure(error),
                Ok(report) => ok(
                    json!({"depth":depth,"report":report.to_json(),"documentSha256":digest(document.as_bytes())}),
                ),
            }
        }
        op => panic!("unknown operation {op}"),
    }
}

#[tokio::test]
async fn reader_differential() {
    let corpus = corpus::build();
    let mut oracle = Oracle::start();
    let mut statuses = BTreeMap::<String, usize>::new();
    let mut graphs_in_domain = 0usize;
    let mut manifest = Vec::new();
    for case in &corpus.cases {
        let actual = native(&case.request);
        let expected = oracle
            .request_kind(
                "reader",
                &case.request,
                &case.id,
                Duration::from_secs(60),
                "ARGENTIC_READER_NORESPONSE",
            )
            .await;
        match expected["status"].as_str() {
            Some("resourceLimit") => {
                eprintln!(
                    "ARGENTIC_READER_RESOURCE {}",
                    json!({"case":case.id,"result":expected})
                );
                panic!(
                    "resource limit inside the declared common corpus: {}",
                    case.id
                );
            }
            Some("exception") => panic!(
                "oracle exception inside the common corpus: {} {expected}",
                case.id
            ),
            _ => {}
        }
        assert_eq!(
            actual, expected,
            "reader differential {}\nrequest={}",
            case.id, case.request
        );
        *statuses
            .entry(string(&expected, "status").to_owned())
            .or_default() += 1;
        if expected["output"]["inDomain"] == true {
            graphs_in_domain += 1;
        }
        manifest.push(json!({"id":case.id,"family":case.family,
            "requestSha256":digest(&serde_json::to_vec(&case.request).unwrap()),
            "resultSha256":digest(&serde_json::to_vec(&expected).unwrap())}));
    }
    for (status, minimum) in [("ok", 1500), ("moduleError", 40), ("setupError", 1)] {
        assert!(
            statuses.get(status).copied().unwrap_or(0) >= minimum,
            "too few {status} results: {statuses:?}"
        );
    }
    assert!(
        graphs_in_domain >= 400,
        "too few graph snapshots: {graphs_in_domain}"
    );
    // Probes characterize the oracle's recursion only. They never enter the
    // common counts and impose no depth limit on the Rust reader.
    let mut probes = Vec::new();
    for depth in [64usize, 1_000, 4_000, 12_000] {
        let request = json!({"op":"probe","depth":depth});
        let actual = native(&request);
        assert_eq!(
            actual["status"], "ok",
            "the Rust reader handles depth {depth}"
        );
        let expected = oracle
            .request_kind(
                "reader",
                &request,
                "resource-probe",
                Duration::from_secs(300),
                "ARGENTIC_READER_NORESPONSE",
            )
            .await;
        let compared = match expected["status"].as_str() {
            Some("ok") => {
                assert_eq!(actual, expected, "probe depth {depth}");
                "equal"
            }
            Some("resourceLimit") => "oracleResourceLimit",
            other => panic!("unexpected probe status {other:?}: {expected}"),
        };
        probes.push(
            json!({"depth":depth,"oracle":expected["status"],"compared":compared,
            "rustReportSha256":digest(actual["output"]["report"].as_str().unwrap().as_bytes())}),
        );
    }
    oracle.close().await;
    eprintln!(
        "ARGENTIC_READER_MANIFEST {}",
        json!({"version":1,"seed":corpus::SEED,"scope":"D15 2.c.2 reader, schema checker, graphs, validator and static permissions; not a compilation or a flow replay",
        "domain":"document and module bytes of any content; exact values for validateExact (v0.3 and shared member orders); explicit module maps with Map.set semantics, loaded or raw; pinned and code-defined schema roots; shape-valid documents for graph snapshots; shape-valid permission values and arbitrary glob and command strings",
        "outsideDomain":"JS values without a Value counterpart: cycles, prototypes, non-JSON values, unpaired surrogates; maps that are not Maps; JS recursion limits (probes only)",
        "files":corpus.files,"families":corpus.counts,"minimums":corpus::MINIMUMS,"statuses":statuses,
        "graphsInDomain":graphs_in_domain,"cases":manifest,"oracleResourceProbes":probes})
    );
}

/// The official expectations of the static corpus: sorted, distinct error
/// and warning codes per case, with the two fixture modules. A distinct
/// coverage check; the strict differential above remains the comparison.
#[test]
fn official_expected_codes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("dev/agsdl/fixtures/v0.4/conformance");
    let expected: Json =
        serde_json::from_slice(&std::fs::read(root.join("expected.json")).unwrap()).unwrap();
    let mut map = ModuleMap::new();
    for name in ["example", "limited"] {
        let bytes = std::fs::read(root.join(format!("modules/{name}/module.json"))).unwrap();
        map.set(
            name.to_owned(),
            reader::load_harness_module(&bytes).unwrap(),
        );
    }
    let cases = expected.as_object().unwrap();
    assert_eq!(cases.len(), 147);
    for (name, wanted) in cases {
        let bytes = std::fs::read(root.join(format!("cases/{name}.json"))).unwrap();
        let report = reader::read(&bytes, Modules::Explicit(&map)).unwrap();
        let codes = |severity: &str| {
            let mut found: Vec<&str> = report
                .diagnostics
                .iter()
                .filter(|item| item.severity == severity)
                .map(|item| item.code)
                .collect();
            found.sort_unstable();
            found.dedup();
            found
        };
        let list = |key: &str| -> Vec<&str> {
            wanted[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|code| code.as_str().unwrap())
                .collect()
        };
        if name == "shape-wrong-contract" {
            // This fixture is rejected by the single-edition upstream validator.
            // Argentic also accepts historical documents.
            assert!(report.valid());
            continue;
        }
        assert_eq!(codes("error"), list("errors"), "{name} errors");
        assert_eq!(codes("warning"), list("warnings"), "{name} warnings");
        assert_eq!(report.valid(), list("errors").is_empty(), "{name} validity");
    }
}
