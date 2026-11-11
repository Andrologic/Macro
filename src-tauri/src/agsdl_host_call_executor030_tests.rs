//! Production call adapter, real confined children, native supervisor and TS ports.
use super::*;

async fn host_fixture(
    document: Value,
) -> (
    Fixture,
    Arc<tokio::sync::Mutex<BunHost>>,
    tokio::task::JoinHandle<()>,
    crate::ai::stream_tasks::StreamTasks,
) {
    let bun = Arc::new(tokio::sync::Mutex::new(BunHost::start()));
    let f = Fixture::new(
        &json!({"document":document,"timeline":[]}).to_string(),
        &mut *bun.lock().await,
    )
    .await;
    let (wake, _) = watch::channel(0);
    let pump = f.pump(bun.clone(), wake);
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    let host = f.app.state::<HostState>();
    host.flow030()
        .supervisors
        .reserve(&f.owner.system_start_id)
        .unwrap();
    spawn_supervisor030(
        f.app.handle().clone(),
        f.pool.clone(),
        f.config.clone(),
        tasks.clone(),
        f.owner.clone(),
        Executors030 {
            agents: Arc::new(Executor {
                plans: Default::default(),
                running: Arc::new(Mutex::new(Vec::new())),
                wake: watch::channel(0).0,
            }),
            calls: Some(Arc::new(
                crate::agsdl_host_call_executor030::CallExecutor030 {
                    config: f.config.clone(),
                    pool: f.pool.clone(),
                    tasks: tasks.clone(),
                    owner: f.owner.clone(),
                    transport: Arc::new(
                        crate::agsdl_host_call_executor030::NativeCallTransport030 {
                            humans: Some(Arc::new(
                                crate::agsdl_host_human_executor030::CallHumans030 {
                                    app: f.app.handle().clone(),
                                    pool: f.pool.clone(),
                                    identity: f.identity.clone(),
                                },
                            )),
                        },
                    ),
                },
            )),
            humans: Some(Arc::new(
                crate::agsdl_host_human_executor030::HumanExecutor030 {
                    pool: f.pool.clone(),
                    tasks: tasks.clone(),
                },
            )),
            clock: Some(Arc::new(
                crate::agsdl_host_human_executor030::HumanClockRuntime030 {
                    app: f.app.handle().clone(),
                    pool: f.pool.clone(),
                    tasks: tasks.clone(),
                    identity: f.identity.clone(),
                },
            )),
        },
    )
    .unwrap();
    drop(host);
    (f, bun, pump, tasks)
}
async fn finish(
    f: &Fixture,
    bun: Arc<tokio::sync::Mutex<BunHost>>,
    pump: tokio::task::JoinHandle<()>,
) -> crate::db::agsdl_execution::flow_store030::FlowView030 {
    let host = f.app.state::<HostState>();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(25),
        host.flow030().supervisors.wait(&f.owner.system_start_id),
    )
    .await;
    if result.is_err() {
        host.flow030().supervisors.cancel(&f.owner.system_start_id);
    }
    let cleanup = host
        .flow030()
        .supervisors
        .wait(&f.owner.system_start_id)
        .await;
    pump.abort();
    let _ = pump.await;
    Arc::try_unwrap(bun)
        .ok()
        .unwrap()
        .into_inner()
        .close()
        .await;
    assert!(result.is_ok(), "Native call did not terminate");
    cleanup.unwrap();
    let view = flow::inspect_run(host.flow030(), &host, &f.pool, &f.owner)
        .await
        .unwrap()
        .flow;
    assert!(view.state.activations.iter().all(|a| !a.physical));
    let page = crate::agsdl_host_projection030::read(
        &host,
        &f.pool,
        crate::agsdl_host_projection030::RuntimeProjectionQuery030 {
            system_start_id: f.owner.system_start_id.clone(),
            source: serde_json::from_value(f.plan.source.clone()).unwrap(),
            snapshot_id: Some(f.identity.snapshot_id.clone()),
        },
        None,
    )
    .await
    .unwrap();
    for item in page.items {
        if let crate::agsdl_host_projection030::RuntimeProjectionItem030::Activation { value } =
            item
        {
            let activation = view
                .state
                .activations
                .iter()
                .find(|a| a.id == value.id)
                .unwrap();
            assert_eq!(
                value.call_result_json,
                activation
                    .result
                    .as_ref()
                    .map(|r| serde_json::to_string(r).unwrap())
            );
        }
    }
    f.pool.close().await;
    view
}
fn document(step: Value) -> Value {
    json!({"contract":"agsdl-0.3.0","id":"native-calls","agents":{},"flow":{"entry":"check","steps":{"check":step}}})
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
async fn native_commands_normalize_and_route_without_git_or_agents() {
    for (step, expected) in [
        (
            json!({"type":"call","command":"printf '{\"n\":9007199254740993}'; printf diagnostic >&2; exit 7","parse":"json","next":{"passed":[],"failed":[]}}),
            json!({"outcome":"failed","data":{"exitCode":7,"output":"{\"n\":9007199254740993}diagnostic","value":{"n":9007199254740993u64}}}),
        ),
        (
            json!({"type":"call","command":"printf 'a\\n\\nb\\r\\n'","parse":"lines"}),
            json!({"outcome":"passed","data":{"exitCode":0,"output":"a\n\nb\r\n","value":["a","b"]}}),
        ),
    ] {
        let (f, bun, pump, _) = host_fixture(document(step)).await;
        assert!(!f._temp.path().join("workspace/.git").exists());
        let view = finish(&f, bun, pump).await;
        assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
        let output: Value = serde_json::from_str(
            serde_json::to_value(&view.state.activations[0].result).unwrap()["outputJson"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(output, expected);
    }
    let mut doc = document(
        json!({"type":"call","command":"printf invalid; exit 3","parse":"json","onError":"recover"}),
    );
    doc["flow"]["steps"]["recover"] = json!({"type":"call","command":"printf recovered"});
    let (f, bun, pump, _) = host_fixture(doc).await;
    let view = finish(&f, bun, pump).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert!(
        matches!(&view.state.activations[0].result, Some(WorkResultRecord030::Failed { error }) if error.code == "OUTPUT_INVALID")
    );
    assert_eq!(view.state.activations.len(), 2);
    let mut doc = document(
        json!({"type":"call","command":"printf '\\377'","parse":"json","onError":"recover"}),
    );
    doc["flow"]["steps"]["recover"] = json!({"type":"call","command":"true"});
    let (f, bun, pump, _) = host_fixture(doc).await;
    let view = finish(&f, bun, pump).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert!(
        matches!(&view.state.activations[0].result, Some(WorkResultRecord030::Failed { error }) if error.code == "OUTPUT_INVALID")
    );
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
async fn native_call_stop_joins_real_child_and_never_starts_successor() {
    let doc = document(
        json!({"type":"call","command":"sleep 120 & printf '%s %s' \"$$\" \"$!\" > pids; wait","next":"after","onError":"after"}),
    );
    stop_and_assert(doc).await;
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
async fn native_mcp_stop_joins_real_server_and_child() {
    let server = r#"while IFS= read -r line; do case "$line" in *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}' ;; *'"method":"tools/call"'*) sleep 120 & printf '%s %s' "$$" "$!" > pids; wait ;; esac; done"#;
    let mut doc = document(
        json!({"type":"call","mcp":{"server":"local","tool":"check"},"next":"after","onError":"after"}),
    );
    doc["mcpServers"] = json!({"local":{"command":["/bin/sh","-c",server]}});
    stop_and_assert(doc).await;
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
async fn stop_and_assert(mut doc: Value) {
    doc["flow"]["steps"]["after"] = json!({"type":"call","command":"printf forbidden > successor"});
    let (f, bun, pump, tasks) = host_fixture(doc).await;
    let path = f._temp.path().join("workspace/pids");
    let observed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                let pids = raw
                    .split_whitespace()
                    .map(|p| p.parse::<i32>().unwrap())
                    .collect::<Vec<_>>();
                if pids.len() == 2 {
                    return pids;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    let host = f.app.state::<HostState>();
    crate::agsdl_host_stop030::request(
        host.flow030(),
        &f.pool,
        &tasks,
        &crate::db::agsdl_execution::dto::EngineStopRequest {
            system_start_id: f.owner.system_start_id.clone(),
            request_id: "stop-command".into(),
            activation_id: None,
        },
    )
    .await
    .unwrap();
    drop(host);
    let pids = observed.expect("Confined command did not start");
    let view = finish(&f, bun, pump).await;
    assert_eq!(view.state.verdict.as_deref(), Some("cancelled"));
    assert_eq!(view.state.activations.len(), 1);
    assert!(!f._temp.path().join("workspace/successor").exists());
    for pid in pids {
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "Child {pid} survived Stop"
        );
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
async fn native_stdio_mcp_preserves_structured_error_result_and_operands() {
    // The server checks the exact argument bytes before replying, like a real
    // stdio server. No model-side result shortcuts or global MCP clients.
    let server = r#"while IFS= read -r line; do case "$line" in *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}' ;; *'"method":"tools/call"'*) case "$line" in *'9007199254740993'*) printf '%s\n' '{"jsonrpc":"2.0","id":"2","result":{"content":[{"type":"text","text":"failed check"}],"structuredContent":{"n":9007199254740993},"isError":true}}' ;; *) exit 12 ;; esac ;; esac; done"#;
    let mut doc = document(
        json!({"type":"call","mcp":{"server":"local","tool":"check"},"arguments":{"n":{"value":9007199254740993u64}},"next":{"passed":[],"failed":"after"}}),
    );
    doc["mcpServers"] = json!({"local":{"command":["/bin/sh","-c",server]}});
    doc["flow"]["steps"]["after"] = json!({"type":"call","command":"printf after"});
    let (f, bun, pump, _) = host_fixture(doc).await;
    let view = finish(&f, bun, pump).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(view.state.activations.len(), 2);
    assert_eq!(
        serde_json::to_value(&view.state.activations[0].result).unwrap()["outputJson"].as_str(),
        Some(r#"{"outcome":"failed","data":{"n":9007199254740993}}"#)
    );
}

#[test]
fn native_preflight_opens_humans_timeouts_but_keeps_http_and_parallelism_closed() {
    let base = document(json!({"type":"call","command":"true"}));
    assert!(crate::agsdl_host_capture::product_slice030(&base.to_string(), None).is_none());
    let mut steer = base.clone();
    steer["agents"] = json!({"worker":{"harness":"codex","permissions":"read-only"}});
    steer["flow"]["steps"]["check"] = json!({"type":"agent","agent":"worker","delivery":"steer"});
    assert!(crate::agsdl_host_capture::product_slice030(&steer.to_string(), None).is_none());
    let mut doc = base.clone();
    doc["mcpServers"] = json!({"remote":{"url":"https://example.invalid/mcp"}});
    let diagnostic = crate::agsdl_host_capture::product_slice030(&doc.to_string(), None).unwrap();
    assert_eq!(diagnostic.pointer, "/mcpServers/remote/url");
    assert!(diagnostic.message.contains("physical cancellation"));
    let mut doc = base.clone();
    doc["flow"]["steps"]["check"]["type"] = json!("approval");
    assert!(crate::agsdl_host_capture::product_slice030(&doc.to_string(), None).is_none());
    doc["flow"]["steps"]["check"]["timeoutMs"] = json!(10);
    assert!(crate::agsdl_host_capture::product_slice030(&doc.to_string(), None).is_none());
    let plan = json!({"steps":[],"routes":[{"targets":[{},{}]}]});
    assert!(crate::agsdl_host_capture::product_slice030(
        &base.to_string(),
        Some(&plan.to_string())
    )
    .is_some());
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
async fn native_mcp_operand_failure_routes_without_launching_server() {
    let mut doc = document(
        json!({"type":"call","mcp":{"server":"local","tool":"check"},"arguments":{"missing":{"path":["missing"]}},"onError":"recover"}),
    );
    doc["mcpServers"] =
        json!({"local":{"command":["/bin/sh","-c","printf forbidden > server-started"]}});
    doc["flow"]["steps"]["recover"] = json!({"type":"call","command":"printf recovered"});
    let (f, bun, pump, _) = host_fixture(doc).await;
    let workspace = f._temp.path().join("workspace");
    let server_started = workspace.join("server-started");
    let view = finish(&f, bun, pump).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert!(
        matches!(&view.state.activations[0].result, Some(WorkResultRecord030::Failed { error }) if error.code == "OPERAND")
    );
    assert!(view.effects.iter().all(|row| row["status"] == "settled"));
    assert!(!server_started.exists());
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
async fn native_command_deadline_waits_for_the_real_child_before_routing_timeout() {
    let mut doc = document(
        json!({"type":"call","command":"sleep 120 & child=$!; printf '%s' \"$child\" > timeout-child; wait","timeoutMs":700,"onError":"recover"}),
    );
    doc["flow"]["steps"]["recover"] =
        json!({"type":"call","command":"test ! -e timeout-forbidden; printf recovered"});
    let (f, bun, pump, _) = host_fixture(doc).await;
    let file = f._temp.path().join("workspace/timeout-child");
    let pid = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(raw) = std::fs::read_to_string(&file) {
                if let Ok(pid) = raw.parse::<i32>() {
                    break pid;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let view = finish(&f, bun, pump).await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert!(
        matches!(&view.state.activations[0].result,Some(WorkResultRecord030::Failed{error}) if error.code=="TIMEOUT")
    );
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "Timed-out child must be absent before the route"
    );
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
async fn native_mcp_question_answers_and_expires_while_machine_time_is_paused() {
    let server = r#"while IFS= read -r line; do case "$line" in *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"question-fixture","version":"1"}}}' ;; *'"method":"tools/call"'*) printf '%s\n' '{"jsonrpc":"2.0","id":"person","method":"elicitation/create","params":{"message":"Release note?","requestedSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}}' ;; *'"id":"person"'*) printf '%s\n' '{"jsonrpc":"2.0","id":"2","result":{"content":[],"structuredContent":{"answered":true},"isError":false}}' ;; esac; done"#;
    for expire in [false, true] {
        let mut step =
            json!({"type":"call","mcp":{"server":"local","tool":"check"},"timeoutMs":1500});
        if expire {
            step["answerTimeoutMs"] = json!(200);
        }
        let mut doc = document(step);
        doc["mcpServers"] = json!({"local":{"command":["/bin/sh","-c",server]}});
        let (f, bun, pump, _) = host_fixture(doc).await;
        let scope = crate::db::agsdl_execution::public030::HumanScope030 {
            system_start_id: f.identity.system_start_id.clone(),
            source: serde_json::from_value(f.plan.source.clone()).unwrap(),
        };
        let page = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let page =
                    crate::agsdl_host_human_projection030::read(&f.pool, scope.clone(), None)
                        .await
                        .unwrap();
                if !page.requests.is_empty() {
                    break page;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if !expire {
            tokio::time::sleep(std::time::Duration::from_millis(1600)).await;
            let host = f.app.state::<HostState>();
            let broker = host
                .flow030()
                .humans
                .broker(&host, &f.pool, &f.identity)
                .await
                .unwrap();
            let _operation = broker.operation.lock().await;
            broker.submit(&host,crate::agsdl_host_human030::HumanSubmission030 {scope:scope.clone(),request_id:page.requests[0].id.clone(),expected_revision:"0".into(),answer:crate::agsdl_host_human030::HumanAnswer030::Question {answer_json:r#"{"action":"accept","content":{"text":"Écrit par une personne."}}"#.into()}},crate::agsdl_host_human030::HumanOrigin030::Person).await.unwrap();
            broker.pump(&host, &CancellationToken::new()).await.unwrap();
        }
        let view = finish(&f, bun, pump).await;
        assert_eq!(
            view.state.verdict.as_deref(),
            Some("succeeded"),
            "Machine timeout must pause during the human wait"
        );
    }
}
