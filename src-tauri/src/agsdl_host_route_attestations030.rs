//! Native 037 writers. JSON cache entries are transport, never read authority.
//! The caller owns admission and the outer SQL transaction through commit. No
//! file/provider IO occurs in a SQL writer; content is resolved beforehand by 11.
use crate::agsdl_content::{
    resolve_content, ContentContext, ContentContextBinding, ContentUse, ResolvedContentReceipt,
};
use crate::agsdl_host::{HostStartLease, HostState};
use crate::agsdl_host_flow030::{FlowHost030, NativeRouteMaterial030, RouteMaterialVerifier030};
use crate::agsdl_host_route_verifier030::{
    content_receipt_fingerprint030, SqlRouteMaterialVerifier030,
};
use crate::db::agsdl_execution::{
    dto::EngineOwner,
    failure,
    flow030::{
        FlowEffect030, FlowEffectKind030, FlowPlan030, FlowState030, PrepareRef030, Producer030,
        Target030,
    },
    flow_store030::CheckFuture,
    json_lexemes030::document_tokens_equal,
    start030::StartCapture030,
    Result,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row, Sqlite, SqliteConnection, Transaction};
use std::collections::BTreeSet;

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn require(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(failure(
            "CORRELATION",
            "route",
            "Native route attestation does not match its capture",
        ))
    }
}
fn content_error(
    error: crate::agsdl_content::ContentError,
) -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(&error.code, &error.pointer, &error.message)
}
fn verification_error(
    _: crate::db::agsdl_execution::flow_store030::StoreError030,
) -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "AUTHORITY",
        "route",
        "Native route material is not attested",
    )
}

/// Implemented by the native policy owner, never by a helper or IPC handler
/// accepting a policy supplied in JSON. This checks the recipient's captured
/// ceilings and the exact uses against the current native policy at commit.
/// Binding metadata alone is not an authorization decision.
pub(crate) trait RouteRecipientAuthority030 {
    fn attest_tx<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        capture: &'a StartCapture030,
        reference: &'a PrepareRef030,
        target_ordinal: usize,
        item_index: &'a str,
        binding: &'a ContentContextBinding,
        uses: &'a [ContentUse],
    ) -> CheckFuture<'a>;
}

/// Sealed by a live native owner. Not Deserialize and never exposed as IPC.
pub(crate) struct RouteAttestor030 {
    owner: EngineOwner,
    generation: String,
    verifier: SqlRouteMaterialVerifier030,
}
/// The source is derived from native reducer state and an accepted 04 event.
/// It cannot be minted from a RouteSource030 transport object.
pub(crate) struct AttestedRouteSource030 {
    capture: StartCapture030,
    reference: PrepareRef030,
    producer: Producer030,
    owner: EngineOwner,
    generation: String,
    source_json: String,
    native_receipt_id: String,
}
/// Owns the actual context and the actual 11 resolution results. There is no
/// constructor accepting deserialized receipts or a callback that supplies them.
pub(crate) struct ResolvedRouteOccurrence030 {
    context: ContentContext,
    uses: Vec<ContentUse>,
    receipts: Vec<ResolvedContentReceipt>,
    target_ordinal: usize,
    item_index: String,
    context_id: String,
    source_receipt_id: String,
}

