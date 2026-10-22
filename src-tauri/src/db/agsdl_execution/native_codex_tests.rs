//! Simulated app-server protocol and real local process containment. No model,
//! provider or authentication is used by these synthetic executable fixtures.
use super::*;
use crate::agsdl_host_codex::{HostCodexRequest, Profile};
use serde_json::json;

struct NativeCompiler(EngineAgentConfiguration);
impl CaptureAuthority for NativeCompiler {
    type CommitGuard = ();
    async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
        let mut captured = Compiler.capture(request, id).await?;
        let account = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    "synthetic-account",
                    "https://synthetic.invalid",
                    "NO_CONSTRAINT"
                ))
                .unwrap()
            )
        );
        captured.private.native_catalogue_json=json!({"catalogue":{"revision":"synthetic","models":[],"unavailableProviders":[]},"providers":[],"codexAccountDigest":account}).to_string();
        captured.snapshot.agents = ["a", "b"]
            .into_iter()
            .map(|name| EngineAgentConfiguration {
                agent_name: name.into(),
                ..self.0.clone()
            })
            .collect();
        Ok(captured)
    }
    async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
        Ok(())
    }
}
#[cfg(unix)]
#[tokio::test]
async fn simulated_codex_resumes_two_activations_keeps_instances_separate_and_joins_descendants() {
    use std::os::unix::fs::PermissionsExt;
    let temp = TempDir::new().unwrap();
    let workspace = temp.path().join("workspace");
    let directory = temp.path().join("private-native");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    let executable = directory.join("fake-codex");
    let profile = Profile {
        executable: executable.clone(),
        directory: directory.clone(),
        home: directory.join("home"),
        bootstrap: temp.path().join("bootstrap"),
        digest: "synthetic-profile".into(),
    };
    std::fs::create_dir(&profile.bootstrap).unwrap();
    let scope = json!({"root":workspace});
    let mut config = configuration("a");
    config.provider_id = "codex-native".into();
    config.model_id = "synthetic-model".into();
    config.configuration_json = json!({"initialization":{"prompt":[{"value":"Review."}]},"nativeEngine":{"adapter":"codex-app-server-v1","profileJson":profile.identity()}}).to_string();
    config.permissions_json =
        json!({"mode":"Implement","readOnly":false,"allowedToolIds":[]}).to_string();
    config.scope_json = scope.to_string();
    config.settings_json =
        json!({"nativeProfileJson":profile.attestation(false,&scope).unwrap()}).to_string();
    std::fs::write(
        directory.join("config.json"),
        profile.settings(&workspace, false).unwrap().to_string(),
    )
    .unwrap();
    std::fs::write(&executable,r#"#!/usr/bin/python3
import sys,json,os,subprocess
from pathlib import Path
root=Path(__file__).parent
child=subprocess.Popen(['/usr/bin/sleep','30'],start_new_session=True)
with (root/'children').open('a') as f:f.write(str(child.pid)+'\n')
thread=None
for line in sys.stdin:
 value=json.loads(line); method=value.get('method'); p=value.get('params',{}); result={}
 if 'id' not in value:continue
 if method=='config/read':result={'layers':[{'name':{'type':'sessionFlags'},'config':json.loads((root/'config.json').read_text())}],'config':json.loads((root/'config.json').read_text())}
 elif method=='skills/list':result={'data':[{'skills':[]}]}
 elif method=='command/exec':result={'exitCode':0}
 elif method=='account/read':result={'account':{'type':'chatgpt'},'workspaceRouting':{'chatgptAccountId':'synthetic-account','backendOrigin':'https://synthetic.invalid','accountRoutingOverride':'NO_CONSTRAINT'}}
 elif method=='model/list':result={'data':[{'model':'synthetic-model'}],'nextCursor':None}
 elif method in ['thread/start','thread/resume']:
  if method=='thread/start':
   count=len(list(root.glob('thread-*')))+1;thread='thread-'+str(count);(root/thread).write_text('')
  else:
   thread=p['threadId']
   if not (root/thread).is_file():
    print(json.dumps({'id':value['id'],'error':{'code':-1,'message':'missing thread'}}),flush=True);continue
  result={'thread':{'id':thread},'model':'synthetic-model','approvalPolicy':'never','activePermissionProfile':{'id':'macro-agsdl'}}
 elif method=='turn/start':
  assert p['threadId']==thread
  with (root/thread).open('a') as f:f.write(p['input'][0]['text'].split('\n\nReturn the final')[0]+'\n')
  if (root/'lose-turn-receipt').exists():sys.exit(0)
  turn='turn-'+str(os.getpid());result={'turn':{'id':turn}}
 print(json.dumps({'id':value['id'],'result':result}),flush=True)
 if method=='turn/start':
  print(json.dumps({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':{'type':'agentMessage','id':turn+'-message','phase':'final_answer','text':json.dumps({'publicationJson':'{"results":{"n":{"value":9007199254740993}}}'})}}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed'}}}),flush=True)
