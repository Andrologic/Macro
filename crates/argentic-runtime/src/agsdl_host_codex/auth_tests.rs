//! Synthetic protocol peers only. Never selects the installed CLI or a real home.
use super::*;
use crate::process::{background_contained_tokio_command, ContainedBackgroundProcess};
use std::process::Stdio;

const SERVER: &str = r#"
import json,sys,base64,os
source,mode,settings,bootstrap,profile=sys.argv[1:]
settings=json.loads(settings)
methods=[]; account='synthetic-account'; refreshed=False; authed=False; exercise=None
def emit(v): print(json.dumps(v),flush=True)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); i=m.get('id'); p=m.get('params',{})
 if method is None:
  if i=='approval':
   emit({'method':'test/approvalObserved','params':{'decision':m['result']['decision']}}); continue
  assert i=='auth-1'
  credential=json.load(open(source))['tokens']
  assert m['result']=={'accessToken':credential['access_token'],'chatgptAccountId':credential['account_id']}
  refreshed=True
  emit({'id':exercise,'result':{'ok':True}})
  continue
 methods.append(method)
 if i is None: continue
 if method=='initialize': result={}
 elif method=='config/read':
  observed=json.loads(json.dumps(settings))
  if (authed and mode=='post-login-config') or (refreshed and mode=='post-refresh-config'): observed['features']['hooks']=True
  result={'layers':[{'name':{'type':'sessionFlags'},'config':observed}],'config':observed}
 elif method=='skills/list': result={'data':[{'cwd':bootstrap,'skills':[],'errors':[]}]}
 elif method=='command/exec': result={'exitCode':0}
 elif method=='account/login/start':
  assert methods[:6]==['initialize','initialized','config/read','skills/list','command/exec','account/login/start']
  credential=json.load(open(source))['tokens']
  assert p=={'type':'chatgptAuthTokens','accessToken':credential['access_token'],'chatgptAccountId':account}
  if mode=='login-error':
   emit({'id':i,'error':{'code':401,'message':p['accessToken'],'data':{'auth':json.load(open(source))}}}); continue
  if mode=='login-timeout': continue
  authed=True
  if mode=='persist-auth':
   with open(profile+'/codex/auth.json','w') as f: json.dump(p,f)
  result={'type':'chatgptAuthTokens'}
 elif method=='account/read':
  if refreshed and mode=='refresh-timeout': continue
  routing={'chatgptAccountId':account,'backendOrigin':'https://chatgpt.com','accountRoutingOverride':'NO_CONSTRAINT'}
  if refreshed and mode=='route-change': routing['backendOrigin']='https://changed.invalid'
  if mode=='missing-routing': routing={}
  result={'account':{'type':'chatgpt'},'workspaceRouting':routing}
 elif method=='exercise':
  exercise=i
  if mode!='same-token':
   record=json.load(open(source))
   payload=base64.urlsafe_b64encode(json.dumps({'exp':1 if mode=='expired-token' else 18446744073709551615,'generation':'rotated'}).encode()).decode().rstrip('=')
   record['tokens']['access_token']='e30.'+payload+'.synthetic'
   if mode=='source-change': record['tokens']['account_id']='other-account'
   with open(source+'.next','w') as f: json.dump(record,f)
   os.chmod(source+'.next',0o600); os.replace(source+'.next',source)
  emit({'id':'auth-1','method':'account/chatgptAuthTokens/refresh','params':{'reason':'unauthorized','previousAccountId':account if mode!='foreign-callback' else 'other-account'}})
  continue
 else: raise Exception('unexpected method')
 emit({'id':i,'result':result})
