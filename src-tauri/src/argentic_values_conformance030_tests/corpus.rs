//! Deterministic corpus recipes and file manifest for the values differential.
//! Repository JSON is read as authored bytes; no official fixture is rewritten.
use super::{digest, hex, json, Json};
use crate::argentic_core::exact::{self, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

pub(super) const SEED: u64 = 0x030d_152c_0126;
pub(super) const MINIMUMS: &[(&str, usize)] = &[
    ("scanner-vectors", 150),
    ("scanner-generated", 600),
    ("scanner-files", 600),
    ("numbers", 600),
    ("structural", 100),
    ("schema-vectors", 300),
    ("schema-generated", 100),
    ("schema-files", 20),
    ("access", 100),
    ("integer", 100),
    ("integer-compare", 300),
    ("monotone", 100),
    ("bounded", 100),
    ("timer", 300),
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
    fn add(&mut self, family: &'static str, label: &str, request: Json) {
        let ordinal = self.counts.entry(family).or_default();
        *ordinal += 1;
        self.cases.push(Case {
            id: format!("{family}/{ordinal}/{label}"),
            family,
            request,
        });
    }
    fn parse(&mut self, family: &'static str, label: &str, bytes: &[u8]) {
        for mode in ["shared", "experimental", "v030"] {
            self.add(
                family,
                &format!("{label}/{mode}"),
                json!({"op":"parse","mode":mode,"hex":hex(bytes)}),
            );
        }
    }
    fn pair(&mut self, family: &'static str, left: &str, right: &str) {
        self.add(
            family,
            "pair",
            json!({"op":"values","left":left,"right":right}),
        );
    }
    fn schema(
        &mut self,
        family: &'static str,
        label: &str,
        schema: &str,
        value: &str,
        path: Json,
        pointer: &str,
    ) {
        self.add(
            family,
            label,
            json!({"op":"schema","schema":schema,"value":value,"path":path,"pointer":pointer}),
        );
    }
    fn integer(
        &mut self,
        family: &'static str,
        action: &str,
        raw: &str,
        other: &str,
        positive: bool,
        slice: i64,
        no_limit: bool,
    ) {
        self.add(family,action,json!({"op":"integer","action":action,"raw":raw,"other":other,"positive":positive,"slice":slice,"noLimit":no_limit}));
    }
}
struct Random(u64);
impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}
fn json_files(root: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    entries.sort();
    for entry in entries {
        if entry.is_dir() {
            json_files(&entry, out);
        } else if entry
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            out.push(entry);
        }
    }
}

