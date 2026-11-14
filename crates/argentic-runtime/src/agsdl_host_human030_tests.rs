use super::fixture::*;
use super::*;
use crate::agsdl_host_clock030::{HostClockCompletion030, HostClockJob030};
use crate::persistence::flow030::{Activation030, Instance030};
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn diagnostic_action_broker_keeps_attach_admit_open_and_pump_failures_distinct() {
    use crate::agsdl_host_codex030::approvals::CommandApprovals030;
    struct UnusedPolicy;
    impl crate::host::ActionPolicySource for UnusedPolicy {
        fn lock_current<'a>(
            &'a self,
            _: &'a StartCapture030,
            _: &'a Value,
        ) -> crate::host::PolicyFuture<'a, crate::host::ActionPolicyLease> {
            Box::pin(async { panic!("an early broker failure cannot reach delivery policy") })
        }
    }
    for case in ["attach", "admit", "open", "pump"] {
        let f = fixture("agent", Some(1000), Some(10)).await;
        let humans = f.host.flow030().human_runtime();
        if case != "attach" {
            let broker = humans
                .broker(&f.host, &f.broker.pool, f.attempt.identity())
                .await
                .unwrap();
            if matches!(case, "open" | "pump") {
                // The real dispatcher stabilizes admission before an adapter
                // can open its first ask; preserve that prerequisite here.
                broker.admit_agent(&f.host, &f.attempt).await.unwrap();
                broker
                    .pump(&f.host, &CancellationToken::new())
                    .await
                    .unwrap();
            }
        }
        match case {
            "attach" => f.broker.pool.close().await,
            "admit" => {}
            "open" => {
                sqlx::raw_sql("CREATE TRIGGER diagnostic_open_failure BEFORE INSERT ON engine_flow030_human_requests BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PRIVATE'); END;").execute(&f.broker.pool).await.unwrap();
            }
            "pump" => {
                sqlx::raw_sql("CREATE TRIGGER diagnostic_pump_failure BEFORE UPDATE OF output_json ON engine_flow030_clock_events BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PRIVATE'); END;").execute(&f.broker.pool).await.unwrap();
            }
            _ => unreachable!(),
        }
        let actor = crate::agsdl_host_action_approval030::AgentActionHumans030 {
            host: f.host.clone(),
            pool: f.broker.pool.clone(),
            policy: Arc::new(UnusedPolicy),
        };
        let attempt = if case == "admit" {
            FlowWorkAttempt030::registry_fixture030("foreign-provider-attempt")
        } else {
            f.attempt.clone()
        };
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            actor.answer(
                &attempt,
                json!({"nativeRequest":{"id":"request","params":{"reason":"Synthetic"}}}),
                &CancellationToken::new(),
                Box::new(|_| Box::pin(async { panic!("failed broker cannot send") })),
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            error.code,
            match case {
                "admit" => "CORRELATION",
                _ => "STORAGE",
            },
            "{case}"
        );
        assert!(!error.message.contains("SYNTHETIC_PRIVATE"));
        if case != "attach" {
            let requests: i64 =
                sqlx::query_scalar("SELECT count(*) FROM engine_flow030_human_requests")
                    .fetch_one(&f.broker.pool)
                    .await
                    .unwrap();
            assert_eq!(requests, i64::from(case == "pump"));
        }
    }
}

