//! Native 11 resolution with synthetic capture/policy fixtures. No provider or
//! SQL authority is claimed by these focused transport/correlation regressions.
use super::*;
use crate::agsdl_content::{ContentPayload, ContentUsage};
use crate::agsdl_permissions::{
    normalize_requested, EffectivePolicy, ExecutionPurpose, PathContext, RequestedPermissions,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const DOCUMENT: &str = r#"{"agents":{"worker":{},"other":{}},"content":{"sample":{"value":{"n":9007199254740993,"e":1e0}}}}"#;
fn context(cancel: CancellationToken, agent: &str) -> (tempfile::TempDir, ContentContext) {
    let temp = tempfile::TempDir::new().unwrap();
    let paths = PathContext {
        workspace: temp.path().to_path_buf(),
        home: temp.path().to_path_buf(),
    };
    let policy = || {
        normalize_requested(
            serde_json::from_value::<RequestedPermissions>(json!("read-only")).unwrap(),
            paths.clone(),
        )
        .unwrap()
    };
    let context = ContentContext::capture(
        "snapshot".into(),
        sha(DOCUMENT.as_bytes()),
        DOCUMENT.into(),
        None,
        agent.into(),
        EffectivePolicy::new(policy(), policy(), policy()),
        ExecutionPurpose::Agent,
        cancel,
        Arc::new(|_| {
            Box::pin(async { panic!("inline content must not ask for an external action") })
        }),
    )
    .unwrap();
    (temp, context)
}
fn fixture() -> (StartCapture030, PrepareRef030) {
    let capture:StartCapture030=serde_json::from_value(json!({
        "identity":{"systemStartId":"system","flowInvocationId":"run","snapshotId":"snapshot","epoch":"epoch"},
        "source":{"owner":{"projectId":"project","planId":"plan","branch":"main"},"revision":"1","sourceSha256":"source"},
        "versions":{"snapshot":"snapshot","contract":"contract","compiler":"compiler","runtime":"runtime","registry":"registry","profile":"profile"},
        "authoredSource":DOCUMENT,"compiledPlanJson":"{}","registryJson":"{}","privateCaptureJson":"{}"
    })).unwrap();
    let reference:PrepareRef030=serde_json::from_value(json!({"identity":capture.identity,"prepareId":"prepare","activationId":"producer","revision":"1",
        "route":{"source":["origin"],"kind":"normal","key":null},"context":[]})).unwrap();
    (capture, reference)
}
fn plan(capture: &mut StartCapture030, recipient_kind: &str, agent: Option<&str>) {
    capture.compiled_plan_json=json!({"format":"fixture","versions":{"snapshot":"snapshot","contract":"contract","compiler":"compiler","runtime":"runtime","registry":"registry","profile":"profile"},
        "source":{},"documentJson":DOCUMENT,"agents":[],"entry":null,"scopes":[],
        "steps":[{"address":["origin"],"scope":[],"type":"agent","declarationJson":"{}","agent":"worker","instance":null,"delivery":null,"maxVisitsJson":null,"timeoutMsJson":null,"submissionContractJson":null},
        {"address":["target"],"scope":[],"type":recipient_kind,"declarationJson":"{}","agent":agent,"instance":null,"delivery":null,"maxVisitsJson":null,"timeoutMsJson":null,"submissionContractJson":null}],
        "routes":[{"source":["origin"],"kind":"normal","key":null,"declarationJson":"{}","targets":[{"kind":"step","address":["target"],"messageJson":null,"eachPathJson":null,"concurrencyJson":null,"maxJson":null}],"inherited":false}],
        "joins":[],"handlers":[],"graphlessSubmissionContracts":{}}).to_string();
}

#[test]
fn occurrence_indices_are_canonical_without_lossy_integer_conversion() {
    for valid in [
        "0",
        "1",
        "9007199254740993",
        "999999999999999999999999999999999999",
    ] {
        assert!(canonical_index(valid).is_ok());
    }
    for invalid in ["", "00", "01", "+1", "-1", "1.0", "1e0", " 1", "１"] {
        assert!(canonical_index(invalid).is_err());
    }
}
#[tokio::test]
async fn transport_is_built_from_real_native_resolution_and_preserves_ref_lexemes() {
    let (_temp, context) = context(CancellationToken::new(), "worker");
    let binding = context.binding().unwrap();
    let usage = ContentUse {
        source_json: r#"{"ref":"sample"}"#.into(),
        usage: ContentUsage::Resource,
        pointer: "/message/resources/sample".into(),
    };
    let native = resolve_content(
        &context,
        ContentUse {
            source_json: usage.source_json.clone(),
            usage: usage.usage,
            pointer: usage.pointer.clone(),
        },
    )
    .await
    .unwrap();
    let receipt = transport_receipt(&binding, &usage, &native).unwrap();
    assert_eq!(
        receipt["sourceJson"],
        r#"{"value":{"n":9007199254740993,"e":1e0}}"#
    );
    assert!(
        matches!(&native.payload,ContentPayload::Json {json} if json==r#"{"n":9007199254740993,"e":1e0}"#)
    );
    assert_eq!(receipt["provenance"]["pointer"], usage.pointer);
    assert_eq!(receipt["provenance"]["policyDigest"], binding.policy_digest);
    let wrong = ContentUse {
        source_json: r#"{"value":1}"#.into(),
        usage: usage.usage,
        pointer: usage.pointer.clone(),
    };
    assert!(transport_receipt(&binding, &wrong, &native).is_err());
    let wrong = ContentUse {
        source_json: usage.source_json.clone(),
        usage: ContentUsage::Prompt,
        pointer: usage.pointer.clone(),
    };
    assert!(transport_receipt(&binding, &wrong, &native).is_err());
    let wrong = ContentUse {
        source_json: usage.source_json.clone(),
        usage: usage.usage,
        pointer: "/another".into(),
    };
    assert!(transport_receipt(&binding, &wrong, &native).is_err());
}
#[test]
fn recipient_is_bound_to_snapshot_document_agent_and_actual_policy() {
    let (_temp, context) = context(CancellationToken::new(), "worker");
    let binding = context.binding().unwrap();
    let (mut capture, reference) = fixture();
    plan(&mut capture, "agent", Some("worker"));
    assert!(validate_recipient(&capture, &reference, 0, &binding).is_ok());
    assert!(validate_recipient(&capture, &reference, 1, &binding).is_err());
    capture.identity.snapshot_id = "foreign".into();
    assert!(validate_recipient(&capture, &reference, 0, &binding).is_err());
    capture.identity.snapshot_id = "snapshot".into();
    plan(&mut capture, "agent", Some("other"));
    assert!(validate_recipient(&capture, &reference, 0, &binding).is_err());
    for kind in ["approval", "compose", "call", "join"] {
        plan(&mut capture, kind, None);
        assert!(
            validate_recipient(&capture, &reference, 0, &binding).is_err(),
            "cannot borrow an agent for {kind}"
        );
    }
}
#[tokio::test]
async fn cancelled_native_context_cannot_resolve_or_supply_a_live_binding() {
    let cancel = CancellationToken::new();
    let (_temp, context) = context(cancel.clone(), "worker");
    cancel.cancel();
    assert!(context.binding().is_err());
    let result = resolve_content(
        &context,
        ContentUse {
            source_json: r#"{"value":"data"}"#.into(),
            usage: ContentUsage::Prompt,
            pointer: "/message/prompt".into(),
        },
    )
    .await;
    assert_eq!(result.unwrap_err().code, "CANCELLED");
}

/// Native tables and owner below are synthetic. The test verifies persistence
/// boundaries, not a provider admission or a real controller decision producer.
async fn sql_fixture(
    accepted_text: &str,
) -> (
    tempfile::TempDir,
    sqlx::SqlitePool,
    HostState,
    StartCapture030,
    PrepareRef030,
) {
    sql_fixture_with_fault(accepted_text, None).await
}
async fn sql_fixture_with_fault(
    accepted_text: &str,
    fault: Option<&str>,
) -> (
    tempfile::TempDir,
    sqlx::SqlitePool,
    HostState,
    StartCapture030,
    PrepareRef030,
) {
    use crate::db::agsdl_execution::{
        dto::{EngineContext, EngineWork},
        flow030::{FlowEvent030, FlowEventKind030, Preparation030},
    };
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("writer.db"))
        .await
        .unwrap();
    let (mut capture, reference) = fixture();
    plan(&mut capture, "agent", Some("worker"));
    let id = &capture.identity;
    let owner = EngineOwner {
        system_start_id: id.system_start_id.clone(),
        owner_epoch: "owner".into(),
    };
    let mut producer = Producer030 {
        activation_id: "producer".into(),
        step: Some(vec!["origin".into()]),
        kind: "agent".into(),
        input_json: "{}".into(),
        message_json: None,
        item_json: None,
        output_json: r#"{"text":"ok","results":{}}"#.into(),
    };
    if fault == Some("unauthorized-instructions") {
        producer.output_json = r#"{"text":"ok","results":{},"instructions":["mission"]}"#.into();
    }
    let mut state = FlowState030::new(id.clone());
    state.entered = true;
    state.revision = "1".into();
    state.plan_json = Some(capture.compiled_plan_json.clone());
    state.preparations.push(Preparation030 {
        reference: reference.clone(),
        producer: producer.clone(),
        status: "pending".into(),
    });
    let effect = FlowEffect030 {
        id: "prepare-effect".into(),
        identity: id.clone(),
        revision: "1".into(),
        kind: FlowEffectKind030::PrepareRoute {
            reference: reference.clone(),
            producer,
        },
    };
    let context = EngineContext {
        owner: owner.clone(),
        work: EngineWork {
            system_start_id: id.system_start_id.clone(),
            flow_invocation_id: id.flow_invocation_id.clone(),
            activation_id: "producer".into(),
            step: Some(vec!["origin".into()]),
            agent_instance_id: Some("instance".into()),
        },
        permissions_json: "[]".into(),
        scope_json: "{}".into(),
        registry_version: capture.versions.registry.clone(),
    };
    let mut ticket = json!({"identity":id,"generation":"generation","input":{"eventId":"accepted","context":context}});
    let mut receipt = json!({"owner":{"systemStartId":id.system_start_id,"activationId":"producer","agentInstanceId":"instance","ownerEpoch":"owner"},"decision":{"kind":"accepted","output":{"text":accepted_text,"resultsJson":"{}"}}});
    match fault {
        None => {}
        Some("ticket-generation") => ticket["generation"] = json!("foreign-generation"),
        Some("ticket-identity") => ticket["identity"]["snapshotId"] = json!("foreign-snapshot"),
        Some("ticket-context") => {
            ticket["input"]["context"]["work"]["activationId"] = json!("foreign-work")
        }
        Some("ticket-event") => ticket["input"]["eventId"] = json!("foreign-event"),
        Some("receipt-owner") => receipt["owner"]["ownerEpoch"] = json!("foreign-epoch"),
        Some("receipt-kind") => receipt["decision"]["kind"] = json!("rejected"),
        Some("receipt-output-type") => receipt["decision"]["output"]["resultsJson"] = json!(5),
        Some("unauthorized-instructions") => {
            receipt["decision"]["output"]["instructions"] = json!(["mission"])
        }
        _ => panic!("unknown synthetic SQL fault"),
    }
    let decision = json!({"receiptJson":receipt.to_string()});
    let event = FlowEvent030 {
        identity: id.clone(),
        event_id: "seed".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
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
        .bind(&owner.owner_epoch)
        .bind("generation")
        .bind("live")
        .bind(sha(&serde_json::to_vec(&capture).unwrap()))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind("seed")
        .bind(serde_json::to_string(&event).unwrap())
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&effect.id)
        .bind("seed")
        .bind(serde_json::to_string(&effect).unwrap())
        .bind(&owner.owner_epoch)
        .bind("pending")
        .bind(None::<String>)
        .execute(&mut *tx)
        .await
        .unwrap();
    // Admission FK requires a Start effect, but this fixture does not claim
    // that the effect was actually admitted to a provider or physical owner.
    sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind("start-effect")
        .bind("seed")
        .bind("{}")
        .bind(&owner.owner_epoch)
        .bind("settled")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_work_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind("producer")
        .bind("start-effect")
        .bind(&owner.owner_epoch)
        .bind("generation")
        .bind(sha(&serde_json::to_vec(&capture).unwrap()))
        .bind(serde_json::to_string(&context).unwrap())
        .bind(r#"{"agentJson":"{}"}"#)
        .bind("{}")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_work_authorizations VALUES (?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind("accepted")
        .bind("producer")
        .bind("{}")
        .bind(None::<String>)
        .bind(None::<String>)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_work_events VALUES (?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind("accepted")
        .bind("producer")
        .bind(ticket.to_string())
        .bind(decision.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let host = crate::agsdl_host::route_attestation_test_host030(owner, "generation");
    (temp, pool, host, capture, reference)
}
struct SyntheticPolicy {
    deny_index: Option<&'static str>,
}
impl RouteRecipientAuthority030 for SyntheticPolicy {
    fn attest_tx<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _capture: &'a StartCapture030,
        _reference: &'a PrepareRef030,
        _ordinal: usize,
        index: &'a str,
        _binding: &'a ContentContextBinding,
        _uses: &'a [ContentUse],
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            if self.deny_index == Some(index) {
                Err(crate::db::agsdl_execution::flow_store030::StoreError030::Authority)
            } else {
                Ok(())
            }
        })
    }
}
fn resource_use() -> ContentUse {
    ContentUse {
        source_json: r#"{"ref":"sample"}"#.into(),
        usage: ContentUsage::Resource,
        pointer: "/message/resources/sample".into(),
    }
}
#[tokio::test]
async fn sql_source_rejects_contradictory_accepted_output_without_partial_attestation() {
    let (_temp, pool, host, capture, reference) = sql_fixture("contradiction").await;
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
    let lease = host.start_lease().await.unwrap();
    let _admission = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    assert!(writer
        .attest_agent_source_tx(
            &mut tx,
            &lease,
            host.flow030(),
            &capture,
            &reference,
            "accepted"
        )
        .await
        .is_err());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(count, 0);
    tx.rollback().await.unwrap();
}
#[tokio::test]
async fn sql_occurrence_failure_rolls_back_all_rows_then_distinct_equal_items_persist() {
    let (_temp, pool, host, capture, reference) = sql_fixture("ok").await;
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
    let source = {
        let lease = host.start_lease().await.unwrap();
        let _admission = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        let source = writer
            .attest_agent_source_tx(
                &mut tx,
                &lease,
                host.flow030(),
                &capture,
                &reference,
                "accepted",
            )
            .await
            .unwrap();
        tx.commit().await.unwrap();
        source
    };
    let (_a, context_a) = context(CancellationToken::new(), "worker");
    let (_b, context_b) = context(CancellationToken::new(), "worker");
    let a = writer
        .resolve_occurrence(&source, 0, "0".into(), context_a, vec![resource_use()])
        .await
        .unwrap();
    let b = writer
        .resolve_occurrence(&source, 0, "1".into(), context_b, vec![resource_use()])
        .await
        .unwrap();
    let occurrences = vec![a, b];
    let lease = host.start_lease().await.unwrap();
    let _admission = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    assert!(writer
        .attest_occurrences_tx(
            &mut tx,
            &lease,
            host.flow030(),
            &source,
            &occurrences,
            &SyntheticPolicy {
                deny_index: Some("1")
            }
        )
        .await
        .is_err());
    let contexts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_content_contexts")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let receipts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_content_receipts")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(contexts, 0);
    assert_eq!(receipts, 0);
    let material = writer
        .attest_occurrences_tx(
            &mut tx,
            &lease,
            host.flow030(),
            &source,
            &occurrences,
            &SyntheticPolicy { deny_index: None },
        )
        .await
        .unwrap();
    let wire: Value = serde_json::from_str(&material.content_receipts_json).unwrap();
    let uses = wire["occurrences"].as_array().unwrap();
    assert_eq!(uses.len(), 2);
    assert_eq!(uses[0]["itemIndex"], "0");
    assert_eq!(uses[1]["itemIndex"], "1");
    assert_ne!(uses[0]["contextId"], uses[1]["contextId"]);
    assert_eq!(
        uses[0]["receipts"][0]["payload"],
        uses[1]["receipts"][0]["payload"]
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_content_receipts")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(count, 2);
    tx.commit().await.unwrap();
}
#[tokio::test]
async fn sql_revocation_after_resolution_cannot_publish_a_context_or_receipt() {
    let (_temp, pool, host, capture, reference) = sql_fixture("ok").await;
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
    let source = {
        let lease = host.start_lease().await.unwrap();
        let _admission = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        let source = writer
            .attest_agent_source_tx(
                &mut tx,
                &lease,
                host.flow030(),
                &capture,
                &reference,
                "accepted",
            )
            .await
            .unwrap();
        tx.commit().await.unwrap();
        source
    };
    let cancel = CancellationToken::new();
    let (_temp, context) = context(cancel.clone(), "worker");
    let occurrence = writer
        .resolve_occurrence(&source, 0, "0".into(), context, vec![resource_use()])
        .await
        .unwrap();
    cancel.cancel();
    let lease = host.start_lease().await.unwrap();
    let _admission = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    assert!(writer
        .attest_occurrences_tx(
            &mut tx,
            &lease,
            host.flow030(),
            &source,
            &[occurrence],
            &SyntheticPolicy { deny_index: None }
        )
        .await
        .is_err());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_content_contexts")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(count, 0);
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn sql_source_rejects_foreign_ticket_and_receipt_fields_before_publishing() {
    for fault in [
        "ticket-generation",
        "ticket-identity",
        "ticket-context",
        "ticket-event",
        "receipt-owner",
        "receipt-kind",
        "receipt-output-type",
        "unauthorized-instructions",
    ] {
        let (_temp, pool, host, capture, reference) =
            sql_fixture_with_fault("ok", Some(fault)).await;
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        };
        let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
        let lease = host.start_lease().await.unwrap();
        let _admission = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        assert!(
            writer
                .attest_agent_source_tx(
                    &mut tx,
                    &lease,
                    host.flow030(),
                    &capture,
                    &reference,
                    "accepted"
                )
                .await
                .is_err(),
            "{fault}"
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(count, 0, "{fault}");
        tx.rollback().await.unwrap();
    }
}
#[tokio::test]
async fn sql_source_rejects_fenced_capture_stale_preparation_and_ambiguous_outbox() {
    for fault in [
        "owner-epoch",
        "generation",
        "revoked",
        "capture",
        "preparation",
        "producer",
        "effect-identity",
        "duplicate-effect",
    ] {
        let (_temp, pool, host, mut capture, reference) = sql_fixture("ok").await;
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        };
        let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
        let mut mutation = pool.begin().await.unwrap();
        match fault {
            "owner-epoch" => {
                sqlx::query("UPDATE engine_flow030_owners SET owner_epoch='foreign'")
                    .execute(&mut *mutation)
                    .await
                    .unwrap();
            }
            "generation" => {
                sqlx::query("UPDATE engine_flow030_owners SET generation='foreign'")
                    .execute(&mut *mutation)
                    .await
                    .unwrap();
            }
            "revoked" => {
                sqlx::query("UPDATE engine_flow030_owners SET status='revoked'")
                    .execute(&mut *mutation)
                    .await
                    .unwrap();
            }
            "capture" => capture.private_capture_json = r#"{"substituted":true}"#.into(),
            "preparation" => {
                let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
                    .fetch_one(&mut *mutation)
                    .await
                    .unwrap();
                let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
                state.preparations[0].status = "ready".into();
                sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
                    .bind(serde_json::to_string(&state).unwrap())
                    .execute(&mut *mutation)
                    .await
                    .unwrap();
            }
            "producer" | "effect-identity" | "duplicate-effect" => {
                let raw:String=sqlx::query_scalar("SELECT effect_json FROM engine_flow030_outbox WHERE effect_id='prepare-effect'").fetch_one(&mut *mutation).await.unwrap();
                let mut effect: FlowEffect030 = serde_json::from_str(&raw).unwrap();
                if fault == "producer" {
                    let FlowEffectKind030::PrepareRoute { producer, .. } = &mut effect.kind else {
                        panic!("prepare fixture")
                    };
                    producer.output_json = r#"{"text":"substituted","results":{}}"#.into();
                }
                if fault == "effect-identity" {
                    effect.identity.epoch = "foreign".into();
                }
                if fault == "duplicate-effect" {
                    effect.id = "second-effect".into();
                    sqlx::query("INSERT INTO engine_flow030_outbox VALUES ('system','run','second-effect','seed',?,'owner','pending',NULL)").bind(serde_json::to_string(&effect).unwrap()).execute(&mut *mutation).await.unwrap();
                } else {
                    sqlx::query("UPDATE engine_flow030_outbox SET effect_json=? WHERE effect_id='prepare-effect'").bind(serde_json::to_string(&effect).unwrap()).execute(&mut *mutation).await.unwrap();
                }
            }
            _ => unreachable!(),
        }
        mutation.commit().await.unwrap();
        let lease = host.start_lease().await.unwrap();
        let _admission = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        assert!(
            writer
                .attest_agent_source_tx(
                    &mut tx,
                    &lease,
                    host.flow030(),
                    &capture,
                    &reference,
                    "accepted"
                )
                .await
                .is_err(),
            "{fault}"
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(count, 0, "{fault}");
        tx.rollback().await.unwrap();
    }
}
#[tokio::test]
async fn sql_verifier_rejects_cache_substitution_and_revoked_native_context() {
    let (_temp, pool, host, capture, reference) = sql_fixture("ok").await;
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
    let source = {
        let lease = host.start_lease().await.unwrap();
        let _admission = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        let source = writer
            .attest_agent_source_tx(
                &mut tx,
                &lease,
                host.flow030(),
                &capture,
                &reference,
                "accepted",
            )
            .await
            .unwrap();
        tx.commit().await.unwrap();
        source
    };
    let (_temp, context) = context(CancellationToken::new(), "worker");
    let occurrence = writer
        .resolve_occurrence(&source, 0, "0".into(), context, vec![resource_use()])
        .await
        .unwrap();
    let lease = host.start_lease().await.unwrap();
    let _admission = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    let material = writer
        .attest_occurrences_tx(
            &mut tx,
            &lease,
            host.flow030(),
            &source,
            &[occurrence],
            &SyntheticPolicy { deny_index: None },
        )
        .await
        .unwrap();
    writer
        .verifier
        .attest_tx(&mut tx, &capture, &reference, &source.producer, &material)
        .await
        .unwrap();
    for fault in [
        "context",
        "ordinal",
        "index",
        "agent",
        "policy",
        "source-lexeme",
        "payload",
    ] {
        let mut wire: Value = serde_json::from_str(&material.content_receipts_json).unwrap();
        let occurrence = &mut wire["occurrences"][0];
        match fault {
            "context" => occurrence["contextId"] = json!("unattested-context"),
            "ordinal" => occurrence["targetOrdinal"] = json!(1),
            "index" => occurrence["itemIndex"] = json!("1"),
            "agent" => occurrence["identity"]["agent"] = json!("other"),
            "policy" => occurrence["identity"]["policyDigest"] = json!("foreign-policy"),
            "source-lexeme" => {
                occurrence["receipts"][0]["sourceJson"] =
                    json!(r#"{"value":{"n":9007199254740993,"e":1.0}}"#)
            }
            "payload" => occurrence["receipts"][0]["payload"]["json"] = json!("{}"),
            _ => unreachable!(),
        }
        let substituted = NativeRouteMaterial030 {
            source_json: material.source_json.clone(),
            content_receipts_json: wire.to_string(),
        };
        assert!(
            writer
                .verifier
                .attest_tx(
                    &mut tx,
                    &capture,
                    &reference,
                    &source.producer,
                    &substituted
                )
                .await
                .is_err(),
            "{fault}"
        );
    }
    sqlx::query("UPDATE engine_flow030_route_content_contexts SET status='revoked'")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(writer
        .verifier
        .attest_tx(&mut tx, &capture, &reference, &source.producer, &material)
        .await
        .is_err());
    tx.rollback().await.unwrap();
}
