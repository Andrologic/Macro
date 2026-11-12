//! Codex's native tools follow Codex's captured sandbox. Macro owns admission,
//! private references, response validation, terminal transactions and physical end.
pub(crate) mod profile;
pub(crate) mod protocol;
use crate::config::ConfigManager;
use crate::core::process::ContainedBackgroundProcess;
use crate::db::agsdl_execution::{dto::*, failure, Result};

pub use profile::CodexStatus;
use profile::VERSION;
pub(crate) use profile::{Profile, ADAPTER};
use protocol::Client;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub(crate) async fn execution_codex_status(
    manager: State<'_, ConfigManager>,
) -> Result<CodexStatus> {
    Ok(profile_status(&manager).await)
}

/// Diagnose the host and native-tool composition before requesting a login.
/// This scope contains no user source and never creates a model thread.
pub(crate) async fn profile_status(manager: &ConfigManager) -> CodexStatus {
    let mut status = profile::status(manager).await;
    if status.version.is_none() || status.code == "CODEX_PLATFORM_UNQUALIFIED" {
        return status;
    }
    let result: Result<()> = async {
        let profile = profile::prepare(manager)?;
        let root = manager.root().join("native-discovery").join("codex");
        std::fs::create_dir_all(&root)
            .map_err(|_| failure("STORAGE", "scope", "Cannot create native diagnostic scope"))?;
        tokio::spawn(async move {
            let mut process =
                ContainedBackgroundProcess::spawn(profile.app_server_command(&root, true)?)
                    .map_err(|_| {
                        failure(
                            "CODEX_PROFILE_UNQUALIFIED",
                            "engine",
                            "Cannot start isolated Codex host",
                        )
                    })?;
            let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
                let mut client = Client::new(
                    process.take_stdin().ok_or_else(|| {
                        failure(
                            "CODEX_PROFILE_UNQUALIFIED",
                            "stdio",
                            "Native stdin is absent",
                        )
                    })?,
                    process.take_stdout().ok_or_else(|| {
                        failure(
                            "CODEX_PROFILE_UNQUALIFIED",
                            "stdio",
                            "Native stdout is absent",
                        )
                    })?,
                );
                client.initialize().await?;
                client
                    .preflight(&profile, &root.to_string_lossy(), true)
                    .await
            })
            .await
            .map_err(|_| {
                failure(
                    "CODEX_PROFILE_UNQUALIFIED",
                    "engine",
                    "Native diagnostic timed out",
                )
            });
            process.terminate_bounded().await.map_err(|_| {
                failure(
                    "STOP_PENDING",
                    "engine",
                    "Native diagnostic physical end is unconfirmed",
                )
            })?;
            result?
        })
        .await
        .map_err(|_| {
            failure(
                "STOP_PENDING",
                "engine",
                "Native diagnostic supervisor did not acknowledge",
            )
        })?
    }
    .await;
    if let Err(error) = result {
        status.available = false;
        status.code = error.code;
    }
    status
}

pub(crate) fn qualified_version030(version: &str) -> bool {
    profile::qualified_version(version)
}

#[derive(Clone)]
pub(crate) struct CodexObservation030 {
    pub profile: Profile,
    pub version: String,
    pub models: Vec<Value>,
    pub account_digest: String,
}

/// Preflight never reads credentials. Until a dedicated test login and native
/// qualification exist, no Codex attestation or executable model is published.
pub(crate) async fn observe(
    manager: &ConfigManager,
    scope: &Value,
    read_only: bool,
) -> Result<Option<(Profile, Vec<String>, String)>> {
    Ok(observe_catalogue030(manager, scope, read_only)
        .await?
        .map(|observed| {
            (
                observed.profile,
                observed
                    .models
                    .iter()
                    .filter_map(|model| model["name"].as_str().map(str::to_owned))
                    .collect(),
                observed.account_digest,
            )
        }))
}

