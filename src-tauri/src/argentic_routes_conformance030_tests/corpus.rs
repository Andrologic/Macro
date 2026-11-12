//! Bounded deterministic cases from the shipped TS vectors, official documents,
//! demos and discriminating mutations. No fixture or expected file is written.
use super::{hash, stringify};
use crate::argentic_core::exact::{self, Value};
use serde_json::{json, Value as Json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
pub(super) const SEED: u64 = 0x2c5a_0303;
pub(super) const MINIMUMS: &[(&str, usize)] = &[
    ("routes", 100),
    ("instruction-prompts", 78),
    ("scopes", 20),
    ("paths", 100),
    ("messages", 100),
    ("authority", 30),
    ("urls", 60),
    ("construction", 50),
    ("documents", 100),
];
pub(super) struct Case {
    pub id: String,
    pub family: &'static str,
    pub request: Json,
}
pub(super) struct Corpus {
    pub cases: Vec<Case>,
    pub files: Vec<Json>,
    pub counts: BTreeMap<&'static str, usize>,
}
impl Corpus {
    fn add(&mut self, family: &'static str, request: Json) {
        let n = self.counts.entry(family).or_default();
        let id = format!("{family}:{n}");
        *n += 1;
        self.cases.push(Case {
            id,
            family,
            request,
        });
    }
}
fn scope() -> Json {
    json!({"steps":[{"address":["worker"],"declarationJson":"{\"type\":\"agent\"}"},{"address":["review"],"declarationJson":"{\"type\":\"approval\"}"},{"address":["body"],"declarationJson":"{\"type\":\"compose\"}"},{"address":["run"],"declarationJson":"{\"type\":\"call\"}"},{"address":["gather"],"declarationJson":"{\"type\":\"join\"}"}]})
}
fn auth() -> Json {
    json!({"pathJson":"[\"instructions\"]","producerAgent":"lead","terminalId":"t"})
}
fn source(kind: &str, output: &str, authorized: bool) -> Json {
    json!({"kind":kind,"outputJson":output,"terminalId":"t","producerStep":["review","approve"],"producerAgent":if kind=="agent"{json!("lead")}else{Json::Null},"provenance":{"instructions":if authorized{vec![auth()]}else{vec![]}}})
}
fn request(op: &str, route: &str) -> Json {
    json!({"op":op,"route":route,"scopes":[scope()],"agent":"{\"instructs\":true}","source":source("agent",r#"{"results":{"xs":[9007199254740993,9007199254740993]},"instructions":["A","B"]}"#,true),"item":{"kind":"absent"}})
}
fn message(kind: &str, output: &str, route: &str) -> Json {
    let mut r = request("message", route);
    r["document"] = json!(
        r#"{"agents":{"lead":{"instructs":true,"results":{"n":{},"file":{"mediaType":"image/png"},"geo":{"mediaType":"application/geo+json"}}}},"content":{"guide":{"value":"Guide"},"remote":{"uri":"guide.txt","mediaType":"text/plain"}}}"#
    );
    r["source"] = source(kind, output, false);
    r
}
fn paths(c: &mut Corpus) {
    let raw = r#"{"xs":[9007199254740993,0.123456789012345678901],"0":null,"a/b~c":{"x":1e400},"literal":{"uri":"data","ref":"data","from":["x"]}}"#;
    let paths = [
        "[]",
        r#"["xs"]"#,
        r#"["xs",0]"#,
        r#"["xs",0e20]"#,
        r#"["xs",-0]"#,
        r#"["xs",1]"#,
        r#"["xs","0"]"#,
        r#"["xs",true]"#,
        r#"["xs",-1]"#,
        r#"["xs",0.5]"#,
        r#"["xs",9007199254740993]"#,
        r#"["xs",1e999999999999]"#,
        r#"["missing"]"#,
        r#"["0"]"#,
        r#"["literal"]"#,
        r#"["a/b~c","x"]"#,
        r#"["item"]"#,
        "{}",
        "null",
        "1",
        "[null]",
        "[[0]]",
    ];
    for value in [
        raw,
        "null",
        "[]",
        "[null,1.0]",
        "1e400",
        r#"{"item":"literal","xs":[]}"#,
    ] {
        for path in paths {
            c.add("paths", json!({"op":"path","value":value,"path":path}));
            for item in [
                json!({"kind":"absent"}),
                json!({"kind":"element","index":"3","valueJson":"null","mission":false}),
                json!({"kind":"element","index":"0","valueJson":raw,"mission":false}),
            ] {
                if path.starts_with('[') {
                    c.add(
                        "paths",
                        json!({"op":"select","value":value,"path":path,"item":item}),
                    );
                }
            }
        }
    }
}
fn routes(c: &mut Corpus) {
    let basics = [
        "[]",
        r#""worker""#,
        r#"["worker","review"]"#,
        r#"{"step":"review","message":{}}"#,
        r#"["worker",{"step":"worker","message":{}}]"#,
        r#"{"output":"done"}"#,
        r#"{"output":"done","message":{}}"#,
        r#""missing""#,
        r#"{"step":"run","message":{}}"#,
        r#"{"step":"gather","each":[]}"#,
        r#"{"step":"worker","max":1}"#,
        r#"{"step":"worker","extra":true}"#,
        "null",
        "true",
        "0",
        r#"{"step":1}"#,
    ];
    for route in basics {
        for op in ["normalize", "expand", "expect"] {
            c.add("routes", request(op, route));
        }
    }
    for limit in [
        "-0",
        "0",
        "1",
        "1.0",
        "2e0",
        "2",
        "1.1",
        "-1",
        "9007199254740993",
        "1e999999999999999999",
        "1e-999999999",
        "null",
        r#""1""#,
    ] {
        for each in [
            r#"["results","xs"]"#,
            r#"["instructions"]"#,
            r#"["missing"]"#,
            r#"["item"]"#,
            "[true]",
            "[-1]",
            "[0.5]",
            "[]",
            "{}",
        ] {
            let route =
                format!(r#"{{"step":"worker","each":{each},"max":{limit},"concurrency":1}}"#);
            for op in ["normalize", "expand", "expect"] {
                c.add("routes", request(op, &route));
            }
        }
    }
    for output in [
        r#"{"results":{"xs":[]}}"#,
        r#"{"results":{"xs":null}}"#,
        r#"{"results":{"xs":{}}}"#,
        r#"{"instructions":["A","B"]}"#,
        r#"{"instructions":[1]}"#,
    ] {
        for authorized in [true, false] {
            for route in [
                r#"{"step":"worker","each":["results","xs"],"max":1}"#,
                r#"{"step":"worker","each":["instructions"]}"#,
                r#"["review",{"step":"worker","each":["results","xs"]},{"step":"body","each":["missing"]}]"#,
            ] {
                let mut r = request("expand", route);
                r["source"] = source("agent", output, authorized);
                c.add("routes", r);
            }
        }
    }
    for route in [
        r#""worker""#,
        r#""run""#,
        r#""gather""#,
        r#"{"step":"worker","message":{}}"#,
        r#"{"step":"worker","message":{"prompt":{"from":["instructions"]}}}"#,
        r#"{"step":"worker","each":["instructions"],"message":{"prompt":{"from":["item"]}}}"#,
        r#"[{"step":"worker","each":["instructions"]},"review"]"#,
        r#"[{"step":"worker","each":["instructions"]},{"step":"review","message":{"resources":{"missions":{"from":["instructions"]}}}}]"#,
    ] {
        for agent in ["{}", r#"{"instructs":false}"#, r#"{"instructs":true}"#] {
            let mut r = request("expect", route);
            r["agent"] = json!(agent);
            c.add("routes", r);
        }
    }
}
fn instruction_prompts(c: &mut Corpus) {
    // NumberToken is a JS object. An instructing agent reaches record(prompt),
    // which rejects it; non-instructors return before that validation.
    let prompts = [
        "1",
        "1.0",
        "-0",
        "1e400",
        "null",
        "false",
        "true",
        "[]",
        "[1]",
        r#""Mission""#,
        "{}",
        r#"{"from":["instructions"]}"#,
        r#"{"from":["item"]}"#,
    ];
    for agent in ["{}", r#"{"instructs":false}"#, r#"{"instructs":true}"#] {
        for each in ["", r#","each":["instructions"]"#] {
            for prompt in prompts {
                let route = format!(r#"{{"step":"worker"{each},"message":{{"prompt":{prompt}}}}}"#);
                let mut r = request("expect", &route);
                r["agent"] = json!(agent);
                c.add("instruction-prompts", r);
            }
        }
    }
}
fn scopes(c: &mut Corpus) {
    for outer in [
        "[]",
        r#""run""#,
        r#""worker""#,
        r#"{"step":"worker","each":["instructions"]}"#,
        r#"[{"step":"worker","each":["instructions"]},"review"]"#,
    ] {
        for depth in [1, 2, 5, 20] {
            for agent in ["{}", r#"{"instructs":true}"#] {
                let mut scopes = vec![scope()];
                for index in 1..=depth {
                    scopes.push(json!({"steps":[],"outputs":["done"],"outputRoutes":[["done",{"routeJson":if index==1{outer}else{r#"{"output":"done"}"#},"scope":index-1}]]}));
                }
                let mut r = request("expect", r#"{"output":"done"}"#);
                r["scopes"] = json!(scopes);
                r["scope"] = json!(depth);
                r["agent"] = json!(agent);
                c.add("scopes", r);
            }
        }
    }
    for agent in ["{}", r#"{"instructs":true}"#] {
        for mode in 0..4 {
            let mut r = request("expect", r#"{"output":"done"}"#);
            r["agent"] = json!(agent);
            r["scopes"] = json!([{"steps":[],"outputs":["done"]}]);
            if mode == 1 {
                r["scopes"][0]["outputRoutes"] =
                    json!([["done",{"routeJson":r#"{"output":"done"}"#,"scope":0}]]);
            }
            if mode == 2 {
                r["scope"] = Json::Null;
            }
            if mode == 3 {
                r["route"] = json!(r#"{"output":"unknown"}"#);
            }
            c.add("scopes", r);
        }
    }
    let nested = json!({"prefix":["body"],"outputs":["done"],"steps":[{"address":["body","worker"],"declarationJson":"{\"type\":\"agent\"}"}]});
    for route in [
        r#""worker""#,
        r#""body/worker""#,
        r#"{"output":"done"}"#,
        r#"[{"output":"done"},{"output":"done"}]"#,
    ] {
        let mut r = request("normalize", route);
        r["scopes"] = json!([nested]);
        c.add("scopes", r);
    }
}
fn messages(c: &mut Corpus) {
    let outputs = [
        (
            "entry",
            r#"{"prompt":"Host","resources":{"a":{"value":1}}}"#,
        ),
        (
            "agent",
            r#"{"text":"Visible","results":{"n":9007199254740993,"geo":{"n":0.123456789012345678901},"file":"file:///workspace/out.png"},"instructions":"Mission"}"#,
        ),
        ("call", r#"{"data":{"prompt":"Data","n":1e400}}"#),
        (
            "join",
            r#"{"branches":{"a":{"instructions":"Data"},"b":[]}}"#,
        ),
        (
            "error",
            r#"{"error":{"code":"CALL_FAILED","message":"Do this"}}"#,
        ),
        (
            "approval",
            r#"{"comment":"Update","message":{"prompt":"Review","comments":[{"step":"first","comment":"Before"}],"item":null}}"#,
        ),
    ];
    let messages = [
        None,
        Some("{}"),
        Some(r#"{"prompt":""}"#),
        Some(r#"{"prompt":"Explicit"}"#),
        Some(r#"{"prompt":{"from":["instructions"]}}"#),
        Some(r#"{"prompt":{"from":["text"]}}"#),
        Some(r#"{"resources":{"r":{"value":{"ref":"literal","uri":"literal","from":[]}}}}"#),
        Some(r#"{"resources":{"r":{"from":["instructions"]}}}"#),
        Some(r#"{"prompt":[{"ref":"guide"}],"resources":{"r":{"ref":"remote"}}}"#),
        Some(r#"{"prompt":[{"ref":"remote"}]}"#),
        Some(r#"{"comments":[]}"#),
        Some(r#"{"prompt":null}"#),
        Some(r#"{"prompt":{"bad":true}}"#),
        Some(r#"{"resources":{"r":{"from":[],"extra":true}}}"#),
        Some(r#"{"resources":{"r":{"ref":"unknown"}}}"#),
        Some(r#"{"resources":{"r":{"uri":"relative","value":null}}}"#),
    ];
    for (kind, output) in outputs {
        for payload in messages {
            for fallback in [None, Some(r#""Fallback""#)] {
                let route = format!(
                    r#"{{"step":"worker"{}}}"#,
                    payload.map_or(String::new(), |p| format!(",\"message\":{p}"))
                );
                let mut r = message(kind, output, &route);
                if let Some(prompt) = fallback {
                    r["scopes"][0]["steps"][0]["declarationJson"] =
                        json!(format!(r#"{{"type":"agent","prompt":{prompt}}}"#));
                }
                if kind == "approval" {
                    r["source"]["provenance"]["prompt"] = json!({"kind":"author","pointer":"/old"});
                }
                c.add("messages", r);
            }
        }
    }
    for kind in ["agent", "call", "approval", "join", "error"] {
        for output in [
            "{}",
            r#"{"results":null}"#,
            r#"{"results":{"text":"bad"}}"#,
            r#"{"results":{"file":"relative"}}"#,
            r#"{"comment":"","message":{}}"#,
            r#"{"comment":"Comment","message":{"prompt":"Old"}}"#,
        ] {
            c.add("messages", message(kind, output, r#""worker""#));
        }
    }
    for payload in [
        r#"{"prompt":[{"ref":"remote"}]}"#,
        r#"{"prompt":[{"uri":"guide.txt","mediaType":"text/plain"}],"resources":{"direct":{"uri":"direct.png","mediaType":"image/png"},"ref":{"ref":"remote"}}}"#,
    ] {
        for captured in [
            None,
            Some(r#"{"value":"Captured","mediaType":"text/plain"}"#),
            Some(r#"{"uri":"still.txt"}"#),
            Some(r#"{"ref":"bad"}"#),
            Some("null"),
            Some("{"),
            Some(r#"{"value":1,"uri":"both"}"#),
        ] {
            for defer in [true, false] {
                let mut r = message(
                    "call",
                    r#"{"data":null}"#,
                    &format!(r#"{{"step":"worker","message":{payload}}}"#),
                );
                r["content"] = json!({"deferPromptUris":defer});
                if let Some(value) = captured {
                    r["content"]["entries"] = json!([{"sourceJson":r#"{"uri":"guide.txt","mediaType":"text/plain"}"#,"capturedJson":value}]);
                }
                c.add("messages", r);
            }
        }
    }
    // The compiler's exact entry-helper invocation: no invented capture or provenance.
    for kind in ["agent", "approval", "compose", "call", "join"] {
        for prompt in [
            None,
            Some(r#""Default""#),
            Some(r#"[{"uri":"relative.txt"}]"#),
        ] {
            for output in [
                "{}",
                r#"{"prompt":"Host"}"#,
                r#"{"prompt":null}"#,
                r#"{"resources":{"a":{"value":9007199254740993}}}"#,
            ] {
                let declaration = format!(
                    r#"{{"type":"{kind}"{}}}"#,
                    prompt.map_or(String::new(), |p| format!(",\"prompt\":{p}"))
                );
                let mut r = message("entry", output, r#""worker""#);
                r["source"] = json!({"kind":"entry","terminalId":"","producerStep":null,"outputJson":output,"provenance":{"instructions":[]}});
                r["scopes"][0]["steps"][0]["declarationJson"] = json!(declaration);
                c.add("messages", r);
            }
        }
    }
}
fn authority(c: &mut Corpus) {
    for kind in ["agent", "join", "call", "entry"] {
        for path in [
            r#"["instructions"]"#,
            r#"["branches","a","instructions"]"#,
            r#"["results","instructions"]"#,
            r#"[]"#,
        ] {
            for good in [true, false] {
                let mut s = source(
                    kind,
                    r#"{"instructions":"Mission","branches":{"a":{"instructions":"Joined"}}}"#,
                    good,
                );
                if kind == "join" && good {
                    s["provenance"]["instructions"] = json!([{"pathJson":r#"["branches","a","instructions"]"#,"producerAgent":"lead","terminalId":"branch-t"}]);
                }
                c.add(
                    "authority",
                    json!({"op":"authority","source":s,"path":path}),
                );
            }
        }
    }
    for index in [
        "1",
        "0",
        "01",
        "-1",
        "2",
        "999999999999999999999999999999999999",
    ] {
        for value in [r#""B""#, r#""Forged""#, "null"] {
            for authorized in [true, false] {
                let mut r = message(
                    "agent",
                    r#"{"instructions":["A","B"],"results":{}}"#,
                    r#"{"step":"worker","each":["instructions"],"message":{"prompt":{"from":["item"]}}}"#,
                );
                r["source"] = source("agent", r#"{"instructions":["A","B"],"results":{}}"#, true);
                r["item"] =
                    json!({"kind":"element","index":index,"valueJson":value,"mission":true});
                if authorized {
                    r["item"]["instructionAuthority"] = auth();
                }
                c.add("authority", r);
            }
        }
    }
}
fn urls(c: &mut Corpus) {
    let values = [
        "file:///workspace/out.png",
        "relative.png",
        "/absolute/path",
        "//host/path",
        "http://example.com",
        "http:example.com",
        "https://éxample.com/é",
        "https://[::1]:65535/x",
        "http://a:65536",
        "http://a:-1",
        "http://a:abc",
        "http://a:80",
        "http://",
        "http://%zz",
        "http://%41.com",
        "https://a/%zz",
        "https://a/%00",
        "ftp://a",
        "mailto:a@b",
        "data:image/png;base64,AA==",
        "urn:uuid:test",
        "x:opaque",
        "x:",
        "1x:bad",
        ":bad",
        "FILE:///tmp/a",
        "file://localhost/tmp/a",
        "file://host:80/tmp/a",
        " http://a ",
        "\nhttp://a\t",
        "http://a\nb",
        "http://a b",
        "http://a\u{0}b",
        "http://a\u{1f}b",
        "x:a b",
        "x:é",
        "http://\\\\a\\p",
        "https://[::ffff:192.0.2.1]",
        "https://[invalid]",
        "https://a..b",
        "https://a.",
        "https://a:00080",
        "https://a:0",
        "file:c:/path",
        "file:/tmp/a",
        "https://0x7f.1",
        "https://0177.0.0.1",
        "https://256.1.1.1",
        "https://a%2fb",
        "https://a%23b",
        "https://a%00b",
        "https://a\u{2028}b",
        "https://a\u{a0}b",
        "x:a\n",
        "x:a\r",
        "\u{7f}x:a",
        "",
    ];
    for value in values {
        for media in ["image/png", "application/geo+json", "text/plain"] {
            c.add("urls",json!({"op":"select","value":stringify(&value),"path":"[]","item":{"kind":"absent"},"metadata":[{"pathJson":"[]","mediaType":media}]}));
        }
    }
    for media in [
        "application/json",
        "application/x+json",
        "application/x+json\n",
        "application/x+json\r\n",
        "application/x+json\u{2028}",
        "application/+json",
        "/x+json",
        "x/y/z+json",
        "text/",
        "TEXT/plain",
        "x/+json",
    ] {
        c.add("urls",json!({"op":"select","value":"\"relative\"","path":"[]","item":{"kind":"absent"},"metadata":[{"pathJson":"[]","mediaType":media}]}));
    }
}
fn capture_extensions(c: &mut Corpus) {
    for (path, media) in [
        (r#"["results","n"]"#, "text/plain"),
        (r#"["results","geo"]"#, "image/png"),
        (r#"["results","file"]"#, "application/json"),
        (r#"["results","n"]"#, "application/geo+json"),
    ] {
        let mut r = message(
            "agent",
            r#"{"results":{"n":"Info","geo":"file:///x","file":"literal"},"instructions":"Mission"}"#,
            r#""worker""#,
        );
        r["source"]["provenance"]["results"] = json!([{"pathJson":path,"mediaType":media,"extra":{"2":2,"1":1,"text":"é"}},{"pathJson":path,"mediaType":"text/second","tag":"second ignored"}]);
        r["source"]["provenance"]["instructions"] = json!([{"pathJson":r#"["instructions"]"#,"producerAgent":"lead","terminalId":"t","extra":{"note":"captured"}}]);
        c.add("messages", r);
    }
    for prompt in [
        json!({"kind":"author","pointer":"/before","extra":["captured"]}),
        json!({"kind":"none","extra":true}),
        json!({"kind":"agent","authority":{"pathJson":"[]","producerAgent":"lead","terminalId":"old"},"extra":"preserved"}),
    ] {
        let mut r = message(
            "approval",
            r#"{"comment":"Update","message":{"prompt":"Old"}}"#,
            r#""worker""#,
        );
        r["source"]["provenance"]["prompt"] = prompt;
        c.add("messages", r);
    }
    for document in [
        r#"{"agents":null,"content":null}"#,
        r#"{"agents":{"lead":{"results":null}}}"#,
    ] {
        let mut r = message("agent", r#"{"results":{},"text":"Empty"}"#, r#""worker""#);
        r["document"] = json!(document);
        c.add("messages", r);
    }
    let mut r = message(
        "approval",
        r#"{"comment":"Update","message":{}}"#,
        r#""worker""#,
    );
    r["source"]["producerStep"] = Json::Null;
    c.add("messages", r);
    let mut r = message("entry", r#"{"prompt":"Host"}"#, r#""worker""#);
    r["target"] = json!({"kind":"output","name":"done"});
    c.add("messages", r);
}
fn construction(c: &mut Corpus) {
    for n in 0..64 {
        let entries = json!([
            ["b", format!("{n}.0")],
            ["10", "1e400"],
            ["2", "-0"],
            ["__proto__", "null"],
            ["b", format!("9007199254740993{n}")],
            ["4294967295", "true"],
            ["01", "false"]
        ]);
        c.add("construction",json!({"op":"construct","entries":entries,"updates":[["2","2.0"],["a","{\"10\":1,\"2\":2}"],["0","null"]]}));
    }
}
fn files(path: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            paths.extend(files(&path));
        } else if path.extension().is_some_and(|e| e == "json") {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}
fn documents(c: &mut Corpus) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for directory in [
        "dev/agsdl/fixtures/v0.3/conformance/cases",
        "dev/agsdl/fixtures/v0.3/conformance/runs",
        "dev/agsdl/fixtures/v0.3/examples",
        "src/demo/agsdl",
    ] {
        for path in files(&root.join(directory)) {
            let bytes = std::fs::read(&path).unwrap();
            c.files.push(json!({"path":path.strip_prefix(root).unwrap().to_str().unwrap(),"sha256":hash(&bytes)}));
            let Ok(parsed) = exact::scan::parse_v030(&bytes) else {
                continue;
            };
            let Some(doc) = parsed.tree.as_object() else {
                continue;
            };
            let document = if let Some(d) = doc.get("document") {
                d
            } else {
                &parsed.tree
            };
            let Some(doc) = document.as_object() else {
                continue;
            };
            let mut containers = Vec::new();
            if let Some(flow) = doc.get("flow").and_then(Value::as_object) {
                containers.push(flow);
            }
            if let Some(compositions) = doc.get("compositions").and_then(Value::as_object) {
                for (_, value) in compositions.iter() {
                    if let Some(value) = value.as_object() {
                        containers.push(value);
                    }
                }
            }
            for container in containers {
                let Some(steps) = container.get("steps").and_then(Value::as_object) else {
                    continue;
                };
                let step_specs:Vec<Json>=steps.iter().filter(|(_,decl)|decl.as_object().and_then(|o|o.get("type")).and_then(Value::as_str).is_some()).map(|(name,decl)|json!({"address":[name],"declarationJson":exact::encode(decl)})).collect();
                let mut local = json!({"steps":step_specs});
                if let Some(outputs) = container.get("outputs") {
                    if let Ok(outputs) = serde_json::from_str::<Json>(&exact::encode(outputs)) {
                        local["outputs"] = outputs;
                    }
                }
                for (name, decl) in steps.iter() {
                    let Some(decl) = decl.as_object() else {
                        continue;
                    };
                    if !decl.get("type").is_some_and(|v| v.as_str().is_some()) {
                        continue;
                    }
                    let mut routes = Vec::new();
                    for field in ["next", "onError"] {
                        if let Some(route) = decl.get(field) {
                            if let Some(map) = route.as_object().filter(|map| {
                                !map.contains_key("step") && !map.contains_key("output")
                            }) {
                                for (_, value) in map.iter() {
                                    routes.push(exact::encode(value));
                                }
                            } else {
                                routes.push(exact::encode(route));
                            }
                        }
                    }
                    if routes.is_empty() {
                        routes.push("[]".to_owned());
                    }
                    for route in routes {
                        for op in ["normalize", "expand", "expect"] {
                            let mut r = request(op, &route);
                            r["scopes"] = json!([local]);
                            r["document"] = json!(exact::encode(document));
                            c.add("documents", r);
                        }
                    }
                    if ["agent", "approval", "compose"]
                        .contains(&decl.get("type").and_then(Value::as_str).unwrap())
                    {
                        let mut r = message("entry", r#"{"prompt":"Fixture"}"#, &stringify(&name));
                        r["scopes"] = json!([local]);
                        r["document"] = json!(exact::encode(document));
                        c.add("documents", r);
                    }
                }
            }
        }
    }
}
pub(super) fn build() -> Corpus {
    let mut c = Corpus {
        cases: vec![],
        files: vec![],
        counts: BTreeMap::new(),
    };
    routes(&mut c);
    instruction_prompts(&mut c);
    scopes(&mut c);
    paths(&mut c);
    messages(&mut c);
    authority(&mut c);
    urls(&mut c);
    construction(&mut c);
    capture_extensions(&mut c);
    documents(&mut c);
    for &(family, min) in MINIMUMS {
        assert!(
            c.counts.get(family).copied().unwrap_or(0) >= min,
            "missing {family}: {:?}",
            c.counts
        );
    }
    c
}
