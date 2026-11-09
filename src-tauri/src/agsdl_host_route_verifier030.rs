//! Read-only verification of native 04/11 attestations for route preparation.
//! These tables have native-only writers. Helper/model JSON cannot create an
//! attestation; a digest checks correlation and is never a permission grant.
use crate::agsdl_content::{ContentPayload, ResolvedContentReceipt};
use crate::agsdl_host::HostState;
use crate::agsdl_host_flow030::{
    work_terminal_event_id030, NativeRouteMaterial030, RouteMaterialVerifier030,
};
use crate::db::agsdl_execution::{
    dto::{EngineContext, EngineOwner},
    flow030::{
        Continuation030, FlowEffect030, FlowEffectKind030, FlowEvent030, FlowEventKind030,
        FlowPlan030, FlowState030, PhysicalEvidence030, PrepareRef030, PreparedResult030,
        Producer030, Target030, WorkResult030,
    },
    flow_store030::{CheckFuture, StoreError030},
    start030::StartCapture030,
    Result,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeSet;

#[path = "agsdl_host_path_failure030.rs"]
mod path_failure;
use path_failure::{verify_preparation_origin_tx, verify_reduced_failure_tx, PathFailureOrigin030};

type Verified<T> = std::result::Result<T, StoreError030>;
fn require(value: bool) -> Verified<()> {
    if value {
        Ok(())
    } else {
        Err(StoreError030::Authority)
    }
}
pub(crate) fn same_flow_plan030(retained: &str, captured: &str) -> serde_json::Result<bool> {
    Ok(serde_json::from_str::<FlowPlan030>(retained)?
        == serde_json::from_str::<FlowPlan030>(captured)?)
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn string<'a>(value: &'a Value, key: &str) -> Verified<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(StoreError030::Authority)
}
fn exact(left: &str, right: &str) -> Verified<bool> {
    crate::db::agsdl_execution::json_lexemes030::document_tokens_equal(left, right)
        .map_err(|_| StoreError030::Authority)
}

/// Keep accepted numeric lexemes verbatim rather than decoding/re-encoding them.
pub(crate) fn accepted_output_json(output: &Value) -> Verified<String> {
    #[derive(Serialize)]
    struct Output<'a> {
        text: &'a str,
        results: &'a RawValue,
        #[serde(skip_serializing_if = "Option::is_none")]
        choice: Option<&'a Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<&'a Value>,
    }
    let results = string(output, "resultsJson")?;
    crate::db::exact_json::validate(results)?;
    let results: Box<RawValue> = serde_json::from_str(results)?;
    require(results.get().starts_with('{'))?;
    let choice = output.get("choice").filter(|v| !v.is_null());
    require(choice.is_none_or(Value::is_string))?;
    let instructions = output.get("instructions").filter(|v| !v.is_null());
    require(instructions.is_none_or(|v| {
        v.is_string()
            || v.as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
    }))?;
    Ok(serde_json::to_string(&Output {
        text: string(output, "text")?,
        results: &results,
        choice,
        instructions,
    })?)
}

fn content_identity(identity: &Value) -> Verified<()> {
    let fields = ["captureId", "sourceDigest", "agent", "policyDigest"];
    require(
        identity
            .as_object()
            .is_some_and(|o| o.len() == fields.len()),
    )?;
    for field in fields {
        require(!string(identity, field)?.is_empty())?;
    }
    Ok(())
}
fn value_equal(left: &Value, right: &Value) -> Verified<bool> {
    exact(
        &serde_json::to_string(left)?,
        &serde_json::to_string(right)?,
    )
}

/// Created from a current native lease, never Deserialize/IPC. The facade also
/// checks its own current lease and admission transaction at both boundaries.
pub(crate) struct SqlRouteMaterialVerifier030 {
    owner: EngineOwner,
    generation: String,
}
impl SqlRouteMaterialVerifier030 {
    pub(crate) async fn capture(host: &HostState, owner: &EngineOwner) -> Result<Self> {
        let lease = host.start_lease().await?;
        if lease.owner(&owner.system_start_id)? != *owner {
            return Err(crate::db::agsdl_execution::failure(
                "CORRELATION",
                "route",
                "Foreign route owner",
            ));
        }
        Ok(Self {
            owner: owner.clone(),
            generation: lease.generation().into(),
        })
    }

