//! Controlled executors retain physical ownership after submission. All
//! scheduling, admission, routing and settlement use the production supervisor.
use super::*;
use crate::db::agsdl_execution::flow030::FlowEffectKind030;
use futures::future::BoxFuture;
use tokio::sync::{mpsc, oneshot};

struct Work {
    step: String,
    instance: String,
    message: Value,
    submit: Option<oneshot::Sender<(Value, oneshot::Sender<()>)>>,
    finish: Option<oneshot::Sender<()>>,
    cancel: CancellationToken,
}
impl Work {
    async fn submit(&mut self, submission: Value) {
        let (tx, rx) = oneshot::channel();
        self.submit.take().unwrap().send((submission, tx)).unwrap();
        rx.await.unwrap();
    }
    fn finish(&mut self) {
        self.finish.take().unwrap().send(()).unwrap();
    }
}
struct Controlled(mpsc::UnboundedSender<Work>);
impl AgentExecutor030 for Controlled {
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
    ) -> BoxFuture<'static, crate::db::agsdl_execution::Result<()>> {
        let tx = self.0.clone();
        Box::pin(async move {
            let step = work
                .attempt
                .work()
                .step
                .as_ref()
                .unwrap()
                .last()
                .unwrap()
                .clone();
            if work.attempt.agent() == "seed" {
                events.emit(json!({"kind":"submit","callId":"seed","argumentsJson":"{\"results\":{\"items\":[1,2,3]}}"}), &cancel).await?;
                return Ok(());
            }
            let message = match &work.effect.kind {
                FlowEffectKind030::Start { message_json, .. } => {
                    serde_json::from_str(message_json.as_deref().unwrap()).unwrap()
                }
                _ => unreachable!(),
            };
            let (submit, submission) = oneshot::channel();
            let (finish, finished) = oneshot::channel();
            tx.send(Work {
                step,
                instance: work.attempt.work().agent_instance_id.clone().unwrap(),
                message,
                submit: Some(submit),
                finish: Some(finish),
                cancel: cancel.clone(),
            })
            .unwrap_or_else(|_| panic!("test receiver closed"));
            tokio::select! {
                _ = cancel.cancelled() => (),
                submitted = submission => {
                    let (value, ack) = submitted.unwrap();
                    events.emit(json!({"kind":"submit","callId":"controlled","argumentsJson":value.to_string()}), &cancel).await?;
                    ack.send(()).unwrap();
                }
            }
            // Submission is not proof of physical end, even after cancellation.
            finished.await.unwrap();
            Ok(())
        })
    }
}
async fn next(rx: &mut mpsc::UnboundedReceiver<Work>) -> Work {
    tokio::time::timeout(std::time::Duration::from_secs(8), rx.recv())
        .await
        .expect("work did not start")
        .unwrap()
}
async fn quiet(rx: &mut mpsc::UnboundedReceiver<Work>) {
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), rx.recv())
            .await
            .is_err(),
        "work started before its obligation ended"
    );
}
async fn exercise(
    f: &Fixture,
    executor: Arc<dyn AgentExecutor030>,
    script: impl std::future::Future<Output = ()>,
) -> crate::db::agsdl_execution::flow_store030::FlowView030 {
    let capture = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap()
        .capture;
    assert!(crate::agsdl_host_capture::product_slice030(
        &capture.authored_source,
        Some(&capture.compiled_plan_json)
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
    let cancel = CancellationToken::new();
    let supervisor = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &f.config,
        &tasks,
        &f.owner,
        &executors,
        receiver,
        &cancel,
        f.emitter(&tasks),
    );
    let result = tokio::time::timeout(std::time::Duration::from_secs(35), async {
        let (result, ()) = tokio::join!(supervisor, script);
        result
    })
    .await;
    for pump in pumps {
        pump.abort();
        let _ = pump.await;
    }
    result.expect("parallel supervisor timed out").unwrap();
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap()
        .flow;
    assert!(view.state.activations.iter().all(|a| !a.physical));
    assert!(
        view.effects.iter().all(|row| row["status"] == "settled"),
        "unsettled effects: {:?}",
        view.effects
    );
    view
}
fn fork(remaining: &str) -> Value {
    json!({"contract":"agsdl-0.3.0","id":"parallel","agents":{
    "seed":{"harness":"codex","permissions":"read-only","results":{"items":{"schema":{"type":"array","items":{"type":"integer"}}}}},
    "worker":{"harness":"codex","permissions":"read-only"}},
    "flow":{"entry":"seed","steps":{
        "seed":{"type":"agent","agent":"seed","next":["left","right"]},
        "left":{"type":"agent","agent":"worker","instance":"new","next":{"yes":"join"}},
        "right":{"type":"agent","agent":"worker","instance":"new","next":{"yes":"join"}},
        "join":{"type":"join","quorum":{"count":1,"accept":["yes"]},"remaining":remaining,"next":{"reached":"after","missed":"after"}},
        "after":{"type":"agent","agent":"worker","instance":"new"}
    }}})
}

#[tokio::test]
async fn quorum_remaining_obeys_physical_ownership() {
    for remaining in ["stop", "finish", "wait"] {
        let f = Fixture::with_document(fork(remaining)).await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let view = exercise(&f, Arc::new(Controlled(tx)), async {
            let mut left = next(&mut rx).await;
            let mut right = next(&mut rx).await;
            assert_ne!(left.instance, right.instance);
            assert_ne!(left.step, right.step);
            left.submit(json!({"choice":"yes"})).await;
            quiet(&mut rx).await;
            left.finish();
            if remaining == "stop" {
                tokio::time::timeout(std::time::Duration::from_secs(8), right.cancel.cancelled())
                    .await
                    .expect("loser not cancelled");
                quiet(&mut rx).await;
                right.finish();
            } else if remaining == "wait" {
                quiet(&mut rx).await;
                assert!(!right.cancel.is_cancelled());
                right.submit(json!({"choice":"yes"})).await;
                quiet(&mut rx).await;
                right.finish();
            }
            let mut after = next(&mut rx).await;
            assert_eq!(after.step, "after");
            if remaining == "finish" {
                assert!(!right.cancel.is_cancelled());
                right.submit(json!({"choice":"yes"})).await;
                right.finish();
            }
            after.submit(json!({})).await;
            after.finish();
            quiet(&mut rx).await;
        })
        .await;
        assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
        assert_eq!(view.state.groups[0].decision.as_deref(), Some("reached"));
    }
}

#[tokio::test]
async fn fanout_concurrency_waits_for_physical_end_and_preserves_items() {
    let mut document = fork("stop");
    document["flow"]["steps"]["seed"]["next"] =
        json!({"step":"left","each":["results","items"],"concurrency":2,"max":3});
    document["flow"]["steps"]
        .as_object_mut()
        .unwrap()
        .remove("right");
    document["flow"]["steps"]["join"] = json!({"type":"join","next":"after"});
    let f = Fixture::with_document(document).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let view = exercise(&f, Arc::new(Controlled(tx)), async {
        let mut first = next(&mut rx).await;
        let mut second = next(&mut rx).await;
        assert_eq!(first.message["item"], 1);
        assert_eq!(second.message["item"], 2);
        assert_ne!(first.instance, second.instance);
        first.submit(json!({"choice":"yes"})).await;
        quiet(&mut rx).await;
        first.finish();
        let mut third = next(&mut rx).await;
        assert_eq!(third.message["item"], 3);
        assert_ne!(second.instance, third.instance);
        third.submit(json!({"choice":"yes"})).await;
        third.finish();
        second.submit(json!({"choice":"yes"})).await;
        quiet(&mut rx).await;
        second.finish();
        let mut after = next(&mut rx).await;
        assert_eq!(after.step, "after");
        after.submit(json!({})).await;
        after.finish();
    })
    .await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    let output: Value =
        serde_json::from_str(view.state.groups[0].output_json.as_ref().unwrap()).unwrap();
    assert_eq!(
        output["branches"]["left"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["item"].clone())
            .collect::<Vec<_>>(),
        vec![json!(1), json!(2), json!(3)]
    );
}

#[tokio::test]
async fn fanout_max_rejects_the_entire_route_before_any_target_starts() {
    let mut document = fork("stop");
    document["flow"]["steps"]["seed"]["next"] =
        json!([{"step":"left","each":["results","items"],"max":2},"right"]);
    document["flow"]["steps"]["join"] = json!({"type":"join","onError":"after"});
    let f = Fixture::with_document(document).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let view = exercise(&f, Arc::new(Controlled(tx)), async {
        let mut after = next(&mut rx).await;
        assert_eq!(after.step, "after", "no fan-out or fixed sibling may start");
        after.submit(json!({})).await;
        after.finish();
    })
    .await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
    assert!(
        view.state.groups.is_empty(),
        "a rejected fork opens no group"
    );
    assert!(view.effects.iter().any(|row| matches!(
        serde_json::from_value::<FlowEffect030>(row["effect"].clone()).unwrap().kind,
        FlowEffectKind030::Failure { step:Some(step), error, .. } if step == ["join"] && error.code == "FANOUT_LIMIT"
    )));
}

#[tokio::test]
async fn global_stop_joins_each_parallel_owner_after_accepted_submission() {
    let f = Fixture::with_document(fork("stop")).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let view = exercise(&f, Arc::new(Controlled(tx)), async {
        let mut first = next(&mut rx).await;
        let mut second = next(&mut rx).await;
        first.submit(json!({"choice":"yes"})).await;
        stop_fixture(&f, "parallel-stop").await;
        for work in [&first, &second] {
            tokio::time::timeout(std::time::Duration::from_secs(8), work.cancel.cancelled())
                .await
                .expect("parallel owner not cancelled");
        }
        second.finish();
        quiet(&mut rx).await;
        let inspection = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
            .await
            .unwrap();
        assert!(inspection.flow.state.activations.iter().any(|a| a.physical));
        assert!(inspection.flow.state.verdict.is_none());
        first.finish();
    })
    .await;
    assert_eq!(view.state.verdict.as_deref(), Some("cancelled"));
    assert_eq!(
        view.state
            .activations
            .iter()
            .filter(|a| a.agent.as_deref() == Some("worker"))
            .count(),
        2
    );
}

#[cfg(unix)]
#[tokio::test]
async fn codex_parallel_sessions_isolate_settings_missions_and_resources() {
    use std::os::unix::fs::PermissionsExt;
    let mut document = fork("wait");
    document["agents"]["left"] = json!({"harness":"codex","permissions":"read-only","model":{"name":"fixture","effort":"medium"},"instructions":"LEFT_PERMANENT","resources":{"note":{"value":"LEFT_DATA"}}});
    document["agents"]["right"] = json!({"harness":"codex","permissions":"workspace","model":{"name":"fixture","effort":"high"},"instructions":"RIGHT_PERMANENT","resources":{"note":{"value":"RIGHT_DATA"}}});
    for name in ["left", "right"] {
        document["flow"]["steps"][name]["agent"] = json!(name);
        document["flow"]["steps"][name]["prompt"] = json!(format!("{name}_MISSION"));
    }
    document["flow"]["steps"]["after"]["prompt"] = json!("AFTER_MISSION");
    let f = Fixture::with_document(document).await;
    // Approve the synthetic host ceiling through the same configuration path
    // as conformance. The default read-only ceiling correctly narrows both agents.
    let tools = f
        .config
        .get_document(
            crate::config::ConfigDocumentKind::Tools,
            crate::config::ConfigScope::User,
        )
        .await
        .unwrap();
    let mut approved = tools.value;
    approved["agsdlHostPermissions"] = json!("workspace");
    std::fs::write(&tools.file_path, serde_json::to_vec(&approved).unwrap()).unwrap();
    let pending = f
        .config
        .reload(
            crate::config::ConfigDocumentKind::Tools,
            crate::config::ConfigScope::User,
            crate::config::ConfigChangeSource::ExternalEditor,
        )
        .await
        .unwrap()
        .pending
        .unwrap();
    f.config.accept_pending_change(&pending.id).await.unwrap();
    let root = f._temp.path().canonicalize().unwrap();
    let trace = root.join("parallel.jsonl");
    let profile = crate::agsdl_host_codex::profile::Profile {
        executable: root.join("fake-codex"),
        directory: root.join("profile"),
        home: root.join("profile/home"),
        bootstrap: root.join("bootstrap"),
        digest: "synthetic-profile".into(),
    };
    std::fs::create_dir_all(&profile.bootstrap).unwrap();
    let variants = json!([
        profile.settings(&root.join("workspace"), true).unwrap(),
        profile.settings(&root.join("workspace"), false).unwrap()
    ]);
    let script = format!(
        "#!/usr/bin/env python3\nimport json\ntrace={}\nvariants=json.loads({})\n{}",
        serde_json::to_string(trace.to_str().unwrap()).unwrap(),
        serde_json::to_string(&variants.to_string()).unwrap(),
        PARALLEL_PEER
    );
    std::fs::write(&profile.executable, script).unwrap();
    std::fs::set_permissions(&profile.executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut executor = crate::agsdl_host_codex030::CodexExecutor030::new(f.config.clone());
    executor.test_profile = Some(profile);
    let view = exercise(&f, Arc::new(executor), async {}).await;
    assert_eq!(
        view.state.verdict.as_deref(),
        Some("succeeded"),
        "{:?}; trace={}",
        view.state.activations,
        std::fs::read_to_string(&trace).unwrap_or_default()
    );
    let records: Vec<Value> = std::fs::read_to_string(&trace)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let turns: Vec<_> = records
        .iter()
        .filter(|r| r["method"] == "turn/start")
        .collect();
    assert_eq!(turns.len(), 4, "one turn per work, no double dispatch");
    let mut intervals = vec![];
    for (name, effort, permission) in [("left", "medium", "read"), ("right", "high", "write")] {
        let turn = turns
            .iter()
            .find(|r| {
                r["params"]["input"]
                    .to_string()
                    .contains(&format!("{name}_MISSION"))
            })
            .unwrap();
        let pid = &turn["pid"];
        let start = records
            .iter()
            .find(|r| r["pid"] == *pid && r["method"] == "thread/start")
            .unwrap();
        let settings = records
            .iter()
            .find(|r| r["pid"] == *pid && r["method"] == "settings")
            .unwrap();
        assert_eq!(
            settings["params"]["permissions"]["macro-agsdl"]["filesystem"]
                [root.join("workspace").to_str().unwrap()],
            permission
        );
        assert_eq!(turn["params"]["effort"], effort);
        let instructions = start["params"]["developerInstructions"].as_str().unwrap();
        assert!(instructions.contains(&format!("{}_PERMANENT", name.to_uppercase())));
        assert!(!instructions.contains("_DATA"));
        assert!(!instructions.contains("_MISSION"));
        let context = turn["params"]["additionalContext"].to_string();
        assert!(context.contains(&format!("{}_DATA", name.to_uppercase())));
        assert!(!context.contains(if name == "left" {
            "RIGHT_DATA"
        } else {
            "LEFT_DATA"
        }));
        let begin = records
            .iter()
            .position(|r| r["pid"] == *pid && r["method"] == "barrier")
            .unwrap();
        let end = records
            .iter()
            .position(|r| r["pid"] == *pid && r["method"] == "release")
            .unwrap();
        intervals.push((pid, &turn["params"]["threadId"], begin, end));
    }
    assert_ne!(intervals[0].0, intervals[1].0);
    assert_ne!(intervals[0].1, intervals[1].1);
    assert!(
        intervals[0].2.max(intervals[1].2) < intervals[0].3.min(intervals[1].3),
        "distinct native processes must overlap before either may finish"
    );
}

#[cfg(unix)]
const PARALLEL_PEER: &str = r#"
import json,sys,os,time,glob
def inline_toml(value):
 if isinstance(value,dict): return '{'+','.join(json.dumps(k)+'='+inline_toml(v) for k,v in value.items())+'}'
 return json.dumps(value,separators=(',',':'),ensure_ascii=False)
flags={sys.argv[index+1] for index,arg in enumerate(sys.argv[:-1]) if arg=='-c'}
matches=[v for v in variants if flags=={k+'='+inline_toml(value) for k,value in v.items()}]
assert len(matches)==1, 'session flags differ from both native profiles'
settings=matches[0]
bootstrap=os.getcwd(); pid=os.getpid(); thread='thread-'+str(pid)
def log(method,params={}):
 data=json.dumps({'pid':pid,'time':time.time_ns(),'method':method,'params':params})+'\n'
 fd=os.open(trace,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600); os.write(fd,data.encode()); os.close(fd)
log('settings',settings)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{}); i=m.get('id')
 if i is None: continue
 log(method,p)
 if method=='initialize': result={}
 elif method=='config/read': result={'layers':[{'name':{'type':'sessionFlags'},'config':settings}],'config':settings}
 elif method=='skills/list': result={'data':[{'cwd':bootstrap,'skills':[],'errors':[]}]}
 elif method=='command/exec': result={'exitCode':0}
 elif method=='thread/start': result={'thread':{'id':thread},'model':p['model'],'approvalPolicy':'never','activePermissionProfile':{'id':'macro-agsdl'},'cwd':bootstrap,'runtimeWorkspaceRoots':p['runtimeWorkspaceRoots'],'instructionSources':[]}
 elif method=='turn/start':
  print(json.dumps({'id':i,'result':{'turn':{'id':'turn'}}}),flush=True)
  prompt=json.dumps(p['input'])
  worker='left_MISSION' in prompt or 'right_MISSION' in prompt
  if worker:
   log('barrier'); open(trace+'.ready.'+str(pid),'w').close()
   deadline=time.monotonic()+8
   while len(glob.glob(trace+'.ready.*'))<2:
    assert time.monotonic()<deadline, 'second concurrent session never started'
    time.sleep(.01)
   log('release')
  submission={'choice':'yes'} if worker else {'results':{'items':[1,2,3]}} if 'AFTER_MISSION' not in prompt else {}
  envelope={'text':'Completed','submissionJson':json.dumps(submission)}
  print(json.dumps({'method':'item/completed','params':{'threadId':thread,'turnId':'turn','item':{'id':'final','type':'agentMessage','phase':'final_answer','text':json.dumps(envelope)}}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':'turn','status':'completed'}}}),flush=True)
  continue
 else: raise RuntimeError(method)
 print(json.dumps({'id':i,'result':result}),flush=True)
"#;

#[tokio::test]
async fn composition_output_does_not_end_run_before_finishing_body_work() {
    let mut doc = fork("finish");
    let mut body = doc["flow"].clone();
    body["outputs"] = json!(["done"]);
    body["steps"].as_object_mut().unwrap().remove("after");
    body["steps"]["join"]["next"] = json!({"reached":{"output":"done"},"missed":{"output":"done"}});
    doc["compositions"] = json!({"body":body});
    doc["flow"] = json!({"entry":"outer","steps":{
        "outer":{"type":"compose","composition":"body","next":{"done":"after"}},
        "after":{"type":"agent","agent":"worker","instance":"new"}
    }});
    let f = Fixture::with_document(doc).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let view = exercise(&f, Arc::new(Controlled(tx)), async {
        let mut left = next(&mut rx).await;
        let mut right = next(&mut rx).await;
        left.submit(json!({"choice":"yes"})).await;
        left.finish();
        let mut after = next(&mut rx).await;
        assert_eq!(after.step, "after");
        after.submit(json!({})).await;
        after.finish();
        quiet(&mut rx).await;
        let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
            .await
            .unwrap();
        assert_eq!(view.flow.state.verdict, None);
        assert!(view.flow.state.activations.iter().any(|a| a.physical
            && a.step
                .as_ref()
                .is_some_and(|s| s.last() == Some(&right.step))));
        right.submit(json!({"choice":"yes"})).await;
        right.finish();
    })
    .await;
    assert_eq!(view.state.verdict.as_deref(), Some("succeeded"));
}
