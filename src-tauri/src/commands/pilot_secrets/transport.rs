//! Private bootstrap over the real policy/vault owner. No IPC authority or F activation.
use super::{
    manager::{TransportIdentity, TransportPair},
    Manager, PilotVaultContext, Vault,
};
use crate::{
    connect::{
        codec::{Bytes, Profile},
        http::{HttpSession, Request, Response},
        runtime::{CodecHandle, CodecLauncher},
        TransferRuntime,
    },
    connect_resources::TransitCharge,
    core::db_state::DbReady,
    secrets::policy::{PolicyObservation, PolicySnapshot},
};
use serde::Deserialize;
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

type Result<T> = std::result::Result<T, &'static str>;
const CLOSED: u64 = 196_608;
const BODY: usize = 98_304;

// Intent is never authority. The matching session/account/device must be
// observed through authenticated /me before the preflight can establish rights.
pub(crate) struct Intent {
    pub context: PilotVaultContext,
    pub generation: String,
    pub instance_creation_id: String,
    pub account_id: Option<String>,
    pub device_id: Option<String>,
    pub scope: Scope,
    pub capabilities: Vec<String>,
}
pub(crate) enum Scope {
    Producer {
        instance_id: String,
    },
    Controller {
        source_instance_id: String,
        target_instance_id: Option<String>,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionFacts {
    account_id: String,
    session_id: String,
    device_id: String,
    session_revision: f64,
    expires_at_ms: Option<u64>,
}
pub(crate) struct VerifiedTransport {
    codec: Option<CodecHandle>,
    session: SessionFacts,
    pub(super) authority: serde_json::Value,
    producer_authority: Option<serde_json::Value>,
    capabilities: Vec<String>,
    transit_session: std::sync::Mutex<Option<serde_json::Value>>,
    target_invitation: std::sync::Mutex<Option<serde_json::Value>>,
    terminal_receipt: std::sync::Mutex<Option<serde_json::Value>>,
    activation_receipt: std::sync::Mutex<Option<serde_json::Value>>,
    observation: PolicyObservation,
    deadline: std::sync::Mutex<Instant>,
    runtime: TransferRuntime,
    generation: u64,
    cancel: CancellationToken,
    identity: TransportIdentity,
    address: SocketAddr,
    plain: bool,
    _snapshot: Arc<PolicySnapshot<TransportPair>>,
    _charge: TransitCharge,
}
impl VerifiedTransport {
    /// Uses the same authenticated connection owner as preflight. The returned
    /// codec output remains data; callers must still check native admission.
    pub(super) async fn decision<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        path: &str,
        sent: serde_json::Value,
        expectation: serde_json::Value,
    ) -> Result<crate::connect::codec::Output> {
        self.metadata(
            manager,
            ready,
            path,
            sent.clone(),
            serde_json::json!({
            "kind":"decision","sent":sent,"expectation":expectation}),
        )
        .await
    }
    pub(super) async fn metadata<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        path: &str,
        sent: serde_json::Value,
        mut reception: serde_json::Value,
    ) -> Result<crate::connect::codec::Output> {
        self.check_for_phase(manager.clone(), ready).await?;
        let request_id = sent["request_id"]
            .as_str()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .ok_or("http_correlation")?;
        if reception["sent"] != sent {
            return Err("invalid_request");
        }
        let kind = reception["kind"]
            .as_str()
            .ok_or("invalid_request")?
            .to_owned();
        let producer = kind == "received" || kind == "attestation";
        let proof = if producer {
            let p = &self
                .producer_authority
                .as_ref()
                .ok_or("authority_context")?["producer"];
            let e = reception["exchange"].clone();
            if e["instance_id"] != p["instance_id"]
                || e["producer_generation"] != p["generation"]
                || e["connection_id"] != p["connection_id"]
            {
                return Err("authority_context");
            }
            if kind == "attestation" {
                reception["producer"] = p.clone();
                reception["connection"] = p["connection_id"].clone();
                serde_json::json!({"kind":"attestation","exchange":e,"producer":p,"connection":p["connection_id"]})
            } else {
                serde_json::json!({"kind":"received","exchange":e})
            }
        } else {
            serde_json::Value::Null
        };
        let codec = self.codec.as_ref().ok_or("codec_closed")?;
        let budget = self.runtime.budget()?;
        let bytes = Bytes::serialize(&budget, &sent)?;
        let valid = decode(
            codec,
            3,
            serde_json::json!({"path":path,"request_id":request_id,"proof":proof}),
            Bytes::copy(&budget, bytes.as_slice())?,
            &self.cancel,
        )
        .await?;
        drop(valid);
        self.check().await?;
        let response = exchange(
            manager,
            self.identity.clone(),
            self._snapshot.clone(),
            &self.observation,
            &self.runtime,
            ready,
            self.address,
            self.plain,
            http::Method::POST,
            path,
            bytes,
            producer,
            false,
            request_id,
            BODY,
            &self.cancel,
        )
        .await?;
        let output = decode(
            codec,
            4,
            reception,
            response.into_codec_body()?,
            &self.cancel,
        )
        .await?;
        self.check().await?;
        let reply: serde_json::Value =
            serde_json::from_slice(output.bytes.as_slice()).map_err(|_| "codec_result")?;
        if reply["type"] == "error" || reply["result"]["kind"] == "error" {
            return Err(
                match reply["code"]
                    .as_str()
                    .or(reply["result"]["error"]["code"].as_str())
                {
                    Some("unsupported_context") => "unsupported_context",
                    Some("producer_changed") => "producer_changed",
                    Some("authority_changed") => "authority_changed",
                    Some("resource_limit") => "resource_limit",
                    Some("forbidden") => "forbidden",
                    Some("session_revoked") => "session_revoked",
                    Some("stale_revision") => "stale_revision",
                    Some("conflict") => "conflict",
                    _ => "transfer_decision_refused",
                },
            );
        }
        if kind == "decision" {
            let terminal = if reply["result"]["status"]["terminal"]["type"] == "terminal_receipt" {
                &reply["result"]["status"]["terminal"]
            } else {
                &reply["result"]["receipt"]
            };
            if terminal["type"] == "terminal_receipt" {
                // Only an authenticated HTTP response accepted by canonical
                // validation can install this fact, never a caller or SQL read.
                *self
                    .terminal_receipt
                    .lock()
                    .map_err(|_| "transfer_closed")? = Some(terminal.clone());
            }
            let activation =
                if reply["result"]["status"]["activation"]["type"] == "activation_receipt" {
                    &reply["result"]["status"]["activation"]
                } else {
                    &reply["result"]["receipt"]
                };
            if activation["type"] == "activation_receipt" {
                *self
                    .activation_receipt
                    .lock()
                    .map_err(|_| "transfer_closed")? = Some(activation.clone());
            }
        }
        Ok(output)
    }
    pub(super) async fn delivery<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
    ) -> Result<crate::connect::codec::Output> {
        self.delivery_until(manager, ready, &self.cancel).await
    }
    /// Stop only the idle network wait. Callers join this future so an admitted
    /// codec operation finishes instead of retiring the shared codec on drop.
    pub(super) async fn delivery_until<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        stop: &CancellationToken,
    ) -> Result<crate::connect::codec::Output> {
        if stop.is_cancelled() {
            return Err("http_cancelled");
        }
        self.check_for_phase(manager.clone(), ready).await?;
        let p = &self
            .producer_authority
            .as_ref()
            .ok_or("authority_context")?["producer"];
        let instance = p["instance_id"].as_str().ok_or("authority_context")?;
        let path = format!("/pilot/v2/instances/{instance}/deliveries/poll");
        let request_id = uuid::Uuid::new_v4();
        let bytes = Bytes::serialize(
            &self.runtime.budget()?,
            &serde_json::json!({"transport_version":"2.0","type":"poll","transfer_only":true,"capabilities":self.capabilities}),
        )?;
        let response = tokio::select! {biased;
            _=stop.cancelled()=>return Err("http_cancelled"),
            result=exchange(manager.clone(),self.identity.clone(),self._snapshot.clone(),&self.observation,&self.runtime,
                ready,self.address,self.plain,http::Method::POST,&path,bytes,true,true,request_id,BODY,&self.cancel)=>result?,
        };
        if !matches!(response.status, 200 | 204) {
            return Err("delivery_unavailable");
        }
        let facts = serde_json::json!({"context":{"offered":"transfer-transit-1","confirmed":response.transfer_offer,
            "poll_request_id":request_id,"response_request_id":response.request_id,"response_status":response.status,
            "instance_id":p["instance_id"],"producer_generation":p["generation"],"connection_id":p["connection_id"]}});
        let output = decode(
            self.codec.as_ref().ok_or("codec_closed")?,
            5,
            facts,
            response.into_codec_body()?,
            &self.cancel,
        )
        .await?;
        // Decode releases the HTTP body permit. If the poll crossed expiry,
        // also release its codec bank before preflight needs that same bank.
        // The exact validated bytes keep their own bounded native reservation.
        match self.check().await {
            Ok(()) => Ok(output),
            Err("authority_expired") => {
                let bytes = Bytes::copy(&self.runtime.budget()?, output.bytes.as_slice())?;
                let status = output.status;
                drop(output);
                self.refresh_authority(manager, ready).await?;
                Ok(crate::connect::codec::Output { status, bytes })
            }
            Err(error) => Err(error),
        }
    }
    /// Transit uses the existing HTTP owner and canonical codec. A successful
    /// submit only means HTTP acceptance; durability is observed through progress
    /// after the target's FULL-synchronous staging commit.
    pub(super) async fn transit<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        path: &str,
        sent: serde_json::Value,
        session: &serde_json::Value,
    ) -> Result<Option<crate::connect::codec::Output>> {
        self.check_for_phase(manager.clone(), ready).await?;
        let request_id = sent["request_id"]
            .as_str()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .ok_or("http_correlation")?;
        let op = match sent["type"].as_str() {
            Some("transit.open") => Some(9),
            Some("transit.status" | "transit.ack") => Some(8),
            Some("transit.pull" | "transit.chunk" | "transit.close" | "transit.prepared") => None,
            _ => return Err("invalid_request"),
        };
        let codec = self.codec.as_ref().ok_or("codec_closed")?;
        let budget = self.runtime.budget()?;
        let bytes = Bytes::serialize(&budget, &sent)?;
        let valid = decode(
            codec,
            3,
            serde_json::json!({"path":path,"request_id":request_id,"proof":null}),
            Bytes::copy(&budget, bytes.as_slice())?,
            &self.cancel,
        )
        .await?;
        drop(valid);
        let response = exchange(
            manager,
            self.identity.clone(),
            self._snapshot.clone(),
            &self.observation,
            &self.runtime,
            ready,
            self.address,
            self.plain,
            http::Method::POST,
            path,
            bytes,
            true,
            false,
            request_id,
            BODY,
            &self.cancel,
        )
        .await?;
        if response.status != 200 {
            return Err("transit_refused");
        }
        let output = match op {
            Some(op) => Some(
                decode(
                    codec,
                    op,
                    serde_json::json!({"session":session,"request_id":request_id}),
                    response.into_codec_body()?,
                    &self.cancel,
                )
                .await?,
            ),
            None => {
                drop(response);
                None
            }
        };
        self.check().await?;
        if op == Some(9) {
            // Only the authenticated, canonically validated HTTP response can
            // install this live session. SQL and caller-supplied JSON cannot.
            let value: serde_json::Value = serde_json::from_slice(
                output
                    .as_ref()
                    .ok_or("transit_open_missing")?
                    .bytes
                    .as_slice(),
            )
            .map_err(|_| "codec_result")?;
            *self.transit_session.lock().map_err(|_| "transit_closed")? =
                Some(value["session"].clone());
        }
        Ok(output)
    }
    /// The target learns its intent only through the canonical producer poll.
    /// Reconcile F before retaining it; the invitation itself grants no rights.
    pub(super) async fn receive_target_invitation<B: Vault + 'static>(
        &mut self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        job: &crate::connect::runtime::TransferJob,
    ) -> Result<serde_json::Value> {
        let received = loop {
            let output = self.delivery(manager.clone(), ready).await?;
            let received: serde_json::Value =
                serde_json::from_slice(output.bytes.as_slice()).map_err(|_| "invalid_delivery")?;
            drop(output);
            if received["branch"] != "empty" {
                break received;
            }
        };
        if received["branch"] != "transit"
            || received["value"]["body"]["kind"] != "transit.invitation"
        {
            return Err("transfer_invitation_missing");
        }
        #[cfg(test)]
        if let Some(ms) = std::env::var("MACRO_CONNECT_TEST_INVITATION_PAUSE_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
        {
            // Opens the window between delivery and protection to an interrupt.
            INVITATION_RECEIVED.store(true, std::sync::atomic::Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
        job.protect()?;
        let intent = received["value"]["body"]["message"].clone();
        let binding = &intent["binding"];
        let source = &binding["provenance"]["source"];
        let text =
            |value: &serde_json::Value| value.as_str().map(str::to_owned).ok_or("invalid_request");
        let source_instance = text(&source["source_instance_id"])?;
        let target = text(&binding["target_instance_id"])?;
        self.controller_for_pair(manager.clone(), ready, &source_instance, &target)
            .await?;
        let status = self
            .transfer_status(
                manager.clone(),
                ready,
                binding,
                &intent["frozen"],
                &intent["manifest"],
                &serde_json::Value::Null,
                &serde_json::Value::Null,
            )
            .await?;
        if status["status"] != "in_progress" || status["phase"] != "sealed" {
            return Err("transfer_source_changed");
        }
        let session = &intent["session"];
        // The target reopens with the exact selection the relay retained.
        let mut open = serde_json::json!({"transit_contract":"transfer-transit-1","type":"transit.open","request_id":uuid::Uuid::new_v4(),"session":session,"provider_id":intent["provider_id"],"model_id":intent["model_id"]});
        if let Some(effort) = intent.get("reasoning_effort") {
            open["reasoning_effort"] = effort.clone();
        }
        let opened = self
            .transit(
                manager,
                ready,
                &format!(
                    "/pilot/v2/transfers/known/{}/transit",
                    text(&binding["transfer_id"])?
                ),
                open,
                session,
            )
            .await?;
        drop(opened);
        *self
            .target_invitation
            .lock()
            .map_err(|_| "transit_closed")? = Some(intent.clone());
        self.check_target_transfer(&intent, &intent["manifest"])
            .await?;
        Ok(intent)
    }
    pub(super) async fn transfer_status<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        binding: &serde_json::Value,
        frozen: &serde_json::Value,
        manifest: &serde_json::Value,
        prepared: &serde_json::Value,
        terminal: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let source = &binding["provenance"]["source"];
        let text =
            |value: &serde_json::Value| value.as_str().map(str::to_owned).ok_or("invalid_request");
        let wrap = |request: serde_json::Value| serde_json::json!({"transit_contract":"transfer-transit-1","type":"decision.request","request_id":uuid::Uuid::new_v4(),"request":request});
        let request = wrap(
            serde_json::json!({"decision_contract":"transfer-decision-1","type":"decision_request","operation":"reconcile","operation_id":uuid::Uuid::new_v4(),"expected_revision":"0","body":{"action":"source_status","provenance":binding["provenance"]}}),
        );
        let path = format!(
            "/pilot/v2/transfers/sources/{}/{}",
            text(&source["source_instance_id"])?,
            text(&source["source_conversation_id"])?
        );
        let output = self
            .decision(
                manager.clone(),
                ready,
                &(path + "/decisions"),
                request,
                serde_json::Value::Null,
            )
            .await?;
        let reply: serde_json::Value =
            serde_json::from_slice(output.bytes.as_slice()).map_err(|_| "codec_result")?;
        drop(output);
        let status = &reply["result"]["status"];
        let ledger = &status["ledger"];
        // An aborted attempt leaves the ledger available at its own epoch;
        // its terminal then comes from the status read below.
        if status["status"] != "known"
            || !matches!(
                ledger["state"].as_str(),
                Some("reserved" | "ceded" | "available")
            )
            || ledger["state"] == "reserved"
                && ledger["active_transfer_id"] != binding["transfer_id"]
            || ledger["high_epoch"] != binding["epoch"]
            || ledger["provenance"] != binding["provenance"]
            || status["recovery_generation"] != self.authority["recovery_generation"]
        {
            return Err("transfer_source_changed");
        }
        // Read-only status does not use a CAS revision. Its ledger revision is
        // nevertheless the authenticated value above, not a reserve guess.
        let request = wrap(
            serde_json::json!({"decision_contract":"transfer-decision-1","type":"decision_request","operation":"reconcile","operation_id":uuid::Uuid::new_v4(),"expected_revision":"0","transfer_id":binding["transfer_id"],"body":{"action":"status","binding":binding,"frozen":frozen,"expected_ledger_revision":ledger["revision"]}}),
        );
        let expectation = serde_json::json!({"binding":binding,"frozen":frozen,"manifest":manifest,"prepared":prepared,"terminal":terminal});
        let output = self
            .decision(
                manager.clone(),
                ready,
                &format!(
                    "/pilot/v2/transfers/known/{}/decisions",
                    text(&binding["transfer_id"])?
                ),
                request,
                expectation,
            )
            .await?;
        let reply: serde_json::Value =
            serde_json::from_slice(output.bytes.as_slice()).map_err(|_| "codec_result")?;
        drop(output);
        let status = reply["result"]["status"].clone();
        if status["source_recovery"] != "intact"
            || status["recovery_generation"] != binding["relay_recovery_generation"]
        {
            return Err("transfer_source_changed");
        }
        Ok(status)
    }
    pub(crate) async fn check_target_transfer(
        &self,
        intent: &serde_json::Value,
        manifest: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.check().await?;
        let retained = self
            .target_invitation
            .lock()
            .map_err(|_| "transit_closed")?
            .clone()
            .ok_or("transfer_invitation_missing")?;
        if *intent != retained || *manifest != retained["manifest"] {
            return Err("transit_binding");
        }
        let binding = &intent["binding"];
        let frozen = &intent["frozen"];
        let source = &binding["provenance"]["source"];
        let text =
            |value: &serde_json::Value| value.as_str().map(str::to_owned).ok_or("invalid_request");
        self.check_producer(
            &text(&source["account_id"])?,
            &text(&binding["target_instance_id"])?,
            &text(&binding["target_producer_generation"])?,
        )
        .await?;
        if source["relay_origin"] != self.identity.context.relay_origin
            || self.authority["scope"]["kind"] != "controller"
            || self.authority["scope"]["source_instance_id"] != source["source_instance_id"]
            || self.authority["scope"]["target_instance_id"] != binding["target_instance_id"]
            || self.authority["source_producer"]["generation"]
                != binding["source_producer_generation"]
            || self.authority["target_producer"]["generation"]
                != binding["target_producer_generation"]
            || self.authority["recovery_generation"] != binding["relay_recovery_generation"]
        {
            return Err("authority_context");
        }
        let session = self
            .transit_session
            .lock()
            .map_err(|_| "transit_closed")?
            .clone()
            .ok_or("transit_not_open")?;
        if session["transfer_id"] != binding["transfer_id"]
            || session["binding_digest"] != commitment("transfer-binding", binding)?
            || session["frozen_digest"] != commitment("frozen", frozen)?
            || session["manifest_digest"] != commitment("manifest", manifest)?
        {
            return Err("transit_binding");
        }
        self.check().await?;
        Ok(session)
    }
    pub(super) async fn source_decision<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        owner: &crate::core::db_state::DbPool,
        reservation: &crate::db::connect_transfer::Reservation,
        normalized: Option<&crate::connect::transfer_worker::TransferWorker>,
        path: &str,
        sent: serde_json::Value,
        expectation: serde_json::Value,
        kind: &str,
    ) -> Result<crate::connect::codec::Output> {
        self.check_for_phase(manager.clone(), ready).await?;
        let expected = reservation
            .source_expectation(owner, normalized, &sent["request"], kind)
            .await
            .map_err(|_| "source_proof_refused")?;
        let challenge = serde_json::json!({"transit_contract":"transfer-transit-1","type":"decision.challenge",
            "request_id":uuid::Uuid::new_v4(),"kind":kind,"request":sent["request"]});
        let challenge_path = path
            .strip_suffix("/decisions")
            .ok_or("transfer_route")?
            .to_owned()
            + "/challenges";
        let issued = self
            .metadata(
                manager.clone(),
                ready,
                &challenge_path,
                challenge.clone(),
                serde_json::json!({"kind":"challenge","sent":challenge,"exchange":expected}),
            )
            .await?;
        drop(issued);
        let delivery = self.delivery(manager.clone(), ready).await?;
        self.attest_source(
            manager.clone(),
            ready,
            owner,
            reservation,
            normalized,
            delivery,
        )
        .await?;
        self.decision(manager, ready, path, sent, expectation).await
    }
    pub(super) async fn attest_source<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        owner: &crate::core::db_state::DbPool,
        reservation: &crate::db::connect_transfer::Reservation,
        normalized: Option<&crate::connect::transfer_worker::TransferWorker>,
        delivery: crate::connect::codec::Output,
    ) -> Result<()> {
        self.check_for_phase(manager.clone(), ready).await?;
        let data: serde_json::Value =
            serde_json::from_slice(delivery.bytes.as_slice()).map_err(|_| "invalid_delivery")?;
        drop(delivery);
        if data["branch"] != "transit" || data["value"]["body"]["kind"] != "proof.challenge" {
            return Err("invalid_delivery");
        }
        let request = &data["value"]["body"]["request"];
        let exchange = &data["value"]["body"]["exchange"];
        reservation
            .check_source_attestation(owner, self, normalized, request, exchange)
            .await
            .map_err(|_| "source_proof_refused")?;
        let id = exchange["delivery_id"].clone();
        let instance = exchange["instance_id"].as_str().ok_or("invalid_delivery")?;
        let received = serde_json::json!({"transit_contract":"transfer-transit-1","type":"proof.received","request_id":id,"exchange":exchange});
        self.metadata(
            manager.clone(),
            ready,
            &format!("/pilot/v2/transfers/instances/{instance}/received"),
            received.clone(),
            serde_json::json!({"kind":"received","sent":received,"exchange":exchange}),
        )
        .await?;
        reservation
            .check_source_attestation(owner, self, normalized, request, exchange)
            .await
            .map_err(|_| "source_proof_refused")?;
        let attestation = serde_json::json!({"decision_contract":"transfer-decision-1","type":"producer_attestation","format_version":"1",
            "kind":exchange["kind"],"binding_digest":exchange["binding_digest"],"subject_digest":exchange["subject_digest"],
            "producer_instance_id":exchange["instance_id"],"producer_generation":exchange["producer_generation"],
            "delivery_id":id,"challenge_id":exchange["challenge_id"],"request_digest":exchange["request_digest"],
            "prior_receipt_digest":exchange["prior_receipt_digest"]});
        let sent = serde_json::json!({"transit_contract":"transfer-transit-1","type":"proof.result","request_id":id,"attestation":attestation});
        self.metadata(
            manager,
            ready,
            &format!("/pilot/v2/transfers/instances/{instance}/attestations"),
            sent.clone(),
            serde_json::json!({"kind":"attestation","sent":sent,"exchange":exchange}),
        )
        .await?;
        Ok(())
    }
    pub(super) async fn attest_target<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        owner: &crate::core::db_state::DbPool,
        reservation: &crate::db::connect_transfer::Reservation,
        config: &crate::config::ConfigManager,
        selection: &crate::db::connect_transfer::TargetSelection,
        delivery: crate::connect::codec::Output,
    ) -> Result<()> {
        self.check_for_phase(manager.clone(), ready).await?;
        let data: serde_json::Value =
            serde_json::from_slice(delivery.bytes.as_slice()).map_err(|_| "invalid_delivery")?;
        drop(delivery);
        if data["branch"] != "transit" || data["value"]["body"]["kind"] != "proof.challenge" {
            return Err("invalid_delivery");
        }
        let request = &data["value"]["body"]["request"];
        let exchange = &data["value"]["body"]["exchange"];
        reservation
            .check_target_attestation(owner, config, self, selection, request, exchange)
            .await
            .map_err(|_| "target_proof_refused")?;
        let id = exchange["delivery_id"].clone();
        let instance = exchange["instance_id"].as_str().ok_or("invalid_delivery")?;
        let received = serde_json::json!({"transit_contract":"transfer-transit-1","type":"proof.received","request_id":id,"exchange":exchange});
        self.metadata(
            manager.clone(),
            ready,
            &format!("/pilot/v2/transfers/instances/{instance}/received"),
            received.clone(),
            serde_json::json!({"kind":"received","sent":received,"exchange":exchange}),
        )
        .await?;
        reservation
            .check_target_attestation(owner, config, self, selection, request, exchange)
            .await
            .map_err(|_| "target_proof_refused")?;
        let attestation = serde_json::json!({"decision_contract":"transfer-decision-1","type":"producer_attestation","format_version":"1",
            "kind":exchange["kind"],"binding_digest":exchange["binding_digest"],"subject_digest":exchange["subject_digest"],
            "producer_instance_id":exchange["instance_id"],"producer_generation":exchange["producer_generation"],
            "delivery_id":id,"challenge_id":exchange["challenge_id"],"request_digest":exchange["request_digest"],
            "prior_receipt_digest":exchange["prior_receipt_digest"]});
        let sent = serde_json::json!({"transit_contract":"transfer-transit-1","type":"proof.result","request_id":id,"attestation":attestation});
        self.metadata(
            manager,
            ready,
            &format!("/pilot/v2/transfers/instances/{instance}/attestations"),
            sent.clone(),
            serde_json::json!({"kind":"attestation","sent":sent,"exchange":exchange}),
        )
        .await?;
        Ok(())
    }
    /// A desktop can initiate a transfer while remaining its source producer.
    /// Reuse its existing codec and authenticated HTTP owner for both snapshots.
    pub(super) async fn controller_for<B: Vault + 'static>(
        &mut self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        target: &str,
    ) -> Result<()> {
        let source = self
            .producer_authority
            .as_ref()
            .ok_or("authority_context")?["scope"]["instance_id"]
            .as_str()
            .ok_or("authority_context")?
            .to_owned();
        self.controller_for_pair(manager, ready, &source, target)
            .await
    }
    /// Both endpoints authenticate the whole pair before retaining a binding.
    /// Target authority is separate from the source initiator stored in F.
    pub(super) async fn controller_for_pair<B: Vault + 'static>(
        &mut self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        source: &str,
        target: &str,
    ) -> Result<()> {
        self.check().await?;
        if source == target {
            return Err("authority_context");
        }
        let producer = self
            .producer_authority
            .as_ref()
            .ok_or("authority_context")?;
        let request_id = uuid::Uuid::new_v4();
        let request = serde_json::json!({"authority_contract":"transfer-authority-1","type":"preflight","request_id":request_id,
            "scope":{"kind":"controller","source_instance_id":source,"target_instance_id":target}});
        let codec = self.codec.as_ref().ok_or("codec_closed")?;
        let budget = self.runtime.budget()?;
        let bytes = Bytes::serialize(&budget, &request)?;
        let checked = decode(
            codec,
            1,
            serde_json::json!({"request_id_header":request_id}),
            Bytes::copy(&budget, bytes.as_slice())?,
            &self.cancel,
        )
        .await?;
        drop(checked);
        let dispatched = Instant::now();
        let response = exchange(
            manager,
            self.identity.clone(),
            self._snapshot.clone(),
            &self.observation,
            &self.runtime,
            ready,
            self.address,
            self.plain,
            http::Method::POST,
            "/pilot/v2/transfer-authority/preflight",
            bytes,
            false,
            false,
            request_id,
            8192,
            &self.cancel,
        )
        .await?;
        if response.status != 200 {
            return Err("authority_unavailable");
        }
        let output=decode(codec,2,serde_json::json!({"request":request,"expected":{
            "request_id_header":request_id,"response_request_id_header":response.request_id,
            "expected_origin":self.identity.context.relay_origin,"connection_origin":self.identity.context.relay_origin,
            "account_id":self.session.account_id},"time":{"now_ms":now_ms()?,"dispatch_age_ms":dispatched.elapsed().as_secs_f64()*1000.0}}),
            response.into_codec_body()?,&self.cancel).await?;
        let authority: serde_json::Value =
            serde_json::from_slice(output.bytes.as_slice()).map_err(|_| "codec_result")?;
        if authority["type"] != "authority_snapshot"
            || authority["actor"]["session_id"] != self.session.session_id
            || authority["actor"]["device_id"] != self.session.device_id
            || authority["source_producer"] != producer["producer"]
                && authority["target_producer"] != producer["producer"]
        {
            return Err("authority_context");
        }
        let expiry = chrono::DateTime::parse_from_rfc3339(
            authority["expires_at"]
                .as_str()
                .ok_or("authority_expired")?,
        )
        .map_err(|_| "authority_expired")?
        .timestamp_millis();
        let remaining = u64::try_from(expiry)
            .ok()
            .and_then(|v| v.checked_sub(now_ms().ok()?))
            .ok_or("authority_expired")?;
        let deadline = self
            .deadline
            .get_mut()
            .map_err(|_| "authority_unavailable")?;
        *deadline = (*deadline).min(Instant::now() + Duration::from_millis(remaining));
        self.authority = authority;
        self.check().await
    }
    async fn check_for_phase<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
    ) -> Result<()> {
        match self.check().await {
            Err("authority_expired") => self.refresh_authority(manager, ready).await,
            result => result,
        }
    }
    /// A new phase needs a new authenticated relay preflight. Retained snapshots
    /// identify the same actors; their old timestamps never extend this lease.
    pub(crate) async fn refresh_authority<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
    ) -> Result<()> {
        self.check_scope_local()?;
        self.observation
            .check_fresh()
            .await
            .map_err(|_| "policy_revoked")?;
        // A failed renewal leaves no usable old lease, even before its former
        // expiry. A subsequent phase must authenticate again.
        *self.deadline.lock().map_err(|_| "authority_unavailable")? = Instant::now();
        let mut deadline = None;
        if let Some(producer) = &self.producer_authority {
            let fresh = self
                .refresh_snapshot(manager.clone(), ready, producer, true)
                .await?;
            deadline = Some(fresh);
        }
        if self.authority["scope"]["kind"] != "producer" || deadline.is_none() {
            let fresh = self
                .refresh_snapshot(manager, ready, &self.authority, false)
                .await?;
            deadline = Some(deadline.map_or(fresh, |old: Instant| old.min(fresh)));
        }
        self.observation
            .check_fresh()
            .await
            .map_err(|_| "policy_revoked")?;
        self.check_scope_local()?;
        *self.deadline.lock().map_err(|_| "authority_unavailable")? =
            deadline.ok_or("authority_context")?;
        self.check().await
    }
    async fn refresh_snapshot<B: Vault + 'static>(
        &self,
        manager: Arc<Manager<B>>,
        ready: &DbReady,
        previous: &serde_json::Value,
        producer: bool,
    ) -> Result<Instant> {
        let request_id = uuid::Uuid::new_v4();
        let request = serde_json::json!({"authority_contract":"transfer-authority-1","type":"preflight",
            "request_id":request_id,"scope":previous["scope"]});
        let codec = self.codec.as_ref().ok_or("codec_closed")?;
        let budget = self.runtime.budget()?;
        let bytes = Bytes::serialize(&budget, &request)?;
        drop(
            decode(
                codec,
                1,
                serde_json::json!({"request_id_header":request_id}),
                Bytes::copy(&budget, bytes.as_slice())?,
                &self.cancel,
            )
            .await?,
        );
        drop(bytes);
        let mut attempt = 0u32;
        let (response, dispatch) = loop {
            self.check_scope_local()?;
            self.observation
                .check_fresh()
                .await
                .map_err(|_| "policy_revoked")?;
            let dispatch = Instant::now();
            let response = exchange(
                manager.clone(),
                self.identity.clone(),
                self._snapshot.clone(),
                &self.observation,
                &self.runtime,
                ready,
                self.address,
                self.plain,
                http::Method::POST,
                "/pilot/v2/transfer-authority/preflight",
                Bytes::serialize(&budget, &request)?,
                producer,
                false,
                request_id,
                8192,
                &self.cancel,
            )
            .await?;
            // Two pair preflights can overlap the relay's per-instance reader
            // admission. Retry only this read, after fully dropping its reply;
            // F decisions and their side effects never use this retry path.
            if response.status == 413 && attempt < 3 {
                drop(response);
                let delay = Duration::from_millis(25 * 3u64.pow(attempt));
                attempt += 1;
                tokio::select! {biased;_=self.cancel.cancelled()=>return Err("http_cancelled"),_=tokio::time::sleep(delay)=>{}}
                continue;
            }
            break (response, dispatch);
        };
        if response.status != 200 {
            return Err(if response.status == 413 {
                "resource_limit"
            } else {
                "authority_unavailable"
            });
        }
        let output=decode(codec,2,serde_json::json!({"request":request,"expected":{
            "request_id_header":request_id,"response_request_id_header":response.request_id,
            "expected_origin":self.identity.context.relay_origin,"connection_origin":self.identity.context.relay_origin,
            "account_id":self.session.account_id},"time":{"now_ms":now_ms()?,"dispatch_age_ms":dispatch.elapsed().as_secs_f64()*1000.0}}),
            response.into_codec_body()?,&self.cancel).await?;
        let fresh: serde_json::Value =
            serde_json::from_slice(output.bytes.as_slice()).map_err(|_| "codec_result")?;
        // Compare every authenticated fact, including revisions, permissions,
        // recovery history and both selected producer connections. Only the
        // correlation and validity timestamps may change between preflights.
        let facts =
            |value: &serde_json::Value| -> Result<serde_json::Map<String, serde_json::Value>> {
                let mut value = value.as_object().ok_or("authority_context")?.clone();
                for field in ["request_id", "issued_at", "expires_at"] {
                    value.remove(field);
                }
                Ok(value)
            };
        if fresh["type"] != "authority_snapshot" || facts(&fresh)? != facts(previous)? {
            return Err("authority_changed");
        }
        let expiry = chrono::DateTime::parse_from_rfc3339(
            fresh["expires_at"].as_str().ok_or("authority_expired")?,
        )
        .map_err(|_| "authority_expired")?
        .timestamp_millis();
        let remaining = u64::try_from(expiry)
            .ok()
            .and_then(|expiry| expiry.checked_sub(now_ms().ok()?))
            .ok_or("authority_expired")?;
        self.check_scope_local()?;
        Ok((dispatch + Duration::from_secs(30))
            .min(Instant::now() + Duration::from_millis(remaining)))
    }
    pub(crate) fn controller_snapshot(&self) -> Result<&serde_json::Value> {
        self.check_local()?;
        if self.authority["scope"]["kind"] != "controller" {
            return Err("authority_context");
        }
        Ok(&self.authority)
    }
    pub(crate) fn producer_identity(&self) -> Result<&serde_json::Value> {
        self.check_local()?;
        Ok(&self
            .producer_authority
            .as_ref()
            .ok_or("authority_context")?["producer"])
    }
    pub(crate) async fn terminal(&self, transfer: &str) -> Result<serde_json::Value> {
        self.check().await?;
        let receipt = self
            .terminal_receipt
            .lock()
            .map_err(|_| "transfer_closed")?
            .clone()
            .ok_or("terminal_not_received")?;
        if receipt["transfer_id"] != transfer {
            return Err("terminal_mismatch");
        }
        Ok(receipt)
    }
    pub(crate) async fn committed_terminal(&self, transfer: &str) -> Result<serde_json::Value> {
        let receipt = self.terminal(transfer).await?;
        if receipt["outcome"] != "committed" {
            return Err("terminal_mismatch");
        }
        Ok(receipt)
    }
    pub(crate) async fn committed_activation(&self, transfer: &str) -> Result<serde_json::Value> {
        let terminal = self.committed_terminal(transfer).await?;
        let activation = self
            .activation_receipt
            .lock()
            .map_err(|_| "transfer_closed")?
            .clone()
            .ok_or("activation_not_received")?;
        if activation["transfer_id"] != transfer
            || activation["terminal_digest"] != commitment("terminal", &terminal)?
            || activation["prepared_digest"] != commitment("prepared", &terminal["prepared"])?
            || activation["target_conversation_id"]
                != terminal["prepared"]["target_conversation_id"]
        {
            return Err("activation_mismatch");
        }
        Ok(activation)
    }
    pub(crate) fn session_binding(&self) -> Result<(&str, &str)> {
        self.check_local()?;
        Ok((&self.session.session_id, &self.session.device_id))
    }
    pub(crate) async fn detection_values(&self) -> Result<Vec<String>> {
        self.check().await?;
        let mut values = self._snapshot.values().to_vec();
        let pair = self._snapshot.peer();
        values.push(pair.session_token.clone());
        values.push(pair.instance_key.clone());
        values.sort();
        values.dedup();
        if values.iter().map(String::len).sum::<usize>() > 8192 || values.len() > 128 {
            return Err("resource_limit");
        }
        Ok(values)
    }
    pub(crate) async fn check_reserve(&self, sent: &serde_json::Value) -> Result<()> {
        self.check().await?;
        let q = &sent["request"];
        let b = &q["body"]["binding"];
        let source = &b["provenance"]["source"];
        // Only the authenticated controller snapshot grants rights. Request and
        // journal JSON merely identify which source the caller wants to move.
        if self.authority["scope"]["kind"] != "controller"
            || q["operation"] != "reserve"
            || source["relay_origin"] != self.identity.context.relay_origin
            || source["account_id"] != self.session.account_id
            || source["source_instance_id"] != self.authority["scope"]["source_instance_id"]
            || b["target_instance_id"].is_null()
            || b["target_instance_id"] != self.authority["scope"]["target_instance_id"]
            || b["source_producer_generation"] != self.authority["source_producer"]["generation"]
            || b["target_producer_generation"] != self.authority["target_producer"]["generation"]
            || b["relay_recovery_generation"] != self.authority["recovery_generation"]
            || b["initiator"] != self.authority["actor"]
        {
            return Err("authority_context");
        }
        let text = |v: &serde_json::Value| v.as_str().ok_or("invalid_request").map(str::to_owned);
        let path = format!(
            "/pilot/v2/transfers/sources/{}/{}/targets/{}/reservations/{}/decisions",
            text(&source["source_instance_id"])?,
            text(&source["source_conversation_id"])?,
            text(&b["target_instance_id"])?,
            text(&b["transfer_id"])?
        );
        let codec = self.codec.as_ref().ok_or("codec_closed")?;
        let bytes = Bytes::serialize(&self.runtime.budget()?, sent)?;
        let valid = decode(
            codec,
            3,
            serde_json::json!({"path":path,
            "request_id":sent["request_id"],"proof":null}),
            bytes,
            &self.cancel,
        )
        .await?;
        drop(valid);
        self.check().await
    }
    pub(crate) async fn check_producer(
        &self,
        account: &str,
        instance: &str,
        generation: &str,
    ) -> Result<()> {
        self.check().await?;
        let authority = self
            .producer_authority
            .as_ref()
            .ok_or("authority_context")?;
        if authority["scope"]["kind"] != "producer"
            || authority["scope"]["instance_id"] != instance
            || authority["producer"]["account_id"] != account
            || authority["producer"]["instance_id"] != instance
            || authority["producer"]["generation"] != generation
        {
            return Err("authority_context");
        }
        Ok(())
    }
    pub(crate) async fn close(mut self) -> Result<()> {
        if let Some(codec) = self.codec.take() {
            codec.close().await?;
        }
        Ok(())
    }
    /// Fresh at the persistent policy read; future effects still need consume_policy.
    pub(crate) async fn check(&self) -> Result<()> {
        self.check_local()?;
        self.observation
            .check_fresh()
            .await
            .map_err(|_| "policy_revoked")?;
        self.check_local()
    }
    fn check_local(&self) -> Result<()> {
        self.check_scope_local()?;
        if Instant::now() >= *self.deadline.lock().map_err(|_| "authority_unavailable")? {
            return Err("authority_expired");
        }
        Ok(())
    }
    fn check_scope_local(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            return Err("http_cancelled");
        }
        if self.runtime.generation()? != self.generation {
            return Err("transport_retired");
        }
        self.observation
            .check_local()
            .map_err(|_| "policy_revoked")?;
        if self
            .session
            .expires_at_ms
            .is_some_and(|expiry| now_ms().map_or(true, |now| now >= expiry))
        {
            return Err("authority_expired");
        }
        Ok(())
    }
}
/// Encoding only. Every emitted envelope still passes the canonical codec.
pub(crate) fn commitment(domain: &str, value: &serde_json::Value) -> Result<String> {
    use sha2::{Digest, Sha256};
    if !matches!(
        domain,
        "provenance"
            | "transfer-binding"
            | "retry-body"
            | "birth"
            | "frozen"
            | "manifest"
            | "prepared"
            | "terminal"
            | "activation"
    ) {
        return Err("commitment_domain");
    }
    let mut digest = Sha256::new();
    digest.update(format!("macro-connect-{domain}-1\0"));
    digest.update(serde_json::to_vec(value).map_err(|_| "commitment_encoding")?);
    Ok(format!("{:x}", digest.finalize()))
}
fn now_ms() -> Result<u64> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "clock")?
            .as_millis(),
    )
    .map_err(|_| "clock")
}

