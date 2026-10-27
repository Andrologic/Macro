use super::*;
use crate::core::db_state::DbPool;
use crate::db::{
    chat_admission::reconciliation::{self, Snapshot},
    models::ConversationContentToken,
};
use sqlx::{Connection, Row};

/// Owned expectations supplied by the later canonical/native composition. No
/// production constructor or deserializer accepts these from IPC/network JSON.
/// Its bytes are stored exactly; this low-level owner does not authenticate them
/// or replace the canonical validators with a second Rust contract implementation.
#[derive(Clone, Serialize)]
pub(crate) struct Reservation {
    transfer_id: String,
    relay_origin: String,
    account_id: String,
    source_instance_id: String,
    source_conversation_id: String,
    source_epoch: i64,
    target_instance_id: String,
    source_generation: String,
    target_generation: String,
    binding_digest: Vec<u8>,
    binding_json: Vec<u8>,
    expectation_json: Vec<u8>,
    reserve_request: Vec<u8>,
    expected_ownership_revision: i64,
    expected_content: ConversationContentToken,
    // Live native scope only. None on storage fixtures; never serialized to SQL
    // and never reconstructed when reading a durable receipt.
    #[serde(skip)]
    native_authority:
        Option<std::sync::Arc<crate::commands::pilot_secrets::transport::VerifiedTransport>>,
    #[serde(skip)]
    native_target_prepared: Option<serde_json::Value>,
    #[serde(skip)]
    native_target_activation: Option<serde_json::Value>,
    #[serde(skip)]
    native_lineage_id: String,
    #[serde(skip)]
    native_installation_id: String,
    #[serde(skip)]
    native_birth_generation: String,
}
impl Reservation {
    pub(crate) fn transfer_id(&self) -> &str {
        &self.transfer_id
    }
    /// The original native object stays with the live job. SQL and JSON receipts
    /// cannot reconstruct this attachment input or replace fresh producer rights.
    pub(crate) async fn attach_captured_source(
        &self,
        owner: &DbPool,
        transport: &crate::commands::pilot_secrets::transport::VerifiedTransport,
        capture: &str,
    ) -> DbResult<()> {
        transport
            .check_producer(
                &self.account_id,
                &self.source_instance_id,
                &self.source_generation,
            )
            .await
            .map_err(invalid)?;
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        attach_capture(&guard.ready.pool, self, capture).await
    }
    fn native_commitments(&self) -> DbResult<(serde_json::Value, serde_json::Value)> {
        use crate::commands::pilot_secrets::transport::commitment;
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        let facts = live.controller_snapshot().map_err(invalid)?;
        let binding = serde_json::json!({"transfer_id":self.transfer_id,"provenance":{
            "source":{"relay_origin":self.relay_origin,"account_id":self.account_id,"source_instance_id":self.source_instance_id,"source_conversation_id":self.source_conversation_id},
            "lineage_id":self.native_lineage_id,"installation_id":self.native_installation_id,"birth_generation":self.native_birth_generation},
            "epoch":self.source_epoch.to_string(),"target_instance_id":self.target_instance_id,
            "relay_recovery_generation":facts["recovery_generation"],"initiator":facts["actor"],
            "source_producer_generation":self.source_generation,"target_producer_generation":self.target_generation});
        let binding_digest = commitment("transfer-binding", &binding).map_err(invalid)?;
        if binding_digest
            != self
                .binding_digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        {
            return Err(invalid("connect_native_binding_changed"));
        }
        let freeze_hash = hash(
            &serde_json::to_vec(&self.expected_content)
                .map_err(|_| invalid("connect_native_freeze"))?,
        )
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
        let frozen = serde_json::json!({"format_version":"1","binding_digest":binding_digest,
            "ownership_revision":self.expected_ownership_revision.to_string(),"content_incarnation":self.expected_content.incarnation,
            "content_revision":self.expected_content.revision,"sha256":freeze_hash});
        Ok((binding, frozen))
    }
    pub(crate) async fn source_manifest(
        &self,
        owner: &DbPool,
        normalized: &crate::connect::transfer_worker::TransferWorker,
    ) -> DbResult<serde_json::Value> {
        use crate::commands::pilot_secrets::transport::commitment;
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        live.check_producer(
            &self.account_id,
            &self.source_instance_id,
            &self.source_generation,
        )
        .await
        .map_err(invalid)?;
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        guard
            .ready
            .check_source_schema(&mut *guard.ready.pool.acquire().await?)
            .await?;
        let row=sqlx::query("SELECT t.fingerprint,t.local_generation,t.ownership_incarnation,t.ownership_revision,t.restore_hold,t.terminal_outcome,t.resolution,o.incarnation,o.revision,o.mode,c.manifest_hash,c.phase FROM connect_transfers t JOIN chat_admission_owners o ON o.conversation_id=t.source_conversation_id JOIN e_source_captures c ON c.id=t.source_capture_id WHERE t.transfer_id=? AND t.local_role='source'")
            .bind(&self.transfer_id).fetch_one(&guard.ready.pool).await?;
        if row.get::<Vec<u8>, _>("fingerprint") != self.inspect()?.0
            || row.get::<String, _>("local_generation") != guard.ready.catalog_generation
            || row.get::<String, _>("incarnation") != row.get::<String, _>("ownership_incarnation")
            || row.get::<i64, _>("revision") != row.get::<i64, _>("ownership_revision")
            || row.get::<String, _>("mode") != "frozen"
            || row.get::<i64, _>("restore_hold") != 0
            || row.get::<Option<String>, _>("terminal_outcome").is_some()
            || row.get::<Option<String>, _>("resolution").is_some()
            || row.get::<i64, _>("phase") != 2
        {
            return Err(invalid("connect_source_effect_changed"));
        }
        let current = crate::db::conversation_content::conversation_content_version(
            &guard.ready.pool,
            &self.source_conversation_id,
        )
        .await?;
        if current != self.expected_content {
            return Err(invalid("connect_source_effect_changed"));
        }
        let (descriptor, _) = normalized
            .normalized_for(&row.get::<Vec<u8>, _>("manifest_hash"))
            .map_err(invalid)?;
        let (_, frozen) = self.native_commitments()?;
        Ok(
            serde_json::json!({"format_version":"1","binding_digest":frozen["binding_digest"],
            "frozen_digest":commitment("frozen",&frozen).map_err(invalid)?,
            "content_contract_sha256":descriptor["content_contract_sha256"],"manifest_sha256":descriptor["manifest_sha256"],
            "source_revision":self.expected_content.revision}),
        )
    }
    /// `normalized` is required only for proofs about the sealed manifest.
    pub(crate) async fn source_expectation(
        &self,
        owner: &DbPool,
        normalized: Option<&crate::connect::transfer_worker::TransferWorker>,
        request: &serde_json::Value,
        kind: &str,
    ) -> DbResult<serde_json::Value> {
        use crate::commands::pilot_secrets::transport::commitment;
        let manifest = match (kind, normalized) {
            ("source_sealed" | "source_maintained", Some(normalized)) => {
                self.source_manifest(owner, normalized).await?
            }
            ("source_sealed" | "source_maintained", None) => {
                return Err(invalid("connect_proof_mismatch"))
            }
            _ => serde_json::Value::Null,
        };
        let (binding, frozen) = self.native_commitments()?;
        let original: serde_json::Value = serde_json::from_slice(&self.reserve_request)
            .map_err(|_| invalid("connect_native_binding_changed"))?;
        let original = &original["request"];
        if original["body"]["binding"] != binding || original["body"]["frozen"] != frozen {
            return Err(invalid("connect_native_binding_changed"));
        }
        let (scope, subject, prior) = match kind {
            "lineage_enrolled"
                if request["operation"] == "lineage.create"
                    && request["body"]["mode"] == "initial_existing"
                    && request["body"]["provenance"] == binding["provenance"]
                    && request["body"]["creation_digest"] == frozen["sha256"] =>
            {
                (
                    commitment("provenance", &binding["provenance"]),
                    commitment("birth", &request["body"]),
                    None,
                )
            }
            // The reserve, or the abort_missing closing that same frozen
            // binding when the relay never received it.
            "source_frozen"
                if request == original
                    || request["operation"] == "reconcile"
                        && request["body"]["action"] == "abort_missing"
                        && request["transfer_id"] == self.transfer_id
                        && request["body"]["binding"] == binding
                        && request["body"]["frozen"] == frozen =>
            {
                (
                    commitment("transfer-binding", &binding),
                    commitment("frozen", &frozen),
                    None,
                )
            }
            "source_sealed"
                if request["operation"] == "seal"
                    && request["transfer_id"] == self.transfer_id
                    && request["body"]["manifest"] == manifest =>
            {
                (
                    commitment("transfer-binding", &binding),
                    commitment("manifest", &manifest),
                    Some(commitment("frozen", &frozen)),
                )
            }
            "source_maintained"
                if request["operation"] == "commit"
                    && request["transfer_id"] == self.transfer_id =>
            {
                (
                    commitment("transfer-binding", &binding),
                    commitment("frozen", &frozen),
                    Some(commitment("manifest", &manifest)),
                )
            }
            _ => return Err(invalid("connect_proof_mismatch")),
        };
        let prior = prior.transpose().map_err(invalid)?;
        let facts = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?
            .controller_snapshot()
            .map_err(invalid)?;
        Ok(
            serde_json::json!({"kind":kind,"binding_digest":scope.map_err(invalid)?,"subject_digest":subject.map_err(invalid)?,
            "instance_id":self.source_instance_id,"producer_generation":self.source_generation,
            "connection_id":facts["source_producer"]["connection_id"],
            "request_digest":commitment("retry-body",request).map_err(invalid)?,"prior_receipt_digest":prior}),
        )
    }
    pub(crate) async fn check_source_attestation(
        &self,
        owner: &DbPool,
        transport: &crate::commands::pilot_secrets::transport::VerifiedTransport,
        normalized: Option<&crate::connect::transfer_worker::TransferWorker>,
        request: &serde_json::Value,
        exchange: &serde_json::Value,
    ) -> DbResult<()> {
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        // Match fresh authenticated facts against the original native reserve
        // intent. The address of a transport object is not a transfer identity.
        let original: serde_json::Value = serde_json::from_slice(&self.reserve_request)
            .map_err(|_| invalid("connect_native_binding_changed"))?;
        transport.check_reserve(&original).await.map_err(invalid)?;
        transport
            .check_producer(
                &self.account_id,
                &self.source_instance_id,
                &self.source_generation,
            )
            .await
            .map_err(invalid)?;
        live.check().await.map_err(invalid)?;
        let kind = exchange["kind"]
            .as_str()
            .ok_or_else(|| invalid("connect_proof_mismatch"))?;
        let expected = self
            .source_expectation(owner, normalized, request, kind)
            .await?;
        for (name, value) in expected
            .as_object()
            .ok_or_else(|| invalid("connect_proof_mismatch"))?
        {
            if &exchange[name] != value {
                return Err(invalid("connect_proof_mismatch"));
            }
        }
        Ok(())
    }
    fn inspect(&self) -> DbResult<(Vec<u8>, i64)> {
        uuid(&self.transfer_id)?;
        for id in [
            &self.account_id,
            &self.source_instance_id,
            &self.source_conversation_id,
            &self.target_instance_id,
            &self.source_generation,
            &self.target_generation,
        ] {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            {
                return Err(invalid("connect_transfer_invalid_identity"));
            }
        }
        if self.source_epoch <= 0
            || self.expected_ownership_revision <= 0
            || self.binding_digest.len() != 32
            || self.relay_origin.is_empty()
            || self.relay_origin.len() > 2048
            || self.source_instance_id == self.target_instance_id
        {
            return Err(invalid("connect_transfer_invalid_identity"));
        }
        for bytes in [
            &self.binding_json,
            &self.expectation_json,
            &self.reserve_request,
        ] {
            control(bytes, CONTROL)?;
        }
        fingerprint(self)
    }
}
/// Compose the existing canonical transport with the real browser/native freeze.
/// A persisted reservation can never reconstruct the transport argument.
pub(crate) async fn reserve_verified_source(
    owner: &DbPool,
    runtime: &crate::db::chat_admission::runtime::ChatAdmissionRuntime,
    caller: &str,
    browser: &str,
    inspection: &str,
    transport: &std::sync::Arc<crate::commands::pilot_secrets::transport::VerifiedTransport>,
    sent: &serde_json::Value,
) -> DbResult<(Reservation, LocalReservation)> {
    transport.check_reserve(sent).await.map_err(invalid)?;
    let input = reservation_intent(
        transport,
        sent,
        &sent["request"]["body"]["binding"],
        &sent["request"]["body"]["frozen"],
    )?;
    let native_freeze_hash = hash(
        &serde_json::to_vec(&input.expected_content)
            .map_err(|_| invalid("connect_native_freeze"))?,
    )
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect::<String>();
    if sent["request"]["body"]["frozen"]["sha256"] != native_freeze_hash {
        return Err(invalid("connect_native_freeze"));
    }
    let receipt = runtime
        .reserve_reconciled_transfer(owner, caller, browser, inspection, &input)
        .await?;
    if !receipt.native_source_frozen {
        return Err(invalid("connect_replay_requires_live_owner"));
    }
    transport.check().await.map_err(invalid)?;
    Ok((input, receipt))
}
/// The conversation's unresolved source attempt, for reconciliation after a lost
/// reply or an interrupted process. Its intent is the stored reserve request,
/// whose fingerprint must match the row; the source is already frozen. This
/// grants nothing: only a relay terminal later received by `transport` can
/// resolve it. Returns the reservation and that request.
pub(crate) async fn unresolved_source(
    owner: &DbPool,
    conversation: &str,
    transport: &std::sync::Arc<crate::commands::pilot_secrets::transport::VerifiedTransport>,
) -> DbResult<Option<(Reservation, serde_json::Value)>> {
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("unavailable"))?;
    let row=sqlx::query("SELECT fingerprint,reserve_request FROM connect_transfers WHERE local_role='source' AND source_conversation_id=? AND resolution IS NULL")
        .bind(conversation).fetch_optional(&guard.ready.pool).await?;
    let Some(row) = row else { return Ok(None) };
    let sent: serde_json::Value = serde_json::from_slice(&row.get::<Vec<u8>, _>("reserve_request"))
        .map_err(|_| invalid("connect_transfer_conflict"))?;
    let input = reservation_intent(
        transport,
        &sent,
        &sent["request"]["body"]["binding"],
        &sent["request"]["body"]["frozen"],
    )?;
    if input.inspect()?.0 != row.get::<Vec<u8>, _>("fingerprint") {
        return Err(invalid("connect_transfer_conflict"));
    }
    Ok(Some((input, sent)))
}
/// Conversations with an unresolved source attempt on this source instance,
/// with each attempt's target instance.
pub(crate) async fn unresolved_sources(
    owner: &DbPool,
    source_instance: &str,
) -> DbResult<Vec<(String, String)>> {
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("unavailable"))?;
    Ok(sqlx::query_as("SELECT source_conversation_id,target_instance_id FROM connect_transfers WHERE local_role='source' AND source_instance_id=? AND resolution IS NULL ORDER BY source_conversation_id")
        .bind(source_instance).fetch_all(&guard.ready.pool).await?)
}
// This constructor only copies intent. Its two callers first establish their
// live source freeze or authenticated target session; none is a receipt reader.
fn reservation_intent(
    transport: &std::sync::Arc<crate::commands::pilot_secrets::transport::VerifiedTransport>,
    sent: &serde_json::Value,
    b: &serde_json::Value,
    f: &serde_json::Value,
) -> DbResult<Reservation> {
    let source = &b["provenance"]["source"];
    let text = |v: &serde_json::Value| {
        v.as_str()
            .map(str::to_owned)
            .ok_or_else(|| invalid("connect_transfer_invalid_input"))
    };
    let digest = text(&f["binding_digest"])?;
    let digest = (0..digest.len())
        .step_by(2)
        .map(|i| {
            digest
                .get(i..i + 2)
                .and_then(|v| u8::from_str_radix(v, 16).ok())
                .ok_or_else(|| invalid("connect_transfer_invalid_input"))
        })
        .collect::<DbResult<Vec<u8>>>()?;
    Ok(Reservation {
        transfer_id: text(&b["transfer_id"])?, relay_origin: text(&source["relay_origin"])?,
        account_id: text(&source["account_id"])?, source_instance_id: text(&source["source_instance_id"])?,
        source_conversation_id: text(&source["source_conversation_id"])?,
        source_epoch: text(&b["epoch"])?.parse().map_err(|_|invalid("connect_transfer_invalid_input"))?,
        target_instance_id: text(&b["target_instance_id"])?,
        source_generation: text(&b["source_producer_generation"])?, target_generation: text(&b["target_producer_generation"])?,
        binding_digest: digest, binding_json: serde_json::to_vec(b).map_err(|_|invalid("connect_transfer_invalid_input"))?,
        expectation_json: serde_json::to_vec(&serde_json::json!({"binding":b,"frozen":f,"manifest":null,"prepared":null,"terminal":null}))
            .map_err(|_|invalid("connect_transfer_invalid_input"))?,
        reserve_request: serde_json::to_vec(sent).map_err(|_|invalid("connect_transfer_invalid_input"))?,
        expected_ownership_revision: text(&f["ownership_revision"])?.parse().map_err(|_|invalid("connect_transfer_invalid_input"))?,
        expected_content: ConversationContentToken { version:1,
            incarnation:text(&f["content_incarnation"])?,revision:text(&f["content_revision"])? },
        native_authority:Some(transport.clone()),native_target_prepared:None,native_target_activation:None,
        native_lineage_id:text(&b["provenance"]["lineage_id"])?,
        native_installation_id:text(&b["provenance"]["installation_id"])?,
        native_birth_generation:text(&b["provenance"]["birth_generation"])?,
    })
}
pub(crate) async fn reserve_verified_target(
    owner: &DbPool,
    transport: &std::sync::Arc<crate::commands::pilot_secrets::transport::VerifiedTransport>,
    sent: &serde_json::Value,
    manifest: &serde_json::Value,
) -> DbResult<Reservation> {
    transport
        .check_target_transfer(sent, manifest)
        .await
        .map_err(invalid)?;
    let input = reservation_intent(transport, sent, &sent["binding"], &sent["frozen"])?;
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("unavailable"))?;
    reserve_target(&guard.ready.pool, &input).await?;
    transport.check().await.map_err(invalid)?;
    Ok(input)
}
impl Reservation {
    async fn native_terminal(&self) -> DbResult<serde_json::Value> {
        self.native_terminal_with("committed").await
    }
    async fn native_terminal_with(&self, outcome: &str) -> DbResult<serde_json::Value> {
        use crate::commands::pilot_secrets::transport::commitment;
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        let terminal = live.terminal(&self.transfer_id).await.map_err(invalid)?;
        if terminal["outcome"] != outcome {
            return Err(invalid("connect_terminal_mismatch"));
        }
        // Original native intent, never reconstructed from a SQL receipt. Fresh
        // authority is the private authenticated terminal above.
        let binding: serde_json::Value = serde_json::from_slice(&self.binding_json)
            .map_err(|_| invalid("connect_native_binding_changed"))?;
        let expectation: serde_json::Value = serde_json::from_slice(&self.expectation_json)
            .map_err(|_| invalid("connect_native_binding_changed"))?;
        let frozen = &expectation["frozen"];
        if terminal["source"] != binding["provenance"]["source"]
            || terminal["epoch"] != binding["epoch"]
            || terminal["target_instance_id"] != self.target_instance_id
            || terminal["binding_digest"]
                != commitment("transfer-binding", &binding).map_err(invalid)?
            || terminal["frozen_digest"] != commitment("frozen", frozen).map_err(invalid)?
        {
            return Err(invalid("connect_terminal_mismatch"));
        }
        Ok(terminal)
    }
    pub(crate) async fn publish_target(
        &mut self,
        owner: &DbPool,
        config: &crate::config::ConfigManager,
        prepared: &crate::connect::transfer_worker::TransferWorker,
    ) -> DbResult<String> {
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        live.check_producer(
            &self.account_id,
            &self.target_instance_id,
            &self.target_generation,
        )
        .await
        .map_err(invalid)?;
        let terminal = self.native_terminal().await?;
        let pin = self.target_prepared().await?;
        if terminal["prepared"] != *pin {
            return Err(invalid("connect_terminal_mismatch"));
        }
        let (_, request, _, configuration) = prepared.native_prepared().map_err(invalid)?;
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        let (_, _, _, fresh) = crate::connect::runtime::transfer_target_snapshot(
            config,
            &guard.ready,
            &request.provider_id,
            &request.model_id,
        )
        .await
        .map_err(invalid)?;
        let row=sqlx::query("SELECT t.fingerprint,t.restore_hold,p.fingerprint AS preparation_fingerprint,p.local_generation,p.phase,p.pin_receipt,p.configuration_digest,p.target_conversation_id FROM connect_transfers t JOIN connect_preparations p USING(transfer_id) WHERE transfer_id=? AND t.local_role='target'").bind(&self.transfer_id).fetch_one(&guard.ready.pool).await?;
        if row.get::<Vec<u8>, _>("fingerprint") != self.inspect()?.0
            || row.get::<i64, _>("restore_hold") != 0
            || row.get::<String, _>("phase") != "pinned"
            || row.get::<String, _>("local_generation") != guard.ready.catalog_generation
            || row.get::<Vec<u8>, _>("pin_receipt")
                != serde_json::to_vec(pin)
                    .map_err(|_| invalid("connect_preparation_invalid_input"))?
            || row.get::<Vec<u8>, _>("configuration_digest") != configuration
            || fresh != configuration
            || request.conversation_id.as_deref()
                != Some(row.get::<String, _>("target_conversation_id").as_str())
        {
            return Err(invalid("connect_target_effect_changed"));
        }
        live.check().await.map_err(invalid)?;
        let terminal_fingerprint = super::terminal::store_committed(
            &guard.ready.pool,
            &self.transfer_id,
            self.inspect()?.0,
            self.binding_digest.clone(),
            self.source_epoch,
            &terminal,
            false,
        )
        .await?;
        let result = super::publication::publish(
            &guard.ready.pool,
            &super::publication::PublishWrite {
                transfer_id: self.transfer_id.clone(),
                terminal_fingerprint,
                preparation_fingerprint: row.get("preparation_fingerprint"),
                local_generation: guard.ready.catalog_generation.clone(),
                configuration_digest: fresh,
            },
        )
        .await?;
        if result.disposition != super::publication::LocalDisposition::Published {
            return Err(invalid("connect_publication_removed"));
        }
        live.check().await.map_err(invalid)?;
        use crate::commands::pilot_secrets::transport::commitment;
        self.native_target_activation = Some(
            serde_json::json!({"decision_contract":"transfer-decision-1","type":"activation_receipt",
            "receipt_id":uuid::Uuid::new_v4(),"transfer_id":self.transfer_id,"terminal_digest":commitment("terminal",&terminal).map_err(invalid)?,
            "target_instance_id":self.target_instance_id,"target_conversation_id":result.conversation_id,
            "prepared_digest":commitment("prepared",pin).map_err(invalid)?,"revision":"1"}),
        );
        Ok(result.conversation_id)
    }
    pub(crate) fn target_activation(&self) -> DbResult<&serde_json::Value> {
        self.native_target_activation
            .as_ref()
            .ok_or_else(|| invalid("connect_native_publication_missing"))
    }
    pub(crate) async fn apply_committed_source(
        &self,
        owner: &DbPool,
        normalized: &crate::connect::transfer_worker::TransferWorker,
    ) -> DbResult<()> {
        use crate::commands::pilot_secrets::transport::commitment;
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        live.check_producer(
            &self.account_id,
            &self.source_instance_id,
            &self.source_generation,
        )
        .await
        .map_err(invalid)?;
        let terminal = self.native_terminal().await?;
        let activation = live
            .committed_activation(&self.transfer_id)
            .await
            .map_err(invalid)?;
        let manifest = self.source_manifest(owner, normalized).await?;
        if terminal["manifest_digest"] != commitment("manifest", &manifest).map_err(invalid)?
            || activation["target_instance_id"] != self.target_instance_id
        {
            return Err(invalid("connect_terminal_mismatch"));
        }
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        live.check().await.map_err(invalid)?;
        super::terminal::store_committed(
            &guard.ready.pool,
            &self.transfer_id,
            self.inspect()?.0,
            self.binding_digest.clone(),
            self.source_epoch,
            &terminal,
            true,
        )
        .await?;
        Ok(())
    }
    /// Once the relay has durably recorded `aborted`, resolves this target
    /// attempt and releases its staged import and projection.
    pub(crate) async fn apply_aborted_target(&self, owner: &DbPool) -> DbResult<()> {
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        let terminal = self.native_terminal_with("aborted").await?;
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        live.check().await.map_err(invalid)?;
        super::terminal::store_aborted_target(
            &guard.ready.pool,
            &self.transfer_id,
            self.inspect()?.0,
            self.binding_digest.clone(),
            self.source_epoch,
            &terminal,
        )
        .await
    }
    /// Reopens the source once the relay has durably recorded `aborted`.
    pub(crate) async fn apply_aborted_source(&self, owner: &DbPool) -> DbResult<()> {
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        let terminal = self.native_terminal_with("aborted").await?;
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        live.check().await.map_err(invalid)?;
        super::terminal::store_aborted_source(
            &guard.ready.pool,
            &self.transfer_id,
            self.inspect()?.0,
            self.binding_digest.clone(),
            self.source_epoch,
            &terminal,
        )
        .await
    }
    pub(crate) async fn target_expectation(
        &self,
        owner: &DbPool,
        config: &crate::config::ConfigManager,
        prepared: &crate::connect::transfer_worker::TransferWorker,
        request: &serde_json::Value,
        kind: &str,
    ) -> DbResult<serde_json::Value> {
        use crate::commands::pilot_secrets::transport::commitment;
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        live.check_producer(
            &self.account_id,
            &self.target_instance_id,
            &self.target_generation,
        )
        .await
        .map_err(invalid)?;
        let pin = self.target_prepared().await?;
        let (_, native_request, _, configuration) = prepared.native_prepared().map_err(invalid)?;
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        let (_, _, _, fresh) = crate::connect::runtime::transfer_target_snapshot(
            config,
            &guard.ready,
            &native_request.provider_id,
            &native_request.model_id,
        )
        .await
        .map_err(invalid)?;
        let row=sqlx::query("SELECT t.fingerprint,t.restore_hold,t.terminal_outcome,t.resolution,p.local_generation,p.phase,p.pin_receipt,p.configuration_digest,p.prepared_digest,p.target_conversation_id FROM connect_transfers t JOIN connect_preparations p USING(transfer_id) WHERE transfer_id=? AND t.local_role='target'").bind(&self.transfer_id).fetch_one(&guard.ready.pool).await?;
        let digest = commitment("prepared", pin).map_err(invalid)?;
        let activated = kind == "target_activated";
        if row.get::<Vec<u8>, _>("fingerprint") != self.inspect()?.0
            || row.get::<i64, _>("restore_hold") != 0
            || if activated {
                row.get::<Option<String>, _>("terminal_outcome").as_deref() != Some("committed")
                    || row.get::<Option<String>, _>("resolution").as_deref() != Some("committed")
            } else {
                row.get::<Option<String>, _>("terminal_outcome").is_some()
                    || row.get::<Option<String>, _>("resolution").is_some()
            }
            || row.get::<String, _>("phase") != if activated { "published" } else { "pinned" }
            || row.get::<String, _>("local_generation") != guard.ready.catalog_generation
            || row.get::<Vec<u8>, _>("configuration_digest") != configuration
            || fresh != configuration
            || row.get::<Vec<u8>, _>("pin_receipt")
                != serde_json::to_vec(pin)
                    .map_err(|_| invalid("connect_preparation_invalid_input"))?
            || row
                .get::<Vec<u8>, _>("prepared_digest")
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
                != digest
            || native_request.conversation_id.as_deref()
                != Some(row.get::<String, _>("target_conversation_id").as_str())
        {
            return Err(invalid("connect_target_effect_changed"));
        }
        let (subject, prior) = if activated {
            let activation = self.target_activation()?;
            let terminal = self.native_terminal().await?;
            let stored:i64=sqlx::query_scalar("SELECT COUNT(*) FROM connect_activation_receipts WHERE transfer_id=? AND conversation_id=? AND terminal_digest=?")
                .bind(&self.transfer_id).bind(&request["body"]["activation"]["target_conversation_id"].as_str().unwrap_or_default())
                .bind(super::preparation::native_digest_bytes(&commitment("terminal",&terminal).map_err(invalid)?)?).fetch_one(&guard.ready.pool).await?;
            if request["operation"] != "activation.record"
                || request["body"]["activation"] != *activation
                || terminal["prepared"] != *pin
                || stored != 1
            {
                return Err(invalid("connect_proof_mismatch"));
            }
            (
                commitment("activation", activation).map_err(invalid)?,
                serde_json::json!(commitment("terminal", &terminal).map_err(invalid)?),
            )
        } else {
            (
                digest.clone(),
                match kind {
                    "target_pinned"
                        if request["operation"] == "ready"
                            && request["body"]["prepared"] == *pin =>
                    {
                        pin["manifest_digest"].clone()
                    }
                    "target_maintained" if request["operation"] == "commit" => {
                        serde_json::json!(digest)
                    }
                    _ => return Err(invalid("connect_proof_mismatch")),
                },
            )
        };
        if request["transfer_id"] != self.transfer_id {
            return Err(invalid("connect_proof_mismatch"));
        }
        let producer = live.producer_identity().map_err(invalid)?;
        Ok(
            serde_json::json!({"kind":kind,"binding_digest":self.binding_digest.iter().map(|b|format!("{b:02x}")).collect::<String>(),
            "subject_digest":subject,"instance_id":self.target_instance_id,"producer_generation":self.target_generation,
            "connection_id":producer["connection_id"],"request_digest":commitment("retry-body",request).map_err(invalid)?,"prior_receipt_digest":prior}),
        )
    }
    pub(crate) async fn check_target_attestation(
        &self,
        owner: &DbPool,
        config: &crate::config::ConfigManager,
        emitter: &crate::commands::pilot_secrets::transport::VerifiedTransport,
        prepared: &crate::connect::transfer_worker::TransferWorker,
        request: &serde_json::Value,
        exchange: &serde_json::Value,
    ) -> DbResult<()> {
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        if !std::ptr::eq(live.as_ref(), emitter) {
            return Err(invalid("connect_native_owner_changed"));
        }
        let expected = self
            .target_expectation(
                owner,
                config,
                prepared,
                request,
                exchange["kind"]
                    .as_str()
                    .ok_or_else(|| invalid("connect_proof_mismatch"))?,
            )
            .await?;
        for (name, value) in expected
            .as_object()
            .ok_or_else(|| invalid("connect_proof_mismatch"))?
        {
            if &exchange[name] != value {
                return Err(invalid("connect_proof_mismatch"));
            }
        }
        Ok(())
    }
    pub(crate) async fn pin_target(
        &mut self,
        owner: &DbPool,
        config: &crate::config::ConfigManager,
        imported: &crate::connect::transfer_worker::TransferWorker,
        prepared: &mut crate::connect::transfer_worker::TransferWorker,
        sent: &serde_json::Value,
        manifest: &serde_json::Value,
    ) -> DbResult<()> {
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        let session = live
            .check_target_transfer(sent, manifest)
            .await
            .map_err(invalid)?;
        if session["transfer_id"] != self.transfer_id
            || serde_json::to_vec(sent).map_err(|_| invalid("connect_transfer_invalid_input"))?
                != self.reserve_request
            || self.native_target_prepared.is_some()
        {
            return Err(invalid("connect_native_binding_changed"));
        }
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        let expected = self.inspect()?.0;
        let value = super::preparation::pin_native(
            &guard.ready,
            config,
            &expected,
            &sent["binding"],
            manifest,
            imported,
            prepared,
        )
        .await?;
        live.check_target_transfer(sent, manifest)
            .await
            .map_err(invalid)?;
        self.native_target_prepared = Some(value);
        Ok(())
    }
    pub(crate) async fn target_prepared(&self) -> DbResult<&serde_json::Value> {
        self.native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?
            .check()
            .await
            .map_err(invalid)?;
        self.native_target_prepared
            .as_ref()
            .ok_or_else(|| invalid("connect_target_not_pinned"))
    }
    pub(crate) async fn attach_imported_target(
        &self,
        owner: &DbPool,
        sent: &serde_json::Value,
        manifest: &serde_json::Value,
        imported: &crate::connect::transfer_worker::TransferWorker,
    ) -> DbResult<()> {
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        live.check_target_transfer(sent, manifest)
            .await
            .map_err(invalid)?;
        let completed = imported.imported_storage().map_err(invalid)?;
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        attach_import(&guard.ready.pool, self, &completed.receipt.key).await?;
        live.check().await.map_err(invalid)
    }
    pub(crate) async fn staged_target(
        &self,
        owner: &DbPool,
        sent: &serde_json::Value,
        manifest: &serde_json::Value,
    ) -> DbResult<Vec<u8>> {
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        let session = live
            .check_target_transfer(sent, manifest)
            .await
            .map_err(invalid)?;
        if session["transfer_id"] != self.transfer_id {
            return Err(invalid("connect_transfer_session_conflict"));
        }
        let text = |v: &serde_json::Value| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid("connect_transfer_invalid_input"))
        };
        let length = text(&session["stream_bytes"])?
            .parse::<i64>()
            .map_err(|_| invalid("connect_transfer_invalid_input"))?;
        if length <= 0 || length > 8 * 1024 * 1024 {
            return Err(invalid("resource_limit"));
        }
        let prefix = super::staging::Session {
            transfer_id: self.transfer_id.clone(),
            transit_id: text(&session["transit_id"])?,
            producer_generation: self.target_generation.clone(),
            binding_digest: self.binding_digest.clone(),
            session_json: serde_json::to_vec(&session)
                .map_err(|_| invalid("connect_transfer_invalid_input"))?,
            stream_bytes: length,
        };
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        let status = super::staging::open_prefix(&guard.ready.pool, &prefix).await?;
        if !status.eof || status.next_offset != length {
            return Err(invalid("connect_transfer_incomplete"));
        }
        let mut archive = Vec::with_capacity(length as usize);
        for sequence in 0..status.next_sequence {
            let bytes = super::staging::read_chunk(&guard.ready.pool, &prefix, sequence).await?;
            if bytes.len() > length as usize - archive.len() {
                return Err(invalid("resource_limit"));
            }
            archive.extend(bytes);
        }
        live.check().await.map_err(invalid)?;
        Ok(archive)
    }
    pub(crate) async fn stage_target(
        &self,
        owner: &DbPool,
        sent: &serde_json::Value,
        manifest: &serde_json::Value,
        chunk: &serde_json::Value,
    ) -> DbResult<(i64, i64, bool)> {
        use crate::commands::pilot_secrets::transport::commitment;
        let live = self
            .native_authority
            .as_ref()
            .ok_or_else(|| invalid("connect_native_owner_missing"))?;
        let session = live
            .check_target_transfer(sent, manifest)
            .await
            .map_err(invalid)?;
        if session["transfer_id"] != self.transfer_id
            || chunk["transfer_id"] != self.transfer_id
            || chunk["transit_id"] != session["transit_id"]
            || session["binding_digest"]
                != commitment("transfer-binding", &sent["binding"]).map_err(invalid)?
        {
            return Err(invalid("connect_transfer_session_conflict"));
        }
        let text = |v: &serde_json::Value| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid("connect_transfer_invalid_input"))
        };
        let number = |v: &serde_json::Value| {
            text(v)?
                .parse::<i64>()
                .map_err(|_| invalid("connect_transfer_invalid_input"))
        };
        let raw = text(&chunk["data_utf8"])?;
        let digest = hash(raw.as_bytes());
        if text(&chunk["sha256"])?
            != digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
            || number(&chunk["length"])? != raw.len() as i64
        {
            return Err(invalid("connect_transfer_integrity_failed"));
        }
        let prefix = super::staging::Session {
            transfer_id: self.transfer_id.clone(),
            transit_id: text(&session["transit_id"])?,
            producer_generation: self.target_generation.clone(),
            binding_digest: self.binding_digest.clone(),
            session_json: serde_json::to_vec(&session)
                .map_err(|_| invalid("connect_transfer_invalid_input"))?,
            stream_bytes: number(&session["stream_bytes"])?,
        };
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("unavailable"))?;
        super::staging::open_prefix(&guard.ready.pool, &prefix).await?;
        let committed = super::staging::stage(
            &guard.ready.pool,
            &prefix,
            &super::staging::Chunk {
                sequence: number(&chunk["sequence"])?,
                offset: number(&chunk["offset"])?,
                sha256: &digest,
                data: raw.as_bytes(),
                eof: chunk["eof"]
                    .as_bool()
                    .ok_or_else(|| invalid("connect_transfer_invalid_input"))?,
            },
        )
        .await?;
        live.check().await.map_err(invalid)?;
        Ok((
            committed.next_sequence,
            committed.next_offset,
            committed.eof,
        ))
    }
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct LocalReservation {
    pub transfer_id: String,
    pub fingerprint: Vec<u8>,
    pub ownership_revision: Option<i64>,
    // In-memory result of this transaction, never loaded from a SQL receipt.
    native_source_frozen: bool,
}
async fn existing(
    db: &mut SqliteConnection,
    input: &Reservation,
    role: &str,
    digest: &[u8],
) -> DbResult<Option<LocalReservation>> {
    super::deletion::require_transfer(db, &input.transfer_id).await?;
    let row = sqlx::query("SELECT local_role,fingerprint,ownership_revision FROM connect_transfers WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_optional(db).await?;
    row.map(|row| {
        if row.get::<String, _>("local_role") != role
            || row.get::<Vec<u8>, _>("fingerprint") != digest
        {
            return Err(invalid("connect_transfer_conflict"));
        }
        Ok(LocalReservation {
            transfer_id: input.transfer_id.clone(),
            fingerprint: digest.to_vec(),
            ownership_revision: row.get("ownership_revision"),
            native_source_frozen: false,
        })
    })
    .transpose()
}
async fn insert(
    db: &mut SqliteConnection,
    input: &Reservation,
    role: &str,
    frozen: Option<&reconciliation::FrozenSource>,
    digest: &[u8],
    bytes: i64,
) -> DbResult<LocalReservation> {
    let high: Option<i64> = sqlx::query_scalar("SELECT MAX(source_epoch) FROM connect_transfers WHERE relay_origin=? AND account_id=? AND source_instance_id=? AND source_conversation_id=?")
        .bind(&input.relay_origin).bind(&input.account_id).bind(&input.source_instance_id).bind(&input.source_conversation_id).fetch_one(&mut *db).await?;
    if high.is_some_and(|high| input.source_epoch <= high) {
        return Err(invalid("connect_transfer_stale_epoch"));
    }
    // Three identity/index keys plus the PK and optional resource indexes.
    let key = add(
        add(
            input.relay_origin.len() as i64,
            input.account_id.len() as i64,
        )?,
        add(
            input.source_instance_id.len() as i64,
            input.source_conversation_id.len() as i64,
        )?,
    )?;
    let extra = charge(
        bytes,
        add(
            key.checked_mul(3)
                .ok_or_else(|| invalid("resource_limit"))?,
            256,
        )?,
        512,
    )?;
    admit_journal(db, extra).await?;
    sqlx::query("INSERT INTO connect_transfers(transfer_id,local_role,relay_origin,account_id,source_instance_id,source_conversation_id,source_epoch,target_instance_id,source_generation,target_generation,binding_digest,binding_json,expectation_json,reserve_request,fingerprint,local_generation,ownership_incarnation,ownership_revision,content_incarnation,content_revision,phase,charge_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&input.transfer_id).bind(role).bind(&input.relay_origin).bind(&input.account_id).bind(&input.source_instance_id).bind(&input.source_conversation_id).bind(input.source_epoch).bind(&input.target_instance_id).bind(&input.source_generation).bind(&input.target_generation)
        .bind(&input.binding_digest).bind(&input.binding_json).bind(&input.expectation_json).bind(&input.reserve_request).bind(digest)
        .bind(frozen.map(|f| f.generation.as_str())).bind(frozen.map(|f| f.incarnation.as_str())).bind(frozen.map(|f| f.revision)).bind(frozen.map(|f| f.content.incarnation.as_str())).bind(frozen.map(|f| f.content.revision.as_str())).bind(if role=="source" {"reserved"} else {"receiving"}).bind(extra)
        .execute(db).await?;
    Ok(LocalReservation {
        transfer_id: input.transfer_id.clone(),
        fingerprint: digest.to_vec(),
        ownership_revision: frozen.map(|f| f.revision),
        native_source_frozen: frozen.is_some(),
    })
}
/// Called only under the live browser lifecycle/inspection locks. Journal insert,
/// real 017 recheck and freeze share this FULL-synchronous transaction.
pub(in crate::db) async fn reserve_source(
    owner: &DbPool,
    snapshot: &Snapshot,
    input: &Reservation,
) -> DbResult<LocalReservation> {
    let (digest, bytes) = input.inspect()?;
    let guard = owner
        .source_ready(Some(snapshot.generation()))
        .await
        .map_err(|_| invalid("chat_admission_stale_generation"))?;
    let mut lease = lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    if input.source_conversation_id != snapshot.conversation {
        return Err(invalid("connect_transfer_conflict"));
    }
    if let Some(receipt) = existing(&mut tx, input, "source", &digest).await? {
        // A replay is a receipt read, never permission to emit or to unfreeze.
        tx.commit().await?;
        lease.committed = true;
        return Ok(receipt);
    }
    let frozen = reconciliation::freeze_in(&mut tx, snapshot).await?;
    if frozen.revision != input.expected_ownership_revision
        || frozen.content != input.expected_content
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    let receipt = insert(&mut tx, input, "source", Some(&frozen), &digest, bytes).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(receipt)
}
async fn reserve_target(pool: &SqlitePool, input: &Reservation) -> DbResult<LocalReservation> {
    let (digest, bytes) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let receipt = match existing(&mut tx, input, "target", &digest).await? {
        Some(receipt) => receipt,
        None => insert(&mut tx, input, "target", None, &digest, bytes).await?,
    };
    tx.commit().await?;
    lease.committed = true;
    Ok(receipt)
}
/// No externally usable lease handle is returned. References in the journal own
/// retention even after the process, window or original test object disappears.
async fn attach_capture(pool: &SqlitePool, input: &Reservation, capture: &str) -> DbResult<()> {
    let (digest, _) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    existing(&mut tx, input, "source", &digest)
        .await?
        .ok_or_else(|| invalid("connect_transfer_not_found"))?;
    let row = sqlx::query("SELECT source_capture_id,local_generation,content_incarnation,content_revision,restore_hold,phase FROM connect_transfers WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_one(&mut *tx).await?;
    if row.get::<i64, _>("restore_hold") != 0
        || row.get::<String, _>("phase") == "reconciliation_required"
    {
        return Err(invalid("connect_transfer_recovery_hold"));
    }
    let id = crate::db::source_capture::transfer_attachment(
        &mut tx,
        capture,
        &input.source_conversation_id,
        &row.get::<String, _>("local_generation"),
        &input.expected_content,
    )
    .await?;
    if row
        .get::<Option<i64>, _>("source_capture_id")
        .is_some_and(|old| old != id)
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    sqlx::query("UPDATE connect_transfers SET source_capture_id=? WHERE transfer_id=?")
        .bind(id)
        .bind(&input.transfer_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}
async fn attach_import(pool: &SqlitePool, input: &Reservation, key: &str) -> DbResult<()> {
    let (digest, _) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    existing(&mut tx, input, "target", &digest)
        .await?
        .ok_or_else(|| invalid("connect_transfer_not_found"))?;
    let current: (Option<i64>, i64, String) = sqlx::query_as(
        "SELECT inactive_import_id,restore_hold,phase FROM connect_transfers WHERE transfer_id=?",
    )
    .bind(&input.transfer_id)
    .fetch_one(&mut *tx)
    .await?;
    if current.1 != 0 || current.2 == "reconciliation_required" {
        return Err(invalid("connect_transfer_recovery_hold"));
    }
    let row = sqlx::query("SELECT id,begin_json FROM e_inactive_imports WHERE identity_key=? AND length(CAST(begin_json AS BLOB))<=4096 AND phase BETWEEN 0 AND 2").bind(key).fetch_optional(&mut *tx).await?.ok_or_else(|| invalid("connect_transfer_import_unavailable"))?;
    let begin: crate::db::inactive_storage::Begin =
        serde_json::from_str(&row.get::<String, _>("begin_json"))
            .map_err(|_| invalid("connect_transfer_import_unavailable"))?;
    let identity = &begin.identity;
    if identity.origin != input.relay_origin
        || identity.account_incarnation != input.account_id
        || identity.source_instance != input.source_instance_id
        || identity.source_conversation != input.source_conversation_id
        || identity.transfer != input.transfer_id
        || identity.source_epoch != input.source_epoch.to_string()
        || begin.bindings.target_instance != input.target_instance_id
        || begin.bindings.source_generation != input.source_generation
        || begin.bindings.target_generation != input.target_generation
        || crate::db::inactive_storage::identity_key(identity)
            .map_err(|_| invalid("connect_transfer_conflict"))?
            != key
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    let id: i64 = row.get("id");
    if current.0.is_some_and(|old| old != id) {
        return Err(invalid("connect_transfer_conflict"));
    }
    sqlx::query("UPDATE connect_transfers SET inactive_import_id=? WHERE transfer_id=?")
        .bind(id)
        .bind(&input.transfer_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

#[derive(Serialize)]
struct Exchange {
    delivery_id: String,
    transfer_id: String,
    challenge_id: String,
    request_id: String,
    kind: String,
    subject_digest: Vec<u8>,
    prior_receipt_digest: Option<Vec<u8>>,
    producer_generation: String,
    connection_id: String,
    canonical_request: Vec<u8>,
    expectation_json: Vec<u8>,
}
impl Exchange {
    fn inspect(&self) -> DbResult<(Vec<u8>, i64)> {
        uuid(&self.delivery_id)?;
        uuid(&self.challenge_id)?;
        uuid(&self.connection_id)?;
        if self.request_id.is_empty()
            || self.request_id.len() > 128
            || self.producer_generation.is_empty()
            || self.producer_generation.len() > 128
            || self.subject_digest.len() != 32
            || self
                .prior_receipt_digest
                .as_ref()
                .is_some_and(|v| v.len() != 32)
        {
            return Err(invalid("connect_transfer_invalid_input"));
        }
        control(&self.canonical_request, CONTROL)?;
        control(&self.expectation_json, CONTROL)?;
        fingerprint(self)
    }
}
async fn prior_exchange(
    db: &mut SqliteConnection,
    input: &Exchange,
    digest: &[u8],
) -> DbResult<bool> {
    let old:Option<Vec<u8>>=sqlx::query_scalar("SELECT fingerprint FROM connect_exchanges WHERE delivery_id=? UNION ALL SELECT previous_fingerprint FROM connect_exchanges WHERE previous_delivery_id=?")
        .bind(&input.delivery_id).bind(&input.delivery_id).fetch_optional(&mut *db).await?;
    if let Some(old) = old {
        if old != digest {
            return Err(invalid("connect_transfer_conflict"));
        }
        return Ok(true);
    }
    let collision:i64=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_exchanges WHERE challenge_id=? OR previous_challenge_id=?)")
        .bind(&input.challenge_id).bind(&input.challenge_id).fetch_one(db).await?;
    if collision != 0 {
        return Err(invalid("connect_transfer_conflict"));
    }
    Ok(false)
}
async fn check_new_exchange(db: &mut SqliteConnection, input: &Exchange) -> DbResult<()> {
    super::deletion::require_transfer(db, &input.transfer_id).await?;
    let role:Option<(String,String,String,i64,String,Option<String>,Option<String>)>=sqlx::query_as("SELECT local_role,source_generation,target_generation,restore_hold,phase,resolution,terminal_outcome FROM connect_transfers WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_optional(db).await?;
    let (role, source, target, hold, phase, resolution, terminal) =
        role.ok_or_else(|| invalid("connect_transfer_not_found"))?;
    if hold != 0
        || phase == "reconciliation_required"
        || input.producer_generation != if role == "source" { source } else { target }
    {
        return Err(invalid("connect_transfer_recovery_hold"));
    }
    if (terminal.is_some() || resolution.is_some())
        && !(role == "target"
            && resolution.as_deref() == Some("committed")
            && input.kind == "target_activated")
    {
        return Err(invalid("connect_transfer_terminal"));
    }
    if (role == "source"
        && !matches!(
            input.kind.as_str(),
            "source_frozen" | "source_sealed" | "source_maintained"
        ))
        || (role == "target"
            && !matches!(
                input.kind.as_str(),
                "target_pinned" | "target_maintained" | "target_activated"
            ))
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    Ok(())
}
async fn accept_exchange(pool: &SqlitePool, input: &Exchange) -> DbResult<Vec<u8>> {
    let (digest, bytes) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    if !prior_exchange(&mut tx, input, &digest).await? {
        check_new_exchange(&mut tx, input).await?;
        let occupied: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM connect_exchanges WHERE transfer_id=? AND kind=?)",
        )
        .bind(&input.transfer_id)
        .bind(&input.kind)
        .fetch_one(&mut *tx)
        .await?;
        if occupied != 0 {
            return Err(invalid("connect_transfer_renewal_required"));
        }
        let extra = charge(bytes, 512, 256)?;
        admit_journal(&mut tx, extra).await?;
        sqlx::query("INSERT INTO connect_exchanges(delivery_id,transfer_id,challenge_id,request_id,kind,subject_digest,prior_receipt_digest,producer_generation,connection_id,canonical_request,expectation_json,fingerprint,phase,charge_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'accepted',?)")
            .bind(&input.delivery_id).bind(&input.transfer_id).bind(&input.challenge_id).bind(&input.request_id).bind(&input.kind).bind(&input.subject_digest).bind(&input.prior_receipt_digest).bind(&input.producer_generation).bind(&input.connection_id).bind(&input.canonical_request).bind(&input.expectation_json).bind(&digest).bind(extra).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(digest)
}
/// A persisted adapter receipt, not an authentication capability. Only the
/// future canonical receiver may supply its closed bytes to this private owner.
/// No constructor or caller is exposed in product composition.
struct RecordedExchange {
    transfer_id: String,
    kind: String,
    delivery_id: String,
    fingerprint: Vec<u8>,
    receipt: Vec<u8>,
}
async fn record_exchange_receipt(
    pool: &SqlitePool,
    delivery: &str,
    expected_fingerprint: &[u8],
    receipt: &[u8],
) -> DbResult<RecordedExchange> {
    control(receipt, CONTROL)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let row=sqlx::query("SELECT transfer_id,kind,fingerprint,phase,relay_receipt FROM connect_exchanges WHERE delivery_id=? UNION ALL SELECT transfer_id,kind,previous_fingerprint AS fingerprint,'result_recorded' AS phase,previous_relay_receipt AS relay_receipt FROM connect_exchanges WHERE previous_delivery_id=?")
        .bind(delivery).bind(delivery).fetch_one(&mut *tx).await?;
    let digest: Vec<u8> = row.get("fingerprint");
    let old: Option<Vec<u8>> = row.get("relay_receipt");
    if digest != expected_fingerprint || old.as_deref().is_some_and(|v| v != receipt) {
        return Err(invalid("connect_transfer_conflict"));
    }
    if old.is_none() {
        if row.get::<String, _>("phase") != "result_pending" {
            return Err(invalid("connect_transfer_result_missing"));
        }
        let extra = receipt.len() as i64;
        admit(&mut tx, extra).await?;
        sqlx::query("UPDATE connect_exchanges SET relay_receipt=?,phase='result_recorded',charge_bytes=charge_bytes+? WHERE delivery_id=?")
            .bind(receipt).bind(extra).bind(delivery).execute(&mut *tx).await?;
    }
    let recorded = RecordedExchange {
        transfer_id: row.get("transfer_id"),
        kind: row.get("kind"),
        delivery_id: delivery.into(),
        fingerprint: digest,
        receipt: receipt.to_vec(),
    };
    tx.commit().await?;
    lease.committed = true;
    Ok(recorded)
}
/// Maintenance is renewable after its prior result was recorded. Keep the
/// immediately preceding receipt for exact retries; replace only this slot.
/// Older deliveries cannot enter through accept_exchange while the slot exists.
/// A future renewal caller must independently authenticate the new outstanding
/// canonical challenge; the predecessor here proves local storage only.
async fn renew_maintained_exchange(
    pool: &SqlitePool,
    input: &Exchange,
    previous: &RecordedExchange,
) -> DbResult<Vec<u8>> {
    if !matches!(
        input.kind.as_str(),
        "source_maintained" | "target_maintained"
    ) || input.transfer_id != previous.transfer_id
        || input.kind != previous.kind
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    let (digest, bytes) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    if !prior_exchange(&mut tx, input, &digest).await? {
        check_new_exchange(&mut tx, input).await?;
        let row=sqlx::query("SELECT delivery_id,challenge_id,fingerprint,local_result,relay_receipt,phase,charge_bytes FROM connect_exchanges WHERE transfer_id=? AND kind=?")
            .bind(&input.transfer_id).bind(&input.kind).fetch_one(&mut *tx).await?;
        let old_result: Option<Vec<u8>> = row.get("local_result");
        let old_receipt: Option<Vec<u8>> = row.get("relay_receipt");
        if row.get::<String, _>("delivery_id") != previous.delivery_id
            || row.get::<Vec<u8>, _>("fingerprint") != previous.fingerprint
            || old_receipt.as_deref() != Some(previous.receipt.as_slice())
            || row.get::<String, _>("phase") != "result_recorded"
        {
            return Err(invalid("connect_transfer_conflict"));
        }
        let old_result = old_result.ok_or_else(|| invalid("connect_transfer_result_missing"))?;
        let old_receipt = old_receipt.ok_or_else(|| invalid("connect_transfer_result_missing"))?;
        let retained_previous = charge(
            add(old_result.len() as i64, old_receipt.len() as i64)?,
            144,
            128,
        )?;
        let new_charge = add(charge(bytes, 512, 256)?, retained_previous)?;
        let delta = new_charge
            .checked_sub(row.get::<i64, _>("charge_bytes"))
            .ok_or_else(|| invalid("resource_limit"))?;
        if delta > 0 {
            admit(&mut tx, delta).await?;
        }
        sqlx::query("UPDATE connect_exchanges SET previous_delivery_id=delivery_id,previous_challenge_id=challenge_id,previous_fingerprint=fingerprint,previous_local_result=local_result,previous_relay_receipt=relay_receipt,delivery_id=?,challenge_id=?,request_id=?,subject_digest=?,prior_receipt_digest=?,producer_generation=?,connection_id=?,canonical_request=?,expectation_json=?,fingerprint=?,phase='accepted',local_result=NULL,relay_receipt=NULL,charge_bytes=? WHERE transfer_id=? AND kind=?")
            .bind(&input.delivery_id).bind(&input.challenge_id).bind(&input.request_id).bind(&input.subject_digest).bind(&input.prior_receipt_digest).bind(&input.producer_generation).bind(&input.connection_id).bind(&input.canonical_request).bind(&input.expectation_json).bind(&digest).bind(new_charge).bind(&input.transfer_id).bind(&input.kind).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(digest)
}
async fn record_local_result(
    pool: &SqlitePool,
    delivery: &str,
    expected_fingerprint: &[u8],
    result: &[u8],
) -> DbResult<()> {
    control(result, CONTROL)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let (fingerprint, old, hold, phase): (Vec<u8>, Option<Vec<u8>>, i64, String) = sqlx::query_as(
        "SELECT e.fingerprint,e.local_result,t.restore_hold,t.phase FROM connect_exchanges e JOIN connect_transfers t ON t.transfer_id=e.transfer_id WHERE e.delivery_id=? UNION ALL SELECT e.previous_fingerprint,e.previous_local_result,t.restore_hold,t.phase FROM connect_exchanges e JOIN connect_transfers t ON t.transfer_id=e.transfer_id WHERE e.previous_delivery_id=?",
    )
    .bind(delivery)
    .bind(delivery)
    .fetch_one(&mut *tx)
    .await?;
    if fingerprint != expected_fingerprint || old.as_deref().is_some_and(|old| old != result) {
        return Err(invalid("connect_transfer_conflict"));
    }
    if old.is_none() {
        if hold != 0 || phase == "reconciliation_required" {
            return Err(invalid("connect_transfer_recovery_hold"));
        }
        let extra = i64::try_from(result.len()).map_err(|_| invalid("resource_limit"))?;
        admit(&mut tx, extra).await?;
        sqlx::query("UPDATE connect_exchanges SET phase='result_pending',local_result=?,charge_bytes=charge_bytes+? WHERE delivery_id=?")
            .bind(result).bind(extra).bind(delivery).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
pub(super) mod tests;
