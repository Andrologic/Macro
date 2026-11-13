//! Product admission, real supervisor and TS controllers with controlled agents.
use super::*;
use crate::db::agsdl_execution::{flow030::FlowEffectKind030, flow_store030::FlowView030};

#[derive(Default)]
struct Scripted {
    starts: Mutex<Vec<(Vec<String>, Value)>>,
    failures: BTreeMap<Vec<String>, &'static str>,
    submissions: BTreeMap<Vec<String>, Value>,
}
impl AgentExecutor030 for Scripted {
    fn prepare(
        &self,
        work: PreparedEffectiveAgentWork030,
    ) -> crate::db::agsdl_execution::Result<AttestedWorkPolicy030> {
        AttestedWorkPolicy030::from_codex(work)
    }
    fn run(
        &self,
        work: AgentWork030,
        events: WorkEventSink030,
        cancel: CancellationToken,
    ) -> futures::future::BoxFuture<'static, crate::db::agsdl_execution::Result<()>> {
        let address = work.attempt.work().step.clone().unwrap();
        let FlowEffectKind030::Start { message_json, .. } = &work.effect.kind else {
            unreachable!()
        };
        self.starts.lock().unwrap().push((
            address.clone(),
            serde_json::from_str(message_json.as_deref().unwrap()).unwrap(),
        ));
        let failure = self.failures.get(&address).copied();
        let submission = self
            .submissions
            .get(&address)
            .cloned()
            .unwrap_or(json!({}))
            .to_string();
        Box::pin(async move {
            let event = match failure {
                Some(code) => json!({"kind":"stop","reason":code}),
                None => json!({"kind":"submit","callId":"synthetic","argumentsJson":submission}),
            };
            events.emit(event, &cancel).await?;
            Ok(())
        })
    }
}
async fn run(document: Value, executor: Arc<Scripted>) -> FlowView030 {
    let f = Fixture::with_document(document).await;
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    let executors: Executors030 = Executors030 {
        agents: executor,
        calls: None,
        humans: None,
        clock: None,
    };
    let (_wake, receiver) = watch::channel(0);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        supervise_with_emitter030(
            None,
            &f.host,
            &f.pool,
            &f.config,
            &tasks,
            &f.owner,
            &executors,
            receiver,
            &CancellationToken::new(),
            f.emitter(&tasks),
        ),
    )
    .await;

    result.expect("composition supervisor timed out").unwrap();
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap()
        .flow;
    assert!(view.state.activations.iter().all(|a| !a.physical));
    assert!(view.effects.iter().all(|row| row["status"] == "settled"));
    view
}
fn document() -> Value {
    json!({"contract":"agsdl-0.3.0","id":"nested-product","agents":{"worker":{"harness":"codex","permissions":"read-only"}},
    "compositions":{
        "inner":{"entry":"work","outputs":["done"],"steps":{"work":{"type":"agent","agent":"worker","maxVisits":1,"next":{"output":"done"}}}},
        "outer":{"entry":"inner","outputs":["done"],"steps":{"inner":{"type":"compose","composition":"inner","next":{"done":{"output":"done"}}}}}
    },
    "flow":{"entry":"first","steps":{
        "first":{"type":"compose","composition":"outer","maxVisits":1,"next":{"done":{"step":"second","message":{"prompt":"Second use"}}}},
        "second":{"type":"compose","composition":"outer","maxVisits":1,"next":{"done":"after"}},
        "after":{"type":"agent","agent":"worker"}
    }}})
}
fn failures(view: &FlowView030) -> Vec<(Vec<String>, String)> {
    view.effects
        .iter()
        .filter_map(|row| {
            let effect: crate::db::agsdl_execution::flow030::FlowEffect030 =
                serde_json::from_value(row["effect"].clone()).unwrap();
            match effect.kind {
                FlowEffectKind030::Failure {
                    step: Some(step),
                    error,
                    ..
                } => Some((step, error.code)),
                _ => None,
            }
        })
        .collect()
}
#[tokio::test]
async fn nested_direct_outputs_keep_actual_owner_and_separate_reused_addresses() {
    let executor = Arc::new(Scripted::default());
    let view = run(document(), executor.clone()).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    let starts = executor.starts.lock().unwrap();
    assert_eq!(
        starts.iter().map(|(s, _)| s.join("/")).collect::<Vec<_>>(),
        ["first/inner/work", "second/inner/work", "after"]
    );
    assert_eq!(starts[0].1["prompt"], "Start");
    assert_eq!(starts[1].1["prompt"], "Second use");
    for step in [
        vec!["first".into()],
        vec!["first".into(), "inner".into()],
        vec!["first".into(), "inner".into(), "work".into()],
        vec!["second".into(), "inner".into(), "work".into()],
    ] {
        assert_eq!(view.state.visits_at(&step), "1");
    }
    assert!(failures(&view).is_empty());
}
#[tokio::test]
async fn nested_failure_prefers_the_inner_handler_over_flow_default() {
    let mut doc = document();
    doc["compositions"]["outer"]["steps"]["inner"]["onError"] = json!({"output":"done"});
    doc["flow"]["onError"] = json!("handler");
    doc["flow"]["steps"]["handler"] = json!({"type":"agent","agent":"worker"});
    let executor = Arc::new(Scripted {
        failures: BTreeMap::from([(
            vec!["first".into(), "inner".into(), "work".into()],
            "AGENT_FAILED",
        )]),
        ..Default::default()
    });
    let view = run(doc, executor.clone()).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(view.state.visits_at(&vec!["handler".into()]), "0");
    assert_eq!(failures(&view).len(), 2);
}
#[tokio::test]
async fn body_visit_limit_fails_before_another_start_and_handler_does_not_loop() {
    let mut doc = document();
    doc["compositions"]["inner"]["steps"]["work"]["next"] = json!("work");
    doc["compositions"]["inner"]["steps"]["work"]["prompt"] = json!("Repeat");
    doc["compositions"]["inner"]["steps"]["work"]["onError"] = json!({"output":"done"});
    doc["flow"]["onError"] = json!("handler");
    doc["flow"]["steps"]["handler"] = json!({"type":"agent","agent":"worker"});
    let executor = Arc::new(Scripted::default());
    let view = run(doc, executor.clone()).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(executor.starts.lock().unwrap().len(), 3);
    assert_eq!(
        failures(&view)
            .iter()
            .filter(|(_, code)| code == "VISIT_LIMIT")
            .count(),
        2
    );
}
#[tokio::test]
async fn flow_handler_failure_ends_once_without_inheriting_itself() {
    let mut doc = document();
    doc["flow"] = json!({"entry":"work","onError":"handler","steps":{
        "work":{"type":"agent","agent":"worker"},"handler":{"type":"agent","agent":"worker","maxVisits":1}
    }});
    let executor = Arc::new(Scripted {
        failures: BTreeMap::from([
            (vec!["work".into()], "AGENT_FAILED"),
            (vec!["handler".into()], "AGENT_FAILED"),
        ]),
        ..Default::default()
    });
    let view = run(doc, executor.clone()).await;
    assert_eq!(view.state.verdict.as_deref(), Some("failed"));
    assert_eq!(executor.starts.lock().unwrap().len(), 2);
    assert_eq!(failures(&view).len(), 2);
}