#[cfg(test)]
pub(crate) static INVITATION_RECEIVED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// `loopback` addresses a plain local relay in native scenarios; the app always
/// resolves the HTTPS origin.
pub(super) async fn bootstrap<B: Vault + 'static>(
    manager: Arc<Manager<B>>,
    intent: Intent,
    runtime: &TransferRuntime,
    launcher: &CodecLauncher,
    ready: &DbReady,
    loopback: Option<SocketAddr>,
    cancel: &CancellationToken,
) -> Result<VerifiedTransport> {
    if let Some(address) = loopback {
        return bootstrap_owned(
            manager, intent, runtime, launcher, ready, address, true, cancel,
        )
        .await;
    }
    let origin = url::Url::parse(&intent.context.relay_origin).map_err(|_| "origin")?;
    if origin.scheme() != "https"
        || origin.origin().ascii_serialization() != intent.context.relay_origin
    {
        return Err("origin");
    }
    let host = origin.host_str().ok_or("origin")?;
    let address = tokio::net::lookup_host((host, origin.port_or_known_default().ok_or("origin")?))
        .await
        .map_err(|_| "dns")?
        .next()
        .ok_or("dns")?;
    bootstrap_owned(
        manager, intent, runtime, launcher, ready, address, false, cancel,
    )
    .await
}

