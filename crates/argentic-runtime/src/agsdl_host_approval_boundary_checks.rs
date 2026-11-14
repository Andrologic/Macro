//! Development-only checks through the actual private native approval actor.
use super::*;
use crate::agsdl_host_codex030::approvals::CommandApprovals030;
use crate::agsdl_host_human030::fixture::*;
use crate::host::{ActionPolicyLease, ActionPolicySource, PolicyFuture};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
struct Policy {
    lock: Arc<tokio::sync::RwLock<()>>,
    live: Arc<AtomicBool>,
    sent: Arc<AtomicBool>,
    pumped: Arc<AtomicUsize>,
    allowed: bool,
}
struct Guard {
    _read: tokio::sync::OwnedRwLockReadGuard<()>,
    live: Arc<AtomicBool>,
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.live.store(false, Ordering::SeqCst);
    }
}
impl ActionPolicySource for Policy {
    fn lock_current<'a>(
        &'a self,
        _: &'a StartCapture030,
        _: &'a Value,
    ) -> PolicyFuture<'a, ActionPolicyLease> {
        Box::pin(async move {
            let read = self.lock.clone().read_owned().await;
            self.live.store(true, Ordering::SeqCst);
            Ok(ActionPolicyLease::new(
                self.allowed,
                Guard {
                    _read: read,
                    live: self.live.clone(),
                },
            ))
        })
    }
}
async fn native_pump(f: &Fixture) {
    f.broker
        .pump(&f.host, &CancellationToken::new())
        .await
        .unwrap();
}
async fn ticket(f: &Fixture) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let _op = f.broker.operation.lock().await;
            let row: Option<String> = sqlx::query_scalar(
                "SELECT request_id FROM engine_flow030_human_requests WHERE kind='ask'",
            )
            .fetch_optional(&f.broker.pool)
            .await
            .unwrap();
            if let Some(id) = row {
                return id;
            }
            drop(_op);
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("native human request opened")
}
async fn actor_case(outcome: &str) {
    let f = fixture("agent", Some(1000), Some(10)).await;
    let humans = f.host.flow030().human_runtime();
    *humans.clock.lock().unwrap() = f.clock.clone();
    humans.brokers.lock().await.insert(
        (
            f.attempt.identity().system_start_id.clone(),
            f.attempt.identity().flow_invocation_id.clone(),
        ),
        f.broker.clone(),
    );
    // Production dispatch admits and stabilizes the owned work before its
    // adapter can receive a native command-approval request.
    f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    native_pump(&f).await;
    let policy = Arc::new(Policy {
        allowed: outcome != "policy-deny",
        ..Default::default()
    });
    let witness = policy.clone();
    f.broker.jobs.approval_check_probe(Arc::new(move |raw, _| {
        if witness.sent.load(Ordering::SeqCst) {
            assert!(
                raw.contains("ack"),
                "the post-response pump evaluates its real acknowledgement"
            );
            assert!(
                witness.live.load(Ordering::SeqCst),
                "policy lease released during pump"
            );
            assert!(
                witness.lock.try_write().is_err(),
                "policy writer entered during pump"
            );
            witness.pumped.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let cancel = CancellationToken::new();
    let actor = crate::agsdl_host_action_approval030::AgentActionHumans030 {
        host: f.host.clone(),
        pool: f.broker.pool.clone(),
        policy: policy.clone(),
    };
    let attempt = f.attempt.clone();
    let cancelled = cancel.clone();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let called = calls.clone();
    let witness = policy.clone();
    let task = tokio::spawn(async move {
        actor.answer(&attempt, json!({"nativeRequest":{"id":"request","params":{"reason":"Synthetic native action","threadId":"thread","turnId":"turn","itemId":"command"}}}), &cancelled,
            Box::new(move |yes| Box::pin(async move {
                assert!(witness.live.load(Ordering::SeqCst));
                assert!(witness.lock.try_write().is_err());
                tokio::task::yield_now().await;
                assert!(witness.lock.try_write().is_err(), "policy lease released across physical await");
                called.lock().unwrap().push(yes);
                witness.sent.store(true, Ordering::SeqCst);
                Ok(())
            }))).await
    });
    let request = ticket(&f).await;
    {
        let _op = f.broker.operation.lock().await;
        if outcome == "stop" {
            stop_fence(&f).await;
            cancel.cancel();
        } else if outcome == "expired" {
            f.clock.at(10);
            f.broker.tick(&f.host).await.unwrap();
            native_pump(&f).await;
        } else {
            f.broker
                .submit(
                    &f.host,
                    submission(
                        &f,
                        &request,
                        "0",
                        HumanAnswer030::Decision {
                            decision: if outcome == "no" { "no" } else { "yes" }.into(),
                            comment: "Synthetic person".into(),
                        },
                    ),
                    HumanOrigin030::Person,
                )
                .await
                .unwrap();
            native_pump(&f).await;
        }
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    if outcome == "stop" {
        let error = result.unwrap_err();
        assert_eq!(
            (error.code.as_str(), error.pointer.as_str()),
            ("STOP_PENDING", "approval")
        );
        assert!(calls.lock().unwrap().is_empty());
        assert!(!policy.live.load(Ordering::SeqCst));
    } else {
        result.unwrap();
        assert_eq!(*calls.lock().unwrap(), vec![outcome == "yes"]);
        assert!(
            policy.pumped.load(Ordering::SeqCst) > 0,
            "post-response pump must actually execute"
        );
        assert!(!policy.live.load(Ordering::SeqCst));
        assert!(
            policy.lock.try_write().is_ok(),
            "policy writer not released after answer"
        );
        let delivery: String = sqlx::query_scalar(
            "SELECT delivery FROM engine_flow030_human_requests WHERE request_id=?",
        )
        .bind(request)
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
        assert_eq!(delivery, "acknowledged");
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_flow030_clock_events WHERE output_json IS NULL",
        )
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
        assert_eq!(pending, 0);
    }
    println!("native actor {outcome}: passed");
}
async fn rejected_case(kind: &str) {
    let f = fixture("agent", Some(1000), Some(10)).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    native_pump(&f).await;
    let payload = json!({"nativeRequest":{"id":"request","params":{"reason":"Synthetic"}}});
    let request = f
        .broker
        .open(&f.host, &work, "ask", payload.clone())
        .await
        .unwrap();
    native_pump(&f).await;
    f.broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Decision {
                    decision: "yes".into(),
                    comment: "Synthetic person".into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    native_pump(&f).await;
    let mut decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
    match kind {
        "foreign-identity" => decision.identity.snapshot_id.push_str("-foreign"),
        "foreign-owner" => decision.owner.owner_epoch.push_str("-foreign"),
        "foreign-generation" => decision.generation.push_str("-foreign"),
        "foreign-payload" => decision.payload = json!({"nativeRequest":{"id":"other"}}),
        "stale-resolution" => decision.resolution["answer"]["comment"] = json!("substituted"),
        "retired" => {
            f.broker.retire(&f.host, &work).await.unwrap();
            native_pump(&f).await;
        }
        "stop" => stop_fence(&f).await,
        "replayed" => {
            f.broker
                .deliver_action(&f.host, &work, &decision, &payload, |_| async { Ok(()) })
                .await
                .unwrap();
            native_pump(&f).await;
        }
        _ => unreachable!(),
    }
    let calls = AtomicUsize::new(0);
    let result = f
        .broker
        .deliver_action(&f.host, &work, &decision, &payload, |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        })
        .await;
    let error = result.unwrap_err();
    assert_eq!(
        (error.code.as_str(), error.pointer.as_str()),
        ("CORRELATION", "humanClock"),
        "{kind}: {error:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0, "{kind} physically sent");
    println!("native rejection {kind}: passed");
}
pub(super) async fn run() {
    for case in ["yes", "no", "expired", "policy-deny", "stop"] {
        actor_case(case).await;
    }
    for case in [
        "foreign-identity",
        "foreign-owner",
        "foreign-generation",
        "foreign-payload",
        "stale-resolution",
        "retired",
        "stop",
        "replayed",
    ] {
        rejected_case(case).await;
    }
}
