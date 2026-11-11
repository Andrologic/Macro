//! Synthetic captures and preparation receipts, with real reducer/store claims,
//! native authority, owned parent attribution and mailbox consumption. These
//! tests exercise interleavings, without claiming provider/policy admission.
use super::*;
use crate::ai::stream_tasks::StreamTasks;
use crate::db::agsdl_execution::flow030::*;

struct Case {
    _directory: tempfile::TempDir,
    pool: SqlitePool,
    host: HostState,
    plan: FlowPlan030,
    state: FlowState030,
    serial: usize,
}
impl Case {
    async fn new(raw: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::db::create_pool(&directory.path().join("steer.db"))
            .await
            .unwrap();
        let mut plan: FlowPlan030 = serde_json::from_str(raw).unwrap();
        let template: FlowPlan030 = serde_json::from_str(include_str!(
            "../tests/fixtures/agsdl030_compiled_plan.json"
        ))
        .unwrap();
        plan.source = template.source;
        let identity = FlowIdentity030 {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            snapshot_id: "snapshot".into(),
            epoch: "capture".into(),
        };
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        };
        let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
        let capture = StartCapture030 {
            identity: identity.clone(),
            source: serde_json::from_value(plan.source.clone()).unwrap(),
            versions: serde_json::from_value(json!(plan.versions)).unwrap(),
            authored_source: plan.document_json.clone(),
            compiled_plan_json: json!(plan).to_string(),
            registry_json: "{}".into(),
            private_capture_json: "{}".into(),
        };
        let state = FlowState030::new(identity.clone());
        let enter = FlowEvent030 {
            identity: identity.clone(),
            event_id: "start:enter".into(),
            expected_revision: "0".into(),
            kind: FlowEventKind030::Enter {
                message_json: "{}".into(),
            },
        };
        let initial = reduce(&plan, &state, &enter).unwrap();
        let capture_json = serde_json::to_string(&capture).unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(
            "INSERT INTO engine_flow030_runs VALUES('system','flow','snapshot','capture',?,?,?)",
        )
        .bind(plan.source.to_string())
        .bind(json!(plan).to_string())
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO engine_start030_requests VALUES('request',?,'system','flow','snapshot','capture',?,?)")
            .bind(json!({"source":plan.source,"entry":{"deliveryId":"fixture-entry","messageJson":"{}"}}).to_string()).bind(&capture_json).bind(json!({"identity":identity,"enter":initial.receipt}).to_string()).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO engine_flow030_owners VALUES('system','flow','snapshot','capture','owner','generation','live',?)")
            .bind(format!("{:x}",Sha256::digest(capture_json.as_bytes()))).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        let mut case = Self {
            _directory: directory,
            pool,
            host,
            plan,
            state,
            serial: 0,
        };
        case.apply(enter.kind).await;
        case.finish("start").await;
        case.prepare().await;
        case
    }
    fn work(&self, step: &str) -> WorkRef030 {
        let activation = self
            .state
            .activations
            .iter()
            .find(|a| a.step.as_deref() == Some(&[step.to_owned()][..]) && a.phase == "running")
            .unwrap();
        WorkRef030 {
            activation_id: activation.id.clone(),
            start_effect_id: activation.start_effect_id.clone().unwrap(),
            agent_instance_id: activation.instance_id.clone(),
        }
    }
    fn attempt(&self, work: &WorkRef030) -> FlowWorkAttempt030 {
        let a = self
            .state
            .activations
            .iter()
            .find(|a| a.id == work.activation_id)
            .unwrap();
        FlowWorkAttempt030 {
            identity: self.state.identity.clone(),
            owner: EngineOwner {
                system_start_id: "system".into(),
                owner_epoch: "owner".into(),
            },
            generation: "generation".into(),
            work: repository::dto::EngineWork {
                system_start_id: "system".into(),
                flow_invocation_id: "flow".into(),
                activation_id: a.id.clone(),
                step: a.step.clone(),
                agent_instance_id: a.instance_id.clone(),
            },
            start_effect_id: work.start_effect_id.clone(),
            agent: a.agent.clone().unwrap(),
            provider_attempt_id: format!("fixture:{}", a.id),
        }
    }
    async fn apply(&mut self, kind: FlowEventKind030) {
        let event = FlowEvent030 {
            identity: self.state.identity.clone(),
            event_id: if self.serial == 0 {
                "start:enter".into()
            } else {
                format!("fixture:{}", self.serial)
            },
            expected_revision: self.state.revision.clone(),
            kind,
        };
        self.serial += 1;
        let lease = self.host.start_lease().await.unwrap();
        let authority = Authority {
            runtime: self.host.flow030(),
            lease: &lease,
            owner: lease.owner("system").unwrap(),
        };
        let mut db = self.pool.acquire().await.unwrap();
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await.unwrap();
        assert!(matches!(
            flow_store030::apply_tx(&mut tx, &authority, &event)
                .await
                .unwrap_or_else(|error| panic!("{}: {error:?}", event.event_id)),
            Apply030::Applied(_)
        ));
        self.state = flow_store030::read_tx(&mut tx, &authority, &event.identity)
            .await
            .unwrap()
            .state;
        tx.commit().await.unwrap();
    }
    async fn finish(&mut self, step: &str) {
        let work = self.work(step);
        self.apply(FlowEventKind030::WorkResult {
            work,
            result: WorkResult030::Completed {
                output_json: "{}".into(),
                route_key: None,
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: format!("physical:{step}"),
                descendants_joined: true,
            }),
        })
        .await;
    }
    async fn prepare(&mut self) {
        let p = self
            .state
            .preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap()
            .clone();
        let route = self
            .plan
            .routes
            .iter()
            .find(|r| {
                r.source == p.reference.route.source
                    && r.kind == p.reference.route.kind
                    && r.key == p.reference.route.key
            })
            .unwrap();
        let native = format!("prepared:{}", self.serial);
        let batches = route
            .targets
            .iter()
            .enumerate()
            .map(|(n, target)| PreparedBatch030 {
                target_ordinal: n,
                target: target.clone(),
                items: vec![PreparedItem030 {
                    message_json: Some("{}".into()),
                    item_json: None,
                    occurrence: DeliveryOccurrence030 {
                        native_receipt_id: native.clone(),
                        target_ordinal: n,
                        item_index: "0".into(),
                    },
                }],
            })
            .collect::<Vec<_>>();
        // Explicit preparation fixtures preserve the actual reducer occurrence,
        // sender and native receipt checks instead of erasing them for claims.
        let mut tx = self.pool.begin().await.unwrap();
        sqlx::query("INSERT INTO engine_flow030_preparations VALUES('system','flow',?,?,'owner','generation',?,?,?,'{}','{}')")
            .bind(&p.reference.prepare_id).bind(&native).bind(json!(p.reference).to_string()).bind(json!(p.producer).to_string()).bind("{}").execute(&mut *tx).await.unwrap();
        for batch in &batches {
            let occurrence = &batch.items[0].occurrence;
            let proof = OccurrenceProvenance030 {
                occurrence: occurrence.clone(),
                prompt: Value::Null,
                source: json!({}),
                producer: p.producer.clone(),
            };
            sqlx::query("INSERT INTO engine_flow030_occurrence_provenance VALUES('system','flow',?,?,'0',?)")
                .bind(&native).bind(batch.target_ordinal as i64).bind(serde_json::to_string(&proof).unwrap()).execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        self.apply(FlowEventKind030::Prepared {
            reference: p.reference,
            native_receipt_id: native,
            result: PreparedResult030::Ready { batches },
        })
        .await;
    }
    async fn settle_fixture_handoffs(&self) {
        let rows = sqlx::query(
            "SELECT effect_json FROM engine_flow030_outbox WHERE status='pending' ORDER BY rowid",
        )
        .fetch_all(&self.pool)
        .await
        .unwrap();
        for row in rows {
            let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json")).unwrap();
            if matches!(&effect.kind, FlowEffectKind030::Steer { .. }) {
                continue;
            }
            let mut receipt = json!({"kind":"nativeOwnedHandoff030","identity":effect.identity,"effectId":effect.id,"ownerEpoch":"owner","generation":"generation","requestId":format!("flow030:system:{}",effect.id)});
            if let FlowEffectKind030::PrepareRoute { reference, .. } = &effect.kind {
                let native = self
                    .state
                    .preparation_receipts
                    .iter()
                    .find_map(|(id, p)| (p == &reference.prepare_id).then_some(id))
                    .unwrap();
                receipt = json!({"kind":"nativeRoutePrepared030","prepareId":reference.prepare_id,"nativeReceiptId":native});
            } else {
                if let FlowEffectKind030::Start {
                    work,
                    agent: Some(_),
                    ..
                } = &effect.kind
                {
                    receipt["workAttempt"] = json!(self.attempt(work));
                }
                sqlx::query("INSERT INTO engine_flow030_handoffs VALUES('system','flow',?,'owner','generation',?)").bind(&effect.id).bind(receipt.to_string()).execute(&self.pool).await.unwrap();
            }
            sqlx::query("UPDATE engine_flow030_outbox SET status='settled',settlement_json=? WHERE effect_id=?").bind(receipt.to_string()).bind(&effect.id).execute(&self.pool).await.unwrap();
        }
    }
    async fn verify_replay(&self) {
        self.pool.close().await;
        let verdict = crate::db::agsdl_execution::replay_verify030::verify_path030(
            &self._directory.path().join("steer.db"),
            "system",
            "flow",
        )
        .await;
        assert!(verdict.ok, "{verdict:?}");
    }
    async fn steer(&self) -> FlowEffect030 {
        serde_json::from_str(&sqlx::query_scalar::<_,String>("SELECT effect_json FROM engine_flow030_outbox WHERE json_extract(effect_json,'$.kind.kind')='steer'").fetch_one(&self.pool).await.unwrap()).unwrap()
    }
}