pub(super) fn build() -> Corpus {
    let mut c = Corpus {
        cases: Vec::new(),
        files: Vec::new(),
        counts: BTreeMap::new(),
    };
    // Vectors from exact.test.ts, v0.3/exact.test.ts, diagnosticOrder.test.ts,
    // agentWork030.test.ts and valueSchemaPort030.test.ts, plus delimiter edges.
    let valid = [
        "null",
        "true",
        "false",
        "0",
        "-0",
        "1.00e+9999999999999999999999",
        "\"é\\n𝄞\"",
        "{\"large\":9007199254740993,\"exponent\":1e999999,\"negativeZero\":-0,\"text\":\"é\\n𝄞\"}",
        " {\"é/~\":[9007199254740993,1.00e+9999999999999999999999,-0]} ",
        "\"\\ud83d\\ude00\"",
        "\"😀�\"",
        "{\"__proto__\":1,\"constructor\":2,\"toString\":3}",
        "{\"other\":0,\"2\":9007199254740993,\"1\":0,\"nested\":{\"9\":0,\"8\":1}}",
        "{\"4294967295\":0,\"4294967294\":1,\"01\":2,\"10\":3,\"-0\":4,\"0\":5}",
        "{\"a/b\":[1,\"x\"],\"~\":{}}",
        "[]",
        "{}",
        "[ ]",
        "{ }",
        "[1, [2], {\"a\":3}]",
        "\"\\b\\f\\n\\r\\t\\u0000\\u001f/\\\\\\\"\u{7f}\u{2028}\u{2029}\"",
    ];
    let invalid = [
        "",
        "NaN",
        "Infinity",
        "-Infinity",
        "01",
        "+1",
        "1.",
        "1e",
        "true false",
        "[1,]",
        "{\"a\":1,}",
        "{\"a\":1,\"\\u0061\":2}",
        "\u{feff}{}",
        "\"\\ud800\"",
        "\"\\udc00\"",
        "\"\\ud800x\"",
        "\"\\ud800\\u0041\"",
        "\"\n\"",
        "{\"\\ud800\":1}",
        "[1 2]",
        "{\"x\" 1}",
        "{,}",
        "{\"é\":0,\"é\":1}",
        "\"\\uZZZZ\"",
        "\"\\x\"",
        "\"\\",
        "-",
        "1e+",
        "tru",
        "nul1",
        "[1] x",
        "{\"a\"",
        "[",
        "{",
        "[1,",
        "{\"a\":",
    ];
    for text in valid.iter().chain(invalid.iter()) {
        c.parse("scanner-vectors", text, text.as_bytes());
    }
    for bytes in [
        vec![34, 0xc0, 0xaf, 34],
        vec![34, 0xed, 0xa0, 0x80, 34],
        vec![34, 0xf4, 0x90, 0x80, 0x80, 34],
        vec![34, 0xe2, 0x82],
        vec![34, 0x80, 34],
    ] {
        c.parse("scanner-vectors", "utf8", &bytes);
    }
    // Every byte value in a quoted string, including all UTF-8 error classes.
    for scalar in [
        0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff,
    ] {
        let text = format!("\"{}\"", char::from_u32(scalar).unwrap());
        c.parse("scanner-generated", "unicode-boundary", text.as_bytes());
    }
    for byte in 0..=255 {
        c.parse("scanner-generated", "byte", &[b'"', byte, b'"']);
    }
    let mut random = Random(SEED);
    let mut numbers: Vec<String> = [
        "0",
        "-0",
        "0.0",
        "-0.000e-99999999999999999999",
        "1",
        "1.0",
        "1e0",
        "1E+2",
        "100",
        "9007199254740991",
        "9007199254740992",
        "9007199254740993",
        "18446744073709551615",
        "1e400",
        "-1e-400",
        "1.00000000000000000001",
        "1.00000000000000000002",
        "1e999999999999999999999999",
        "9e999999999999999999999998",
        "1e-999999999999999999999999",
        "9e-999999999999999999999998",
        "-2e100000000000000000000",
        "-1e100000000000000000000",
        "1200",
        "12e2",
        "1.20",
        "1.20001",
        "-0.1",
        "1.01",
        "1001e-3",
        "150e-1",
        "9.007199254740991e15",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    numbers.push("9".repeat(256));
    numbers.push(format!("-{}.{}e-100", "1".repeat(128), "0".repeat(128)));
    for index in 0..128 {
        let n = random.next();
        let raw = format!(
            "{}{}.{}{}{}{}",
            if n & 1 == 0 { "" } else { "-" },
            n % 999_999,
            n % 10007,
            if n & 2 == 0 { "e" } else { "E" },
            if n & 4 == 0 { "+" } else { "-" },
            if index % 7 == 0 {
                "999999999999999999999999".to_owned()
            } else {
                (n % 100).to_string()
            }
        );
        numbers.push(raw.clone());
        let text = format!(
            "{{\"{}\":{},\"é/~\":[{},\"😀\\u0001\"],\"4294967295\":-0}}",
            n % 100,
            raw,
            index
        );
        c.parse("scanner-generated", "object", text.as_bytes());
        c.parse(
            "scanner-generated",
            "truncated",
            &text.as_bytes()[..text.len() - 1],
        );
    }
    for depth in [1, 2, 8, 32, 64] {
        let text = format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
        c.parse("scanner-generated", "depth", text.as_bytes());
    }
    // These iterative 0.3 cases exceed the shared recursive oracle's common
    // resource domain, so they are separate, named vectors for that scanner.
    let deep = format!(
        "{}1e100000000000000000000{}",
        "[".repeat(4000),
        "]".repeat(4000)
    );
    c.add(
        "scanner-vectors",
        "v030-depth-4000",
        json!({"op":"parse","mode":"v030","hex":hex(deep.as_bytes()),"clone":false}),
    );
    let large = format!("\"{}\"", "x".repeat(1024 * 1024 + 1));
    c.add(
        "scanner-vectors",
        "v030-over-editor-limit",
        json!({"op":"parse","mode":"v030","hex":hex(large.as_bytes())}),
    );
    for (i, a) in numbers.iter().enumerate() {
        for b in [
            &numbers[i],
            &numbers[(i + 1) % numbers.len()],
            &numbers[(i + 17) % numbers.len()],
            &numbers[0],
        ] {
            c.pair("numbers", a, b);
        }
    }
    let values = [
        "null",
        "true",
        "false",
        "0",
        "1",
        "\"1\"",
        "[]",
        "{}",
        "[1,2]",
        "[1.0,2e0]",
        "{\"a\":1,\"b\":2}",
        "{\"b\":2,\"a\":1.0}",
        "{\"__proto__\":1}",
        "{\"raw\":\"1\"}",
        "\"😀é/~\"",
    ];
    for a in values {
        for b in values {
            c.pair("structural", a, b);
        }
    }
    for a in invalid {
        c.pair("structural", a, "0");
        c.pair("structural", "0", a);
    }
    for text in values.iter().chain(invalid.iter()) {
        for action in ["record", "list", "text", "has", "at"] {
            for missing in [false, true] {
                c.add("access",action,json!({"op":"access","action":action,"value":text,"pointer":"/results/a~1b~0c","key":"a/b~c","missing":missing}));
            }
        }
    }
    for key in ["a/b~c", "__proto__", "constructor", "toString", ""] {
        for value in [
            "{}",
            r#"{"a/b~c":1,"__proto__":2,"constructor":3,"toString":4,"":5}"#,
        ] {
            c.add(
                "access",
                "own-key",
                json!({"op":"access","action":"has","value":value,"pointer":"","key":key}),
            );
        }
    }
    let constraints = [
        r#"{"type":"object","minItems":2,"maxItems":1,"required":["x"],"properties":{"a":{"type":"number","enum":[1,1.0,true]}}}"#,
        r#"{"type":"object","properties":{"a":{"type":"array","minItems":2,"maxItems":1e0,"items":{"type":"integer","enum":[1,2e0]}}},"required":["a","b~/"],"additionalProperties":false}"#,
        r#"{"type":"array","minItems":9007199254740993,"maxItems":9007199254740992}"#,
        r#"{"type":"array","maxItems":1e30,"items":{"type":"object","properties":{"n":{"type":"number"}},"additionalProperties":false}}"#,
        r#"{"type":"string","enum":["é","😀",true]}"#,
        r#"{"type":"array","enum":[[true]]}"#,
        r#"{"type":"object"}"#,
        r#"{"type":"array"}"#,
        r#"{"type":"null"}"#,
        r#"{"type":"object","properties":{"2":{"type":"number"},"1":{"type":"string"},"é/~":{"type":"integer"}},"required":["x","y"],"additionalProperties":false}"#,
        r#"{"type":"array","minItems":-0,"maxItems":2.0e0,"items":{"type":"boolean"}}"#,
    ];
    let paths = [
        json!([]),
        json!([{"kind":"number","raw":"1.0"}]),
        json!([{"kind":"number","raw":"1e30"}]),
        json!([{"kind":"key","raw":"a"}]),
        json!([{"kind":"key","raw":"list"},{"kind":"index","index":0}]),
        json!([{"kind":"number","raw":"-1"},{"kind":"key","raw":"n"}]),
        json!([{"kind":"number","raw":"1.5"}]),
        json!([{"kind":"key","raw":"é/~"}]),
    ];
    for constraint in constraints {
        for value in values
            .iter()
            .chain(["{\"a\":[1.0,3,\"s\"],\"x\":1,\"y/~\":null}", "[true]"].iter())
        {
            for path in &paths {
                c.schema(
                    "schema-vectors",
                    "vector",
                    constraint,
                    value,
                    path.clone(),
                    "/results/a~1b~0",
                );
            }
        }
    }
    for index in 0..128 {
        let constraint=format!("{{\"type\":\"array\",\"minItems\":{},\"maxItems\":{},\"items\":{{\"type\":\"integer\",\"enum\":[1,1e0,{},true]}}}}",index%5,index%3,index);
        c.schema(
            "schema-generated",
            "bounds-enum",
            &constraint,
            "[0,1,1.5,true]",
            paths[index % paths.len()].clone(),
            if index % 2 == 0 { "" } else { "/a~1b~0" },
        );
    }
    for schema in [
        "[]",
        r#"{"items":{"type":"string"}}"#,
        r#"{"type":"text"}"#,
        r#"{"type":"array","minItems":-1}"#,
        r#"{"type":"object","required":["a","a"]}"#,
    ] {
        c.schema(
            "schema-generated",
            "outside-published-shape",
            schema,
            "null",
            json!([]),
            "",
        );
    }
    let mut integer_raw = numbers.clone();
    integer_raw.extend(invalid.iter().map(|s| s.to_string()));
    integer_raw.extend(values.iter().map(|s| s.to_string()));
    integer_raw.extend(
        [" 1e2 ", "012", "+1", "-1", "1.00e2"]
            .iter()
            .map(|s| s.to_string()),
    );
    for (index, raw) in integer_raw.iter().enumerate() {
        for positive in [false, true] {
            c.integer("integer", "integer", raw, "0", positive, 1, false);
        }
        for other in ["0", "100", "1e999999999999999999999999"] {
            c.integer("integer-compare", "compare", raw, other, false, 1, false);
        }
        c.integer("monotone", "monotone", raw, "0", false, 1, false);
        for bound in ["-1", "0", "100", "18446744073709551615"] {
            c.integer("bounded", "bounded", raw, bound, false, 1, false);
        }
        for slice in [-1, 0, 1, 10, 2_147_483_647, 2_147_483_648] {
            c.integer(
                "timer",
                "timer",
                raw,
                if index % 3 == 0 { "-9" } else { "99" },
                false,
                slice,
                index % 11 == 0,
            );
        }
    }
    for raw in ["1\n", "1\r\n", "0\u{2028}", "01\n", "1.0\n"] {
        c.integer("monotone", "monotone", raw, "0", false, 1, false);
    }
    for (left, right) in [("0", "bad"), ("bad", "01"), ("1", "-1"), ("1e2", " 100 ")] {
        c.integer("integer-compare", "compare", left, right, false, 1, false);
    }
    repository(&mut c);
    for &(family, minimum) in MINIMUMS {
        assert!(
            c.counts.get(family).copied().unwrap_or(0) >= minimum,
            "missing corpus family {family}, expected >= {minimum}"
        );
    }
    c
}

fn repository(c: &mut Corpus) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    for directory in [
        "dev/agsdl/fixtures/v0.3",
        "src/vendor/agsdl/v0.3/schema",
        "src/vendor/agsdl/v0.3/harnesses",
        "src/demo/agsdl",
    ] {
        json_files(&root.join(directory), &mut files);
    }
    files.sort();
    let mut source_counts = BTreeMap::<&str, usize>::new();
    let mut numbers = BTreeSet::new();
    for path in files {
        let relative = path
            .strip_prefix(root)
            .unwrap()
            .to_str()
            .unwrap()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let bytes = std::fs::read(&path).unwrap();
        let category = if relative.contains("/conformance/runs/") {
            "scenarios"
        } else if relative.contains("/conformance/cases/") {
            "staticCases"
        } else if relative.contains("/examples/") {
            "examples"
        } else if relative.contains("/harnesses/") {
            "modules"
        } else if relative.starts_with("src/demo/") {
            "demo"
        } else {
            "other"
        };
        *source_counts.entry(category).or_default() += 1;
        c.files.push(json!({"path":relative,"category":category,"bytes":bytes.len(),"sha256":digest(&bytes)}));
        c.parse("scanner-files", &relative, &bytes);
        if let Ok(parsed) = exact::scan::parse_v030(&bytes) {
            let mut pending = vec![(&parsed.tree, String::new())];
            while let Some((node, pointer)) = pending.pop() {
                match node {
                    Value::Number(number) => {
                        numbers.insert(number.raw().to_owned());
                    }
                    Value::Array(items) => {
                        for (i, item) in items.iter().enumerate().rev() {
                            pending.push((item, exact::at(&pointer, &i.to_string())));
                        }
                    }
                    Value::Object(object) => {
                        for (key, value) in object.iter().rev() {
                            let at = exact::at(&pointer, key);
                            if key == "schema" || key == "settings" {
                                for sample in ["null", "{\"x\":1}", "[1,1.5,true]", "\"😀\""] {
                                    c.schema(
                                        "schema-files",
                                        &format!("{relative}#{at}"),
                                        &exact::stringify(value),
                                        sample,
                                        json!([]),
                                        "/results/value",
                                    );
                                }
                            }
                            pending.push((value, at));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    assert_eq!(
        source_counts["scenarios"], 37,
        "official run corpus changed"
    );
    assert_eq!(
        source_counts["staticCases"], 144,
        "official static corpus changed"
    );
    assert_eq!(source_counts["examples"], 10, "official examples changed");
    for raw in numbers {
        c.pair("numbers", &raw, "0");
    }
}