async fn exchange<B: Vault + 'static>(
    manager: Arc<Manager<B>>,
    identity: TransportIdentity,
    snapshot: Arc<PolicySnapshot<TransportPair>>,
    observation: &PolicyObservation,
    runtime: &TransferRuntime,
    ready: &DbReady,
    address: SocketAddr,
    plain: bool,
    method: http::Method,
    path: &str,
    body: Bytes,
    producer: bool,
    poll: bool,
    request_id: uuid::Uuid,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<Response> {
    let origin = url::Url::parse(&identity.context.relay_origin).map_err(|_| "origin")?;
    let host = origin.host_str().ok_or("origin")?;
    let mut session = HttpSession::new(runtime.http_owner(ready)?, host, address)?;
    #[cfg(test)]
    if plain {
        session.use_plain_loopback();
    }
    #[cfg(not(test))]
    if plain {
        return Err("tls_required");
    }
    // All TCP/TLS work finishes before reacquiring policy and store locks.
    let prepared = session.prepare(poll).await?;
    let request = Request::from_admitted(&runtime.budget()?, method, path, body)?;
    let request = if poll {
        request.offer_transfer()
    } else {
        request
    };
    let handle = tokio::runtime::Handle::current();
    let local_cancel = cancel.child_token();
    let guard = local_cancel.clone().drop_guard();
    let emitting_cancel = local_cancel.clone();
    let pending = super::blocking(move || {
        manager.consume_policy(&snapshot, &identity, |lease, pair| {
            Ok(handle.block_on(async {
                let request = request.authenticate(
                    &pair.session_token,
                    producer.then_some(pair.instance_key.as_str()),
                    request_id,
                )?;
                prepared.emit(lease, request, &emitting_cancel).await
            }))
        })
    })
    .await
    .map_err(|_| "policy_revoked")??;
    let response = pending.receive(limit, observation, &local_cancel).await?;
    // Retire both IO and TLS configuration before borrowing the codec graph.
    drop(session);
    if response.request_id.as_deref() != Some(request_id.to_string().as_str()) {
        return Err("http_correlation");
    }
    guard.disarm();
    Ok(response)
}

