use super::work_protocol030::*;
use super::*;
use tempfile::TempDir;

// This sub-lot cannot change the parent's capture-version gate. Seed the exact
// admitted native records so tests exercise the DB API, not a pretend compiler.
async fn setup() -> (TempDir, SqlitePool, EngineContext) {
    setup_contract("agsdl-0.3.0").await
}
async fn setup_contract(contract: &str) -> (TempDir, SqlitePool, EngineContext) {
    let temp = TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("protocol.db"))
        .await
        .unwrap();
    let context = EngineContext {
        owner: EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "1".into(),
        },
        work: EngineWork {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            activation_id: "work".into(),
            step: Some(vec!["step".into()]),
            agent_instance_id: Some("agent".into()),
        },
        permissions_json: "[]".into(),
        scope_json: "{}".into(),
        registry_version: "registry".into(),
    };
    let snapshot = EngineSnapshot {
        system_start_id: "system".into(),
        source: EngineSourceRevision {
            owner: EngineSourceOwner {
                project_id: "project".into(),
                plan_id: "plan".into(),
                branch: "develop".into(),
            },
            revision: "1".into(),
            source_sha256: "synthetic".into(),
        },
        authored_source: "{\"agsdl\":\"0.3.0\"}".into(),
        versions: EngineVersions {
            snapshot: "1".into(),
            contract: contract.into(),
            compiler: "compiler".into(),
            runtime: "runtime".into(),
            registry: "registry".into(),
            profile: "synthetic030".into(),
        },
        agents: vec![EngineAgentConfiguration {
            agent_name: "agent".into(),
            configuration_name: "synthetic".into(),
            provider_id: "fake".into(),
            model_id: "fake".into(),
            configuration_json: "{}".into(),
            settings_json: "{}".into(),
            permissions_json: "[]".into(),
            scope_json: "{}".into(),
        }],
        compiled_plan_json: "{}".into(),
        associations: EngineAssociations::default(),
    };
    let activation = EngineActivation {
        delivery: EngineAcceptedDelivery {
            delivery: EngineDelivery {
                delivery_id: "delivery".into(),
                work: context.work.clone(),
                input: EngineValue {
                    origin: "entry".into(),
                    value_json: "null".into(),
                },
            },
            queue_sequence: "1".into(),
        },
        work_state: "active".into(),
        stop_state: EngineStopState::None,
        admitted_epoch: Some("1".into()),
        terminal: None,
    };
    let state = State {
        epoch: "1".into(),
        invocation_id: "flow".into(),
        cursor: "0".into(),
        stop: EngineStopState::None,
        agents: BTreeMap::from([(
            "agent".into(),
            AgentState {
                id: "agent".into(),
                memory: None,
                next_queue: "2".into(),
            },
        )]),
        activations: BTreeMap::from([("work".into(), activation)]),
        visits: BTreeMap::new(),
        terminals: BTreeMap::new(),
        closed_responses: BTreeMap::new(),
        rejected: BTreeMap::new(),
    };
    sqlx::query("INSERT INTO engine_systems VALUES ('system','start','{}',?,'[]',?)")
        .bind(encode(&snapshot).unwrap())
        .bind(encode(&state).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    if contract == "agsdl-0.3.0" {
        initialize(
            &pool,
            &context,
            "{ \"maxCorrections\":900719925474099300000 }",
            "{ \"opaque\": 1e999 }",
        )
        .await
        .unwrap();
    }
    (temp, pool, context)
}
fn input(context: &EngineContext, id: &str, revision: &str) -> ProtocolEvent030 {
    ProtocolEvent030 {
        context: context.clone(),
        event_id: id.into(),
        expected_revision: revision.into(),
        event_json: "{ \"results\":9007199254740993 }".into(),
        native_call: None,
        control: false,
    }
}
async fn ticket(pool: &SqlitePool, input: &ProtocolEvent030) -> TransitionTicket030 {
    match reserve_event(pool, input).await.unwrap() {
        EventReservation030::Pending { ticket } => ticket,
        _ => panic!("already committed"),
    }
}
fn decision(check: bool) -> ProtocolDecision030 {
    ProtocolDecision030 {
        state_json: "{ \"opaque\":9007199254740994 }".into(),
        receipt_json: "{\"accepted\": true,\"n\":1.0}".into(),
        check: check.then(|| CheckRequest030 {
            check_id: "check".into(),
            invocation_json: "{\"command\":\"synthetic\"}".into(),
        }),
    }
}
async fn stop_work(pool: &SqlitePool, context: &EngineContext) {
    stop(
        pool,
        EngineStopRequest {
            system_start_id: context.work.system_start_id.clone(),
            request_id: "stop".into(),
            activation_id: Some(context.work.activation_id.clone()),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn exact_events_decisions_and_initialization_survive_lost_receipts() {
    let (temp, pool, context) = setup().await;
    let input = input(&context, "submit", "0");
    let ticket = ticket(&pool, &input).await;
    assert_eq!(
        ticket,
        match reserve_event(&pool, &input).await.unwrap() {
            EventReservation030::Pending { ticket } => ticket,
            _ => panic!(),
        }
    );
    let decision = decision(false);
    let committed = commit_event(&pool, &ticket, &decision).await.unwrap();
    assert_eq!(committed.revision, "1");
    assert_eq!(
        committed,
        commit_event(&pool, &ticket, &decision).await.unwrap()
    );
    let mut wrong = decision.clone();
    wrong.receipt_json = wrong.receipt_json.replace("1.0", "1");
    assert!(commit_event(&pool, &ticket, &wrong).await.is_err());
    let mut wrong = input.clone();
    wrong.event_json.push(' ');
    assert!(reserve_event(&pool, &wrong).await.is_err());
    assert!(initialize(
        &pool,
        &context,
        &committed.contract_json,
        "{\"opaque\":1e999}"
    )
    .await
    .is_err());
    let current = initialize(
        &pool,
        &context,
        &committed.contract_json,
        "{ \"opaque\": 1e999 }",
    )
    .await
    .unwrap();
    assert_eq!(current, committed);
    pool.close().await;
    let reopened = crate::db::create_pool(&temp.path().join("protocol.db"))
        .await
        .unwrap();
    assert_eq!(read(&reopened, &context.work).await.unwrap(), committed);
    assert_eq!(
        reserve_event(&reopened, &input).await.unwrap(),
        EventReservation030::Committed { decision }
    );
}

#[tokio::test]
async fn cas_concurrency_commits_only_one_transition_and_one_check() {
    let (_temp, pool, context) = setup().await;
    let a = ticket(&pool, &input(&context, "a", "0")).await;
    let b = ticket(&pool, &input(&context, "b", "0")).await;
    let decision = decision(true);
    let (a, b) = tokio::join!(
        commit_event(&pool, &a, &decision),
        commit_event(&pool, &b, &decision)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(read(&pool, &context.work).await.unwrap().revision, "1");
    assert_eq!(read_checks(&pool, &context.work).await.unwrap().len(), 1);
    assert_eq!(read_effects(&pool, &context.work).await.unwrap().len(), 1);
    let (a, b) = tokio::join!(
        claim_check(&pool, &context, "check"),
        claim_check(&pool, &context, "check")
    );
    assert_ne!(a.is_ok(), b.is_ok());
}

#[tokio::test]
async fn stop_fences_pending_results_and_check_dispatch_but_accepts_control_and_end_evidence() {
    let (_temp, pool, context) = setup().await;
    let first = ticket(&pool, &input(&context, "a", "0")).await;
    commit_event(&pool, &first, &decision(true)).await.unwrap();
    claim_check(&pool, &context, "check").await.unwrap();
    let late = ticket(&pool, &input(&context, "late", "1")).await;
    let mut control = input(&context, "control-before-stop", "1");
    control.control = true;
    let control_before = ticket(&pool, &control).await;
    stop_work(&pool, &context).await;
    assert!(commit_event(&pool, &late, &decision(false)).await.is_err());
    assert!(commit_event(&pool, &control_before, &decision(false))
        .await
        .is_err());
    assert!(claim_check(&pool, &context, "check").await.is_err());
    assert!(reserve_event(&pool, &input(&context, "new", "1"))
        .await
        .is_err());
    control.event_id = "stop-observed".into();
    let stopping = ticket(&pool, &control).await;
    assert!(commit_event(&pool, &stopping, &decision(true))
        .await
        .is_err());
    commit_event(&pool, &stopping, &decision(false))
        .await
        .unwrap();
    finish_check(
        &pool,
        &context,
        "check",
        "{\"joined\":true}",
        "{\"status\":0}",
    )
    .await
    .unwrap();
    assert_eq!(
        read_effects(&pool, &context.work).await.unwrap()[0].status,
        "ended"
    );
}

#[tokio::test]
async fn unclaimed_checks_cannot_dispatch_after_stop() {
    let (_temp, pool, context) = setup().await;
    let t = ticket(&pool, &input(&context, "a", "0")).await;
    commit_event(&pool, &t, &decision(true)).await.unwrap();
    assert!(finish_check(&pool, &context, "check", "{}", "{}")
        .await
        .is_err());
    stop_work(&pool, &context).await;
    assert!(claim_check(&pool, &context, "check").await.is_err());
    assert_eq!(
        read_checks(&pool, &context.work).await.unwrap()[0].status,
        "pending"
    );
}

#[tokio::test]
async fn revoke_and_restart_preserve_state_and_never_replay_checks() {
    let (temp, pool, context) = setup().await;
    let t = ticket(&pool, &input(&context, "a", "0")).await;
    let state = commit_event(&pool, &t, &decision(true)).await.unwrap();
    claim_check(&pool, &context, "check").await.unwrap();
    pool.close().await;
    let pool = crate::db::create_pool(&temp.path().join("protocol.db"))
        .await
        .unwrap();
    // Even before startup reconciliation, the durable claim forbids replay.
    assert!(claim_check(&pool, &context, "check").await.is_err());
    crate::db::reconcile_runtime_after_restart(&pool)
        .await
        .unwrap();
    assert!(commit_event(&pool, &t, &decision(true)).await.is_err());
    assert!(finish_check(&pool, &context, "check", "{}", "{}")
        .await
        .is_err());
    let mut forged_new_owner = context.clone();
    forged_new_owner.owner.owner_epoch = "2".into();
    assert!(reserve_event(&pool, &input(&forged_new_owner, "b", "1"))
        .await
        .is_err());
    assert_eq!(read(&pool, &context.work).await.unwrap(), state);
    let checks = read_checks(&pool, &context.work).await.unwrap();
    assert_eq!(checks[0].status, "uncertain");
    assert!(checks[0].claimed);
}

#[tokio::test]
async fn check_receipt_is_exact_and_reopen_does_not_duplicate_the_effect() {
    let (temp, pool, context) = setup().await;
    let t = ticket(&pool, &input(&context, "a", "0")).await;
    commit_event(&pool, &t, &decision(true)).await.unwrap();
    claim_check(&pool, &context, "check").await.unwrap();
    finish_check(
        &pool,
        &context,
        "check",
        "{ \"joined\":true }",
        "{\"status\":0}",
    )
    .await
    .unwrap();
    pool.close().await;
    let pool = crate::db::create_pool(&temp.path().join("protocol.db"))
        .await
        .unwrap();
    finish_check(
        &pool,
        &context,
        "check",
        "{ \"joined\":true }",
        "{\"status\":0}",
    )
    .await
    .unwrap();
    assert!(finish_check(
        &pool,
        &context,
        "check",
        "{\"joined\":true}",
        "{\"status\":0}"
    )
    .await
    .is_err());
    assert!(finish_check(
        &pool,
        &context,
        "check",
        "{ \"joined\":true }",
        "{\"status\":0.0}"
    )
    .await
    .is_err());
    assert!(claim_check(&pool, &context, "check").await.is_err());
    assert_eq!(
        read_checks(&pool, &context.work).await.unwrap()[0]
            .result_json
            .as_deref(),
        Some("{\"status\":0}")
    );
    assert_eq!(read_effects(&pool, &context.work).await.unwrap().len(), 1);
}

#[tokio::test]
async fn attribution_ticket_and_native_call_cannot_be_forged_or_reused() {
    let (_temp, pool, context) = setup().await;
    let mut event = input(&context, "a", "0");
    event.native_call = Some(NativeCall030 {
        provider_attempt_id: "provider".into(),
        native_call_id: "call".into(),
    });
    assert!(reserve_event(&pool, &event).await.is_err());
    register_effect(
        &pool,
        EngineEffect {
            context: context.clone(),
            effect: EngineEffectIdentity::Provider {
                provider_attempt_id: "provider".into(),
            },
            invocation_json: "{}".into(),
        },
    )
    .await
    .unwrap();
    let t = ticket(&pool, &event).await;
    event.event_id = "b".into();
    assert!(reserve_event(&pool, &event).await.is_err());
    let mut forged = t.clone();
    forged.input_digest.push('0');
    assert!(commit_event(&pool, &forged, &decision(false))
        .await
        .is_err());
    let mut forged = t.clone();
    forged.state_json = "{}".into();
    assert!(commit_event(&pool, &forged, &decision(false))
        .await
        .is_err());
    let mut foreign = context.clone();
    foreign.permissions_json = "[\"all\"]".into();
    assert!(reserve_event(&pool, &input(&foreign, "foreign", "0"))
        .await
        .is_err());
    let mut foreign = context.clone();
    foreign.permissions_json = "[ ]".into();
    assert!(reserve_event(&pool, &input(&foreign, "foreign", "0"))
        .await
        .is_err());
    commit_event(&pool, &t, &decision(false)).await.unwrap();
    revoke_host_owners(&pool, &[context.owner.clone()])
        .await
        .unwrap();
    assert!(reserve_event(&pool, &t.input).await.is_err());
}

#[tokio::test]
async fn check_collision_rolls_back_state_receipt_and_effect_registration() {
    let (_temp, pool, context) = setup().await;
    let a = ticket(&pool, &input(&context, "a", "0")).await;
    let state = commit_event(&pool, &a, &decision(true)).await.unwrap();
    let b = ticket(&pool, &input(&context, "b", "1")).await;
    assert!(commit_event(&pool, &b, &decision(true)).await.is_err());
    assert_eq!(read(&pool, &context.work).await.unwrap(), state);
    assert!(matches!(
        reserve_event(&pool, &b.input).await.unwrap(),
        EventReservation030::Pending { .. }
    ));
    assert_eq!(read_effects(&pool, &context.work).await.unwrap().len(), 1);
    commit_event(&pool, &b, &decision(false)).await.unwrap();
}

fn human(context: &EngineContext, id: &str) -> HumanRequest030 {
    HumanRequest030 {
        request_id: id.into(),
        contexts: vec![context.clone()],
        kind: "plan".into(),
        payload_json: "{ \"plan\":\"review\" }".into(),
        deadline_ms: Some("9007199254740993000000000".into()),
    }
}
#[tokio::test]
async fn human_requests_are_linked_durable_and_resolve_once() {
    let (temp, pool, context) = setup().await;
    let request = human(&context, "request");
    let opened = open_human(&pool, &request).await.unwrap();
    assert_eq!(opened, open_human(&pool, &request).await.unwrap());
    let mut conflict = request.clone();
    conflict.payload_json.push(' ');
    assert!(open_human(&pool, &conflict).await.is_err());
    let (yes, no) = tokio::join!(
        resolve_human(&pool, &request, "0", "true"),
        resolve_human(&pool, &request, "0", "false")
    );
    assert_ne!(yes.is_ok(), no.is_ok());
    let resolved = yes.or(no).unwrap();
    let answer = resolved.answer_json.as_deref().unwrap();
    assert_eq!(
        resolve_human(&pool, &request, "0", answer).await.unwrap(),
        resolved
    );
    assert!(resolve_human(&pool, &request, "1", answer).await.is_err());
    assert!(resolve_human(&pool, &request, "0", &format!("{answer} "))
        .await
        .is_err());
    open_human(&pool, &human(&context, "still-open"))
        .await
        .unwrap();
    pool.close().await;
    let pool = crate::db::create_pool(&temp.path().join("protocol.db"))
        .await
        .unwrap();
    assert_eq!(
        read_humans(&pool, &context.work).await.unwrap(),
        vec![
            resolved,
            HumanRecord030 {
                request: human(&context, "still-open"),
                revision: "0".into(),
                answer_json: None
            }
        ]
    );
    stop_work(&pool, &context).await;
    assert!(
        resolve_human(&pool, &human(&context, "still-open"), "0", "true")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn human_associations_reject_empty_duplicate_foreign_or_retired_works() {
    let (_temp, pool, context) = setup().await;
    let mut request = human(&context, "request");
    request.contexts.clear();
    assert!(open_human(&pool, &request).await.is_err());
    request.contexts = vec![context.clone(), context.clone()];
    assert!(open_human(&pool, &request).await.is_err());
    request.contexts[1].work.system_start_id = "foreign".into();
    assert!(open_human(&pool, &request).await.is_err());
    request = human(&context, "request");
    request.deadline_ms = Some("01".into());
    assert!(open_human(&pool, &request).await.is_err());
    request = human(&context, "request");
    open_human(&pool, &request).await.unwrap();
    revoke_host_owners(&pool, &[context.owner.clone()])
        .await
        .unwrap();
    assert!(resolve_human(&pool, &request, "0", "false").await.is_err());
    assert_eq!(
        read_humans(&pool, &context.work).await.unwrap()[0].answer_json,
        None
    );
}

#[tokio::test]
async fn exact_revision_beyond_u64_and_invalid_json() {
    let (_temp, pool, context) = setup().await;
    let revision = "9999999999999999999999999999999999";
    sqlx::query("UPDATE engine_work_protocol030 SET revision=?")
        .bind(revision)
        .execute(&pool)
        .await
        .unwrap();
    let mut event = input(&context, "a", revision);
    event.event_json = "{\"a\":1,\"a\":2}".into();
    assert!(reserve_event(&pool, &event).await.is_err());
    let t = ticket(&pool, &input(&context, "a", revision)).await;
    let mut invalid = decision(false);
    invalid.state_json = "[".into();
    assert!(commit_event(&pool, &t, &invalid).await.is_err());
    let state = commit_event(&pool, &t, &decision(false)).await.unwrap();
    assert_eq!(state.revision, "10000000000000000000000000000000000");
}

#[tokio::test]
async fn database_failure_rolls_back_check_reservation_and_controller_state_together() {
    let (_temp, pool, context) = setup().await;
    let t = ticket(&pool, &input(&context, "a", "0")).await;
    sqlx::raw_sql("CREATE TRIGGER fail_protocol_state BEFORE UPDATE ON engine_work_protocol030 BEGIN SELECT RAISE(ABORT,'synthetic'); END;").execute(&pool).await.unwrap();
    assert!(commit_event(&pool, &t, &decision(true)).await.is_err());
    assert!(read_checks(&pool, &context.work).await.unwrap().is_empty());
    assert!(read_effects(&pool, &context.work).await.unwrap().is_empty());
    assert_eq!(read(&pool, &context.work).await.unwrap().revision, "0");
    assert!(matches!(
        reserve_event(&pool, &t.input).await.unwrap(),
        EventReservation030::Pending { .. }
    ));
    sqlx::query("DROP TRIGGER fail_protocol_state")
        .execute(&pool)
        .await
        .unwrap();
    commit_event(&pool, &t, &decision(true)).await.unwrap();
}

#[tokio::test]
async fn shared_human_request_links_each_work_and_resolves_all_together() {
    let (_temp, pool, context) = setup().await;
    let mut second = context.clone();
    second.work.activation_id = "second".into();
    let mut db = pool.acquire().await.unwrap();
    let mut stored = load(&mut db, "system").await.unwrap();
    let mut a = stored.state.activations["work"].clone();
    a.delivery.delivery.work = second.work.clone();
    a.delivery.delivery.delivery_id = "second-delivery".into();
    stored.state.activations.insert("second".into(), a);
    save(&mut db, "system", &stored.state).await.unwrap();
    drop(db);
    initialize(&pool, &second, "{}", "{}").await.unwrap();
    let mut request = human(&context, "shared");
    request.contexts.push(second.clone());
    let opened = open_human(&pool, &request).await.unwrap();
    assert_eq!(
        read_humans(&pool, &context.work).await.unwrap(),
        vec![opened.clone()]
    );
    assert_eq!(
        read_humans(&pool, &second.work).await.unwrap(),
        vec![opened]
    );
    let resolved = resolve_human(&pool, &request, "0", "false").await.unwrap();
    assert_eq!(
        read_humans(&pool, &second.work).await.unwrap(),
        vec![resolved]
    );
}

#[tokio::test]
async fn historical_capture_cannot_be_reinterpreted_as_protocol030() {
    let (_temp, pool, context) = setup_contract("agsdl-0.2.0").await;
    let historical = read_snapshot(&pool, "system").await.unwrap();
    assert!(reserve_event(&pool, &input(&context, "a", "0"))
        .await
        .is_err());
    assert!(initialize(&pool, &context, "{}", "{}").await.is_err());
    assert_eq!(read_snapshot(&pool, "system").await.unwrap(), historical);
}

#[tokio::test]
async fn private_event_history_retains_pending_and_committed_bytes_after_recovery() {
    let (temp, pool, context) = setup().await;
    let first = ticket(&pool, &input(&context, "first", "0")).await;
    let state = commit_event(&pool, &first, &decision(false)).await.unwrap();
    let pending = ticket(&pool, &input(&context, "pending", "1")).await;
    pool.close().await;
    let pool = crate::db::create_pool(&temp.path().join("protocol.db"))
        .await
        .unwrap();
    crate::db::reconcile_runtime_after_restart(&pool)
        .await
        .unwrap();
    assert_eq!(
        read_protocol_events(&pool, &context.work).await.unwrap(),
        vec![
            ProtocolEventRecord030 {
                ticket: first,
                decision: Some(decision(false)),
                committed_state: Some(state)
            },
            ProtocolEventRecord030 {
                ticket: pending,
                decision: None,
                committed_state: None
            },
        ]
    );
}

#[tokio::test]
async fn stop_or_revocation_racing_commit_always_fences_check_dispatch() {
    for revoke in [false, true] {
        let (_temp, pool, context) = setup().await;
        let t = ticket(&pool, &input(&context, "a", "0")).await;
        let proposed = decision(true);
        let (committed, ()) = tokio::join!(commit_event(&pool, &t, &proposed), async {
            if revoke {
                revoke_host_owners(&pool, &[context.owner.clone()])
                    .await
                    .unwrap();
            } else {
                stop_work(&pool, &context).await;
            }
        });
        assert!(claim_check(&pool, &context, "check").await.is_err());
        assert_eq!(
            read(&pool, &context.work).await.unwrap().revision,
            if committed.is_ok() { "1" } else { "0" }
        );
        assert_eq!(
            read_checks(&pool, &context.work).await.unwrap().len(),
            usize::from(committed.is_ok())
        );
    }
}

#[tokio::test]
async fn pending_check_uses_existing_terminal_effect_barrier() {
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
    let (_temp, pool, context) = setup().await;
    let t = ticket(&pool, &input(&context, "a", "0")).await;
    commit_event(&pool, &t, &decision(true)).await.unwrap();
    seal_responses(&pool, &context.owner, &context.work, "0")
        .await
        .unwrap();
    let terminal = EngineTerminalCommit {
        owner: context.owner.clone(),
        work: context.work.clone(),
        outcome: EngineOutcome::Completed {
            output: EngineValue {
                origin: "agent".into(),
                value_json: "{}".into(),
            },
        },
        termination_evidence_json: "{}".into(),
        response_cursor: "0".into(),
        memory: Some(EngineMemory {
            agent_instance_id: "agent".into(),
            revision: "1".into(),
            format_version: "synthetic".into(),
            state_json: "{}".into(),
        }),
        outgoing: vec![],
    };
    let error = commit_terminal(&pool, terminal.clone(), &NoRoutes)
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "Unresolved effects retain the activation lock"
    );
    claim_check(&pool, &context, "check").await.unwrap();
    finish_check(
        &pool,
        &context,
        "check",
        "{\"joined\":true}",
        "{\"status\":0}",
    )
    .await
    .unwrap();
    assert!(commit_terminal(&pool, terminal, &NoRoutes).await.unwrap());
    assert!(claim_check(&pool, &context, "check").await.is_err());
}
