//! Synthetic admission through the production Start and Engine APIs. No provider.
use argentic_runtime::{
    api::{StartSession, StreamTasks},
    host::{
        ActionPolicyLease, ActionPolicySource, HostContext, HostPolicyLease, PolicyFuture,
        PolicySource, ProjectPolicyLease,
    },
    persistence::{
        self,
        dto::EngineStartRequest,
        flow030::{FlowEffect030, FlowIdentity030},
        flow_store030::{Authority030, CheckFuture, StoreError030},
        start030::{StartAuthority030, StartCapture030},
    },
    Engine,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct Policy {
    calls: AtomicUsize,
}
impl ActionPolicySource for Policy {
    fn lock_current<'a>(
        &'a self,
        _: &'a StartCapture030,
        _: &'a Value,
    ) -> PolicyFuture<'a, ActionPolicyLease> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(ActionPolicyLease::new(false, ())) })
    }
}
impl PolicySource for Policy {
    fn lock_project<'a>(&'a self, _: &'a str) -> PolicyFuture<'a, ProjectPolicyLease> {
        Box::pin(async {
            Ok(ProjectPolicyLease::new(
                json!({}),
                serde_json::from_value(json!("workspace")).unwrap(),
                (),
            ))
        })
    }
    fn lock_ceiling(&self) -> PolicyFuture<'_, HostPolicyLease> {
        Box::pin(async {
            Ok(HostPolicyLease::new(
                serde_json::from_value(json!("workspace")).unwrap(),
                "synthetic".into(),
                (),
            ))
        })
    }
}
struct Capture<'a> {
    session: &'a StartSession<'a>,
    capture: StartCapture030,
}
impl Authority030 for Capture<'_> {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            self.session
                .check_owner_tx(db, id, Some(&self.capture))
                .await
        })
    }
    fn effect<'a>(&'a self, _: &'a mut SqliteConnection, _: &'a FlowEffect030) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn settlement<'a>(
        &'a self,
        _: &'a mut SqliteConnection,
        _: &'a FlowEffect030,
        _: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn owner_epoch(&self) -> &str {
        "0"
    }
}
impl StartAuthority030 for Capture<'_> {
    type SourceGuard = ();
    fn require_clear(&self, request: &EngineStartRequest) -> persistence::Result<()> {
        self.session.require_clear(request)
    }
    fn begin_commit(
        &self,
        request: &EngineStartRequest,
        id: &FlowIdentity030,
    ) -> persistence::Result<()> {
        self.session.begin_commit(request, id, true)
    }
    fn commit_acknowledged(&self, request: &EngineStartRequest, id: &FlowIdentity030) {
        self.session.commit_acknowledged(request, id)
    }
    async fn capture(&self, _: &EngineStartRequest) -> persistence::Result<StartCapture030> {
        Ok(self.capture.clone())
    }
    async fn lock_source(&self, _: &EngineStartRequest) -> persistence::Result<()> {
        Ok(())
    }
    async fn bind_capture_tx(
        &self,
        db: &mut SqliteConnection,
        _: &EngineStartRequest,
        capture: &StartCapture030,
    ) -> persistence::Result<()> {
        self.session.bind_capture_tx(db, capture).await
    }
}
fn synthetic_capture(generation: &str) -> (EngineStartRequest, StartCapture030) {
    // Approval-only input avoids provider execution and exercises the real
    // compiler, entered flow, native supervisor and Stop.
    let authored = r#"{"contract":"agsdl-0.3.0","id":"boundary","agents":{},"flow":{"entry":"wait","steps":{"wait":{"type":"approval","title":"Continue?","timeoutMs":86400000,"next":{"yes":[],"no":[]}}}}}"#;
    let source = json!({"owner":{"projectId":"project","planId":"boundary","branch":"develop"},"revision":"1","sourceSha256":format!("{:x}",Sha256::digest(authored.as_bytes()))});
    let registry = json!({"format":"macro-agsdl-registry/030","version":"boundary","modules":[],"harnesses":[],"agents":[],"hostCapabilities":[{"name":"approval","support":"native","evidenceJson":"{\"fixture\":\"synthetic-human-clock\"}"}],"startEntry":{"messageJson":"{}"}});
    let compiled = argentic_runtime::calculation::compile(
        authored,
        &source.to_string(),
        &registry.to_string(),
    )
    .unwrap();
    let compiled: Value = serde_json::from_str(&compiled).unwrap();
    let plan_json = compiled["compiledPlanJson"]
        .as_str()
        .unwrap_or_else(|| panic!("{compiled}"));
    let plan: Value = serde_json::from_str(plan_json).unwrap();
    let capture = StartCapture030 {
        identity: FlowIdentity030 {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            snapshot_id: "snapshot".into(),
            epoch: "capture".into(),
        },
        source: serde_json::from_value(source.clone()).unwrap(),
        versions: serde_json::from_value(plan["versions"].clone()).unwrap(),
        authored_source: authored.into(),
        compiled_plan_json: plan_json.to_owned(),
        registry_json: registry.to_string(),
        private_capture_json:
            json!({"format":"macro-native-flow-capture/030","generation":generation}).to_string(),
    };
    let request=serde_json::from_value(json!({"source":source,"profile":"macro-agsdl-030-v1","associations":{},"requestId":"start","entry":{"deliveryId":"entry","messageJson":"{}"}})).unwrap();
    (request, capture)
}
async fn exercise(pool: SqlitePool, root: &std::path::Path) {
    let engine = Engine::new();
    let session = engine.begin_start().await.unwrap();
    let (request, capture) = synthetic_capture(session.generation());
    let retained = persistence::start030::start(
        &pool,
        &request,
        &Capture {
            session: &session,
            capture,
        },
    )
    .await
    .unwrap();
    let id = &retained.receipt.identity;
    let policy = Arc::new(Policy {
        calls: AtomicUsize::new(0),
    });
    let context = HostContext::new(root.to_owned(), policy.clone());
    let tasks = StreamTasks::default();
    let mut replaced = retained.capture.clone();
    replaced.compiled_plan_json.push(' ');
    let result = session
        .attach_committed_start(
            &pool,
            context.clone(),
            tasks.clone(),
            id,
            &replaced,
            policy.clone(),
        )
        .await;
    let error = result.err().expect("substituted capture must be refused");
    assert_eq!(
        (error.code.as_str(), error.pointer.as_str()),
        ("CORRELATION", "capture")
    );
    let mut wrong_identity = id.clone();
    wrong_identity.snapshot_id = "foreign-snapshot".into();
    let error = session
        .attach_committed_start(
            &pool,
            context.clone(),
            tasks.clone(),
            &wrong_identity,
            &retained.capture,
            policy.clone(),
        )
        .await
        .err()
        .expect("identity substitution must be refused");
    assert_eq!(
        (error.code.as_str(), error.pointer.as_str()),
        ("CORRELATION", "capture")
    );
    let other = Engine::new();
    let foreign = other.begin_start().await.unwrap();
    let error = foreign
        .attach_committed_start(
            &pool,
            context.clone(),
            tasks.clone(),
            id,
            &retained.capture,
            policy.clone(),
        )
        .await
        .err()
        .expect("another incarnation cannot adopt the committed run");
    assert_eq!(
        (error.code.as_str(), error.pointer.as_str()),
        ("RUNTIME_UNAVAILABLE", "owner")
    );
    let clone = engine.clone();
    let cloned_session = clone.begin_start().await.unwrap();
    cloned_session
        .attach_committed_start(
            &pool,
            context.clone(),
            tasks.clone(),
            id,
            &retained.capture,
            policy.clone(),
        )
        .await
        .unwrap();
    // Wait for the real human handoff before issuing Stop or inspecting a
    // second attachment. This test is about the established reservation, not
    // Stop racing an executor which has not yet admitted its work.
    tokio::time::timeout(std::time::Duration::from_secs(3),async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            let ready:Result<bool,sqlx::Error>=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_human_requests WHERE system_id=? AND invocation_id=?)").bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_one(&pool).await;
            match ready {
                Ok(true)=>break,
                Ok(false)=>{},
                Err(sqlx::Error::Database(e)) if matches!(e.code().as_deref(),Some("5"|"6"|"262"))=>{},
                Err(e)=>panic!("readiness query: {e}"),
            }
        }
    }).await.unwrap();
    let error = session
        .attach_committed_start(
            &pool,
            context,
            tasks.clone(),
            id,
            &retained.capture,
            policy.clone(),
        )
        .await
        .err()
        .expect("a reservation cannot acquire a second supervisor");
    assert_eq!(
        (error.code.as_str(), error.pointer.as_str()),
        ("CORRELATION", "runtime")
    );
    assert_eq!(policy.calls.load(Ordering::SeqCst), 0);
    let stop =
        serde_json::from_value(json!({"systemStartId":id.system_start_id,"requestId":"stop"}))
            .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(8),
        engine.request_stop(&pool, &tasks, &stop),
    )
    .await
    .unwrap()
    .unwrap();
    drop(cloned_session);
    drop(foreign);
    drop(session);
    pool.close().await;
}
#[tokio::test]
async fn committed_start_boundary_memory() {
    let root = tempfile::tempdir().unwrap();
    exercise(
        argentic_runtime::sqlite::memory().await.unwrap(),
        root.path(),
    )
    .await;
}
#[tokio::test]
async fn committed_start_boundary_file() {
    let root = tempfile::tempdir().unwrap();
    exercise(
        argentic_runtime::sqlite::create_file(&root.path().join("boundary.db"))
            .await
            .unwrap(),
        root.path(),
    )
    .await;
}