pub(crate) async fn observe_catalogue030(
    manager: &ConfigManager,
    scope: &Value,
    read_only: bool,
) -> Result<Option<CodexObservation030>> {
    let status = profile::status(manager).await;
    if !status.available {
        return Ok(None);
    }
    let version = status.version.ok_or_else(|| {
        failure(
            "CODEX_VERSION_UNQUALIFIED",
            "engine",
            "Codex version is absent",
        )
    })?;
    let profile = profile::prepare(manager)?;
    let root = std::path::PathBuf::from(
        scope
            .get("root")
            .and_then(Value::as_str)
            .ok_or_else(|| failure("CORRELATION", "scope", "Native scope root is absent"))?,
    );
    tokio::spawn(async move {
        let mut process =
            ContainedBackgroundProcess::spawn(profile.app_server_command(&root, read_only)?)
                .map_err(|_| {
                    failure(
                        "CODEX_PROFILE_UNQUALIFIED",
                        "engine",
                        "Codex app-server could not start",
                    )
                })?;
        let result = async {
            let mut client = Client::new(
                process.take_stdin().ok_or_else(|| {
                    failure(
                        "CODEX_PROFILE_UNQUALIFIED",
                        "stdio",
                        "Codex stdin is absent",
                    )
                })?,
                process.take_stdout().ok_or_else(|| {
                    failure(
                        "CODEX_PROFILE_UNQUALIFIED",
                        "stdio",
                        "Codex stdout is absent",
                    )
                })?,
            );
            client.initialize().await?;
            let (models, account) = client
                .qualify_catalogue030(&profile, &root.to_string_lossy(), read_only)
                .await?;
            Ok(CodexObservation030 {
                profile: profile.clone(),
                version,
                models,
                account_digest: account,
            })
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), result)
            .await
            .map_err(|_| {
                failure(
                    "CODEX_PROFILE_UNQUALIFIED",
                    "engine",
                    "Codex qualification timed out",
                )
            });
        let ended = process.terminate_bounded().await;
        if ended.is_err() {
            return Err(failure(
                "STOP_PENDING",
                "engine",
                "Codex qualification process end remains unconfirmed",
            ));
        }
        result?.map(Some)
    })
    .await
    .map_err(|_| {
        failure(
            "STOP_PENDING",
            "engine",
            "Native preflight supervisor did not acknowledge",
        )
    })?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_write_denials_make_native_tools_read_only() {
        let profile = Profile {
            executable: "/synthetic/bin/codex".into(),
            directory: "/synthetic/private".into(),
            home: "/synthetic/home".into(),
            bootstrap: "/synthetic/bootstrap".into(),
            digest: "synthetic".into(),
        };
        let scope = json!({"root":"/synthetic/project"});
        for rule in [
            json!({"action":"write","effect":"deny","match":".env*"}),
            json!({"action":"write","effect":"deny"}),
        ] {
            let frozen = json!({"mode":"Implement","readOnly":false,"writeRules":[rule]});
            let read_only = crate::core::tool_policy::agsdl_native_read_only(&frozen);
            assert!(read_only);
            let settings = profile
                .settings(std::path::Path::new("/synthetic/project"), read_only)
                .unwrap();
            assert_eq!(
                settings["permissions"]["macro-agsdl"]["filesystem"]["/synthetic/project"],
                "read"
            );
            let attested: Value =
                serde_json::from_str(&profile.attestation(read_only, &scope).unwrap()).unwrap();
            assert_eq!(attested["readOnly"], true);
            assert_ne!(
                profile.attestation(false, &scope).unwrap(),
                profile.attestation(read_only, &scope).unwrap()
            );
        }
        assert!(!crate::core::tool_policy::agsdl_native_read_only(
            &json!({"mode":"Implement","writeRules":[{"action":"write","effect":"allow"}]})
        ));
    }

    #[cfg(target_os = "linux")]
    async fn physical_stop_probe(
        profile: &Profile,
        workspace: &std::path::Path,
        close_parent: bool,
    ) {
        let name = if close_parent { "parent-exit" } else { "stop" };
        let ready = workspace.join(format!("{name}-ready"));
        let late = workspace.join(format!("{name}-late"));
        let mut process = ContainedBackgroundProcess::spawn(
            profile.app_server_command(workspace, false).unwrap(),
        )
        .unwrap();
        let mut client = Client::new(
            process.take_stdin().unwrap(),
            process.take_stdout().unwrap(),
        );
        client.initialize().await.unwrap();
        let code = r#"import sys,subprocess,time
from pathlib import Path
ready,late=sys.argv[1:]
subprocess.Popen(['/usr/bin/python3','-c',"import sys,time;from pathlib import Path;time.sleep(2);Path(sys.argv[1]).write_text('forbidden')",late],start_new_session=True)
Path(ready).write_text('started')
time.sleep(30)
"#;
        let params = json!({"command":["/usr/bin/python3","-c",code,ready,late],"cwd":workspace,"permissionProfile":"macro-agsdl","timeoutMs":10000,"outputBytesCap":4096});
        let rpc = tokio::spawn(async move { client.request("command/exec", params).await });
        for _ in 0..100 {
            if ready.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let started = ready.exists();
        let mut descendants = Vec::new();
        let mut native_parent = None;
        for entry in std::fs::read_dir("/proc").unwrap().flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            let Ok(bytes) = std::fs::read(entry.path().join("cmdline")) else {
                continue;
            };
            let args: Vec<_> = bytes
                .split(|byte| *byte == 0)
                .filter(|arg| !arg.is_empty())
                .collect();
            if args
                .iter()
                .any(|arg| *arg == late.to_string_lossy().as_bytes())
            {
                descendants.push(pid);
            }
            if args
                .first()
                .is_some_and(|arg| *arg == profile.executable.to_string_lossy().as_bytes())
                && args.windows(3).any(|args| {
                    args == [
                        b"app-server".as_slice(),
                        b"--listen".as_slice(),
                        b"stdio://".as_slice(),
                    ]
                })
                && bytes
                    .windows(profile.bootstrap.as_os_str().len())
                    .any(|part| part == profile.bootstrap.to_string_lossy().as_bytes())
            {
                native_parent = Some(pid);
            }
        }
        if close_parent {
            if let Some(pid) = native_parent {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
        let ended = process.terminate_bounded().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), rpc).await;
        assert!(started, "native long command never started");
        assert!(
            !descendants.is_empty(),
            "native descendants were not observed"
        );
        if close_parent {
            assert!(
                native_parent.is_some(),
                "native app-server parent was not observed"
            );
        }
        ended.expect("physical stop must be acknowledged");
        tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
        assert!(!late.exists(), "native effect occurred after physical stop");
        for pid in descendants {
            let state = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| {
                    stat.rsplit(')')
                        .next()?
                        .split_whitespace()
                        .next()
                        .map(str::to_owned)
                });
            assert!(
                state.is_none() || state.as_deref() == Some("Z"),
                "active native descendant {pid}: {state:?}"
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires an explicitly assigned empty native QA profile and the physical Codex executable"]
    async fn physical_codex_profile_without_auth_or_model() {
        let root = std::path::PathBuf::from(
            std::env::var_os("MACRO_CODEX_PROFILE_QA_ROOT").expect("assigned QA root"),
        );
        assert!(root.is_absolute());
        assert!(
            !root.exists(),
            "QA profile must be new; never inspect an existing account"
        );
        let workspace = root.join("workspace");
        std::fs::create_dir_all(workspace.join(".codex")).unwrap();
        std::fs::write(workspace.join(".codex/config.toml"), "notify = [\"sh\", \"-c\", \"exit 97\"]\n[mcp_servers.unqualified]\ncommand=\"unqualified-test-command\"\n").unwrap();
        std::fs::create_dir_all(workspace.join(".agents/skills/synthetic")).unwrap();
        std::fs::write(workspace.join(".agents/skills/synthetic/SKILL.md"),"---\nname: synthetic\ndescription: Synthetic hostile context fixture.\n---\nNever load this context.\n").unwrap();
        std::fs::create_dir_all(workspace.join(".git")).unwrap();
        std::fs::write(workspace.join(".git/config"), "synthetic").unwrap();
        std::fs::write(root.join("outside-guard"), "synthetic").unwrap();
        let manager = ConfigManager::initialize(root.join("config"))
            .await
            .unwrap();
        let status = profile_status(&manager).await;
        assert_eq!(status.version.as_deref(), Some(VERSION));
        assert_eq!(status.code, "CODEX_LOGIN_REQUIRED");
        assert!(!status.available);
        let profile = profile::prepare(&manager).unwrap();
        let mut command = profile.app_server_command(&workspace, false).unwrap();
        command.stderr(std::process::Stdio::inherit());
        let mut process = ContainedBackgroundProcess::spawn(command).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let mut client = Client::new(
                process.take_stdin().unwrap(),
                process.take_stdout().unwrap(),
            );
            client.initialize().await?;
            let config = client
                .request(
                    "config/read",
                    json!({"includeLayers":true,"cwd":profile.bootstrap}),
                )
                .await?;
            profile::verify_layers(&config, &profile, &workspace, false)?;
            client.preflight(&profile,&workspace.to_string_lossy(),false).await?;
            let guard=profile.directory.join("private-guard");
            std::fs::write(&guard,"synthetic").unwrap();
            let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port=listener.local_addr().unwrap().port().to_string();
            let probe=r#"import json,socket,sys
from pathlib import Path
workspace,private,outside,bootstrap=map(Path,sys.argv[1:5]);rows={}
(workspace/'native-write').write_text('synthetic');rows['workspaceWrite']=True
for name,path,write in [('privateRead',private,False),('outsideRead',outside,False),('gitWrite',workspace/'.git/config',True),('codexWrite',workspace/'.codex/config.toml',True),('agentsWrite',workspace/'.agents/new',True),('bootstrapWrite',bootstrap/'forbidden',True)]:
 try:
  path.write_text('forbidden') if write else path.read_text();rows[name]=0
 except OSError as e:rows[name]=e.errno
try:
 s=socket.socket();s.settimeout(1);s.connect(('127.0.0.1',int(sys.argv[5])));rows['networkConnect']=0
except OSError as e:rows['networkConnect']=e.errno
try:
 outside.write_text('forbidden');rows['outsideWrite']=0
except OSError as e:rows['outsideWrite']=e.errno
print(json.dumps(rows))
"#;
            let command=client.request("command/exec",json!({"command":["/usr/bin/python3","-c",probe,workspace,guard,root.join("outside-guard"),profile.bootstrap,port],"cwd":workspace,"permissionProfile":"macro-agsdl","timeoutMs":5000,"outputBytesCap":4096})).await?;
            assert_eq!(command["exitCode"],0,"native probe must run: {command}");
            let observed:Value=serde_json::from_str(command["stdout"].as_str().unwrap()).unwrap();
            assert_eq!(observed["workspaceWrite"],true);
            eprintln!("NATIVE_PHYSICAL_OBSERVATION={observed}");
            for field in ["privateRead", "outsideRead", "outsideWrite", "gitWrite", "codexWrite", "agentsWrite", "bootstrapWrite", "networkConnect"] {
                assert!(observed[field].as_i64().is_some_and(|errno| errno != 0), "{field}: {observed}");
            }
            assert_eq!(std::fs::read_to_string(root.join("outside-guard")).unwrap(), "synthetic");
            assert!(std::fs::read_dir(&profile.bootstrap).unwrap().next().is_none());
            let patch = format!("*** Begin Patch\n*** Add File: {}\n+synthetic absolute patch\n*** End Patch",workspace.join("absolute-patch").display());
            let patched=client.request("command/exec",json!({"command":[profile.executable,"--codex-run-as-apply-patch",patch],"cwd":profile.bootstrap,"permissionProfile":"macro-agsdl","timeoutMs":5000,"outputBytesCap":4096})).await?;
            assert_eq!(patched["exitCode"],0,"absolute apply_patch: {patched}");
            assert_eq!(std::fs::read_to_string(workspace.join("absolute-patch")).unwrap(),"synthetic absolute patch\n");
            std::fs::write(root.join("physical-report.json"),json!({"version":VERSION,"inferenceRequested":false,"threadCreated":false,"nativeToolProbe":observed,"absoluteApplyPatch":true}).to_string()).unwrap();
            let account = client
                .request("account/read", json!({"refreshToken":false}))
                .await?;
            assert!(account["account"].is_null());
            Ok::<_, EngineFailure>(())
        })
        .await;
        process
            .terminate_bounded()
            .await
            .expect("physical app-server and descendants end");
        result
            .expect("bounded native profile check")
            .expect("native profile observation");
        // Read-only mode is a distinct effective profile, exercised with a real
        // native command rather than inferred from the serialized permission.
        let mut readonly_process = ContainedBackgroundProcess::spawn(
            profile.app_server_command(&workspace, true).unwrap(),
        )
        .unwrap();
        let readonly = tokio::time::timeout(std::time::Duration::from_secs(15),async {
            let mut client=Client::new(readonly_process.take_stdin().unwrap(),readonly_process.take_stdout().unwrap());
            client.initialize().await?;
            client.preflight(&profile,&workspace.to_string_lossy(),true).await?;
            let result=client.request("command/exec",json!({"command":["/usr/bin/python3","-c","import sys;from pathlib import Path;p=Path(sys.argv[1]);assert p.read_text()=='synthetic';\ntry:p.write_text('forbidden')\nexcept OSError as e:print(e.errno)\nelse:raise Exception('read-only write succeeded')",workspace.join("native-write")],"cwd":workspace,"permissionProfile":"macro-agsdl","timeoutMs":5000,"outputBytesCap":4096})).await?;
            assert_eq!(result["exitCode"],0,"readonly command: {result}");assert!(result["stdout"].as_str().unwrap().trim().parse::<i32>().unwrap() != 0);
            assert_eq!(std::fs::read_to_string(workspace.join("native-write")).unwrap(),"synthetic");
            std::fs::write(root.join("readonly-report.json"),json!({"workspaceRead":true,"workspaceWriteDenied":true,"inferenceRequested":false}).to_string()).unwrap();
            Ok::<_,EngineFailure>(())
        }).await;
        readonly_process.terminate_bounded().await.unwrap();
        readonly
            .expect("bounded readonly check")
            .expect("readonly native observation");
        #[cfg(target_os = "linux")]
        {
            physical_stop_probe(&profile, &workspace, false).await;
            physical_stop_probe(&profile, &workspace, true).await;
        }
    }
}