    async fn verify(
        &self,
        db: &mut SqliteConnection,
        capture: &StartCapture030,
        reference: &PrepareRef030,
        producer: &Producer030,
        material: &NativeRouteMaterial030,
    ) -> Verified<()> {
        let id = &capture.identity;
        require(reference.identity == *id && self.owner.system_start_id == id.system_start_id)?;
        let capture_sha = sha(&serde_json::to_vec(capture)?);
        let row = sqlx::query("SELECT owner_epoch,generation,status,capture_sha256 FROM engine_flow030_owners WHERE system_id=? AND invocation_id=? AND snapshot_id=? AND capture_epoch=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&id.snapshot_id).bind(&id.epoch).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
        require(
            row.get::<&str, _>("owner_epoch") == self.owner.owner_epoch
                && row.get::<&str, _>("generation") == self.generation
                && row.get::<&str, _>("status") == "live"
                && row.get::<&str, _>("capture_sha256") == capture_sha,
        )?;
        for text in [&material.source_json, &material.content_receipts_json] {
            crate::db::exact_json::validate(text)?;
        }
        let source: Value = serde_json::from_str(&material.source_json)?;
        require(
            string(&source, "terminalId")? == producer.activation_id
                && string(&source, "outputJson")? == producer.output_json
                && source.get("producerStep") == Some(&serde_json::to_value(&producer.step)?),
        )?;
        let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
        let row = sqlx::query("SELECT preparation_effect_id,owner_epoch,generation,capture_sha256,native_receipt_id,receipt_kind,work_event_id,producer_json,source_json FROM engine_flow030_route_source_attestations WHERE system_id=? AND invocation_id=? AND prepare_id=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&reference.prepare_id).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
        require(
            row.get::<&str, _>("owner_epoch") == self.owner.owner_epoch
                && row.get::<&str, _>("generation") == self.generation
                && row.get::<&str, _>("capture_sha256") == capture_sha
                && !row.get::<&str, _>("native_receipt_id").is_empty(),
        )?;
        require(
            serde_json::from_str::<Producer030>(row.get("producer_json"))? == *producer
                && exact(row.get("source_json"), &material.source_json)?,
        )?;
        let encoded: String = sqlx::query_scalar("SELECT effect_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(row.get::<&str,_>("preparation_effect_id")).bind(&self.owner.owner_epoch).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
        let effect: FlowEffect030 = serde_json::from_str(&encoded)?;
        require(
            effect.identity == *id
                && matches!(&effect.kind, FlowEffectKind030::PrepareRoute { reference: r, producer: p } if r == reference && p == producer),
        )?;
        let kind = if reference.route.kind == "error" {
            "error"
        } else {
            match producer.kind.as_str() {
                "agent" => "agentWork",
                "join" => "join",
                _ => return Err(StoreError030::Authority),
            }
        };
        require(
            row.get::<&str, _>("receipt_kind") == kind
                && string(&source, "kind")?
                    == if kind == "error" {
                        "error"
                    } else {
                        producer.kind.as_str()
                    },
        )?;
        if kind == "agentWork" {
            let event_id: &str = row
                .get::<Option<&str>, _>("work_event_id")
                .ok_or(StoreError030::Authority)?;
            verify_accepted_work(
                db,
                capture,
                producer,
                &source,
                event_id,
                &self.owner,
                &self.generation,
            )
            .await?;
        } else {
            require(
                row.get::<Option<&str>, _>("work_event_id").is_none()
                    && source.get("producerAgent") == Some(&Value::Null)
                    && source.pointer("/provenance/instructions") == Some(&json!([])),
            )?;
            if kind == "join" {
                verify_join_source(db, capture, producer).await?;
            } else if kind == "error" && producer.kind == "join" {
                verify_join_error_source_tx(
                    db,
                    capture,
                    reference,
                    producer,
                    &self.owner,
                    &self.generation,
                )
                .await?;
            } else if kind == "error" {
                require(producer.kind == "agent")?;
            }
        }
        verify_content(
            db,
            capture,
            reference,
            &plan,
            &material.content_receipts_json,
            &self.owner,
            &self.generation,
            &capture_sha,
        )
        .await
    }
}
impl RouteMaterialVerifier030 for SqlRouteMaterialVerifier030 {
    fn attest_tx<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        capture: &'a StartCapture030,
        reference: &'a PrepareRef030,
        producer: &'a Producer030,
        material: &'a NativeRouteMaterial030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            self.verify(db, capture, reference, producer, material)
                .await
        })
    }
}

/// Select the unique successful terminal, never an intermediate acceptance.
/// The durable Flow result must be the result of that same native 04 event.
pub(crate) async fn unique_agent_work_event_tx(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    producer: &Producer030,
) -> Verified<String> {
    let id = &capture.identity;
    let rows = sqlx::query("SELECT event_id,decision_json FROM engine_flow030_work_events WHERE system_id=? AND invocation_id=? AND activation_id=? AND decision_json IS NOT NULL")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&producer.activation_id)
        .fetch_all(&mut *db)
        .await?;
    let mut terminals = Vec::new();
    for row in rows {
        let decision: Value = serde_json::from_str(row.get("decision_json"))?;
        let receipt: Value = serde_json::from_str(string(&decision, "receiptJson")?)?;
        let decision = receipt.get("decision").ok_or(StoreError030::Authority)?;
        if decision.get("kind").and_then(Value::as_str) == Some("finished")
            && decision.get("outcome").and_then(Value::as_str) == Some("success")
        {
            terminals.push(row.get::<String, _>("event_id"));
        }
    }
    require(terminals.len() == 1)?;
    let event_id = terminals.remove(0);
    let terminal_id =
        work_terminal_event_id030(id, &event_id).map_err(|_| StoreError030::Authority)?;
    let row = sqlx::query("SELECT f.event_json,a.context_json,a.start_effect_id FROM engine_flow030_events f JOIN engine_flow030_work_admissions a ON a.system_id=f.system_id AND a.invocation_id=f.invocation_id AND a.activation_id=? WHERE f.system_id=? AND f.invocation_id=? AND f.event_id=? AND f.receipt_json IS NOT NULL AND f.diagnostic_json IS NULL")
        .bind(&producer.activation_id)
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&terminal_id)
        .fetch_optional(&mut *db)
        .await?
        .ok_or(StoreError030::Authority)?;
    let context: EngineContext = serde_json::from_str(row.get("context_json"))?;
    let event: Value = serde_json::from_str(row.get("event_json"))?;
    let result = event
        .pointer("/kind/WorkResult")
        .ok_or(StoreError030::Authority)?;
    require(
        event.get("identity") == Some(&serde_json::to_value(id)?)
            && event.get("eventId").and_then(Value::as_str) == Some(terminal_id.as_str())
            && context.work.system_start_id == id.system_start_id
            && context.work.flow_invocation_id == id.flow_invocation_id
            && context.work.activation_id == producer.activation_id
            && context.work.step == producer.step
            && result.get("work")
                == Some(&json!({
                    "activationId": producer.activation_id,
                    "startEffectId": row.get::<&str, _>("start_effect_id"),
                    "agentInstanceId": context.work.agent_instance_id,
                }))
            && result.get("physical")
                == Some(&serde_json::to_value(PhysicalEvidence030 {
                    native_receipt_id: event_id.clone(),
                    descendants_joined: true,
                })?),
    )?;
    let output = result
        .pointer("/result/Completed/output_json")
        .and_then(Value::as_str)
        .ok_or(StoreError030::Authority)?;
    require(exact(output, &producer.output_json)?)?;
    Ok(event_id)
}

