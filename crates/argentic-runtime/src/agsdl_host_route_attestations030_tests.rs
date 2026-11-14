//! Native 11 resolution with synthetic capture/policy fixtures. No provider or
//! SQL authority is claimed by these focused transport/correlation regressions.
use super::*;
use crate::content::{ContentPayload, ContentUsage};
use crate::permissions::{
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
    sql_fixture_source(accepted_text, fault, false).await
}
async fn sql_fixture_source(
    accepted_text: &str,
    fault: Option<&str>,
    join: bool,
) -> (
    tempfile::TempDir,
    sqlx::SqlitePool,
    HostState,
    StartCapture030,
    PrepareRef030,
) {
    use crate::persistence::{
        dto::{EngineContext, EngineWork},
        flow030::{
            FlowEvent030, FlowEventKind030, PhysicalEvidence030, Preparation030, WorkRef030,
            WorkResult030,
        },
    };
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::sqlite::create_file(&temp.path().join("writer.db"))
        .await
        .unwrap();
    let (mut capture, reference) = fixture();
    plan(&mut capture, "agent", Some("worker"));
    if join {
        // Configure the synthetic capture before its immutable row is written.
        let mut plan: Value = serde_json::from_str(&capture.compiled_plan_json).unwrap();
        plan["steps"][0]["type"] = json!("join");
        plan["steps"][0]["agent"] = Value::Null;
        plan["joins"] = json!([{"address":["origin"],"scope":[],"origin":["entry"],"branches":[],"mode":"all","failures":"fail","maxFailuresJson":null,"quorumCountJson":null,"accept":[],"remaining":"stop"}]);
        capture.compiled_plan_json = plan.to_string();
    }
    let id = &capture.identity;
    let owner = EngineOwner {
        system_start_id: id.system_start_id.clone(),
        owner_epoch: "owner".into(),
    };
    let mut producer = Producer030 {
        activation_id: "producer".into(),
        step: Some(vec!["origin".into()]),
        kind: if join { "join" } else { "agent" }.into(),
        input_json: "{}".into(),
        message_json: None,
        item_json: None,
        output_json: if join {
            r#"{"outcome":"done","branches":{"left":{"text":"A","results":{"n":9007199254740993,"e":1e0}}}}"#
        } else {
            r#"{"text":"ok","results":{}}"#
        }.into(),
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
    if join {
        state.groups.push(
            serde_json::from_value(json!({
                "id":"group", "join":["origin"], "originActivationId":"source",
                "activationId":"producer", "context":[], "branches":[], "decision":"done",
                "outputJson":producer.output_json, "error":null,
                "continuation":{"kind":"join"}, "released":true
            }))
            .unwrap(),
        );
    }
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
    let mut receipt = json!({"owner":{"systemStartId":id.system_start_id,"activationId":"producer","agentInstanceId":"instance","ownerEpoch":"owner"},"decision":{"kind":"finished","outcome":"success","output":{"text":accepted_text,"resultsJson":"{}"}}});
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
        Some("intermediate") => {
            receipt["decision"]["kind"] = json!("accepted");
            receipt["decision"]
                .as_object_mut()
                .unwrap()
                .remove("outcome");
        }
        Some(
            "missing-flow"
            | "foreign-flow-work"
            | "ambiguous"
            | "missing-physical"
            | "foreign-physical-receipt"
            | "descendants-not-joined",
        ) => {}
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
    if !join {
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
        // Synthetic terminal ledger linked to the fixture's 04 decision. This
        // remains SQL-only test data, not a provider or a physical join claim.
        let terminal_id =
            crate::agsdl_host_flow030::work_terminal_event_id030(id, "accepted").unwrap();
        let terminal = FlowEvent030 {
            identity: id.clone(),
            event_id: terminal_id.clone(),
            expected_revision: "0".into(),
            kind: FlowEventKind030::WorkResult {
                work: WorkRef030 {
                    activation_id: if fault == Some("foreign-flow-work") {
                        "foreign-work"
                    } else {
                        "producer"
                    }
                    .into(),
                    start_effect_id: "start-effect".into(),
                    agent_instance_id: Some("instance".into()),
                },
                result: WorkResult030::Completed {
                    output_json: state.preparations[0].producer.output_json.clone(),
                    route_key: None,
                },
                physical: (fault != Some("missing-physical")).then(|| PhysicalEvidence030 {
                    native_receipt_id: if fault == Some("foreign-physical-receipt") {
                        "foreign"
                    } else {
                        "accepted"
                    }
                    .into(),
                    descendants_joined: fault != Some("descendants-not-joined"),
                }),
            },
        };
        if fault != Some("missing-flow") {
            sqlx::query("INSERT INTO engine_flow030_events(system_id,invocation_id,event_id,event_json,receipt_json) VALUES(?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&terminal_id)
        .bind(serde_json::to_string(&terminal).unwrap())
        .bind("{}")
        .execute(&mut *tx).await.unwrap();
        }
        if fault == Some("ambiguous") {
            // Conflicting terminal candidates are inserted initially, never by
            // rewriting a committed immutable work decision.
            sqlx::query("INSERT INTO engine_flow030_work_authorizations SELECT system_id,invocation_id,'duplicate',activation_id,input_json,provider_attempt_id,native_call_id FROM engine_flow030_work_authorizations")
            .execute(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO engine_flow030_work_events SELECT system_id,invocation_id,'duplicate',activation_id,ticket_json,decision_json FROM engine_flow030_work_events")
            .execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
    let host = crate::agsdl_host::route_attestation_test_host030(owner, "generation");
    (temp, pool, host, capture, reference)
}
// Paired positive control: the unmodified fixture must reach attestation,
// independently of the negative case's expected error code.
async fn assert_valid_source_fixture(
    pool: &sqlx::SqlitePool,
    host: &HostState,
    capture: &StartCapture030,
    reference: &PrepareRef030,
) {
    let owner = EngineOwner {
        system_start_id: capture.identity.system_start_id.clone(),
        owner_epoch: "owner".into(),
    };
    let writer = RouteAttestor030::capture(host, &owner).await.unwrap();
    let lease = host.start_lease().await.unwrap();
    let _admission = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    writer
        .attest_source_tx(&mut tx, &lease, host.flow030(), capture, reference)
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(count, 1);
    tx.rollback().await.unwrap();
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
                Err(crate::persistence::flow_store030::StoreError030::Authority)
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
        .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference,)
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
async fn sql_source_requires_one_finished_success_linked_to_the_flow_terminal() {
    for fault in [
        "intermediate",
        "missing-flow",
        "foreign-flow-work",
        "ambiguous",
        "missing-physical",
        "foreign-physical-receipt",
        "descendants-not-joined",
    ] {
        let (_valid_temp, valid_pool, valid_host, valid_capture, valid_reference) =
            sql_fixture("ok").await;
        assert_valid_source_fixture(&valid_pool, &valid_host, &valid_capture, &valid_reference)
            .await;
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
        let error = writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .err()
            .expect("non-terminal or ambiguous proof was accepted");
        assert_eq!(error.code, "AUTHORITY", "fault: {fault}");
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(count, 0, "fault: {fault}");
        tx.rollback().await.unwrap();
    }
}

#[tokio::test]
async fn sql_agent_source_readback_preserves_its_marker_and_never_reinserts_absence() {
    for committed in [true, false] {
        let (_temp, pool, host, capture, reference) = sql_fixture("ok").await;
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        };
        let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
        let lease = host.start_lease().await.unwrap();
        let _admission = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        let source = writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .unwrap();
        let marker = host.flow030().begin_route_source_commit(&source).unwrap();
        if committed {
            tx.commit().await.unwrap();
        } else {
            // A real rollback creates absence without disabling retention.
            tx.rollback().await.unwrap();
        }
        let mut tx = pool.begin().await.unwrap();
        let readback = writer
            .inspect_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .unwrap();
        assert_eq!(readback.is_some(), committed);
        if let Some(readback) = readback {
            assert_eq!(marker, readback.commit_marker().unwrap());
            assert!(!readback.is_join_source());
        }
        assert!(host.flow030().available(&capture.identity).is_err());
        assert!(writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .is_err());
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(count, if committed { 1 } else { 0 });
        assert_eq!(
            host.flow030()
                .pending_route_source_commit(&reference)
                .unwrap(),
            Some(marker)
        );
        tx.rollback().await.unwrap();
    }
}

async fn sql_join_fixture() -> (
    tempfile::TempDir,
    sqlx::SqlitePool,
    HostState,
    StartCapture030,
    PrepareRef030,
) {
    sql_fixture_source("ok", None, true).await
}

#[tokio::test]
async fn sql_join_source_uses_only_the_released_native_group_and_reads_back_its_marker() {
    for fault in [
        None,
        Some("closed"),
        Some("unreleased"),
        Some("output"),
        Some("continuation"),
    ] {
        let (_temp, pool, host, capture, reference) = sql_join_fixture().await;
        assert_valid_source_fixture(&pool, &host, &capture, &reference).await;
        if let Some(fault) = fault {
            let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
                .fetch_one(&pool)
                .await
                .unwrap();
            let mut state: Value = serde_json::from_str(&raw).unwrap();
            match fault {
                "closed" => state["groups"][0]["decision"] = json!("closed"),
                "unreleased" => state["groups"][0]["released"] = json!(false),
                "output" => state["groups"][0]["outputJson"] = json!("{}"),
                "continuation" => state["groups"][0]["continuation"] = Value::Null,
                _ => unreachable!(),
            }
            sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
                .bind(state.to_string())
                .execute(&pool)
                .await
                .unwrap();
        }
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        };
        let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
        let lease = host.start_lease().await.unwrap();
        let _admission = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        let result = writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await;
        if let Some(fault) = fault {
            assert_eq!(
                result.err().expect("unproven group accepted").code,
                "CORRELATION",
                "{fault}"
            );
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
            tx.rollback().await.unwrap();
            continue;
        }
        let source = result.unwrap();
        assert!(source.is_join_source());
        let value: Value =
            serde_json::from_str(&source.source_only_material().source_json).unwrap();
        assert_eq!(value["kind"], "join");
        assert!(value["producerAgent"].is_null());
        assert!(value["outputJson"].as_str().unwrap().contains("1e0"));
        let kind: (String, Option<String>) = sqlx::query_as(
            "SELECT receipt_kind,work_event_id FROM engine_flow030_route_source_attestations",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(kind, ("join".into(), None));
        let marker = host.flow030().begin_route_source_commit(&source).unwrap();
        tx.commit().await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let readback = writer
            .inspect_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(readback.commit_marker().unwrap(), marker);
        assert!(host.flow030().available(&capture.identity).is_err());
        tx.rollback().await.unwrap();
    }
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
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
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
    sqlx::query("CREATE TEMP TRIGGER writer_test_second_receipt BEFORE INSERT ON engine_flow030_route_content_receipts WHEN (SELECT count(*) FROM engine_flow030_route_content_receipts)=1 BEGIN SELECT RAISE(ABORT,'synthetic second receipt failure'); END")
        .execute(&mut *tx).await.unwrap();
    let error = writer
        .attest_occurrences_tx(
            &mut tx,
            &lease,
            host.flow030(),
            &source,
            &occurrences,
            &SyntheticPolicy { deny_index: None },
        )
        .await
        .err()
        .expect("second receipt insertion should fail");
    assert_eq!(error.code, "STORAGE");
    assert_eq!(error.pointer, "");
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
    assert_eq!((contexts, receipts), (0, 0));
    sqlx::query("DROP TRIGGER writer_test_second_receipt")
        .execute(&mut *tx)
        .await
        .unwrap();
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
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
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
        let (_valid_temp, valid_pool, valid_host, valid_capture, valid_reference) =
            sql_fixture("ok").await;
        assert_valid_source_fixture(&valid_pool, &valid_host, &valid_capture, &valid_reference)
            .await;
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
        let error = writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .err()
            .expect("mutated source was accepted");
        // Rejected receipts are not successful terminal candidates, so the
        // native proof lookup now rejects them before transport correlation.
        assert_eq!(error.code, "AUTHORITY", "{fault}: {}", error.message);
        assert_eq!(error.pointer, "route", "{fault}");
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
        assert_valid_source_fixture(&pool, &host, &capture, &reference).await;
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
        let error = writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .err()
            .expect("mutated source was accepted");
        let expected = if fault == "preparation" {
            "STALE_REFERENCE"
        } else {
            "CORRELATION"
        };
        assert_eq!(error.code, expected, "{fault}: {}", error.message);
        assert_eq!(error.pointer, "route", "{fault}");
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
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
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

// Synthetic SQL fixture copied from the shape of a failed opening. It is not
// a provider admission or proof that a physical agent was joined.
async fn failed_join_fixture(
    fault: Option<&str>,
) -> (
    tempfile::TempDir,
    sqlx::SqlitePool,
    HostState,
    StartCapture030,
    PrepareRef030,
    EngineOwner,
    String,
) {
    let data: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/agsdl_host_join_error030_fixture.json"
    ))
    .unwrap();
    let mut state: FlowState030 = serde_json::from_str(data["state"].as_str().unwrap()).unwrap();
    let (mut capture, _) = fixture();
    capture.identity = state.identity.clone();
    capture.compiled_plan_json = state.plan_json.clone().unwrap();
    if matches!(fault, Some("reordered" | "different-plan")) {
        let mut reordered: Value = serde_json::from_str(&capture.compiled_plan_json).unwrap();
        if fault == Some("different-plan") {
            reordered["format"] = json!("different-plan");
        }
        state.plan_json = Some(serde_json::to_string(&reordered).unwrap());
        assert_ne!(
            capture.compiled_plan_json,
            *state.plan_json.as_ref().unwrap()
        );
    }
    let index = state
        .preparations
        .iter()
        .position(|p| p.status == "pending" && p.producer.kind == "join")
        .unwrap();
    let reference = state.preparations[index].reference.clone();
    let mut producer = state.preparations[index].producer.clone();
    match fault {
        None => (),
        Some("error") => producer.output_json = r#"{"error":{"code":"FORGED","message":"Fan-out exceeds max.","details":[]}}"#.into(),
        Some("step") => producer.step = Some(vec!["foreign".into()]),
        Some("group") => state.groups.push(serde_json::from_value(json!({"id":"forged", "join":producer.step, "originActivationId":"source", "activationId":producer.activation_id, "context":[], "branches":[], "decision":"done", "outputJson":"{}", "error":null, "continuation":{"kind":"join"}, "released":true})).unwrap()),
        Some("agent") => producer.kind = "agent".into(),
        Some("activation-duplicate") => {
            let activation = state.activations.iter().find(|a| a.id == producer.activation_id).unwrap().clone();
            state.activations.push(activation);
        }
        Some("activation-physical") => {
            state.activations.iter_mut().find(|a| a.id == producer.activation_id).unwrap().physical = true;
        }
        Some("ordinal" | "duplicate" | "reordered" | "different-plan" | "not-accepted" | "receipt-absent" | "receipt-foreign" | "failure-absent" | "failure-duplicate") => (),
        _ => panic!("unknown fixture fault"),
    }
    state.preparations[index].producer = producer.clone();
    let mut effects = data["effects"].as_array().unwrap().clone();
    for row in &mut effects {
        let mut effect: FlowEffect030 =
            serde_json::from_str(row["effect_json"].as_str().unwrap()).unwrap();
        if let FlowEffectKind030::PrepareRoute {
            reference: r,
            producer: p,
        } = &mut effect.kind
        {
            *r = reference.clone();
            *p = producer.clone();
            row["effect_json"] = json!(serde_json::to_string(&effect).unwrap());
        }
    }
    if fault == Some("failure-absent") {
        effects.retain(|row| {
            !matches!(
                serde_json::from_str::<FlowEffect030>(row["effect_json"].as_str().unwrap())
                    .unwrap()
                    .kind,
                FlowEffectKind030::Failure { .. }
            )
        });
    }
    let mut native_receipt: crate::persistence::flow030::FlowReceipt030 =
        serde_json::from_str(data["event"]["receipt_json"].as_str().unwrap()).unwrap();
    if fault == Some("failure-duplicate") {
        let mut duplicate = effects
            .iter()
            .find(|row| {
                matches!(
                    serde_json::from_str::<FlowEffect030>(row["effect_json"].as_str().unwrap())
                        .unwrap()
                        .kind,
                    FlowEffectKind030::Failure { .. }
                )
            })
            .unwrap()
            .clone();
        let mut effect: FlowEffect030 =
            serde_json::from_str(duplicate["effect_json"].as_str().unwrap()).unwrap();
        effect.id = "duplicated-failure".into();
        duplicate["effect_id"] = json!(effect.id);
        duplicate["effect_json"] = json!(serde_json::to_string(&effect).unwrap());
        effects.push(duplicate);
        native_receipt.effect_ids.push("duplicated-failure".into());
        state
            .events
            .get_mut(data["event"]["event_id"].as_str().unwrap())
            .unwrap()
            .receipt = native_receipt.clone();
    }
    let temp = tempfile::tempdir().unwrap();
    let pool = crate::sqlite::create_file(&temp.path().join("join-error.db"))
        .await
        .unwrap();
    let id = &capture.identity;
    let owner = EngineOwner {
        system_start_id: id.system_start_id.clone(),
        owner_epoch: data["preparation"]["owner_epoch"].as_str().unwrap().into(),
    };
    let generation = data["preparation"]["generation"]
        .as_str()
        .unwrap()
        .to_owned();
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
        .bind("synthetic-request")
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
        .bind(&generation)
        .bind("live")
        .bind(sha(&serde_json::to_vec(&capture).unwrap()))
        .execute(&mut *tx)
        .await
        .unwrap();
    let e = &data["event"];
    sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(e["event_id"].as_str().unwrap())
        .bind(e["event_json"].as_str().unwrap())
        .bind(
            (fault != Some("not-accepted"))
                .then(|| serde_json::to_string(&native_receipt).unwrap()),
        )
        .bind((fault == Some("not-accepted")).then_some("{}"))
        .execute(&mut *tx)
        .await
        .unwrap();
    for row in &effects {
        sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind(row["effect_id"].as_str().unwrap())
            .bind(row["event_id"].as_str().unwrap())
            .bind(row["effect_json"].as_str().unwrap())
            .bind(&owner.owner_epoch)
            .bind(row["status"].as_str().unwrap())
            .bind(row["settlement_json"].as_str())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let row = &data["preparation"];
    let mut result_json: Value =
        serde_json::from_str(row["result_json"].as_str().unwrap()).unwrap();
    if fault == Some("ordinal") {
        result_json["targetOrdinal"] = json!(1);
    }
    let result_json = result_json.to_string();
    if fault == Some("duplicate") {
        sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind("duplicate-prepared")
            .bind(e["event_json"].as_str().unwrap())
            .bind(e["receipt_json"].as_str().unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    if fault != Some("receipt-absent") {
        sqlx::query("INSERT INTO engine_flow030_preparations VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind(row["prepare_id"].as_str().unwrap())
            .bind(if fault == Some("receipt-foreign") {
                "foreign-receipt"
            } else {
                row["native_receipt_id"].as_str().unwrap()
            })
            .bind(&owner.owner_epoch)
            .bind(&generation)
            .bind(row["reference_json"].as_str().unwrap())
            .bind(row["producer_json"].as_str().unwrap())
            .bind(row["source_json"].as_str().unwrap())
            .bind(row["content_receipts_json"].as_str().unwrap())
            .bind(&result_json)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), &generation);
    (temp, pool, host, capture, reference, owner, generation)
}

#[tokio::test]
async fn failed_join_source_requires_native_prepared_failure_and_reads_back_after_restart() {
    for fault in [
        None,
        Some("reordered"),
        Some("different-plan"),
        Some("error"),
        Some("step"),
        Some("group"),
        Some("ordinal"),
        Some("duplicate"),
    ] {
        let (_temp, pool, host, capture, reference, owner, generation) =
            failed_join_fixture(fault).await;
        let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
        let lease = host.start_lease().await.unwrap();
        let _guard = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        let result = writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await;
        if let Some(fault) = fault.filter(|f| *f != "reordered") {
            assert!(result.is_err(), "{fault} accepted");
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
            tx.rollback().await.unwrap();
            continue;
        }
        let source = result.unwrap();
        assert!(source.is_join_source());
        let original = source.source_only_material().source_json;
        let kind: (String, Option<String>) = sqlx::query_as(
            "SELECT receipt_kind,work_event_id FROM engine_flow030_route_source_attestations",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(kind, ("error".into(), None));
        tx.commit().await.unwrap();
        drop(_guard);
        drop(lease);
        drop(writer);
        drop(host);
        let restarted =
            crate::agsdl_host::route_attestation_test_host030(owner.clone(), &generation);
        let writer = RouteAttestor030::capture(&restarted, &owner).await.unwrap();
        let lease = restarted.start_lease().await.unwrap();
        let _guard = restarted.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        let again = writer
            .inspect_source_tx(&mut tx, &lease, restarted.flow030(), &capture, &reference)
            .await
            .unwrap()
            .unwrap();
        assert!(again.is_join_source());
        assert_eq!(again.source_only_material().source_json, original);
        tx.rollback().await.unwrap();
        // Re-run the SQL verifier independently after a contradictory group is
        // inserted into the mutable reducer snapshot. The attestation already
        // exists, so the writer cannot mask a missing read-side recheck.
        let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
            .fetch_one(&pool)
            .await
            .unwrap();
        let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
        state.groups.push(serde_json::from_value(json!({"id":"forged", "join":source.producer.step, "originActivationId":"source", "activationId":source.producer.activation_id, "context":[], "branches":[], "decision":"done", "outputJson":"{}", "error":null, "continuation":{"kind":"join"}, "released":true})).unwrap());
        sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
            .bind(serde_json::to_string(&state).unwrap())
            .execute(&pool)
            .await
            .unwrap();
        let verifier = SqlRouteMaterialVerifier030::capture(&restarted, &owner)
            .await
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        assert!(verifier
            .attest_tx(
                &mut tx,
                &capture,
                &reference,
                &source.producer,
                &source.source_only_material()
            )
            .await
            .is_err());
        tx.rollback().await.unwrap();
    }
}

#[tokio::test]
async fn agent_error_without_joined_witness_is_rejected_before_commit() {
    let (_temp, pool, host, capture, reference, owner, _) =
        failed_join_fixture(Some("agent")).await;
    let result = crate::agsdl_host_dispatch030::dispatch_source_route030(
        &host,
        &pool,
        &owner,
        &reference,
        crate::agsdl_host_dispatch030::SourceOwnership030::Join,
        &CancellationToken::new(),
    )
    .await;
    let error = result
        .err()
        .expect("agent error without ownership was accepted");
    assert_eq!(error.code, "CORRELATION");
    assert_eq!(error.message, "Route source ownership kind differs");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    assert_eq!(capture.identity, reference.identity);
}

async fn rejected_join_error_fixture(fault: &str) {
    let (_tmp, pool, host, capture, reference, owner, _) = failed_join_fixture(Some(fault)).await;
    let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
    let lease = host.start_lease().await.unwrap();
    let _gate = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    assert!(
        writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .is_err(),
        "fault {fault} was accepted"
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(count, 0);
    tx.rollback().await.unwrap();
}
macro_rules! rejected_join_error_test {
    ($name:ident, $fault:literal) => {
        #[tokio::test]
        async fn $name() {
            rejected_join_error_fixture($fault).await;
        }
    };
}
rejected_join_error_test!(join_error_rejects_unaccepted_event, "not-accepted");
rejected_join_error_test!(join_error_rejects_absent_native_receipt, "receipt-absent");
rejected_join_error_test!(join_error_rejects_foreign_native_receipt, "receipt-foreign");
rejected_join_error_test!(
    join_error_rejects_duplicated_activation,
    "activation-duplicate"
);
rejected_join_error_test!(
    join_error_rejects_physical_activation,
    "activation-physical"
);
rejected_join_error_test!(join_error_rejects_absent_failure_effect, "failure-absent");
rejected_join_error_test!(
    join_error_rejects_duplicated_failure_effect,
    "failure-duplicate"
);

#[tokio::test]
async fn join_error_independent_sql_verifier_rejects_falsified_state() {
    let (_tmp, pool, host, capture, reference, owner, _) = failed_join_fixture(None).await;
    let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
    let lease = host.start_lease().await.unwrap();
    let _gate = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    let source = writer
        .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
    state
        .activations
        .iter_mut()
        .find(|a| a.id == source.producer.activation_id)
        .unwrap()
        .physical = true;
    sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let verifier = SqlRouteMaterialVerifier030::capture(&host, &owner)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert!(verifier
        .attest_tx(
            &mut tx,
            &capture,
            &reference,
            &source.producer,
            &source.source_only_material()
        )
        .await
        .is_err());
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn source_readback_is_fenced_after_generation_retirement_for_all_kinds() {
    for kind in ["agent", "join", "join-error"] {
        let (_tmp, pool, host, capture, reference, owner, generation) = match kind {
            "agent" => {
                let (t, p, h, c, r) = sql_fixture("ok").await;
                (
                    t,
                    p,
                    h,
                    c,
                    r,
                    EngineOwner {
                        system_start_id: "system".into(),
                        owner_epoch: "owner".into(),
                    },
                    "generation".to_owned(),
                )
            }
            "join" => {
                let (t, p, h, c, r) = sql_join_fixture().await;
                (
                    t,
                    p,
                    h,
                    c,
                    r,
                    EngineOwner {
                        system_start_id: "system".into(),
                        owner_epoch: "owner".into(),
                    },
                    "generation".to_owned(),
                )
            }
            _ => failed_join_fixture(None).await,
        };
        let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
        let lease = host.start_lease().await.unwrap();
        let gate = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        let source = writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .unwrap();
        let marker = source.commit_marker().unwrap();
        tx.commit().await.unwrap();
        drop(gate);
        crate::agsdl_host_flow030::revoke_generation(&pool, &generation)
            .await
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        assert!(
            writer
                .inspect_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
                .await
                .is_err(),
            "old {kind} authority survived retirement"
        );
        tx.rollback().await.unwrap();
        let new_host = crate::agsdl_host::route_attestation_test_host030(
            owner.clone(),
            "replacement-generation",
        );
        let new_writer = RouteAttestor030::capture(&new_host, &owner).await.unwrap();
        let new_lease = new_host.start_lease().await.unwrap();
        let _new_gate = new_host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        assert!(
            new_writer
                .inspect_source_tx(
                    &mut tx,
                    &new_lease,
                    new_host.flow030(),
                    &capture,
                    &reference
                )
                .await
                .is_err(),
            "new {kind} authority read an old generation"
        );
        assert!(
            new_writer
                .attest_source_tx(
                    &mut tx,
                    &new_lease,
                    new_host.flow030(),
                    &capture,
                    &reference
                )
                .await
                .is_err(),
            "new {kind} authority recreated a source"
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_route_source_attestations")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(count, 1);
        assert_eq!(source.commit_marker().unwrap(), marker);
        tx.rollback().await.unwrap();
    }
}

#[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
#[tokio::test]
async fn call_sources_attest_normal_and_error_with_independent_sql_readback() {
    use crate::agsdl_host_calls030::{tests as calls, CallDataBroker030};
    for error in [false, true] {
        let f = calls::Fixture::new(if error {
            r#"{"type":"call","command":"never execute","parse":"json","onError":"tests"}"#
        } else {
            r#"{"type":"call","command":"never execute","next":"tests"}"#
        })
        .await;
        let broker = CallDataBroker030::default();
        let witness = calls::joined(
            &f,
            &broker,
            calls::command(0, if error { "invalid json" } else { "done" }),
        )
        .await;
        let receipt = calls::finish(&f, &broker, &witness).await;
        let owner = EngineOwner {
            system_start_id: f.id.system_start_id.clone(),
            owner_epoch: "owner".into(),
        };
        let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
        let capture_raw: String =
            sqlx::query_scalar("SELECT capture_json FROM engine_start030_requests")
                .fetch_one(&f.pool)
                .await
                .unwrap();
        let capture: StartCapture030 = serde_json::from_str(&capture_raw).unwrap();
        let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
            .fetch_one(&f.pool)
            .await
            .unwrap();
        let state: FlowState030 = serde_json::from_str(&raw).unwrap();
        let reference = state
            .preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap()
            .reference
            .clone();
        // A joined owner from another call cannot authorize a new 037 source,
        // even when both synthetic databases use the same system/work labels.
        let other = calls::Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
        let other_witness = calls::joined(
            &other,
            &CallDataBroker030::default(),
            calls::command(0, "done"),
        )
        .await;
        assert!(!receipt.matches_joined(&other_witness).unwrap());
        assert!(crate::agsdl_host_dispatch030::dispatch_source_route030(
            &host,
            &f.pool,
            &owner,
            &reference,
            crate::agsdl_host_dispatch030::SourceOwnership030::Call(&other_witness),
            &CancellationToken::new()
        )
        .await
        .is_err());
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM engine_flow030_route_source_attestations")
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
        let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
        let verifier = SqlRouteMaterialVerifier030::capture(&host, &owner)
            .await
            .unwrap();
        let lease = host.start_lease().await.unwrap();
        let _gate = host.admission_lock().lock_owned().await;
        let mut tx = f.pool.begin().await.unwrap();
        let source = writer
            .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .unwrap();
        assert!(source.ownership_kind() == SourceOwnershipKind030::Call);
        let material = source.source_only_material();
        verifier
            .attest_tx(&mut tx, &capture, &reference, source.producer(), &material)
            .await
            .unwrap();
        let readback = writer
            .inspect_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
            .await
            .unwrap()
            .unwrap();
        assert!(source.commit_marker().unwrap() == readback.commit_marker().unwrap());
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM engine_flow030_route_source_attestations")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(count, 1);
        let row = sqlx::query(
            "SELECT receipt_kind,work_event_id FROM engine_flow030_route_source_attestations",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            row.get::<&str, _>("receipt_kind"),
            if error { "error" } else { "call" }
        );
        assert!(row.get::<Option<&str>, _>("work_event_id").is_none());
        tx.commit().await.unwrap();
        drop(_gate);
        drop(lease);
        assert!(crate::agsdl_host_dispatch030::dispatch_source_route030(
            &host,
            &f.pool,
            &owner,
            &reference,
            crate::agsdl_host_dispatch030::SourceOwnership030::Call(&other_witness),
            &CancellationToken::new()
        )
        .await
        .is_err());
        assert!(host.flow030().available(&f.id).is_ok());
    }
}

#[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
#[tokio::test]
async fn failed_group_accepts_only_the_native_call_failure_receipt() {
    use crate::agsdl_host_calls030::{tests as calls, CallDataBroker030};
    let f = calls::Fixture::branch_failure().await;
    let broker = CallDataBroker030::default();
    let witness = calls::joined(&f, &broker, calls::command(0, "invalid json")).await;
    calls::finish(&f, &broker, &witness).await;
    let owner = EngineOwner {
        system_start_id: f.id.system_start_id.clone(),
        owner_epoch: "owner".into(),
    };
    let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
    let raw: String = sqlx::query_scalar("SELECT capture_json FROM engine_start030_requests")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let capture: StartCapture030 = serde_json::from_str(&raw).unwrap();
    let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let state: FlowState030 = serde_json::from_str(&raw).unwrap();
    let reference = state
        .preparations
        .iter()
        .find(|p| p.status == "pending" && p.producer.kind == "join")
        .unwrap()
        .reference
        .clone();
    let writer = RouteAttestor030::capture(&host, &owner).await.unwrap();
    let verifier = SqlRouteMaterialVerifier030::capture(&host, &owner)
        .await
        .unwrap();
    let lease = host.start_lease().await.unwrap();
    let _gate = host.admission_lock().lock_owned().await;
    let mut tx = f.pool.begin().await.unwrap();
    let source = writer
        .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, &reference)
        .await
        .unwrap();
    assert!(source.is_join_source());
    verifier
        .attest_tx(
            &mut tx,
            &capture,
            &reference,
            source.producer(),
            &source.source_only_material(),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[test]
fn composed_content_uses_only_the_effective_entry_agent_policy() {
    let (_temp, context) = context(CancellationToken::new(), "worker");
    let binding = context.binding().unwrap();
    let (mut capture, reference) = fixture();
    plan(&mut capture, "compose", None);
    let mut value: Value = serde_json::from_str(&capture.compiled_plan_json).unwrap();
    let mut entry = value["steps"][0].clone();
    entry["address"] = json!(["target", "inner", "work"]);
    value["steps"].as_array_mut().unwrap().push(entry);
    let mut inner = value["steps"][1].clone();
    inner["address"] = json!(["target", "inner"]);
    value["steps"].as_array_mut().unwrap().push(inner);
    value["scopes"] = json!([
        {"address":["target"],"parent":[],"composition":"outer","entry":["target","inner"],"outputs":["done"],"agents":{}},
        {"address":["target","inner"],"parent":["target"],"composition":"inner","entry":["target","inner","work"],"outputs":["done"],"agents":{}}
    ]);
    capture.compiled_plan_json = value.to_string();
    assert_eq!(
        validate_recipient(&capture, &reference, 0, &binding).unwrap(),
        (vec!["target".into()], "worker".into())
    );
    value["steps"][2]["agent"] = json!("other");
    capture.compiled_plan_json = value.to_string();
    assert!(validate_recipient(&capture, &reference, 0, &binding).is_err());
    value["scopes"][1]["entry"] = json!(["target"]);
    capture.compiled_plan_json = value.to_string();
    assert!(validate_recipient(&capture, &reference, 0, &binding).is_err());
}
