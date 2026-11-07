use super::*;
use std::collections::BTreeMap;
use tokio::io::AsyncReadExt;

pub(crate) fn test_policy(root: &Path, network: bool) -> SandboxPolicy {
    let mut allow = vec![
        PathScope::Literal(PathBuf::from("/")),
        PathScope::Subtree(root.canonicalize().unwrap()),
        PathScope::Subtree(PathBuf::from("/private/var/select")),
    ];
    // Test-only explicit runtime grants. Production adds none automatically.
    for path in ["/bin", "/usr/bin", "/usr/lib", "/System/Library", "/dev"] {
        allow.push(PathScope::Subtree(
            PathBuf::from(path).canonicalize().unwrap(),
        ));
    }
    SandboxPolicy::from_authorized_ceilings(
        "test-policy".into(),
        &[OsCeiling {
            read: FileAccess {
                allow,
                block: vec![],
            },
            write: FileAccess {
                allow: vec![
                    PathScope::Subtree(root.canonicalize().unwrap()),
                    PathScope::Literal("/dev/null".into()),
                ],
                block: vec![],
            },
            network,
        }],
    )
    .unwrap()
}

#[test]
fn lowering_intersects_ceilings_and_rejects_injection_or_aliases() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap();
    let full = OsCeiling {
        read: FileAccess {
            allow: vec![PathScope::Subtree(path.clone())],
            block: vec![],
        },
        write: FileAccess::default(),
        network: true,
    };
    let none = OsCeiling::default();
    let policy = SandboxPolicy::from_authorized_ceilings("p".into(), &[full, none]).unwrap();
    assert!(!policy.profile.contains("allow file-read"));
    assert!(!policy.profile.contains("allow network"));
    assert!(SandboxPolicy::from_authorized_ceilings("".into(), &[]).is_err());
    assert!(scope(&PathScope::Literal("relative".into())).is_err());
    assert!(quoted(Path::new("/tmp/a\n(allow default)")).is_err());
    assert_eq!(quoted(Path::new("/tmp/a\"b")).unwrap(), "\"/tmp/a\\\"b\"");
    #[cfg(unix)]
    {
        let link = path.join("alias");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(scope(&PathScope::Subtree(link)).is_err());
    }
}

async fn probe(policy: &SandboxPolicy, cwd: &Path, script: &str) -> (i32, String, String) {
    let mut child = policy
        .spawn(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            cwd,
            &BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        )
        .unwrap();
    let mut out = child.take_stdout().unwrap();
    let mut err = child.take_stderr().unwrap();
    let stdout = tokio::spawn(async move {
        let mut s = String::new();
        out.read_to_string(&mut s).await.unwrap();
        s
    });
    let stderr = tokio::spawn(async move {
        let mut s = String::new();
        err.read_to_string(&mut s).await.unwrap();
        s
    });
    let status = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
        .await
        .unwrap()
        .unwrap();
    child.terminate_bounded().await.unwrap();
    (
        status.code().unwrap_or(-1),
        stdout.await.unwrap(),
        stderr.await.unwrap(),
    )
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
#[ignore = "Real Darwin Seatbelt probe; run explicitly outside the agent sandbox"]
async fn darwin_read_write_outside_symlink_network_and_descendant_probes() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let outside = outside.path().canonicalize().unwrap();
    std::fs::write(root.join("readable"), "allowed").unwrap();
    std::fs::write(outside.join("secret"), "outside-secret").unwrap();
    std::fs::create_dir(root.join("readonly")).unwrap();
    let mut ceiling = OsCeiling {
        read: FileAccess {
            allow: vec![
                PathScope::Literal(PathBuf::from("/")),
                PathScope::Subtree(root.clone()),
                PathScope::Subtree(PathBuf::from("/private/var/select")),
            ],
            block: vec![],
        },
        write: FileAccess {
            allow: vec![
                PathScope::Subtree(root.clone()),
                PathScope::Literal("/dev/null".into()),
            ],
            block: vec![PathScope::Subtree(root.join("readonly"))],
        },
        network: false,
    };
    for path in ["/bin", "/usr/bin", "/usr/lib", "/System/Library", "/dev"] {
        ceiling.read.allow.push(PathScope::Subtree(
            PathBuf::from(path).canonicalize().unwrap(),
        ));
    }
    let policy = SandboxPolicy::from_authorized_ceilings("os-probe".into(), &[ceiling]).unwrap();
    let good = probe(
        &policy,
        &root,
        "cat readable; printf written > writable; cat writable",
    )
    .await;
    assert_eq!(good.0, 0, "{good:?}");
    assert_eq!(good.1, "allowedwritten");
    let read = probe(
        &policy,
        &root,
        &format!("cat '{}/secret'", outside.display()),
    )
    .await;
    assert_ne!(read.0, 0, "{read:?}");
    assert!(!read.1.contains("outside-secret"));
    let write = probe(&policy, &root, "printf forbidden > readonly/file").await;
    assert_ne!(write.0, 0);
    assert!(!root.join("readonly/file").exists());
    let outside_write = probe(
        &policy,
        &root,
        &format!("printf forbidden > '{}/new'", outside.display()),
    )
    .await;
    assert_ne!(outside_write.0, 0);
    assert!(!outside.join("new").exists());
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let escape = probe(
        &policy,
        &root,
        "cat link/secret; printf forbidden > link/created",
    )
    .await;
    assert_ne!(escape.0, 0);
    assert!(!outside.join("created").exists());
    let descendant = probe(
        &policy,
        &root,
        &format!("/bin/sh -c \"cat '{}/secret'\"", outside.display()),
    )
    .await;
    assert_ne!(descendant.0, 0);
    assert!(!descendant.1.contains("outside-secret"));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let denied = probe(&policy, &root, &format!("nc -z -G 1 127.0.0.1 {port}")).await;
    assert_ne!(denied.0, 0, "network deny: {denied:?}");
    let allowed = probe(
        &test_policy(&root, true),
        &root,
        &format!("nc -z -G 1 127.0.0.1 {port}"),
    )
    .await;
    assert_eq!(allowed.0, 0, "network allow control: {allowed:?}");
    eprintln!(
        "Darwin read/write/outside/symlink/network/descendant-denial probes passed; profile {}",
        policy.profile_digest()
    );
}