/// Re-read the accepted native preparation and its reducer effects. A join
/// allocated for a failed opening has no group and no agent-owned future.
pub(crate) async fn verify_join_error_source_tx(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    reference: &PrepareRef030,
    producer: &Producer030,
    owner: &EngineOwner,
    generation: &str,
) -> Verified<()> {
    let id = &capture.identity;
    require(
        reference.identity == *id && reference.route.kind == "error" && producer.kind == "join",
    )?;
    let address = producer.step.as_ref().ok_or(StoreError030::Authority)?;
    require(
        reference.activation_id == producer.activation_id && reference.route.source == *address,
    )?;
    let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=? AND snapshot_id=? AND epoch=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&id.snapshot_id).bind(&id.epoch)
        .fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
    let state: FlowState030 = serde_json::from_str(&raw)?;
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
    require(state.identity == *id)?;
    let retained = state.plan_json.as_deref().ok_or(StoreError030::Authority)?;
    require(same_flow_plan030(retained, &capture.compiled_plan_json)?)?;
    if state
        .groups
        .iter()
        .any(|group| group.activation_id == producer.activation_id)
    {
        return verify_failed_group_source_tx(
            db, capture, reference, producer, owner, generation, &state, &plan,
        )
        .await;
    }
    let activations = state
        .activations
        .iter()
        .filter(|a| a.id == producer.activation_id)
        .collect::<Vec<_>>();
    require(
        activations.len() == 1
            && activations[0].step.as_ref() == Some(address)
            && activations[0].phase == "preparing"
            && !activations[0].physical
            && activations[0].context == reference.context
            && state
                .groups
                .iter()
                .all(|g| g.activation_id != producer.activation_id),
    )?;
    require(
        plan.steps
            .iter()
            .filter(|s| s.address == *address && s.r#type == "join")
            .count()
            == 1
            && plan.steps.iter().filter(|s| s.address == *address).count() == 1,
    )?;
    let joins = plan
        .joins
        .iter()
        .filter(|j| j.address == *address)
        .collect::<Vec<_>>();
    require(joins.len() == 1)?;
    let output: Value = serde_json::from_str(&producer.output_json)?;
    require(
        output
            .as_object()
            .is_some_and(|o| o.len() == 1 && o.contains_key("error")),
    )?;
    let output_error = crate::db::exact_json::at_path(&producer.output_json, &["error"])?
        .ok_or(StoreError030::Authority)?;
    let pending = sqlx::query("SELECT event_id,effect_id,effect_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND owner_epoch=? AND status='pending'")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&owner.owner_epoch).fetch_all(&mut *db).await?;
    let mut effects = Vec::new();
    for row in pending {
        let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
        if effect.identity == *id
            && matches!(&effect.kind, FlowEffectKind030::PrepareRoute { reference:r, producer:p } if r == reference && p == producer)
        {
            require(effect.id == row.get::<&str, _>("effect_id"))?;
            effects.push((row.get::<String, _>("event_id"), effect.id));
        }
    }
    require(effects.len() == 1)?;
    let (source_event, effect_id) = &effects[0];
    let rows = sqlx::query("SELECT event_id,event_json,receipt_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND receipt_json IS NOT NULL AND diagnostic_json IS NULL")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *db).await?;
    let mut matches = Vec::new();
    for row in rows {
        let event_json: &str = row.get("event_json");
        let Some(error) = crate::db::exact_json::at_path(
            event_json,
            &["kind", "Prepared", "result", "Failed", "error"],
        )?
        else {
            continue;
        };
        if !exact(error.get(), output_error.get())? {
            continue;
        }
        let event: Value = serde_json::from_str(event_json)?;
        if event.get("identity") != Some(&serde_json::to_value(id)?) {
            continue;
        }
        matches.push((
            row.get::<String, _>("event_id"),
            event_json.to_owned(),
            row.get::<String, _>("receipt_json"),
            event,
        ));
    }
    require(matches.len() == 1)?;
    let (event_id, event_json, receipt_json, event) = &matches[0];
    let receipt: crate::db::agsdl_execution::flow030::FlowReceipt030 =
        serde_json::from_str(receipt_json)?;
    require(
        event_id == source_event
            && event.get("eventId").and_then(Value::as_str) == Some(event_id)
            && receipt.event_id == *event_id
            && receipt.revision == reference.revision
            && receipt
                .effect_ids
                .iter()
                .filter(|v| *v == effect_id)
                .count()
                == 1,
    )?;
    let record = state.events.get(event_id).ok_or(StoreError030::Authority)?;
    require(record.event_json == *event_json && record.receipt == receipt)?;
    let prepared = event
        .pointer("/kind/Prepared")
        .ok_or(StoreError030::Authority)?;
    let previous: PrepareRef030 = serde_json::from_value(
        prepared
            .get("reference")
            .cloned()
            .ok_or(StoreError030::Authority)?,
    )?;
    let native_receipt = string(prepared, "native_receipt_id")?;
    let failed = prepared
        .pointer("/result/Failed")
        .ok_or(StoreError030::Authority)?;
    let ordinal = usize::try_from(
        failed
            .get("target_ordinal")
            .and_then(Value::as_u64)
            .ok_or(StoreError030::Authority)?,
    )
    .map_err(|_| StoreError030::Authority)?;
    require(
        previous.identity == *id
            && !native_receipt.is_empty()
            && state.preparation_receipts.get(native_receipt) == Some(&previous.prepare_id)
            && state
                .preparations
                .iter()
                .filter(|p| p.reference == previous && p.status == "consumed")
                .count()
                == 1,
    )?;
    let routes = plan
        .routes
        .iter()
        .filter(|r| {
            r.source == previous.route.source
                && r.kind == previous.route.kind
                && r.key == previous.route.key
        })
        .collect::<Vec<_>>();
    require(routes.len() == 1 && joins[0].origin == previous.route.source)?;
    let target = routes[0]
        .targets
        .get(ordinal)
        .ok_or(StoreError030::Authority)?;
    require(
        matches!(target, Target030::Step {address, ..} if joins[0].branches.iter().any(|b| b.target == *address)),
    )?;
    let prep = sqlx::query("SELECT reference_json,result_json FROM engine_flow030_preparations WHERE system_id=? AND invocation_id=? AND prepare_id=? AND native_receipt_id=? AND owner_epoch=? AND generation=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&previous.prepare_id).bind(native_receipt).bind(&owner.owner_epoch).bind(generation)
        .fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
    require(serde_json::from_str::<PrepareRef030>(prep.get("reference_json"))? == previous)?;
    let result_json: &str = prep.get("result_json");
    let result: Value = serde_json::from_str(result_json)?;
    let result_error =
        crate::db::exact_json::at_path(result_json, &["error"])?.ok_or(StoreError030::Authority)?;
    require(
        result.get("kind").and_then(Value::as_str) == Some("failed")
            && result.get("targetOrdinal").and_then(Value::as_u64) == Some(ordinal as u64)
            && exact(result_error.get(), output_error.get())?,
    )?;
    let rows = sqlx::query("SELECT effect_id,effect_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND event_id=? AND owner_epoch=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(event_id).bind(&owner.owner_epoch).fetch_all(&mut *db).await?;
    let mut failures = 0;
    for row in rows {
        let effect_json: &str = row.get("effect_json");
        let effect: FlowEffect030 = serde_json::from_str(effect_json)?;
        if let FlowEffectKind030::Failure {
            activation_id,
            step,
            counted,
            ..
        } = &effect.kind
        {
            if activation_id == &producer.activation_id && step == &producer.step && *counted {
                let error = crate::db::exact_json::at_path(effect_json, &["kind", "error"])?
                    .ok_or(StoreError030::Authority)?;
                require(
                    effect.identity == *id
                        && effect.id == row.get::<&str, _>("effect_id")
                        && receipt
                            .effect_ids
                            .iter()
                            .filter(|v| *v == &effect.id)
                            .count()
                            == 1
                        && exact(error.get(), output_error.get())?,
                )?;
                failures += 1;
            }
        }
    }
    require(failures == 1)
}

/// Read the join failure and its accepted receipt independently of the source writer.
async fn verify_join_failure_effect_tx(
    db: &mut SqliteConnection,
    id: &crate::db::agsdl_execution::flow030::FlowIdentity030,
    owner: &EngineOwner,
    producer: &Producer030,
    error: &crate::db::agsdl_execution::flow030::Failure030,
    state: &FlowState030,
) -> Verified<i64> {
    // The join's own Failure is a distinct durable effect. It may precede
    // the event that releases the group, but must have one accepted receipt.
    let rows = sqlx::query("SELECT o.effect_id,o.effect_json,o.event_id,e.rowid AS event_rowid,e.event_json,e.receipt_json,e.diagnostic_json FROM engine_flow030_outbox o LEFT JOIN engine_flow030_events e ON e.system_id=o.system_id AND e.invocation_id=o.invocation_id AND e.event_id=o.event_id WHERE o.system_id=? AND o.invocation_id=? AND o.owner_epoch=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&owner.owner_epoch).fetch_all(&mut *db).await?;
    let mut join_failures = 0;
    let mut join_failure_rowid = None;
    for row in rows {
        let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
        if let FlowEffectKind030::Failure {
            activation_id,
            step,
            error: effect_error,
            counted,
        } = &effect.kind
        {
            if activation_id == &producer.activation_id && step == &producer.step {
                join_failures += 1;
                let event_id: &str = row.get("event_id");
                let event_json: &str = row
                    .try_get::<Option<&str>, _>("event_json")?
                    .ok_or(StoreError030::Authority)?;
                let receipt_json: &str = row
                    .try_get::<Option<&str>, _>("receipt_json")?
                    .ok_or(StoreError030::Authority)?;
                let receipt: crate::db::agsdl_execution::flow030::FlowReceipt030 =
                    serde_json::from_str(receipt_json)?;
                let event: Value = serde_json::from_str(event_json)?;
                let record = state.events.get(event_id).ok_or(StoreError030::Authority)?;
                require(
                    *counted
                        && effect.identity == *id
                        && effect.id == row.get::<&str, _>("effect_id")
                        && effect_error == error
                        && row.try_get::<Option<&str>, _>("diagnostic_json")?.is_none()
                        && event.get("identity") == Some(&serde_json::to_value(id)?)
                        && event.get("eventId").and_then(Value::as_str) == Some(event_id)
                        && receipt.event_id == event_id
                        && receipt
                            .effect_ids
                            .iter()
                            .filter(|v| *v == &effect.id)
                            .count()
                            == 1
                        && record.event_json == event_json
                        && record.receipt == receipt,
                )?;
                join_failure_rowid = row.try_get::<Option<i64>, _>("event_rowid")?;
            }
        }
    }
    require(join_failures == 1)?;
    join_failure_rowid.ok_or(StoreError030::Authority)
}

fn failed_group_paths<'a>(
    group: &'a crate::db::agsdl_execution::flow030::Group030,
    state: &'a FlowState030,
) -> Verified<
    Vec<(
        &'a crate::db::agsdl_execution::flow030::Path030,
        &'a crate::db::agsdl_execution::flow030::Membership030,
    )>,
> {
    let mut failed_paths = Vec::new();
    let mut failed_path_ids = std::collections::HashSet::new();
    for branch_state in &group.branches {
        for path_id in &branch_state.path_ids {
            let paths = state
                .paths
                .iter()
                .filter(|p| p.id == *path_id)
                .collect::<Vec<_>>();
            require(paths.len() == 1)?;
            let members = paths[0]
                .memberships
                .iter()
                .filter(|m| m.group_id == group.id && m.branch == branch_state.name)
                .collect::<Vec<_>>();
            require(members.len() == 1)?;
            if members[0].failed {
                require(failed_path_ids.insert(path_id))?;
                failed_paths.push((paths[0], members[0]));
            }
        }
    }
    Ok(failed_paths)
}

/// A local error route handles the failure before it can end a branch.
fn has_local_error_handler(plan: &FlowPlan030, step: &Option<Vec<String>>) -> bool {
    step.as_ref().is_some_and(|address| {
        plan.routes
            .iter()
            .any(|route| route.source == *address && route.kind == "error" && !route.inherited)
    })
}

/// The call lifecycle's native authority and commit fence are not wired here.
/// Until the calls wave supplies them, a call failure is refused as AUTHORITY.
fn reject_unintegrated_call(plan: &FlowPlan030, step: &Option<Vec<String>>) -> Verified<()> {
    let Some(address) = step else {
        return Err(StoreError030::Authority);
    };
    let mut matches = plan.steps.iter().filter(|item| item.address == *address);
    let item = matches.next().ok_or(StoreError030::Authority)?;
    require(matches.next().is_none() && item.r#type != "call")
}

/// An already-opened join failure is anchored to its immutable group and to the
/// accepted branch failure that crossed its configured threshold. The later
/// release event may be a different physical-end event.
async fn verify_failed_group_source_tx(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    reference: &PrepareRef030,
    producer: &Producer030,
    owner: &EngineOwner,
    generation: &str,
    state: &FlowState030,
    plan: &FlowPlan030,
) -> Verified<()> {
    require(
        state
            .activations
            .iter()
            .filter(|a| {
                a.id == producer.activation_id
                    && a.phase == "preparing"
                    && a.context == reference.context
            })
            .count()
            == 1,
    )?;
    let id = &capture.identity;
    let pending = sqlx::query("SELECT effect_id,event_id,effect_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND owner_epoch=? AND status='pending'")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&owner.owner_epoch).fetch_all(&mut *db).await?;
    let mut source_effects = Vec::new();
    for row in pending {
        let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
        if effect.identity == *id
            && matches!(&effect.kind, FlowEffectKind030::PrepareRoute {reference:r,producer:p} if r == reference && p == producer)
        {
            require(effect.id == row.get::<&str, _>("effect_id"))?;
            source_effects.push((row.get::<String, _>("event_id"), effect.id));
        }
    }
    require(source_effects.len() == 1)?;
    let release = sqlx::query("SELECT rowid,event_json,receipt_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=? AND receipt_json IS NOT NULL AND diagnostic_json IS NULL")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&source_effects[0].0).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
    let release_event: Value = serde_json::from_str(release.get("event_json"))?;
    let release_receipt: crate::db::agsdl_execution::flow030::FlowReceipt030 =
        serde_json::from_str(release.get("receipt_json"))?;
    require(
        release_event.get("identity") == Some(&serde_json::to_value(id)?)
            && release_receipt.event_id == source_effects[0].0
            && release_receipt.revision == reference.revision
            && release_receipt
                .effect_ids
                .iter()
                .filter(|v| *v == &source_effects[0].1)
                .count()
                == 1,
    )?;
    let release_record = state
        .events
        .get(&source_effects[0].0)
        .ok_or(StoreError030::Authority)?;
    require(
        release_record.event_json == release.get::<&str, _>("event_json")
            && release_record.receipt == release_receipt,
    )?;
    let rowid =
        verify_failed_group_tx(db, capture, producer, owner, generation, state, plan, 0).await?;
    require(rowid == release.get::<i64, _>("rowid"))
}

