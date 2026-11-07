use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

pub(crate) struct TestHost {
    pub(crate) gate: Arc<Mutex<()>>,
    pub(crate) claimed: AtomicBool,
    pub(crate) launches: AtomicUsize,
    pub(crate) finished: Mutex<Vec<Completion>>,
    pub(crate) grant: Mutex<Option<LaunchGrant>>,
    pub(crate) control: Control,
    pub(crate) fail_finish: bool,
    pub(crate) human_open: AtomicUsize,
    pub(crate) human_closed: AtomicUsize,
}
impl TestHost {
    pub(crate) fn new(grant: LaunchGrant) -> Self {
        Self {
            gate: Arc::new(Mutex::new(())),
            claimed: AtomicBool::new(false),
            launches: AtomicUsize::new(0),
            finished: Mutex::new(vec![]),
            grant: Mutex::new(Some(grant)),
            control: control(),
            fail_finish: false,
            human_open: AtomicUsize::new(0),
            human_closed: AtomicUsize::new(0),
        }
    }
}
#[async_trait]
impl HostPort for TestHost {
    async fn claim(&self, _: &CallRequest) -> Result<ClaimedCall> {
        if self.claimed.swap(true, Ordering::SeqCst) {
            return Err(CallError::new("UNCERTAIN", "already claimed"));
        }
        Ok(ClaimedCall {
            ticket: "claimed".into(),
            control: self.control.clone(),
        })
    }
    fn launch_gate(&self) -> Arc<Mutex<()>> {
        self.gate.clone()
    }
    async fn authorize_launch(&self, _: &CallRequest, _: &str) -> Result<LaunchGrant> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        self.grant
            .lock()
            .await
            .take()
            .ok_or_else(|| CallError::new("CORRELATION", "grant consumed"))
    }
    async fn finish(&self, _: &str, completion: &Completion) -> Result<()> {
        if self.fail_finish {
            return Err(CallError::new("UNCERTAIN", "durable finish unavailable"));
        }
        self.finished.lock().await.push(completion.clone());
        Ok(())
    }
    async fn human_open(&self, _: &CallIdentity, _: &str, raw: &str) -> Result<String> {
        self.human_open.fetch_add(1, Ordering::SeqCst);
        Ok(if raw.contains("input_required") {
            "modern"
        } else {
            "legacy"
        }
        .into())
    }
    async fn human_answer(&self, ticket: &str) -> Result<String> {
        tokio::time::sleep(Duration::from_millis(30)).await;
        Ok(if ticket == "modern" {
            r#"{"ask":{"action":"decline"}}"#
        } else {
            r#"{"action":"decline"}"#
        }
        .into())
    }
    async fn human_close(&self, _: &str, _: &Result<String>) -> Result<()> {
        self.human_closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
pub(crate) fn control() -> Control {
    Control {
        stop: CancellationToken::new(),
        machine_timeout: CancellationToken::new(),
    }
}
pub(crate) fn identity() -> CallIdentity {
    CallIdentity {
        system_id: "system".into(),
        run_id: "run".into(),
        group_id: "group".into(),
        work_id: "work".into(),
        epoch: "1".into(),
        effect_id: "effect".into(),
        provider_attempt_id: Some("provider".into()),
        native_call_id: "native-call".into(),
    }
}
pub(crate) fn grant(root: &std::path::Path) -> CommandGrant {
    CommandGrant {
        workspace: root.canonicalize().unwrap(),
        environment: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        sandbox: crate::agsdl_host_confinement::tests::test_policy(root, false),
    }
}

#[tokio::test]
async fn stopped_claim_never_authorizes_io_and_lost_receipt_never_replays() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(TestHost::new(LaunchGrant::Command(grant(root.path()))));
    host.control.stop.cancel();
    let request = CallRequest {
        identity: identity(),
        invocation: Invocation::Command {
            command: "exit 0".into(),
            parse: None,
        },
    };
    let result = execute(host.clone(), request.clone()).await.unwrap();
    assert_eq!(result.failure.unwrap().code, "STOPPED");
    assert_eq!(host.launches.load(Ordering::SeqCst), 0);
    assert!(execute(host.clone(), request).await.is_err());
    assert_eq!(host.finished.lock().await.len(), 1);
}

