use super::*;
use sqlx::Connection;

// Test-only registry stands in for the authority that 09 must wire to the
// real versioned native registry in the same transaction.
struct Owner {
    epoch: &'static str,
    allow_effect: bool,
}
impl Authority030 for Owner {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            let actual: Option<String> =
                sqlx::query_scalar("SELECT epoch FROM test_flow_owner WHERE system_id=?")
                    .bind(&id.system_start_id)
                    .fetch_optional(db)
                    .await?;
            if actual.as_deref() != Some(self.epoch) {
                return Err(StoreError030::Authority);
            }
            Ok(())
        })
    }
    fn effect<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            if self.allow_effect {
                Ok(())
            } else {
                Err(StoreError030::Authority)
            }
        })
    }
    fn settlement<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
        receipt: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            if receipt.get("nativeProof") == Some(&json!(true)) {
                Ok(())
            } else {
                Err(StoreError030::Authority)
            }
        })
    }
    fn owner_epoch(&self) -> &str {
        self.epoch
    }
}

const SCHEMA: &str = r#"
PRAGMA foreign_keys=ON;
CREATE TABLE test_flow_owner(system_id TEXT PRIMARY KEY,epoch TEXT NOT NULL);
INSERT INTO test_flow_owner VALUES('system','owner-1');
CREATE TABLE engine_systems(system_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL);
"#;
fn identity() -> FlowIdentity030 {
    FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "run".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture-epoch".into(),
    }
}
fn owner() -> Owner {
    Owner {
        epoch: "owner-1",
        allow_effect: true,
    }
}
async fn db() -> SqliteConnection {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(SCHEMA).execute(&mut db).await.unwrap();
    sqlx::raw_sql(include_str!("../../tests/fixtures/030_execution_flow.sql"))
        .execute(&mut db)
        .await
        .unwrap();
    db
}
async fn initialize(db: &mut SqliteConnection) {
    let raw = include_str!("../../tests/fixtures/agsdl030_compiled_plan.json");
    let plan: FlowPlan030 = serde_json::from_str(raw).unwrap();
    initialize_tx(
        db,
        &owner(),
        &identity(),
        &serde_json::to_string(&plan.source).unwrap(),
        raw,
    )
    .await
    .unwrap();
}
fn enter() -> FlowEvent030 {
    FlowEvent030 {
        identity: identity(),
        event_id: "enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    }
}
async fn begin(db: &mut SqliteConnection) {
    sqlx::query("BEGIN IMMEDIATE").execute(db).await.unwrap();
}
async fn commit(db: &mut SqliteConnection) {
    sqlx::query("COMMIT").execute(db).await.unwrap();
}

#[tokio::test]
async fn initialization_and_transition_rollback_are_atomic() {
    let mut db = db().await;
    begin(&mut db).await;
    initialize(&mut db).await;
    apply_tx(&mut db, &owner(), &enter()).await.unwrap();
    sqlx::query("ROLLBACK").execute(&mut db).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_runs")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_outbox")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn replay_conflict_claim_once_and_uncertain_settlement() {
    let mut db = db().await;
    begin(&mut db).await;
    initialize(&mut db).await;
    let receipt = match apply_tx(&mut db, &owner(), &enter()).await.unwrap() {
        Apply030::Applied(r) => r,
        _ => panic!("expected applied"),
    };
    assert_eq!(receipt.effect_ids.len(), 1);
    assert!(matches!(
        apply_tx(&mut db, &owner(), &enter()).await.unwrap(),
        Apply030::Replayed(_)
    ));
    let mut conflict = enter();
    conflict.kind = FlowEventKind030::Stop;
    assert!(matches!(
        apply_tx(&mut db, &owner(), &conflict).await,
        Err(StoreError030::Conflict)
    ));
    let denied = Owner {
        epoch: "owner-1",
        allow_effect: false,
    };
    assert!(matches!(
        claim_tx(&mut db, &denied, &identity(), &receipt.effect_ids[0]).await,
        Err(StoreError030::Authority)
    ));
    claim_tx(&mut db, &owner(), &identity(), &receipt.effect_ids[0])
        .await
        .unwrap();
    commit(&mut db).await;
    begin(&mut db).await;
    assert!(matches!(
        claim_tx(&mut db, &owner(), &identity(), &receipt.effect_ids[0]).await,
        Err(StoreError030::NotClaimable)
    ));
    assert!(matches!(
        settle_tx(
            &mut db,
            &owner(),
            &identity(),
            &receipt.effect_ids[0],
            &json!({})
        )
        .await,
        Err(StoreError030::Authority)
    ));
    let proof = json!({"nativeProof":true,"id":"receipt-1"});
    settle_tx(
        &mut db,
        &owner(),
        &identity(),
        &receipt.effect_ids[0],
        &proof,
    )
    .await
    .unwrap();
    settle_tx(
        &mut db,
        &owner(),
        &identity(),
        &receipt.effect_ids[0],
        &proof,
    )
    .await
    .unwrap();
    assert!(matches!(
        settle_tx(
            &mut db,
            &owner(),
            &identity(),
            &receipt.effect_ids[0],
            &json!({"nativeProof":true,"id":"other"})
        )
        .await,
        Err(StoreError030::Conflict)
    ));
    commit(&mut db).await;
}

#[tokio::test]
async fn rotation_fences_old_owner_and_does_not_reclaim_old_pending() {
    let mut db = db().await;
    begin(&mut db).await;
    initialize(&mut db).await;
    let receipt = match apply_tx(&mut db, &owner(), &enter()).await.unwrap() {
        Apply030::Applied(r) => r,
        _ => unreachable!(),
    };
    sqlx::query("UPDATE test_flow_owner SET epoch='owner-2' WHERE system_id='system'")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(matches!(
        read_tx(&mut db, &owner(), &identity()).await,
        Err(StoreError030::Authority)
    ));
    let new_owner = Owner {
        epoch: "owner-2",
        allow_effect: true,
    };
    assert!(read_tx(&mut db, &new_owner, &identity()).await.is_ok());
    assert!(matches!(
        claim_tx(&mut db, &new_owner, &identity(), &receipt.effect_ids[0]).await,
        Err(StoreError030::NotClaimable)
    ));
    commit(&mut db).await;
}

#[tokio::test]
async fn stop_revokes_new_starts_but_keeps_control_effect_claimable() {
    let mut db = db().await;
    begin(&mut db).await;
    initialize(&mut db).await;
    let enter = match apply_tx(&mut db, &owner(), &enter()).await.unwrap() {
        Apply030::Applied(r) => r,
        _ => unreachable!(),
    };
    let stop = FlowEvent030 {
        identity: identity(),
        event_id: "stop".into(),
        expected_revision: "1".into(),
        kind: FlowEventKind030::Stop,
    };
    let stop = match apply_tx(&mut db, &owner(), &stop).await.unwrap() {
        Apply030::Applied(r) => r,
        _ => unreachable!(),
    };
    assert!(matches!(
        claim_tx(&mut db, &owner(), &identity(), &enter.effect_ids[0]).await,
        Err(StoreError030::NotClaimable)
    ));
    let effects = read_tx(&mut db, &owner(), &identity())
        .await
        .unwrap()
        .effects;
    let stop_id = stop
        .effect_ids
        .iter()
        .find(|id| {
            effects.iter().any(|e| {
                e["effect"]["id"] == json!(id) && e["effect"]["kind"]["kind"] == "stopWork"
            })
        })
        .unwrap();
    assert!(matches!(
        claim_tx(&mut db, &owner(), &identity(), stop_id)
            .await
            .unwrap()
            .kind,
        FlowEffectKind030::StopWork { .. }
    ));
    commit(&mut db).await;
}

#[tokio::test]
async fn concurrent_claimers_cannot_both_receive_the_same_effect() {
    use sqlx::sqlite::SqliteConnectOptions;
    use std::time::Duration;
    let dir = tempfile::tempdir().unwrap();
    let options = SqliteConnectOptions::new()
        .filename(dir.path().join("flow.sqlite"))
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(5));
    let mut first = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(SCHEMA).execute(&mut first).await.unwrap();
    sqlx::raw_sql(include_str!("../../tests/fixtures/030_execution_flow.sql"))
        .execute(&mut first)
        .await
        .unwrap();
    begin(&mut first).await;
    initialize(&mut first).await;
    let receipt = match apply_tx(&mut first, &owner(), &enter()).await.unwrap() {
        Apply030::Applied(r) => r,
        _ => unreachable!(),
    };
    commit(&mut first).await;
    let second = SqliteConnection::connect_with(&options).await.unwrap();
    let id = receipt.effect_ids[0].clone();
    async fn contender(mut db: SqliteConnection, id: String) -> bool {
        begin(&mut db).await;
        let claimed = claim_tx(&mut db, &owner(), &identity(), &id).await.is_ok();
        commit(&mut db).await;
        claimed
    }
    let (a, b) = tokio::join!(contender(first, id.clone()), contender(second, id));
    assert_ne!(a, b);
}