// Bound native proof recursion independently of authored nesting and SQL data.
const MAX_FAILURE_PROOF_DEPTH030: usize = 16;

fn verify_failed_group_tx<'a>(
    db: &'a mut SqliteConnection,
    capture: &'a StartCapture030,
    producer: &'a Producer030,
    owner: &'a EngineOwner,
    generation: &'a str,
    state: &'a FlowState030,
    plan: &'a FlowPlan030,
    depth: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Verified<i64>> + Send + 'a>> {
    Box::pin(async move {
        require(depth < MAX_FAILURE_PROOF_DEPTH030)?;
        let id = &capture.identity;
        let groups = state
            .groups
            .iter()
            .filter(|g| g.activation_id == producer.activation_id)
            .collect::<Vec<_>>();
        require(groups.len() == 1)?;
        let group = groups[0];
        let address = producer.step.as_ref().ok_or(StoreError030::Authority)?;
        require(
            group.join == *address
                && group.released
                && group.decision.as_deref() == Some("failed")
                && matches!(group.continuation, Some(Continuation030::Join))
                && group.output_json.is_none(),
        )?;
        let activations = state
            .activations
            .iter()
            .filter(|a| a.id == group.activation_id)
            .collect::<Vec<_>>();
        require(
            activations.len() == 1
                && activations[0].step.as_ref() == Some(address)
                && matches!(activations[0].phase.as_str(), "preparing" | "done")
                && !activations[0].physical
                && activations[0].context == group.context,
        )?;
        require(
            plan.steps.iter().filter(|s| s.address == *address).count() == 1
                && plan
                    .steps
                    .iter()
                    .filter(|s| s.address == *address && s.r#type == "join")
                    .count()
                    == 1,
        )?;
        let joins = plan
            .joins
            .iter()
            .filter(|j| j.address == *address)
            .collect::<Vec<_>>();
        require(joins.len() == 1 && joins[0].mode == "all")?;
        let error = group.error.as_ref().ok_or(StoreError030::Authority)?;
        require(error.code == "BRANCH_FAILED" && error.message == "BRANCH_FAILED")?;
        let output = json!({"error":error});
        require(exact(
            &producer.output_json,
            &serde_json::to_string(&output)?,
        )?)?;
        let details = error.details.as_array().ok_or(StoreError030::Authority)?;
        require(details.len() == 1 && details[0].as_object().is_some_and(|m| m.len() == 2))?;
        let branch = string(&details[0], "branch")?;
        let cause = details[0].get("error").ok_or(StoreError030::Authority)?;
        let failed_paths = failed_group_paths(group, state)?;
        require(
            !failed_paths.is_empty()
                && (joins[0].failures == "fail"
                    || joins[0].max_failures_json.as_ref().is_some_and(|raw| {
                        crate::db::agsdl_execution::flow030::number::Limit::parse(raw).is_some()
                            && crate::db::agsdl_execution::flow030::number::exceeds(
                                &failed_paths.len().to_string(),
                                &joins[0].max_failures_json,
                            )
                    })),
        )?;
        let join_failure_rowid =
            verify_join_failure_effect_tx(db, id, owner, producer, error, state).await?;
        let mut trigger: Option<(i64, usize, String, Value)> = None;
        for (path, membership) in failed_paths {
            let expected = membership
                .result_json
                .as_ref()
                .ok_or(StoreError030::Authority)?;
            let result: Value = serde_json::from_str(expected)?;
            require(result.get("ended").and_then(Value::as_str) == Some("failed"))?;
            let path_error = result.get("error").ok_or(StoreError030::Authority)?;
            let rows = sqlx::query("SELECT o.effect_id,o.effect_json,e.rowid,e.event_json,e.receipt_json FROM engine_flow030_outbox o JOIN engine_flow030_events e ON e.system_id=o.system_id AND e.invocation_id=o.invocation_id AND e.event_id=o.event_id WHERE o.system_id=? AND o.invocation_id=? AND o.owner_epoch=? AND e.receipt_json IS NOT NULL AND e.diagnostic_json IS NULL")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&owner.owner_epoch).fetch_all(&mut *db).await?;
            let mut found = Vec::new();
            for row in rows {
                let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
                let FlowEffectKind030::Failure {
                    activation_id,
                    step,
                    error,
                    counted: true,
                } = &effect.kind
                else {
                    continue;
                };
                if has_local_error_handler(plan, step) {
                    continue;
                }
                let acts = state.activations.iter().filter(|a| a.id == *activation_id && a.step == *step && a.context.iter().any(|f| matches!(f, crate::db::agsdl_execution::flow030::Frame030::Path {path_id,..} if path_id == &path.id))).collect::<Vec<_>>();
                if acts.len() != 1 || serde_json::to_value(error)? != *path_error {
                    continue;
                }
                reject_unintegrated_call(plan, step)?;
                let event: Value = serde_json::from_str(row.get("event_json"))?;
                let receipt: crate::db::agsdl_execution::flow030::FlowReceipt030 =
                    serde_json::from_str(row.get("receipt_json"))?;
                let event_id = event
                    .get("eventId")
                    .and_then(Value::as_str)
                    .ok_or(StoreError030::Authority)?;
                require(
                    event.get("identity") == Some(&serde_json::to_value(id)?)
                        && effect.identity == *id
                        && effect.id == row.get::<&str, _>("effect_id")
                        && receipt.event_id == event_id
                        && receipt
                            .effect_ids
                            .iter()
                            .filter(|v| *v == &effect.id)
                            .count()
                            == 1,
                )?;
                let record = state.events.get(event_id).ok_or(StoreError030::Authority)?;
                require(
                    record.event_json == row.get::<&str, _>("event_json")
                        && record.receipt == receipt,
                )?;
                // Only the nearest path may consume this failure. A nested branch's
                // failure must first be attested through its own join.
                require(
                    acts[0].context.iter().rev().find_map(|frame| match frame {
                        crate::db::agsdl_execution::flow030::Frame030::Path { path_id, .. } => {
                            Some(path_id)
                        }
                        _ => None,
                    }) == Some(&path.id),
                )?;
                let origin = PathFailureOrigin030::derive(&event, acts[0], state, error)?;
                match origin {
                    PathFailureOrigin030::AgentWork => {
                        require(
                            event.pointer("/kind/WorkResult/result/Failed/error")
                                == Some(path_error),
                        )?;
                        verify_preparation_origin_tx(db, capture, owner, generation, &event, state)
                            .await?;
                    }
                    PathFailureOrigin030::FailedJoin => {
                        let nested = Producer030 {
                            activation_id: activation_id.clone(),
                            step: step.clone(),
                            kind: "join".into(),
                            input_json: acts[0].input_json.clone(),
                            message_json: acts[0].message_json.clone(),
                            item_json: acts[0].item_json.clone(),
                            output_json: json!({"error":error}).to_string(),
                        };
                        let nested_rowid = verify_failed_group_tx(
                            db,
                            capture,
                            &nested,
                            owner,
                            generation,
                            state,
                            plan,
                            depth + 1,
                        )
                        .await?;
                        require(nested_rowid == row.get::<i64, _>("rowid"))?;
                    }
                    PathFailureOrigin030::PreparedFailure
                    | PathFailureOrigin030::AdmissionLimit => {
                        verify_preparation_origin_tx(db, capture, owner, generation, &event, state)
                            .await?;
                    }
                }
                verify_reduced_failure_tx(db, capture, state, &effect).await?;
                found.push((
                    row.get::<i64, _>("rowid"),
                    receipt
                        .effect_ids
                        .iter()
                        .position(|id| id == &effect.id)
                        .ok_or(StoreError030::Authority)?,
                    membership.branch.clone(),
                    path_error.clone(),
                ));
            }
            require(found.len() == 1)?;
            let candidate = found.remove(0);
            if trigger
                .as_ref()
                .is_none_or(|t| (candidate.0, candidate.1) > (t.0, t.1))
            {
                trigger = Some(candidate);
            }
        }
        let trigger = trigger.ok_or(StoreError030::Authority)?;
        require(trigger.0 <= join_failure_rowid && trigger.2 == branch && trigger.3 == *cause)?;
        Ok(join_failure_rowid)
    })
}

