//! Exact wire tokens are required for 030 source and terminal attestations.
use super::*;

#[test]
fn exact_comparison_preserves_numeric_lexemes() {
    assert!(exact(
        r#"{"results":[1e0,9007199254740993]}"#,
        r#"{"results":[1e0,9007199254740993]}"#
    )
    .unwrap());
    assert!(!exact(r#"{"results":[1]}"#, r#"{"results":[1.0]}"#).unwrap());
    assert!(!exact(r#"{"results":[1]}"#, r#"{"results":[1e0]}"#).unwrap());
}

#[test]
fn accepted_results_keep_exponent_and_large_integer_tokens() {
    let output = json!({"text":"ok", "resultsJson":"{\"x\":1e0,\"n\":9007199254740993}"});
    let encoded = accepted_output_json(&output).unwrap();
    assert!(exact(
        &encoded,
        r#"{"text":"ok","results":{"x":1e0,"n":9007199254740993}}"#
    )
    .unwrap());
    assert!(!exact(
        &encoded,
        r#"{"text":"ok","results":{"x":1.0,"n":9007199254740993}}"#
    )
    .unwrap());
    assert!(!exact(
        &encoded,
        r#"{"text":"ok","results":{"x":1,"n":9007199254740993}}"#
    )
    .unwrap());
}

#[test]
fn native_content_compares_inline_and_expanded_ref_before_number_decoding() {
    let identity = json!({"captureId":"capture","sourceDigest":"source","agent":"worker","policyDigest":"policy"});
    let make = |source: &str, transported: &str| {
        let native: ResolvedContentReceipt = serde_json::from_value(json!({
            "payload":{"kind":"json","json":"1e0"},
            "provenance":{"captureId":"capture","sourceDigest":"source","agent":"worker","usage":"prompt",
                "pointer":"/message/prompt/0","sourceJsonDigest":sha(source.as_bytes()),"requestedUri":null,
                "finalUri":null,"fileParentIdentity":null,"declaredMediaType":null,"observedMediaType":null,
                "mediaType":"application/json","sizeBytes":"3","sha256":sha(b"1e0"),"policyDigest":"policy"}
        })).unwrap();
        let receipt = json!({"sourceJson":transported,"payload":native.payload.clone(),
            "provenance":{"captureId":"capture","sourceDigest":"source","agent":"worker","usage":"prompt",
                "pointer":"/message/prompt/0","requestedUri":null,"mediaType":"application/json",
                "sha256":sha(b"1e0"),"policyDigest":"policy"}});
        (native, receipt)
    };
    let document = r#"{"content":{"sample":{"value":1e0}}}"#;
    for source in [r#"{"ref":"sample"}"#, r#"{"value":1e0}"#] {
        let (native, valid) = make(source, r#"{"value":1e0}"#);
        assert!(verify_native_content(&native, source, &valid, &identity, document).is_ok());
        for altered in [r#"{"value":1}"#, r#"{"value":1.0}"#] {
            let (_, receipt) = make(source, altered);
            assert!(verify_native_content(&native, source, &receipt, &identity, document).is_err());
        }
    }
}

/// Synthetic rows only: exercise the same independent SQL check used on reads.
#[tokio::test]
async fn failed_group_requires_one_exact_accepted_join_failure() {
    use crate::db::agsdl_execution::flow030::{
        EventRecord030, Failure030, FlowIdentity030, FlowReceipt030,
    };
    use sqlx::Connection;
    for fault in ["none", "missing", "duplicated", "different"] {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE engine_flow030_events(system_id TEXT,invocation_id TEXT,event_id TEXT,event_json TEXT,receipt_json TEXT,diagnostic_json TEXT)").execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE engine_flow030_outbox(system_id TEXT,invocation_id TEXT,effect_id TEXT,effect_json TEXT,event_id TEXT,owner_epoch TEXT)").execute(&mut db).await.unwrap();
        let id = FlowIdentity030 {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            snapshot_id: "snapshot".into(),
            epoch: "epoch".into(),
        };
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        };
        let producer = Producer030 {
            activation_id: "join".into(),
            step: Some(vec!["merge".into()]),
            kind: "join".into(),
            input_json: "{}".into(),
            message_json: Some("{}".into()),
            item_json: None,
            output_json: "{}".into(),
        };
        let error = crate::db::agsdl_execution::flow030::Failure030::new("BRANCH_FAILED");
        let actual = if fault == "different" {
            Failure030::new("OTHER")
        } else {
            error.clone()
        };
        let effect = FlowEffect030 {
            id: "failure".into(),
            identity: id.clone(),
            revision: "1".into(),
            kind: FlowEffectKind030::Failure {
                activation_id: "join".into(),
                step: Some(vec!["merge".into()]),
                error: actual,
                counted: true,
            },
        };
        let mut ids = vec!["failure".to_owned()];
        if fault == "duplicated" {
            ids.push("failure-2".into());
        }
        let receipt = FlowReceipt030 {
            event_id: "event".into(),
            revision: "1".into(),
            effect_ids: ids,
        };
        let event_json = json!({"identity":id,"eventId":"event"}).to_string();
        let mut state = FlowState030::new(id.clone());
        state.events.insert(
            "event".into(),
            EventRecord030 {
                event_json: event_json.clone(),
                receipt: receipt.clone(),
            },
        );
        sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
            .bind("system")
            .bind("flow")
            .bind("event")
            .bind(&event_json)
            .bind(serde_json::to_string(&receipt).unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        if fault != "missing" {
            sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?)")
                .bind("system")
                .bind("flow")
                .bind(&effect.id)
                .bind(serde_json::to_string(&effect).unwrap())
                .bind("event")
                .bind("owner")
                .execute(&mut db)
                .await
                .unwrap();
        }
        if fault == "duplicated" {
            let mut duplicate = effect.clone();
            duplicate.id = "failure-2".into();
            sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?)")
                .bind("system")
                .bind("flow")
                .bind(&duplicate.id)
                .bind(serde_json::to_string(&duplicate).unwrap())
                .bind("event")
                .bind("owner")
                .execute(&mut db)
                .await
                .unwrap();
        }
        let result =
            verify_join_failure_effect_tx(&mut db, &id, &owner, &producer, &error, &state).await;
        assert_eq!(result.is_ok(), fault == "none", "fault {fault}");
    }
}

#[test]
fn failed_group_rejects_the_same_failed_path_twice() {
    use crate::db::agsdl_execution::flow030::{
        FlowIdentity030, Group030, GroupBranch030, Membership030, Path030,
    };
    let id = FlowIdentity030 {
        system_start_id: "s".into(),
        flow_invocation_id: "f".into(),
        snapshot_id: "snapshot".into(),
        epoch: "epoch".into(),
    };
    let mut state = FlowState030::new(id);
    state.paths.push(Path030 {
        id: "p".into(),
        memberships: vec![Membership030 {
            group_id: "g".into(),
            branch: "a".into(),
            phase: "ended".into(),
            result_json: None,
            producer: None,
            accepted: false,
            failed: true,
        }],
        batch_id: None,
        item_json: None,
        context: vec![],
        phase: "ended".into(),
    });
    let mut group = Group030 {
        id: "g".into(),
        join: vec!["j".into()],
        origin_activation_id: "o".into(),
        activation_id: "j".into(),
        context: vec![],
        branches: vec![GroupBranch030 {
            name: "a".into(),
            fanout: true,
            path_ids: vec!["p".into()],
        }],
        decision: None,
        decided_ordinal: None,
        output_json: None,
        error: None,
        continuation: None,
        released: false,
    };
    assert_eq!(failed_group_paths(&group, &state).unwrap().len(), 1);
    group.branches[0].path_ids.push("p".into());
    assert!(failed_group_paths(&group, &state).is_err());
}

#[test]
fn only_local_error_handlers_exclude_branch_failure_candidates() {
    let mut plan: FlowPlan030 = serde_json::from_str(include_str!(
        "../tests/fixtures/agsdl030_compiled_plan.json"
    ))
    .unwrap();
    let mut route = plan.routes[0].clone();
    route.source = vec!["a".into()];
    route.kind = "error".into();
    route.inherited = false;
    plan.routes.push(route);
    assert!(has_local_error_handler(&plan, &Some(vec!["a".into()])));
    assert!(!has_local_error_handler(
        &plan,
        &Some(vec!["handler".into()])
    ));
    plan.routes.last_mut().unwrap().inherited = true;
    assert!(!has_local_error_handler(&plan, &Some(vec!["a".into()])));
}

#[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
#[tokio::test]
async fn call_source_requires_exact_receipt_generation_visit_and_physical_end() {
    use crate::agsdl_host_calls030::{tests as calls, CallDataBroker030};
    for invalid in [false, true] {
        let f = calls::Fixture::new(r#"{"type":"call","command":"never execute","parse":"json"}"#)
            .await;
        let broker = CallDataBroker030::default();
        let witness = calls::joined(
            &f,
            &broker,
            calls::command(
                1,
                if invalid {
                    "invalid"
                } else {
                    r#"{"n":9007199254740993}"#
                },
            ),
        )
        .await;
        let owner = EngineOwner {
            system_start_id: f.id.system_start_id.clone(),
            owner_epoch: "owner".into(),
        };
        let mut tx = f.pool.begin().await.unwrap();
        let raw: String = sqlx::query_scalar("SELECT capture_json FROM engine_start030_requests")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let capture: StartCapture030 = serde_json::from_str(&raw).unwrap();
        let (message_json, item_json) = match &witness.attempt().effect().kind {
            FlowEffectKind030::Start {
                message_json,
                item_json,
                ..
            } => (message_json.clone(), item_json.clone()),
            _ => unreachable!(),
        };
        let mut producer = Producer030 {
            activation_id: witness.attempt().work().activation_id.clone(),
            step: Some(witness.attempt().address().to_vec()),
            kind: "call".into(),
            input_json: witness.attempt().input_json().into(),
            message_json,
            item_json,
            output_json: "{}".into(),
        };
        assert!(
            verify_call_source_tx(&mut tx, &capture, &producer, &owner, "generation")
                .await
                .is_err()
        );
        tx.rollback().await.unwrap();
        let receipt = calls::finish(&f, &broker, &witness).await;
        producer.output_json = match receipt.work_result().unwrap().unwrap() {
            WorkResult030::Completed { output_json, .. } => output_json,
            WorkResult030::Failed { error } => json!({"error":error}).to_string(),
        };
        let mut tx = f.pool.begin().await.unwrap();
        assert!(
            verify_call_source_tx(&mut tx, &capture, &producer, &owner, "generation")
                .await
                .is_ok()
        );
        assert!(
            verify_call_source_tx(&mut tx, &capture, &producer, &owner, "old-generation")
                .await
                .is_err()
        );
        let mut forged = producer.clone();
        forged.output_json = "{}".into();
        assert!(
            verify_call_source_tx(&mut tx, &capture, &forged, &owner, "generation")
                .await
                .is_err()
        );
        forged = producer.clone();
        forged.activation_id = "other-visit".into();
        assert!(
            verify_call_source_tx(&mut tx, &capture, &forged, &owner, "generation")
                .await
                .is_err()
        );
        let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
        state
            .activations
            .iter_mut()
            .find(|a| a.id == producer.activation_id)
            .unwrap()
            .physical = true;
        sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
            .bind(serde_json::to_string(&state).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        assert!(
            verify_call_source_tx(&mut tx, &capture, &producer, &owner, "generation")
                .await
                .is_err()
        );
        tx.rollback().await.unwrap();
    }
}

#[path = "agsdl_host_path_failure030_tests.rs"]
mod path_failure_tests;
