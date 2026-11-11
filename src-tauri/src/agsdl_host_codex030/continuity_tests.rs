//! Full dispatch, native admission, Codex adapter and production controller.
//! Only the observed installation and JSON-RPC peer are synthetic.
use super::*;
use crate::agsdl_host_codex030::{protocol_tests::SERVER, CodexExecutor030};
use std::{os::unix::fs::PermissionsExt, path::Path};

fn envelope(submission: Value) -> Value {
    json!({"text":"Completed work", "submissionJson":submission.to_string()})
}

fn requests(trace: &Path, method: &str) -> Vec<Value> {
    std::fs::read_to_string(trace)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|request| request["method"] == method)
        .map(|request| request["params"].clone())
        .collect()
}

#[tokio::test]
async fn codex_run_end_releases_references_after_failure_and_stop() {
    for stop in [false, true] {
        let document = json!({"contract":"agsdl-0.3.0","id":"run-end","agents":{
            "worker":{"harness":"codex","permissions":"read-only","maxCorrections":0}},
            "flow":{"entry":"work","steps":{"work":{"type":"agent","agent":"worker"}}}});
        let f = Fixture::with_document(document).await;
        let trace_root = tempfile::tempdir().unwrap();
        let trace = trace_root.path().join("requests.jsonl");
        let script = vec![if stop {
            Value::Null
        } else {
            envelope(json!({"instructions":"UNAUTHORIZED"}))
        }];
        std::fs::write(
            trace.with_extension("jsonl.script"),
            serde_json::to_vec(&script).unwrap(),
        )
        .unwrap();
        let executor = executor(&f, &trace, None);
        let references = executor.test_thread_references();
        let stopper = async {
            if stop {
                tokio::time::timeout(std::time::Duration::from_secs(15), async {
                    while requests(&trace, "turn/start").is_empty() {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("Codex work did not start");
                stop_fixture(&f, "stop-codex-continuity").await;
            }
        };
        let (view, ()) = tokio::join!(run(&f, Arc::new(executor)), stopper);
        assert_eq!(
            view.state.verdict.as_deref(),
            Some(if stop { "cancelled" } else { "failed" })
        );
        assert!(references.upgrade().is_none());
        if stop {
            assert_eq!(requests(&trace, "turn/interrupt").len(), 1);
        }
    }
}

fn executor(f: &Fixture, trace: &Path, previous: Option<&CodexExecutor030>) -> CodexExecutor030 {
    let root = f._temp.path().canonicalize().unwrap();
    let profile = crate::agsdl_host_codex::profile::Profile {
        executable: root.join("fake-codex"),
        directory: root.join("profile"),
        home: root.join("profile/home"),
        bootstrap: root.join("bootstrap"),
        digest: "synthetic-profile".into(),
    };
    std::fs::create_dir_all(&profile.bootstrap).unwrap();
    let settings = profile.settings(&root.join("workspace"), true).unwrap();
    // Reuse the existing protocol peer, including config/layer verification.
    let script = format!(
        "#!/usr/bin/env python3\nimport sys\nsys.argv=['fake', {}, {}, 'continuity', {}]\n{SERVER}",
        serde_json::to_string(&settings.to_string()).unwrap(),
        serde_json::to_string(&profile.bootstrap).unwrap(),
        serde_json::to_string(trace).unwrap(),
    );
    std::fs::write(&profile.executable, script).unwrap();
    std::fs::set_permissions(&profile.executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut executor = previous
        .cloned()
        .unwrap_or_else(|| CodexExecutor030::new(f.config.clone()));
    executor.test_profile = Some(profile);
    executor
}

async fn run(
    f: &Fixture,
    executor: Arc<CodexExecutor030>,
) -> crate::db::agsdl_execution::flow_store030::FlowView030 {
    let capture = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap()
        .capture;
    assert!(crate::agsdl_host_capture::product_slice030(
        &capture.authored_source,
        Some(&capture.compiled_plan_json),
    )
    .is_none());
    let pumps = f.pumps();
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    let executors: Executors030 = Executors030 {
        agents: executor,
        calls: None,
        humans: None,
        clock: None,
    };
    let (_wake, receiver) = watch::channel(0);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
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
    for pump in pumps {
        pump.abort();
        assert!(pump.await.unwrap_err().is_cancelled());
    }
    result.expect("Codex supervisor timed out").unwrap();
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap()
        .flow;
    assert!(view.state.activations.iter().all(|work| !work.physical));
    view
}

fn assert_policy(params: &Value) {
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["permissions"], "macro-agsdl");
}

#[tokio::test]
async fn codex_shared_named_new_and_runs_use_the_reducer_instances() {
    let document = json!({"contract":"agsdl-0.3.0","id":"continuity", "agents":{
        "worker":{"harness":"codex","permissions":"read-only","instructions":"PERMANENT_WORKER", "resources":{"note":{"value":"UNTRUSTED_WORKER_DATA"}}},
        "other":{"harness":"codex","permissions":"read-only","instructions":"PERMANENT_OTHER"}
    },"flow":{"entry":"shared","steps":{
        "shared":{"type":"agent","agent":"worker","prompt":"FIRST_MISSION","next":{"first":"a1"}},
        "a1":{"type":"agent","agent":"worker","instance":"alpha","prompt":"ALPHA_ONE","next":"b"},
        "b":{"type":"agent","agent":"worker","instance":"beta","prompt":"BETA","next":"a2"},
        "a2":{"type":"agent","agent":"worker","instance":"alpha","prompt":"ALPHA_TWO","next":"other"},
        "other":{"type":"agent","agent":"other","instance":"alpha","prompt":"OTHER_ALPHA","next":"new1"},
        "new1":{"type":"agent","agent":"worker","instance":"new","prompt":"NEW_ONE","next":"new2"},
        "new2":{"type":"agent","agent":"worker","instance":"new","prompt":"NEW_TWO","next":"sharedEnd"},
        "sharedEnd":{"type":"agent","agent":"worker","next":{"last":[]}}
    }}});
    let f = Fixture::with_document_in_run(document.clone(), "run-one").await;
    let trace_root = tempfile::tempdir().unwrap();
    let trace = trace_root.path().join("requests.jsonl");
    let script = vec![
        envelope(json!({"choice":"first"})),
        envelope(json!({})),
        envelope(json!({})),
        envelope(json!({})),
        envelope(json!({})),
        envelope(json!({})),
        envelope(json!({})),
        envelope(json!({"choice":"last"})),
        envelope(json!({})),
    ];
    std::fs::write(
        trace.with_extension("jsonl.script"),
        serde_json::to_vec(&script).unwrap(),
    )
    .unwrap();
    let first = executor(&f, &trace, None);
    let references = first.test_thread_references();
    let view = run(&f, Arc::new(first.clone())).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    let starts = requests(&trace, "thread/start");
    let resumes = requests(&trace, "thread/resume");
    let updates = requests(&trace, "thread/inject_items");
    let turns = requests(&trace, "turn/start");
    assert_eq!((starts.len(), resumes.len(), turns.len()), (6, 2, 8));
    assert_eq!(updates.len(), 2);
    assert_eq!(updates[1]["threadId"], turns[0]["threadId"]);
    let current = updates[1]["items"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(current.contains("\"choices\":[\"last\"]"));
    assert!(!current.contains("\"first\""));
    let threads: Vec<_> = turns.iter().map(|turn| turn["threadId"].clone()).collect();
    assert_eq!(threads[1], threads[3], "same named instance must resume");
    assert_eq!(threads[0], threads[7], "shared instance must resume");
    let distinct: std::collections::BTreeSet<_> = [0, 1, 2, 4, 5, 6]
        .map(|i| threads[i].as_str().unwrap())
        .into_iter()
        .collect();
    assert_eq!(
        distinct.len(),
        6,
        "names, definitions and new works must be isolated"
    );
    assert!(resumes[1]["developerInstructions"]
        .as_str()
        .unwrap()
        .contains("\"choices\":[\"last\"]"));
    assert!(!resumes[1]["developerInstructions"]
        .as_str()
        .unwrap()
        .contains("\"first\""));
    assert_eq!(resumes[1]["threadId"], threads[0]);
    assert!(!turns[7]["input"].to_string().contains("FIRST_MISSION"));
    assert!(!turns[7]["input"].to_string().contains("Start"));
    for params in starts.iter().chain(&resumes) {
        assert_policy(params);
        assert!(!params["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("UNTRUSTED_WORKER_DATA"));
    }
    for (index, turn) in turns.iter().enumerate() {
        assert_policy(turn);
        assert!(!turn["input"].to_string().contains("UNTRUSTED_WORKER_DATA"));
        if index != 4 {
            assert!(turn["additionalContext"]
                .as_object()
                .unwrap()
                .values()
                .any(|entry| entry["kind"] == "untrusted"
                    && entry["value"]
                        .as_str()
                        .unwrap()
                        .contains("UNTRUSTED_WORKER_DATA")));
        }
    }
    // Deliberately retain the same map across two supervisors: the run key must
    // still prevent reuse even if a caller holds an executor clone longer.
    let second_doc = json!({"contract":"agsdl-0.3.0","id":"next-run","agents":document["agents"],
        "flow":{"entry":"work","steps":{"work":{"type":"agent","agent":"worker","prompt":"NEXT_RUN"}}}});
    let second_f = Fixture::with_document_in_run(second_doc, "run-two").await;
    let second = executor(&second_f, &trace, Some(&first));
    assert_eq!(
        run(&second_f, Arc::new(second.clone()))
            .await
            .state
            .verdict
            .as_deref(),
        Some("succeeded")
    );
    let all_turns = requests(&trace, "turn/start");
    assert!(threads
        .iter()
        .all(|thread| thread != &all_turns[8]["threadId"]));
    drop(second);
    drop(first);
    assert!(
        references.upgrade().is_none(),
        "completed work must not retain conversation references"
    );
}

#[tokio::test]
async fn codex_authorized_missions_keep_permanent_instructions_permissions_and_data_separate() {
    let document = json!({"contract":"agsdl-0.3.0","id":"missions","agents":{
        "lead":{"harness":"codex","permissions":"read-only","instructs":true,"instructions":"PERMANENT_LEAD"},
        "worker":{"harness":"codex","permissions":"read-only","instructions":"PERMANENT_WORKER"}
    },"flow":{"entry":"lead","steps":{
        "lead":{"type":"agent","agent":"lead","prompt":"LEAD_FALLBACK","maxVisits":4,"next":{
            "default":"work",
            "explicit":{"step":"work","message":{"prompt":"EXPLICIT_MISSION"}},
            "data":{"step":"work","message":{"resources":{"note":{"from":["instructions"]}}}},
            "done":[]}},
        "work":{"type":"agent","agent":"worker","prompt":"WORKER_FALLBACK","next":"lead"}
    }}});
    let f = Fixture::with_document(document).await;
    let trace_root = tempfile::tempdir().unwrap();
    let trace = trace_root.path().join("requests.jsonl");
    let script = vec![
        envelope(json!({"choice":"default","instructions":"AUTHORIZED_MISSION"})),
        envelope(json!({"instructions":"UNAUTHORIZED_MISSION"})),
        envelope(json!({})),
        envelope(json!({"choice":"explicit","instructions":"OVERRIDDEN_MISSION"})),
        envelope(json!({})),
        envelope(json!({"choice":"data","instructions":"DATA_ONLY_MISSION"})),
        envelope(json!({})),
        envelope(json!({"choice":"done"})),
    ];
    std::fs::write(
        trace.with_extension("jsonl.script"),
        serde_json::to_vec(&script).unwrap(),
    )
    .unwrap();
    let executor = executor(&f, &trace, None);
    let references = executor.test_thread_references();
    let view = run(&f, Arc::new(executor)).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(
        view.state
            .activations
            .iter()
            .filter(|work| work.agent.is_some())
            .count(),
        7
    );
    let turns = requests(&trace, "turn/start");
    assert_eq!(
        turns.len(),
        8,
        "unauthorized instructions require correction in the same work"
    );
    assert_eq!(turns[1]["threadId"], turns[2]["threadId"]);
    assert!(turns[2]["input"].to_string().contains("INSTRUCTS"));
    assert!(turns[1]["input"].to_string().contains("AUTHORIZED_MISSION"));
    assert!(turns[4]["input"].to_string().contains("EXPLICIT_MISSION"));
    assert!(!turns[4]["input"].to_string().contains("OVERRIDDEN_MISSION"));
    assert!(turns[6]["input"].to_string().contains("WORKER_FALLBACK"));
    assert!(!turns[6]["input"].to_string().contains("DATA_ONLY_MISSION"));
    assert!(turns[6]["additionalContext"]
        .as_object()
        .unwrap()
        .values()
        .any(|entry| entry["kind"] == "untrusted"
            && entry["value"]
                .as_str()
                .unwrap()
                .contains("DATA_ONLY_MISSION")));
    for method in ["thread/start", "thread/resume"] {
        for params in requests(&trace, method) {
            assert_policy(&params);
            let instructions = params["developerInstructions"].as_str().unwrap();
            assert!(instructions.contains("PERMANENT_"));
            for mission in [
                "AUTHORIZED_MISSION",
                "UNAUTHORIZED_MISSION",
                "OVERRIDDEN_MISSION",
                "DATA_ONLY_MISSION",
                "EXPLICIT_MISSION",
            ] {
                assert!(!instructions.contains(mission));
            }
        }
    }
    for update in requests(&trace, "thread/inject_items") {
        assert_eq!(update["items"][0]["role"], "developer");
        let instructions = update["items"][0]["content"][0]["text"].as_str().unwrap();
        assert!(instructions.contains("PERMANENT_"));
        for mission in [
            "AUTHORIZED_MISSION",
            "UNAUTHORIZED_MISSION",
            "OVERRIDDEN_MISSION",
            "DATA_ONLY_MISSION",
            "EXPLICIT_MISSION",
        ] {
            assert!(!instructions.contains(mission));
        }
    }
    assert!(references.upgrade().is_none());
    assert!(!view.state.activations.iter().any(|work| work
        .message_json
        .as_deref()
        .is_some_and(|message| message.contains("UNAUTHORIZED_MISSION"))));
}
