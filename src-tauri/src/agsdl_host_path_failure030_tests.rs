//! Synthetic reducer/SQL evidence, not provider or process qualification.
use super::*;
use crate::db::agsdl_execution::flow030::*;

struct Journal {
    plan: FlowPlan030,
    state: FlowState030,
    history: Vec<(FlowEvent030, FlowTransition030)>,
    preparations: Vec<(PrepareRef030, Producer030, String, Value)>,
}
fn addr(s: &str) -> Vec<String> {
    vec![s.into()]
}
impl Journal {
    fn new(depth: usize, origin: &str) -> Self {
        let mut plan: FlowPlan030 = serde_json::from_str(include_str!(
            "../tests/fixtures/agsdl030_compiled_plan.json"
        ))
        .unwrap();
        let template = plan
            .steps
            .iter()
            .find(|s| s.r#type == "agent")
            .unwrap()
            .clone();
        plan.steps.clear();
        plan.routes.clear();
        plan.joins.clear();
        plan.scopes.clear();
        plan.entry = Some(addr("o0"));
        let mut names = vec!["leaf".to_string(), "bad".into(), "handler".into()];
        for n in 0..depth {
            names.extend([format!("o{n}"), format!("b{n}"), format!("j{n}")]);
        }
        for name in names {
            let mut step = template.clone();
            step.address = addr(&name);
            step.scope.clear();
            step.max_visits_json = None;
            step.instance = Some(Instance030::New);
            step.delivery = None;
            if name.starts_with('j') {
                step.r#type = "join".into();
                step.agent = None;
                step.instance = None;
            }
            plan.steps.push(step);
        }
        for n in 0..depth {
            let first = if n + 1 == depth {
                "leaf".into()
            } else {
                format!("o{}", n + 1)
            };
            let mut members = vec![addr(&first), addr(&format!("j{n}"))];
            if n + 1 < depth {
                for m in n + 1..depth {
                    members.extend([
                        addr(&format!("o{m}")),
                        addr(&format!("b{m}")),
                        addr(&format!("j{m}")),
                    ]);
                }
            }
            members.extend([addr("leaf"), addr("bad")]);
            members.sort();
            members.dedup();
            plan.joins.push(serde_json::from_value(json!({"address":[format!("j{n}")],"scope":[],"origin":[format!("o{n}")],"mode":"all","failures":"fail","remaining":"finish","maxFailuresJson":null,"quorumCountJson":null,"accept":[],"branches":[{"name":first,"target":[first],"members":members,"fanout":false},{"name":format!("b{n}"),"target":[format!("b{n}")],"members":[[format!("b{n}")]],"fanout":false}]})).unwrap());
            Self::route(
                &mut plan,
                &format!("o{n}"),
                "normal",
                &[&first, &format!("b{n}")],
            );
            Self::route(&mut plan, &format!("b{n}"), "normal", &[&format!("j{n}")]);
            if n > 0 {
                Self::route(
                    &mut plan,
                    &format!("j{n}"),
                    "normal",
                    &[&format!("j{}", n - 1)],
                );
            }
        }
        Self::route(&mut plan, "j0", "error", &["handler"]);
        Self::route(
            &mut plan,
            "leaf",
            "normal",
            &[if origin == "visit" { "leaf" } else { "bad" }],
        );
        Self::route(&mut plan, "bad", "normal", &[&format!("j{}", depth - 1)]);
        if origin == "visit" {
            plan.steps
                .iter_mut()
                .find(|s| s.address == addr("leaf"))
                .unwrap()
                .max_visits_json = Some("1".into());
        }
        if origin == "queue" {
            let leaf = plan
                .steps
                .iter_mut()
                .find(|s| s.address == addr("leaf"))
                .unwrap();
            leaf.instance = Some(Instance030::Shared);
            leaf.max_visits_json = Some("1".into());
            leaf.delivery = Some("queue".into());
            let route = plan
                .routes
                .iter_mut()
                .find(|r| r.source == addr("o0"))
                .unwrap();
            if let Target030::Step { each_path_json, .. } = &mut route.targets[0] {
                *each_path_json = Some("[\"results\",\"items\"]".into());
            }
            let join = &mut plan.joins[0];
            join.branches[0].fanout = true;
            join.failures = "keep".into();
            join.max_failures_json = Some("1".into());
            plan.routes
                .iter_mut()
                .find(|r| r.source == addr("leaf"))
                .unwrap()
                .targets = vec![Target030::Step {
                address: addr("j0"),
                message_json: None,
                each_path_json: None,
                concurrency_json: None,
                max_json: None,
            }];
        }
        Self {
            plan,
            state: FlowState030::new(FlowIdentity030 {
                system_start_id: "system".into(),
                flow_invocation_id: "flow".into(),
                snapshot_id: "snapshot".into(),
                epoch: "epoch".into(),
            }),
            history: vec![],
            preparations: vec![],
        }
    }
    fn route(plan: &mut FlowPlan030, name: &str, kind: &str, targets: &[&str]) {
        plan.routes.push(Route030 {
            source: addr(name),
            kind: kind.into(),
            key: None,
            declaration_json: "[]".into(),
            inherited: false,
            targets: targets
                .iter()
                .map(|t| Target030::Step {
                    address: addr(t),
                    message_json: None,
                    each_path_json: None,
                    concurrency_json: None,
                    max_json: None,
                })
                .collect(),
        });
    }
    fn send(&mut self, kind: FlowEventKind030) {
        let event = FlowEvent030 {
            identity: self.state.identity.clone(),
            event_id: match &kind {
                FlowEventKind030::WorkResult {
                    physical: Some(p), ..
                } => work_terminal_event_id030(&self.state.identity, &p.native_receipt_id).unwrap(),
                _ => format!("e{}", self.history.len()),
            },
            expected_revision: self.state.revision.clone(),
            kind,
        };
        let t = reduce(&self.plan, &self.state, &event).unwrap();
        self.state = t.state.clone();
        self.history.push((event, t));
    }
    fn complete(&mut self, name: &str) {
        let a = self
            .state
            .activations
            .iter()
            .find(|a| a.step == Some(addr(name)) && a.phase == "running")
            .unwrap();
        let work = WorkRef030 {
            activation_id: a.id.clone(),
            start_effect_id: a.start_effect_id.clone().unwrap(),
            agent_instance_id: a.instance_id.clone(),
        };
        self.send(FlowEventKind030::WorkResult {
            work,
            result: WorkResult030::Completed {
                output_json: r#"{"text":"","results":{}}"#.into(),
                route_key: None,
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: format!("native-{}", self.history.len()),
                descendants_joined: true,
            }),
        });
    }
    fn prepare(&mut self, failed: bool) {
        let p = self
            .state
            .preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap()
            .clone();
        let native = format!("prep-{}", self.history.len());
        let (result, wire) = if failed {
            let error = Failure030::new("OPERAND");
            (
                PreparedResult030::Failed {
                    target_ordinal: 0,
                    error: error.clone(),
                },
                json!({"kind":"failed","targetOrdinal":0,"error":error}),
            )
        } else {
            let route = self
                .plan
                .routes
                .iter()
                .find(|r| r.source == p.reference.route.source && r.kind == p.reference.route.kind)
                .unwrap();
            let batches = route
                .targets
                .iter()
                .enumerate()
                .map(|(n, t)| PreparedBatch030 {
                    target_ordinal: n,
                    target: t.clone(),
                    items: (0..if matches!(
                        t,
                        Target030::Step {
                            each_path_json: Some(_),
                            ..
                        }
                    ) {
                        3
                    } else {
                        1
                    })
                        .map(|index| PreparedItem030 {
                            message_json: Some("{}".into()),
                            item_json: matches!(
                                t,
                                Target030::Step {
                                    each_path_json: Some(_),
                                    ..
                                }
                            )
                            .then(|| index.to_string()),
                            occurrence: DeliveryOccurrence030 {
                                native_receipt_id: native.clone(),
                                target_ordinal: n,
                                item_index: index.to_string(),
                            },
                        })
                        .collect(),
                })
                .collect::<Vec<_>>();
            (
                PreparedResult030::Ready {
                    batches: batches.clone(),
                },
                json!({"kind":"ready","batches":batches,"provenance":[]}),
            )
        };
        self.preparations
            .push((p.reference.clone(), p.producer, native.clone(), wire));
        self.send(FlowEventKind030::Prepared {
            reference: p.reference,
            native_receipt_id: native,
            result,
        });
    }
    fn fail(depth: usize, origin: &str) -> Self {
        let mut j = Self::new(depth, origin);
        j.send(FlowEventKind030::Enter {
            message_json: "{}".into(),
        });
        for n in 0..depth {
            j.complete(&format!("o{n}"));
            j.prepare(false);
        }
        j.complete("leaf");
        if origin != "queue" {
            j.prepare(origin == "prepared");
        }
        j
    }
}

