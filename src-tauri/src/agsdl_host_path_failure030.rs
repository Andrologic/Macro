//! Private SQL-only evidence for path failures. Never accepts helper/IPC events.
use super::*;
use crate::db::agsdl_execution::flow030::{reduce, Activation030, Failure030, FlowIdentity030};

pub(super) enum PathFailureOrigin030 {
    AgentWork,
    FailedJoin,
    PreparedFailure,
    AdmissionLimit,
}
impl PathFailureOrigin030 {
    pub(super) fn derive(
        event: &Value,
        activation: &Activation030,
        state: &FlowState030,
        error: &Failure030,
    ) -> Verified<Self> {
        if state
            .groups
            .iter()
            .any(|g| g.activation_id == activation.id)
        {
            return Ok(Self::FailedJoin);
        }
        if activation.start_effect_id.is_none() && error == &Failure030::new("VISIT_LIMIT") {
            return Ok(Self::AdmissionLimit);
        }
        if event.pointer("/kind/Prepared/result/Failed").is_some()
            && activation.start_effect_id.is_none()
        {
            return Ok(Self::PreparedFailure);
        }
        require(
            event
                .pointer("/kind/WorkResult/work/activationId")
                .and_then(Value::as_str)
                == Some(activation.id.as_str())
                && activation.start_effect_id.is_some(),
        )?;
        Ok(Self::AgentWork)
    }
}

