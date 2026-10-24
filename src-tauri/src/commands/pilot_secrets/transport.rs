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
    authority: serde_json::Value,
    observation: PolicyObservation,
    deadline: Instant,
    runtime: TransferRuntime,
    generation: u64,
    cancel: CancellationToken,
    _snapshot: Arc<PolicySnapshot<TransportPair>>,
    _charge: TransitCharge,
}
impl VerifiedTransport {
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
        if self.cancel.is_cancelled() {
            return Err("http_cancelled");
        }
        if self.runtime.generation()? != self.generation {
            return Err("transport_retired");
        }
        self.observation
            .check_local()
            .map_err(|_| "policy_revoked")?;
        if Instant::now() >= self.deadline
            || self
                .session
                .expires_at_ms
                .is_some_and(|expiry| now_ms().map_or(true, |now| now >= expiry))
        {
            return Err("authority_expired");
        }
        Ok(())
    }
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

pub(crate) async fn bootstrap(
    intent: Intent,
    runtime: &TransferRuntime,
    launcher: &CodecLauncher,
    ready: &DbReady,
    cancel: &CancellationToken,
) -> Result<VerifiedTransport> {
    let manager = super::manager().map_err(|_| "vault_unavailable")?;
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
    path: &'static str,
    body: Bytes,
    producer: bool,
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
    let prepared = session.prepare(false).await?;
    let request = Request::from_admitted(&runtime.budget()?, method, path, body)?;
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
    let output = decode(
        codec,
        10,
        facts,
        response.into_codec_body()?,
        cancel,
    )
    .await?;
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
    let output = decode(
        codec,
        2,
        facts,
        response.into_codec_body()?,
        cancel,
    )
    .await?;
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
        authority,
        observation,
        runtime: runtime.clone(),
        generation,
        cancel: cancel.clone(),
        deadline: std::cmp::min(
            started + Duration::from_secs(30),
            Instant::now() + Duration::from_millis(remaining),
        ),
        _snapshot: snapshot,
        _charge: retained,
    };
    verified.check().await?;
    Ok(verified)
}
