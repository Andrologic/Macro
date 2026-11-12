//! Reader differential corpus: official cases, examples, run documents, demo
//! documents, pinned and fixture modules, schema roots, TS test vectors,
//! deterministic mutations and generated documents. Official files are read,
//! never written.
use super::{digest, hex};
use crate::argentic_core::exact::{quote, scan, stringify, Value};
use serde_json::{json, Value as Json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(super) const SEED: u64 = 0x2c2_0d0c_5eed_0303;

pub(super) const MINIMUMS: &[(&str, usize)] = &[
    ("cases", 432),
    ("examples", 30),
    ("runs", 111),
    ("demo", 30),
    ("exact", 400),
    ("modules", 6),
    ("module-mutations", 60),
    ("registry", 12),
    ("schema-files", 200),
    ("schema-generated", 90),
    ("graph-files", 200),
    ("graph-generated", 400),
    ("mutations", 500),
    ("generated", 800),
    ("ts-vectors", 12),
    ("permissions", 600),
];

pub(super) struct Case {
    pub(super) id: String,
    pub(super) family: &'static str,
    pub(super) request: Json,
}

pub(super) struct Corpus {
    pub(super) cases: Vec<Case>,
    pub(super) files: Vec<Json>,
    pub(super) counts: BTreeMap<&'static str, usize>,
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned()
}

fn json_files(directory: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.to_str().unwrap().ends_with(suffix))
        .collect();
    files.sort();
    files
}

fn module_sets(official: &Json) -> [(&'static str, Json); 3] {
    [
        ("official", official.clone()),
        ("pinned", json!({"kind":"pinned"})),
        ("empty", json!({"kind":"map","entries":[]})),
    ]
}

impl Corpus {
    fn push(&mut self, family: &'static str, id: String, request: Json) {
        *self.counts.entry(family).or_default() += 1;
        self.cases.push(Case {
            id,
            family,
            request,
        });
    }

    fn read(&mut self, family: &'static str, id: &str, bytes: &[u8], sets: &[(&str, Json)]) {
        for (name, modules) in sets {
            self.push(
                family,
                format!("{id}@{name}"),
                json!({"op":"read","hex":hex(bytes),"modules":modules}),
            );
        }
    }

    fn exact(&mut self, id: &str, text: &str, official: &Json) {
        for mode in ["v030", "shared"] {
            for (name, modules) in [
                ("official", official.clone()),
                ("pinned", json!({"kind":"pinned"})),
            ] {
                self.push(
                    "exact",
                    format!("{id}#{mode}@{name}"),
                    json!({"op":"validateExact","document":text,"mode":mode,"modules":modules}),
                );
            }
        }
    }

    fn schema(&mut self, family: &'static str, id: &str, root: &str, value: &str) {
        self.push(
            family,
            format!("{id}~{root}"),
            json!({"op":"schema","root":root,"value":value}),
        );
    }

    fn graph(&mut self, family: &'static str, id: &str, text: &str) {
        self.push(
            family,
            format!("{id}~graph"),
            json!({"op":"graph","document":text}),
        );
    }

    fn permission(&mut self, id: String, fields: Json) {
        let mut request = json!({"op":"permissions","fn":"","permissions":null,"action":"","subject":"","pattern":"","paths":false,"command":false,"rule":"{}"});
        for (key, value) in fields.as_object().unwrap() {
            request[key] = value.clone();
        }
        self.push("permissions", id, request);
    }
}

/// `Object.assign(module, extra)` on exact text: replaced members keep their
/// place, new ones are appended.
fn assign(text: &str, members: &[(&str, &str)]) -> String {
    let tree = scan::parse_v030(text.as_bytes()).unwrap().tree;
    let object = tree.as_object().unwrap();
    let mut out: Vec<String> = object
        .iter()
        .map(|(key, value)| {
            let replaced = members.iter().find(|(name, _)| *name == key);
            format!(
                "{}:{}",
                quote(key),
                replaced.map_or_else(|| stringify(value), |(_, text)| (*text).to_owned())
            )
        })
        .collect();
    for (key, value) in members {
        if !object.contains_key(key) {
            out.push(format!("{}:{value}", quote(key)));
        }
    }
    format!("{{{}}}", out.join(","))
}

/// `delete module[key]` on exact text.
fn without(text: &str, key: &str) -> String {
    let tree = scan::parse_v030(text.as_bytes()).unwrap().tree;
    let members: Vec<String> = tree
        .as_object()
        .unwrap()
        .iter()
        .filter(|(name, _)| *name != key)
        .map(|(name, value)| format!("{}:{}", quote(name), stringify(value)))
        .collect();
    format!("{{{}}}", members.join(","))
}

enum Edit {
    Delete,
    Replace(String),
    Duplicate,
    Reverse,
    RenameKey(String),
}

fn size(value: &Value) -> usize {
    let mut count = 0;
    let mut pending = vec![value];
    while let Some(node) = pending.pop() {
        count += 1;
        match node {
            Value::Array(items) => pending.extend(items),
            Value::Object(object) => pending.extend(object.iter().map(|(_, item)| item)),
            _ => {}
        }
    }
    count
}

/// Exact text of `value` with one edit at pre-order node `target`.
fn emit(value: &Value, counter: &mut usize, target: usize, edit: &Edit, out: &mut String) {
    let me = *counter;
    *counter += 1;
    if me == target {
        if let Edit::Replace(text) = edit {
            out.push_str(text);
            *counter += size(value) - 1;
            return;
        }
    }
    match value {
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                let id = *counter;
                let mut text = String::new();
                emit(item, counter, target, edit, &mut text);
                if id == target {
                    match edit {
                        Edit::Delete => continue,
                        Edit::Duplicate => parts.push(text.clone()),
                        _ => {}
                    }
                }
                parts.push(text);
            }
            if me == target && matches!(edit, Edit::Reverse) {
                parts.reverse();
            }
            out.push_str(&format!("[{}]", parts.join(",")));
        }
        Value::Object(object) => {
            let mut parts = Vec::new();
            for (key, item) in object.iter() {
                let id = *counter;
                let mut text = String::new();
                emit(item, counter, target, edit, &mut text);
                let mut name = key.to_owned();
                if id == target {
                    match edit {
                        Edit::Delete => continue,
                        Edit::Duplicate => parts.push(format!("{}:{text}", quote(&name))),
                        Edit::RenameKey(suffix) => name.push_str(suffix),
                        _ => {}
                    }
                }
                parts.push(format!("{}:{text}", quote(&name)));
            }
            if me == target && matches!(edit, Edit::Reverse) {
                parts.reverse();
            }
            out.push_str(&format!("{{{}}}", parts.join(",")));
        }
        other => out.push_str(&stringify(other)),
    }
}