impl RouteAttestor030 {
    pub(crate) async fn capture(host: &HostState, owner: &EngineOwner) -> Result<Self> {
        let lease = host.start_lease().await?;
        require(lease.owner(&owner.system_start_id)? == *owner)?;
        let generation = lease.generation().to_owned();
        // Drop the lease before another lifecycle acquisition, avoiding a
        // nested read behind a queued retirement writer.
        drop(lease);
        let verifier = SqlRouteMaterialVerifier030::capture(host, owner).await?;
        let lease = host.start_lease().await?;
        require(
            lease.generation() == generation && lease.owner(&owner.system_start_id)? == *owner,
        )?;
        Ok(Self {
            owner: owner.clone(),
            generation,
            verifier,
        })
    }
    fn live(&self, lease: &HostStartLease) -> Result<()> {
        lease.ensure_live()?;
        require(
            lease.generation() == self.generation
                && lease.owner(&self.owner.system_start_id)? == self.owner,
        )
    }
    async fn current_tx(
        &self,
        db: &mut SqliteConnection,
        lease: &HostStartLease,
        runtime: &FlowHost030,
        capture: &StartCapture030,
        reference: &PrepareRef030,
    ) -> Result<(Producer030, String)> {
        self.live(lease)?;
        runtime.available(&capture.identity)?;
        require(
            reference.identity == capture.identity
                && self.owner.system_start_id == capture.identity.system_start_id,
        )?;
        let id = &capture.identity;
        let row = sqlx::query("SELECT o.owner_epoch,o.generation,o.status,o.capture_sha256,s.capture_json,r.state_json FROM engine_flow030_owners o JOIN engine_start030_requests s ON s.system_id=o.system_id AND s.invocation_id=o.invocation_id AND s.snapshot_id=o.snapshot_id AND s.capture_epoch=o.capture_epoch JOIN engine_flow030_runs r ON r.system_id=o.system_id AND r.invocation_id=o.invocation_id WHERE o.system_id=? AND o.invocation_id=? AND o.snapshot_id=? AND o.capture_epoch=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&id.snapshot_id).bind(&id.epoch)
            .fetch_optional(&mut *db).await?.ok_or_else(|| failure("AUTHORITY", "route", "Native route owner is absent"))?;
        let capture_json = serde_json::to_string(capture)?;
        require(
            row.get::<&str, _>("owner_epoch") == self.owner.owner_epoch
                && row.get::<&str, _>("generation") == self.generation
                && row.get::<&str, _>("status") == "live"
                && row.get::<&str, _>("capture_sha256") == sha(capture_json.as_bytes())
                && row.get::<&str, _>("capture_json") == capture_json,
        )?;
        let state: FlowState030 = serde_json::from_str(row.get("state_json"))?;
        require(state.identity == *id && state.entered && !state.stopping)?;
        let retained_plan: FlowPlan030 = serde_json::from_str(
            state
                .plan_json
                .as_deref()
                .ok_or_else(|| failure("CORRELATION", "route", "Entered flow plan is absent"))?,
        )?;
        require(
            retained_plan == serde_json::from_str::<FlowPlan030>(&capture.compiled_plan_json)?,
        )?;
        let preparation = state
            .preparations
            .iter()
            .find(|p| p.reference == *reference && p.status == "pending")
            .ok_or_else(|| {
                failure(
                    "STALE_REFERENCE",
                    "route",
                    "Route preparation is no longer pending",
                )
            })?;
        let effects = sqlx::query("SELECT effect_id,effect_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND owner_epoch=? AND status='pending'")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&self.owner.owner_epoch).fetch_all(&mut *db).await?;
        let mut matching = Vec::new();
        for row in effects {
            let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
            if effect.identity == *id
                && matches!(&effect.kind, FlowEffectKind030::PrepareRoute {reference:r,producer:p} if r==reference && p==&preparation.producer)
            {
                require(effect.id == row.get::<&str, _>("effect_id"))?;
                matching.push(effect.id);
            }
        }
        require(matching.len() == 1)?;
        self.live(lease)?;
        Ok((preparation.producer.clone(), matching.remove(0)))
    }

