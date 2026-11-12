//! Direct TS/Rust differential. Process IO stays in the host's test module.
//! Serialized DTOs, exact messages and capture-call order compare byte for byte.
use crate::argentic_core::{
    error::Failure,
    exact::{self, Value},
    messages::{self, CapturedContent, CapturedSource},
    route::{self, ItemContext, ResultMetadata, RouteSource, RouteTarget, Scope},
};
use crate::argentic_values_conformance030_tests::Oracle;
use serde::Serialize;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::time::Duration;
mod corpus;
fn s<'a>(request: &'a Json, key: &str) -> &'a str {
    request[key].as_str().unwrap()
}
fn stringify(value: &impl Serialize) -> String {
    serde_json::to_string(value).unwrap()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Serialize)]
struct Context {
    usage: String,
    pointer: String,
}
#[derive(Default)]
struct Captures {
    entries: Vec<(String, String)>,
    calls: Vec<(String, Context)>,
}
impl CapturedSource for Captures {
    fn resolve_source(&mut self, raw: &str, usage: &str, pointer: &str) -> Result<String, Failure> {
        self.calls.push((
            raw.to_owned(),
            Context {
                usage: usage.to_owned(),
                pointer: pointer.to_owned(),
            },
        ));
        self.entries
            .iter()
            .find(|(source, _)| source == raw)
            .map(|(_, value)| value.clone())
            .ok_or_else(|| {
                Failure::new(
                    "CONTENT_UNAVAILABLE",
                    pointer,
                    "No matching captured source.",
                )
            })
    }
}
fn evaluate(request: &Json, captures: &mut Captures) -> Result<String, Failure> {
    let scopes: Vec<Scope> = serde_json::from_str(&stringify(
        &request.get("scopes").cloned().unwrap_or(json!([])),
    ))
    .unwrap();
    let scope = request
        .get("scope")
        .map_or(Some(0), |v| v.as_u64().map(|v| v as usize));
    let targets = || route::normalize_route(s(request, "route"), &scopes[scope.unwrap()]);
    let source = || serde_json::from_str::<RouteSource>(&stringify(&request["source"])).unwrap();
    let item = || serde_json::from_str::<ItemContext>(&stringify(&request["item"])).unwrap();
    Ok(match s(request, "op") {
        "normalize" => stringify(&targets()?),
        "expand" => stringify(&route::preflight_expansion(&targets()?, &source())?),
        "expect" => stringify(&route::instructions_expectation(
            s(request, "agent"),
            s(request, "route"),
            &scopes,
            scope,
        )?),
        "path" => stringify(&exact::encode(&messages::read_path(
            &exact::decode(s(request, "value"))?,
            &exact::decode(s(request, "path"))?,
        )?)),
        "select" => {
            let metadata: Vec<ResultMetadata> = serde_json::from_str(&stringify(
                &request.get("metadata").cloned().unwrap_or(json!([])),
            ))
            .unwrap();
            stringify(&messages::select_value(
                s(request, "value"),
                s(request, "path"),
                &item(),
                &metadata,
            )?)
        }
        "authority" => stringify(&messages::instruction_authority(
            &source(),
            s(request, "path"),
        )?),
        "message" => {
            let target: RouteTarget = if let Some(target) = request.get("target") {
                serde_json::from_str(&stringify(target)).unwrap()
            } else {
                targets()?.remove(0)
            };
            let mut content = CapturedContent {
                defer_prompt_uris: request.pointer("/content/deferPromptUris")
                    == Some(&Json::Bool(true)),
                resolve_source: None,
            };
            if request.pointer("/content/entries").is_some() {
                content.resolve_source = Some(captures);
            }
            stringify(&messages::resolve_route_message(
                s(request, "document"),
                &target,
                &source(),
                &item(),
                &mut content,
            )?)
        }
        "construct" => {
            let mut object = exact::Object::from_entries(
                request["entries"].as_array().unwrap().iter().map(|entry| {
                    (
                        entry[0].as_str().unwrap().to_owned(),
                        exact::decode(entry[1].as_str().unwrap()).unwrap(),
                    )
                }),
            );
            for entry in request
                .get("updates")
                .and_then(Json::as_array)
                .into_iter()
                .flatten()
            {
                object.set(
                    entry[0].as_str().unwrap().to_owned(),
                    exact::decode(entry[1].as_str().unwrap())?,
                );
            }
            stringify(&exact::encode(&Value::Object(object)))
        }
        op => panic!("unknown op {op}"),
    })
}
fn native(request: &Json) -> Json {
    let mut captures = Captures::default();
    if let Some(entries) = request.pointer("/content/entries").and_then(Json::as_array) {
        captures.entries = entries
            .iter()
            .map(|entry| {
                (
                    s(entry, "sourceJson").to_owned(),
                    s(entry, "capturedJson").to_owned(),
                )
            })
            .collect();
    }
    let output = evaluate(request, &mut captures);
    let calls = stringify(&captures.calls);
    match output {
        Ok(output) => json!({"status":"ok","json":output,"callsJson":calls}),
        Err(error) => {
            json!({"status":"failure","code":error.code,"pointer":error.pointer,"message":error.message,"callsJson":calls})
        }
    }
}
#[tokio::test]
async fn routes_differential() {
    let corpus = corpus::build();
    let mut oracle = Oracle::start();
    let mut manifest = Vec::new();
    let mut statuses = std::collections::BTreeMap::<String, usize>::new();
    for case in &corpus.cases {
        let expected = oracle
            .request_kind(
                "routes",
                &case.request,
                &case.id,
                Duration::from_secs(30),
                "ARGENTIC_ROUTES_RESOURCE",
            )
            .await;
        assert!(
            !["resourceLimit", "exception"].contains(&expected["status"].as_str().unwrap()),
            "oracle outside comparable domain {}: {expected}",
            case.id
        );
        let actual = native(&case.request);
        assert_eq!(actual, expected, "{} input {}", case.id, case.request);
        *statuses.entry(s(&actual, "status").to_owned()).or_default() += 1;
        manifest.push(json!({"id":case.id,"family":case.family,"requestSha256":hash(stringify(&case.request).as_bytes()),"outputSha256":hash(stringify(&actual).as_bytes())}));
    }
    oracle.close().await;
    assert!(statuses.get("ok").copied().unwrap_or(0) > 500);
    assert!(statuses.get("failure").copied().unwrap_or(0) > 100);
    eprintln!(
        "ARGENTIC_ROUTES_MANIFEST {}",
        json!({"base":"f1567018c8b633312bdf9934b25c56ed6a515298","seed":corpus::SEED,"files":corpus.files,"families":corpus.counts,"minimums":corpus::MINIMUMS,"statuses":statuses,"cases":manifest})
    );
}
#[test]
fn object_construction_retains_tokens_and_js_assignment_order() {
    let request = json!({"op":"construct","entries":[["b","1.0"],["2","-0"],["1","1e400"],["b","9007199254740993"]],"updates":[["2","2.0"],["a","null"]]});
    assert_eq!(
        native(&request)["json"],
        json!(r#""{\"1\":1e400,\"2\":2.0,\"b\":9007199254740993,\"a\":null}""#)
    );
    assert!(exact::NumberToken::lexeme("NaN").is_none());
    assert!(exact::NumberToken::lexeme("1.0").is_some());
}