async fn persist(
    j: &Journal,
    fault: &str,
) -> (
    tempfile::TempDir,
    sqlx::SqlitePool,
    StartCapture030,
    PrepareRef030,
    Producer030,
) {
    let temp = tempfile::tempdir().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("proof.db"))
        .await
        .unwrap();
    let mut state = j.state.clone();
    let mut plan = j.plan.clone();
    let cause = state
        .activations
        .iter()
        .find(|a| {
            a.step
                == Some(addr(
                    if state.visits_at(&addr("leaf")) == "1"
                        && j.preparations.last().unwrap().3["kind"] == "ready"
                    {
                        "leaf"
                    } else {
                        "bad"
                    },
                ))
                && a.phase == "done"
                && a.start_effect_id.is_none()
        })
        .unwrap()
        .id
        .clone();
    if fault == "local" {
        Journal::route(&mut plan, "bad", "error", &["handler"]);
        state.plan_json = Some(serde_json::to_string(&plan).unwrap());
    }
    if fault == "path" {
        state
            .activations
            .iter_mut()
            .find(|a| a.id == cause)
            .unwrap()
            .context
            .clear();
    }
    if fault == "call" {
        plan.steps
            .iter_mut()
            .find(|s| s.address == addr("bad"))
            .unwrap()
            .r#type = "call".into();
        state.plan_json = Some(serde_json::to_string(&plan).unwrap());
    }
    let p = state
        .preparations
        .iter()
        .find(|p| p.status == "pending" && p.producer.step == Some(addr("j0")))
        .unwrap()
        .clone();
    let capture = StartCapture030 {
        identity: state.identity.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: serde_json::to_string(&plan).unwrap(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let id = &capture.identity;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&id.snapshot_id)
        .bind(&id.epoch)
        .bind(serde_json::to_string(&capture.source).unwrap())
        .bind(&capture.compiled_plan_json)
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_start030_requests VALUES (?,?,?,?,?,?,?,?)")
        .bind("request")
        .bind("{}")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&id.snapshot_id)
        .bind(&id.epoch)
        .bind(serde_json::to_string(&capture).unwrap())
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&id.snapshot_id)
        .bind(&id.epoch)
        .bind("owner")
        .bind("generation")
        .bind("live")
        .bind(sha(&serde_json::to_vec(&capture).unwrap()))
        .execute(&mut *tx)
        .await
        .unwrap();
    for (event, t) in &j.history {
        sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind(&event.event_id)
            .bind(serde_json::to_string(event).unwrap())
            .bind(serde_json::to_string(&t.receipt).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        for e in &t.effects {
            let mut e = e.clone();
            if fault == "forged" {
                if let FlowEffectKind030::Failure {
                    activation_id,
                    error,
                    ..
                } = &mut e.kind
                {
                    if *activation_id == cause {
                        error.message = "forged".into();
                    }
                }
            }
            let pending = matches!(&e.kind,FlowEffectKind030::PrepareRoute{reference,..} if reference==&p.reference);
            sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
                .bind(&id.system_start_id)
                .bind(&id.flow_invocation_id)
                .bind(&e.id)
                .bind(&event.event_id)
                .bind(serde_json::to_string(&e).unwrap())
                .bind("owner")
                .bind(if pending { "pending" } else { "settled" })
                .bind((!pending).then_some("{}"))
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }
    for (r, producer, native, result) in &j.preparations {
        if fault == "unattested" && r == &j.preparations.last().unwrap().0 {
            continue;
        }
        sqlx::query("INSERT INTO engine_flow030_preparations VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind(&r.prepare_id)
            .bind(native)
            .bind("owner")
            .bind("generation")
            .bind(serde_json::to_string(r).unwrap())
            .bind(serde_json::to_string(producer).unwrap())
            .bind("{}")
            .bind("{}")
            .bind(result.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for (event, _) in &j.history {
        if let FlowEventKind030::WorkResult {
            work,
            physical: Some(physical),
            result: WorkResult030::Completed { .. },
        } = &event.kind
        {
            let act = j
                .state
                .activations
                .iter()
                .find(|a| a.id == work.activation_id)
                .unwrap();
            let context = json!({"owner":{"systemStartId":"system","ownerEpoch":"owner"},"work":{"systemStartId":"system","flowInvocationId":"flow","activationId":work.activation_id,"step":act.step,"agentInstanceId":work.agent_instance_id},"permissionsJson":"{}","scopeJson":"{}","registryVersion":"test"});
            let input = json!({"context":context,"eventId":physical.native_receipt_id});
            let ticket = json!({"identity":id,"generation":"generation","input":input});
            let receipt = json!({"receiptId":format!("{}:1",work.activation_id),"revision":"1","owner":{"systemStartId":"system","activationId":work.activation_id,"agentInstanceId":work.agent_instance_id,"ownerEpoch":"owner"},"decision":{"kind":"finished","outcome":"success","output":{"text":"","resultsJson":"{}"}}});
            sqlx::query(
                "INSERT INTO engine_flow030_work_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind("system")
            .bind("flow")
            .bind(&work.activation_id)
            .bind(&work.start_effect_id)
            .bind("owner")
            .bind("generation")
            .bind(sha(&serde_json::to_vec(&capture).unwrap()))
            .bind(context.to_string())
            .bind("{}")
            .bind("{}")
            .bind("{}")
            .execute(&mut *tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO engine_flow030_work_authorizations VALUES (?,?,?,?,?,NULL,NULL)",
            )
            .bind("system")
            .bind("flow")
            .bind(&physical.native_receipt_id)
            .bind(&work.activation_id)
            .bind(input.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
            if fault != "work-unattested" || act.step != Some(addr("leaf")) {
                sqlx::query("INSERT INTO engine_flow030_work_events VALUES (?,?,?,?,?,?)")
                    .bind("system")
                    .bind("flow")
                    .bind(&physical.native_receipt_id)
                    .bind(&work.activation_id)
                    .bind(ticket.to_string())
                    .bind(json!({"receiptJson":receipt.to_string()}).to_string())
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
        }
    }
    tx.commit().await.unwrap();
    (temp, pool, capture, p.reference, p.producer)
}

async fn verify_origin(depth: usize, origin: &str, fault: &str, ok: bool) {
    let j = Journal::fail(depth, origin);
    let (_temp, pool, capture, reference, producer) = persist(&j, fault).await;
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
    let writer = crate::agsdl_host_route_attestations030::RouteAttestor030::capture(&host, &owner)
        .await
        .unwrap();
    let lease = host.start_lease().await.unwrap();
    let _guard = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    let written = writer
        .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
        .await;
    assert_eq!(
        written.is_ok(),
        ok,
        "writer depth={depth} origin={origin} fault={fault}: {:?}",
        written.as_ref().err()
    );
    if ok {
        // A fresh SQL verifier has no in-memory writer result to trust.
        let material = written.unwrap().source_only_material();
        let verifier = SqlRouteMaterialVerifier030::capture(&host, &owner)
            .await
            .unwrap();
        verifier
            .verify(&mut tx, &capture, &reference, &producer, &material)
            .await
            .unwrap();
        // A durable attestation cannot hide a later forged reducer snapshot.
        let mut altered = j.state.clone();
        altered
            .paths
            .iter_mut()
            .find(|p| p.memberships.iter().any(|m| m.failed))
            .unwrap()
            .memberships[0]
            .failed = false;
        sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
            .bind(serde_json::to_string(&altered).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        assert!(verifier
            .verify(&mut tx, &capture, &reference, &producer, &material)
            .await
            .is_err());
    }
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn prepared_failure_is_attested_and_independently_rechecked() {
    verify_origin(1, "prepared", "none", true).await;
}
#[tokio::test]
async fn admission_visit_limit_is_attested_and_independently_rechecked() {
    verify_origin(1, "visit", "none", true).await;
}
#[tokio::test]
async fn nested_failed_join_uses_the_inner_native_proof() {
    verify_origin(3, "prepared", "none", true).await;
}
#[tokio::test]
async fn recursive_proof_rejects_excessive_depth() {
    verify_origin(MAX_FAILURE_PROOF_DEPTH030, "prepared", "none", true).await;
    verify_origin(MAX_FAILURE_PROOF_DEPTH030 + 1, "prepared", "none", false).await;
}
#[tokio::test]
async fn path_failure_rejects_forgery_wrong_path_local_handler_and_missing_authority() {
    for origin in ["prepared", "visit"] {
        for fault in ["forged", "path", "unattested"] {
            verify_origin(1, origin, fault, false).await;
        }
    }
    for fault in ["local", "call"] {
        verify_origin(2, "prepared", fault, false).await;
    }
}

#[tokio::test]
async fn queued_visit_limits_in_one_event_use_the_last_failure_at_max_failures() {
    verify_origin(1, "queue", "none", true).await;
    verify_origin(1, "queue", "work-unattested", false).await;
}

#[tokio::test]
async fn physical_admission_requires_the_exact_native_group_stop_settlement() {
    use sqlx::Connection;
    let j = Journal::new(1, "prepared");
    let id = j.state.identity.clone();
    let capture = StartCapture030 {
        identity: id.clone(),
        source: serde_json::from_value(j.plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&j.plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: serde_json::to_string(&j.plan).unwrap(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let work = WorkRef030 {
        activation_id: "activation".into(),
        start_effect_id: "start".into(),
        agent_instance_id: Some("instance".into()),
    };
    let event = FlowEvent030 {
        identity: id.clone(),
        event_id: work_terminal_event_id030(&id, "joined-stop:attempt").unwrap(),
        expected_revision: "1".into(),
        kind: FlowEventKind030::PhysicalEnded {
            work: work.clone(),
            stop_effect_id: Some("stop".into()),
            evidence: PhysicalEvidence030 {
                native_receipt_id: "physical:attempt".into(),
                descendants_joined: true,
            },
        },
    };
    let stop = FlowEffect030 {
        id: "stop".into(),
        identity: id.clone(),
        revision: "1".into(),
        kind: FlowEffectKind030::StopWork {
            work,
            include_descendants: true,
        },
    };
    let settlement = json!({"kind":"nativeJoinedGroupStop030","eventId":event.event_id,"stopEffectId":"stop","ownerEpoch":"owner","generation":"generation","workAttempt":{"identity":id,"owner":owner,"generation":"generation","startEffectId":"start","providerAttemptId":"attempt","work":{"systemStartId":"system","flowInvocationId":"flow","activationId":"activation","agentInstanceId":"instance"}}});
    for fault in [
        "none",
        "native-id",
        "generation",
        "event",
        "work",
        "unjoined",
        "missing",
    ] {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE engine_flow030_outbox(system_id TEXT,invocation_id TEXT,effect_id TEXT,owner_epoch TEXT,status TEXT,effect_json TEXT,settlement_json TEXT)").execute(&mut db).await.unwrap();
        let mut event = serde_json::to_value(&event).unwrap();
        let mut settlement = settlement.clone();
        match fault {
            "native-id" => {
                event["kind"]["PhysicalEnded"]["evidence"]["native_receipt_id"] = json!("forged")
            }
            "generation" => settlement["workAttempt"]["generation"] = json!("foreign"),
            "event" => event["eventId"] = json!("foreign"),
            "work" => settlement["workAttempt"]["work"]["activationId"] = json!("foreign"),
            "unjoined" => {
                event["kind"]["PhysicalEnded"]["evidence"]["descendants_joined"] = json!(false)
            }
            _ => (),
        }
        if fault != "missing" {
            sqlx::query("INSERT INTO engine_flow030_outbox VALUES ('system','flow','stop','owner','settled',?,?)").bind(serde_json::to_string(&stop).unwrap()).bind(settlement.to_string()).execute(&mut db).await.unwrap();
        }
        let result =
            verify_preparation_origin_tx(&mut db, &capture, &owner, "generation", &event, &j.state)
                .await;
        assert_eq!(result.is_ok(), fault == "none", "{fault}: {result:?}");
    }
}
