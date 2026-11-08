//! Read-only verification of native 04/11 attestations for route preparation.
//! These tables have native-only writers. Helper/model JSON cannot create an
//! attestation; a digest checks correlation and is never a permission grant.
use crate::agsdl_content::{ContentPayload, ResolvedContentReceipt};
use crate::agsdl_host::HostState;
use crate::agsdl_host_flow030::{NativeRouteMaterial030, RouteMaterialVerifier030};
use crate::db::agsdl_execution::{
    dto::{EngineContext, EngineOwner},
    flow030::{
        FlowEffect030, FlowEffectKind030, FlowPlan030, PrepareRef030, Producer030, Target030,
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

type Verified<T> = std::result::Result<T, StoreError030>;
fn require(value: bool) -> Verified<()> {
    if value {
        Ok(())
    } else {
        Err(StoreError030::Authority)
    }
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
fn accepted_output_json(output: &Value) -> Verified<String> {
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
                "call" => "call",
                "approval" => "human",
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
        accepted.get("kind").and_then(Value::as_str) == Some("accepted")
            || (accepted.get("kind").and_then(Value::as_str) == Some("finished")
                && accepted.get("outcome").and_then(Value::as_str) == Some("success")),
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
    if !instructions.is_empty() {
        require(
            agent.get("instructs") == Some(&Value::Bool(true))
                && output.get("instructions").is_some_and(|v| !v.is_null()),
        )?;
    }
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
    // Compatibility for an entirely empty legacy cache conveys no authority.
    let legacy: Value = serde_json::from_str(raw)?;
    if legacy.get("format").is_none() {
        require(
            legacy.get("identity").is_some_and(Value::is_object)
                && legacy
                    .get("receipts")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
                && legacy.as_object().is_some_and(|o| o.len() == 2),
        )?;
        return Ok(());
    }
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