"#;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    source: PathBuf,
    profile: Profile,
    process: ContainedBackgroundProcess,
    client: Client,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let source = root.join("ordinary.json");
        auth::fixture_file(&source, "synthetic-account", u64::MAX, "initial");
        for name in ["workspace", "profile", "bootstrap", "profile/codex"] {
            std::fs::create_dir(root.join(name)).unwrap();
        }
        let profile = Profile {
            executable: root.join("bin/codex"),
            directory: root.join("profile"),
            home: root.join("profile/home"),
            bootstrap: root.join("bootstrap"),
            digest: "synthetic".into(),
        };
        let settings = profile.settings(&root.join("workspace"), true).unwrap();
        let mut command = background_contained_tokio_command("/usr/bin/python3");
        command
            .args(["-u", "-c", SERVER])
            .arg(&source)
            .arg(mode)
            .arg(settings.to_string())
            .arg(&profile.bootstrap)
            .arg(&profile.directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut process = ContainedBackgroundProcess::spawn(command).unwrap();
        let mut client = Client::new(
            process.take_stdin().unwrap(),
            process.take_stdout().unwrap(),
        );
        client.use_auth_source(Some(source.clone()), None);
        Self {
            _temp: temp,
            root,
            source,
            profile,
            process,
            client,
        }
    }
    async fn bootstrap(&mut self) -> Result<()> {
        self.client.initialize().await?;
        self.client
            .preflight(
                &self.profile,
                self.root.join("workspace").to_str().unwrap(),
                true,
            )
            .await
    }
    async fn end(mut self) {
        drop(self.client);
        self.process.terminate_bounded().await.unwrap();
    }
}

#[tokio::test]
async fn external_auth_bootstrap_and_refresh_preserve_private_config_and_rpc_order() {
    for notification in [false, true] {
        let mut f = Fixture::new("ok");
        let source_before = std::fs::read(&f.source).unwrap();
        let settings = f.profile.settings(&f.root.join("workspace"), true).unwrap();
        f.bootstrap().await.unwrap();
        assert_eq!(std::fs::read(&f.source).unwrap(), source_before);
        auth::no_private_auth(&f.profile.directory).unwrap();
        if notification {
            let id = f.client.begin_request("exercise", json!({})).await.unwrap();
            let callback = f.client.notification().await.unwrap();
            assert!(f.client.handle_auth_request(&callback).await.unwrap());
            assert_eq!(f.client.response(id).await.unwrap(), json!({"ok":true}));
        } else {
            assert_eq!(
                f.client.request("exercise", json!({})).await.unwrap(),
                json!({"ok":true})
            );
        }
        f.client.check_auth_current().await.unwrap();
        assert_eq!(
            f.profile.settings(&f.root.join("workspace"), true).unwrap(),
            settings
        );
        assert_eq!(std::fs::read_dir(&f.profile.directory).unwrap().count(), 1);
        assert_eq!(
            std::fs::read_dir(f.profile.directory.join("codex"))
                .unwrap()
                .count(),
            0
        );
        f.end().await;
    }
}

#[tokio::test]
async fn external_auth_rejects_foreign_captured_accounts_and_missing_native_routing() {
    let mut f = Fixture::new("ok");
    f.client.expected_account = Some("different-captured-digest".into());
    assert_eq!(
        f.bootstrap().await.unwrap_err().code,
        "CODEX_AUTH_ACCOUNT_CHANGED"
    );
    f.end().await;
    let mut f = Fixture::new("post-login-config");
    assert_eq!(
        f.bootstrap().await.unwrap_err().code,
        "CODEX_PROFILE_UNQUALIFIED"
    );
    f.end().await;
    let mut f = Fixture::new("missing-routing");
    assert_eq!(f.bootstrap().await.unwrap_err().code, "CODEX_AUTH_FAILED");
    f.end().await;
}

#[tokio::test]
async fn external_auth_errors_are_typed_and_never_retain_echoed_credentials() {
    let mut f = Fixture::new("login-error");
    let token = auth::read(&f.source).await.unwrap().access_token;
    let error = f.bootstrap().await.unwrap_err();
    assert_eq!(error.code, "CODEX_AUTH_FAILED");
    let public = serde_json::to_string(&error).unwrap();
    assert!(!public.contains(&token));
    assert!(!public.contains("SYNTHETIC_REFRESH"));
    assert!(!public.contains("auth.json"));
    assert!(f
        .client
        .pending
        .iter()
        .all(|v| !v.to_string().contains(&token)));
    // A failed bootstrap cannot become a successful retry on the same client.
    assert_eq!(
        f.client
            .bootstrap_auth(&f.profile, &f.root.join("workspace"), true)
            .await
            .unwrap_err()
            .code,
        "CODEX_AUTH_FAILED"
    );
    f.end().await;
}