async fn decode(
    codec: &CodecHandle,
    op: u16,
    facts: serde_json::Value,
    body: Bytes,
    cancel: &CancellationToken,
) -> Result<crate::connect::codec::Output> {
    let input = codec.admit(op)?.input(&facts, body)?;
    drop(facts);
    let output = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("http_cancelled"),
        result = codec.run_admitted(input) => result?,
    };
    if output.status != 0 {
        return Err("invalid_response");
    }
    Ok(output)
}

pub(super) async fn bootstrap_owned<B: Vault + 'static>(
    manager: Arc<Manager<B>>,
    intent: Intent,
    runtime: &TransferRuntime,
    launcher: &CodecLauncher,
    ready: &DbReady,
    address: SocketAddr,
    plain: bool,
    cancel: &CancellationToken,
) -> Result<VerifiedTransport> {
    if !launcher.belongs_to(runtime) {
        return Err("codec_owner");
    }
    let mut codec = None;
    let result = bootstrap_with_codec(
        manager, intent, runtime, launcher, &mut codec, ready, address, plain, cancel,
    )
    .await;
    match result {
        Ok(mut verified) => {
            verified.codec = codec.take();
            Ok(verified)
        }
        Err(error) => {
            if let Some(codec) = codec.take() {
                codec.close().await?;
            }
            Err(error)
        }
    }
}