fn kind_at(value: &Value, target: usize) -> &'static str {
    let mut pending = vec![value];
    let mut index = 0;
    while let Some(node) = pending.pop() {
        if index == target {
            return match node {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::String(_) => "string",
                Value::Array(_) => "array",
                Value::Object(_) => "object",
            };
        }
        index += 1;
        match node {
            Value::Array(items) => pending.extend(items.iter().rev()),
            Value::Object(object) => pending.extend(object.iter().rev().map(|(_, item)| item)),
            _ => {}
        }
    }
    "none"
}

const NUMBERS: &[&str] = &[
    "0",
    "1",
    "2",
    "3",
    "1.0",
    "1e0",
    "10e-1",
    "-0",
    "1e400",
    "-1",
    "0.5",
    "12345678901234567890",
    "2E+0",
];
const STRINGS: &[&str] = &[
    "x\n", "😀", "", "a b", "Write", "write", "\u{2028}", "#exit", "ghost", "done", "example",
    "lines", "keep", "finish", "new", "steer",
];

fn mutate(rng: &mut Rng, tree: &Value) -> Option<String> {
    let total = size(tree);
    if total < 2 {
        return None;
    }
    let target = 1 + rng.below(total - 1);
    let edit = match kind_at(tree, target) {
        "number" => Edit::Replace(rng.pick(NUMBERS).to_string()),
        "string" => match rng.below(3) {
            0 => Edit::Replace(quote(rng.pick(STRINGS))),
            1 => Edit::RenameKey(rng.pick(&["\n", "😀", "_x", ""]).to_string()),
            _ => Edit::Delete,
        },
        "array" | "object" => match rng.below(4) {
            0 => Edit::Reverse,
            1 => Edit::Duplicate,
            2 => Edit::RenameKey(rng.pick(&["x", "1", "\u{1F600}"]).to_string()),
            _ => Edit::Delete,
        },
        _ => match rng.below(2) {
            0 => Edit::Replace(
                rng.pick(&["null", "true", "false", "[]", "{}", "\"s\""])
                    .to_string(),
            ),
            _ => Edit::Delete,
        },
    };
    let mut out = String::new();
    emit(tree, &mut 0, target, &edit, &mut out);
    Some(out)
}