#[tokio::test]
async fn collector_retains_calls_and_explicitly_bounds_checks() {
    let bytes = vec![b'a'; 9 * 1024 * 1024];
    let full = collect(bytes.as_slice(), None).await.unwrap();
    assert_eq!(full.bytes.len(), bytes.len());
    let bounded = collect(bytes.as_slice(), Some(128)).await.unwrap();
    assert_eq!(bounded.total, bytes.len() as u64);
    assert_eq!(bounded.bytes.len(), 128);
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
#[ignore = "Real Darwin Seatbelt/process test; run outside the agent sandbox"]
async fn darwin_calls_checks_stop_and_finish_loss() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(TestHost::new(LaunchGrant::Command(grant(root.path()))));
    let request = CallRequest {
        identity: identity(),
        invocation: Invocation::Command {
            command: "printf '9007199254740993'; printf err >&2; exit 7".into(),
            parse: Some(CommandParse::Json),
        },
    };
    let result = execute(host.clone(), request).await.unwrap();
    assert!(result.failure.is_none(), "{:?}", result.failure);
    let RawReceipt::Command { receipt } = result.receipt.unwrap() else {
        panic!()
    };
    assert_eq!(receipt.stdout, "9007199254740993");
    assert_eq!(receipt.stderr, "err");
    assert_eq!(receipt.exit_code_json, "7");
    assert!(receipt.complete);
    assert!(matches!(
        result.evidence,
        PhysicalEvidence::Local {
            leader_reaped: true,
            tree_termination_succeeded: true,
            streams_joined: true,
            ..
        }
    ));

    let host = Arc::new(TestHost::new(LaunchGrant::Command(grant(root.path()))));
    let check = CallRequest {
        identity: identity(),
        invocation: Invocation::CompletionCheck {
            command: "printf 123456789; printf abcdefghi >&2".into(),
            candidate_json: "{\"n\":9007199254740993}".into(),
            output_limit: 4,
            limit_ms: 2000,
        },
    };
    let result = execute(host, check).await.unwrap();
    let RawReceipt::CompletionCheck { receipt } = result.receipt.unwrap() else {
        panic!()
    };
    assert_eq!(receipt.stdout, "1234");
    assert_eq!(receipt.stderr, "abcd");
    assert!(receipt.truncated);
    assert!(!receipt.complete);

    let host = Arc::new(TestHost::new(LaunchGrant::Command(grant(root.path()))));
    let stop = host.control.stop.clone();
    let request = CallRequest {
        identity: identity(),
        invocation: Invocation::Command {
            command: "sleep 300 & printf '%s' $!; wait".into(),
            parse: None,
        },
    };
    let running = tokio::spawn(execute(host.clone(), request));
    tokio::time::sleep(Duration::from_millis(200)).await;
    stop.cancel();
    let result = running.await.unwrap().unwrap();
    assert_eq!(result.failure.unwrap().code, "STOPPED");
    let RawReceipt::Command { receipt } = result.receipt.unwrap() else {
        panic!()
    };
    let pid: i32 = receipt.stdout.parse().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while unsafe { libc::kill(pid, 0) } == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "descendant survived Stop"
    );

    let mut host = TestHost::new(LaunchGrant::Command(grant(root.path())));
    host.fail_finish = true;
    let host = Arc::new(host);
    let request = CallRequest {
        identity: identity(),
        invocation: Invocation::Command {
            command: "printf x >> effect".into(),
            parse: None,
        },
    };
    assert!(execute(host.clone(), request.clone()).await.is_err());
    assert!(execute(host, request).await.is_err());
    assert_eq!(std::fs::read(root.path().join("effect")).unwrap(), b"x");
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
#[ignore = "Real Darwin Seatbelt process; run outside the agent sandbox"]
async fn service_keeps_effect_owner_when_waiters_are_cancelled() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(TestHost::new(LaunchGrant::Command(grant(root.path()))));
    let service = Arc::new(HostCallService::new());
    let gate = host.gate.lock().await;
    let request = CallRequest {
        identity: identity(),
        invocation: Invocation::Command {
            command: "printf done > effect".into(),
            parse: None,
        },
    };
    let waiting = {
        let host = host.clone();
        let service = service.clone();
        tokio::spawn(async move { service.execute(host, request).await })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while !host.claimed.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    waiting.abort();
    let _ = waiting.await;
    let closing = {
        let service = service.clone();
        tokio::spawn(async move { service.close_and_join().await })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while !service.closed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    closing.abort();
    let _ = closing.await;
    drop(gate);
    tokio::time::timeout(Duration::from_secs(10), service.close_and_join())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(root.path().join("effect")).unwrap(), b"done");
    assert_eq!(host.finished.lock().await.len(), 1);
    assert!(service.jobs.lock().await.is_none());
}

#[tokio::test]
async fn service_reports_failed_durable_finish_after_caller_has_gone() {
    let root = tempfile::tempdir().unwrap();
    let mut host = TestHost::new(LaunchGrant::Command(grant(root.path())));
    host.fail_finish = true;
    host.control.stop.cancel();
    let service = HostCallService::new();
    let request = CallRequest {
        identity: identity(),
        invocation: Invocation::Command {
            command: "exit 0".into(),
            parse: None,
        },
    };
    assert_eq!(
        service
            .execute(Arc::new(host), request)
            .await
            .unwrap_err()
            .code,
        "UNCERTAIN"
    );
    assert_eq!(
        service.close_and_join().await.unwrap_err().code,
        "UNCERTAIN"
    );
    assert_eq!(
        service.close_and_join().await.unwrap_err().code,
        "UNCERTAIN"
    );
}
