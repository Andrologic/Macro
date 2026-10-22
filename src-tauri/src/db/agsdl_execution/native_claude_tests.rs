//! Real SQLite and process containment with a synthetic runner protocol. No SDK,
//! authentication or remote inference is required by these normal CI tests.
use super::*;
use crate::agsdl_host_claude::{HostClaudeReceipt, HostClaudeRequest, Profile};
use serde_json::json;
struct ClaudeCompiler(EngineAgentConfiguration);
impl CaptureAuthority for ClaudeCompiler {
    type CommitGuard = ();
    async fn capture(&self, r: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
        let mut c = Compiler.capture(r, id).await?;
        c.snapshot.agents = ["a", "b"]
            .into_iter()
            .map(|name| EngineAgentConfiguration {
                agent_name: name.into(),
                ..self.0.clone()
            })
            .collect();
        c.private.native_catalogue_json=json!({"catalogue":{"revision":"synthetic","models":[],"unavailableProviders":[]},"providers":[],"claudeAccountDigest":format!("sha256:{:x}",Sha256::digest(b"synthetic-claude-key"))}).to_string();
        Ok(c)
    }
    async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
        Ok(())
    }
}
#[cfg(unix)]
#[tokio::test]
async fn simulated_claude_resumes_exactly_retains_preterminal_refs_and_refuses_ambiguous_replay() {
    let _secrets = crate::secrets::lock_test_store();
    let temp = TempDir::new().unwrap();
    crate::secrets::init(temp.path()).unwrap();
    crate::secrets::set_api_key("claude-native", "synthetic-claude-key").unwrap();
    let directory = temp.path().join("native");
    let workspace = temp.path().join("workspace");
    let bootstrap = temp.path().join("bootstrap");
    for p in [&directory, &workspace, &bootstrap] {
        std::fs::create_dir(p).unwrap();
    }
    let profile = Profile {
        node: "/usr/bin/python3".into(),
        sdk: "/synthetic/sdk.mjs".into(),
        zod: "/synthetic/zod".into(),
        cli: "/synthetic/claude".into(),
        directory: directory.clone(),
        home: directory.join("home"),
        config: directory.join("claude"),
        bootstrap,
        digest: "synthetic-profile".into(),
        workspace: None,
        qa_endpoint: None,
    };
    for p in [&profile.home, &profile.config] {
        std::fs::create_dir(p).unwrap();
    }
    let ready = json!({"nodeVersion":"22.23.3","initialized":{"claude_code_version":"2.1.308","current_permission_mode":"default","hooks_applied":true,"account":{"apiKeySource":"ANTHROPIC_API_KEY","apiProvider":"firstParty"},"commands":crate::agsdl_host_claude::COMMANDS.iter().map(|name|json!({"name":name,"builtin":true})).collect::<Vec<_>>(),"agents":crate::agsdl_host_claude::AGENTS.iter().map(|name|json!({"name":name})).collect::<Vec<_>>()},"mcpStatus":[{"name":"macro","status":"connected","source":"sdk","tools":[{"name":"macro_agsdl_publish"}]}],"models":[{"value":"synthetic","resolvedModel":"synthetic-model"}],"settings":{"tools":[],"verbatimPrompts":true}});
    std::fs::write(directory.join("ready.json"), ready.to_string()).unwrap();
    std::fs::write(profile.runner_path(),r#"import sys,json,os,subprocess,uuid
from pathlib import Path
root=Path(__file__).parent
child=subprocess.Popen(['/usr/bin/sleep','30'],start_new_session=True)
with (root/'children').open('a') as f:f.write(str(child.pid)+'\n')
def ask(method,params):
 print(json.dumps({'id':str(uuid.uuid4()),'method':method,'params':params}),flush=True)
 if not sys.stdin.readline():sys.exit(0)
c=json.loads(sys.stdin.readline())['params'];session=c['sessionId'];file=root/('session-'+session)
if c['resume'] and not file.exists():sys.exit(0)
ask('ready',json.loads((root/'ready.json').read_text()))
if (root/'lose-init').exists():sys.exit(0)
run=str(uuid.uuid4())
init={'type':'system','subtype':'init','session_id':session,'uuid':run,'model':c['model'],'claude_code_version':'2.1.308','cwd':c['cwd'],'slash_commands':[x['name'] for x in json.loads((root/'ready.json').read_text())['initialized']['commands']],'output_style':'default','permissionMode':'default','apiKeySource':'ANTHROPIC_API_KEY','tools':['mcp__macro__macro_agsdl_publish'],'agents':[],'skills':[],'plugins':[],'mcp_servers':[{'name':'macro','status':'connected','source':'sdk'}]}
ask('frame',{'frame':init})
with file.open('a') as f:f.write(c['input']+'\n')
if (root/'lose-result').exists():sys.exit(0)
raw='{"results":{"n":{"value":9007199254740993},"text":{"value":"'+'x'*2048+'"}}}'
ask('publish',{'toolUseId':'tool-publication','name':'macro_agsdl_publish','argumentsJson':raw})
ask('publish',{'toolUseId':'tool-publication','name':'macro_agsdl_publish','argumentsJson':raw})
ask('frame',{'frame':{'type':'result','session_id':session,'subtype':'success','is_error':False,'uuid':str(uuid.uuid4()),'total_cost_usd':0,'usage':{}}})
for line in sys.stdin:pass
"#).unwrap();
    let scope = json!({"root":workspace});
    let mut config = configuration("a");
    config.provider_id = "claude-native".into();
    config.model_id = "synthetic-model".into();
    config.configuration_json=json!({"initialization":{"prompt":[{"value":"Synthetic."}]},"configuration":{"tools":{}},"bindings":{},"nativeEngine":{"adapter":"claude-sdk-v1","profileJson":profile.identity()}}).to_string();
    config.settings_json =
        json!({"nativeProfileJson":profile.attestation(&scope).unwrap()}).to_string();
    config.scope_json = scope.to_string();
    config.permissions_json = "{}".into();
    let path = temp.path().join("native.db");
    let pool = create_pool(&path).await.unwrap();
    let receipt = start(&pool, request(), &ClaudeCompiler(config.clone()))
        .await
        .unwrap();
    let owner = resume(&pool, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    let ai = crate::ai::AiState::default();
    let mut sessions = Vec::new();
    for (index, step, input) in [
        (0, "second", "first"),
        (1, "second", "second"),
        (2, "b", "other"),
        (3, "second", "ambiguous"),
    ] {
        if index == 3 {
            std::fs::write(directory.join("lose-result"), "").unwrap();
        }
        let delivery = delivery(&pool, &owner, step, &format!("claude-{index}")).await;
        accept_delivery(&pool, &owner, delivery.clone())
            .await
            .unwrap();
        begin(&pool, &owner, &delivery.delivery_id).await.unwrap();
        let mut configuration = config.clone();
        configuration.agent_name = if step == "b" { "b" } else { "a" }.into();
        let context = EngineContext {
            owner: owner.clone(),
            work: delivery.work.clone(),
            permissions_json: config.permissions_json.clone(),
            scope_json: config.scope_json.clone(),
            registry_version: "registry-v1".into(),
        };
        let request = HostClaudeRequest {
            context: context.clone(),
            request_id: format!("claude-{index}"),
            input_json: json!({"prompt":[{"value":input}]}).to_string(),
            publication_contract_json: Some("{}".into()),
        };
        let effect = EngineEffect {
            context: context.clone(),
            effect: EngineEffectIdentity::Provider {
                provider_attempt_id: request.request_id.clone(),
            },
            invocation_json: "{\"kind\":\"claude-sdk-v1\"}".into(),
        };
        register_effect(&pool, effect.clone()).await.unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let (p, a, n, c, r) = (
            pool.clone(),
            ai.clone(),
            profile.clone(),
            configuration.clone(),
            request.clone(),
        );
        ai.stream_tasks
            .start(request.request_id.clone(), async move {
                let result = crate::agsdl_host_claude::run(
                    p,
                    a,
                    n,
                    c,
                    r,
                    std::sync::Arc::default(),
                    None,
                    false,
                )
                .await;
                let _ = sender.send(result);
            })
            .unwrap();
        let result = receiver.await.unwrap();
        ai.stream_tasks
            .cancel_owned(&request.request_id)
            .await
            .unwrap();
        // Reopening SQLite sees init references before any terminal transaction.
        let reopened = create_pool(&path).await.unwrap();
        let native = super::native_operations::read_instance(
            &reopened,
            &owner.system_start_id,
            delivery.work.agent_instance_id.as_deref().unwrap(),
        )
        .await
        .unwrap();
        assert!(native.iter().any(|(op, refs)| op.operation_id
            == format!("claude-{index}:query/start")
            && refs.as_ref().is_some_and(|s| s.contains("nativeInit"))));
        if index == 3 {
            assert_eq!(result.unwrap_err().code, "NATIVE_UNCERTAIN");
            assert!(native
                .iter()
                .any(|(op, refs)| op.method == "query/result" && refs.is_none()));
            let before = std::fs::read_to_string(directory.join("children")).unwrap();
            assert_eq!(
                crate::agsdl_host_claude::run(
                    pool.clone(),
                    ai.clone(),
                    profile.clone(),
                    configuration,
                    request,
                    std::sync::Arc::default(),
                    None,
                    false
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
            break;
        }
        if index == 2 {
            let (operation, references) = native
                .iter()
                .find(|(op, _)| op.operation_id == "claude-2:query/result")
                .unwrap();
            let original = references.as_ref().unwrap();
            let before = std::fs::read_to_string(directory.join("children")).unwrap();
            for native_result in [
                json!({"subtype":"success","is_error":true}),
                json!({"subtype":"success"}),
            ] {
                let mut changed: serde_json::Value = serde_json::from_str(original).unwrap();
                changed["nativeResult"] = native_result;
                sqlx::query("UPDATE engine_native_operations SET references_json=? WHERE system_id=? AND operation_id=?")
                    .bind(changed.to_string()).bind(&owner.system_start_id).bind(&operation.operation_id).execute(&pool).await.unwrap();
                let refused = crate::agsdl_host_claude::run(
                    pool.clone(),
                    ai.clone(),
                    profile.clone(),
                    configuration.clone(),
                    request.clone(),
                    std::sync::Arc::default(),
                    None,
                    false,
                )
                .await
                .unwrap_err();
                assert_eq!(refused.code, "NATIVE_UNCERTAIN");
                assert!(refused.message.contains("unsuccessful native turn"));
                assert_eq!(
                    std::fs::read_to_string(directory.join("children")).unwrap(),
                    before,
                    "an unsuccessful result spawned a runner"
                );
            }
            sqlx::query("UPDATE engine_native_operations SET references_json=? WHERE system_id=? AND operation_id=?")
                .bind(original).bind(&owner.system_start_id).bind(&operation.operation_id).execute(&pool).await.unwrap();
        }
        let HostClaudeReceipt::Completed { session_id, .. } = result.unwrap() else {
            panic!("expected completed Claude receipt")
        };
        settle_owned_effect(
            &pool,
            EngineSettlement {
                context: context.clone(),
                effect: effect.effect,
                status: "ended".into(),
                evidence_json: "{\"kind\":\"synthetic-physical-join\"}".into(),
            },
            None,
        )
        .await
        .unwrap();
        let (emissions, digest) = responses::read(&pool, &owner, &delivery.work)
            .await
            .unwrap();
        assert_eq!(emissions.len(), 1);
        assert!(emissions[0].body_json.contains("9007199254740993"));
        assert!(emissions[0].body_json.len() > 2048);
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
            format_version: "macro-claude-memory/1".into(),
            state_json: json!({"sessionId":session_id}).to_string(),
        });
        commit_terminal(&pool, terminal, &NoRoutes).await.unwrap();
        sessions.push(session_id);
    }
    assert_eq!(sessions[0], sessions[1]);
    assert_ne!(sessions[0], sessions[2]);
    for pid in std::fs::read_to_string(directory.join("children"))
        .unwrap()
        .lines()
    {
        let pid: i32 = pid.parse().unwrap();
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "native descendant survived physical join"
        );
    }
}