"#).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let pool = create_pool(&temp.path().join("native.db")).await.unwrap();
    let receipt = start(&pool, request(), &NativeCompiler(config.clone()))
        .await
        .unwrap();
    let owner = resume(&pool, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    let ai = crate::ai::AiState::default();
    let mut threads = Vec::new();
    for (index, step, input) in [
        (0, "second", "first"),
        (1, "second", "second"),
        (2, "b", "other"),
    ] {
        let delivery = delivery(&pool, &owner, step, &format!("native-{index}")).await;
        accept_delivery(&pool, &owner, delivery.clone())
            .await
            .unwrap();
        begin(&pool, &owner, &delivery.delivery_id).await.unwrap();
        let agent_name = if step == "b" { "b" } else { "a" };
        let configuration = EngineAgentConfiguration {
            agent_name: agent_name.into(),
            ..config.clone()
        };
        let context = EngineContext {
            owner: owner.clone(),
            work: delivery.work.clone(),
            permissions_json: configuration.permissions_json.clone(),
            scope_json: configuration.scope_json.clone(),
            registry_version: "registry-v1".into(),
        };
        let request = HostCodexRequest {
            context: context.clone(),
            request_id: format!("native-{index}"),
            input_json: json!({"prompt":[{"value":input}]}).to_string(),
            publication_contract_json: Some("{}".into()),
        };
        let effect = EngineEffect {
            context: context.clone(),
            effect: EngineEffectIdentity::Provider {
                provider_attempt_id: request.request_id.clone(),
            },
            invocation_json: json!({"kind":"codex-app-server-v1"}).to_string(),
        };
        register_effect(&pool, effect.clone()).await.unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let (owned_pool, owned_ai, owned_profile) = (pool.clone(), ai.clone(), profile.clone());
        ai.stream_tasks
            .start(request.request_id.clone(), async move {
                let result = crate::agsdl_host_codex::run(
                    owned_pool,
                    owned_ai,
                    owned_profile,
                    configuration,
                    request,
                    std::sync::Arc::default(),
                )
                .await;
                let _ = sender.send(result);
            })
            .unwrap();
        let received = receiver.await.unwrap().unwrap();
        ai.stream_tasks
            .cancel_owned(&format!("native-{index}"))
            .await
            .unwrap();
        settle_owned_effect(
            &pool,
            EngineSettlement {
                context: context.clone(),
                effect: effect.effect,
                status: "ended".into(),
                evidence_json: "{\"kind\":\"simulated-native-physical-join\"}".into(),
            },
            None,
        )
        .await
        .unwrap();
        let (emissions, digest) = responses::read(&pool, &owner, &delivery.work)
            .await
            .unwrap();
        assert_eq!(emissions.len(), 1);
        assert_eq!(emissions[0].kind, "publication");
        assert!(emissions[0].body_json.contains("9007199254740993"));
        responses::close(
            &pool,
            responses::Closure {
                owner: owner.clone(),
                work: delivery.work.clone(),
                cursor: "1".into(),
                digest,
                validation_json: r#"{"kind":"success","text":"","resultsJson":"{}","choice":null}"#
                    .into(),
            },
        )
        .await
        .unwrap();
        let mut terminal = commit(&owner, &delivery.work);
        terminal.response_cursor = "1".into();
        terminal.memory = Some(EngineMemory {
            agent_instance_id: delivery.work.agent_instance_id.clone().unwrap(),
            revision: if index == 1 { "2" } else { "1" }.into(),
            format_version: "macro-codex-memory/1".into(),
            state_json: json!({"threadId":received.thread_id}).to_string(),
        });
        commit_terminal(&pool, terminal, &NoRoutes).await.unwrap();
        threads.push(received.thread_id);
    }
    assert_eq!(threads[0], threads[1]);
    assert_ne!(threads[0], threads[2]);
    assert_eq!(
        std::fs::read_to_string(directory.join(&threads[0])).unwrap(),
        "first\nsecond\n"
    );
    assert_eq!(
        std::fs::read_to_string(directory.join(&threads[2])).unwrap(),
        "other\n"
    );
    // A turn may execute even if its receipt is lost. The adapter must retain
    // uncertainty and refuse a later call before it can spawn another process.
    std::fs::write(directory.join("lose-turn-receipt"), "synthetic").unwrap();
    let d = delivery(&pool, &owner, "second", "uncertain").await;
    accept_delivery(&pool, &owner, d.clone()).await.unwrap();
    begin(&pool, &owner, &d.delivery_id).await.unwrap();
    let context = EngineContext {
        owner: owner.clone(),
        work: d.work.clone(),
        permissions_json: config.permissions_json.clone(),
        scope_json: config.scope_json.clone(),
        registry_version: "registry-v1".into(),
    };
    let request = HostCodexRequest {
        context: context.clone(),
        request_id: "uncertain".into(),
        input_json: r#"{"prompt":[{"value":"uncertain"}]}"#.into(),
        publication_contract_json: Some("{}".into()),
    };
    let effect = EngineEffect {
        context: context.clone(),
        effect: EngineEffectIdentity::Provider {
            provider_attempt_id: "uncertain".into(),
        },
        invocation_json: json!({"kind":"codex-app-server-v1"}).to_string(),
    };
    register_effect(&pool, effect).await.unwrap();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let (owned_pool, owned_ai, owned_profile, owned_config, owned_request) = (
        pool.clone(),
        ai.clone(),
        profile.clone(),
        config.clone(),
        request.clone(),
    );
    ai.stream_tasks
        .start("uncertain".into(), async move {
            let result = crate::agsdl_host_codex::run(
                owned_pool,
                owned_ai,
                owned_profile,
                owned_config,
                owned_request,
                std::sync::Arc::default(),
            )
            .await;
            let _ = sender.send(result);
        })
        .unwrap();
    assert_eq!(
        receiver.await.unwrap().unwrap_err().code,
        "NATIVE_UNCERTAIN"
    );
    ai.stream_tasks.cancel_owned("uncertain").await.unwrap();
    let retained = super::native_operations::read_instance(
        &pool,
        &owner.system_start_id,
        d.work.agent_instance_id.as_deref().unwrap(),
    )
    .await
    .unwrap();
    assert!(retained
        .iter()
        .any(
            |(operation, refs)| operation.operation_id == "uncertain:turn/start" && refs.is_none()
        ));
    let before = std::fs::read_to_string(directory.join("children")).unwrap();
    assert_eq!(
        crate::agsdl_host_codex::run(
            pool.clone(),
            ai.clone(),
            profile.clone(),
            config,
            request,
            std::sync::Arc::default()
        )
        .await
        .unwrap_err()
        .code,
        "NATIVE_UNCERTAIN"
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("children")).unwrap(),
        before
    );
    for pid in std::fs::read_to_string(directory.join("children"))
        .unwrap()
        .lines()
    {
        let pid: i32 = pid.parse().unwrap();
        for _ in 0..50 {
            if unsafe { libc::kill(pid, 0) } == -1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "native descendant {pid} remains: {:?}",
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
        );
    }
}