#[tokio::test]
async fn external_auth_refresh_refuses_rejected_tokens_foreign_callbacks_and_account_drift() {
    for (mode, code) in [
        ("same-token", "CODEX_AUTH_REFRESH_REQUIRED"),
        ("foreign-callback", "CODEX_AUTH_ACCOUNT_CHANGED"),
        ("source-change", "CODEX_AUTH_ACCOUNT_CHANGED"),
        ("route-change", "CODEX_AUTH_ACCOUNT_CHANGED"),
        ("expired-token", "CODEX_AUTH_EXPIRED"),
        ("post-refresh-config", "CODEX_PROFILE_UNQUALIFIED"),
    ] {
        let mut f = Fixture::new(mode);
        f.bootstrap().await.unwrap();
        assert_eq!(
            f.client
                .request("exercise", json!({}))
                .await
                .unwrap_err()
                .code,
            code,
            "{mode}"
        );
        assert!(f.client.check_auth_current().await.is_err());
        auth::no_private_auth(&f.profile.directory).unwrap();
        f.end().await;
    }
}

#[tokio::test]
async fn external_auth_prohibits_private_persistence_and_stale_human_replies() {
    let mut f = Fixture::new("ok");
    f.bootstrap().await.unwrap();
    let reply = f.client.reply_sender030();
    auth::fixture_file(&f.source, "different-account", u64::MAX, "new-account");
    assert_eq!(
        reply
            .answer_request030(json!("approval"), json!({"decision":"accept"}))
            .await
            .unwrap_err()
            .code,
        "CODEX_AUTH_ACCOUNT_CHANGED"
    );
    f.end().await;
    let mut f = Fixture::new("ok");
    std::fs::write(f.profile.directory.join("codex/auth.json"), "synthetic").unwrap();
    assert_eq!(
        f.bootstrap().await.unwrap_err().code,
        "CODEX_AUTH_PROFILE_CONFLICT"
    );
    f.end().await;
    let mut f = Fixture::new("persist-auth");
    assert_eq!(
        f.bootstrap().await.unwrap_err().code,
        "CODEX_AUTH_PROFILE_CONFLICT"
    );
    f.end().await;
}

#[tokio::test]
async fn external_auth_wait_rechecks_stop_before_physical_approval() {
    let mut f = Fixture::new("ok");
    f.bootstrap().await.unwrap();
    let auth = f.client.external_auth.as_ref().unwrap().clone();
    let held = auth.0.lock().await;
    let reply = f.client.reply_sender030();
    let cancel = tokio_util::sync::CancellationToken::new();
    let signal = cancel.clone();
    let send = tokio::spawn(async move {
        reply
            .answer_request_checked030(
                json!("approval"),
                || json!({"decision":if signal.is_cancelled() {"decline"} else {"accept"}}),
            )
            .await
    });
    tokio::task::yield_now().await;
    assert!(!send.is_finished());
    cancel.cancel();
    drop(held);
    send.await.unwrap().unwrap();
    let event = f.client.notification().await.unwrap();
    assert_eq!(event["params"]["decision"], "decline");
    f.end().await;
}

#[tokio::test]
async fn external_auth_deadlines_leave_process_drainage_owned() {
    for mode in ["login-timeout", "refresh-timeout"] {
        let mut f = Fixture::new(mode);
        let result = if mode == "login-timeout" {
            f.bootstrap().await
        } else {
            f.bootstrap().await.unwrap();
            f.client.request("exercise", json!({})).await.map(|_| ())
        };
        assert_eq!(result.unwrap_err().code, "CODEX_AUTH_TIMEOUT");
        assert!(
            !f.client
                .external_auth
                .as_ref()
                .unwrap()
                .0
                .lock()
                .await
                .valid
        );
        f.end().await;
    }
}