#[tokio::test]
async fn native_steer_claim_consumes_before_absorption_makes_its_quorum_missed() {
    let mut c = Case::new(include_str!(
        "../tests/fixtures/agsdl030_pending_steer_quorum_plan.json"
    ))
    .await;
    assert_eq!(c.state.groups[0].decision, None);
    c.settle_fixture_handoffs().await;
    let effect = c.steer().await;
    assert!(flow_store030::eligible(&c.state, &effect));
    let work = c.work("a");
    let attempt = c.attempt(&work);
    let tasks = StreamTasks::default();
    let owned = tasks.clone();
    let target = attempt.clone();
    let (send, mut inbox) = crate::agsdl_host_steer030::channel030();
    let (release, hold) = tokio::sync::oneshot::channel();
    tasks
        .start_agent030(
            format!("flow030:system:{}", work.start_effect_id),
            &attempt,
            async move {
                let delivery = inbox.receive().await.unwrap();
                delivery.acknowledge(&owned, &target).unwrap();
                let _ = hold.await;
            },
        )
        .unwrap();
    let claim = claim_expected(
        c.host.flow030(),
        &c.host,
        &c.pool,
        &c.state.identity,
        &effect.id,
    )
    .await
    .unwrap()
    .expect("eligible steer must be claimable by native authority");
    claim.deliver_steer030(&attempt, &send).await.unwrap();
    let lease = c.host.start_lease().await.unwrap();
    let authority = Authority {
        runtime: c.host.flow030(),
        lease: &lease,
        owner: attempt.owner().clone(),
    };
    let mut tx = c.pool.begin().await.unwrap();
    let view = flow_store030::read_tx(&mut tx, &authority, &c.state.identity)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    c.state = view.state;
    assert_eq!(c.state.groups[0].decision.as_deref(), Some("missed"));
    assert_eq!(c.state.steer_deliveries[0].status, "consumed");
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM engine_flow030_outbox WHERE effect_id=?"
        )
        .bind(&effect.id)
        .fetch_one(&c.pool)
        .await
        .unwrap(),
        "settled"
    );
    assert_eq!(c.state.visits_at(&["b".into()]), "0");
    release.send(()).unwrap();
    tasks.join_agent030(&attempt, false).await.unwrap();
    c.verify_replay().await;
}