    /// Persists one agent terminal source. Calls, humans, joins and errors need
    /// their own native terminal authority; they cannot borrow an agent event.
    /// A savepoint makes a rejected attestation leave no partial source row.
    pub(crate) async fn attest_agent_source_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        lease: &HostStartLease,
        runtime: &FlowHost030,
        capture: &StartCapture030,
        reference: &PrepareRef030,
        work_event_id: &str,
    ) -> Result<AttestedRouteSource030> {
        let mut save = tx.begin().await?;
        let (producer, effect_id) = self
            .current_tx(&mut save, lease, runtime, capture, reference)
            .await?;
        require(
            producer.kind == "agent"
                && reference.route.kind == "normal"
                && !work_event_id.is_empty(),
        )?;
        let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
        let agent = producer
            .step
            .as_ref()
            .and_then(|address| plan.steps.iter().find(|s| &s.address == address))
            .and_then(|s| s.agent.as_ref())
            .ok_or_else(|| {
                failure(
                    "CORRELATION",
                    "route",
                    "Agent producer is absent from the captured plan",
                )
            })?;
        let decision: String = sqlx::query_scalar("SELECT decision_json FROM engine_flow030_work_events WHERE system_id=? AND invocation_id=? AND event_id=? AND activation_id=? AND decision_json IS NOT NULL")
            .bind(&capture.identity.system_start_id).bind(&capture.identity.flow_invocation_id).bind(work_event_id).bind(&producer.activation_id)
            .fetch_optional(&mut *save).await?.ok_or_else(|| failure("AUTHORITY", "route", "Accepted native work decision is absent"))?;
        let decision: Value = serde_json::from_str(&decision)?;
        let receipt: Value = serde_json::from_str(
            decision
                .get("receiptJson")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("CORRELATION", "route", "Native work receipt is absent"))?,
        )?;
        let accepted = receipt
            .get("decision")
            .ok_or_else(|| failure("CORRELATION", "route", "Native work decision is absent"))?;
        require(
            accepted.get("kind").and_then(Value::as_str) == Some("accepted")
                || (accepted.get("kind").and_then(Value::as_str) == Some("finished")
                    && accepted.get("outcome").and_then(Value::as_str) == Some("success")),
        )?;
        let mut instructions = Vec::new();
        if accepted
            .pointer("/output/instructions")
            .is_some_and(|v| !v.is_null())
        {
            instructions.push(json!({"pathJson":"[\"instructions\"]","producerAgent":agent,"terminalId":producer.activation_id}));
        }
        let source_json = json!({"terminalId":producer.activation_id,"producerStep":producer.step,"producerAgent":agent,
            "kind":"agent","outputJson":producer.output_json,"provenance":{"instructions":instructions}}).to_string();
        let native_receipt_id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO engine_flow030_route_source_attestations(system_id,invocation_id,prepare_id,preparation_effect_id,owner_epoch,generation,capture_sha256,native_receipt_id,receipt_kind,work_event_id,producer_json,source_json) VALUES(?,?,?,?,?,?,?,?,'agentWork',?,?,?)")
            .bind(&capture.identity.system_start_id).bind(&capture.identity.flow_invocation_id).bind(&reference.prepare_id).bind(&effect_id)
            .bind(&self.owner.owner_epoch).bind(&self.generation).bind(sha(&serde_json::to_vec(capture)?)).bind(&native_receipt_id)
            .bind(work_event_id).bind(serde_json::to_string(&producer)?).bind(&source_json).execute(&mut *save).await?;
        let material = NativeRouteMaterial030 {
            source_json: source_json.clone(),
            content_receipts_json: json!({"format":"macro-agsdl-route-content/1","occurrences":[]})
                .to_string(),
        };
        // This independently validates the 036 admission/ticket/accepted receipt,
        // exact output, agent contract and preparation outbox in this snapshot.
        self.verifier
            .attest_tx(&mut save, capture, reference, &producer, &material)
            .await
            .map_err(verification_error)?;
        self.live(lease)?;
        runtime.available(&capture.identity)?;
        save.commit().await?; // release savepoint; outer COMMIT remains with 09
        Ok(AttestedRouteSource030 {
            capture: capture.clone(),
            reference: reference.clone(),
            producer,
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            source_json,
            native_receipt_id,
        })
    }

    /// The caller obtains the context from the native recipient policy owner.
    /// This function performs actual 11 resolution, never JSON cache replay.
    pub(crate) async fn resolve_occurrence(
        &self,
        source: &AttestedRouteSource030,
        target_ordinal: usize,
        item_index: String,
        context: ContentContext,
        uses: Vec<ContentUse>,
    ) -> Result<ResolvedRouteOccurrence030> {
        require(source.owner == self.owner && source.generation == self.generation)?;
        canonical_index(&item_index)?;
        let binding = context.binding().map_err(content_error)?;
        validate_recipient(&source.capture, &source.reference, target_ordinal, &binding)?;
        let mut receipts = Vec::with_capacity(uses.len());
        for usage in &uses {
            receipts.push(
                resolve_content(
                    &context,
                    ContentUse {
                        source_json: usage.source_json.clone(),
                        usage: usage.usage,
                        pointer: usage.pointer.clone(),
                    },
                )
                .await
                .map_err(content_error)?,
            );
        }
        context.binding().map_err(content_error)?;
        Ok(ResolvedRouteOccurrence030 {
            context,
            uses,
            receipts,
            target_ordinal,
            item_index,
            context_id: uuid::Uuid::new_v4().to_string(),
            source_receipt_id: source.native_receipt_id.clone(),
        })
    }

    /// No external IO. The policy owner revalidates the exact recipient and uses
    /// under the caller's shared admission gate and SQL transaction. A failed
    /// verification rolls this savepoint back, including every receipt row.
    pub(crate) async fn attest_occurrences_tx<P: RouteRecipientAuthority030>(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        lease: &HostStartLease,
        runtime: &FlowHost030,
        source: &AttestedRouteSource030,
        occurrences: &[ResolvedRouteOccurrence030],
        policy: &P,
    ) -> Result<NativeRouteMaterial030> {
        require(source.owner == self.owner && source.generation == self.generation)?;
        let mut save = tx.begin().await?;
        let (producer, _) = self
            .current_tx(
                &mut save,
                lease,
                runtime,
                &source.capture,
                &source.reference,
            )
            .await?;
        require(producer == source.producer)?;
        let retained: String = sqlx::query_scalar("SELECT native_receipt_id FROM engine_flow030_route_source_attestations WHERE system_id=? AND invocation_id=? AND prepare_id=? AND source_json=?")
            .bind(&source.capture.identity.system_start_id).bind(&source.capture.identity.flow_invocation_id)
            .bind(&source.reference.prepare_id).bind(&source.source_json).fetch_one(&mut *save).await?;
        require(retained == source.native_receipt_id)?;
        let mut seen = BTreeSet::new();
        let mut transported = Vec::new();
        for occurrence in occurrences {
            require(occurrence.source_receipt_id == source.native_receipt_id)?;
            canonical_index(&occurrence.item_index)?;
            require(seen.insert((occurrence.target_ordinal, occurrence.item_index.clone())))?;
            let binding = occurrence.context.binding().map_err(content_error)?;
            let (address, agent) = validate_recipient(
                &source.capture,
                &source.reference,
                occurrence.target_ordinal,
                &binding,
            )?;
            policy
                .attest_tx(
                    &mut save,
                    &source.capture,
                    &source.reference,
                    occurrence.target_ordinal,
                    &occurrence.item_index,
                    &binding,
                    &occurrence.uses,
                )
                .await
                .map_err(verification_error)?;
            let identity = json!({"captureId":binding.capture_id,"sourceDigest":binding.source_digest,"agent":binding.agent,"policyDigest":binding.policy_digest});
            sqlx::query("INSERT INTO engine_flow030_route_content_contexts(system_id,invocation_id,prepare_id,target_ordinal,item_index,context_id,owner_epoch,generation,capture_sha256,target_address_json,recipient_kind,recipient_agent,identity_json,policy_evidence_json,status) VALUES(?,?,?,?,?,?,?,?,?,?,'agent',?,?,?,'live')")
                .bind(&source.capture.identity.system_start_id).bind(&source.capture.identity.flow_invocation_id).bind(&source.reference.prepare_id)
                .bind(i64::try_from(occurrence.target_ordinal).map_err(|_| failure("CORRELATION","route","Target ordinal is out of range"))?)
                .bind(&occurrence.item_index).bind(&occurrence.context_id).bind(&self.owner.owner_epoch).bind(&self.generation)
                .bind(sha(&serde_json::to_vec(&source.capture)?)).bind(serde_json::to_string(&address)?).bind(&agent)
                .bind(identity.to_string()).bind(&binding.policy_json).execute(&mut *save).await?;
            require(occurrence.uses.len() == occurrence.receipts.len())?;
            let mut receipts = Vec::new();
            for (usage, native) in occurrence.uses.iter().zip(&occurrence.receipts) {
                let receipt = transport_receipt(&binding, usage, native)?;
                let receipt_sha =
                    content_receipt_fingerprint030(&receipt).map_err(verification_error)?;
                sqlx::query("INSERT INTO engine_flow030_route_content_receipts(system_id,invocation_id,context_id,receipt_sha256,source_json,native_receipt_json,transport_receipt_json) VALUES(?,?,?,?,?,?,?)")
                    .bind(&source.capture.identity.system_start_id).bind(&source.capture.identity.flow_invocation_id).bind(&occurrence.context_id)
                    .bind(receipt_sha).bind(&usage.source_json).bind(serde_json::to_string(native)?).bind(receipt.to_string()).execute(&mut *save).await?;
                receipts.push(receipt);
            }
            transported.push(
                json!({"targetOrdinal":occurrence.target_ordinal,"itemIndex":occurrence.item_index,
                "contextId":occurrence.context_id,"identity":identity,"receipts":receipts}),
            );
            occurrence.context.binding().map_err(content_error)?;
        }
        let material = NativeRouteMaterial030 {
            source_json: source.source_json.clone(),
            content_receipts_json:
                json!({"format":"macro-agsdl-route-content/1","occurrences":transported})
                    .to_string(),
        };
        self.verifier
            .attest_tx(
                &mut save,
                &source.capture,
                &source.reference,
                &source.producer,
                &material,
            )
            .await
            .map_err(verification_error)?;
        self.live(lease)?;
        runtime.available(&source.capture.identity)?;
        save.commit().await?;
        Ok(material)
    }
}