#[tokio::test]
async fn native_action_delivery_requires_exact_payload_live_work_and_one_resolution() {
    for outcome in ["yes", "no", "expired", "stop", "retired", "payload"] {
        let f = fixture("agent", Some(1000), Some(10)).await;
        let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
        assert!(work.belongs_to(&f.attempt));
        pump(&f).await;
        let payload = json!({"nativeRequest":{"id":"request","params":{"threadId":"thread","turnId":"turn","itemId":"command"}}});
        let ticket = f
            .broker
            .open(&f.host, &work, "ask", payload.clone())
            .await
            .unwrap();
        pump(&f).await;
        if outcome == "expired" {
            f.clock.at(10);
            f.broker.tick(&f.host).await.unwrap();
        } else {
            let answer = HumanAnswer030::Decision {
                decision: if outcome == "no" { "no" } else { "yes" }.into(),
                comment: "A person's comment".into(),
            };
            f.broker
                .submit(
                    &f.host,
                    submission(&f, &ticket, "0", answer),
                    HumanOrigin030::Person,
                )
                .await
                .unwrap();
        }
        pump(&f).await;
        let decision = f.broker.take_resolution(&f.host, &ticket).await.unwrap();
        if outcome == "stop" {
            stop_fence(&f).await;
        }
        if outcome == "retired" {
            f.broker.retire(&f.host, &work).await.unwrap();
            pump(&f).await;
        }
        let supplied = if outcome == "payload" {
            json!({"nativeRequest":{"id":"another-request"}})
        } else {
            payload.clone()
        };
        let calls = std::sync::Mutex::new(Vec::new());
        let result = f
            .broker
            .deliver_action(&f.host, &work, &decision, &supplied, |yes| {
                calls.lock().unwrap().push(yes);
                async { Ok(()) }
            })
            .await;
        if matches!(outcome, "stop" | "retired" | "payload") {
            assert!(result.is_err());
            assert!(calls.lock().unwrap().is_empty());
        } else {
            result.unwrap();
            assert_eq!(*calls.lock().unwrap(), vec![outcome == "yes"]);
            assert!(f
                .broker
                .deliver_action(&f.host, &work, &decision, &payload, |_| async {
                    panic!("replayed native answer")
                })
                .await
                .is_err());
        }
    }
}
#[cfg(feature = "editor-parity")]
async fn evaluate_oracle(job: &HostClockJob030) -> HostClockOutput030 {
    let script = "import {evaluateHumanClockJob030} from './src/services/agsdlExecution/humanAnswer030'; process.stdout.write(JSON.stringify(evaluateHumanClockJob030(JSON.parse(await Bun.stdin.text()))));";
    let mut child = crate::process::background_tokio_command("bun")
        .args(["-e", script])
        .current_dir(
            std::env::var_os("ARGENTIC_EDITOR_ROOT")
                .expect("editor-parity requires ARGENTIC_EDITOR_ROOT"),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(job).unwrap())
        .await
        .unwrap();
    let output = child.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
async fn evaluate(job: &HostClockJob030) -> HostClockOutput030 {
    let raw =
        crate::calculation::route(&json!({"operation":"humanClock","input":job.input}).to_string())
            .unwrap();
    let output: crate::agsdl_host_route030::HostRouteOutput030 =
        serde_json::from_str(&raw).unwrap();
    let crate::agsdl_host_route030::HostRouteOutput030::Ready { result_json } = output else {
        panic!("native clock refused fixture")
    };
    let actual: HostClockOutput030 = serde_json::from_str(&result_json).unwrap();
    #[cfg(feature = "editor-parity")]
    assert_eq!(actual, evaluate_oracle(job).await);
    actual
}
async fn pump(f: &Fixture) -> Value {
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(f.broker.pump(&f.host, &cancel), async {
        let job = f.broker.jobs.next().await.unwrap();
        let output = evaluate(&job).await;
        f.broker
            .jobs
            .complete(
                &job.generation,
                HostClockCompletion030 {
                    ticket: job.ticket.clone(),
                    generation: job.generation.clone(),
                    input_digest: job.input_digest.clone(),
                    output,
                },
            )
            .unwrap();
    });
    serde_json::from_str(&result.unwrap().unwrap().receipt_json).unwrap()
}
fn yes() -> HumanAnswer030 {
    HumanAnswer030::Decision {
        decision: "yes".into(),
        comment: "".into(),
    }
}

#[tokio::test]
async fn native_hour_wait_union_then_exact_machine_timeout() {
    let f = fixture("agent", Some(60000), None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    f.clock.at(30000);
    let first = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic-read"}))
        .await
        .unwrap();
    pump(&f).await;
    let second = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic-read-2"}))
        .await
        .unwrap();
    pump(&f).await;
    f.clock.at(3630000);
    f.broker
        .submit(
            &f.host,
            submission(&f, &first, "0", yes()),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    let receipt = pump(&f).await;
    assert_eq!(
        receipt["clocks"][0]["snapshot"]["elapsedMachineMs"],
        "30000"
    );
    assert_eq!(
        receipt["clocks"][0]["snapshot"]["openHumanRequests"],
        json!([second])
    );
    assert!(f.broker.timeout_controls().await.unwrap().is_empty());
    f.broker
        .submit(
            &f.host,
            submission(&f, &second, "0", yes()),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    f.clock.at(3659999);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(pump(&f).await["expiredWorkIds"], json!([]));
    f.clock.at(3660000);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(pump(&f).await["expiredWorkIds"], json!([work.work_id()]));
    let controls = f.broker.timeout_controls().await.unwrap();
    assert_eq!(controls.len(), 1);
    assert_eq!(controls[0].work_id(), work.work_id());
    let reason: String = sqlx::query_scalar("SELECT reason FROM engine_flow030_clock_controls")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(reason, "TIMEOUT");
}

#[tokio::test]
async fn native_approval_arbitrary_choice_comment_and_timeout_late_answer() {
    let f = fixture("approval", Some(86400000), None).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.oldest_open(&work).await.unwrap().unwrap();
    f.broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Approval {
                    choice: "revise".into(),
                    comment: "Corriger le titre.".into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
    let output = decision.approval_output().unwrap();
    assert_eq!(output["choice"], "revise");
    assert_eq!(output["comment"], "Corriger le titre.");
    assert_eq!(output["message"]["resources"]["comment"], "Checked twice.");
    assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
    f.broker.acknowledge(&f.host, &decision).await.unwrap();
    assert_eq!(pump(&f).await["pendingResolutions"], json!([]));
    let g = fixture("approval", Some(86400000), None).await;
    let work = g
        .broker
        .admit_host_work(&g.host, g.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&g).await;
    let request = g.broker.oldest_open(&work).await.unwrap().unwrap();
    g.clock.at(86400000);
    g.broker
        .submit(
            &g.host,
            submission(
                &g,
                &request,
                "0",
                HumanAnswer030::Approval {
                    choice: "publish".into(),
                    comment: "".into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    let result = pump(&g).await;
    assert_eq!(
        result["pendingResolutions"][0]["failure"],
        "APPROVAL_TIMEOUT"
    );
    assert_eq!(result["nativeAnswers"][0]["accepted"], false);
    assert!(g
        .broker
        .take_resolution(&g.host, &request)
        .await
        .unwrap()
        .approval_output()
        .is_err());
}

#[tokio::test]
async fn native_intermediate_deadline_and_plan_resolution_precede_terminal() {
    for kind in ["ask", "plan", "question"] {
        let f = fixture("agent", Some(60000), Some(600000)).await;
        let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
        pump(&f).await;
        let request = f
            .broker
            .open(
                &f.host,
                &work,
                kind,
                json!({"planId":"plan","text":"Synthetic plan","nativeCallId":"call"}),
            )
            .await
            .unwrap();
        pump(&f).await;
        assert_eq!(f.broker.next_wake_ms().await.unwrap(), Some(600000));
        // Driver must stabilize here before consuming the final 1 ms.
        f.clock.at(600000);
        f.broker.tick(&f.host).await.unwrap();
        let result = pump(&f).await;
        assert_eq!(result["pendingResolutions"][0]["resolvedAtMs"], "600000");
        let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
        if kind == "plan" {
            assert_eq!(decision.plan_event().unwrap()["kind"], "planResolved");
            assert_eq!(
                decision.resolution()["workActions"][0]["action"],
                "PLAN_REJECTED"
            );
        } else {
            assert_eq!(
                decision.resolution()["workActions"][0]["action"],
                "continue"
            );
        }
        f.broker.acknowledge(&f.host, &decision).await.unwrap();
        pump(&f).await;
        f.clock.at(600001);
        f.broker.tick(&f.host).await.unwrap();
        assert_eq!(
            pump(&f).await["clocks"][0]["snapshot"]["elapsedMachineMs"],
            "1"
        );
        assert!(f.broker.timeout_controls().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn native_rejects_forged_scope_revision_visit_and_owner() {
    let f = fixture("approval", Some(10), None).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.oldest_open(&work).await.unwrap().unwrap();
    let answer = HumanAnswer030::Approval {
        choice: "publish".into(),
        comment: "".into(),
    };
    assert!(f
        .broker
        .submit(
            &f.host,
            submission(&f, &request, "9", answer.clone()),
            HumanOrigin030::Person
        )
        .await
        .is_err());
    let mut forged = submission(&f, &request, "0", answer.clone());
    forged.scope.source.owner.project_id = "foreign".into();
    assert!(f
        .broker
        .submit(&f.host, forged, HumanOrigin030::Person)
        .await
        .is_err());
    let wrong_host = crate::agsdl_host::route_attestation_test_host030(
        EngineOwner {
            system_start_id: f.broker.identity.system_start_id.clone(),
            owner_epoch: "foreign".into(),
        },
        f.attempt.generation(),
    );
    assert!(f
        .broker
        .submit(
            &wrong_host,
            submission(&f, &request, "0", answer.clone()),
            HumanOrigin030::Person
        )
        .await
        .is_err());
    let mut db = f.broker.pool.acquire().await.unwrap();
    let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
        .fetch_one(&mut *db)
        .await
        .unwrap();
    let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
    state.activations[0].phase = "done".into();
    sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&mut *db)
        .await
        .unwrap();
    drop(db);
    assert!(f
        .broker
        .submit(
            &f.host,
            submission(&f, &request, "0", answer),
            HumanOrigin030::Person
        )
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_human_submissions")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn native_reconstruction_retains_budget_and_never_replays_reserved_delivery() {
    let f = fixture("agent", Some(60000), Some(10)).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    f.clock.at(10);
    f.broker.tick(&f.host).await.unwrap();
    pump(&f).await;
    let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
    let reopened = HumanBroker030::attach(
        &f.host,
        f.broker.pool.clone(),
        f.broker.identity.clone(),
        f.clock.clone(),
        Arc::default(),
    )
    .await
    .unwrap();
    assert!(reopened
        .pump(&f.host, &CancellationToken::new())
        .await
        .unwrap()
        .is_none());
    assert!(reopened.take_resolution(&f.host, &request).await.is_err());
    let existing = reopened.admit_agent(&f.host, &f.attempt).await.unwrap();
    assert_eq!(existing.work_id(), work.work_id());
    assert!(reopened
        .pump(&f.host, &CancellationToken::new())
        .await
        .unwrap()
        .is_none());
    // An uncertain reservation is readable and may only be acked by its owner.
    reopened.acknowledge(&f.host, &decision).await.unwrap();
    let foreign_generation =
        crate::agsdl_host::route_attestation_test_host030(f.broker.owner.clone(), "new-generation");
    assert!(HumanBroker030::attach(
        &foreign_generation,
        f.broker.pool.clone(),
        f.broker.identity.clone(),
        f.clock.clone(),
        Arc::default()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn native_plan_gate_rejects_mutation_until_correlated_person_accepts() {
    use crate::agsdl_host_work_admission030::NativePlanLock030;
    let f = fixture("agent", None, None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let gate = NativePlanLock030::fixture030(&f.attempt);
    assert!(gate.authorize(&f.attempt, false).await.is_err());
    let read_permit = gate.authorize(&f.attempt, true).await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        gate.presented(&f.attempt, "p1"),
    )
    .await
    .expect("An in-flight read must not block plan presentation")
    .unwrap();
    let request = f
        .broker
        .open(
            &f.host,
            &work,
            "plan",
            json!({"planId":"p1","text":"First plan"}),
        )
        .await
        .unwrap();
    pump(&f).await;
    assert!(gate.authorize(&f.attempt, false).await.is_err());
    f.broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Decision {
                    decision: "no".into(),
                    comment: "Réviser.".into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    let declined = f.broker.take_resolution(&f.host, &request).await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        gate.resolve(&f.attempt, &declined),
    )
    .await
    .expect("An in-flight read must not block a human decision")
    .unwrap();
    drop(read_permit);
    assert!(gate.authorize(&f.attempt, false).await.is_err());
    f.broker.acknowledge(&f.host, &declined).await.unwrap();
    pump(&f).await;
    gate.presented(&f.attempt, "p2").await.unwrap();
    assert!(gate.resolve(&f.attempt, &declined).await.is_err());
    let request = f
        .broker
        .open(
            &f.host,
            &work,
            "plan",
            json!({"planId":"p2","text":"Revised plan"}),
        )
        .await
        .unwrap();
    pump(&f).await;
    f.broker
        .submit(
            &f.host,
            submission(&f, &request, "0", yes()),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    let accepted = f.broker.take_resolution(&f.host, &request).await.unwrap();
    gate.resolve(&f.attempt, &accepted).await.unwrap();
    let permit = gate.authorize(&f.attempt, false).await.unwrap();
    // Holding the permit keeps an actual RwLock read guard, so a concurrent
    // plan-state writer cannot cross the physical operation it authorizes.
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(1),
        gate.presented(&f.attempt, "p3")
    )
    .await
    .is_err());
    drop(permit);
}

#[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
#[tokio::test]
async fn native_large_elapse_stabilizes_at_intermediate_deadlines() {
    use crate::agsdl_host_clock030::VirtualClock030;
    let mut f = fixture("agent", Some(60000), Some(600000)).await;
    let clock = Arc::new(VirtualClock030::default());
    Arc::get_mut(&mut f.broker).unwrap().clock = clock.clone();
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    let jobs = f.broker.jobs.clone();
    let resident = tokio::spawn(async move {
        while let Ok(job) = jobs.next().await {
            let output = evaluate(&job).await;
            jobs.complete(
                &job.generation,
                HostClockCompletion030 {
                    ticket: job.ticket.clone(),
                    generation: job.generation.clone(),
                    input_digest: job.input_digest.clone(),
                    output,
                },
            )
            .unwrap();
        }
    });
    let boundaries = std::sync::Mutex::new(Vec::new());
    f.broker.elapse_qa(&f.host,&clock,600001,&CancellationToken::new(),|| async {
        boundaries.lock().unwrap().push(clock.now_ms());
        if clock.now_ms() == 600000 {
            // The first pass is before tick; the second follows its commit.
            let raw: Option<String> = sqlx::query_scalar("SELECT resolution_json FROM engine_flow030_human_requests WHERE request_id=?")
                .bind(&request).fetch_one(&f.broker.pool).await?;
            if raw.is_some() {
                let decision = f.broker.take_resolution(&f.host,&request).await?;
                f.broker.acknowledge(&f.host,&decision).await?;
                f.broker.pump(&f.host,&CancellationToken::new()).await?;
            }
        }
        Ok(())
    }).await.unwrap();
    assert!(boundaries.lock().unwrap().contains(&600000));
    let raw: String = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_clock")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    let receipt: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(receipt["clocks"][0]["snapshot"]["elapsedMachineMs"], "1");
    assert_eq!(clock.now_ms(), 600001);
    f.broker.jobs.close();
    resident.await.unwrap();
}

#[tokio::test]
async fn native_protocol_answer_requires_attested_validator_and_preserves_exact_bytes() {
    struct Validator;
    impl QuestionValidator030 for Validator {
        fn validate(&self, payload: &Value, answer: &str) -> Result<()> {
            require(
                payload["protocolReceiptId"] == "native-protocol-receipt"
                    && answer == "{\"count\":9007199254740993}",
                "Protocol answer schema differs",
            )
        }
    }
    let f = fixture("call", Some(60000), Some(600000)).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.open_question(&f.host,&work,json!({"nativeCallId":"native-call","protocolReceiptId":"native-protocol-receipt","schema":"count"}),Arc::new(Validator)).await.unwrap();
    pump(&f).await;
    assert!(f
        .broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Question {
                    answer_json: "{\"count\":false}".into()
                }
            ),
            HumanOrigin030::Person
        )
        .await
        .is_err());
    let exact = "{\"count\":9007199254740993}";
    f.broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Question {
                    answer_json: exact.into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
    assert_eq!(
        f.broker
            .protocol_answer(&decision)
            .await
            .unwrap()
            .as_deref(),
        Some(exact)
    );
    assert!(f.broker.timeout_controls().await.unwrap().is_empty());
}

#[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
#[tokio::test]
async fn qa_submission_is_explicitly_synthetic_person_in_the_product_service() {
    let f = fixture("agent", None, None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    f.broker
        .submit(
            &f.host,
            submission(&f, &request, "0", yes()),
            HumanOrigin030::SyntheticPerson,
        )
        .await
        .unwrap();
    pump(&f).await;
    let origin: String = sqlx::query_scalar("SELECT origin FROM engine_flow030_human_submissions")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(origin, "synthetic-person");
}

fn complete(job: &HostClockJob030, output: HostClockOutput030) -> HostClockCompletion030 {
    HostClockCompletion030 {
        ticket: job.ticket.clone(),
        generation: job.generation.clone(),
        input_digest: job.input_digest.clone(),
        output,
    }
}
fn replace_receipt(output: &mut HostClockOutput030, receipt: Value) {
    output.receipt_json = receipt.to_string();
    let mut state: Value = serde_json::from_str(&output.state_json).unwrap();
    state["entries"].as_array_mut().unwrap().last_mut().unwrap()["receiptJson"] =
        json!(output.receipt_json);
    output.state_json = state.to_string();
}
async fn pump_result(f: &Fixture) -> Result<Option<HostClockOutput030>> {
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(f.broker.pump(&f.host, &cancel), async {
        let job = f.broker.jobs.next().await.unwrap();
        let output = evaluate(&job).await;
        f.broker
            .jobs
            .complete(&job.generation, complete(&job, output))
            .unwrap();
    });
    result
}

#[tokio::test]
async fn rejects_correlated_but_semantically_forged_resident_authority() {
    use crate::agsdl_host_work_admission030::NativePlanLock030;
    for attack in [
        "unsubmitted-yes",
        "backdated-yes",
        "backdated-late",
        "missing-native-reference",
        "changed-no",
        "early-timeout",
        "deadline-poison",
        "machine-timeout",
    ] {
        let f = fixture("agent", Some(60000), Some(100)).await;
        let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
        pump(&f).await;
        let lock = NativePlanLock030::fixture030(&f.attempt);
        lock.presented(&f.attempt, "plan").await.unwrap();
        let request = f
            .broker
            .open(
                &f.host,
                &work,
                "plan",
                json!({"planId":"plan","text":"A native plan"}),
            )
            .await
            .unwrap();
        pump(&f).await;
        f.clock
            .at(if attack == "backdated-late" { 150 } else { 10 });
        if [
            "backdated-yes",
            "backdated-late",
            "missing-native-reference",
            "changed-no",
        ]
        .contains(&attack)
        {
            let answer = if attack != "changed-no" {
                yes()
            } else {
                HumanAnswer030::Decision {
                    decision: "no".into(),
                    comment: "".into(),
                }
            };
            f.broker
                .submit(
                    &f.host,
                    submission(&f, &request, "0", answer),
                    HumanOrigin030::Person,
                )
                .await
                .unwrap();
        } else {
            f.broker.tick(&f.host).await.unwrap();
        }
        let cancel = CancellationToken::new();
        let (result, ()) = tokio::join!(f.broker.pump(&f.host, &cancel), async {
            let job = f.broker.jobs.next().await.unwrap();
            let mut output = evaluate(&job).await;
            let mut receipt: Value = serde_json::from_str(&output.receipt_json).unwrap();
            match attack {
                "unsubmitted-yes" => {
                    receipt["pendingResolutions"] = json!([{"requestId":request,"expired":false,"resolvedAtMs":"1","answer":{"kind":"decision","decision":"yes","comment":""},"workActions":[{"workId":work.work_id(),"action":"continue"}]}]);
                    receipt["nativeAnswers"] = json!([]);
                }
                "backdated-yes" => receipt["pendingResolutions"][0]["resolvedAtMs"] = json!("1"),
                "backdated-late" => {
                    receipt["pendingResolutions"] = json!([{"requestId":request,"expired":false,"resolvedAtMs":"99","answer":{"kind":"decision","decision":"yes","comment":""},"workActions":[{"workId":work.work_id(),"action":"continue"}]}]);
                    receipt["nativeAnswers"][0]["accepted"] = json!(true);
                }
                "missing-native-reference" => receipt["nativeAnswers"] = json!([]),
                "changed-no" => {
                    receipt["pendingResolutions"][0]["answer"]["decision"] = json!("yes");
                    receipt["pendingResolutions"][0]["workActions"][0]["action"] =
                        json!("continue");
                }
                "early-timeout" => {
                    receipt["pendingResolutions"] = json!([{"requestId":request,"expired":true,"resolvedAtMs":"1","answer":{"kind":"decision","decision":"no"},"workActions":[{"workId":work.work_id(),"action":"PLAN_REJECTED"}]}])
                }
                "deadline-poison" => receipt["requests"][0]["answerTimeoutMs"] = json!("1"),
                "machine-timeout" => {
                    receipt["expiredWorkIds"] = json!([work.work_id()]);
                    receipt["clocks"][0]["snapshot"]["expired"] = json!(true);
                }
                _ => unreachable!(),
            }
            replace_receipt(&mut output, receipt);
            // Ticket, generation, digest and appended journal bytes all match.
            f.broker
                .jobs
                .complete(&job.generation, complete(&job, output))
                .unwrap();
        });
        assert!(result.is_err(), "accepted attack {attack}");
        assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
        assert!(lock.authorize(&f.attempt, false).await.is_err());
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_flow030_human_requests WHERE resolution_json IS NOT NULL",
        )
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "partial authority for {attack}");
        assert!(f.broker.timeout_controls().await.unwrap().is_empty());
        // Retry the same native ticket with an honest pure result, not a new
        // answer or a fresh budget. Unsubmitted cases remain unresolved.
        let honest = pump_result(&f).await.unwrap().unwrap();
        if attack == "unsubmitted-yes" {
            assert!(serde_json::from_str::<Value>(&honest.receipt_json).unwrap()
                ["pendingResolutions"]
                .as_array()
                .unwrap()
                .is_empty());
        }
    }
}

#[tokio::test]
async fn delayed_broker_admission_keeps_the_delivered_start_origin() {
    let f = fixture("agent", Some(60000), None).await;
    f.clock.at(5000);
    f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    assert_eq!(
        pump(&f).await["clocks"][0]["snapshot"]["elapsedMachineMs"],
        "5000"
    );
    f.clock.at(59999);
    f.broker.tick(&f.host).await.unwrap();
    assert!(pump(&f).await["expiredWorkIds"]
        .as_array()
        .unwrap()
        .is_empty());
    f.clock.at(60000);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(
        pump(&f).await["expiredWorkIds"],
        json!([f.attempt.work().activation_id])
    );
    let origin: String = sqlx::query_scalar("SELECT admitted_ms FROM engine_flow030_clock_works")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(origin, "0");
}

#[tokio::test]
async fn delivered_handoff_without_a_native_origin_cannot_get_a_fresh_budget() {
    let f = fixture("agent", Some(60000), None).await;
    // Emulate an older delivered Start. The origin writer itself must refuse
    // backfill after settlement; broker admission must also fail closed.
    sqlx::query("DROP TRIGGER engine_flow030_handoff_clock_retained")
        .execute(&f.broker.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM engine_flow030_handoff_clock")
        .execute(&f.broker.pool)
        .await
        .unwrap();
    f.clock.at(5000);
    assert!(f.broker.admit_agent(&f.host, &f.attempt).await.is_err());
    let lease = f.host.start_lease().await.unwrap();
    let mut tx = f.broker.pool.begin().await.unwrap();
    let raw: String = sqlx::query_scalar("SELECT effect_json FROM engine_flow030_outbox")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let effect: FlowEffect030 = serde_json::from_str(&raw).unwrap();
    assert!(crate::agsdl_host_clock030::record_handoff_clock_tx(
        &mut tx,
        &lease,
        &effect,
        f.clock.as_ref()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn concurrent_answers_resolve_once_under_the_shared_native_fence() {
    let f = fixture("approval", Some(100), None).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.oldest_open(&work).await.unwrap().unwrap();
    let a = submission(
        &f,
        &request,
        "0",
        HumanAnswer030::Approval {
            choice: "publish".into(),
            comment: "First".into(),
        },
    );
    let b = submission(
        &f,
        &request,
        "0",
        HumanAnswer030::Approval {
            choice: "revise".into(),
            comment: "Second".into(),
        },
    );
    let (a, b) = tokio::join!(
        f.broker.submit(&f.host, a, HumanOrigin030::Person),
        f.broker.submit(&f.host, b, HumanOrigin030::Person)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    pump(&f).await;
    let accepted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_human_submissions WHERE accepted=1",
    )
    .fetch_one(&f.broker.pool)
    .await
    .unwrap();
    assert_eq!(accepted, 1);
    f.broker.take_resolution(&f.host, &request).await.unwrap();
    assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
}

#[tokio::test]
async fn answer_racing_stop_cannot_publish_a_post_stop_decision() {
    let f = fixture("agent", None, None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    let (answer, ()) = tokio::join!(
        f.broker.submit(
            &f.host,
            submission(&f, &request, "0", yes()),
            HumanOrigin030::Person
        ),
        stop_fence(&f)
    );
    // Whichever writer enters first, Stop is durable before a possible pump.
    if answer.is_ok() {
        assert!(f
            .broker
            .pump(&f.host, &CancellationToken::new())
            .await
            .is_err());
    }
    assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_human_requests WHERE resolution_json IS NOT NULL",
    )
    .fetch_one(&f.broker.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}
#[tokio::test]
async fn generation_revocation_while_resident_is_computing_rejects_its_completion() {
    let f = fixture("agent", None, None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    f.broker
        .submit(
            &f.host,
            submission(&f, &request, "0", yes()),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    let cancelled = CancellationToken::new();
    let (result, ()) = tokio::join!(f.broker.pump(&f.host, &cancelled), async {
        let job = f.broker.jobs.next().await.unwrap();
        crate::agsdl_host_flow030::revoke_generation(&f.broker.pool, f.attempt.generation())
            .await
            .unwrap();
        let output = evaluate(&job).await;
        f.broker
            .jobs
            .complete(&job.generation, complete(&job, output))
            .unwrap();
    });
    assert!(result.is_err());
    assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_clock_events WHERE output_json IS NULL",
    )
    .fetch_one(&f.broker.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let new_host =
        crate::agsdl_host::route_attestation_test_host030(f.broker.owner.clone(), "new-generation");
    assert!(HumanBroker030::attach(
        &new_host,
        f.broker.pool.clone(),
        f.broker.identity.clone(),
        f.clock.clone(),
        Arc::default()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn real_commit_failure_rolls_back_resolution_and_allows_exact_ticket_readback() {
    let f = fixture("agent", None, None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    f.broker
        .submit(
            &f.host,
            submission(&f, &request, "0", yes()),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_real_commit AFTER UPDATE OF output_json ON engine_flow030_clock_events BEGIN INSERT INTO commit_child VALUES(1); END;").execute(&f.broker.pool).await.unwrap();
    let error = pump_result(&f).await.unwrap_err();
    assert_eq!(error.code, "STORAGE");
    let resolved: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_human_requests WHERE resolution_json IS NOT NULL",
    )
    .fetch_one(&f.broker.pool)
    .await
    .unwrap();
    assert_eq!(resolved, 0);
    let accepted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_human_submissions WHERE accepted IS NOT NULL",
    )
    .fetch_one(&f.broker.pool)
    .await
    .unwrap();
    assert_eq!(accepted, 0);
    assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
    let proofs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_human_resolution_proofs")
            .fetch_one(&f.broker.pool)
            .await
            .unwrap();
    assert_eq!(
        proofs, 0,
        "A failed COMMIT must not leave a native authority proof"
    );
    sqlx::query("DROP TRIGGER fail_real_commit")
        .execute(&f.broker.pool)
        .await
        .unwrap();
    // Lose the successful commit acknowledgment, then inspect. No new event,
    // answer or delivery may be created by this retry.
    drop(pump_result(&f).await.unwrap());
    assert!(f
        .broker
        .pump(&f.host, &CancellationToken::new())
        .await
        .unwrap()
        .is_none());
    let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
    assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
    f.broker.acknowledge(&f.host, &decision).await.unwrap();
    drop(pump_result(&f).await.unwrap());
    assert!(f
        .broker
        .pump(&f.host, &CancellationToken::new())
        .await
        .unwrap()
        .is_none());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_human_submissions")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn combines_call_039_and_human_clock_040_without_schema_conflict() {
    let f = fixture("call", Some(60000), Some(100)).await;
    let tables: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('engine_flow030_calls','engine_flow030_call_causes','engine_flow030_call_diagnostics','engine_flow030_clock','engine_flow030_handoff_clock')").fetch_one(&f.broker.pool).await.unwrap();
    assert_eq!(
        tables, 5,
        "The real registry must install both call 039 and human clock 040"
    );
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    sqlx::query("INSERT INTO engine_flow030_calls(system_id,invocation_id,activation_id,start_effect_id,call_id,attempt_json,status) VALUES(?,?,?,?,?,?,'reserved')")
        .bind(&f.broker.identity.system_start_id).bind(&f.broker.identity.flow_invocation_id)
        .bind(work.work_id()).bind(f.attempt.start_effect_id()).bind("combined-native-call")
        .bind(serde_json::to_string(&work).unwrap()).execute(&f.broker.pool).await.unwrap();
    f.broker
        .open(
            &f.host,
            &work,
            "question",
            json!({"nativeCallId":"call","protocolReceiptId":"protocol"}),
        )
        .await
        .unwrap();
    pump(&f).await;
    f.clock.at(101);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(
        pump(&f).await["pendingResolutions"][0]["answer"],
        json!({"kind":"expired"})
    );
    let status: String = sqlx::query_scalar(
        "SELECT status FROM engine_flow030_calls WHERE call_id='combined-native-call'",
    )
    .fetch_one(&f.broker.pool)
    .await
    .unwrap();
    assert_eq!(
        status, "reserved",
        "An expired question must not terminate the owned Call"
    );
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&f.broker.pool)
        .await
        .unwrap();
    assert!(violations.is_empty());
}

#[tokio::test]
async fn historical_unproved_resolution_never_mints_a_native_plan_capability() {
    let f = fixture("agent", None, Some(100)).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(
            &f.host,
            &work,
            "plan",
            json!({"planId":"old-plan","text":"A captured plan"}),
        )
        .await
        .unwrap();
    pump(&f).await;
    // Recreate a row that the old vulnerable writer could have persisted.
    let fake = json!({"requestId":request,"expired":false,"resolvedAtMs":"1","answer":{"kind":"decision","decision":"yes","comment":""},"workActions":[{"workId":work.work_id(),"action":"continue"}],"reason":"answer"});
    sqlx::query("UPDATE engine_flow030_human_requests SET resolution_json=?,revision='1' WHERE request_id=?")
        .bind(fake.to_string()).bind(&request).execute(&f.broker.pool).await.unwrap();
    assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
    let delivery: String =
        sqlx::query_scalar("SELECT delivery FROM engine_flow030_human_requests WHERE request_id=?")
            .bind(&request)
            .fetch_one(&f.broker.pool)
            .await
            .unwrap();
    assert_eq!(delivery, "pending");
}

#[tokio::test]
async fn delayed_approval_keeps_its_original_unsuspended_deadline() {
    let f = fixture("approval", Some(1000), None).await;
    f.clock.at(5000);
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    let receipt = pump(&f).await;
    assert_eq!(receipt["pendingResolutions"][0]["resolvedAtMs"], "1000");
    assert_eq!(
        receipt["pendingResolutions"][0]["failure"],
        "APPROVAL_TIMEOUT"
    );
    let request: String =
        sqlx::query_scalar("SELECT request_id FROM engine_flow030_human_requests")
            .fetch_one(&f.broker.pool)
            .await
            .unwrap();
    assert!(f
        .broker
        .take_resolution(&f.host, &request)
        .await
        .unwrap()
        .approval_output()
        .is_err());
    assert!(f.broker.oldest_open(&work).await.unwrap().is_none());
}

#[tokio::test]
async fn wake_delay_accounts_for_native_time_spent_in_the_pump() {
    for kind in ["machine", "answer", "approval"] {
        let f = fixture(
            if kind == "approval" {
                "approval"
            } else {
                "agent"
            },
            if kind == "answer" { None } else { Some(60000) },
            if kind == "answer" { Some(60000) } else { None },
        )
        .await;
        if kind == "approval" {
            f.broker
                .admit_host_work(&f.host, f.attempt.start_effect_id())
                .await
                .unwrap();
        } else {
            let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
            if kind == "answer" {
                pump(&f).await;
                f.broker
                    .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
                    .await
                    .unwrap();
            }
        }
        let cancelled = CancellationToken::new();
        let (result, ()) = tokio::join!(f.broker.pump(&f.host, &cancelled), async {
            let job = f.broker.jobs.next().await.unwrap();
            let output = evaluate(&job).await;
            // The resident computed its delay at t=0, but finishes at t=30s.
            f.clock.at(30000);
            f.broker
                .jobs
                .complete(&job.generation, complete(&job, output))
                .unwrap();
        });
        assert!(result.unwrap().is_some());
        assert_eq!(
            f.broker.next_wake_ms().await.unwrap(),
            Some(30000),
            "{kind}"
        );
        // Repeated reads subtract from the same persisted origin exactly once.
        f.clock.at(45000);
        assert_eq!(
            f.broker.next_wake_ms().await.unwrap(),
            Some(15000),
            "{kind}"
        );
        f.clock.at(60000);
        assert_eq!(f.broker.next_wake_ms().await.unwrap(), Some(0), "{kind}");
        f.broker.tick(&f.host).await.unwrap();
        let receipt = pump(&f).await;
        if kind == "machine" {
            assert_eq!(
                receipt["expiredWorkIds"],
                json!([f.attempt.work().activation_id])
            );
        } else {
            assert_eq!(receipt["pendingResolutions"][0]["resolvedAtMs"], "60000");
        }
        f.clock.at(90000);
        assert!(f
            .broker
            .next_wake_ms()
            .await
            .unwrap()
            .is_none_or(|delay| delay == 0));
    }
}

#[tokio::test]
async fn unicode_comments_keep_the_native_plan_lock_and_ts_journal_consistent() {
    use crate::agsdl_host_work_admission030::NativePlanLock030;
    for (comment, empty) in [
        ("\u{0085}", false),
        ("\u{feff}", true),
        ("\u{00a0}\u{1680}\u{2003}\u{202f}\u{205f}\u{3000}", true),
        ("\t\n\r\u{000b}\u{000c}\u{2028}\u{2029}", true),
        ("\u{feff}\u{0085}\u{feff}", false),
        ("\u{200b}", false),
        ("\u{180e}", false),
        ("\u{2003}Réviser.\u{feff}", false),
    ] {
        assert_eq!(human_comment_is_empty030(comment), empty);
        let f = fixture("agent", None, None).await;
        let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
        pump(&f).await;
        let lock = NativePlanLock030::fixture030(&f.attempt);
        lock.presented(&f.attempt, "plan").await.unwrap();
        let request = f
            .broker
            .open(
                &f.host,
                &work,
                "plan",
                json!({"planId":"plan","text":"A captured plan"}),
            )
            .await
            .unwrap();
        pump(&f).await;
        f.broker
            .submit(
                &f.host,
                submission(
                    &f,
                    &request,
                    "0",
                    HumanAnswer030::Decision {
                        decision: "no".into(),
                        comment: comment.into(),
                    },
                ),
                HumanOrigin030::Person,
            )
            .await
            .unwrap();
        let receipt = pump(&f).await;
        assert_eq!(
            receipt["pendingResolutions"][0]["workActions"][0]["action"],
            if empty { "PLAN_REJECTED" } else { "continue" },
            "{comment:?}"
        );
        let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
        lock.resolve(&f.attempt, &decision).await.unwrap();
        assert!(lock.authorize(&f.attempt, false).await.is_err());
        assert_eq!(
            lock.authorize(&f.attempt, true).await.is_err(),
            empty,
            "{comment:?}"
        );
        assert_eq!(
            lock.presented(&f.attempt, "revised-plan").await.is_err(),
            empty,
            "{comment:?}"
        );
    }
}

#[tokio::test]
async fn plan_text_uses_ecmascript_emptiness_before_opening_a_native_request() {
    for (text, empty) in [("\u{feff}", true), ("\u{0085}", false)] {
        let f = fixture("agent", None, None).await;
        let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
        pump(&f).await;
        let result = f
            .broker
            .open(
                &f.host,
                &work,
                "plan",
                json!({"planId":"unicode-plan","text":text}),
            )
            .await;
        if empty {
            assert_eq!(result.unwrap_err().message, "Plan content absent");
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM engine_flow030_human_requests")
                    .fetch_one(&f.broker.pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
            assert!(f
                .broker
                .pump(&f.host, &CancellationToken::new())
                .await
                .unwrap()
                .is_none());
        } else {
            let request = result.unwrap();
            pump(&f).await;
            assert_eq!(
                f.broker.oldest_open(&work).await.unwrap(),
                Some(request.clone())
            );
            let raw: String = sqlx::query_scalar(
                "SELECT payload_json FROM engine_flow030_human_requests WHERE request_id=?",
            )
            .bind(request)
            .fetch_one(&f.broker.pool)
            .await
            .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["text"], text);
        }
    }
}

#[tokio::test]
async fn retiring_the_first_expired_work_preserves_the_second_work_deadline() {
    let f = fixture_with_second_work("call", Some(60000), None, Some(90000)).await;
    let first = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let second = f
        .broker
        .admit_host_work(&f.host, "second-start")
        .await
        .unwrap();
    pump(&f).await;
    assert_eq!(f.broker.next_wake_ms().await.unwrap(), Some(60000));
    f.clock.at(60000);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(pump(&f).await["expiredWorkIds"], json!([first.work_id()]));
    assert_eq!(f.broker.next_wake_ms().await.unwrap(), Some(0));
    f.broker.retire(&f.host, &first).await.unwrap();
    let retired = pump(&f).await;
    assert_eq!(retired["retiredClocks"][0]["workId"], first.work_id());
    assert_eq!(retired["clocks"][0]["workId"], second.work_id());
    assert_eq!(f.broker.next_wake_ms().await.unwrap(), Some(30000));
    f.clock.at(75000);
    assert_eq!(f.broker.next_wake_ms().await.unwrap(), Some(15000));
    f.clock.at(90000);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(pump(&f).await["expiredWorkIds"], json!([second.work_id()]));
}

#[tokio::test]
async fn wake_rejects_a_native_clock_behind_the_persisted_observation() {
    let f = fixture("agent", Some(60000), None).await;
    f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    f.clock.at(10000);
    f.broker.tick(&f.host).await.unwrap();
    pump(&f).await;
    f.clock.at(9999);
    let error = f.broker.next_wake_ms().await.unwrap_err();
    assert_eq!(error.code, "CORRELATION");
    assert_eq!(error.message, "Native wake time moved backwards");
    f.clock.at(10000);
    assert_eq!(f.broker.next_wake_ms().await.unwrap(), Some(50000));
}

#[tokio::test]
async fn oversized_answer_cannot_poison_the_durable_clock_ticket() {
    let f = fixture("approval", Some(100), None).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.oldest_open(&work).await.unwrap().unwrap();
    let error = f
        .broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Approval {
                    choice: "publish".into(),
                    comment: "é".repeat(40_000),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "INPUT_LIMIT");
    let submitted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_human_submissions")
            .fetch_one(&f.broker.pool)
            .await
            .unwrap();
    let tickets: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_clock_events WHERE output_json IS NULL",
    )
    .fetch_one(&f.broker.pool)
    .await
    .unwrap();
    assert_eq!((submitted, tickets), (0, 0));
    f.clock.at(100);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(
        pump(&f).await["pendingResolutions"][0]["failure"],
        "APPROVAL_TIMEOUT"
    );
}

#[tokio::test]
async fn pending_human_generation_loss_is_interrupted_and_never_replayed() {
    let f = fixture("approval", Some(100), None).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.oldest_open(&work).await.unwrap().unwrap();
    let before: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    crate::agsdl_host_flow030::revoke_generation(&f.broker.pool, f.attempt.generation())
        .await
        .unwrap();
    let interrupted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_interruptions WHERE system_id=?")
            .bind(&f.scope.system_start_id)
            .fetch_one(&f.broker.pool)
            .await
            .unwrap();
    assert_eq!(interrupted, 1);
    f.clock.at(200);
    assert!(f.broker.tick(&f.host).await.is_err());
    let after: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    let page = crate::agsdl_host_human_projection030::read(&f.broker.pool, f.scope.clone(), None)
        .await
        .unwrap();
    assert_eq!(page.requests[0].id, request);
    let facts: Value =
        serde_json::from_str(page.requests[0].flow_json.as_deref().unwrap()).unwrap();
    assert_eq!(facts["clock"]["value"]["works"], json!([]));
    assert_eq!(facts["state"]["kind"], "cancelled");
    assert_eq!(facts["state"]["resolution"]["reason"], "revocation");
}