async fn bootstrap_with_codec<B: Vault + 'static>(
    manager: Arc<Manager<B>>,
    intent: Intent,
    runtime: &TransferRuntime,
    launcher: &CodecLauncher,
    active: &mut Option<CodecHandle>,
    ready: &DbReady,
    address: SocketAddr,
    plain: bool,
    cancel: &CancellationToken,
) -> Result<VerifiedTransport> {
    if cancel.is_cancelled() {
        return Err("http_cancelled");
    }
    // Retain bounded compatibility intent. The relay validates the poll shape;
    // authenticated preflight and producer checks still establish authority.
    if intent.capabilities.len() > 32 || intent.capabilities.iter().any(|v| v.len() > 128) {
        return Err("resource_limit");
    }
    let generation = runtime.generation()?;
    if intent.context.relay_origin.len() > 2048
        || intent.context.configuration_id.len() > 128
        || intent.context.owner_id.len() > 128
        || intent.generation.len() > 128
        || intent.instance_creation_id.len() > 128
        || intent.account_id.as_ref().is_some_and(|v| v.len() > 128)
        || intent.device_id.as_ref().is_some_and(|v| v.len() > 128)
        || match &intent.scope {
            Scope::Producer { instance_id } => instance_id.len() > 128,
            Scope::Controller {
                source_instance_id,
                target_instance_id,
            } => {
                source_instance_id.len() > 128
                    || target_instance_id.as_ref().is_some_and(|v| v.len() > 128)
            }
        }
    {
        return Err("resource_limit");
    }
    let budget = runtime.budget()?;
    let retained = budget.reserve(CLOSED).map_err(|_| "resource_limit")?;
    let identity = TransportIdentity {
        context: intent.context,
        generation: intent.generation,
        instance_creation_id: intent.instance_creation_id,
    };
    let capturing_manager = manager.clone();
    let capturing_identity = identity.clone();
    let snapshot = Arc::new(
        super::blocking(move || capturing_manager.capture_policy(&capturing_identity))
            .await
            .map_err(|_| "policy_revoked")?,
    );
    let observation = manager
        .observe_transport(&snapshot)
        .map_err(|_| "policy_revoked")?;
    let started = Instant::now();
    let request_id = uuid::Uuid::new_v4();
    let response = exchange(
        manager.clone(),
        identity.clone(),
        snapshot.clone(),
        &observation,
        runtime,
        ready,
        address,
        plain,
        http::Method::GET,
        "/pilot/v1/me",
        Bytes::copy(&budget, &[])?,
        false,
        false,
        request_id,
        BODY,
        cancel,
    )
    .await?;
    if response.status != 200 {
        return Err("session_unavailable");
    }
    let facts = serde_json::json!({"method":"GET", "path":"/pilot/v1/me", "request_id_header":request_id,
        "response_request_id_header":response.request_id, "expected_origin":identity.context.relay_origin,
        "connection_origin":identity.context.relay_origin, "session_id":identity.context.owner_id,
        "account_id":intent.account_id, "device_id":intent.device_id, "now_ms":now_ms()?});
    // Do not keep the short bootstrap child idle during network reception.
    *active = Some(launcher.start(Profile::Bootstrap).await?);
    let codec = active.as_ref().ok_or("codec_closed")?;
    let output = decode(codec, 10, facts, response.into_codec_body()?, cancel).await?;
    let session: SessionFacts =
        serde_json::from_slice(output.bytes.as_slice()).map_err(|_| "codec_result")?;
    drop(output);
    observation.check_local().map_err(|_| "policy_revoked")?;
    // Reap the A1 process and all pipes before admitting the persistent profile.
    active.take().ok_or("codec_closed")?.close().await?;
    *active = Some(launcher.start(Profile::Persistent).await?);
    let codec = active.as_ref().ok_or("codec_closed")?;
    let request_id = uuid::Uuid::new_v4();
    let producer = matches!(intent.scope, Scope::Producer { .. });
    let scope = match intent.scope {
        Scope::Producer { instance_id } => {
            serde_json::json!({"kind":"producer","instance_id":instance_id})
        }
        Scope::Controller {
            source_instance_id,
            target_instance_id,
        } => {
            serde_json::json!({"kind":"controller","source_instance_id":source_instance_id,"target_instance_id":target_instance_id})
        }
    };
    let request = serde_json::json!({"authority_contract":"transfer-authority-1","type":"preflight","request_id":request_id,"scope":scope});
    drop(scope);
    let bytes = Bytes::serialize(&budget, &request)?;
    let valid = decode(
        codec,
        1,
        serde_json::json!({"request_id_header":request_id}),
        Bytes::copy(&budget, bytes.as_slice())?,
        cancel,
    )
    .await?;
    drop(valid);
    let dispatch = Instant::now();
    let response = exchange(
        manager,
        identity.clone(),
        snapshot.clone(),
        &observation,
        runtime,
        ready,
        address,
        plain,
        http::Method::POST,
        "/pilot/v2/transfer-authority/preflight",
        bytes,
        producer,
        false,
        request_id,
        8192,
        cancel,
    )
    .await?;
    if response.status != 200 {
        return Err("authority_unavailable");
    }
    let facts = serde_json::json!({"request":request,"expected":{"request_id_header":request_id,
        "response_request_id_header":response.request_id,"expected_origin":identity.context.relay_origin,
        "connection_origin":identity.context.relay_origin,"account_id":session.account_id},
        "time":{"now_ms":now_ms()?,"dispatch_age_ms":dispatch.elapsed().as_secs_f64()*1000.0}});
    drop(request); // json! copied it into the now-owned op2 facts.
    let output = decode(codec, 2, facts, response.into_codec_body()?, cancel).await?;
    let authority: serde_json::Value =
        serde_json::from_slice(output.bytes.as_slice()).map_err(|_| "codec_result")?;
    if authority["type"] != "authority_snapshot" {
        return Err("authority_refused");
    }
    if !producer
        && (authority["actor"]["session_id"] != session.session_id
            || authority["actor"]["device_id"] != session.device_id)
    {
        return Err("authority_context");
    }
    // Canonical validation already checked the deadline against dispatch age.
    // Keep a monotone ceiling as well as the authenticated wall-clock expiry.
    let expiry = chrono::DateTime::parse_from_rfc3339(
        authority["expires_at"]
            .as_str()
            .ok_or("authority_expired")?,
    )
    .map_err(|_| "authority_expired")?
    .timestamp_millis();
    let remaining = u64::try_from(expiry)
        .ok()
        .and_then(|expiry| expiry.checked_sub(now_ms().ok()?))
        .ok_or("authority_expired")?;
    let verified = VerifiedTransport {
        codec: None,
        session,
        producer_authority: producer.then(|| authority.clone()),
        capabilities: intent.capabilities,
        transit_session: std::sync::Mutex::new(None),
        target_invitation: std::sync::Mutex::new(None),
        terminal_receipt: std::sync::Mutex::new(None),
        activation_receipt: std::sync::Mutex::new(None),
        authority,
        observation,
        runtime: runtime.clone(),
        generation,
        cancel: cancel.clone(),
        deadline: std::sync::Mutex::new(std::cmp::min(
            started + Duration::from_secs(30),
            Instant::now() + Duration::from_millis(remaining),
        )),
        identity,
        address,
        plain,
        _snapshot: snapshot,
        _charge: retained,
    };
    verified.check().await?;
    Ok(verified)
}