#[tokio::test]
async fn body_and_wrapper_limits_are_per_run_and_handler_limit_terminates_the_loop() {
    let mut doc = document();
    doc["compositions"]["inner"]["steps"]["work"]["prompt"] = json!("Repeat");
    doc["compositions"]["inner"]["steps"]["work"]["next"] =
        json!({"again":"work","done":{"output":"done"}});
    doc["flow"] = json!({"entry":"first","onError":"handler","steps":{
        "first":{"type":"compose","composition":"outer","maxVisits":1,"next":{"done":[]}},
        "handler":{"type":"agent","agent":"worker","maxVisits":1,"next":"first"}
    }});
    let executor = Arc::new(Scripted {
        submissions: BTreeMap::from([(
            vec!["first".into(), "inner".into(), "work".into()],
            json!({"choice":"again"}),
        )]),
        ..Default::default()
    });
    let view = run(doc, executor.clone()).await;
    assert_eq!(view.state.verdict.as_deref(), Some("failed"));
    assert_eq!(executor.starts.lock().unwrap().len(), 2);
    for step in [
        vec!["first".into()],
        vec!["first".into(), "inner".into()],
        vec!["first".into(), "inner".into(), "work".into()],
        vec!["handler".into()],
    ] {
        assert_eq!(view.state.visits_at(&step), "1");
    }
    assert_eq!(
        failures(&view)
            .iter()
            .map(|(s, _)| s.join("/"))
            .collect::<Vec<_>>(),
        [
            "first/inner/work",
            "first/inner",
            "first",
            "first",
            "handler"
        ]
    );
    assert!(failures(&view)
        .iter()
        .all(|(_, code)| code == "VISIT_LIMIT"));
}
#[tokio::test]
async fn preparation_and_join_failures_bubble_through_nested_bodies() {
    for preparation in [true, false] {
        let mut doc = document();
        doc["agents"]["worker"]["results"] =
            json!({"items":{"schema":{"type":"array","items":{"type":"integer"}}}});
        doc["compositions"]["inner"]["entry"] = json!("spread");
        doc["compositions"]["inner"]["steps"] = json!({
            "spread":{"type":"agent","agent":"worker","next": if preparation {json!({"step":"left","each":["results","items"],"max":1})} else {json!(["left","right"]) }},
            "left":{"type":"agent","agent":"worker","instance":"new","next":"join"},
            "join":{"type":"join","remaining":"finish","next":{"output":"done"}}
        });
        if !preparation {
            doc["compositions"]["inner"]["steps"]["right"] =
                json!({"type":"agent","agent":"worker","instance":"new","next":"join"});
        }
        doc["flow"] = json!({"entry":"first","onError":"handler","steps":{
            "first":{"type":"compose","composition":"outer","next":{"done":[]}},"handler":{"type":"agent","agent":"worker"}
        }});
        let executor = Arc::new(Scripted {
            submissions: BTreeMap::from([(
                vec!["first".into(), "inner".into(), "spread".into()],
                json!({"results":{"items":[1,2]}}),
            )]),
            failures: if preparation {
                BTreeMap::new()
            } else {
                BTreeMap::from([(
                    vec!["first".into(), "inner".into(), "left".into()],
                    "AGENT_FAILED",
                )])
            },
            ..Default::default()
        });
        let view = run(doc, executor.clone()).await;
        assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
        let expected = if preparation {
            "FANOUT_LIMIT"
        } else {
            "BRANCH_FAILED"
        };
        let failures = failures(&view);
        for name in ["first/inner/join", "first/inner", "first"] {
            assert!(
                failures
                    .iter()
                    .any(|(s, code)| s.join("/") == name && code == expected),
                "{failures:?}"
            );
        }
        assert_eq!(view.state.visits_at(&vec!["handler".into()]), "1");
        if preparation {
            assert_eq!(executor.starts.lock().unwrap().len(), 2);
        }
    }
}

#[tokio::test]
async fn unhandled_composition_failure_reaches_its_outer_join_before_flow_handler() {
    let mut doc = document();
    doc["flow"] = json!({"entry":"spread","onError":"global","steps":{
        "spread":{"type":"agent","agent":"worker","next":["first","right"]},
        "first":{"type":"compose","composition":"outer","next":{"done":"join"}},
        "right":{"type":"agent","agent":"worker","instance":"new","next":"join"},
        "join":{"type":"join","remaining":"finish","onError":"local","next":[]},
        "local":{"type":"agent","agent":"worker"},"global":{"type":"agent","agent":"worker"}
    }});
    let executor = Arc::new(Scripted {
        failures: BTreeMap::from([(
            vec!["first".into(), "inner".into(), "work".into()],
            "AGENT_FAILED",
        )]),
        ..Default::default()
    });
    let view = run(doc, executor).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(view.state.visits_at(&vec!["global".into()]), "0");
    assert_eq!(view.state.visits_at(&vec!["local".into()]), "1");
    assert!(failures(&view).contains(&(vec!["join".into()], "BRANCH_FAILED".into())));
}
