//! Native Global Chat transfer sequence. Callers supply intent and local owners,
//! never relay decisions, producer proofs or target expectations.
use super::{
    manager::Manager,
    transport::{self, VerifiedTransport},
    Vault,
};
use crate::{
    config::ConfigManager,
    connect::{runtime::CodecLauncher, transfer_worker::TransferWorker},
    core::db_state::{DbPool, DbReady},
    db::chat_admission::runtime::ChatAdmissionRuntime,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};

type Result<T> = std::result::Result<T, &'static str>;
fn text(v: &Value) -> Result<&str> {
    v.as_str().ok_or("transfer_intent_invalid")
}
fn wrap(request: Value) -> Value {
    json!({"transit_contract":"transfer-transit-1","type":"decision.request","request_id":uuid::Uuid::new_v4(),"request":request})
}
fn output(value: crate::connect::codec::Output) -> Result<Value> {
    serde_json::from_slice(value.bytes.as_slice()).map_err(|_| "codec_result")
}
fn request(operation: &str, revision: &str, transfer: &Value, body: Value) -> Value {
    let mut q = json!({"decision_contract":"transfer-decision-1","type":"decision_request","operation":operation,
        "operation_id":uuid::Uuid::new_v4(),"expected_revision":revision,"body":body});
    if !transfer.is_null() {
        q["transfer_id"] = transfer.clone();
    }
    q
}
fn expectation(
    binding: &Value,
    frozen: &Value,
    manifest: &Value,
    prepared: &Value,
    terminal: &Value,
) -> Value {
    json!({"binding":binding,"frozen":frozen,"manifest":manifest,"prepared":prepared,"terminal":terminal})
}
fn target_proof(
    transport: &VerifiedTransport,
    binding: &Value,
    manifest: &Value,
    prepared: &Value,
    request: &Value,
    kind: &str,
) -> Result<Value> {
    let authority = transport.controller_snapshot()?;
    let producer = &authority["target_producer"];
    if prepared["binding_digest"] != manifest["binding_digest"]
        || prepared["manifest_digest"] != transport::commitment("manifest", manifest)?
        || request["transfer_id"] != binding["transfer_id"]
    {
        return Err("target_scope_mismatch");
    }
    let digest = transport::commitment("prepared", prepared)?;
    let prior = match kind {
        "target_pinned"
            if request["operation"] == "ready" && request["body"]["prepared"] == *prepared =>
        {
            transport::commitment("manifest", manifest)?
        }
        "target_maintained" if request["operation"] == "commit" => digest.clone(),
        _ => return Err("target_scope_mismatch"),
    };
    Ok(
        json!({"kind":kind,"binding_digest":manifest["binding_digest"],"subject_digest":digest,
        "instance_id":producer["instance_id"],"producer_generation":producer["generation"],"connection_id":producer["connection_id"],
        "request_digest":transport::commitment("retry-body",request)?,"prior_receipt_digest":prior}),
    )
}
async fn challenge_target<B: Vault + 'static>(
    transport: &VerifiedTransport,
    manager: Arc<Manager<B>>,
    ready: &DbReady,
    binding: &Value,
    manifest: &Value,
    prepared: &Value,
    request: &Value,
    kind: &str,
) -> Result<()> {
    let expected = target_proof(transport, binding, manifest, prepared, request, kind)?;
    let sent = json!({"transit_contract":"transfer-transit-1","type":"decision.challenge","request_id":uuid::Uuid::new_v4(),"kind":kind,"request":request});
    drop(
        transport
            .metadata(
                manager,
                ready,
                &format!(
                    "/pilot/v2/transfers/known/{}/challenges",
                    text(&binding["transfer_id"])?
                ),
                sent.clone(),
                json!({"kind":"challenge","sent":sent,"exchange":expected}),
            )
            .await?,
    );
    Ok(())
}
// The identical F operation is retried only while its peer proof is arriving.
// Fresh authenticated pair preflight distinguishes pending proof from lost rights.
async fn after_target_proof<B: Vault + 'static>(
    transport: &VerifiedTransport,
    manager: Arc<Manager<B>>,
    ready: &DbReady,
    path: &str,
    sent: Value,
    expected: Value,
) -> Result<Value> {
    for _ in 0..100 {
        match transport
            .decision(manager.clone(), ready, path, sent.clone(), expected.clone())
            .await
        {
            Ok(reply) => return output(reply),
            Err("forbidden") => {
                transport.refresh_authority(manager.clone(), ready).await?;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err("target_proof_timeout")
}

pub(super) async fn send<B: Vault + 'static>(
    manager: Arc<Manager<B>>,
    owner: &DbPool,
    admission: &ChatAdmissionRuntime,
    config: &ConfigManager,
    launcher: &CodecLauncher,
    transport: &Arc<VerifiedTransport>,
    ready: &DbReady,
    caller: &str,
    browser: &str,
    inspection: &str,
    conversation: &str,
    provider_id: &str,
    model_id: &str,
) -> Result<String> {
    if provider_id.is_empty()
        || provider_id.len() > 128
        || !provider_id
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphanumeric() || i > 0 && b"._:-".contains(&b))
        || model_id.is_empty()
        || model_id.chars().count() > 256
    {
        return Err("transfer_model_intent_invalid");
    }
    let authority = transport.controller_snapshot()?;
    let source_instance = text(&authority["scope"]["source_instance_id"])?;
    let target = text(&authority["scope"]["target_instance_id"])?;
    let pool = &ready.pool;
    let old:Option<Vec<u8>>=sqlx::query_scalar("SELECT binding_json FROM connect_transfers WHERE local_role='source' AND source_conversation_id=? ORDER BY source_epoch DESC LIMIT 1")
        .bind(conversation).fetch_optional(pool).await.map_err(|_|"database_unavailable")?;
    let provenance = if let Some(old) = old {
        let old: Value = serde_json::from_slice(&old).map_err(|_| "transfer_intent_invalid")?;
        old["provenance"].clone()
    } else {
        json!({"source":{"relay_origin":authority["authority_origin"],"account_id":authority["actor"]["account_id"],"source_instance_id":source_instance,"source_conversation_id":conversation},
            "lineage_id":uuid::Uuid::new_v4(),"installation_id":uuid::Uuid::new_v4(),"birth_generation":authority["recovery_generation"]})
    };
    if provenance["source"]["source_instance_id"] != source_instance
        || provenance["source"]["source_conversation_id"] != conversation
        || provenance["source"]["account_id"] != authority["actor"]["account_id"]
        || provenance["source"]["relay_origin"] != authority["authority_origin"]
    {
        return Err("authority_context");
    }
    let source_path = format!("/pilot/v2/transfers/sources/{source_instance}/{conversation}");
    let status = output(
        transport
            .decision(
                manager.clone(),
                ready,
                &(source_path.clone() + "/decisions"),
                wrap(request(
                    "reconcile",
                    "0",
                    &Value::Null,
                    json!({"action":"source_status","provenance":provenance}),
                )),
                Value::Null,
            )
            .await?,
    )?;
    let status = &status["result"]["status"];
    let existing = status["status"] == "known";
    let ledger = &status["ledger"];
    if existing && (ledger["state"] != "available" || ledger["provenance"] != provenance)
        || !existing && status["status"] != "not_found"
    {
        return Err("transfer_reconciliation_required");
    }
    let epoch = if existing {
        text(&ledger["high_epoch"])?
            .parse::<u64>()
            .map_err(|_| "transfer_intent_invalid")?
            .checked_add(1)
            .ok_or("resource_limit")?
            .to_string()
    } else {
        "1".into()
    };
    let binding = json!({"transfer_id":uuid::Uuid::new_v4(),"provenance":provenance,"epoch":epoch,"target_instance_id":target,
        "relay_recovery_generation":authority["recovery_generation"],"initiator":authority["actor"],
        "source_producer_generation":authority["source_producer"]["generation"],"target_producer_generation":authority["target_producer"]["generation"]});
    let token = crate::db::conversation_content::conversation_content_version(pool, conversation)
        .await
        .map_err(|_| "transfer_source_changed")?;
    let revision: i64 =
        sqlx::query_scalar("SELECT revision+1 FROM chat_admission_owners WHERE conversation_id=?")
            .bind(conversation)
            .fetch_one(pool)
            .await
            .map_err(|_| "transfer_source_changed")?;
    let frozen = json!({"format_version":"1","binding_digest":transport::commitment("transfer-binding",&binding)?,"ownership_revision":revision.to_string(),
        "content_incarnation":token.incarnation,"content_revision":token.revision,"sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&token).map_err(|_|"transfer_intent_invalid")?))});
    let sent = wrap(request(
        "reserve",
        "0",
        &binding["transfer_id"],
        json!({"binding":binding,"frozen":frozen,"expected_ledger_revision":if existing{ledger["revision"].clone()}else{json!("1")}}),
    ));
    let (reservation, _) = crate::db::connect_transfer::reserve_verified_source(
        owner, admission, caller, browser, inspection, transport, &sent,
    )
    .await
    .map_err(|_| "transfer_source_reservation")?;
    let capture = crate::db::source_capture::SourceCapture::for_transfer(
        owner.clone(),
        transport.clone(),
        reservation.transfer_id(),
    )
    .await
    .map_err(|e| crate::connect::transfer_worker::storage_error(e, "source_capture"))?;
    let sealed = capture
        .capture_transfer(&reservation)
        .await
        .map_err(|e| crate::connect::transfer_worker::storage_error(e, "source_capture"))?;
    transport.refresh_authority(manager.clone(), ready).await?;
    let normalized = launcher
        .normalize_capture(config, transport, &capture)
        .await?;
    let manifest = reservation
        .source_manifest(owner, &normalized)
        .await
        .map_err(|_| "source_manifest")?;
    if !existing {
        let birth = wrap(request(
            "lineage.create",
            "0",
            &Value::Null,
            json!({"provenance":binding["provenance"],"mode":"initial_existing","creation_digest":frozen["sha256"]}),
        ));
        drop(
            transport
                .source_decision(
                    manager.clone(),
                    ready,
                    owner,
                    &reservation,
                    &normalized,
                    &(source_path.clone() + "/decisions"),
                    birth,
                    Value::Null,
                    "lineage_enrolled",
                )
                .await?,
        );
    }
    let reserve_path = format!(
        "{source_path}/targets/{target}/reservations/{}/decisions",
        reservation.transfer_id()
    );
    let reserved = output(
        transport
            .source_decision(
                manager.clone(),
                ready,
                owner,
                &reservation,
                &normalized,
                &reserve_path,
                sent,
                expectation(&binding, &frozen, &Value::Null, &Value::Null, &Value::Null),
                "source_frozen",
            )
            .await?,
    )?;
    let known = format!(
        "/pilot/v2/transfers/known/{}/decisions",
        reservation.transfer_id()
    );
    // From here the relay holds a record: any failure ends in a durable terminal.
    let mut step = Progress {
        revision: text(&reserved["result"]["status"]["revision"])?.to_owned(),
        manifest: Value::Null,
        prepared: Value::Null,
    };
    let attempt=async {
    let seal=wrap(request("seal",&step.revision,&binding["transfer_id"],json!({"manifest":manifest})));
    let sealed_reply=output(transport.source_decision(manager.clone(),ready,owner,&reservation,&normalized,&known,seal,expectation(&binding,&frozen,&manifest,&Value::Null,&Value::Null),"source_sealed").await?)?;
    step.manifest=manifest.clone();
    let sealed_revision=text(&sealed_reply["result"]["status"]["revision"])?;step.revision=sealed_revision.to_owned();
    let (descriptor,archive)=normalized.normalized_for(&sealed.manifest)?;
    let session=json!({"transfer_id":reservation.transfer_id(),"transit_id":uuid::Uuid::new_v4(),"binding_digest":transport::commitment("transfer-binding",&binding)?,
        "frozen_digest":transport::commitment("frozen",&frozen)?,"manifest_digest":transport::commitment("manifest",&manifest)?,"content_contract_sha256":descriptor["content_contract_sha256"],
        "portable_records":descriptor["records"].as_u64().ok_or("transfer_archive")?.to_string(),"portable_fragments":archive.as_slice().split(|b|*b==b'\n').filter(|line|!line.is_empty()).count().saturating_sub(1).to_string(),
        "portable_payload_bytes":descriptor["bytes"].as_u64().ok_or("transfer_archive")?.to_string(),"stream_bytes":archive.as_slice().len().to_string()});
    drop(transport.transit(manager.clone(),ready,&format!("/pilot/v2/transfers/known/{}/transit",reservation.transfer_id()),json!({"transit_contract":"transfer-transit-1","type":"transit.open","request_id":uuid::Uuid::new_v4(),"session":session,"provider_id":provider_id,"model_id":model_id}),&session).await?);
    let root=format!("/pilot/v2/transfers/transits/{}",text(&session["transit_id"])?);
    let mut offset=0;let mut sequence=0u64;
    let mut quiet=tokio::time::Instant::now()+target_quiet();
    while offset<archive.as_slice().len(){
        let received=output(transport.delivery(manager.clone(),ready).await?)?;
        if received["branch"]=="empty"{if tokio::time::Instant::now()>quiet{return Err("target_unresponsive");}continue;}
        quiet=tokio::time::Instant::now()+target_quiet();
        let message=&received["value"]["body"]["message"];
        if received["branch"]!="transit" || received["value"]["body"]["kind"]!="transit.pull" || message["transfer_id"]!=session["transfer_id"]
            || message["transit_id"]!=session["transit_id"] || message["offset"]!=offset.to_string() || message["sequence"]!=sequence.to_string(){return Err("transit_pull");}
        let mut end=(offset+65_536).min(archive.as_slice().len());
        while std::str::from_utf8(&archive.as_slice()[offset..end]).is_err()&&end>offset {end-=1;}
        if end==offset{return Err("transit_utf8");}
        let bytes=&archive.as_slice()[offset..end];
        let chunk=json!({"transit_contract":"transfer-transit-1","type":"transit.chunk","request_id":uuid::Uuid::new_v4(),"transfer_id":session["transfer_id"],"transit_id":session["transit_id"],
            "sequence":sequence.to_string(),"offset":offset.to_string(),"length":bytes.len().to_string(),"sha256":format!("{:x}",Sha256::digest(bytes)),"eof":end==archive.as_slice().len(),"data_utf8":std::str::from_utf8(bytes).map_err(|_|"transit_utf8")?});
        transport.transit(manager.clone(),ready,&(root.clone()+"/chunk"),chunk,&session).await?;offset=end;sequence+=1;
    }
    let quiet=tokio::time::Instant::now()+TARGET_PREPARATION;
    let proposal=loop{
        let received=output(transport.delivery(manager.clone(),ready).await?)?;
        if received["branch"]=="empty"{if tokio::time::Instant::now()>quiet{return Err("target_unresponsive");}continue;}
        let proposal=&received["value"]["body"]["message"];
        if received["branch"]!="transit" || received["value"]["body"]["kind"]!="transit.prepared" || proposal["transfer_id"]!=session["transfer_id"] || proposal["transit_id"]!=session["transit_id"]{return Err("transit_prepared");}
        break proposal["prepared"].clone();
    };
    let progress=output(transport.transit(manager.clone(),ready,&(root+"/status"),json!({"transit_contract":"transfer-transit-1","type":"transit.status","request_id":uuid::Uuid::new_v4(),"transfer_id":session["transfer_id"],"transit_id":session["transit_id"]}),&session).await?.ok_or("transit_progress")?)?;
    if progress["cursor"]["eof"]!=true || progress["cursor"]["next_offset"]!=archive.as_slice().len().to_string(){return Err("transit_progress");}
    let ready_request=request("ready",sealed_revision,&binding["transfer_id"],json!({"prepared":proposal}));
    challenge_target(transport,manager.clone(),ready,&binding,&manifest,&proposal,&ready_request,"target_pinned").await?;
    step.prepared=proposal.clone();
    let ready_reply=after_target_proof(transport,manager.clone(),ready,&known,wrap(ready_request),expectation(&binding,&frozen,&manifest,&proposal,&Value::Null)).await?;
    step.revision=text(&ready_reply["result"]["status"]["revision"])?.to_owned();
    let commit=wrap(request("commit",&step.revision,&binding["transfer_id"],json!({})));
    challenge_target(transport,manager.clone(),ready,&binding,&manifest,&proposal,&commit["request"],"target_maintained").await?;
    let committed=match transport.source_decision(manager.clone(),ready,owner,&reservation,&normalized,&known,commit.clone(),expectation(&binding,&frozen,&manifest,&proposal,&Value::Null),"source_maintained").await {
        Ok(reply)=>output(reply)?,Err("forbidden")=>after_target_proof(transport,manager.clone(),ready,&known,commit,expectation(&binding,&frozen,&manifest,&proposal,&Value::Null)).await?,Err(error)=>return Err(error),
    };
    if committed["result"]["status"]["phase"]!="committed"{return Err("commit_reply");}
    Ok(())
    }.await;
    if let Err(error) = attempt {
        abandon(
            transport,
            manager.clone(),
            ready,
            &known,
            &binding,
            &frozen,
            &mut step,
            error,
        )
        .await?;
    }
    let terminal = transport.terminal(reservation.transfer_id()).await?;
    if terminal["outcome"] == "aborted" {
        reservation
            .apply_aborted_source(owner)
            .await
            .map_err(|_| "source_application")?;
        return Err("transfer_aborted");
    }
    let terminal = transport
        .committed_terminal(reservation.transfer_id())
        .await?;
    let proposal = terminal["prepared"].clone();
    // The source stays frozen until it can cede: a committed decision never reopens it.
    for _ in 0..100 {
        let status = transport
            .transfer_status(
                manager.clone(),
                ready,
                &binding,
                &frozen,
                &manifest,
                &proposal,
                &terminal,
            )
            .await?;
        if !status["activation"].is_null() {
            reservation
                .apply_committed_source(owner, &normalized)
                .await
                .map_err(|_| "source_application")?;
            return Ok(text(&proposal["target_conversation_id"])?.to_owned());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("target_activation_pending")
}

/// Wait without traffic from the target before the source gives up.
const TARGET_QUIET: Duration = Duration::from_secs(60);
fn target_quiet() -> Duration {
    #[cfg(test)]
    if let Some(ms) = std::env::var("MACRO_CONNECT_TEST_TARGET_QUIET_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
    {
        return Duration::from_millis(ms);
    }
    TARGET_QUIET
}
/// Covers target import and preparation, each bounded by its worker deadline.
const TARGET_PREPARATION: Duration = Duration::from_secs(120);
struct Progress {
    revision: String,
    manifest: Value,
    prepared: Value,
}
/// Records `aborted` for the attempt, unless the relay already holds a terminal.
/// A stale revision means a step reply was lost; the next revision is tried.
/// Without a terminal the source stays frozen and the original error is returned.
async fn abandon<B: Vault + 'static>(
    transport: &VerifiedTransport,
    manager: Arc<Manager<B>>,
    ready: &DbReady,
    known: &str,
    binding: &Value,
    frozen: &Value,
    step: &mut Progress,
    error: &'static str,
) -> Result<()> {
    for _ in 0..3 {
        let sent = wrap(request(
            "abort",
            &step.revision,
            &binding["transfer_id"],
            json!({"reason":"user_cancelled"}),
        ));
        match transport
            .decision(
                manager.clone(),
                ready,
                known,
                sent,
                expectation(
                    binding,
                    frozen,
                    &step.manifest,
                    &step.prepared,
                    &Value::Null,
                ),
            )
            .await
        {
            Ok(_) => return Ok(()),
            Err("stale_revision") => {
                step.revision = step
                    .revision
                    .parse::<u64>()
                    .map_err(|_| error)?
                    .checked_add(1)
                    .ok_or(error)?
                    .to_string()
            }
            Err(_) => return Err(error),
        }
    }
    Err(error)
}

pub(super) async fn receive<B: Vault + 'static>(
    manager: Arc<Manager<B>>,
    owner: &DbPool,
    config: &ConfigManager,
    launcher: &CodecLauncher,
    mut transport: VerifiedTransport,
    ready: &DbReady,
    job: &crate::connect::runtime::TransferJob,
) -> Result<(String, TransferWorker)> {
    let intent = transport
        .receive_target_invitation(manager.clone(), ready, job)
        .await?;
    let session = &intent["session"];
    let manifest = &intent["manifest"];
    let binding = &intent["binding"];
    let frozen = &intent["frozen"];
    let provider_id = text(&intent["provider_id"])?;
    let model_id = text(&intent["model_id"])?;
    crate::connect::runtime::transfer_target_snapshot(config, ready, provider_id, model_id).await?;
    let transport = Arc::new(transport);
    let mut reservation =
        crate::db::connect_transfer::reserve_verified_target(owner, &transport, &intent, manifest)
            .await
            .map_err(|_| "target_reservation")?;
    let root = format!(
        "/pilot/v2/transfers/transits/{}",
        text(&session["transit_id"])?
    );
    let mut sequence = 0i64;
    let mut offset = 0i64;
    loop {
        transport.refresh_authority(manager.clone(), ready).await?;
        transport.transit(manager.clone(),ready,&(root.clone()+"/pull"),json!({"transit_contract":"transfer-transit-1","type":"transit.pull","request_id":uuid::Uuid::new_v4(),"transfer_id":session["transfer_id"],"transit_id":session["transit_id"],"sequence":sequence.to_string(),"offset":offset.to_string()}),session).await?;
        let received = output(transport.delivery(manager.clone(), ready).await?)?;
        if received["branch"] != "transit" || received["value"]["body"]["kind"] != "transit.chunk" {
            return Err("transit_chunk");
        }
        let chunk = &received["value"]["body"]["message"];
        let staged = reservation
            .stage_target(owner, &intent, manifest, chunk)
            .await
            .map_err(|_| "target_staging")?;
        let mut ack = chunk.clone();
        ack.as_object_mut()
            .ok_or("transit_chunk")?
            .remove("data_utf8");
        ack["type"] = json!("transit.ack");
        ack["request_id"] = json!(uuid::Uuid::new_v4());
        ack["next_offset"] = json!(staged.1.to_string());
        drop(
            transport
                .transit(
                    manager.clone(),
                    ready,
                    &(root.clone() + "/ack"),
                    ack,
                    session,
                )
                .await?,
        );
        (sequence, offset) = (staged.0, staged.1);
        if staged.2 {
            break;
        }
    }
    let archive = reservation
        .staged_target(owner, &intent, manifest)
        .await
        .map_err(|_| "target_staging")?;
    let descriptor: Value = serde_json::from_slice(
        archive
            .split(|b| *b == b'\n')
            .next()
            .ok_or("transfer_archive")?,
    )
    .map_err(|_| "transfer_archive")?;
    let storage = crate::db::inactive_storage::InactiveStorage::for_transfer(
        owner,
        transport.clone(),
        intent.clone(),
        manifest.clone(),
    )
    .await
    .map_err(|e| crate::connect::transfer_worker::storage_error(e, "target_storage"))?;
    #[cfg(test)]
    if let Ok(delay) = std::env::var("MACRO_CONNECT_TEST_PHASE_DELAY_MS") {
        let delay = delay.parse::<u64>().map_err(|_| "invalid_delay")?;
        if delay > 35_000 {
            return Err("invalid_delay");
        }
        transport.refresh_authority(manager.clone(), ready).await?;
        super::tests::transfer_wait_with_idle_poll(
            &transport,
            manager.clone(),
            ready,
            false,
            tokio::time::sleep(Duration::from_millis(delay)),
        )
        .await;
        assert_eq!(transport.check().await.err(), Some("authority_expired"));
        assert_eq!(
            storage.check_native().await.err().as_deref(),
            Some("authority_expired")
        );
    }
    transport.refresh_authority(manager.clone(), ready).await?;
    let imported = launcher
        .import_archive(config, &transport, &storage, &archive, &descriptor)
        .await?;
    reservation
        .attach_imported_target(owner, &intent, manifest, &imported)
        .await
        .map_err(|_| "target_import")?;
    transport.refresh_authority(manager.clone(), ready).await?;
    let mut prepared = launcher
        .prepare_archive(
            config,
            &transport,
            &storage,
            &imported,
            provider_id,
            model_id,
        )
        .await?;
    reservation
        .pin_target(owner, config, &imported, &mut prepared, &intent, manifest)
        .await
        .map_err(|_| "target_pin")?;
    let proposal = reservation
        .target_prepared()
        .await
        .map_err(|_| "target_pin")?
        .clone();
    transport.transit(manager.clone(),ready,&(root+"/prepared"),json!({"transit_contract":"transfer-transit-1","type":"transit.prepared","request_id":uuid::Uuid::new_v4(),"transfer_id":session["transfer_id"],"transit_id":session["transit_id"],"prepared":proposal}),session).await?;
    for expected in ["target_pinned", "target_maintained"] {
        loop {
            let delivery = transport.delivery(manager.clone(), ready).await?;
            let received: Value = serde_json::from_slice(delivery.bytes.as_slice())
                .map_err(|_| "invalid_delivery")?;
            if received["branch"] == "empty" {
                drop(delivery);
                continue;
            }
            if received["value"]["body"]["exchange"]["kind"] != expected {
                return Err("target_proof_unexpected");
            }
            transport
                .attest_target(
                    manager.clone(),
                    ready,
                    owner,
                    &reservation,
                    config,
                    &prepared,
                    delivery,
                )
                .await?;
            break;
        }
    }
    // The pinned preparation is kept on timeout: only a terminal decides it.
    let deadline = tokio::time::Instant::now() + TARGET_PREPARATION;
    loop {
        let status = transport
            .transfer_status(
                manager.clone(),
                ready,
                binding,
                frozen,
                manifest,
                &proposal,
                &Value::Null,
            )
            .await?;
        if status["phase"] == "committed" {
            break;
        }
        if !status["terminal"].is_null() {
            return Err("transfer_aborted");
        }
        if tokio::time::Instant::now() > deadline {
            return Err("source_commit_timeout");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let conversation = reservation
        .publish_target(owner, config, &prepared)
        .await
        .map_err(|_| "target_publication")?;
    let terminal = transport
        .committed_terminal(text(&binding["transfer_id"])?)
        .await?;
    let activation = reservation
        .target_activation()
        .map_err(|_| "target_publication")?;
    let sent = wrap(request(
        "activation.record",
        &terminal["decision_revision"]
            .as_str()
            .ok_or("terminal_mismatch")?,
        &binding["transfer_id"],
        json!({"activation":activation}),
    ));
    let expected = reservation
        .target_expectation(
            owner,
            config,
            &prepared,
            &sent["request"],
            "target_activated",
        )
        .await
        .map_err(|_| "target_proof_refused")?;
    let challenge = json!({"transit_contract":"transfer-transit-1","type":"decision.challenge","request_id":uuid::Uuid::new_v4(),"kind":"target_activated","request":sent["request"]});
    let known = format!(
        "/pilot/v2/transfers/known/{}",
        text(&binding["transfer_id"])?
    );
    drop(
        transport
            .metadata(
                manager.clone(),
                ready,
                &(known.clone() + "/challenges"),
                challenge.clone(),
                json!({"kind":"challenge","sent":challenge,"exchange":expected}),
            )
            .await?,
    );
    let delivery = transport.delivery(manager.clone(), ready).await?;
    transport
        .attest_target(
            manager.clone(),
            ready,
            owner,
            &reservation,
            config,
            &prepared,
            delivery,
        )
        .await?;
    drop(
        transport
            .decision(
                manager.clone(),
                ready,
                &(known + "/decisions"),
                sent,
                expectation(binding, frozen, manifest, &proposal, &terminal),
            )
            .await?,
    );
    drop(reservation);
    drop(storage);
    drop(imported);
    Arc::try_unwrap(transport)
        .map_err(|_| "transport_retained")?
        .close()
        .await?;
    Ok((conversation, prepared))
}