/// A deterministic document mixing every step kind, route form and selector.
fn generate(rng: &mut Rng) -> String {
    let q = |text: &str| quote(text);
    let names = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    let count = 3 + rng.below(6);
    let steps = &names[..count];
    let agents = ["w", "r", "v"];
    let target = |rng: &mut Rng| -> String {
        if rng.chance(5) {
            "nowhere".to_owned()
        } else {
            rng.pick(steps).to_string()
        }
    };
    let paths = [
        r#"["results","plan","items"]"#,
        r#"["instructions"]"#,
        r#"["text"]"#,
        r#"["data","value"]"#,
        r#"["data","value",1]"#,
        r#"["branches","s1","results","plan"]"#,
        r#"["branches","s2",0,"item"]"#,
        r#"["message","resources","r"]"#,
        r#"["item"]"#,
        r#"["choice"]"#,
        r#"["error","details",0]"#,
        r#"["results","plan","n",2]"#,
        r#"["outcome"]"#,
        r#"["results",3]"#,
    ];
    let route_item = |rng: &mut Rng| -> String {
        let step = target(rng);
        match rng.below(6) {
            0 | 1 => q(&step),
            2 => format!(
                r#"{{"step":{},"each":{}{}}}"#,
                q(&step),
                rng.pick(&paths),
                if rng.chance(50) {
                    format!(r#","max":{}"#, rng.pick(&NUMBERS[1..4]))
                } else {
                    String::new()
                }
            ),
            3 => format!(
                r#"{{"step":{},"message":{{"prompt":{{"from":{}}}}}}}"#,
                q(&step),
                rng.pick(&paths)
            ),
            4 => format!(
                r#"{{"step":{},"message":{{"resources":{{"r":{{"from":{}}}}}}}}}"#,
                q(&step),
                rng.pick(&paths)
            ),
            _ => format!(r#"{{"step":{},"concurrency":2}}"#, q(&step)),
        }
    };
    let route = |rng: &mut Rng| -> String {
        if rng.chance(40) {
            let items: Vec<String> = (0..1 + rng.below(3)).map(|_| route_item(rng)).collect();
            format!("[{}]", items.join(","))
        } else {
            route_item(rng)
        }
    };
    let mut step_texts = Vec::new();
    for (index, name) in steps.iter().enumerate() {
        let kind = if index == 0 { 0 } else { rng.below(6) };
        let next = |rng: &mut Rng, keys: &[&str]| -> String {
            let members: Vec<String> = keys
                .iter()
                .map(|key| format!("{}:{}", q(key), route(rng)))
                .collect();
            format!("{{{}}}", members.join(","))
        };
        let mut members = Vec::new();
        match kind {
            0 | 1 => {
                members.push(r#""type":"agent""#.to_owned());
                let agent = if rng.chance(8) {
                    "ghost".to_owned()
                } else {
                    rng.pick(&agents).to_string()
                };
                members.push(format!(r#""agent":{}"#, q(&agent)));
                if rng.chance(20) {
                    members.push(format!(r#""instance":{}"#, q(rng.pick(&["new", "second"]))));
                }
                if rng.chance(15) {
                    members.push(format!(
                        r#""delivery":{}"#,
                        q(rng.pick(&["queue", "steer"]))
                    ));
                }
                if rng.chance(25) {
                    members.push(r#""prompt":"go""#.to_owned());
                }
                if rng.chance(20) {
                    members.push(format!(
                        r#""maxVisits":{}"#,
                        rng.pick(&["1", "2", "5", "1e1", "10"])
                    ));
                }
                if index + 1 < count || rng.chance(50) {
                    let next_text = if rng.chance(35) {
                        next(rng, &["done", "retry"])
                    } else {
                        route(rng)
                    };
                    members.push(format!(r#""next":{next_text}"#));
                }
            }
            2 => {
                members.push(r#""type":"approval""#.to_owned());
                members.push(format!(r#""next":{}"#, next(rng, &["ok", "no"])));
            }
            3 => {
                members.push(r#""type":"call""#.to_owned());
                if rng.chance(50) {
                    members.push(r#""command":"make test""#.to_owned());
                    if rng.chance(50) {
                        members.push(format!(r#""parse":{}"#, q(rng.pick(&["lines", "json"]))));
                    }
                } else {
                    members.push(r#""mcp":{"server":"m","tool":"t"}"#.to_owned());
                    members.push(format!(
                        r#""arguments":{{"1":{{"path":{}}},"x":{{"value":1.50}}}}"#,
                        rng.pick(&paths)
                    ));
                }
                let next_text = if rng.chance(40) {
                    next(rng, &["passed", "failed"])
                } else {
                    route(rng)
                };
                members.push(format!(r#""next":{next_text}"#));
            }
            4 => {
                members.push(r#""type":"join""#.to_owned());
                if rng.chance(35) {
                    members.push(format!(
                        r#""quorum":{{"count":{},"accept":["done"]}}"#,
                        rng.pick(&["1", "2", "3", "1.0", "2e0", "1e400", "4"])
                    ));
                    members.push(format!(r#""next":{}"#, next(rng, &["reached", "missed"])));
                } else {
                    if rng.chance(40) {
                        members.push(r#""failures":"keep""#.to_owned());
                    }
                    if rng.chance(20) {
                        members.push(r#""maxFailures":1"#.to_owned());
                    }
                    if rng.chance(40) {
                        members.push(format!(
                            r#""remaining":{}"#,
                            q(rng.pick(&["finish", "stop", "wait"]))
                        ));
                    }
                    if rng.chance(70) {
                        members.push(format!(r#""next":{}"#, route(rng)));
                    }
                }
            }
            _ => {
                members.push(r#""type":"compose""#.to_owned());
                members.push(format!(
                    r#""composition":{}"#,
                    q(rng.pick(&["c0", "c1", "cx"]))
                ));
                if rng.chance(70) {
                    members.push(format!(r#""agents":{{"p":{}}}"#, q(rng.pick(&agents))));
                }
                members.push(format!(r#""next":{}"#, next(rng, &["done"])));
            }
        }
        step_texts.push(format!("{}:{{{}}}", q(name), members.join(",")));
    }
    let permissions = [
        r#""full""#,
        r#""workspace""#,
        r#""read-only""#,
        r#"{"preset":"full","rules":[{"action":"shell","match":"git push *","effect":"deny"},{"action":"shell","match":"git*","effect":"ask"}]}"#,
        r#"{"rules":[{"action":"network","effect":"allow"}]}"#,
        r#"{"preset":"read-only","directories":{"2":"write","src":"read"},"reviewer":"person"}"#,
        r#"{"preset":"workspace","outside":"read","rules":[{"action":"write","match":"/**","effect":"deny"}]}"#,
    ];
    let mut agent_texts = Vec::new();
    for name in agents {
        let mut members = vec![
            format!(
                r#""harness":{}"#,
                q(rng.pick(&["example", "limited", "codex", "claude-code", "unknown"]))
            ),
            format!(r#""permissions":{}"#, rng.pick(&permissions)),
        ];
        if rng.chance(40) {
            members.push(r#""instructs":true"#.to_owned());
        }
        if rng.chance(30) {
            members.push(format!(
                r#""model":{{"effort":{}}}"#,
                q(rng.pick(&["low", "high", "extreme"]))
            ));
        }
        if rng.chance(50) {
            members.push(r#""results":{"plan":{"schema":{"type":"object","properties":{"items":{"type":"array","items":{"type":"string"},"maxItems":3},"n":{"type":"integer"}},"additionalProperties":false}},"notes":{"mediaType":"text/plain"}}"#.to_owned());
        }
        if rng.chance(20) {
            members.push(format!(
                r#""completionCheck":{{"command":{},"choices":["done"]}}"#,
                q(rng.pick(&["make test", "git push origin", "rm -rf /"]))
            ));
        }
        if rng.chance(15) {
            members.push(r#""harnessSettings":{"profile":"x","2":1}"#.to_owned());
        }
        if rng.chance(15) {
            members.push(
                r#""mcpServers":["m"],"skills":["k"],"plan":true,"planFirst":"ask""#.to_owned(),
            );
        }
        agent_texts.push(format!("{}:{{{}}}", q(name), members.join(",")));
    }
    let compositions = r#""compositions":{"c0":{"parameters":["p"],"outputs":["done"],"entry":"x","steps":{"x":{"type":"agent","agent":{"parameter":"p"},"next":["y","z"]},"y":{"type":"agent","agent":{"parameter":"p"},"next":"j"},"z":{"type":"agent","agent":{"parameter":"p"},"next":"j"},"j":{"type":"join","next":{"output":"done"}}}},"c1":{"outputs":["done"],"entry":"u","steps":{"u":{"type":"compose","composition":"c0","agents":{"p":"w"},"next":{"done":{"output":"done"}}}}}}"#;
    let mut sections = vec![
        r#""contract":"agsdl-0.3.0""#.to_owned(),
        r#""id":"generated""#.to_owned(),
        r#""content":{"brief":{"value":"hi"}}"#.to_owned(),
        r#""mcpServers":{"m":{"command":["srv"]}}"#.to_owned(),
        format!(r#""agents":{{{}}}"#, agent_texts.join(",")),
    ];
    let mut flow = format!(
        r#""flow":{{"entry":"s0","steps":{{{}}}"#,
        step_texts.join(",")
    );
    if rng.chance(30) {
        flow.push_str(&format!(r#","onError":{}"#, route(rng)));
    }
    flow.push('}');
    sections.push(flow);
    if rng.chance(70) {
        sections.push(compositions.to_owned());
    }
    format!("{{{}}}", sections.join(","))
}

fn modules_from(entries: &[(&str, String, bool)]) -> Json {
    let entries: Vec<Json> = entries
        .iter()
        .map(|(name, json, load)| json!({"name":name,"json":json,"load":load}))
        .collect();
    json!({"kind":"map","entries":entries})
}

pub(super) fn build() -> Corpus {
    let mut c = Corpus {
        cases: Vec::new(),
        files: Vec::new(),
        counts: BTreeMap::new(),
    };
    let root = root();
    let fixtures = root.join("dev/agsdl/fixtures/v0.3");
    let record = |c: &mut Corpus, path: &Path, category: &str| -> Vec<u8> {
        let bytes = std::fs::read(path).unwrap();
        let relative = path
            .strip_prefix(&root)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        c.files.push(json!({"path":relative,"category":category,"bytes":bytes.len(),"sha256":digest(&bytes)}));
        bytes
    };
    let mut modules_text = Vec::new();
    for name in ["example", "limited"] {
        let bytes = record(
            &mut c,
            &fixtures.join(format!("conformance/modules/{name}/module.json")),
            "fixtureModules",
        );
        modules_text.push((name, String::from_utf8(bytes).unwrap()));
    }
    let official = modules_from(
        &modules_text
            .iter()
            .map(|(name, text)| (*name, text.clone(), true))
            .collect::<Vec<_>>(),
    );
    let sets = module_sets(&official);
    let mut documents: Vec<(String, String)> = Vec::new();

    let cases = json_files(&fixtures.join("conformance/cases"), ".json");
    assert_eq!(cases.len(), 144, "official static corpus changed");
    for path in &cases {
        let bytes = record(&mut c, path, "staticCases");
        let id = format!("case:{}", path.file_stem().unwrap().to_str().unwrap());
        c.read("cases", &id, &bytes, &sets);
        if let Ok(text) = String::from_utf8(bytes) {
            if scan::parse_v030(text.as_bytes()).is_ok() {
                documents.push((id, text));
            }
        }
    }
    let examples = json_files(&fixtures.join("examples"), ".json");
    assert_eq!(examples.len(), 10, "official examples changed");
    for path in &examples {
        let bytes = record(&mut c, path, "examples");
        let id = format!("example:{}", path.file_stem().unwrap().to_str().unwrap());
        c.read("examples", &id, &bytes, &sets);
        documents.push((id, String::from_utf8(bytes).unwrap()));
    }
    let runs = json_files(&fixtures.join("conformance/runs"), ".json");
    assert_eq!(runs.len(), 37, "official run corpus changed");
    for path in &runs {
        let bytes = record(&mut c, path, "scenarios");
        let scenario = scan::parse_v030(&bytes).unwrap().tree;
        let document = stringify(scenario.as_object().unwrap().get("document").unwrap());
        let id = format!("run:{}", path.file_stem().unwrap().to_str().unwrap());
        c.read("runs", &id, document.as_bytes(), &sets);
        documents.push((id, document));
    }
    for path in json_files(&root.join("src/demo/agsdl"), ".agsdl.json") {
        let bytes = record(&mut c, &path, "demo");
        let id = format!("demo:{}", path.file_name().unwrap().to_str().unwrap());
        c.read("demo", &id, &bytes, &sets[..2]);
        if let Ok(text) = String::from_utf8(bytes) {
            if scan::parse_v030(text.as_bytes()).is_ok() {
                documents.push((id, text));
            }
        }
    }
    let pinned: Vec<(String, String)> =
        json_files(&root.join("src/vendor/agsdl/v0.3/harnesses"), "")
            .into_iter()
            .map(|directory| {
                let path = directory.join("module.json");
                let bytes = record(&mut c, &path, "pinnedModules");
                (
                    directory.file_name().unwrap().to_str().unwrap().to_owned(),
                    String::from_utf8(bytes).unwrap(),
                )
            })
            .collect();
    for schema in ["agsdl.schema.json", "harness-module.schema.json"] {
        record(
            &mut c,
            &root.join("src/vendor/agsdl/v0.3/schema").join(schema),
            "schemas",
        );
    }

    // Documents: exact validation, schema root and graph snapshot.
    for (id, text) in &documents {
        c.exact(id, text, &official);
        c.schema("schema-files", id, "document", text);
        c.graph("graph-files", id, text);
    }

    // Modules, their schema roots and their settings.
    let all_modules: Vec<(String, String)> = pinned
        .iter()
        .cloned()
        .chain(
            modules_text
                .iter()
                .map(|(name, text)| (name.to_string(), text.clone())),
        )
        .collect();
    for (name, text) in &all_modules {
        c.push(
            "modules",
            format!("module:{name}"),
            json!({"op":"loadModule","hex":hex(text.as_bytes())}),
        );
        c.schema("schema-files", &format!("module:{name}"), "module", text);
        let tree = scan::parse_v030(text.as_bytes()).unwrap().tree;
        if let Some(settings) = tree.as_object().unwrap().get("settings") {
            c.schema(
                "schema-files",
                &format!("module:{name}:settings"),
                "valueSchema",
                &stringify(settings),
            );
        }
        let keys: Vec<String> = tree
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, _)| key.to_owned())
            .collect();
        for key in &keys {
            let mutated = without(text, key);
            c.push(
                "module-mutations",
                format!("module:{name}-{key}"),
                json!({"op":"loadModule","hex":hex(mutated.as_bytes())}),
            );
        }
        for (label, members) in [
            ("bad-name", vec![("name", r#""bad name\n""#)]),
            ("bad-version", vec![("version", r#""1.0.0\n""#)]),
            ("leading-zero", vec![("version", r#""01.0.0""#)]),
            ("unknown", vec![("2", "false"), ("1", "true")]),
            ("settings-shape", vec![("settings", r#"{"type":"text"}"#)]),
            (
                "settings-inconsistent",
                vec![(
                    "settings",
                    r#"{"type":"object","properties":{"2":{"type":"string","items":{"type":"string"}},"1":{"type":"string","items":{"type":"string"}}}}"#,
                )],
            ),
            (
                "settings-bounds",
                vec![(
                    "settings",
                    r#"{"type":"array","minItems":12345678901234567890,"maxItems":1e1}"#,
                )],
            ),
            (
                "settings-nested",
                vec![(
                    "settings",
                    r#"{"type":"object","properties":{"2":{"type":"array","maxItems":1e400,"items":{"type":"integer","enum":[1.0,12345678901234567890123]}},"1":{"type":"string"}}}"#,
                )],
            ),
            ("settings-null", vec![("settings", "null")]),
            (
                "properties",
                vec![("properties", r#"{"plan":{"support":"sometimes"}}"#)],
            ),
        ] {
            let mutated = assign(text, &members);
            c.push(
                "module-mutations",
                format!("module:{name}+{label}"),
                json!({"op":"loadModule","hex":hex(mutated.as_bytes())}),
            );
        }
    }

    // Registries: Map.set replacement, raw trees, key/name mismatch, copies.
    let codex = pinned
        .iter()
        .find(|(name, _)| name == "codex")
        .unwrap()
        .1
        .clone();
    let example = modules_text[0].1.clone();
    let nested = assign(
        &example,
        &[(
            "settings",
            r#"{"type":"object","properties":{"2":{"type":"array","maxItems":1e400,"items":{"type":"integer","enum":[1.0,12345678901234567890123]}},"1":{"type":"string","enum":["a"]}},"additionalProperties":false}"#,
        )],
    );
    let settings_doc = r#"{"contract":"agsdl-0.3.0","id":"settings","agents":{"a":{"harness":"example","permissions":"full","harnessSettings":{"2":[1,2.5,"x"],"1":"b","0":false}}}}"#;
    let order_doc = r#"{"contract":"agsdl-0.3.0","id":"order"}"#;
    let directories_doc = r#"{"contract":"agsdl-0.3.0","id":"order","agents":{"a":{"harness":"unknown","permissions":{"preset":"read-only","directories":{"2":"write","1":"write"}}}}}"#;
    for (label, document, modules) in [
        (
            "overwritten-broken",
            settings_doc,
            modules_from(&[
                ("example", "{\"bad\":1}".to_owned(), false),
                ("example", nested.clone(), false),
            ]),
        ),
        (
            "overwritten-mismatch",
            settings_doc,
            modules_from(&[
                ("example", codex.clone(), true),
                ("example", nested.clone(), true),
            ]),
        ),
        (
            "raw-nested",
            settings_doc,
            modules_from(&[("example", nested.clone(), false)]),
        ),
        (
            "loaded-nested",
            settings_doc,
            modules_from(&[("example", nested.clone(), true)]),
        ),
        (
            "mismatch",
            settings_doc,
            modules_from(&[("other", example.clone(), true)]),
        ),
        (
            "raw-broken",
            settings_doc,
            modules_from(&[
                ("example", example.clone(), true),
                ("codex", "{\"name\":\"codex\"}".to_owned(), false),
            ]),
        ),
        (
            "raw-order",
            order_doc,
            modules_from(&[(
                "codex",
                assign(&codex, &[("2", "false"), ("1", "true")]),
                false,
            )]),
        ),
        (
            "raw-reinserted",
            order_doc,
            modules_from(&[(
                "codex",
                assign(
                    &without(&assign(&codex, &[("2", "false"), ("1", "true")]), "2"),
                    &[("2", "false")],
                ),
                false,
            )]),
        ),
        (
            "raw-settings-order",
            order_doc,
            modules_from(&[(
                "codex",
                assign(
                    &codex,
                    &[(
                        "settings",
                        r#"{"type":"object","properties":{"2":{"type":"string","items":{"type":"string"}},"1":{"type":"string","items":{"type":"string"}}}}"#,
                    )],
                ),
                false,
            )]),
        ),
        (
            "setup-failure",
            order_doc,
            modules_from(&[("x", "{".to_owned(), true)]),
        ),
        (
            "directories",
            directories_doc,
            json!({"kind":"map","entries":[]}),
        ),
        (
            "parse-before-registry",
            "{",
            modules_from(&[("other", example.clone(), true)]),
        ),
        (
            "pinned-explicit",
            settings_doc,
            modules_from(
                &pinned
                    .iter()
                    .map(|(name, text)| (name.as_str(), text.clone(), true))
                    .collect::<Vec<_>>(),
            ),
        ),
    ] {
        c.push(
            "registry",
            format!("registry:{label}"),
            json!({"op":"read","hex":hex(document.as_bytes()),"modules":modules}),
        );
        if scan::parse_v030(document.as_bytes()).is_ok() {
            c.push(
                "registry",
                format!("registry:{label}#exact"),
                json!({"op":"validateExact","document":document,"mode":"v030","modules":modules}),
            );
        }
    }

    // TS test vectors (validator, diagnostic order, reader worker).
    let deep = |depth: usize| {
        let mut compositions = Vec::new();
        for i in 0..depth {
            let step = if i == depth - 1 {
                r#"{"type":"agent","agent":"a","next":{"output":"done"}}"#.to_owned()
            } else {
                format!(
                    r#"{{"type":"compose","composition":"c{}","next":{{"done":{{"output":"done"}}}}}}"#,
                    i + 1
                )
            };
            compositions.push(format!(
                r#""c{i}":{{"entry":"s","outputs":["done"],"steps":{{"s":{step}}}}}"#
            ));
        }
        format!(
            r#"{{"contract":"agsdl-0.3.0","id":"deep","agents":{{"a":{{"harness":"unknown","permissions":"full"}}}},"flow":{{"entry":"s","steps":{{"s":{{"type":"compose","composition":"c0","next":{{"done":[]}}}}}}}},"compositions":{{{}}}}}"#,
            compositions.join(",")
        )
    };
    let empty = json!({"kind":"map","entries":[]});
    for (label, text) in [
        ("deep-300", deep(300)),
        ("deep-1500", deep(1500)),
        ("directories", directories_doc.to_owned()),
        ("minimal", r#"{"contract":"agsdl-0.3.0","id":"x","agents":{}}"#.to_owned()),
        ("missing-agents", order_doc.to_owned()),
        ("id-newline", "{\"contract\":\"agsdl-0.3.0\",\"id\":\"x\\n\",\"agents\":{}}".to_owned()),
        ("astral-name", r#"{"contract":"agsdl-0.3.0","id":"x","agents":{"😀":{"harness":"a","permissions":"full"}}}"#.to_owned()),
        ("duplicate-key", r#"{"contract":"agsdl-0.3.0","contract":"x"}"#.to_owned()),
        ("lone-surrogate", r#"{"contract":"agsdl-0.3.0","id":"\ud800","agents":{}}"#.to_owned()),
        ("bad-utf8", String::from_utf8_lossy(b"{\"id\":\"\xff\"}").into_owned()),
        ("big-numbers", r#"{"contract":"agsdl-0.3.0","id":"n","agents":{"a":{"harness":"example","permissions":"full","maxCorrections":1e400,"answerTimeoutMs":0.5e1}}}"#.to_owned()),
        ("chain-64", super::approval_chain(64)),
    ] {
        c.read("ts-vectors", &format!("ts:{label}"), text.as_bytes(), &[("empty", empty.clone()), ("official", official.clone())]);
        // The deep-1500 snapshot holds every nested scope of every composition
        // graph, quadratic in size: the oracle's JS heap refuses it. The reader
        // itself is compared on it above.
        if scan::parse_v030(text.as_bytes()).is_ok() && label != "deep-1500" {
            c.graph("graph-files", &format!("ts:{label}"), &text);
        }
    }
    c.read(
        "ts-vectors",
        "ts:invalid-utf8-bytes",
        b"{\"id\":\"\xff\"}",
        &[("empty", empty.clone())],
    );

    // Schema roots over generated host messages and value schemas.
    let uris = [
        "https://example.org/a?b=c#d",
        "file:///tmp/x",
        "urn:isbn:0451450523",
        "http://[::1]:80/",
        "http://[v1.fe]/",
        "http://192.168.0.1:8080/p",
        "mailto:a@b.c",
        "x",
        "1abc:",
        "https://exa mple.org",
        "https://example.org/\n",
        "https://é.org",
        "https://example.org/😀",
        "",
        "a:",
        "HTTPS://EXAMPLE.ORG/%7E",
        "https://example.org/%zz",
        "http://[::ffff:1.2.3.4]/",
        "http://[1:2:3:4:5:6:7:8:9]/",
        "s3://bucket/key with space",
    ];
    let long = format!("https://example.org/{}", "a/".repeat(1500));
    for (index, uri) in uris.iter().map(|u| u.to_string()).chain([long]).enumerate() {
        let message = format!(
            r#"{{"prompt":[{{"uri":{}}},{{"ref":"brief"}}],"resources":{{"r":{{"uri":{},"mediaType":"text/plain"}}}}}}"#,
            quote(&uri),
            quote(&uri)
        );
        c.schema(
            "schema-generated",
            &format!("host:uri{index}"),
            "hostMessage",
            &message,
        );
        let skill = format!(
            r#"{{"contract":"agsdl-0.3.0","id":"u","agents":{{}},"skills":{{"k":{{"uri":{}}}}}}}"#,
            quote(&uri)
        );
        c.schema(
            "schema-generated",
            &format!("doc:uri{index}"),
            "document",
            &skill,
        );
    }
    for (index, message) in [
        r#"{"prompt":"go"}"#,
        r#"{"prompt":[]}"#,
        r#"{"prompt":[{"value":"x","mediaType":"text/plain\n"}]}"#,
        r#"{"prompt":[{"value":1e400,"mediaType":"application/vnd.x+json"}]}"#,
        r#"{"prompt":{"from":["text"]}}"#,
        r#"{"resources":{"a\n":{"value":1}}}"#,
        r#"{"resources":{"😀":{"value":1}}}"#,
        r#"{"other":1}"#,
        "[]",
        "null",
        r#"{"resources":{"r":{"ref":"x","extra":1}}}"#,
        r#"{"prompt":[{"ref":"1x"}]}"#,
    ]
    .iter()
    .enumerate()
    {
        c.schema(
            "schema-generated",
            &format!("host:message{index}"),
            "hostMessage",
            message,
        );
    }
    let names: Vec<String> = ["a", "A1_-", "1a", "a\n", "é", "a😀", "_a"]
        .iter()
        .map(|n| n.to_string())
        .chain([
            format!("a{}", "b".repeat(63)),
            format!("a{}", "b".repeat(64)),
        ])
        .collect();
    for (index, name) in names.iter().enumerate() {
        let doc = format!(
            r#"{{"contract":"agsdl-0.3.0","id":{},"agents":{{{}:{{"harness":{},"permissions":"full"}}}}}}"#,
            quote(name),
            quote(name),
            quote(name)
        );
        c.schema(
            "schema-generated",
            &format!("doc:name{index}"),
            "document",
            &doc,
        );
        let choice = format!(
            r#"{{"contract":"agsdl-0.3.0","id":"c","agents":{{"w":{{"harness":"x","permissions":"full"}}}},"flow":{{"entry":"s","steps":{{"s":{{"type":"approval","next":{{{}:"s"}}}}}}}}}}"#,
            quote(&name.to_lowercase())
        );
        c.schema(
            "schema-generated",
            &format!("doc:choice{index}"),
            "document",
            &choice,
        );
        let module = assign(
            &example,
            &[
                ("name", &quote(name)),
                ("version", &quote(&format!("1.{index}.0"))),
            ],
        );
        c.schema(
            "schema-generated",
            &format!("module:name{index}"),
            "module",
            &module,
        );
    }
    for (index, schema) in [
        r#"{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":false}"#,
        r#"{"type":"array","items":{"type":"integer"},"minItems":0,"maxItems":1e400}"#,
        r#"{"type":"array","minItems":-1}"#, r#"{"type":"array","minItems":1.5}"#, r#"{"type":"text"}"#,
        r#"{"type":"object","enum":[]}"#, r#"{"type":"string","enum":["a","a"]}"#, r#"{"type":"string","pattern":"x"}"#,
        r#"{"type":"object","properties":{"2":{"type":"string"},"1":{"type":"number"}}}"#, r#"{}"#, "null", "[]",
        r#"{"type":"string","description":1}"#, r#"{"type":"integer","enum":[1,1.0]}"#,
    ]
    .iter()
    .enumerate()
    {
        c.schema("schema-generated", &format!("value:{index}"), "valueSchema", schema);
    }

    // Deterministic mutations of every parseable document.
    let mut rng = Rng(SEED);
    for (id, text) in &documents {
        let tree = scan::parse_v030(text.as_bytes()).unwrap().tree;
        for round in 0..3 {
            if let Some(mutated) = mutate(&mut rng, &tree) {
                let label = format!("{id}~m{round}");
                c.read("mutations", &label, mutated.as_bytes(), &sets[..1]);
                if scan::parse_v030(mutated.as_bytes()).is_ok() {
                    c.graph("graph-generated", &label, &mutated);
                }
            }
        }
    }

    // Generated documents.
    for index in 0..450 {
        let text = generate(&mut rng);
        let id = format!("gen:{index}");
        c.read("generated", &id, text.as_bytes(), &sets[..2]);
        c.graph("graph-generated", &id, &text);
        if index % 9 == 0 {
            c.exact(&id, &text, &official);
        }
        if index % 3 == 0 {
            if let Some(mutated) =
                mutate(&mut rng, &scan::parse_v030(text.as_bytes()).unwrap().tree)
            {
                c.read(
                    "generated",
                    &format!("{id}~m"),
                    mutated.as_bytes(),
                    &sets[..1],
                );
            }
        }
    }

    // Static permission helpers.
    for (pattern, subject, paths, command) in [
        ("*.ts", "a/b.ts", true, false),
        ("**.ts", "a/b.ts", true, false),
        ("a/**/b", "a/b", true, false),
        ("git push *", "git push", false, true),
        ("git push *", "git push origin", false, true),
        ("git push *", "git pushx", false, true),
        ("a.b[0](x)+?^$|\\", "a.b[0](x)+?^$|\\", false, false),
        ("literal", "literal\n", false, false),
        ("*", "x\ny😀", false, false),
        ("a*", "a\nb", true, false),
        ("**", "x/y", false, false),
        ("***", "x/y", true, false),
    ] {
        c.permission(format!("perm:glob:{pattern}:{subject}"), json!({"fn":"glob","pattern":pattern,"subject":subject,"paths":paths,"command":command}));
    }
    let alphabet = [
        "*", "*", "/", "a", "b", ".", "😀", "\n", " ", "[", "\\", "é",
    ];
    for index in 0..400 {
        let word = |rng: &mut Rng, max: usize| -> String {
            (0..rng.below(max)).map(|_| *rng.pick(&alphabet)).collect()
        };
        let pattern = word(&mut rng, 8);
        let subject = word(&mut rng, 10).replace('*', "x");
        c.permission(
            format!("perm:glob-gen:{index}"),
            json!({"fn":"glob","pattern":pattern,"subject":subject,"paths":rng.chance(50),"command":rng.chance(30)}),
        );
    }
    let spaces = [
        "\t", "\u{b}", "\u{1c}", " ", "\u{85}", "\u{a0}", "\u{1680}", "\u{2000}", "\u{200a}",
        "\u{2028}", "\u{202f}", "\u{205f}", "\u{3000}", "\u{feff}", "\u{200b}", "\u{180e}",
    ];
    for p in [
        "git push",
        "git push *",
        "a\tb",
        "\u{feff}cmd",
        "",
        "*",
        "git*",
        "git * status",
        " git",
        "git ",
        "\u{85}git",
        "git\u{1f}",
    ] {
        c.permission(
            format!("perm:prefix:{p}"),
            json!({"fn":"command_prefix","pattern":p}),
        );
    }
    for (index, space) in spaces.iter().enumerate() {
        for form in [
            format!("{space}git"),
            format!("git{space}"),
            format!("git{space}push *"),
            format!("git{space} *"),
        ] {
            c.permission(
                format!("perm:prefix-ws:{index}:{}", form.escape_debug()),
                json!({"fn":"command_prefix","pattern":form}),
            );
        }
    }
    let values = [
        None,
        Some(r#""workspace""#),
        Some(r#""full""#),
        Some(r#""read-only""#),
        Some(r#"{"preset":"full","outside":"deny"}"#),
        Some(r#"{"outside":"read"}"#),
        Some(
            r#"{"preset":"full","rules":[{"action":"shell","match":"git *","effect":"ask"},{"action":"shell","match":"git push *","effect":"deny"},{"action":"shell","match":"git push origin","effect":"allow"}]}"#,
        ),
        Some(r#"{"rules":[{"action":"network","effect":"allow"}]}"#),
        Some(r#"{"preset":"full","rules":[{"action":"shell","effect":"deny","match":"*"}]}"#),
        Some(
            r#"{"preset":"read-only","rules":[{"action":"shell","effect":"ask","match":"git *"}]}"#,
        ),
        Some(r#"{"rules":[{"action":"shell","effect":"deny","match":"git *"}]}"#),
        Some(r#"{"preset":"workspace","rules":[{"action":"write","match":"**","effect":"ask"}]}"#),
        Some(r#"{"preset":"full","rules":[{"action":"read","match":"/**","effect":"ask"}]}"#),
        Some(r#"{"rules":[{"action":"delegate","effect":"allow"}]}"#),
        Some(
            r#"{"preset":"workspace","rules":[{"action":"read","match":"/src/**","effect":"deny"},{"action":"write","match":"*.md","effect":"ask"}]}"#,
        ),
    ];
    for (index, value) in values.iter().enumerate() {
        let permissions = value.map_or(Json::Null, |text| json!(text));
        for helper in ["normalize", "outside", "shell_denied", "effects_in_use"] {
            c.permission(
                format!("perm:{helper}:{index}"),
                json!({"fn":helper,"permissions":permissions}),
            );
        }
        for (action, subject) in [
            ("shell", "git push origin"),
            ("shell", "git status"),
            ("shell", "echo ok"),
            ("read", "/src/a"),
            ("write", "a.md"),
            ("network", "example.org"),
            ("delegate", "x"),
            ("mcp", "m"),
        ] {
            c.permission(format!("perm:effect:{index}:{action}:{subject}"), json!({"fn":"effect_for","permissions":permissions,"action":action,"subject":subject}));
        }
    }
    for rule in [
        r#"{"action":"read","effect":"deny","match":"**"}"#,
        r#"{"action":"write","effect":"deny","match":"/**"}"#,
        r#"{"action":"shell","effect":"deny","match":"**"}"#,
        r#"{"action":"shell","effect":"deny","match":""}"#,
        r#"{"action":"delegate","effect":"deny"}"#,
        r#"{"action":"network","effect":"ask","match":"*.org"}"#,
    ] {
        c.permission(
            format!("perm:covers:{rule}"),
            json!({"fn":"covers_all","rule":rule}),
        );
    }

    for &(family, minimum) in MINIMUMS {
        assert!(
            c.counts.get(family).copied().unwrap_or(0) >= minimum,
            "missing corpus family {family}: {:?}, expected >= {minimum}",
            c.counts.get(family)
        );
    }
    c
}