#[tokio::test]
async fn native_completion_before_claim_settles_the_offer_and_exposes_a_claimable_fallback_start() {
    let mut c = Case::new(include_str!(
        "../tests/fixtures/agsdl030_pending_steer_completion_plan.json"
    ))
    .await;
    c.finish("ping").await;
    c.prepare().await;
    c.settle_fixture_handoffs().await;
    let steer = c.steer().await;
    assert!(flow_store030::eligible(&c.state, &steer));
    c.finish("work").await;
    assert_eq!(c.state.verdict, None);
    assert!(!flow_store030::eligible(&c.state, &steer));
    let row =
        sqlx::query("SELECT status,settlement_json FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&steer.id)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(row.get::<&str, _>("status"), "settled");
    let receipt: Value = serde_json::from_str(row.get("settlement_json")).unwrap();
    assert_eq!(receipt["kind"], "nativeSteerSuperseded030");
    assert_eq!(receipt["resolution"], "fallback");
    let fallback = c.work("nudge");
    let claim = claim_expected(
        c.host.flow030(),
        &c.host,
        &c.pool,
        &c.state.identity,
        &fallback.start_effect_id,
    )
    .await
    .unwrap()
    .expect("fallback Start must be claimable by native authority");
    assert!(
        matches!(&claim.effect().kind,FlowEffectKind030::Start {step:Some(step),..} if step==&["nudge".to_owned()])
    );
    drop(claim);
    c.verify_replay().await;
}

#[tokio::test]
async fn an_uncertain_steer_cannot_be_replayed_as_a_fallback_but_stop_can_withdraw_it() {
    let mut c = Case::new(include_str!(
        "../tests/fixtures/agsdl030_pending_steer_completion_plan.json"
    ))
    .await;
    c.finish("ping").await;
    c.prepare().await;
    c.settle_fixture_handoffs().await;
    let steer = c.steer().await;
    let claim = claim_expected(
        c.host.flow030(),
        &c.host,
        &c.pool,
        &c.state.identity,
        &steer.id,
    )
    .await
    .unwrap()
    .unwrap();
    drop(claim);
    let event = FlowEvent030 {
        identity: c.state.identity.clone(),
        event_id: "completion-after-lost-ack".into(),
        expected_revision: c.state.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: c.work("work"),
            result: WorkResult030::Completed {
                output_json: "{}".into(),
                route_key: None,
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: "physical".into(),
                descendants_joined: true,
            }),
        },
    };
    let lease = c.host.start_lease().await.unwrap();
    let authority = Authority {
        runtime: c.host.flow030(),
        lease: &lease,
        owner: lease.owner("system").unwrap(),
    };
    let mut db = c.pool.acquire().await.unwrap();
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    assert!(matches!(
        flow_store030::apply_tx(&mut tx, &authority, &event).await,
        Err(StoreError030::Blocked)
    ));
    tx.rollback().await.unwrap();
    drop(db);
    c.apply(FlowEventKind030::Stop).await;
    assert_eq!(c.state.steer_deliveries[0].status, "withdrawn");
    assert_eq!(c.state.visits_at(&["nudge".into()]), "0");
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM engine_flow030_outbox WHERE effect_id=?"
        )
        .bind(&steer.id)
        .fetch_one(&c.pool)
        .await
        .unwrap(),
        "uncertain"
    );
    assert!(!flow_store030::eligible(&c.state, &steer));
    c.verify_replay().await;
}