#[tokio::test]
async fn capture_identity_and_revision_are_checked_before_transition() {
    let mut db = db().await;
    begin(&mut db).await;
    initialize(&mut db).await;
    let mut other = enter();
    other.identity.epoch = "forged-capture".into();
    assert!(matches!(
        apply_tx(&mut db, &owner(), &other).await,
        Err(StoreError030::Authority)
    ));
    let mut stale = enter();
    stale.expected_revision = "9".into();
    assert!(matches!(
        apply_tx(&mut db, &owner(), &stale).await,
        Err(StoreError030::Reducer(FlowInputError030::Revision))
    ));
    let view = read_tx(&mut db, &owner(), &identity()).await.unwrap();
    assert_eq!(view.state.revision, "0");
    assert!(view.events.is_empty());
    assert!(view.effects.is_empty());
    commit(&mut db).await;
}

#[tokio::test]
async fn ambiguous_shared_stop_is_durable_without_transition_and_stop_is_available() {
    use super::super::flow030::{
        DeliveryOccurrence030, PhysicalEvidence030, PreparedBatch030, PreparedItem030,
        PreparedResult030, Target030, WorkRef030, WorkResult030,
    };
    let mut db = db().await;
    begin(&mut db).await;
    let raw =
        include_str!("../../tests/fixtures/agsdl030_shared_stop_pending_compiled_plan.json");
    let plan: FlowPlan030 = serde_json::from_str(raw).unwrap();
    initialize_tx(
        &mut db,
        &owner(),
        &identity(),
        &serde_json::to_string(&plan.source).unwrap(),
        raw,
    )
    .await
    .unwrap();
    apply_tx(&mut db, &owner(), &enter()).await.unwrap();
    let view = read_tx(&mut db, &owner(), &identity()).await.unwrap();
    let a = view
        .state
        .activations
        .iter()
        .find(|a| {
            a.step
                .as_ref()
                .is_some_and(|s| s.as_slice() == ["o".to_string()])
                && a.phase == "running"
        })
        .unwrap();
    let result = FlowEvent030 {
        identity: identity(),
        event_id: "origin-result".into(),
        expected_revision: view.state.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: WorkRef030 {
                activation_id: a.id.clone(),
                start_effect_id: a.start_effect_id.clone().unwrap(),
                agent_instance_id: a.instance_id.clone(),
            },
            result: WorkResult030::Completed {
                output_json: json!({"choice":"approve","results":{"items":["x","y"]}}).to_string(),
                route_key: Some("approve".into()),
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: "physical-o".into(),
                descendants_joined: true,
            }),
        },
    };
    apply_tx(&mut db, &owner(), &result).await.unwrap();
    let before = read_tx(&mut db, &owner(), &identity()).await.unwrap();
    let p = before
        .state
        .preparations
        .iter()
        .find(|p| p.status == "pending")
        .unwrap();
    let route = plan
        .routes
        .iter()
        .find(|r| {
            r.source == p.reference.route.source
                && r.kind == p.reference.route.kind
                && r.key == p.reference.route.key
        })
        .unwrap();
    let batches = route
        .targets
        .iter()
        .enumerate()
        .map(|(ordinal, target)| {
            let Target030::Step {
                each_path_json,
                address,
                ..
            } = target
            else {
                panic!("unexpected output")
            };
            let values = if each_path_json.is_some() {
                vec![Some("\"x\"".to_owned()), Some("\"y\"".to_owned())]
            } else {
                vec![None]
            };
            let message = plan
                .steps
                .iter()
                .find(|s| s.address == *address)
                .unwrap()
                .r#type
                == "agent";
            PreparedBatch030 {
                target_ordinal: ordinal,
                target: target.clone(),
                items: values
                    .into_iter()
                    .enumerate()
                    .map(|(index, item_json)| PreparedItem030 {
                        message_json: message.then(|| "{}".into()),
                        item_json,
                        occurrence: DeliveryOccurrence030 {
                            native_receipt_id: "native-prepare".into(),
                            target_ordinal: ordinal,
                            item_index: index.to_string(),
                        },
                    })
                    .collect(),
            }
        })
        .collect();
    let event = FlowEvent030 {
        identity: identity(),
        event_id: "ambiguous".into(),
        expected_revision: before.state.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference: p.reference.clone(),
            native_receipt_id: "native-prepare".into(),
            result: PreparedResult030::Ready { batches },
        },
    };
    let diagnostic = match apply_tx(&mut db, &owner(), &event).await.unwrap() {
        Apply030::Diagnostic(d) => d,
        _ => panic!("expected diagnostic"),
    };
    assert_eq!(diagnostic["code"], "UNSPECIFIED_SHARED_CANCELLATION");
    assert!(matches!(
        apply_tx(&mut db, &owner(), &event).await.unwrap(),
        Apply030::Diagnostic(_)
    ));
    let after = read_tx(&mut db, &owner(), &identity()).await.unwrap();
    assert_eq!(after.state, before.state);
    assert_eq!(after.effects.len(), before.effects.len());
    let stop = FlowEvent030 {
        identity: identity(),
        event_id: "explicit-stop".into(),
        expected_revision: before.state.revision.clone(),
        kind: FlowEventKind030::Stop,
    };
    let stopped = match apply_tx(&mut db, &owner(), &stop).await.unwrap() {
        Apply030::Applied(receipt) => receipt,
        _ => panic!("expected explicit stop"),
    };
    let mut claimed_control = false;
    for effect_id in stopped.effect_ids {
        if matches!(
            claim_tx(&mut db, &owner(), &identity(), &effect_id).await,
            Ok(FlowEffect030 {
                kind: FlowEffectKind030::RunEnded { .. },
                ..
            })
        ) {
            claimed_control = true;
        }
    }
    assert!(claimed_control);
    commit(&mut db).await;
}

