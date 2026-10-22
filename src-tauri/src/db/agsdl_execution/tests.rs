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
            private: capture::PrivateCapture {
                card_associations: vec![],
                registry_json: "{\"version\":\"registry-v1\"}".into(),
                native_catalogue_json: "{}".into(),
                implementation_digest: "synthetic-adapter".into(),
                call_scopes: vec![],
            },
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
        None,
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
    let mut e = effect(&runtime, &d.work);
    e.effect = EngineEffectIdentity::Tool {
        tool_invocation_id: "exact-result-tool".into(),
        provider_attempt_id: None,
    };
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

#[tokio::test]
async fn host_revocation_is_scoped_and_cannot_rotate_a_replacement_epoch() {
    let (_temp, pool, receipt, owner) = setup().await;
    let mut other_request = request();
    other_request.request_id = "other-system".into();
    let other = start(&pool, other_request, &Compiler).await.unwrap();
    let other_owner = resume(&pool, &other.system_start_id, &versions())
        .await
        .unwrap();
    revoke_host_owners(&pool, &[owner.clone()]).await.unwrap();
    let mut c = pool.acquire().await.unwrap();
    assert_ne!(
        load(&mut c, &receipt.system_start_id)
            .await
            .unwrap()
            .state
            .epoch,
        owner.owner_epoch
    );
    assert_eq!(
        load(&mut c, &other.system_start_id)
            .await
            .unwrap()
            .state
            .epoch,
        other_owner.owner_epoch
    );
    drop(c);
    let replacement = resume(&pool, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    revoke_host_owners(&pool, &[owner]).await.unwrap();
    let mut c = pool.acquire().await.unwrap();
    assert_eq!(
        load(&mut c, &receipt.system_start_id)
            .await
            .unwrap()
            .state
            .epoch,
        replacement.owner_epoch
    );
}

#[tokio::test]
async fn exact_response_journal_requires_attempt_receipts_and_physical_end_before_closure() {
    let (_temp, pool, _receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "response-delivery").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    assert!(matches!(
        begin(&pool, &runtime, &d.delivery_id).await.unwrap(),
        Admission::Admitted(..)
    ));
    let provider = effect(&runtime, &d.work);
    let mut emission = responses::Emission {
        context: provider.context.clone(),
        provider_attempt_id: "provider-1".into(),
        sequence: "1".into(),
        identity: "publication-1".into(),
        kind: "publication".into(),
        body_json: "{\"result\":9007199254740993}".into(),
    };
    assert!(responses::append(&pool, emission.clone()).await.is_err());
    register_effect(&pool, provider.clone()).await.unwrap();
    assert!(responses::append(&pool, emission.clone()).await.unwrap());
    emission.body_json = r#"{ "result": 9007199254740993.0 }"#.into();
    assert!(!responses::append(&pool, emission.clone()).await.unwrap());
    let (events, digest) = responses::read(&pool, &runtime, &d.work).await.unwrap();
    assert_eq!(events[0].body_json, "{\"result\":9007199254740993}");
    let closure = responses::Closure {
        owner: runtime.clone(),
        work: d.work.clone(),
        cursor: "1".into(),
        digest,
        validation_json: "{\"kind\":\"failure\",\"code\":\"OUTPUT_CONSTRAINT\"}".into(),
    };
    assert!(responses::close(&pool, closure.clone()).await.is_err());
    let settlement = EngineSettlement {
        context: provider.context,
        effect: provider.effect,
        status: "ended".into(),
        evidence_json: "{\"requestEnded\":true}".into(),
    };
    assert!(
        settle_effect(&pool, settlement.clone(), Some("null".into()))
            .await
            .is_err()
    );
    settle_effect(&pool, settlement, None).await.unwrap();
    responses::close(&pool, closure.clone()).await.unwrap();
    responses::close(&pool, closure.clone()).await.unwrap();
    emission.sequence = "2".into();
    emission.identity = "late".into();
    assert!(responses::append(&pool, emission).await.is_err());
    let mut changed = closure;
    changed.digest = "wrong".into();
    assert!(responses::close(&pool, changed).await.is_err());
}

#[tokio::test]
async fn approval_survives_reload_and_reserves_the_exact_tool_once() {
    let (temp, pool, _, runtime) = setup().await;
    let delivery = delivery(&pool, &runtime, "second", "approval-work").await;
    accept_delivery(&pool, &runtime, delivery.clone())
        .await
        .unwrap();
    begin(&pool, &runtime, "approval-work").await.unwrap();
    let mut tool = effect(&runtime, &delivery.work);
    tool.effect = EngineEffectIdentity::Tool {
        tool_invocation_id: "terminal-1".into(),
        provider_attempt_id: None,
    };
    tool.invocation_json = r#"{"tool":"terminal","arguments":{"command":"echo synthetic"}}"#.into();
    let request = approvals::Request {
        effect: tool.clone(),
        tool_name: "terminal".into(),
        summary: "echo synthetic".into(),
    };
    let pending = approvals::request(&pool, request.clone()).await.unwrap();
    assert_eq!(
        approvals::request(&pool, request)
            .await
            .unwrap()
            .approval_id,
        pending.approval_id
    );
    assert!(
        approvals::consume_and_register(&pool, &pending.approval_id, tool.clone())
            .await
            .is_err()
    );
    assert!(read_effects(&pool, &delivery.work)
        .await
        .unwrap()
        .is_empty());
    pool.close().await;
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    assert_eq!(
        approvals::pending(&pool, &runtime.system_start_id)
            .await
            .unwrap()[0]
            .approval_id,
        pending.approval_id
    );
    approvals::decide(&pool, &pending.approval_id, true)
        .await
        .unwrap();
    let mut changed = tool.clone();
    changed.invocation_json = r#"{"tool":"terminal","arguments":{"command":"changed"}}"#.into();
    assert!(
        approvals::consume_and_register(&pool, &pending.approval_id, changed)
            .await
            .is_err()
    );
    assert!(
        approvals::consume_and_register(&pool, &pending.approval_id, tool.clone())
            .await
            .unwrap()
    );
    assert!(
        !approvals::consume_and_register(&pool, &pending.approval_id, tool)
            .await
            .unwrap()
    );
    assert_eq!(read_effects(&pool, &delivery.work).await.unwrap().len(), 1);
}

#[tokio::test]
async fn stop_and_revocation_prevent_approved_but_unreserved_tools() {
    for stop_activation in [true, false] {
        let (_temp, pool, _, runtime) = setup().await;
        let delivery = delivery(&pool, &runtime, "second", "approval-stop").await;
        accept_delivery(&pool, &runtime, delivery.clone())
            .await
            .unwrap();
        begin(&pool, &runtime, "approval-stop").await.unwrap();
        let mut tool = effect(&runtime, &delivery.work);
        tool.effect = EngineEffectIdentity::Tool {
            tool_invocation_id: "waiting-tool".into(),
            provider_attempt_id: None,
        };
        let request = approvals::Request {
            effect: tool.clone(),
            tool_name: "terminal".into(),
            summary: "echo synthetic".into(),
        };
        let pending = approvals::request(&pool, request).await.unwrap();
        approvals::decide(&pool, &pending.approval_id, true)
            .await
            .unwrap();
        if stop_activation {
            stop(
                &pool,
                EngineStopRequest {
                    system_start_id: runtime.system_start_id.clone(),
                    request_id: "approval-stop".into(),
                    activation_id: Some(delivery.work.activation_id.clone()),
                },
            )
            .await
            .unwrap();
        } else {
            revoke_host_owners(&pool, std::slice::from_ref(&runtime))
                .await
                .unwrap();
        }
        assert!(
            approvals::consume_and_register(&pool, &pending.approval_id, tool)
                .await
                .is_err()
        );
        assert!(approvals::pending(&pool, &runtime.system_start_id)
            .await
            .unwrap()
            .is_empty());
        assert!(read_effects(&pool, &delivery.work)
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn private_capture_is_immutable_and_bounds_calls_without_an_agent() {
    struct Calls;
    impl CaptureAuthority for Calls {
        type CommitGuard = ();
        async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
            let mut captured = Compiler.capture(request, id).await?;
            captured.policies.push(StepPolicy {
                step: vec!["call".into()],
                agent_name: None,
                max_visits: None,
            });
            captured.private.call_scopes.push(capture::CallScope {
                step: vec!["call".into()],
                permissions_json: "[]".into(),
                scope_json: r#"{"project":"synthetic"}"#.into(),
            });
            Ok(captured)
        }
        async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
            Ok(())
        }
    }
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    let receipt = start(&pool, request(), &Calls).await.unwrap();
    let runtime = resume(&pool, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    let retained = capture::read(&pool, &runtime).await.unwrap();
    assert_eq!(
        retained.call_scopes[0].scope_json,
        r#"{"project":"synthetic"}"#
    );
    assert!(sqlx::query(
        "UPDATE engine_host_captures SET registry_json = '{}' WHERE system_id = ?"
    )
    .bind(&receipt.system_start_id)
    .execute(&pool)
    .await
    .is_err());
    let delivery = delivery(&pool, &runtime, "call", "call-work").await;
    accept_delivery(&pool, &runtime, delivery.clone())
        .await
        .unwrap();
    begin(&pool, &runtime, "call-work").await.unwrap();
    let mut invocation = effect(&runtime, &delivery.work);
    invocation.effect = EngineEffectIdentity::Tool {
        tool_invocation_id: "call-tool".into(),
        provider_attempt_id: None,
    };
    assert!(register_effect(&pool, invocation.clone()).await.is_err());
    invocation.context.scope_json = r#"{"project":"synthetic"}"#.into();
    assert!(register_effect(&pool, invocation).await.unwrap());
    pool.close().await;
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    assert!(record_equal(&retained, &capture::read(&pool, &runtime).await.unwrap()).unwrap());
}

#[tokio::test]
async fn public_run_pages_keep_their_owner_and_creation_boundary() {
    let (_temp, pool, original, _) = setup().await;
    for name in ["second-start", "third-start"] {
        let mut request = request();
        request.request_id = name.into();
        start(&pool, request, &Compiler).await.unwrap();
    }
    let owner = original.snapshot.source.owner.clone();
    let first = discovery::list_runs(
        &pool,
        discovery::RunListRequest {
            owner: owner.clone(),
            after: None,
            limit: Some(1),
        },
    )
    .await
    .unwrap();
    let cursor = first.next_cursor.clone().unwrap();
    let mut later = request();
    later.request_id = "later-start".into();
    let later = start(&pool, later, &Compiler).await.unwrap();
    let rest = discovery::list_runs(
        &pool,
        discovery::RunListRequest {
            owner: owner.clone(),
            after: Some(cursor.clone()),
            limit: Some(100),
        },
    )
    .await
    .unwrap();
    assert_eq!(rest.runs.len(), 2);
    assert!(rest
        .runs
        .iter()
        .all(|run| run.system_start_id != later.system_start_id
            && run.system_start_id != first.runs[0].system_start_id));
    assert!(rest.next_cursor.is_none());
    let mut foreign = owner.clone();
    foreign.project_id = "other".into();
    assert!(discovery::list_runs(
        &pool,
        discovery::RunListRequest {
            owner: foreign.clone(),
            after: Some(cursor),
            limit: None
        }
    )
    .await
    .is_err());
    assert!(discovery::find_start(&pool, &foreign, "start")
        .await
        .is_err());
    assert!(discovery::find_start(&pool, &owner, "absent")
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        discovery::find_start(&pool, &owner, "start")
            .await
            .unwrap()
            .unwrap()
            .system_start_id,
        original.system_start_id
    );
}

#[tokio::test]
async fn public_diagnostics_are_historical_bounded_and_source_scoped() {
    let (_temp, pool, receipt, runtime) = setup().await;
    let delivery = delivery(&pool, &runtime, "second", "diagnostic-work").await;
    accept_delivery(&pool, &runtime, delivery.clone())
        .await
        .unwrap();
    begin(&pool, &runtime, "diagnostic-work").await.unwrap();
    mark_uncertain(&pool, &runtime, &delivery.work, "private provider data")
        .await
        .unwrap();
    let through = read_projection(&pool, &runtime.system_start_id)
        .await
        .unwrap()
        .cursor;
    let request = diagnostics::DiagnosticRequest {
        selected: None,
        before: None,
        recent: false,
        system_start_id: runtime.system_start_id.clone(),
        source: receipt.snapshot.source.clone(),
        activation_id: Some(delivery.work.activation_id.clone()),
        through,
    };
    let first = diagnostics::read(&pool, request.clone()).await.unwrap();
    assert_eq!(first.diagnostics.len(), 1);
    assert!(!serde_json::to_string(&first)
        .unwrap()
        .contains("private provider data"));
    for _ in 0..66 {
        mark_uncertain(&pool, &runtime, &delivery.work, "later private data")
            .await
            .unwrap();
    }
    assert_eq!(
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&diagnostics::read(&pool, request.clone()).await.unwrap()).unwrap()
    );
    let mut latest = request.clone();
    latest.through = read_projection(&pool, &runtime.system_start_id)
        .await
        .unwrap()
        .cursor;
    let page = diagnostics::read(&pool, latest.clone()).await.unwrap();
    assert!(page.incomplete);
    assert_eq!(page.diagnostics.len(), 64);
    let mut recent = latest.clone();
    recent.recent = true;
    let last = diagnostics::read(&pool, recent.clone()).await.unwrap();
    assert_eq!(last.diagnostics[0].sequence, latest.through);
    recent.before = last.next_before.clone();
    let older = diagnostics::read(&pool, recent).await.unwrap();
    assert_eq!(older.diagnostics.len(), 3);
    assert!(!older.incomplete);
    let chosen = &last.diagnostics[0];
    latest.selected = Some(vec![diagnostics::DiagnosticIdentity {
        id: chosen.id.clone(),
        sequence: chosen.sequence.clone(),
    }]);
    let selected = diagnostics::read(&pool, latest.clone()).await.unwrap();
    assert_eq!(selected.diagnostics.len(), 1);
    assert_eq!(selected.diagnostics[0].id, chosen.id);
    latest.selected.as_mut().unwrap()[0].id = "foreign:1".into();
    assert!(diagnostics::read(&pool, latest).await.is_err());
    let mut foreign = request.clone();
    foreign.source.owner.project_id = "other".into();
    assert!(diagnostics::read(&pool, foreign).await.is_err());
    let mut unknown = request;
    unknown.activation_id = Some("foreign-activation".into());
    assert!(diagnostics::read(&pool, unknown).await.is_err());
}

const ROUTED_SOURCE: &str = r#"{"flow":{"steps":{"second":{"type":"agent","agent":"a","next":["b"]},"b":{"type":"agent","agent":"b","next":[]}}}}"#;
struct RoutedCompiler;
impl CaptureAuthority for RoutedCompiler {
    type CommitGuard = ();
    async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
        let mut capture = Compiler.capture(request, id).await?;
        capture.snapshot.authored_source = ROUTED_SOURCE.into();
        Ok(capture)
    }
    async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
        Ok(())
    }
}
async fn prepared_fixture() -> (TempDir, SqlitePool, EngineOwner, prepared::Prepare) {
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    let mut req = request();
    req.source.source_sha256 = format!("{:x}", Sha256::digest(ROUTED_SOURCE.as_bytes()));
    let receipt = start(&pool, req, &RoutedCompiler).await.unwrap();
    let runtime = resume(&pool, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    let delivery = delivery(&pool, &runtime, "second", "prepared").await;
    accept_delivery(&pool, &runtime, delivery.clone())
        .await
        .unwrap();
    begin(&pool, &runtime, &delivery.delivery_id).await.unwrap();
    let (_, digest) = responses::read(&pool, &runtime, &delivery.work)
        .await
        .unwrap();
    responses::close(
        &pool,
        responses::Closure {
            owner: runtime.clone(),
            work: delivery.work.clone(),
            cursor: "0".into(),
            digest: digest.clone(),
            validation_json: r#"{"kind":"success","text":"done","resultsJson":"{}","choice":null}"#
                .into(),
        },
    )
    .await
    .unwrap();
    let request = prepared::Prepare {
        owner: runtime.clone(),
        work: delivery.work.clone(),
        outcome: EngineOutcome::Completed {
            output: EngineValue {
                origin: "agent".into(),
                value_json: r#"{"text":"done","results":{}}"#.into(),
            },
        },
        response_cursor: "0".into(),
        termination_evidence_json: "{}".into(),
        memory: Some(memory(&delivery.work, "1")),
        validation: prepared::Validation {
            snapshot_digest: prepared::snapshot_digest(&receipt.snapshot).unwrap(),
            input: delivery.input,
            declaration_json: Some(r#"{"type":"agent","agent":"a","next":["b"]}"#.into()),
            closure_digest: digest,
            selected_branch: None,
        },
    };
    (temp, pool, runtime, request)
}
#[tokio::test]
async fn prepared_terminal_retains_native_successor_and_final_receipt_after_reopen() {
    let (temp, pool, runtime, request) = prepared_fixture().await;
    let id = prepared::prepare(&pool, "generation", request.clone())
        .await
        .unwrap();
    assert_eq!(
        prepared::prepare(&pool, "generation", request.clone())
            .await
            .unwrap(),
        id
    );
    let committed = prepared::commit(&pool, "generation", &runtime, &id)
        .await
        .unwrap();
    assert_eq!(committed.outgoing.len(), 1);
    assert_eq!(committed.outgoing[0].work.step, Some(vec!["b".into()]));
    assert_ne!(
        committed.outgoing[0].work.activation_id,
        request.work.activation_id
    );
    pool.close().await;
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    assert!(record_equal(
        &committed,
        &prepared::commit(&pool, "generation", &runtime, &id)
            .await
            .unwrap()
    )
    .unwrap());
    assert!(prepared::commit(&pool, "another-generation", &runtime, &id)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_deliveries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}
#[tokio::test]
async fn targeted_stop_between_prepare_and_commit_removes_the_retained_successor() {
    let (_temp, pool, runtime, request) = prepared_fixture().await;
    let id = prepared::prepare(&pool, "generation", request.clone())
        .await
        .unwrap();
    stop(
        &pool,
        EngineStopRequest {
            system_start_id: runtime.system_start_id.clone(),
            request_id: "targeted".into(),
            activation_id: Some(request.work.activation_id.clone()),
        },
    )
    .await
    .unwrap();
    let terminal = prepared::commit(&pool, "generation", &runtime, &id)
        .await
        .unwrap();
    assert!(terminal.outgoing.is_empty());
    let projection = read_projection(&pool, &runtime.system_start_id)
        .await
        .unwrap();
    assert!(matches!(
        projection.activations[0].stop_state,
        EngineStopState::Confirmed { .. }
    ));

    assert!(prepared::commit(&pool, "generation", &runtime, &id)
        .await
        .unwrap()
        .outgoing
        .is_empty());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_deliveries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
#[tokio::test]
async fn terminal_witness_refuses_unrelated_input_declaration_and_publication() {
    let (_temp, pool, _runtime, request) = prepared_fixture().await;
    let mut wrong = request.clone();
    wrong.validation.input.value_json = "{}".into();
    assert!(prepared::prepare(&pool, "generation", wrong).await.is_err());
    let mut wrong = request.clone();
    wrong.validation.declaration_json = Some(r#"{"type":"agent","next":[]}"#.into());
    assert!(prepared::prepare(&pool, "generation", wrong).await.is_err());
    let mut wrong = request.clone();
    wrong.validation.closure_digest = "unrelated".into();
    assert!(prepared::prepare(&pool, "generation", wrong).await.is_err());
    let mut wrong = request.clone();
    wrong.outcome = EngineOutcome::Completed {
        output: EngineValue {
            origin: "agent".into(),
            value_json: r#"{"text":"changed","results":{}}"#.into(),
        },
    };
    assert!(prepared::prepare(&pool, "generation", wrong).await.is_err());
    prepared::prepare(&pool, "generation", request)
        .await
        .unwrap();
}

#[tokio::test]
async fn condition_route_uses_frozen_declaration_and_retains_exact_input_origin() {
    let (_temp, pool, runtime, mut request) = prepared_fixture().await;
    let mut snapshot = read_snapshot(&pool, &runtime.system_start_id)
        .await
        .unwrap();
    let declaration = r#"{"type":"condition","test":{"equals":[{"path":["n"]},{"value":9007199254740993}]},"next":{"true":["b"],"false":[]}}"#;
    snapshot.authored_source = format!(r#"{{"flow":{{"steps":{{"second":{declaration}}}}}}}"#);
    // The proposed compiled routes do not grant authority.
    snapshot.compiled_plan_json = r#"{"routes":{"true":[["invented"]]}}"#.into();
    request.validation.declaration_json = Some(declaration.into());
    request.validation.selected_branch = Some("true".into());
    request.validation.input = EngineValue {
        origin: "call".into(),
        value_json: r#"{"n":9007199254740993}"#.into(),
    };
    request.outcome = EngineOutcome::Completed {
        output: request.validation.input.clone(),
    };
    assert_eq!(
        prepared::target(&snapshot, &request).unwrap(),
        Some(vec!["b".into()])
    );
    request.validation.selected_branch = Some("false".into());
    assert_eq!(prepared::target(&snapshot, &request).unwrap(), None);
    request.validation.selected_branch = Some("invented".into());
    assert!(prepared::target(&snapshot, &request).is_err());
    request.validation.selected_branch = Some("true".into());
    request.outcome = EngineOutcome::Completed {
        output: EngineValue {
            origin: "call".into(),
            value_json: r#"{"n":9007199254740992}"#.into(),
        },
    };
    assert!(prepared::target(&snapshot, &request).is_err());
    request.outcome = EngineOutcome::Completed {
        output: EngineValue {
            origin: "entry".into(),
            value_json: request.validation.input.value_json.clone(),
        },
    };
    assert!(prepared::target(&snapshot, &request).is_err());
}

#[tokio::test]
async fn prepared_failure_rejects_backend_diagnostics_and_mismatched_portable_codes() {
    let (_temp, pool, _runtime, mut request) = prepared_fixture().await;
    request.outcome = EngineOutcome::Failed {
        code: "STOP_PENDING".into(),
        error_json: r#"{"error":{"code":"STOP_PENDING","message":"","details":[]}}"#.into(),
    };
    assert!(prepared::prepare(&pool, "generation", request.clone())
        .await
        .is_err());
    request.outcome = EngineOutcome::Failed {
        code: "OUTPUT_CONSTRAINT".into(),
        error_json: r#"{"error":{"code":"CALL_RESULT","message":"","details":[]}}"#.into(),
    };
    assert!(prepared::prepare(&pool, "generation", request)
        .await
        .is_err());
}

#[tokio::test]
async fn host_inspection_retains_exact_effect_results_and_refuses_stale_owner() {
    let (_temp, pool, receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "inspect").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    begin(&pool, &runtime, "inspect").await.unwrap();
    let mut e = effect(&runtime, &d.work);
    e.effect = EngineEffectIdentity::Tool {
        tool_invocation_id: "inspect-tool".into(),
        provider_attempt_id: None,
    };
    register_effect(&pool, e.clone()).await.unwrap();
    let result = "{ \"n\": 9007199254740993 }";
    settle_effect(
        &pool,
        EngineSettlement {
            context: e.context,
            effect: e.effect,
            status: "ended".into(),
            evidence_json: "{}".into(),
        },
        Some(result.into()),
    )
    .await
    .unwrap();
    let view = inspection::read(&pool, &runtime).await.unwrap();
    assert_eq!(view.snapshot, receipt.snapshot);
    assert_eq!(view.agents.len(), 2);
    assert_eq!(view.effects[0].result_json.as_deref(), Some(result));
    assert!(view.response_closures_json.is_empty());
    assert!(view.prepared_terminals_json.is_empty());
    let stale = EngineOwner {
        owner_epoch: "0".into(),
        ..runtime
    };
    assert!(inspection::read(&pool, &stale).await.is_err());
}

#[tokio::test]
async fn external_graphless_delivery_uses_native_ids_and_keeps_its_exact_receipt() {
    struct Graphless;
    impl CaptureAuthority for Graphless {
        type CommitGuard = ();
        async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
            let mut capture = Compiler.capture(request, id).await?;
            capture.entry_step = None;
            capture.policies.clear();
            Ok(capture)
        }
        async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
            Ok(())
        }
    }
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("external.db")).await.unwrap();
    let receipt = start(&pool, request(), &Graphless).await.unwrap();
    let runtime = EngineOwner {
        system_start_id: receipt.system_start_id.clone(),
        owner_epoch: "0".into(),
    };
    assert!(read_projection(&pool, &receipt.system_start_id)
        .await
        .unwrap()
        .activations
        .is_empty());
    let message =
        r#"{"resources":{"item":{"mediaType":"application/json","value":9007199254740993}}}"#;
    let first = accept_external_delivery(&pool, &runtime, "external", "a", message)
        .await
        .unwrap();
    assert_eq!(first.delivery.input.origin, "entry");
    assert!(first.delivery.work.step.is_none());
    assert!(!first.delivery.work.activation_id.is_empty());
    assert_eq!(first.delivery.input.value_json, message);
    assert_eq!(
        accept_external_delivery(&pool, &runtime, "external", "a", message)
            .await
            .unwrap(),
        first
    );
    assert!(
        accept_external_delivery(&pool, &runtime, "external", "b", message)
            .await
            .is_err()
    );
    assert!(accept_external_delivery(
        &pool,
        &runtime,
        "external",
        "a",
        &message.replace("9007199254740993", "9007199254740992")
    )
    .await
    .is_err());
    assert!(
        accept_external_delivery(&pool, &runtime, "missing", "unknown", message)
            .await
            .is_err()
    );
    stop(
        &pool,
        EngineStopRequest {
            system_start_id: runtime.system_start_id.clone(),
            request_id: "stop".into(),
            activation_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        accept_external_delivery(&pool, &runtime, "external", "a", message)
            .await
            .unwrap(),
        first
    );
    assert!(
        accept_external_delivery(&pool, &runtime, "new", "a", message)
            .await
            .is_err()
    );
    let (_temp, graph_pool, _receipt, graph_owner) = setup().await;
    assert!(
        accept_external_delivery(&graph_pool, &graph_owner, "graph", "a", message)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn call_witness_requires_exact_retained_result_and_matching_invocation() {
    const DECLARATION: &str = r#"{"type":"call","binding":"read","next":[]}"#;
    const BINDING: &str = r#"{"contract":{"identity":"macro/tool/read","version":"1"},"implementation":{"identity":"macro/desktop","version":"1"}}"#;
    struct CallCompiler;
    impl CaptureAuthority for CallCompiler {
        type CommitGuard = ();
        async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
            let mut capture = Compiler.capture(request, id).await?;
            capture.snapshot.authored_source = format!(
                r#"{{"bindings":{{"read":{BINDING}}},"flow":{{"steps":{{"second":{DECLARATION}}}}}}}"#
            );
            capture
                .policies
                .iter_mut()
                .find(|p| p.step == ["second"])
                .unwrap()
                .agent_name = None;
            capture.private.call_scopes.push(capture::CallScope {
                step: vec!["second".into()],
                permissions_json: "[]".into(),
                scope_json: "{}".into(),
            });
            Ok(capture)
        }
        async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
            Ok(())
        }
    }
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    let mut start_request = request();
    let source = format!(
        r#"{{"bindings":{{"read":{BINDING}}},"flow":{{"steps":{{"second":{DECLARATION}}}}}}}"#
    );
    start_request.source.source_sha256 = format!("{:x}", Sha256::digest(source.as_bytes()));
    let started = start(&pool, start_request, &CallCompiler).await.unwrap();
    let runtime = resume(&pool, &started.system_start_id, &versions())
        .await
        .unwrap();
    let delivery = delivery(&pool, &runtime, "second", "native-call").await;
    accept_delivery(&pool, &runtime, delivery.clone())
        .await
        .unwrap();
    begin(&pool, &runtime, &delivery.delivery_id).await.unwrap();
    let (_, digest) = responses::read(&pool, &runtime, &delivery.work)
        .await
        .unwrap();
    responses::close(
        &pool,
        responses::Closure {
            owner: runtime.clone(),
            work: delivery.work.clone(),
            cursor: "0".into(),
            digest: digest.clone(),
            validation_json: r#"{"kind":"success"}"#.into(),
        },
    )
    .await
    .unwrap();
    let mut request = prepared::Prepare {
        owner: runtime.clone(),
        work: delivery.work.clone(),
        outcome: EngineOutcome::Completed {
            output: EngineValue {
                origin: "call".into(),
                value_json: "{}".into(),
            },
        },
        response_cursor: "0".into(),
        termination_evidence_json: "{}".into(),
        memory: None,
        validation: prepared::Validation {
            snapshot_digest: prepared::snapshot_digest(&started.snapshot).unwrap(),
            input: delivery.input,
            declaration_json: Some(DECLARATION.into()),
            closure_digest: digest,
            selected_branch: None,
        },
    };
    let binding = BINDING;
    request.outcome = EngineOutcome::Completed {
        output: EngineValue {
            origin: "call".into(),
            value_json: r#"{"data":9007199254740993}"#.into(),
        },
    };
    assert!(
        prepared::prepare(&pool, "generation", request.clone())
            .await
            .is_err(),
        "no invocation cannot complete"
    );
    let mut tool = effect(&runtime, &request.work);
    tool.effect = EngineEffectIdentity::Tool {
        tool_invocation_id: "call-result".into(),
        provider_attempt_id: None,
    };
    tool.invocation_json =
        serde_json::json!({"bindingJson":binding,"argumentsJson":"{}"}).to_string();
    // Fixture inserts a retained physical receipt; validation itself reads the actual SQL row.
    sqlx::query("INSERT INTO engine_effects VALUES (?,?,?,?,?,?,?)")
        .bind(&runtime.system_start_id)
        .bind(&request.work.activation_id)
        .bind(effect_key(&tool.effect).unwrap())
        .bind(encode(&tool).unwrap())
        .bind("ended")
        .bind(
            encode(&EngineSettlement {
                context: tool.context.clone(),
                effect: tool.effect.clone(),
                status: "ended".into(),
                evidence_json: r#"{"failed":false}"#.into(),
            })
            .unwrap(),
        )
        .bind("9007199254740993")
        .execute(&pool)
        .await
        .unwrap();
    let mut wrong = request.clone();
    wrong.outcome = EngineOutcome::Completed {
        output: EngineValue {
            origin: "call".into(),
            value_json: r#"{"data":9007199254740992}"#.into(),
        },
    };
    assert!(
        prepared::prepare(&pool, "generation", wrong).await.is_err(),
        "rounded or changed result must fail"
    );
    let correct = encode(&tool).unwrap();
    tool.invocation_json = r#"{"bindingJson":"{}","argumentsJson":"{}"}"#.into();
    sqlx::query("UPDATE engine_effects SET record_json=? WHERE system_id=?")
        .bind(encode(&tool).unwrap())
        .bind(&runtime.system_start_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        prepared::prepare(&pool, "generation", request.clone())
            .await
            .is_err(),
        "another binding must fail"
    );
    sqlx::query("UPDATE engine_effects SET record_json=? WHERE system_id=?")
        .bind(correct)
        .bind(&runtime.system_start_id)
        .execute(&pool)
        .await
        .unwrap();
    prepared::prepare(&pool, "generation", request)
        .await
        .unwrap();
}

#[tokio::test]
async fn uncertainty_is_work_local_and_public_approval_rejects_foreign_source() {
    let (_temp, pool, receipt, runtime) = setup().await;
    let a = delivery(&pool, &runtime, "second", "work-local").await;
    accept_delivery(&pool, &runtime, a.clone()).await.unwrap();
    begin(&pool, &runtime, &a.delivery_id).await.unwrap();
    let mut tool = effect(&runtime, &a.work);
    tool.effect = EngineEffectIdentity::Tool {
        tool_invocation_id: "approval-local".into(),
        provider_attempt_id: None,
    };
    let approval = approvals::request(
        &pool,
        approvals::Request {
            effect: tool,
            tool_name: "read".into(),
            summary: "Read synthetic file".into(),
        },
    )
    .await
    .unwrap();
    let scope = approvals::ApprovalScope {
        system_start_id: runtime.system_start_id.clone(),
        source: receipt.snapshot.source.clone(),
    };
    assert_eq!(
        approvals::pending_public(&pool, scope.clone())
            .await
            .unwrap()
            .approvals
            .len(),
        1
    );
    let mut foreign = scope.clone();
    foreign.source.owner.project_id = "foreign".into();
    assert!(approvals::decide_public(
        &pool,
        approvals::ApprovalDecision {
            scope: foreign,
            approval_id: approval.approval_id.clone(),
            approve: true
        }
    )
    .await
    .is_err());
    mark_uncertain(&pool, &runtime, &a.work, "one work failed")
        .await
        .unwrap();
    assert!(approvals::decide_public(
        &pool,
        approvals::ApprovalDecision {
            scope,
            approval_id: approval.approval_id,
            approve: true
        }
    )
    .await
    .is_err());
    let b = delivery(&pool, &runtime, "b", "other-agent").await;
    accept_delivery(&pool, &runtime, b.clone()).await.unwrap();
    assert!(matches!(
        begin(&pool, &runtime, &b.delivery_id).await.unwrap(),
        Admission::Admitted(..)
    ));
}

#[tokio::test]
async fn public_projection_pages_all_retained_activations_at_one_cursor() {
    let (_temp, pool, receipt, owner) = setup().await;
    let first = delivery(&pool, &owner, "second", "page-000").await;
    accept_delivery(&pool, &owner, first.clone()).await.unwrap();
    assert!(matches!(
        begin(&pool, &owner, "page-000").await.unwrap(),
        Admission::Admitted(..)
    ));
    seal_responses(&pool, &owner, &first.work, "0")
        .await
        .unwrap();
    commit_terminal(&pool, commit(&owner, &first.work), &NoRoutes)
        .await
        .unwrap();
    for index in 1..130 {
        let d = delivery(&pool, &owner, "second", &format!("page-{index:03}")).await;
        accept_delivery(&pool, &owner, d).await.unwrap();
    }
    let all = read_projection(&pool, &receipt.system_start_id)
        .await
        .unwrap();
    let first_page = public::projection(&pool, &receipt.system_start_id, None)
        .await
        .unwrap();
    assert_eq!(first_page.activations.len(), 64);
    let cursor = first_page.cursor.clone();
    let mut ids = std::collections::BTreeSet::new();
    let mut page = first_page;
    let mut found_terminal = false;
    loop {
        assert_eq!(page.cursor, cursor);
        assert!(page.activations.len() <= 64 && page.agents.len() <= 64);
        if !ids.is_empty() {
            assert!(page.agents.is_empty());
        }
        for a in &page.activations {
            assert!(ids.insert(a.work.activation_id.clone()));
            if a.work.activation_id == first.work.activation_id {
                assert_eq!(a.terminal_kind.as_deref(), Some("completed"));
                found_terminal = true;
            }
        }
        match page.next_page {
            Some(ref next) => {
                page = public::projection(&pool, &receipt.system_start_id, Some(next))
                    .await
                    .unwrap()
            }
            None => break,
        }
    }
    assert!(found_terminal);
    assert_eq!(ids.len(), all.activations.len());
    assert!(ids.len() >= 130);
    let continuation = public::ProjectionPage { cursor, offset: 64 };
    let next = delivery(&pool, &owner, "second", "page-new").await;
    accept_delivery(&pool, &owner, next).await.unwrap();
    assert!(
        public::projection(&pool, &receipt.system_start_id, Some(&continuation))
            .await
            .is_err()
    );
    let fresh = public::projection(&pool, &receipt.system_start_id, None)
        .await
        .unwrap();
    assert_ne!(fresh.cursor, continuation.cursor);
    assert!(public::projection(
        &pool,
        &receipt.system_start_id,
        Some(&public::ProjectionPage {
            cursor: fresh.cursor,
            offset: 999_999_936,
        })
    )
    .await
    .is_err());
}

#[tokio::test]
async fn public_events_reject_future_and_keep_current_boundary_idempotent() {
    let (_temp, pool, receipt, owner) = setup().await;
    let d = delivery(&pool, &owner, "second", "events-boundary").await;
    accept_delivery(&pool, &owner, d).await.unwrap();
    let state = read_projection(&pool, &receipt.system_start_id)
        .await
        .unwrap();
    assert!(read_events(
        &pool,
        &receipt.system_start_id,
        Some("999999999999999999999"),
        64
    )
    .await
    .is_err());
    for _ in 0..2 {
        let end = read_events(&pool, &receipt.system_start_id, Some(&state.cursor), 64)
            .await
            .unwrap();
        assert!(end.events.is_empty());
        assert!(!end.has_more);
        assert_eq!(end.next_cursor, state.cursor);
    }
    let mut after = "0".to_owned();
    loop {
        let page = read_events(&pool, &receipt.system_start_id, Some(&after), 1)
            .await
            .unwrap();
        assert!(page.events.len() <= 1);
        for event in &page.events {
            assert!(order(&event.sequence, &after).is_gt());
            assert!(order(&event.sequence, &state.cursor).is_le());
        }
        after = page.next_cursor;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(after, state.cursor);
}

struct ManyAgentsCompiler;
impl CaptureAuthority for ManyAgentsCompiler {
    type CommitGuard = ();
    async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
        let mut captured = Compiler.capture(request, id).await?;
        captured
            .snapshot
            .agents
            .extend((0..130).map(|i| configuration(&format!("paged-{i:03}"))));
        Ok(captured)
    }
    async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn public_projection_pages_agents_after_activations_are_exhausted() {
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    let receipt = start(&pool, request(), &ManyAgentsCompiler).await.unwrap();
    let mut page = public::projection(&pool, &receipt.system_start_id, None)
        .await
        .unwrap();
    let mut names = Vec::new();
    let mut lengths = Vec::new();
    loop {
        lengths.push(page.agents.len());
        names.extend(page.agents.iter().map(|a| a.agent_name.clone()));
        if lengths.len() > 1 {
            assert!(page.activations.is_empty());
        }
        match page.next_page {
            Some(ref next) => {
                page = public::projection(&pool, &receipt.system_start_id, Some(next))
                    .await
                    .unwrap()
            }
            None => break,
        }
    }
    assert_eq!(lengths, [64, 64, 4]);
    let expected = receipt
        .snapshot
        .agents
        .iter()
        .map(|a| a.agent_name.clone())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(names, expected.into_iter().collect::<Vec<_>>());
}

#[tokio::test]
async fn public_projection_rejects_invalid_page_tokens() {
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
    let receipt = start(&pool, request(), &ManyAgentsCompiler).await.unwrap();
    let current = public::projection(&pool, &receipt.system_start_id, None)
        .await
        .unwrap();
    for cursor in [
        "",
        "00",
        "01",
        "-1",
        "1.0",
        " 1",
        "1e2",
        "999999999999999999999",
    ] {
        let page = public::ProjectionPage {
            cursor: cursor.into(),
            offset: 64,
        };
        assert!(
            public::projection(&pool, &receipt.system_start_id, Some(&page))
                .await
                .is_err(),
            "cursor {cursor:?}"
        );
    }
    for offset in [0, 1, 63, 65, 192, u32::MAX] {
        let page = public::ProjectionPage {
            cursor: current.cursor.clone(),
            offset,
        };
        assert!(
            public::projection(&pool, &receipt.system_start_id, Some(&page))
                .await
                .is_err(),
            "offset {offset}"
        );
    }
    for raw in [
        r#"{"cursor":"1","offset":-1}"#,
        r#"{"cursor":"1","offset":1.5}"#,
        r#"{"cursor":"1","offset":4294967296}"#,
        r#"{"cursor":"1","offset":64,"extra":true}"#,
    ] {
        assert!(serde_json::from_str::<public::ProjectionPage>(raw).is_err());
    }
    for after in ["", "00", "-1", "1.0", " 1", "1e2"] {
        assert!(
            read_events(&pool, &receipt.system_start_id, Some(after), 64)
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn stop_commits_while_tool_policy_or_source_revalidation_is_pending() {
    use crate::agsdl_host::HostState;
    use crate::agsdl_host_compiler::CompileBroker;
    use std::sync::Arc;
    use std::time::Duration;
    for stop_at in ["compiler", "source", "none"] {
        let (_temp, pool, receipt, owner) = setup().await;
        let d = delivery(&pool, &owner, "second", "pending-policy").await;
        accept_delivery(&pool, &owner, d.clone()).await.unwrap();
        begin(&pool, &owner, "pending-policy").await.unwrap();
        let mut invocation = effect(&owner, &d.work);
        invocation.effect = EngineEffectIdentity::Tool {
            tool_invocation_id: "delayed-policy".into(),
            provider_attempt_id: None,
        };
        let host = Arc::new(HostState::default());
        let broker = Arc::new(CompileBroker::default());
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let worker_host = host.clone();
        let worker_broker = broker.clone();
        let worker_pool = pool.clone();
        let snapshot = receipt.snapshot.clone();
        let pending = tokio::spawn(async move {
            let (_policy, (), _gate) = crate::agsdl_host_tools::policy_admission(
                &worker_host,
                worker_broker.compile("generation", snapshot.source, snapshot.authored_source,
                    r#"{"version":"registry","toolPolicyInput":{"invocationIdentity":"delayed-policy"}}"#.into()),
                async {
                    if stop_at == "source" {
                        waiting_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                    }
                    Ok(())
                },
            ).await?;
            register_effect(&worker_pool, invocation.clone()).await?;
            authorize_reserved_effect(&worker_pool, &invocation).await
        });
        let job = broker.next().await.unwrap();
        let response = serde_json::json!({"runtime":{"registryVersion":"registry","source":job.source,"supported":false},
            "compiledPlanJson":null,"toolPolicy":{"input":{"invocationIdentity":"delayed-policy"},"decision":"allow"}}).to_string();
        if stop_at == "source" {
            broker
                .complete("generation", &job.ticket, response.clone())
                .unwrap();
            waiting_rx.await.unwrap();
        }
        if stop_at != "none" {
            tokio::time::timeout(Duration::from_secs(2), async {
                let _gate = host.admission_gate().await;
                stop(
                    &pool,
                    EngineStopRequest {
                        system_start_id: receipt.system_start_id.clone(),
                        request_id: "stop-pending-policy".into(),
                        activation_id: None,
                    },
                )
                .await
                .unwrap();
            })
            .await
            .expect("Stop must commit before the compiler or source wait is released");
            assert!(matches!(
                read_projection(&pool, &receipt.system_start_id)
                    .await
                    .unwrap()
                    .system_stop,
                EngineStopState::Requested { .. }
            ));
            assert!(read_effects(&pool, &d.work).await.unwrap().is_empty());
        }
        if stop_at == "source" {
            release_tx.send(()).unwrap();
        } else {
            broker
                .complete("generation", &job.ticket, response)
                .unwrap();
        }
        let result = pending.await.unwrap();
        if stop_at == "none" {
            result.unwrap();
            assert_eq!(read_effects(&pool, &d.work).await.unwrap().len(), 1);
        } else {
            assert_eq!(
                result.unwrap_err().message,
                "Stopped or uncertain work cannot dispatch"
            );
            assert!(read_effects(&pool, &d.work).await.unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn ensure_stop_retains_targeted_keys_and_witnesses_beyond_public_page() {
    for target in [
        EngineStopState::Requested {
            request_id: "target-A".into(),
        },
        EngineStopState::Uncertain {
            request_id: "target-A".into(),
            reason: "native-witness-pending".into(),
        },
        EngineStopState::Confirmed {
            request_id: "target-A".into(),
            evidence_json: "{\"nativeWitness\":1}".into(),
        },
    ] {
        let (_temp, pool, receipt, runtime) = setup().await;
        for n in 0..70 {
            let d = delivery(&pool, &runtime, "second", &format!("d-{n:03}")).await;
            accept_delivery(&pool, &runtime, d).await.unwrap();
        }
        let id = "activation-d-069";
        let mut connection = pool.acquire().await.unwrap();
        let mut stored = load(&mut connection, &receipt.system_start_id)
            .await
            .unwrap();
        let a = stored.state.activations.get_mut(id).unwrap();
        a.work_state = "active".into();
        a.stop_state = target.clone();
        save(&mut connection, &receipt.system_start_id, &stored.state)
            .await
            .unwrap();
        drop(connection);
        let before = public::projection(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        assert!(!before
            .activations
            .iter()
            .any(|a| a.work.activation_id == id));
        let system = ensure_stop(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        assert!(matches!(system, EngineStopState::Requested { .. }));
        assert_eq!(
            read_stop_target(&pool, &receipt.system_start_id, Some(id))
                .await
                .unwrap(),
            target
        );
        assert_eq!(
            ensure_stop(&pool, &receipt.system_start_id, Some(id))
                .await
                .unwrap(),
            target
        );
        assert_eq!(
            ensure_stop(&pool, &receipt.system_start_id, None)
                .await
                .unwrap(),
            system
        );
        assert!(stop(
            &pool,
            EngineStopRequest {
                system_start_id: receipt.system_start_id.clone(),
                activation_id: Some(id.into()),
                request_id: "conflict-C".into(),
            }
        )
        .await
        .is_err());
        assert_eq!(
            read_stop_target(&pool, &receipt.system_start_id, Some(id))
                .await
                .unwrap(),
            target
        );
    }
}

#[tokio::test]
async fn ensure_stop_gate_orders_authorization_and_simulated_spawn_in_both_orders() {
    use crate::agsdl_host::HostState;
    use std::sync::Arc;
    for stop_first in [false, true] {
        let (_temp, pool, receipt, runtime) = setup().await;
        let d = delivery(&pool, &runtime, "second", "gate-delivery").await;
        accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
        begin(&pool, &runtime, "gate-delivery").await.unwrap();
        let invocation = effect(&runtime, &d.work);
        register_effect(&pool, invocation.clone()).await.unwrap();
        let host = Arc::new(HostState::default());
        if stop_first {
            let gate = host.admission_gate().await;
            ensure_stop(&pool, &receipt.system_start_id, None)
                .await
                .unwrap();
            drop(gate);
            let _gate = host.admission_gate().await;
            assert!(authorize_reserved_effect(&pool, &invocation).await.is_err());
        } else {
            let gate = host.admission_gate().await;
            authorize_reserved_effect(&pool, &invocation).await.unwrap();
            let worker_host = host.clone();
            let worker_pool = pool.clone();
            let system_id = receipt.system_start_id.clone();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let stop = tokio::spawn(async move {
                started_tx.send(()).unwrap();
                let _gate = worker_host.admission_gate().await;
                ensure_stop(&worker_pool, &system_id, None).await.unwrap()
            });
            started_rx.await.unwrap();
            tokio::task::yield_now().await;
            assert!(
                !stop.is_finished(),
                "Stop cannot cross authorization-to-spawn gate"
            );
            // Synthetic physical-start boundary. No provider is run by this test.
            let spawned = tokio::spawn(async { true });
            drop(gate);
            assert!(spawned.await.unwrap());
            assert!(matches!(
                stop.await.unwrap(),
                EngineStopState::Requested { .. }
            ));
        }
    }
}

async fn intent_fixture() -> (TempDir, SqlitePool, intents::ExecutionStageIntentRequest) {
    use intents::*;
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("intents.db")).await.unwrap();
    sqlx::query("INSERT INTO conversations(id,title,project_id,created_at,updated_at) VALUES('conversation','Synthetic','project','0','0')").execute(&pool).await.unwrap();
    let mut request = request();
    request.entry = Some(EngineEntry {
        delivery_id: "reserved-entry".into(),
        message_json: "{\"n\":1.0}".into(),
    });
    let staged = ExecutionStageIntentRequest {
        scope: ExecutionIntentScope {
            owner: request.source.owner.clone(),
            conversation_id: "conversation".into(),
        },
        intent_id: "intent".into(),
        payload: ExecutionIntentPayload::Start { request },
    };
    (temp, pool, staged)
}
#[tokio::test]
async fn intent_file_reopen_identity_scope_reservations_and_closed_ack_loss() {
    use intents::*;
    let (temp, pool, staged) = intent_fixture().await;
    let source = match &staged.payload {
        ExecutionIntentPayload::Start { request } => request.source.clone(),
        _ => unreachable!(),
    };
    let first = stage(&pool, staged.clone(), &source).await.unwrap();
    let mut changed = staged.clone();
    if let ExecutionIntentPayload::Start { request } = &mut changed.payload {
        request.entry.as_mut().unwrap().message_json = "{\"n\":1}".into();
    }
    assert_eq!(
        stage(&pool, changed, &source).await.unwrap_err().code,
        ExecutionIntentErrorCode::IdentityConflict
    );
    let mut other = staged.clone();
    other.intent_id = "other".into();
    let occupied = stage(&pool, other.clone(), &source).await.unwrap_err();
    assert_eq!(occupied.code, ExecutionIntentErrorCode::SlotOccupied);
    assert_eq!(occupied.current_intent_key, Some(first.key.clone()));
    let mut hidden = first.key.clone();
    hidden.scope.owner.plan_id = "other-plan".into();
    assert!(read(&pool, &hidden).await.unwrap().is_none());
    hidden = first.key.clone();
    hidden.scope.conversation_id = "absent".into();
    assert_eq!(
        read(&pool, &hidden).await.unwrap_err().code,
        ExecutionIntentErrorCode::ScopeInvalid
    );
    let close_request = ExecutionCloseIntentRequest {
        key: first.key.clone(),
        expected_revision: first.revision,
        disposition: ExecutionIntentDisposition::Discarded,
    };
    let closed = close(&pool, &close_request).await.unwrap();
    assert_eq!(closed.revision, "2");
    assert!(read_open(&pool, &first.key.scope).await.unwrap().is_empty());
    assert_eq!(close(&pool, &close_request).await.unwrap().revision, "2");
    let opposite = ExecutionCloseIntentRequest {
        disposition: ExecutionIntentDisposition::Acknowledged,
        ..close_request.clone()
    };
    assert_eq!(
        close(&pool, &opposite).await.unwrap_err().code,
        ExecutionIntentErrorCode::CloseConflict
    );
    assert_eq!(
        stage(&pool, other, &source).await.unwrap_err().code,
        ExecutionIntentErrorCode::IdentityConflict
    );
    for statement in [
        "UPDATE engine_ui_intents SET payload_json = '{}'",
        "UPDATE engine_ui_intents SET status = 'prepared', disposition = NULL",
        "DELETE FROM engine_ui_intents",
    ] {
        assert!(sqlx::query(statement).execute(&pool).await.is_err());
    }
    pool.close().await;
    let pool = create_pool(&temp.path().join("intents.db")).await.unwrap();
    assert!(matches!(
        read(&pool, &first.key).await.unwrap().unwrap().state,
        ExecutionIntentState::Closed {
            disposition: ExecutionIntentDisposition::Discarded,
            admission: None
        }
    ));
    let mut edited = source.clone();
    edited.revision = "42".into();
    edited.source_sha256 = "b".repeat(64);
    assert_eq!(stage(&pool, staged, &edited).await.unwrap().revision, "2");
}

#[tokio::test]
async fn intent_atomic_link_fault_rolls_back_engine_and_retry_keeps_exact_request() {
    use intents::*;
    let (temp, pool, staged) = intent_fixture().await;
    let request = match &staged.payload {
        ExecutionIntentPayload::Start { request } => request.clone(),
        _ => unreachable!(),
    };
    let row = stage(&pool, staged, &request.source).await.unwrap();
    assert_eq!(
        start(&pool, request.clone(), &Compiler)
            .await
            .unwrap_err()
            .code,
        "INTENT_IDENTITY_CONFLICT"
    );
    let Submission::Dispatch(link) = begin_submission(&pool, &row.key, &request.source)
        .await
        .unwrap()
    else {
        panic!("dispatch")
    };
    sqlx::query("CREATE TRIGGER synthetic_link_fault BEFORE UPDATE ON engine_ui_intents WHEN NEW.status = 'admitted' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END").execute(&pool).await.unwrap();
    let injected = start_linked(&pool, request.clone(), &Compiler, Some(&link))
        .await
        .unwrap_err();
    assert_eq!(injected.code, "STORAGE");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_systems")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        finish_failure(&pool, &row.key, &injected)
            .await
            .unwrap_err()
            .code,
        ExecutionIntentErrorCode::StorageUncertain
    );
    assert!(matches!(
        read(&pool, &row.key).await.unwrap().unwrap().state,
        ExecutionIntentState::SubmissionPending {
            retryable_failure: None
        }
    ));
    sqlx::query("DROP TRIGGER synthetic_link_fault")
        .execute(&pool)
        .await
        .unwrap();
    let retry = finish_failure(
        &pool,
        &row.key,
        &failure("RUNTIME_UNAVAILABLE", "", "synthetic unavailable"),
    )
    .await
    .unwrap();
    assert!(matches!(
        retry.state,
        ExecutionIntentState::SubmissionPending {
            retryable_failure: Some(ExecutionIntentRetryableCode::RuntimeUnavailable)
        }
    ));
    let Submission::Dispatch(link) = begin_submission(&pool, &row.key, &request.source)
        .await
        .unwrap()
    else {
        panic!("dispatch")
    };
    let receipt = start_linked(&pool, request.clone(), &Compiler, Some(&link))
        .await
        .unwrap();
    let admitted = finish_failure(
        &pool,
        &row.key,
        &failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "synthetic post-commit attachment failure",
        ),
    )
    .await
    .unwrap();
    assert!(matches!(
        admitted.state,
        ExecutionIntentState::Admitted { .. }
    ));
    assert_eq!(
        start(&pool, request.clone(), &Compiler)
            .await
            .unwrap_err()
            .code,
        "INTENT_IDENTITY_CONFLICT"
    );
    assert_eq!(
        start_linked(&pool, request.clone(), &Compiler, Some(&link))
            .await
            .unwrap()
            .system_start_id,
        receipt.system_start_id
    );
    assert_eq!(
        read(&pool, &row.key).await.unwrap().unwrap().revision,
        admitted.revision
    );
    let ack = ExecutionCloseIntentRequest {
        key: row.key.clone(),
        expected_revision: admitted.revision,
        disposition: ExecutionIntentDisposition::Acknowledged,
    };
    close(&pool, &ack).await.unwrap();
    assert!(matches!(
        close(&pool, &ack).await.unwrap().state,
        ExecutionIntentState::Closed {
            admission: Some(_),
            ..
        }
    ));
    assert_eq!(
        start_linked(&pool, request, &Compiler, Some(&link))
            .await
            .unwrap()
            .system_start_id,
        receipt.system_start_id
    );
    pool.close().await;
    let reopened = create_pool(&temp.path().join("intents.db")).await.unwrap();
    assert!(matches!(
        read(&reopened, &row.key).await.unwrap().unwrap().state,
        ExecutionIntentState::Closed {
            admission: Some(ExecutionIntentAdmission::Start { .. }),
            ..
        }
    ));
}

#[tokio::test]
async fn intent_source_refusal_and_sql_conversation_proof_do_not_compile() {
    use intents::*;
    let (_temp, pool, staged) = intent_fixture().await;
    let source = match &staged.payload {
        ExecutionIntentPayload::Start { request } => request.source.clone(),
        _ => unreachable!(),
    };
    let row = stage(&pool, staged, &source).await.unwrap();
    let mut changed = source;
    changed.revision = "43".into();
    let Submission::Retained(refused) = begin_submission(&pool, &row.key, &changed).await.unwrap()
    else {
        panic!("stale source dispatched")
    };
    assert!(matches!(
        refused.state,
        ExecutionIntentState::Refused {
            code: ExecutionIntentRefusalCode::SourceChanged
        }
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_systems")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE conversations SET project_id = 'other' WHERE id = 'conversation'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        read(&pool, &row.key).await.unwrap_err().code,
        ExecutionIntentErrorCode::ScopeInvalid
    );
    sqlx::query("UPDATE conversations SET project_id = 'project' WHERE id = 'conversation'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        read(&pool, &row.key).await.unwrap().unwrap().state,
        ExecutionIntentState::Refused { .. }
    ));
}

#[tokio::test]
async fn intent_start_final_transaction_rechecks_reservations_created_during_capture() {
    use intents::*;
    struct ReserveDuringCapture {
        pool: SqlitePool,
        staged: ExecutionStageIntentRequest,
    }
    impl CaptureAuthority for ReserveDuringCapture {
        type CommitGuard = ();
        async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
            stage(&self.pool, self.staged.clone(), &request.source)
                .await
                .unwrap();
            Compiler.capture(request, id).await
        }
        async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
            Ok(())
        }
    }
    let (_temp, pool, staged) = intent_fixture().await;
    let request = match &staged.payload {
        ExecutionIntentPayload::Start { request } => request.clone(),
        _ => unreachable!(),
    };
    let authority = ReserveDuringCapture {
        pool: pool.clone(),
        staged,
    };
    assert_eq!(
        start(&pool, request, &authority).await.unwrap_err().code,
        "INTENT_IDENTITY_CONFLICT"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_systems")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn intent_delivery_link_is_atomic_and_all_unlinked_accept_paths_are_reserved() {
    use intents::*;
    struct Graphless;
    impl CaptureAuthority for Graphless {
        type CommitGuard = ();
        async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
            let mut capture = Compiler.capture(request, id).await?;
            capture.policies.clear();
            capture.entry_step = None;
            Ok(capture)
        }
        async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
            Ok(())
        }
    }
    let (_temp, pool, _) = intent_fixture().await;
    let receipt = start(&pool, request(), &Graphless).await.unwrap();
    let runtime = resume(&pool, &receipt.system_start_id, &versions())
        .await
        .unwrap();
    let request = crate::agsdl_host_capture::ExecutionExternalDelivery {
        system_start_id: receipt.system_start_id.clone(),
        delivery_id: "external".into(),
        agent_name: "a".into(),
        message_json: "{\"n\":1.0}".into(),
    };
    let staged = ExecutionStageIntentRequest {
        scope: ExecutionIntentScope {
            owner: receipt.snapshot.source.owner.clone(),
            conversation_id: "conversation".into(),
        },
        intent_id: "deliver-intent".into(),
        payload: ExecutionIntentPayload::Deliver {
            source: receipt.snapshot.source.clone(),
            request: request.clone(),
        },
    };
    let row = stage(&pool, staged, &receipt.snapshot.source)
        .await
        .unwrap();
    assert_eq!(
        accept_external_delivery(
            &pool,
            &runtime,
            &request.delivery_id,
            &request.agent_name,
            &request.message_json
        )
        .await
        .unwrap_err()
        .code,
        "INTENT_IDENTITY_CONFLICT"
    );
    let Submission::Dispatch(link) = begin_submission(&pool, &row.key, &receipt.snapshot.source)
        .await
        .unwrap()
    else {
        panic!("dispatch")
    };
    sqlx::query("CREATE TRIGGER synthetic_delivery_fault BEFORE UPDATE ON engine_ui_intents WHEN NEW.status = 'admitted' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END").execute(&pool).await.unwrap();
    assert_eq!(
        accept_external_delivery_linked(
            &pool,
            &runtime,
            &request.delivery_id,
            &request.agent_name,
            &request.message_json,
            Some(&link)
        )
        .await
        .unwrap_err()
        .code,
        "STORAGE"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER synthetic_delivery_fault")
        .execute(&pool)
        .await
        .unwrap();
    let accepted = accept_external_delivery_linked(
        &pool,
        &runtime,
        &request.delivery_id,
        &request.agent_name,
        &request.message_json,
        Some(&link),
    )
    .await
    .unwrap();
    assert_eq!(
        accept_external_delivery_linked(
            &pool,
            &runtime,
            &request.delivery_id,
            &request.agent_name,
            &request.message_json,
            Some(&link)
        )
        .await
        .unwrap(),
        accepted
    );
    assert_eq!(
        accept_external_delivery(
            &pool,
            &runtime,
            &request.delivery_id,
            &request.agent_name,
            &request.message_json
        )
        .await
        .unwrap_err()
        .code,
        "INTENT_IDENTITY_CONFLICT"
    );
    assert_eq!(
        accept_delivery(&pool, &runtime, accepted.delivery.clone())
            .await
            .unwrap_err()
            .code,
        "INTENT_IDENTITY_CONFLICT"
    );
    assert!(matches!(
        read(&pool, &row.key).await.unwrap().unwrap().state,
        ExecutionIntentState::Admitted {
            admission: ExecutionIntentAdmission::Deliver { .. }
        }
    ));
}

#[tokio::test]
async fn intent_reserved_successor_rejects_entire_terminal_transaction_without_substitution() {
    use intents::*;
    let (_temp, pool, staged) = intent_fixture().await;
    let ordinary = start(&pool, request(), &Compiler).await.unwrap();
    let owner = resume(&pool, &ordinary.system_start_id, &versions())
        .await
        .unwrap();
    let mut staged = staged;
    if let ExecutionIntentPayload::Start { request } = &mut staged.payload {
        request.request_id = "reserved-start".into();
    }
    stage(&pool, staged, &ordinary.snapshot.source)
        .await
        .unwrap();
    let incoming = delivery(&pool, &owner, "second", "incoming").await;
    accept_delivery(&pool, &owner, incoming.clone())
        .await
        .unwrap();
    begin(&pool, &owner, "incoming").await.unwrap();
    let successor = delivery(&pool, &owner, "second", "reserved-entry").await;
    assert_eq!(
        accept_delivery(&pool, &owner, successor.clone())
            .await
            .unwrap_err()
            .code,
        "INTENT_IDENTITY_CONFLICT"
    );
    seal_responses(&pool, &owner, &incoming.work, "0")
        .await
        .unwrap();
    let mut terminal = commit(&owner, &incoming.work);
    terminal.outgoing.push(successor.clone());
    assert_eq!(
        commit_terminal(&pool, terminal, &SingleRoute(successor))
            .await
            .unwrap_err()
            .code,
        "INTENT_IDENTITY_CONFLICT"
    );
    let projection = read_projection(&pool, &ordinary.system_start_id)
        .await
        .unwrap();
    let activation = projection
        .activations
        .iter()
        .find(|a| a.delivery.delivery.delivery_id == "incoming")
        .unwrap();
    assert_eq!(activation.work_state, "active");
    assert!(activation.terminal.is_none());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn ensure_stop_target_and_system_confirm_only_after_native_terminal_witness() {
    let (_temp, pool, receipt, owner) = setup().await;
    let d = delivery(&pool, &owner, "second", "active-target").await;
    accept_delivery(&pool, &owner, d.clone()).await.unwrap();
    begin(&pool, &owner, "active-target").await.unwrap();
    let targeted = EngineStopRequest {
        system_start_id: receipt.system_start_id.clone(),
        activation_id: Some(d.work.activation_id.clone()),
        request_id: "target-A".into(),
    };
    stop(&pool, targeted.clone()).await.unwrap();
    let system = ensure_stop(&pool, &receipt.system_start_id, None)
        .await
        .unwrap();
    assert!(matches!(system, EngineStopState::Requested { .. }));
    assert_eq!(
        read_stop_target(&pool, &receipt.system_start_id, Some(&d.work.activation_id))
            .await
            .unwrap(),
        EngineStopState::Requested {
            request_id: "target-A".into()
        }
    );
    seal_responses(&pool, &owner, &d.work, "0").await.unwrap();
    let mut terminal = commit(&owner, &d.work);
    terminal.outcome = EngineOutcome::Stopped {
        evidence_json: "{\"ended\":true}".into(),
    };
    commit_terminal(&pool, terminal, &NoRoutes).await.unwrap();
    assert!(
        matches!(read_stop_target(&pool,&receipt.system_start_id,Some(&d.work.activation_id)).await.unwrap(),EngineStopState::Confirmed{request_id,..} if request_id=="target-A")
    );
    let system_key = match system {
        EngineStopState::Requested { request_id } => request_id,
        _ => unreachable!(),
    };
    assert!(
        matches!(ensure_stop(&pool,&receipt.system_start_id,None).await.unwrap(),EngineStopState::Confirmed{request_id,..} if request_id==system_key)
    );
}

#[tokio::test]
async fn intent_owned_submission_keeps_close_immediate_during_real_sqlite_wait() {
    use intents::*;
    use std::sync::Arc;
    let (_temp, pool, staged) = intent_fixture().await;
    let source = match &staged.payload {
        ExecutionIntentPayload::Start { request } => request.source.clone(),
        _ => unreachable!(),
    };
    let row = stage(&pool, staged, &source).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    let tx = durable(&mut connection).await.unwrap();
    let coordinator = Arc::new(crate::agsdl_intent_coordinator::IntentCoordinator::default());
    let worker = coordinator.clone();
    let key = row.key.clone();
    let worker_key = key.clone();
    let worker_pool = pool.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (completed_tx, completed_rx) = tokio::sync::oneshot::channel();
    let observer = tokio::spawn(async move {
        worker
            .submit(worker_key.clone(), move || async move {
                entered_tx.send(()).unwrap();
                let submission = begin_submission(&worker_pool, &worker_key, &source).await?;
                assert!(matches!(submission, Submission::Dispatch(_)));
                let result = read(&worker_pool, &worker_key).await?.unwrap();
                completed_tx.send(()).unwrap();
                Ok(result)
            })
            .await
    });
    entered_rx.await.unwrap();
    tokio::task::yield_now().await;
    assert!(matches!(
        coordinator.reserve_close(&key),
        Err(ExecutionIntentError {
            code: ExecutionIntentErrorCode::SubmissionInProgress,
            ..
        })
    ));
    assert!(!observer.is_finished());
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    tx.rollback().await.unwrap();
    drop(connection);
    tokio::time::timeout(std::time::Duration::from_secs(3), completed_rx)
        .await
        .unwrap()
        .unwrap();
    tokio::task::yield_now().await;
    assert!(matches!(
        read(&pool, &key).await.unwrap().unwrap().state,
        ExecutionIntentState::SubmissionPending {
            retryable_failure: None
        }
    ));
    assert!(coordinator.reserve_close(&key).is_ok());
    let before = read(&pool, &key).await.unwrap().unwrap().revision;
    crate::db::reconcile_runtime_after_restart(&pool)
        .await
        .unwrap();
    assert_eq!(read(&pool, &key).await.unwrap().unwrap().revision, before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_systems")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn intent_sqlite_constraints_reject_open_scope_and_tombstone_key_collisions() {
    use intents::*;
    let (_temp, pool, staged) = intent_fixture().await;
    let source = match &staged.payload {
        ExecutionIntentPayload::Start { request } => request.source.clone(),
        _ => unreachable!(),
    };
    let row = stage(&pool, staged, &source).await.unwrap();
    // Deliberately bypass the repository to verify SQLite's durable constraints.
    let duplicate_scope="INSERT INTO engine_ui_intents SELECT 'other',format_version,project_id,plan_id,branch,conversation_id,kind,'other-request','other-delivery',payload_json,'prepared','1',NULL,NULL,NULL,NULL FROM engine_ui_intents WHERE intent_id = 'intent'";
    assert!(sqlx::query(duplicate_scope).execute(&pool).await.is_err());
    close(
        &pool,
        &ExecutionCloseIntentRequest {
            key: row.key,
            expected_revision: row.revision,
            disposition: ExecutionIntentDisposition::Discarded,
        },
    )
    .await
    .unwrap();
    for statement in [
        "INSERT INTO engine_ui_intents SELECT 'other',format_version,'other-project',plan_id,branch,'other-conversation',kind,request_id,'other-delivery',payload_json,'prepared','1',NULL,NULL,NULL,NULL FROM engine_ui_intents WHERE intent_id = 'intent'",
        "INSERT INTO engine_ui_intents SELECT 'other',format_version,'other-project',plan_id,branch,'other-conversation',kind,'other-request',delivery_id,payload_json,'prepared','1',NULL,NULL,NULL,NULL FROM engine_ui_intents WHERE intent_id = 'intent'",
    ] {assert!(sqlx::query(statement).execute(&pool).await.is_err());}
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_ui_intents")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}

const CONDITION_SOURCE: &str = r#"{"flow":{"steps":{"second":{"type":"agent","agent":"a","next":["check"]},"check":{"type":"condition","test":{"equals":[{"path":["text"]},{"value":"done"}]},"next":{"true":[],"false":["b"]}},"b":{"type":"agent","agent":"b","next":[]}}}}"#;
struct ConditionCompiler;
impl CaptureAuthority for ConditionCompiler {
    type CommitGuard = ();
    async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
        let mut capture = Compiler.capture(request, id).await?;
        capture.snapshot.authored_source = CONDITION_SOURCE.into();
        capture.policies.push(StepPolicy {
            step: vec!["check".into()],
            agent_name: None,
            max_visits: None,
        });
        Ok(capture)
    }
    async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
        Ok(())
    }
}
/// A Condition forwards the value it received. An Agent or Call origin on that
/// value must not trigger the publication checks of the step that produced it.
#[tokio::test]
async fn condition_after_agent_or_call_prepares_its_forwarded_value() {
    for origin in ["agent", "call"] {
        let temp = TempDir::new().unwrap();
        let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
        let mut req = request();
        req.source.source_sha256 = format!("{:x}", Sha256::digest(CONDITION_SOURCE.as_bytes()));
        let receipt = start(&pool, req, &ConditionCompiler).await.unwrap();
        let runtime = resume(&pool, &receipt.system_start_id, &versions())
            .await
            .unwrap();
        let mut delivery = delivery(&pool, &runtime, "check", &format!("check-{origin}")).await;
        delivery.input = EngineValue {
            origin: origin.into(),
            value_json: r#"{"text":"first","results":{}}"#.into(),
        };
        accept_delivery(&pool, &runtime, delivery.clone())
            .await
            .unwrap();
        begin(&pool, &runtime, &delivery.delivery_id).await.unwrap();
        let (_, digest) = responses::read(&pool, &runtime, &delivery.work)
            .await
            .unwrap();
        // The resident Flow closes a pure step with an empty publication.
        responses::close(
            &pool,
            responses::Closure {
                owner: runtime.clone(),
                work: delivery.work.clone(),
                cursor: "0".into(),
                digest: digest.clone(),
                validation_json: r#"{"kind":"success","text":"","resultsJson":"{}","choice":null}"#
                    .into(),
            },
        )
        .await
        .unwrap();
        let request = prepared::Prepare {
            owner: runtime.clone(),
            work: delivery.work.clone(),
            outcome: EngineOutcome::Completed {
                output: delivery.input.clone(),
            },
            response_cursor: "0".into(),
            termination_evidence_json: "{}".into(),
            memory: None,
            validation: prepared::Validation {
                snapshot_digest: prepared::snapshot_digest(&receipt.snapshot).unwrap(),
                input: delivery.input.clone(),
                declaration_json: Some(
                    r#"{"type":"condition","test":{"equals":[{"path":["text"]},{"value":"done"}]},"next":{"true":[],"false":["b"]}}"#
                        .into(),
                ),
                closure_digest: digest,
                selected_branch: Some("false".into()),
            },
        };
        // Both refusals happen before any witness exists for this work, so they
        // cannot come from a conflicting earlier preparation.
        let mut changed = request.clone();
        changed.outcome = EngineOutcome::Completed {
            output: EngineValue {
                origin: origin.into(),
                value_json: r#"{"text":"done","results":{}}"#.into(),
            },
        };
        assert_eq!(
            prepared::prepare(&pool, "generation", changed)
                .await
                .unwrap_err()
                .message,
            "Condition changed its durable input"
        );
        let mut invented = request.clone();
        invented.validation.selected_branch = Some("invented".into());
        let refused = prepared::prepare(&pool, "generation", invented)
            .await
            .unwrap_err();
        assert_eq!(
            (refused.code.as_str(), refused.message.as_str()),
            ("CORRELATION", "Condition validation is incomplete")
        );
        let witnesses: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM engine_prepared_terminals WHERE activation_id = ?",
        )
        .bind(&delivery.work.activation_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(witnesses, 0);
        let witness = prepared::prepare(&pool, "generation", request.clone())
            .await
            .unwrap_or_else(|error| panic!("{origin} condition refused: {}", error.message));
        let commit = prepared::commit(&pool, "generation", &runtime, &witness)
            .await
            .unwrap();
        assert_eq!(commit.outgoing.len(), 1);
        assert_eq!(commit.outgoing[0].work.step, Some(vec!["b".into()]));
        assert_eq!(commit.outgoing[0].input, delivery.input);
    }
}

#[tokio::test]
async fn stop_join_after_revoked_ownership_stays_pending_without_settlement() {
    let (_temp, pool, receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "d").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    begin(&pool, &runtime, "d").await.unwrap();
    let e = effect(&runtime, &d.work);
    register_effect(&pool, e.clone()).await.unwrap();
    stop(
        &pool,
        EngineStopRequest {
            system_start_id: receipt.system_start_id.clone(),
            request_id: "stop".into(),
            activation_id: None,
        },
    )
    .await
    .unwrap();
    revoke_host_owners(&pool, &[runtime.clone()]).await.unwrap();
    let row = |pool: SqlitePool| async move {
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT status, settlement_json FROM engine_effects WHERE effect_key = 'provider:provider-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
    };
    let before = row(pool.clone()).await;
    assert_eq!(before.0, "uncertain");

    // Revoked owner: the contract's pending Stop, no settlement and no confirmation.
    for ended in [true, false] {
        let error = settle_provider_join(&pool, e.context.clone(), "provider-1", ended)
            .await
            .unwrap_err();
        assert_eq!(error.code, "STOP_PENDING");
    }
    assert_eq!(row(pool.clone()).await, before);
    let projection = read_projection(&pool, &receipt.system_start_id)
        .await
        .unwrap();
    assert!(matches!(
        projection.system_stop,
        EngineStopState::Requested { .. }
    ));

    // A context the owner never registered is still a correlation failure.
    let mut foreign = e.context.clone();
    foreign.permissions_json = "[\"other\"]".into();
    assert_eq!(
        settle_provider_join(&pool, foreign, "provider-1", true)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    assert_eq!(
        settle_provider_join(&pool, e.context.clone(), "provider-unknown", true)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    assert_eq!(row(pool.clone()).await, before);
}

#[tokio::test]
async fn stop_join_by_current_owner_records_ended_or_keeps_uncertainty() {
    for ended in [true, false] {
        let (_temp, pool, _receipt, runtime) = setup().await;
        let d = delivery(&pool, &runtime, "second", "d").await;
        accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
        begin(&pool, &runtime, "d").await.unwrap();
        let e = effect(&runtime, &d.work);
        register_effect(&pool, e.clone()).await.unwrap();
        let result = settle_provider_join(&pool, e.context.clone(), "provider-1", ended).await;
        let status: String = sqlx::query_scalar(
            "SELECT status FROM engine_effects WHERE effect_key = 'provider:provider-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        if ended {
            result.unwrap();
            assert_eq!(status, "ended");
        } else {
            assert_eq!(result.unwrap_err().code, "STOP_PENDING");
            assert_eq!(status, "uncertain");
        }
    }
}

#[tokio::test]
async fn stop_recovers_only_revoked_calls_with_cancelled_undispatched_approval() {
    struct Calls;
    impl CaptureAuthority for Calls {
        type CommitGuard = ();
        async fn capture(&self, request: &EngineStartRequest, id: &str) -> Result<TrustedCapture> {
            let mut capture = Compiler.capture(request, id).await?;
            capture.policies.push(StepPolicy {
                step: vec!["call".into()],
                agent_name: None,
                max_visits: None,
            });
            capture.private.call_scopes.push(capture::CallScope {
                step: vec!["call".into()],
                permissions_json: "[]".into(),
                scope_json: "{}".into(),
            });
            Ok(capture)
        }
        async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
            Ok(())
        }
    }
    for dispatched in [false, true] {
        let temp = TempDir::new().unwrap();
        let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
        let receipt = start(&pool, request(), &Calls).await.unwrap();
        let runtime = resume(&pool, &receipt.system_start_id, &versions())
            .await
            .unwrap();
        let work = delivery(&pool, &runtime, "call", "crash-call").await;
        accept_delivery(&pool, &runtime, work.clone())
            .await
            .unwrap();
        begin(&pool, &runtime, "crash-call").await.unwrap();
        let mut invocation = effect(&runtime, &work.work);
        invocation.effect = EngineEffectIdentity::Tool {
            tool_invocation_id: "approval-call".into(),
            provider_attempt_id: None,
        };
        let approval = approvals::request(
            &pool,
            approvals::Request {
                effect: invocation.clone(),
                tool_name: "write".into(),
                summary: "Write synthetic file".into(),
            },
        )
        .await
        .unwrap();
        if dispatched {
            approvals::decide(&pool, &approval.approval_id, true)
                .await
                .unwrap();
            approvals::consume_and_register(&pool, &approval.approval_id, invocation.clone())
                .await
                .unwrap();
        }
        ensure_stop(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        confirm_stopped_undispatched_calls(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        assert_eq!(
            read_projection(&pool, &receipt.system_start_id)
                .await
                .unwrap()
                .activations[0]
                .work_state,
            "active"
        );
        resume(&pool, &receipt.system_start_id, &versions())
            .await
            .unwrap();
        confirm_stopped_undispatched_calls(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        let projection = read_projection(&pool, &receipt.system_start_id)
            .await
            .unwrap();
        assert_eq!(
            projection.activations[0].work_state,
            if dispatched { "uncertain" } else { "terminal" }
        );
        assert_eq!(
            matches!(projection.system_stop, EngineStopState::Confirmed { .. }),
            !dispatched
        );
        assert!(
            approvals::consume_and_register(&pool, &approval.approval_id, invocation)
                .await
                .is_err()
        );
        let cursor = projection.cursor;
        confirm_stopped_undispatched_calls(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        assert_eq!(
            read_projection(&pool, &receipt.system_start_id)
                .await
                .unwrap()
                .cursor,
            cursor
        );
    }
}

#[tokio::test]
async fn retired_native_receipts_close_stop_only_after_every_effect_ends() {
    let (_temp, pool, receipt, runtime) = setup().await;
    let d = delivery(&pool, &runtime, "second", "retired").await;
    accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
    begin(&pool, &runtime, "retired").await.unwrap();
    let provider = effect(&runtime, &d.work);
    register_effect(&pool, provider.clone()).await.unwrap();
    let mut tool = provider.clone();
    tool.effect = EngineEffectIdentity::Tool {
        tool_invocation_id: "tool-retired".into(),
        provider_attempt_id: Some("provider-1".into()),
    };
    register_effect(&pool, tool.clone()).await.unwrap();
    revoke_host_owners(&pool, std::slice::from_ref(&runtime))
        .await
        .unwrap();
    ensure_stop(&pool, &receipt.system_start_id, None)
        .await
        .unwrap();
    let joined = EngineSettlement {
        context: provider.context.clone(),
        effect: provider.effect.clone(),
        status: "ended".into(),
        evidence_json: "{\"joined\":true}".into(),
    };
    let mut foreign = joined.clone();
    foreign.context.scope_json = "{\"foreign\":true}".into();
    assert!(settle_owned_effect(&pool, foreign, None).await.is_err());
    let mut uncertain = joined.clone();
    uncertain.status = "uncertain".into();
    assert!(settle_owned_effect(&pool, uncertain, None).await.is_err());
    settle_owned_effect(&pool, joined.clone(), None)
        .await
        .unwrap();
    let partial = read_projection(&pool, &receipt.system_start_id)
        .await
        .unwrap();
    assert_eq!(partial.activations[0].work_state, "uncertain");
    assert!(!matches!(
        partial.system_stop,
        EngineStopState::Confirmed { .. }
    ));
    let ended = EngineSettlement {
        context: tool.context.clone(),
        effect: tool.effect.clone(),
        status: "ended".into(),
        evidence_json: "{\"physicalEnd\":true}".into(),
    };
    assert!(settle_owned_effect(&pool, ended.clone(), None)
        .await
        .is_err());
    settle_owned_effect(&pool, ended.clone(), Some("\"actual result\"".into()))
        .await
        .unwrap();
    let final_state = read_projection(&pool, &receipt.system_start_id)
        .await
        .unwrap();
    assert!(matches!(
        final_state.system_stop,
        EngineStopState::Confirmed { .. }
    ));
    assert!(matches!(
        final_state.activations[0].terminal,
        Some(EngineOutcome::Stopped { .. })
    ));
    let before = final_state.cursor;
    settle_owned_effect(&pool, joined, None).await.unwrap();
    settle_owned_effect(&pool, ended.clone(), Some("\"actual result\"".into()))
        .await
        .unwrap();
    assert_eq!(
        read_projection(&pool, &receipt.system_start_id)
            .await
            .unwrap()
            .cursor,
        before
    );
    assert!(
        settle_owned_effect(&pool, ended, Some("\"different result\"".into()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn process_exit_recovery_preserves_unknown_tool_outcome_and_never_replays() {
    let mut child =
        crate::core::process::background_command(if cfg!(windows) { "cmd" } else { "sh" });
    if cfg!(windows) {
        child.args(["/C", "exit", "0"]);
    } else {
        child.args(["-c", "exit 0"]);
    }
    let mut child = child.spawn().unwrap();
    let dead_pid = child.id();
    child.wait().unwrap();
    for provenance in [
        Some(i64::from(std::process::id())),
        None,
        Some(i64::from(dead_pid)),
    ] {
        let (_temp, pool, receipt, runtime) = setup().await;
        let d = delivery(&pool, &runtime, "second", "crashed").await;
        accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
        begin(&pool, &runtime, "crashed").await.unwrap();
        let mut tool = effect(&runtime, &d.work);
        tool.effect = EngineEffectIdentity::Tool {
            tool_invocation_id: "write-before-crash".into(),
            provider_attempt_id: None,
        };
        register_effect(&pool, tool.clone()).await.unwrap();
        // A synthetic process receipt replaces the fixture's live process. The
        // application has no public write port to this provenance table.
        sqlx::query("DELETE FROM engine_effect_processes WHERE system_id=?")
            .bind(&receipt.system_start_id)
            .execute(&pool)
            .await
            .unwrap();
        if let Some(pid) = provenance {
            sqlx::query("INSERT INTO engine_effect_processes VALUES (?, ?, ?)")
                .bind(&receipt.system_start_id)
                .bind(effect_key(&tool.effect).unwrap())
                .bind(pid)
                .execute(&pool)
                .await
                .unwrap();
        }
        revoke_host_owners(&pool, std::slice::from_ref(&runtime))
            .await
            .unwrap();
        // Process absence alone is insufficient without a user Stop intent.
        process_recovery::close_dead_process_effects(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        assert_eq!(
            read_effects(&pool, &d.work).await.unwrap()[0].status,
            "uncertain"
        );
        ensure_stop(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        process_recovery::close_dead_process_effects(
            &pool,
            &receipt.system_start_id,
            Some("different-activation"),
        )
        .await
        .unwrap();
        assert_eq!(
            read_effects(&pool, &d.work).await.unwrap()[0].status,
            "uncertain"
        );
        process_recovery::close_dead_process_effects(&pool, &receipt.system_start_id, None)
            .await
            .unwrap();
        let effects = read_effects(&pool, &d.work).await.unwrap();
        let projection = read_projection(&pool, &receipt.system_start_id)
            .await
            .unwrap();
        if provenance == Some(i64::from(dead_pid)) {
            assert_eq!(effects[0].status, "ended");
            assert!(effects[0]
                .result_json
                .as_ref()
                .unwrap()
                .contains("result unavailable"));
            let evidence: serde_json::Value =
                serde_json::from_str(&effects[0].settlement.as_ref().unwrap().evidence_json)
                    .unwrap();
            assert_eq!(evidence["outcomeUnknown"], true);
            assert_eq!(evidence["failed"], true);
            assert!(matches!(
                projection.system_stop,
                EngineStopState::Confirmed { .. }
            ));
            let cursor = projection.cursor;
            process_recovery::close_dead_process_effects(&pool, &receipt.system_start_id, None)
                .await
                .unwrap();
            assert_eq!(
                read_projection(&pool, &receipt.system_start_id)
                    .await
                    .unwrap()
                    .cursor,
                cursor
            );
            assert!(register_effect(&pool, tool).await.is_err());
        } else {
            assert_eq!(effects[0].status, "uncertain");
            assert!(effects[0].result_json.is_none());
            assert!(!matches!(
                projection.system_stop,
                EngineStopState::Confirmed { .. }
            ));
        }
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_effects WHERE system_id=?")
                .bind(&receipt.system_start_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }
}

#[tokio::test]
async fn native_operation_receipts_survive_reopen_and_never_authorize_replay() {
    use super::native_operations::{self, NativeOperation};
    for (adapter, version, method, refs, delayed_method) in [
        (
            "codex-app-server-v1",
            "0.163.0",
            "thread/start",
            r#"{"threadId":"synthetic-thread","turnId":null}"#,
            "turn/start",
        ),
        (
            "claude-sdk-v1",
            "0.3.308",
            "session/create",
            r#"{"sessionId":"synthetic-session","runId":null}"#,
            "query/start",
        ),
    ] {
        let (temp, pool, _receipt, runtime) = setup().await;
        let d = delivery(&pool, &runtime, "second", "native").await;
        accept_delivery(&pool, &runtime, d.clone()).await.unwrap();
        begin(&pool, &runtime, &d.delivery_id).await.unwrap();
        let mut effect = effect(&runtime, &d.work);
        effect.invocation_json = serde_json::json!({"kind":adapter}).to_string();
        register_effect(&pool, effect.clone()).await.unwrap();
        let op = NativeOperation {
            context: effect.context.clone(),
            effect: effect.effect.clone(),
            operation_id: "native:thread".into(),
            adapter: adapter.into(),
            version: version.into(),
            profile_digest: "private-profile-digest".into(),
            method: method.into(),
            request_json: "{}".into(),
        };
        native_operations::admit(&pool, &op).await.unwrap();
        assert!(native_operations::admit(&pool, &op).await.is_err());
        // The crash window before a receipt also survives reopening. Absence of a
        // reference is uncertainty, never permission to issue the request again.
        pool.close().await;
        let pool = create_pool(&temp.path().join("test.db")).await.unwrap();
        assert_eq!(
            native_operations::read_instance(
                &pool,
                &runtime.system_start_id,
                d.work.agent_instance_id.as_deref().unwrap()
            )
            .await
            .unwrap(),
            vec![(op.clone(), None)]
        );
        assert!(native_operations::admit(&pool, &op).await.is_err());
        native_operations::received(&pool, &op, refs).await.unwrap();
        let agent = d.work.agent_instance_id.as_deref().unwrap();
        pool.close().await;
        let reopened = create_pool(&temp.path().join("test.db")).await.unwrap();
        assert_eq!(
            native_operations::read_instance(&reopened, &runtime.system_start_id, agent)
                .await
                .unwrap(),
            vec![(op.clone(), Some(refs.into()))]
        );
        assert!(native_operations::admit(&reopened, &op).await.is_err());
        assert!(
            native_operations::received(&reopened, &op, r#"{"threadId":"foreign"}"#)
                .await
                .is_err()
        );
        let mut foreign = op.clone();
        foreign.profile_digest = "foreign-profile".into();
        assert!(native_operations::received(&reopened, &foreign, refs)
            .await
            .is_err());
        assert!(native_operations::read_instance(
            &reopened,
            &runtime.system_start_id,
            "other-agent"
        )
        .await
        .unwrap()
        .is_empty());
        // Losing Macro's process does not establish external native process death.
        sqlx::query("DROP TRIGGER engine_effect_process_immutable")
            .execute(&reopened)
            .await
            .unwrap();
        sqlx::query("UPDATE engine_effect_processes SET process_id=2147483647")
            .execute(&reopened)
            .await
            .unwrap();
        revoke_host_owners(&reopened, &[runtime.clone()])
            .await
            .unwrap();
        process_recovery::close_dead_process_effects(&reopened, &runtime.system_start_id, None)
            .await
            .unwrap();
        assert_ne!(
            read_effects(&reopened, &d.work).await.unwrap()[0].status,
            "ended"
        );
        let mut delayed = op.clone();
        delayed.operation_id = "native:turn".into();
        delayed.method = delayed_method.into();
        assert!(native_operations::admit(&reopened, &delayed).await.is_err());
    }
}

#[path = "native_codex_tests.rs"]
mod native_codex_tests;

#[path = "native_claude_tests.rs"]
mod native_claude_tests;