#[tokio::test]
async fn explicit_no_send_releases_only_the_claim_and_terminal_performs_queue_fallback() {
    let mut c = Case::new(include_str!(
        "../tests/fixtures/agsdl030_pending_steer_completion_plan.json"
    ))
    .await;
    c.finish("ping").await;
    c.prepare().await;
    c.settle_fixture_handoffs().await;
    let effect = c.steer().await;
    let attempt = c.attempt(&c.work("work"));
    let tasks = StreamTasks::default();
    let owned = tasks.clone();
    let target = attempt.clone();
    let (sender, mut inbox) = crate::agsdl_host_steer030::channel030();
    tasks
        .start_agent030(
            format!("flow030:system:{}", attempt.start_effect_id()),
            &attempt,
            async move {
                inbox
                    .receive()
                    .await
                    .unwrap()
                    .not_sent(&owned, &target)
                    .unwrap();
            },
        )
        .unwrap();
    let claim = claim_expected(
        c.host.flow030(),
        &c.host,
        &c.pool,
        &c.state.identity,
        &effect.id,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!claim.deliver_steer030(&attempt, &sender).await.unwrap());
    tasks.join_agent030(&attempt, false).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM engine_flow030_outbox WHERE effect_id=?"
        )
        .bind(&effect.id)
        .fetch_one(&c.pool)
        .await
        .unwrap(),
        "pending"
    );
    c.finish("work").await;
    assert_eq!(c.state.verdict, None);
    assert_eq!(c.state.steer_deliveries[0].status, "fallback");
    assert!(c.work("nudge").agent_instance_id.is_some());
    c.verify_replay().await;
}
