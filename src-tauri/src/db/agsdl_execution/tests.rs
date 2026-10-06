use super::*;
use crate::db::create_pool;
use tempfile::TempDir;
struct Compiler;
fn versions() -> EngineVersions {
    EngineVersions {
        snapshot: "1".into(),
        contract: "agsdl-0.2.0".into(),
        compiler: "compiler-v1".into(),
        runtime: "runtime-v1".into(),
        registry: "registry-v1".into(),
        profile: "macro-serial-inline-v1".into(),
    }
}
fn configuration(name: &str) -> EngineAgentConfiguration {
    EngineAgentConfiguration {
        agent_name: name.into(),
        configuration_name: "fixed".into(),
        provider_id: "synthetic".into(),
        model_id: "synthetic".into(),
        configuration_json: "{}".into(),
        settings_json: "{}".into(),
        permissions_json: "[]".into(),
        scope_json: "{}".into(),
    }
}
fn request() -> EngineStartRequest {
    EngineStartRequest {
        source: EngineSourceRevision {
            owner: EngineSourceOwner {
                project_id: "project".into(),
                plan_id: "plan".into(),
                branch: "develop".into(),
            },
            revision: "9007199254740993".into(),
            source_sha256: format!("{:x}", Sha256::digest(b"{ \"n\": 9007199254740993 }")),
        },
        profile: "macro-serial-inline-v1".into(),
        associations: EngineAssociations::default(),
        request_id: "start".into(),
        entry: None,
    }
}
impl CaptureAuthority for Compiler {
    type CommitGuard = ();
    async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
        Ok(TrustedCapture {
            snapshot: EngineSnapshot {
                system_start_id: id.into(),
                source: request.source.clone(),
                authored_source: "{ \"n\": 9007199254740993 }".into(),
                versions: versions(),
                agents: vec![configuration("a"), configuration("b")],
                compiled_plan_json: "{}".into(),
                associations: request.associations.clone(),
            },
            policies: vec![
                StepPolicy {
                    step: vec!["first".into()],
                    agent_name: Some("a".into()),
                    max_visits: Some("1".into()),
                },
                StepPolicy {
                    step: vec!["second".into()],
                    agent_name: Some("a".into()),
                    max_visits: None,
                },
                StepPolicy {
                    step: vec!["b".into()],
                    agent_name: Some("b".into()),
                    max_visits: None,
                },
            ],
            entry_step: Some(vec!["first".into()]),
        })
    }
    async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
        Ok(())
    }
}
struct NoRoutes;
impl RouteAuthority for NoRoutes {
    fn outgoing(
        &self,
        _: &EngineSnapshot,
        _: &EngineWork,
        _: &EngineOutcome,
    ) -> Result<Vec<EngineDelivery>> {
        Ok(vec![])
    }
}
async fn setup() -> (TempDir, SqlitePool, EngineStartReceipt, EngineOwner) {
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    let receipt = start(&pool, request(), &Compiler).await.unwrap();
    let runtime = resume(&pool, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    (temp, pool, receipt, runtime)
}
async fn delivery(
    pool: &SqlitePool,
    runtime: &EngineOwner,
    step: &str,
    id: &str,
) -> EngineDelivery {
    let mut c = pool.acquire().await.unwrap();
    let stored = load(&mut c, &runtime.system_start_id).await.unwrap();
    let p = stored.policies.iter().find(|p| p.step == [step]).unwrap();
    EngineDelivery {
        delivery_id: id.into(),
        work: EngineWork {
            system_start_id: runtime.system_start_id.clone(),
            flow_invocation_id: stored.state.invocation_id,
            activation_id: format!("activation-{id}"),
            step: Some(vec![step.into()]),
            agent_instance_id: p
                .agent_name
                .as_ref()
                .map(|name| stored.state.agents[name].id.clone()),
        },
        input: EngineValue {
            origin: "entry".into(),
            value_json: "{\"content\":9007199254740993}".into(),
        },
    }
}
fn memory(work: &EngineWork, revision: &str) -> EngineMemory {
    EngineMemory {
        agent_instance_id: work.agent_instance_id.clone().unwrap(),
        revision: revision.into(),
        format_version: "checkpoint-v1".into(),
        state_json: "{\"number\":9007199254740993}".into(),
    }
}
fn commit(runtime: &EngineOwner, work: &EngineWork) -> EngineTerminalCommit {
    EngineTerminalCommit {
        owner: runtime.clone(),
        work: work.clone(),
        outcome: EngineOutcome::Completed {
            output: EngineValue {
                origin: "agent".into(),
                value_json: "{\"result\":\"done\"}".into(),
            },
        },
        termination_evidence_json: "{\"ended\":true}".into(),
        response_cursor: "0".into(),
        memory: Some(memory(work, "1")),
        outgoing: vec![],
    }
}
fn effect(runtime: &EngineOwner, work: &EngineWork) -> EngineEffect {
    EngineEffect {
        context: EngineContext {
            owner: runtime.clone(),
            work: work.clone(),
            permissions_json: "[]".into(),
            scope_json: "{}".into(),
            registry_version: "registry-v1".into(),
        },
        effect: EngineEffectIdentity::Provider {
            provider_attempt_id: "provider-1".into(),
        },
        invocation_json: "{\"request\":true}".into(),
    }
}

#[tokio::test]
async fn terminal_commit_survives_lost_response_and_contradictions_roll_back() {
    let (temp, pool, receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "d1").await;
    let accepted = accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    assert_eq!(
        accepted,
        accept_delivery(&pool, &runtime, d.clone()).await.unwrap()
    );
    let mut conflict = d.clone();
    conflict.input.value_json = "null".into();
    assert!(accept_delivery(&pool, &runtime, conflict).await.is_err());
    assert!(matches!(
        begin(&pool, &runtime, "d1").await.unwrap(),
        Admission::Admitted(..)
    ));
    seal_responses(&pool, &runtime, &d.work, "0").await.unwrap();
    let terminal = commit(&runtime, &d.work);
    assert!(commit_terminal(&pool, terminal.clone(), &NoRoutes)
        .await
        .unwrap());
    pool.close().await;
    let reopened = create_pool(&temp.path().join("test.db")).await.unwrap();
    assert!(!commit_terminal(&reopened, terminal.clone(), &NoRoutes)
        .await
        .unwrap());
    let mut conflicting = terminal;
    conflicting.memory.as_mut().unwrap().state_json = "{}".into();
    assert!(commit_terminal(&reopened, conflicting, &NoRoutes)
        .await
        .is_err());
    let snapshot = read_snapshot(&reopened, &receipt.system_start_id)
        .await
        .unwrap();
    assert_eq!(snapshot.authored_source, "{ \"n\": 9007199254740993 }");
    let projection = read_projection(&reopened, &receipt.system_start_id)
        .await
        .unwrap();
    assert_eq!(projection.activations[0].work_state, "terminal");
    let events = read_events(&reopened, &receipt.system_start_id, None, 2)
        .await
        .unwrap();
    assert!(events.has_more);
    let next_page = read_events(
        &reopened,
        &receipt.system_start_id,
        Some(&events.next_cursor),
        500,
    )
    .await
    .unwrap();
    assert!(!next_page.events.is_empty());
    let empty = read_events(
        &reopened,
        &receipt.system_start_id,
        Some(&next_page.next_cursor),
        5,
    )
    .await
    .unwrap();
    assert_eq!(empty.next_cursor, next_page.next_cursor);
}
#[tokio::test]
async fn stopped_system_retains_delivery_receipts_without_reopening_admission() {
    let (_temp, pool, receipt, runtime) = setup().await;
    let mut delivery = delivery(&pool, &runtime, "second", "retained").await;
    delivery.input.value_json = r#"{"number":1,"flag":false}"#.into();
    let retained = accept_delivery(&pool, &runtime, delivery.clone())
        .await
        .unwrap();
    stop(
        &pool,
        EngineStopRequest {
            system_start_id: receipt.system_start_id.clone(),
            request_id: "stop-retained".into(),
            activation_id: None,
        },
    )
    .await
    .unwrap();
    let stopped = read_projection(&pool, &receipt.system_start_id)
        .await
        .unwrap();
    let mut same = delivery.clone();
    same.input.value_json = r#"{ "flag":false, "number":1e0 }"#.into();
    assert_eq!(
        accept_delivery(&pool, &runtime, same).await.unwrap(),
        retained
    );
    assert_eq!(
        retained.delivery.input.value_json,
        delivery.input.value_json
    );
    let mut conflicting = delivery.clone();
    conflicting.input.value_json = "null".into();
    assert_eq!(
        accept_delivery(&pool, &runtime, conflicting)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    let mut fresh = delivery.clone();
    fresh.delivery_id = "new-after-stop".into();
    fresh.work.activation_id = "new-after-stop-activation".into();
    assert_eq!(
        accept_delivery(&pool, &runtime, fresh)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    let mut stale = runtime.clone();
    stale.owner_epoch = "999".into();
    assert_eq!(
        accept_delivery(&pool, &stale, delivery)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    assert_eq!(
        read_projection(&pool, &receipt.system_start_id)
            .await
            .unwrap(),
        stopped
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_deliveries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn concurrent_fifo_admission_memory_and_visit_budget() {
    let (_temp, pool, _receipt, runtime) = setup().await;
    let first = delivery(&pool, &runtime, "first", "first").await;
    let second = delivery(&pool, &runtime, "second", "second").await;
    accept_delivery(&pool, &runtime, first.clone())
        .await
        .unwrap();
    accept_delivery(&pool, &runtime, second.clone())
        .await
        .unwrap();
    assert!(matches!(
        begin(&pool, &runtime, "second").await.unwrap(),
        Admission::Waiting("fifo")
    ));
    let (left, right) = tokio::join!(
        begin(&pool, &runtime, "first"),
        begin(&pool, &runtime, "first")
    );
    assert_eq!(
        usize::from(matches!(left.unwrap(), Admission::Admitted(..)))
            + usize::from(matches!(right.unwrap(), Admission::Admitted(..))),
        1
    );
    let b = delivery(&pool, &runtime, "b", "b").await;
    accept_delivery(&pool, &runtime, b.clone()).await.unwrap();
    assert!(matches!(
        begin(&pool, &runtime, "b").await.unwrap(),
        Admission::Admitted(_, None)
    ));
    seal_responses(&pool, &runtime, &first.work, "0")
        .await
        .unwrap();
    commit_terminal(&pool, commit(&runtime, &first.work), &NoRoutes)
        .await
        .unwrap();
    match begin(&pool, &runtime, "second").await.unwrap() {
        Admission::Admitted(_, checkpoint) => {
            assert_eq!(checkpoint, Some(memory(&first.work, "1")))
        }
        other => panic!("{other:?}"),
    }
    seal_responses(&pool, &runtime, &second.work, "0")
        .await
        .unwrap();
    let mut second_commit = commit(&runtime, &second.work);
    second_commit.memory = Some(memory(&second.work, "2"));
    commit_terminal(&pool, second_commit, &NoRoutes)
        .await
        .unwrap();
    let revisit = delivery(&pool, &runtime, "first", "revisit").await;
    accept_delivery(&pool, &runtime, revisit).await.unwrap();
    assert!(matches!(
        begin(&pool, &runtime, "revisit").await.unwrap(),
        Admission::Rejected("VISIT_LIMIT")
    ));
}
#[tokio::test]
async fn restart_blocks_effect_replay_stale_epoch_and_unavailable_versions() {
    let (temp, pool, receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "d").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    begin(&pool, &runtime, "d").await.unwrap();
    let registered = effect(&runtime, &d.work);
    assert!(register_effect(&pool, registered.clone()).await.unwrap());
    assert!(!register_effect(&pool, registered.clone()).await.unwrap());
    pool.close().await;
    let reopened = create_pool(&temp.path().join("test.db")).await.unwrap();
    reconcile_after_restart(&reopened).await.unwrap();
    let projection = read_projection(&reopened, &receipt.system_start_id)
        .await
        .unwrap();
    assert_eq!(projection.activations[0].work_state, "uncertain");
    assert!(
        commit_terminal(&reopened, commit(&runtime, &d.work), &NoRoutes)
            .await
            .is_err()
    );
    assert!(register_effect(&reopened, registered).await.is_err());
    let mut unavailable = versions();
    unavailable.compiler = "missing".into();
    assert_eq!(
        resume(&reopened, &receipt.system_start_id, &unavailable)
            .await
            .unwrap_err()
            .code,
        "VERSION_UNAVAILABLE"
    );
    let new_runtime = resume(&reopened, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    let next_d = delivery(&reopened, &new_runtime, "second", "next").await;
    accept_delivery(&reopened, &new_runtime, next_d)
        .await
        .unwrap();
    assert!(matches!(
        begin(&reopened, &new_runtime, "next").await.unwrap(),
        Admission::Waiting("uncertain")
    ));
    let status: String = sqlx::query_scalar("SELECT status FROM engine_effects")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(status, "uncertain");
}
#[tokio::test]
async fn stop_keeps_active_lock_until_closed_effect_and_terminal_proof() {
    let (_temp, pool, receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "d").await;
    let queued = delivery(&pool, &runtime, "second", "queued").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    accept_delivery(&pool, &runtime, queued).await.unwrap();
    begin(&pool, &runtime, "d").await.unwrap();
    let e = effect(&runtime, &d.work);
    register_effect(&pool, e.clone()).await.unwrap();
    let request = EngineStopRequest {
        system_start_id: receipt.system_start_id.clone(),
        request_id: "stop".into(),
        activation_id: None,
    };
    assert!(matches!(
        stop(&pool, request.clone()).await.unwrap(),
        EngineStopState::Requested { .. }
    ));
    seal_responses(&pool, &runtime, &d.work, "0").await.unwrap();
    let mut terminal = commit(&runtime, &d.work);
    terminal.outcome = EngineOutcome::Stopped {
        evidence_json: "{\"ended\":true}".into(),
    };
    assert!(commit_terminal(&pool, terminal.clone(), &NoRoutes)
        .await
        .is_err());
    settle_effect(
        &pool,
        EngineSettlement {
            context: e.context,
            effect: e.effect,
            status: "ended".into(),
            evidence_json: "{\"ended\":true}".into(),
        },
        Some("{\"result\":9007199254740993}".into()),
    )
    .await
    .unwrap();
    commit_terminal(&pool, terminal, &NoRoutes).await.unwrap();
    assert!(matches!(
        stop(&pool, request).await.unwrap(),
        EngineStopState::Confirmed { .. }
    ));
}
#[tokio::test]
async fn start_is_idempotent_immutable_and_source_recheck_is_required() {
    let (_temp, pool, receipt, _runtime) = setup().await;
    assert_eq!(start(&pool, request(), &Compiler).await.unwrap(), receipt);
    let mut conflicting = request();
    conflicting.associations.task_id = Some("task".into());
    assert!(start(&pool, conflicting, &Compiler).await.is_err());
    assert!(
        sqlx::query("UPDATE engine_systems SET snapshot_json = '{}' ")
            .execute(&pool)
            .await
            .is_err()
    );
    struct Changed;
    impl CaptureAuthority for Changed {
        type CommitGuard = ();
        async fn capture(&self, r: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
            Compiler.capture(r, id).await
        }
        async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
            Err(failure(
                "CORRELATION",
                "source",
                "Changed during compilation",
            ))
        }
    }
    let mut fresh = request();
    fresh.request_id = "another".into();
    assert!(start(&pool, fresh, &Changed).await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_systems")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert!(validate_json("{\"number\":1e9999}").is_ok());
}

#[tokio::test]
async fn capture_preserves_schema_properties_and_public_bindings_named_like_credentials() {
    const SOURCE: &str = r#"{ "Tool": {"parametersSchema":{"properties":{"password":{"type":"string"},"credentials":{"type":"object"}}}}, "Resource":{"authorization":"public policy"} }"#;
    const COMPILED: &str = r#"{"schema":{"properties":{"api_key":{"type":"string"}}},"bindings":{"authorization":{"policy":"public"}}}"#;
    struct PublicCompiler;
    impl CaptureAuthority for PublicCompiler {
        type CommitGuard = ();
        async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
            let mut capture = Compiler.capture(request, id).await?;
            capture.snapshot.authored_source = SOURCE.into();
            capture.snapshot.compiled_plan_json = COMPILED.into();
            capture.snapshot.agents[0].configuration_json = COMPILED.into();
            capture.snapshot.agents[0].settings_json =
                r#"{"parametersSchema":{"properties":{"password":{"type":"string"}}}}"#.into();
            Ok(capture)
        }
        async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
            Ok(())
        }
    }
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("public.db")).await.unwrap();
    let mut request = request();
    request.source.source_sha256 = format!("{:x}", Sha256::digest(SOURCE.as_bytes()));
    let receipt = start(&pool, request, &PublicCompiler).await.unwrap();
    assert_eq!(receipt.snapshot.authored_source, SOURCE);
    assert_eq!(receipt.snapshot.compiled_plan_json, COMPILED);
    assert_eq!(receipt.snapshot.agents[0].configuration_json, COMPILED);
    pool.close().await;
    let reopened = create_pool(&temp.path().join("public.db")).await.unwrap();
    assert_eq!(
        read_snapshot(&reopened, &receipt.system_start_id)
            .await
            .unwrap(),
        receipt.snapshot
    );
}

#[tokio::test]
async fn rejected_outgoing_rolls_back_checkpoint_and_terminal() {
    let (_temp, pool, _receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "d").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    begin(&pool, &runtime, "d").await.unwrap();
    seal_responses(&pool, &runtime, &d.work, "0").await.unwrap();
    let mut invalid = commit(&runtime, &d.work);
    invalid
        .outgoing
        .push(delivery(&pool, &runtime, "b", "invented").await);
    assert!(commit_terminal(&pool, invalid, &NoRoutes).await.is_err());
    let (_, checkpoint) = read_agent(
        &pool,
        &runtime.system_start_id,
        d.work.agent_instance_id.as_ref().unwrap(),
    )
    .await
    .unwrap();
    assert!(checkpoint.is_none());
    assert_eq!(
        read_projection(&pool, &runtime.system_start_id)
            .await
            .unwrap()
            .activations[0]
            .work_state,
        "active"
    );
    struct Route(EngineDelivery);
    impl RouteAuthority for Route {
        fn outgoing(
            &self,
            _: &EngineSnapshot,
            _: &EngineWork,
            _: &EngineOutcome,
        ) -> Result<Vec<EngineDelivery>> {
            Ok(vec![self.0.clone()])
        }
    }
    let outgoing = delivery(&pool, &runtime, "b", "successor").await;
    let mut good = commit(&runtime, &d.work);
    good.outgoing.push(outgoing.clone());
    assert!(
        commit_terminal(&pool, good.clone(), &Route(outgoing.clone()))
            .await
            .unwrap()
    );
    assert!(!commit_terminal(&pool, good, &Route(outgoing))
        .await
        .unwrap());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_deliveries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}
#[tokio::test]
async fn effect_completion_preserves_exact_result_and_rejects_contradiction() {
    let (temp, pool, _receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "d").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    begin(&pool, &runtime, "d").await.unwrap();
    let e = effect(&runtime, &d.work);
    register_effect(&pool, e.clone()).await.unwrap();
    let settled = EngineSettlement {
        context: e.context.clone(),
        effect: e.effect.clone(),
        status: "ended".into(),
        evidence_json: "{\"ended\":true}".into(),
    };
    let result = "{ \"number\": 9007199254740993 }";
    settle_effect(&pool, settled.clone(), Some(result.into()))
        .await
        .unwrap();
    pool.close().await;
    let reopened = create_pool(&temp.path().join("test.db")).await.unwrap();
    assert_eq!(
        read_effects(&reopened, &d.work).await.unwrap()[0]
            .result_json
            .as_deref(),
        Some(result)
    );
    settle_effect(&reopened, settled.clone(), Some(result.into()))
        .await
        .unwrap();
    assert!(settle_effect(&reopened, settled, Some("null".into()))
        .await
        .is_err());
    assert!(!register_effect(&reopened, e).await.unwrap());
}

struct SingleRoute(EngineDelivery);
impl RouteAuthority for SingleRoute {
    fn outgoing(
        &self,
        _: &EngineSnapshot,
        _: &EngineWork,
        _: &EngineOutcome,
    ) -> Result<Vec<EngineDelivery>> {
        Ok(vec![self.0.clone()])
    }
}
struct VerifiedEnd;
impl RecoveryAuthority for VerifiedEnd {
    fn verify(&self, _: &EngineSnapshot, proof: &RecoveryProof) -> Result<()> {
        require(
            super::super::exact_json::equal(
                &proof.terminal.termination_evidence_json,
                r#"{"ended":true}"#,
            )?,
            "No verified termination",
        )?;
        for (settlement, _) in &proof.effects {
            require(
                super::super::exact_json::equal(&settlement.evidence_json, r#"{"ended":true}"#)?,
                "No verified effect termination",
            )?;
        }
        Ok(())
    }
}
#[tokio::test]
async fn reserved_visit_refusal_routes_once_without_effect_or_checkpoint_change() {
    let (_temp, pool, _receipt, runtime) = setup().await;
    let first = delivery(&pool, &runtime, "first", "first").await;
    accept_delivery(&pool, &runtime, first.clone())
        .await
        .unwrap();
    begin(&pool, &runtime, "first").await.unwrap();
    seal_responses(&pool, &runtime, &first.work, "0")
        .await
        .unwrap();
    commit_terminal(&pool, commit(&runtime, &first.work), &NoRoutes)
        .await
        .unwrap();
    let rejected = delivery(&pool, &runtime, "first", "refused").await;
    accept_delivery(&pool, &runtime, rejected.clone())
        .await
        .unwrap();
    assert!(matches!(
        begin(&pool, &runtime, "refused").await.unwrap(),
        Admission::Rejected("VISIT_LIMIT")
    ));
    assert!(matches!(
        begin(&pool, &runtime, "refused").await.unwrap(),
        Admission::Rejected("VISIT_LIMIT")
    ));
    assert!(register_effect(&pool, effect(&runtime, &rejected.work))
        .await
        .is_err());
    let error_route = delivery(&pool, &runtime, "second", "error-route").await;
    seal_responses(&pool, &runtime, &rejected.work, "0")
        .await
        .unwrap();
    let mut terminal = commit(&runtime, &rejected.work);
    terminal.outcome = EngineOutcome::Failed {
        code: "VISIT_LIMIT".into(),
        error_json: r#"{"limit":1}"#.into(),
    };
    terminal.memory = Some(memory(&rejected.work, "1"));
    terminal.outgoing = vec![error_route.clone()];
    let mut changed = terminal.clone();
    changed.memory.as_mut().unwrap().revision = "2".into();
    assert!(
        commit_terminal(&pool, changed, &SingleRoute(error_route.clone()))
            .await
            .is_err()
    );
    assert!(
        commit_terminal(&pool, terminal.clone(), &SingleRoute(error_route.clone()))
            .await
            .unwrap()
    );
    assert!(!commit_terminal(&pool, terminal, &SingleRoute(error_route))
        .await
        .unwrap());
    let (.., checkpoint) = read_agent(
        &pool,
        &runtime.system_start_id,
        rejected.work.agent_instance_id.as_ref().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(checkpoint, Some(memory(&first.work, "1")));
    assert_eq!(
        read_visits(
            &pool,
            &runtime.system_start_id,
            &rejected.work.flow_invocation_id
        )
        .await
        .unwrap()
        .iter()
        .find(|v| v.0 == ["first"])
        .unwrap()
        .1,
        "1"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_deliveries WHERE delivery_id='error-route'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}
#[tokio::test]
async fn structural_retransmissions_keep_original_text_and_reject_rounded_or_boolean_values() {
    let (_temp, pool, _receipt, runtime) = setup().await;
    let mut d = delivery(&pool, &runtime, "second", "exact").await;
    d.input.value_json = r#"{ "n":9007199254740993, "a":1 }"#.into();
    let original = accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    let mut equivalent = d.clone();
    equivalent.input.value_json = r#"{"a":1e0,"n":9007199254740993.0}"#.into();
    assert_eq!(
        accept_delivery(&pool, &runtime, equivalent).await.unwrap(),
        original
    );
    for value in [
        r#"{"a":true,"n":9007199254740993}"#,
        r#"{"a":1,"n":9007199254740992}"#,
    ] {
        let mut conflict = d.clone();
        conflict.input.value_json = value.into();
        assert!(accept_delivery(&pool, &runtime, conflict).await.is_err());
    }
    begin(&pool, &runtime, "exact").await.unwrap();
    seal_responses(&pool, &runtime, &d.work, "0").await.unwrap();
    let mut original = commit(&runtime, &d.work);
    original.outcome = EngineOutcome::Completed {
        output: EngineValue {
            origin: "agent".into(),
            value_json: r#"{ "a":1,"n":9007199254740993 }"#.into(),
        },
    };
    commit_terminal(&pool, original.clone(), &NoRoutes)
        .await
        .unwrap();
    let mut equivalent = original.clone();
    if let EngineOutcome::Completed { output } = &mut equivalent.outcome {
        output.value_json = r#"{"n":9007199254740993e0,"a":1.0}"#.into();
    }
    equivalent.memory.as_mut().unwrap().state_json = r#"{"number":9007199254740993e0}"#.into();
    assert!(!commit_terminal(&pool, equivalent, &NoRoutes).await.unwrap());
    let projection = read_projection(&pool, &runtime.system_start_id)
        .await
        .unwrap();
    assert_eq!(projection.activations[0].terminal, Some(original.outcome));
}
#[tokio::test]
async fn startup_reconciliation_requires_native_proof_and_resolves_old_effect_atomically() {
    let (temp, pool, receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "old-work").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    begin(&pool, &runtime, "old-work").await.unwrap();
    let mut tool = effect(&runtime, &d.work);
    tool.effect = EngineEffectIdentity::Tool {
        tool_invocation_id: "old-tool".into(),
        provider_attempt_id: None,
    };
    register_effect(&pool, tool.clone()).await.unwrap();
    pool.close().await;
    let reopened = create_pool(&temp.path().join("test.db")).await.unwrap();
    crate::db::reconcile_runtime_after_restart(&reopened)
        .await
        .unwrap();
    let retained = read_effects(&reopened, &d.work).await.unwrap();
    assert_eq!(retained[0].status, "uncertain");
    assert_eq!(retained[0].registered.context.owner, runtime);
    assert!(retained[0].settlement.is_none());
    let current = resume(&reopened, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    assert!(register_effect(&reopened, tool.clone()).await.is_err());
    let successor = delivery(&reopened, &current, "second", "next").await;
    let mut terminal = commit(&runtime, &d.work);
    terminal.outgoing = vec![successor.clone()];
    let proof = RecoveryProof {
        terminal: terminal.clone(),
        effects: vec![(
            EngineSettlement {
                context: tool.context.clone(),
                effect: tool.effect.clone(),
                status: "ended".into(),
                evidence_json: r#"{"ended":true}"#.into(),
            },
            Some(r#"{ "n":9007199254740993 }"#.into()),
        )],
    };
    let mut invalid = proof.clone();
    invalid.terminal.termination_evidence_json = "{}".into();
    assert!(resolve_recovered(
        &reopened,
        &current,
        &versions(),
        invalid,
        &VerifiedEnd,
        &SingleRoute(successor.clone())
    )
    .await
    .is_err());
    let mut changed_versions = versions();
    changed_versions.runtime = "other".into();
    assert!(resolve_recovered(
        &reopened,
        &current,
        &changed_versions,
        proof.clone(),
        &VerifiedEnd,
        &SingleRoute(successor.clone())
    )
    .await
    .is_err());
    let mut wrong = proof.clone();
    wrong.effects[0].0.context.work.activation_id = "other".into();
    assert!(resolve_recovered(
        &reopened,
        &current,
        &versions(),
        wrong,
        &VerifiedEnd,
        &SingleRoute(successor.clone())
    )
    .await
    .is_err());
    // A failure after effect settlement and checkpoint update must roll back both.
    sqlx::raw_sql("CREATE TRIGGER fail_successor BEFORE INSERT ON engine_deliveries WHEN NEW.delivery_id='next' BEGIN SELECT RAISE(ABORT,'synthetic'); END;").execute(&reopened).await.unwrap();
    assert!(resolve_recovered(
        &reopened,
        &current,
        &versions(),
        proof.clone(),
        &VerifiedEnd,
        &SingleRoute(successor.clone())
    )
    .await
    .is_err());
    assert_eq!(
        read_effects(&reopened, &d.work).await.unwrap()[0].status,
        "uncertain"
    );
    assert!(read_agent(
        &reopened,
        &receipt.system_start_id,
        d.work.agent_instance_id.as_ref().unwrap()
    )
    .await
    .unwrap()
    .1
    .is_none());
    sqlx::query("DROP TRIGGER fail_successor")
        .execute(&reopened)
        .await
        .unwrap();
    assert!(resolve_recovered(
        &reopened,
        &current,
        &versions(),
        proof.clone(),
        &VerifiedEnd,
        &SingleRoute(successor.clone())
    )
    .await
    .unwrap());
    assert!(!resolve_recovered(
        &reopened,
        &current,
        &versions(),
        proof,
        &VerifiedEnd,
        &SingleRoute(successor)
    )
    .await
    .unwrap());
    let retained = read_effects(&reopened, &d.work).await.unwrap();
    assert_eq!(retained[0].status, "ended");
    assert_eq!(
        retained[0].result_json.as_deref(),
        Some(r#"{ "n":9007199254740993 }"#)
    );
    assert_eq!(retained[0].registered.context.owner, runtime);
    assert!(commit_terminal(&reopened, terminal, &NoRoutes)
        .await
        .is_err());
    assert!(matches!(
        begin(&reopened, &current, "next").await.unwrap(),
        Admission::Admitted(..)
    ));
}
#[tokio::test]
async fn native_recovery_can_confirm_stop_without_replaying_a_tool() {
    let (_temp, pool, receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "cancel").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    begin(&pool, &runtime, "cancel").await.unwrap();
    let e = effect(&runtime, &d.work);
    register_effect(&pool, e.clone()).await.unwrap();
    let stop_request = EngineStopRequest {
        system_start_id: receipt.system_start_id.clone(),
        request_id: "cancel".into(),
        activation_id: None,
    };
    stop(&pool, stop_request.clone()).await.unwrap();
    crate::db::reconcile_runtime_after_restart(&pool)
        .await
        .unwrap();
    let current = resume(&pool, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    let mut terminal = commit(&runtime, &d.work);
    terminal.outcome = EngineOutcome::Stopped {
        evidence_json: r#"{"cancelledAndEnded":true}"#.into(),
    };
    let proof = RecoveryProof {
        terminal,
        effects: vec![(
            EngineSettlement {
                context: e.context,
                effect: e.effect,
                status: "ended".into(),
                evidence_json: r#"{"ended":true}"#.into(),
            },
            None,
        )],
    };
    resolve_recovered(&pool, &current, &versions(), proof, &VerifiedEnd, &NoRoutes)
        .await
        .unwrap();
    assert!(matches!(
        stop(&pool, stop_request).await.unwrap(),
        EngineStopState::Confirmed { .. }
    ));
}