async fn verify_join_source(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    producer: &Producer030,
) -> Verified<()> {
    let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=? AND snapshot_id=? AND epoch=?")
        .bind(&capture.identity.system_start_id)
        .bind(&capture.identity.flow_invocation_id)
        .bind(&capture.identity.snapshot_id)
        .bind(&capture.identity.epoch)
        .fetch_optional(&mut *db)
        .await?
        .ok_or(StoreError030::Authority)?;
    let state: FlowState030 = serde_json::from_str(&raw)?;
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
    require(state.identity == capture.identity && producer.kind == "join")?;
    let groups = state
        .groups
        .iter()
        .filter(|group| group.activation_id == producer.activation_id)
        .collect::<Vec<_>>();
    require(groups.len() == 1)?;
    let group = groups[0];
    require(
        group.released
            && plan
                .steps
                .iter()
                .filter(|step| step.address == group.join && step.r#type == "join")
                .count()
                == 1
            && plan
                .joins
                .iter()
                .filter(|join| join.address == group.join)
                .count()
                == 1
            && producer.step.as_ref() == Some(&group.join)
            && matches!(
                group.decision.as_deref(),
                Some("done" | "incomplete" | "reached" | "missed")
            )
            && matches!(group.continuation, Some(Continuation030::Join))
            && group.output_json.as_deref() == Some(producer.output_json.as_str()),
    )
}

async fn verify_accepted_work(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    producer: &Producer030,
    source: &Value,
    event_id: &str,
    owner: &EngineOwner,
    generation: &str,
) -> Verified<()> {
    let id = &capture.identity;
    require(unique_agent_work_event_tx(db, capture, producer).await? == event_id)?;
    let row = sqlx::query("SELECT e.ticket_json,e.decision_json,a.context_json,a.contract_json,a.owner_epoch,a.generation,a.capture_sha256 FROM engine_flow030_work_events e JOIN engine_flow030_work_admissions a USING(system_id,invocation_id,activation_id) WHERE e.system_id=? AND e.invocation_id=? AND e.event_id=? AND e.activation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(event_id).bind(&producer.activation_id).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
    require(
        row.get::<&str, _>("owner_epoch") == owner.owner_epoch
            && row.get::<&str, _>("generation") == generation
            && row.get::<&str, _>("capture_sha256") == sha(&serde_json::to_vec(capture)?),
    )?;
    let context: EngineContext = serde_json::from_str(row.get("context_json"))?;
    let ticket: Value = serde_json::from_str(row.get("ticket_json"))?;
    require(
        context.owner == *owner
            && context.work.system_start_id == id.system_start_id
            && context.work.flow_invocation_id == id.flow_invocation_id
            && context.work.activation_id == producer.activation_id
            && context.work.step == producer.step
            && ticket.get("identity") == Some(&serde_json::to_value(id)?)
            && ticket.get("generation").and_then(Value::as_str) == Some(generation)
            && ticket.pointer("/input/eventId").and_then(Value::as_str) == Some(event_id)
            && ticket.pointer("/input/context") == Some(&serde_json::to_value(&context)?),
    )?;
    let decision: Value = serde_json::from_str(
        row.get::<Option<&str>, _>("decision_json")
            .ok_or(StoreError030::Authority)?,
    )?;
    let receipt: Value = serde_json::from_str(string(&decision, "receiptJson")?)?;
    let receipt_owner = json!({"systemStartId":owner.system_start_id,"activationId":producer.activation_id,"agentInstanceId":context.work.agent_instance_id,"ownerEpoch":owner.owner_epoch});
    require(receipt.get("owner") == Some(&receipt_owner))?;
    let accepted = receipt.get("decision").ok_or(StoreError030::Authority)?;
    require(
        accepted.get("kind").and_then(Value::as_str) == Some("finished")
            && accepted.get("outcome").and_then(Value::as_str) == Some("success"),
    )?;
    let output = accepted.get("output").ok_or(StoreError030::Authority)?;
    require(exact(
        &accepted_output_json(output)?,
        &producer.output_json,
    )?)?;
    let contract: Value = serde_json::from_str(row.get("contract_json"))?;
    let agent: Value = serde_json::from_str(string(&contract, "agentJson")?)?;
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
    let name = producer
        .step
        .as_ref()
        .and_then(|address| plan.steps.iter().find(|step| &step.address == address))
        .and_then(|step| step.agent.as_deref())
        .ok_or(StoreError030::Authority)?;
    require(source.get("producerAgent").and_then(Value::as_str) == Some(name))?;
    let instructions = source
        .pointer("/provenance/instructions")
        .and_then(Value::as_array)
        .ok_or(StoreError030::Authority)?;
    let expected_instructions = if output.get("instructions").is_some_and(|v| !v.is_null()) {
        require(agent.get("instructs") == Some(&Value::Bool(true)))?;
        vec![
            json!({"pathJson":"[\"instructions\"]","producerAgent":name,"terminalId":producer.activation_id}),
        ]
    } else {
        Vec::new()
    };
    require(instructions == &expected_instructions)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentEnvelope030 {
    format: String,
    occurrences: Vec<ContentOccurrence030>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentOccurrence030 {
    target_ordinal: usize,
    item_index: String,
    context_id: String,
    identity: Value,
    receipts: Vec<Value>,
}

async fn verify_content(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    reference: &PrepareRef030,
    plan: &FlowPlan030,
    raw: &str,
    owner: &EngineOwner,
    generation: &str,
    capture_sha: &str,
) -> Verified<()> {
    let envelope: ContentEnvelope030 = serde_json::from_str(raw)?;
    require(envelope.format == "macro-agsdl-route-content/1")?;
    let routes = plan
        .routes
        .iter()
        .filter(|r| {
            r.source == reference.route.source
                && r.kind == reference.route.kind
                && r.key == reference.route.key
        })
        .collect::<Vec<_>>();
    require(routes.len() == 1)?;
    let id = &capture.identity;
    let mut seen = BTreeSet::new();
    for use_ in envelope.occurrences {
        content_identity(&use_.identity)?;
        let index: usize = use_
            .item_index
            .parse()
            .map_err(|_| StoreError030::Authority)?;
        require(
            index.to_string() == use_.item_index
                && seen.insert((use_.target_ordinal, use_.item_index.clone()))
                && !use_.context_id.is_empty(),
        )?;
        let address = match routes[0].targets.get(use_.target_ordinal) {
            Some(Target030::Step { address, .. }) => address,
            _ => return Err(StoreError030::Authority),
        };
        let step = plan
            .steps
            .iter()
            .find(|s| &s.address == address)
            .ok_or(StoreError030::Authority)?;
        require(matches!(
            step.r#type.as_str(),
            "agent" | "approval" | "compose"
        ))?;
        let row=sqlx::query("SELECT context_id,owner_epoch,generation,capture_sha256,target_address_json,recipient_kind,recipient_agent,identity_json,policy_evidence_json,status FROM engine_flow030_route_content_contexts WHERE system_id=? AND invocation_id=? AND prepare_id=? AND target_ordinal=? AND item_index=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&reference.prepare_id).bind(i64::try_from(use_.target_ordinal).map_err(|_| StoreError030::Authority)?).bind(&use_.item_index).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
        require(
            row.get::<&str, _>("context_id") == use_.context_id
                && row.get::<&str, _>("owner_epoch") == owner.owner_epoch
                && row.get::<&str, _>("generation") == generation
                && row.get::<&str, _>("capture_sha256") == capture_sha
                && row.get::<&str, _>("status") == "live"
                && row.get::<&str, _>("recipient_kind") == step.r#type
                && row.get::<Option<String>, _>("recipient_agent") == step.agent
                && exact(
                    row.get("target_address_json"),
                    &serde_json::to_string(address)?,
                )?
                && value_equal(
                    &serde_json::from_str::<Value>(row.get("identity_json"))?,
                    &use_.identity,
                )?,
        )?;
        crate::db::exact_json::validate(row.get("policy_evidence_json"))?;
        if let Some(agent) = &step.agent {
            require(string(&use_.identity, "agent")? == agent)?;
        }
        for receipt in use_.receipts {
            require(receipt.as_object().is_some_and(|fields| {
                fields.len() == 3
                    && fields.contains_key("sourceJson")
                    && fields.contains_key("payload")
                    && fields.contains_key("provenance")
            }))?;
            let digest = content_receipt_fingerprint030(&receipt)?;
            let row=sqlx::query("SELECT source_json,native_receipt_json,transport_receipt_json FROM engine_flow030_route_content_receipts WHERE system_id=? AND invocation_id=? AND context_id=? AND receipt_sha256=?")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&use_.context_id).bind(&digest).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
            require(value_equal(
                &serde_json::from_str::<Value>(row.get("transport_receipt_json"))?,
                &receipt,
            )?)?;
            let native: ResolvedContentReceipt =
                serde_json::from_str(row.get("native_receipt_json"))?;
            verify_native_content(
                &native,
                row.get("source_json"),
                &receipt,
                &use_.identity,
                &plan.document_json,
            )?;
        }
    }
    Ok(())
}

/// Correlation key only. A matching hash without an attestation row grants nothing.
pub(crate) fn content_receipt_fingerprint030(receipt: &Value) -> Verified<String> {
    Ok(sha(&serde_json::to_vec(receipt)?))
}
fn verify_native_content(
    native: &ResolvedContentReceipt,
    source_json: &str,
    receipt: &Value,
    identity: &Value,
    document_json: &str,
) -> Verified<()> {
    crate::db::exact_json::validate(source_json)?;
    let source: Value = serde_json::from_str(source_json)?;
    let expanded: Box<RawValue> = if let Some(name) = source.get("ref").and_then(Value::as_str) {
        require(source.as_object().is_some_and(|o| o.len() == 1))?;
        crate::db::exact_json::at_path(document_json, &["content", name])?
            .ok_or(StoreError030::Authority)?
    } else {
        serde_json::from_str(source_json)?
    };
    // Compare before decoding numeric values: serde_json's Value encoding may
    // normalize a number's exponent spelling even with arbitrary_precision.
    require(exact(expanded.get(), string(receipt, "sourceJson")?)?)?;
    let expanded: Value = serde_json::from_str(expanded.get())?;
    let p = &native.provenance;
    require(
        p.source_json_digest == sha(source_json.as_bytes())
            && p.capture_id == string(identity, "captureId")?
            && p.source_digest == string(identity, "sourceDigest")?
            && p.agent == string(identity, "agent")?
            && p.policy_digest == string(identity, "policyDigest")?,
    )?;
    require(receipt.get("payload") == Some(&serde_json::to_value(&native.payload)?))?;
    let provenance = json!({"captureId":p.capture_id,"sourceDigest":p.source_digest,"agent":p.agent,"usage":p.usage,"pointer":p.pointer,"requestedUri":expanded.get("uri").cloned().unwrap_or(Value::Null),"mediaType":p.media_type,"sha256":p.sha256,"policyDigest":p.policy_digest});
    require(receipt.get("provenance") == Some(&provenance))?;
    let bytes = match &native.payload {
        ContentPayload::Text { text } => text.as_bytes().to_vec(),
        ContentPayload::Json { json } => {
            crate::db::exact_json::validate(json)?;
            json.as_bytes().to_vec()
        }
        ContentPayload::Media { base64 } => base64::engine::general_purpose::STANDARD
            .decode(base64)
            .map_err(|_| StoreError030::Authority)?,
    };
    require(p.sha256 == sha(&bytes) && p.size_bytes == bytes.len().to_string())
}

#[cfg(test)]
#[path = "agsdl_host_route_verifier030_tests.rs"]
mod tests;