#[tokio::test]
async fn equal_fanout_values_keep_distinct_durable_delivery_occurrences() {
    use super::super::flow030::{
        DeliveryOccurrence030, PhysicalEvidence030, PreparedBatch030, PreparedItem030,
        PreparedResult030, Target030, WorkRef030, WorkResult030,
    };
    let mut db = db().await;
    begin(&mut db).await;
    let raw = include_str!("../../tests/fixtures/agsdl030_wait_boundary_compiled_plan.json");
    let plan: FlowPlan030 = serde_json::from_str(raw).unwrap();
    initialize_tx(
        &mut db,
        &owner(),
        &identity(),
        &serde_json::to_string(&plan.source).unwrap(),
        raw,
    )
    .await
    .unwrap();
    apply_tx(&mut db, &owner(), &enter()).await.unwrap();
    let view = read_tx(&mut db, &owner(), &identity()).await.unwrap();
    let a = view
        .state
        .activations
        .iter()
        .find(|a| {
            a.step
                .as_ref()
                .is_some_and(|s| s.as_slice() == ["start".to_string()])
                && a.phase == "running"
        })
        .unwrap();
    let result = FlowEvent030 {
        identity: identity(),
        event_id: "source-result".into(),
        expected_revision: view.state.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: WorkRef030 {
                activation_id: a.id.clone(),
                start_effect_id: a.start_effect_id.clone().unwrap(),
                agent_instance_id: a.instance_id.clone(),
            },
            result: WorkResult030::Completed {
                output_json: json!({"choice":"split","results":{"items":["same","same"]}})
                    .to_string(),
                route_key: Some("split".into()),
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: "physical-start".into(),
                descendants_joined: true,
            }),
        },
    };
    apply_tx(&mut db, &owner(), &result).await.unwrap();
    let view = read_tx(&mut db, &owner(), &identity()).await.unwrap();
    let p = view
        .state
        .preparations
        .iter()
        .find(|p| p.status == "pending")
        .unwrap();
    let route = plan
        .routes
        .iter()
        .find(|r| r.source == p.reference.route.source && r.key == p.reference.route.key)
        .unwrap();
    let batches = route
        .targets
        .iter()
        .enumerate()
        .map(|(ordinal, target)| {
            let Target030::Step { each_path_json, .. } = target else {
                panic!("unexpected output")
            };
            let values = if each_path_json.is_some() {
                vec![Some("\"same\"".to_owned()), Some("\"same\"".to_owned())]
            } else {
                vec![None]
            };
            PreparedBatch030 {
                target_ordinal: ordinal,
                target: target.clone(),
                items: values
                    .into_iter()
                    .enumerate()
                    .map(|(index, item_json)| PreparedItem030 {
                        message_json: Some("{\"content\":\"equal\"}".into()),
                        item_json,
                        occurrence: DeliveryOccurrence030 {
                            native_receipt_id: "receipt-prepared".into(),
                            target_ordinal: ordinal,
                            item_index: index.to_string(),
                        },
                    })
                    .collect(),
            }
        })
        .collect();
    let event = FlowEvent030 {
        identity: identity(),
        event_id: "prepared".into(),
        expected_revision: view.state.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference: p.reference.clone(),
            native_receipt_id: "receipt-prepared".into(),
            result: PreparedResult030::Ready { batches },
        },
    };
    let receipt = match apply_tx(&mut db, &owner(), &event).await.unwrap() {
        Apply030::Applied(r) => r,
        _ => unreachable!(),
    };
    let mut tuples = Vec::new();
    for id in receipt.effect_ids {
        let effect = claim_tx(&mut db, &owner(), &identity(), &id).await.unwrap();
        if let FlowEffectKind030::Start {
            step: Some(step),
            occurrence: Some(occurrence),
            ..
        } = effect.kind
        {
            if step == ["a".to_string()] {
                tuples.push((
                    occurrence.native_receipt_id,
                    occurrence.target_ordinal,
                    occurrence.item_index,
                ));
            }
        }
    }
    tuples.sort();
    assert_eq!(
        tuples,
        vec![
            ("receipt-prepared".into(), 0, "0".into()),
            ("receipt-prepared".into(), 0, "1".into())
        ]
    );
    commit(&mut db).await;
}