fn canonical_index(index: &str) -> Result<()> {
    require(
        index == "0"
            || (!index.is_empty()
                && matches!(index.as_bytes()[0], b'1'..=b'9')
                && index.bytes().all(|b| b.is_ascii_digit())),
    )
}
fn validate_recipient(
    capture: &StartCapture030,
    reference: &PrepareRef030,
    ordinal: usize,
    binding: &ContentContextBinding,
) -> Result<(Vec<String>, String)> {
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
    require(
        reference.identity == capture.identity
            && binding.capture_id == capture.identity.snapshot_id
            && binding.source_digest == sha(plan.document_json.as_bytes())
            && binding.document_json == plan.document_json
            && sha(binding.policy_json.as_bytes()) == binding.policy_digest,
    )?;
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
    let address = match routes[0].targets.get(ordinal) {
        Some(Target030::Step { address, .. }) => address,
        _ => {
            return Err(failure(
                "CORRELATION",
                "route",
                "Target is not a content recipient",
            ))
        }
    };
    let step = plan
        .steps
        .iter()
        .find(|s| &s.address == address)
        .ok_or_else(|| failure("CORRELATION", "route", "Recipient is absent"))?;
    // 11 currently has only a captured agent policy context. Never invent an
    // agent for an approval/composition, nor borrow the producer's permission.
    require(step.r#type == "agent" && step.agent.as_deref() == Some(binding.agent.as_str()))?;
    Ok((address.clone(), binding.agent.clone()))
}
fn transport_receipt(
    binding: &ContentContextBinding,
    usage: &ContentUse,
    native: &ResolvedContentReceipt,
) -> Result<Value> {
    let p = &native.provenance;
    require(
        p.capture_id == binding.capture_id
            && p.source_digest == binding.source_digest
            && p.agent == binding.agent
            && p.policy_digest == binding.policy_digest
            && p.source_json_digest == sha(usage.source_json.as_bytes())
            && p.pointer == usage.pointer
            && p.usage == usage.usage,
    )?;
    let original: Value = serde_json::from_str(&usage.source_json)?;
    let expanded = if let Some(name) = original.get("ref").and_then(Value::as_str) {
        require(original.as_object().is_some_and(|o| o.len() == 1))?;
        crate::db::exact_json::at_path(&binding.document_json, &["content", name])?
            .ok_or_else(|| failure("CORRELATION", "route", "Content ref is absent"))?
            .get()
            .to_owned()
    } else {
        usage.source_json.clone()
    };
    // Validate before decoding; keep the raw expanded source lexemes on wire.
    require(document_tokens_equal(&expanded, &expanded)?)?;
    let value: Value = serde_json::from_str(&expanded)?;
    Ok(json!({"sourceJson":expanded,"payload":native.payload,
        "provenance":{"captureId":p.capture_id,"sourceDigest":p.source_digest,"agent":p.agent,
            "usage":p.usage,"pointer":p.pointer,"requestedUri":value.get("uri").cloned().unwrap_or(Value::Null),
            "mediaType":p.media_type,"sha256":p.sha256,"policyDigest":p.policy_digest}}))
}

#[cfg(test)]
#[path = "agsdl_host_route_attestations030_tests.rs"]
mod tests;