pub(super) async fn verify_preparation_origin_tx(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    owner: &EngineOwner,
    generation: &str,
    event: &Value,
    state: &FlowState030,
) -> Verified<()> {
    let id = &capture.identity;
    if let Some(prepared) = event.pointer("/kind/Prepared") {
        let reference: PrepareRef030 = serde_json::from_value(prepared["reference"].clone())?;
        let native = string(prepared, "native_receipt_id")?;
        require(
            reference.identity == *id
                && !native.is_empty()
                && state.preparation_receipts.get(native) == Some(&reference.prepare_id)
                && state
                    .preparations
                    .iter()
                    .filter(|p| p.reference == reference && p.status == "consumed")
                    .count()
                    == 1,
        )?;
        let row = sqlx::query("SELECT reference_json,result_json FROM engine_flow030_preparations WHERE system_id=? AND invocation_id=? AND prepare_id=? AND native_receipt_id=? AND owner_epoch=? AND generation=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&reference.prepare_id).bind(native).bind(&owner.owner_epoch).bind(generation).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
        require(serde_json::from_str::<PrepareRef030>(row.get("reference_json"))? == reference)?;
        let result: Value = serde_json::from_str(row.get("result_json"))?;
        let expected = match result.get("kind").and_then(Value::as_str) {
            Some("failed") => {
                json!({"Failed":{"target_ordinal":result["targetOrdinal"],"error":result["error"]}})
            }
            Some("ready") => json!({"Ready":{"batches":result["batches"]}}),
            _ => return Err(StoreError030::Authority),
        };
        require(value_equal(&expected, &prepared["result"])?)?;
        return Ok(());
    }
    // A completed work can admit the next queued delivery. Its SQL decision,
    // not the delivery's error code, proves the admission event's authority.
    if let Some(work_result) = event.pointer("/kind/WorkResult") {
        let work = &work_result["work"];
        let activation_id = string(work, "activationId")?;
        let native_id = string(&work_result["physical"], "native_receipt_id")?;
        require(
            work_result["physical"]["descendants_joined"] == true
                && string(event, "eventId")?
                    == work_terminal_event_id030(id, native_id)
                        .map_err(|_| StoreError030::Authority)?,
        )?;
        let row = sqlx::query("SELECT e.ticket_json,e.decision_json,a.context_json,a.owner_epoch,a.generation,a.capture_sha256,a.start_effect_id FROM engine_flow030_work_events e JOIN engine_flow030_work_admissions a USING(system_id,invocation_id,activation_id) WHERE e.system_id=? AND e.invocation_id=? AND e.activation_id=? AND e.event_id=? AND e.decision_json IS NOT NULL")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(activation_id).bind(native_id).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
        let context: EngineContext = serde_json::from_str(row.get("context_json"))?;
        let ticket: Value = serde_json::from_str(row.get("ticket_json"))?;
        let decision: Value = serde_json::from_str(row.get("decision_json"))?;
        let receipt_raw = string(&decision, "receiptJson")?;
        let receipt: Value = serde_json::from_str(receipt_raw)?;
        let activations = state
            .activations
            .iter()
            .filter(|a| a.id == activation_id)
            .collect::<Vec<_>>();
        require(
            activations.len() == 1
                && activations[0].step == context.work.step
                && activations[0].start_effect_id.as_deref()
                    == Some(row.get::<&str, _>("start_effect_id"))
                && activations[0].instance_id == context.work.agent_instance_id,
        )?;
        require(
            context.owner == *owner
                && context.work.system_start_id == id.system_start_id
                && context.work.flow_invocation_id == id.flow_invocation_id
                && context.work.activation_id == activation_id
                && row.get::<&str, _>("owner_epoch") == owner.owner_epoch
                && row.get::<&str, _>("generation") == generation
                && row.get::<&str, _>("capture_sha256") == sha(&serde_json::to_vec(capture)?)
                && work
                    == &json!({"activationId":activation_id,"startEffectId":row.get::<&str,_>("start_effect_id"),"agentInstanceId":context.work.agent_instance_id})
                && ticket["identity"] == serde_json::to_value(id)?
                && ticket["generation"] == generation
                && ticket.pointer("/input/context") == Some(&serde_json::to_value(&context)?)
                && ticket.pointer("/input/eventId").and_then(Value::as_str) == Some(native_id)
                && receipt.pointer("/decision/kind").and_then(Value::as_str) == Some("finished"),
        )?;
        crate::agsdl_host_work::reserved_check030(&context, receipt_raw)
            .map_err(|_| StoreError030::Authority)?;
        let result = &work_result["result"];
        match receipt.pointer("/decision/outcome").and_then(Value::as_str) {
            Some("success") => {
                let output = &receipt["decision"]["output"];
                require(
                    exact(
                        string(&result["Completed"], "output_json")?,
                        &accepted_output_json(output)?,
                    )? && result["Completed"]["route_key"] == output["choice"],
                )?;
            }
            Some("failure") => require(
                result.pointer("/Failed/error")
                    == Some(&serde_json::to_value(Failure030::new(string(
                        &receipt["decision"],
                        "code",
                    )?))?),
            )?,
            _ => return Err(StoreError030::Authority),
        }
        return Ok(());
    }
    if let Some(physical) = event.pointer("/kind/PhysicalEnded") {
        // Group cancellation can also release a shared instance's queue.
        let stop_id = string(physical, "stop_effect_id")?;
        let row = sqlx::query("SELECT effect_json,settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND status='settled'")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(stop_id).bind(&owner.owner_epoch).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
        let stop: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
        let settlement: Value = serde_json::from_str(row.get("settlement_json"))?;
        let attempt = &settlement["workAttempt"];
        let provider_attempt = string(attempt, "providerAttemptId")?;
        require(
            !provider_attempt.is_empty()
                && attempt["identity"] == serde_json::to_value(id)?
                && attempt["owner"] == serde_json::to_value(owner)?
                && attempt["generation"] == generation
                && attempt["work"]["systemStartId"] == id.system_start_id
                && attempt["work"]["flowInvocationId"] == id.flow_invocation_id
                && attempt["work"]["activationId"] == physical["work"]["activationId"]
                && attempt["work"]["agentInstanceId"] == physical["work"]["agentInstanceId"]
                && attempt["startEffectId"] == physical["work"]["startEffectId"]
                && physical["evidence"]["native_receipt_id"]
                    == format!("physical:{provider_attempt}")
                && string(event, "eventId")?
                    == work_terminal_event_id030(id, &format!("joined-stop:{provider_attempt}"))
                        .map_err(|_| StoreError030::Authority)?,
        )?;
        require(
            stop.identity == *id
                && matches!(stop.kind, FlowEffectKind030::StopWork {work,include_descendants:true} if serde_json::to_value(&work).ok().as_ref() == Some(&physical["work"]))
                && settlement["kind"] == "nativeJoinedGroupStop030"
                && settlement["eventId"] == event["eventId"]
                && settlement["ownerEpoch"] == owner.owner_epoch
                && settlement["generation"] == generation
                && settlement["stopEffectId"] == stop_id
                && physical["evidence"]["descendants_joined"] == true,
        )?;
        return Ok(());
    }
    Err(StoreError030::Authority)
}

// Decode only accepted native SQL rows, with exact roundtrip. FlowEvent030
// intentionally remains non-Deserialize and no transport API exposes this.
fn journal_event(raw: &str) -> Verified<FlowEvent030> {
    fn field<T: serde::de::DeserializeOwned>(v: &Value, name: &str) -> Verified<T> {
        Ok(serde_json::from_value(
            v.get(name).cloned().ok_or(StoreError030::Authority)?,
        )?)
    }
    fn physical(v: &Value) -> Verified<PhysicalEvidence030> {
        Ok(PhysicalEvidence030 {
            native_receipt_id: string(v, "native_receipt_id")?.into(),
            descendants_joined: v["descendants_joined"]
                .as_bool()
                .ok_or(StoreError030::Authority)?,
        })
    }
    let v: Value = serde_json::from_str(raw)?;
    if v["kind"] == "Stop" {
        let event = FlowEvent030 {
            identity: field(&v, "identity")?,
            event_id: field(&v, "eventId")?,
            expected_revision: field(&v, "expectedRevision")?,
            kind: FlowEventKind030::Stop,
        };
        require(exact(raw, &serde_json::to_string(&event)?)?)?;
        return Ok(event);
    }
    let kind = v["kind"].as_object().ok_or(StoreError030::Authority)?;
    require(kind.len() == 1)?;
    let event_kind = if let Some(x) = kind.get("Enter") {
        FlowEventKind030::Enter {
            message_json: field(x, "message_json")?,
        }
    } else if let Some(x) = kind.get("Deliver") {
        FlowEventKind030::Deliver {
            agent: field(x, "agent")?,
            instance: field(x, "instance")?,
            delivery: field(x, "delivery")?,
            message_json: field(x, "message_json")?,
            sender: field(x, "sender")?,
        }
    } else if let Some(x) = kind.get("Prepared") {
        let r = &x["result"];
        let result = if let Some(f) = r.get("Failed") {
            PreparedResult030::Failed {
                target_ordinal: field(f, "target_ordinal")?,
                error: field(f, "error")?,
            }
        } else {
            PreparedResult030::Ready {
                batches: field(&r["Ready"], "batches")?,
            }
        };
        FlowEventKind030::Prepared {
            reference: field(x, "reference")?,
            native_receipt_id: field(x, "native_receipt_id")?,
            result,
        }
    } else if let Some(x) = kind.get("WorkResult") {
        let r = &x["result"];
        let result = if let Some(f) = r.get("Failed") {
            WorkResult030::Failed {
                error: field(f, "error")?,
            }
        } else {
            WorkResult030::Completed {
                output_json: field(&r["Completed"], "output_json")?,
                route_key: field(&r["Completed"], "route_key")?,
            }
        };
        FlowEventKind030::WorkResult {
            work: field(x, "work")?,
            result,
            physical: if x["physical"].is_null() {
                None
            } else {
                Some(physical(&x["physical"])?)
            },
        }
    } else if let Some(x) = kind.get("PhysicalEnded") {
        FlowEventKind030::PhysicalEnded {
            work: field(x, "work")?,
            stop_effect_id: field(x, "stop_effect_id")?,
            evidence: physical(&x["evidence"])?,
        }
    } else {
        return Err(StoreError030::Authority);
    };
    let event = FlowEvent030 {
        identity: field(&v, "identity")?,
        event_id: field(&v, "eventId")?,
        expected_revision: field(&v, "expectedRevision")?,
        kind: event_kind,
    };
    require(exact(raw, &serde_json::to_string(&event)?)?)?;
    Ok(event)
}

pub(super) async fn verify_reduced_failure_tx(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    retained: &FlowState030,
    failure: &FlowEffect030,
) -> Verified<()> {
    let id: &FlowIdentity030 = &capture.identity;
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
    let rows = sqlx::query("SELECT event_id,event_json,receipt_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND receipt_json IS NOT NULL AND diagnostic_json IS NULL ORDER BY rowid")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *db).await?;
    let mut state = FlowState030::new(id.clone());
    let mut found = 0;
    for row in rows {
        let raw: &str = row.get("event_json");
        let event = journal_event(raw)?;
        let receipt: crate::db::agsdl_execution::flow030::FlowReceipt030 =
            serde_json::from_str(row.get("receipt_json"))?;
        let record = retained
            .events
            .get(&event.event_id)
            .ok_or(StoreError030::Authority)?;
        require(
            row.get::<&str, _>("event_id") == event.event_id
                && record.event_json == raw
                && record.receipt == receipt,
        )?;
        let transition = reduce(&plan, &state, &event).map_err(|_| StoreError030::Authority)?;
        require(transition.receipt == receipt)?;
        found += transition.effects.iter().filter(|e| *e == failure).count();
        state = transition.state;
    }
    require(found == 1 && state == *retained)
}
