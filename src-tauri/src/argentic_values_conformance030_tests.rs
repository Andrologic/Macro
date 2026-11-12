//! Differential values tests. Process transport and corpus IO belong to Macro's
//! tests, never to the staged pure core. The existing CI filter selects this module.
use crate::argentic_core::{error::Failure, exact, integers, valueschema};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

mod corpus;

fn string<'a>(request: &'a Json, key: &str) -> &'a str {
    request[key].as_str().unwrap()
}
fn ok(output: Json) -> Json {
    json!({"status":"ok","output":output})
}
fn failure(error: Failure) -> Json {
    json!({"status":"failure","code":error.code,"pointer":error.pointer,"message":error.message})
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
fn parse(request: &Json) -> Json {
    let mut bytes = unhex(string(request, "hex"));
    let original = bytes.clone();
    let parsed = match string(request, "mode") {
        "shared" => exact::scan::parse_shared(&bytes),
        "experimental" => exact::scan::parse_experimental(&bytes),
        "v030" => exact::scan::parse_v030(&bytes),
        mode => panic!("unknown scanner {mode}"),
    };
    bytes.fill(0);
    match parsed {
        Err(error) => {
            json!({"status":"parseError","byte":error.byte,"message":error.message(),"tree":null,"spans":[],"bytesHex":hex(&original)})
        }
        Ok(parsed) => {
            let spans: Vec<_> = parsed
                .spans()
                .into_iter()
                .map(|s| json!([s.pointer,{"start":s.start,"end":s.end}]))
                .collect();
            ok(
                json!({"encoded":exact::stringify(&parsed.tree),"cloned":if request["clone"]==false || request["mode"]=="experimental" {None} else {Some(exact::stringify(&exact::values::clone(&parsed.tree)))},"spans":spans,"bytesHex":hex(&original)}),
            )
        }
    }
}
fn schema(request: &Json) -> Json {
    let constraint = exact::scan::parse_v030(string(request, "schema").as_bytes())
        .unwrap()
        .tree;
    if valueschema::check_shape(&constraint).is_err() {
        return ok(json!({"inDomain":false}));
    }
    let value = exact::scan::parse_v030(string(request, "value").as_bytes())
        .unwrap()
        .tree;
    let path: Vec<_> = request["path"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| match string(part, "kind") {
            "key" => valueschema::PointerPart::Key(string(part, "raw").to_owned()),
            "number" => valueschema::PointerPart::Number(
                exact::NumberToken::lexeme(string(part, "raw")).unwrap(),
            ),
            "index" => valueschema::PointerPart::Index(part["index"].as_u64().unwrap() as usize),
            kind => panic!("unknown path part {kind}"),
        })
        .collect();
    let descent = match valueschema::descend(&constraint, &path).unwrap() {
        valueschema::Descent::Allowed => json!([true, null]),
        valueschema::Descent::Refused(message) => json!([false, message]),
        valueschema::Descent::Unknown => json!([null, null]),
    };
    let diagnostics: Vec<_> = valueschema::port::validate_value_schema030(
        &value,
        &constraint,
        string(request, "pointer"),
    )
    .unwrap()
    .into_iter()
    .map(|d| json!({"pointer":d.pointer,"rule":d.rule,"message":d.message}))
    .collect();
    ok(
        json!({"inDomain":true,"consistency":valueschema::consistency(&constraint,&path).unwrap(),
        "validate":valueschema::validate(&value,&constraint,&path).unwrap(),"descend":descent,
        "kindAt":valueschema::kind_at(&constraint,&path).unwrap(),"port":diagnostics}),
    )
}
fn evaluate(request: &Json) -> Result<Json, Failure> {
    match string(request, "op") {
        "values" => {
            let left = exact::decode(string(request, "left"))?;
            let right = exact::decode(string(request, "right"))?;
            let decimal = left.as_number().map(|n| {
                let d = exact::values::decimal(n);
                json!([d.sign(), d.digits, d.exponent.to_js_string()])
            });
            let comparison = left.as_number().zip(right.as_number()).map(|(a, b)| {
                exact::values::ordering_number(exact::values::compare_numbers(
                    exact::values::Num::Token(a),
                    exact::values::Num::Token(b),
                ))
            });
            let types: Vec<_> = [
                "null", "boolean", "number", "integer", "string", "array", "object", "unknown",
            ]
            .iter()
            .map(|kind| exact::values::json_type_matches(&left, kind))
            .collect();
            Ok(
                json!({"equal":exact::equal(&left,&right),"equal030":exact::values::equal_v030(&left,&right),
                "equalText":exact::equal_texts(string(request,"left"),string(request,"right"))?,
                "left":exact::encode(&left),"right":exact::encode(&right),"decimal":decimal,"compare":comparison,
                "integer":exact::values::integer(&left),"integer030":exact::values::is_integer(&left),
                "uint":exact::values::uint(&left,false),"positiveUint":exact::values::uint(&left,true),"types":types}),
            )
        }
        "access" => {
            let (pointer, key) = (string(request, "pointer"), string(request, "key"));
            if string(request, "action") == "at" {
                return Ok(json!(exact::at(pointer, key)));
            }
            let value = if request["missing"] == true {
                None
            } else {
                Some(exact::decode(string(request, "value"))?)
            };
            Ok(match string(request, "action") {
                "record" => {
                    exact::record(value.as_ref(), pointer)?;
                    json!(exact::encode(value.as_ref().unwrap()))
                }
                "list" => {
                    exact::list(value.as_ref(), pointer)?;
                    json!(exact::encode(value.as_ref().unwrap()))
                }
                "text" => json!(exact::text(value.as_ref(), pointer)?),
                "has" => json!(exact::has(exact::record(value.as_ref(), pointer)?, key)),
                action => panic!("unknown accessor {action}"),
            })
        }
        "integer" => {
            let raw = string(request, "raw");
            let other = string(request, "other");
            Ok(match string(request, "action") {
                "integer" => json!(integers::integer030(
                    raw,
                    request["positive"].as_bool().unwrap()
                )?),
                "compare" => json!(exact::values::ordering_number(
                    integers::compare_integers030(raw, other)?
                )),
                "monotone" => json!(integers::monotone_ms030(raw)?.to_js_string()),
                "bounded" => json!(integers::bounded_integer030(
                    raw,
                    &exact::BigInteger::parse(other).unwrap()
                )?
                .to_js_string()),
                "timer" => json!(integers::timer_delay030(
                    if request["noLimit"] == true {
                        None
                    } else {
                        Some(raw)
                    },
                    &exact::BigInteger::parse(other).unwrap(),
                    request["slice"].as_i64().unwrap()
                )?),
                action => panic!("unknown integer helper {action}"),
            })
        }
        op => panic!("unknown operation {op}"),
    }
}
fn native(request: &Json) -> Json {
    match string(request, "op") {
        "parse" => parse(request),
        "schema" => schema(request),
        _ => evaluate(request).map_or_else(failure, ok),
    }
}

struct Oracle {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    sequence: usize,
}
impl Oracle {
    fn start() -> Self {
        let mut child = crate::core::process::background_tokio_command("bun")
            .arg("dev/agsdl/conformance-host030.ts")
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("Bun is required for the values differential; never skip");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            input,
            output,
            sequence: 0,
        }
    }
    async fn request(&mut self, request: &Json, case: &str) -> Json {
        self.sequence += 1;
        let envelope = json!({"id":self.sequence,"kind":"values","request":request});
        let mut bytes = serde_json::to_vec(&envelope).unwrap();
        bytes.push(b'\n');
        self.input.write_all(&bytes).await.unwrap();
        let received =
            tokio::time::timeout(std::time::Duration::from_secs(30), self.output.next_line()).await;
        let line = match received {
            Ok(Ok(Some(line))) => line,
            other => {
                eprintln!(
                    "ARGENTIC_VALUES_RESOURCE {}",
                    json!({"case":case,"status":"resourceLimit","cause":format!("{other:?}")})
                );
                panic!("values oracle did not reply for {case}: {other:?}");
            }
        };
        let reply: Json = serde_json::from_str(&line).expect("oracle JSON-lines reply");
        assert_eq!(reply["id"], self.sequence, "correlation for {case}");
        assert!(
            reply.get("error").is_none(),
            "oracle failed for {case}: {reply}"
        );
        reply["output"].clone()
    }
    async fn close(mut self) {
        self.input.shutdown().await.unwrap();
        drop(self.input);
        let exit = tokio::time::timeout(std::time::Duration::from_secs(5), self.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(exit.success(), "oracle exit: {exit}");
    }
}

#[tokio::test]
async fn values_differential() {
    let corpus = corpus::build();
    let mut oracle = Oracle::start();
    let mut statuses = BTreeMap::<String, usize>::new();
    let mut in_domain = 0usize;
    let mut manifest = Vec::new();
    for case in &corpus.cases {
        let actual = native(&case.request);
        let expected = oracle.request(&case.request, &case.id).await;
        if expected["status"] == "resourceLimit" {
            eprintln!(
                "ARGENTIC_VALUES_RESOURCE {}",
                json!({"case":case.id,"result":expected})
            );
            panic!(
                "resource limit inside the declared common corpus: {}",
                case.id
            );
        }
        assert_eq!(
            actual, expected,
            "values differential {}\nrequest={}",
            case.id, case.request
        );
        *statuses
            .entry(string(&expected, "status").to_owned())
            .or_default() += 1;
        if expected["output"]["inDomain"] == true {
            in_domain += 1;
        }
        manifest.push(json!({"id":case.id,"family":case.family,"requestSha256":digest(&serde_json::to_vec(&case.request).unwrap()),
            "resultSha256":digest(&serde_json::to_vec(&expected).unwrap())}));
    }
    assert!(
        in_domain >= 100,
        "too few schema helper comparisons: {in_domain}"
    );
    assert!(statuses.get("failure").copied().unwrap_or(0) >= 100);
    assert!(statuses.get("parseError").copied().unwrap_or(0) >= 100);
    let mut probes = Vec::new();
    for mode in ["shared", "experimental", "v030"] {
        for depth in [64, 512, 20_000] {
            let request = json!({"op":"probe","mode":mode,"depth":depth});
            let result = oracle.request(&request, "resource-probe").await;
            assert!(
                result["status"] == "ok" || result["status"] == "resourceLimit",
                "unexpected depth probe: {result}"
            );
            // Probes characterize the oracle only. They never enter semantic
            // match counts and never impose a depth limit on the Rust parser.
            probes.push(json!({"request":request,"result":result}));
        }
    }
    oracle.close().await;
    eprintln!(
        "ARGENTIC_VALUES_MANIFEST {}",
        json!({"version":1,"seed":corpus::SEED,"scope":"D15 2.c.1 values only, not a flow replay",
        "domain":"acyclic JSON, valid NumberToken lexemes; valueSchema published shape including inconsistent schemas; typed key/number/index paths; work integers use string lexemes and bigint operands",
        "commonGeneratedMaxDepth":64,"files":corpus.files,"families":corpus.counts,"minimums":corpus::MINIMUMS,
        "statuses":statuses,"schemaInDomain":in_domain,"cases":manifest,"oracleResourceProbes":probes})
    );
}
