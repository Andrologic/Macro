//! Flow-owned pure clock jobs, separate from the Agent work protocol.
use crate::db::agsdl_execution::{
    dto::EngineOwner, failure, flow030::FlowIdentity030, validate_json, Result,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{oneshot, Notify};
use tokio_util::sync::CancellationToken;

/// Durable epoch milliseconds. Persisted origins remain comparable after restart.
pub(crate) trait Clock030: Send + Sync {
    fn now_ms(&self) -> u64;
}
pub(crate) struct MonotoneClock030 {
    origin: u64,
    started: Instant,
}
impl Default for MonotoneClock030 {
    fn default() -> Self {
        Self {
            origin: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("epoch clock")
                .as_millis()
                .try_into()
                .expect("epoch milliseconds"),
            started: Instant::now(),
        }
    }
}
impl Clock030 for MonotoneClock030 {
    fn now_ms(&self) -> u64 {
        self.origin
            .checked_add(
                u64::try_from(self.started.elapsed().as_millis())
                    .expect("monotone milliseconds overflow"),
            )
            .expect("epoch milliseconds overflow")
    }
}
#[cfg(any(test, all(feature = "agsdl-engine-qa", debug_assertions)))]
#[derive(Default)]
pub(crate) struct VirtualClock030(std::sync::atomic::AtomicU64);
#[cfg(any(test, all(feature = "agsdl-engine-qa", debug_assertions)))]
impl Clock030 for VirtualClock030 {
    fn now_ms(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}
#[cfg(any(test, all(feature = "agsdl-engine-qa", debug_assertions)))]
impl VirtualClock030 {
    // Only the pinned QA driver may advance; call at each broker boundary, then
    // stabilize the flow before continuing the remainder of a large elapse.
    pub(crate) fn advance_to(&self, at: u64) -> Result<()> {
        self.0
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |old| (at >= old).then_some(at),
            )
            .map_err(|_| failure("CORRELATION", "clock", "Clock moved backwards"))?;
        Ok(())
    }
}

const MAX_JOBS: usize = 64;
const MAX_BYTES: usize = 8_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostClockInput030 {
    pub identity: FlowIdentity030,
    pub owner: EngineOwner,
    pub event_id: String,
    pub expected_revision: String,
    pub state_json: String,
    pub event_json: String,
    pub options_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostClockJob030 {
    pub ticket: String,
    pub generation: String,
    pub input_digest: String,
    pub input: HostClockInput030,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostClockOutput030 {
    pub state_json: String,
    pub receipt_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostClockCompletion030 {
    pub ticket: String,
    pub generation: String,
    pub input_digest: String,
    pub output: HostClockOutput030,
}

struct Pending {
    job: HostClockJob030,
    issued: bool,
    reply: oneshot::Sender<Result<HostClockOutput030>>,
}

#[derive(Default)]
struct Queue {
    closed: bool,
    ready: VecDeque<String>,
    pending: BTreeMap<String, Pending>,
    // Retain only correlation, not potentially large cancelled inputs.
    retired: BTreeMap<String, (String, String)>,
    retired_order: VecDeque<String>,
}

#[derive(Default)]
pub(crate) struct ClockBroker030 {
    route: Option<std::sync::Arc<crate::agsdl_host_route030::RouteBroker030>>,
    queue: Mutex<Queue>,
    available: Notify,
}

struct TicketGuard<'a> {
    broker: &'a ClockBroker030,
    ticket: String,
}
impl Drop for TicketGuard<'_> {
    fn drop(&mut self) {
        let mut queue = self.broker.queue.lock().expect("work mailbox");
        if let Some(pending) = queue.pending.remove(&self.ticket) {
            if pending.issued && !queue.closed {
                if queue.retired.len() == MAX_JOBS {
                    if let Some(oldest) = queue.retired_order.pop_front() {
                        queue.retired.remove(&oldest);
                    }
                }
                queue.retired_order.push_back(self.ticket.clone());
                queue.retired.insert(
                    self.ticket.clone(),
                    (pending.job.generation, pending.job.input_digest),
                );
            }
        }
        queue.ready.retain(|ticket| ticket != &self.ticket);
    }
}

impl ClockBroker030 {
    pub(crate) fn from_route(
        route: std::sync::Arc<crate::agsdl_host_route030::RouteBroker030>,
    ) -> Self {
        Self {
            route: Some(route),
            ..Self::default()
        }
    }
    pub(crate) fn close(&self) {
        let mut queue = self.queue.lock().expect("work mailbox");
        queue.closed = true;
        queue.ready.clear();
        queue.retired.clear();
        queue.retired_order.clear();
        for (_, pending) in std::mem::take(&mut queue.pending) {
            let _ = pending.reply.send(Err(failure(
                "RUNTIME_UNAVAILABLE",
                "work",
                "Work protocol host was revoked",
            )));
        }
        self.available.notify_waiters();
    }

    /// Only native code submits work after reserving its durable event. A returned
    /// decision still requires SQL CAS and native evidence validation before use.
    pub(crate) async fn evaluate(
        &self,
        generation: &str,
        input: HostClockInput030,
        cancelled: &CancellationToken,
    ) -> Result<HostClockOutput030> {
        let bytes = serde_json::to_vec(&input)?;
        if bytes.len() > MAX_BYTES {
            return Err(failure(
                "INPUT_LIMIT",
                "work",
                "Work transition exceeds the host transport limit",
            ));
        }
        if !input.state_json.is_empty() {
            validate_json(&input.state_json)?;
        }
        for json in [&input.event_json, &input.options_json] {
            validate_json(json)?;
        }
        if generation.is_empty()
            || input.event_id.trim().is_empty()
            || input.owner.system_start_id != input.identity.system_start_id
            || input.expected_revision.is_empty()
            || !input.expected_revision.bytes().all(|c| c.is_ascii_digit())
            || input.expected_revision.len() > 1 && input.expected_revision.starts_with('0')
        {
            return Err(failure(
                "CORRELATION",
                "work",
                "Invalid work transition identity",
            ));
        }
        if let Some(route) = &self.route {
            let input_json =
                serde_json::json!({"operation":"humanClock", "input":input}).to_string();
            let raw = route.evaluate(generation, input_json, cancelled).await?;
            return Ok(serde_json::from_str(&raw)?);
        }
        let ticket = uuid::Uuid::new_v4().to_string();
        let job = HostClockJob030 {
            ticket: ticket.clone(),
            generation: generation.into(),
            input_digest: format!("sha256:{:x}", Sha256::digest(bytes)),
            input,
        };
        let (reply, receiver) = oneshot::channel();
        {
            let mut queue = self.queue.lock().expect("work mailbox");
            if queue.closed || cancelled.is_cancelled() || queue.pending.len() >= MAX_JOBS {
                return Err(failure(
                    "RUNTIME_UNAVAILABLE",
                    "work",
                    "Work protocol host is unavailable or busy",
                ));
            }
            queue.pending.insert(
                ticket.clone(),
                Pending {
                    job,
                    issued: false,
                    reply,
                },
            );
            queue.ready.push_back(ticket.clone());
        }
        let _guard = TicketGuard {
            broker: self,
            ticket,
        };
        self.available.notify_one();
        // Work/host cancellation is authoritative. No transport timeout may
        // silently expire a person's wait or reset the work's machine budget.
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => Err(failure("INTERRUPTED", "work", "Work transition was cancelled")),
            result = receiver => result.map_err(|_| failure("RUNTIME_UNAVAILABLE", "work", "Work transition receiver was lost"))?,
        }
    }

    pub(crate) async fn next(&self) -> Result<HostClockJob030> {
        loop {
            let wake = self.available.notified();
            {
                let mut queue = self.queue.lock().expect("work mailbox");
                if queue.closed {
                    return Err(failure(
                        "RUNTIME_UNAVAILABLE",
                        "work",
                        "Work protocol host was revoked",
                    ));
                }
                while let Some(ticket) = queue.ready.pop_front() {
                    if let Some(pending) = queue.pending.get_mut(&ticket) {
                        pending.issued = true;
                        return Ok(pending.job.clone());
                    }
                }
            }
            wake.await;
        }
    }

    pub(crate) fn complete(
        &self,
        generation: &str,
        completion: HostClockCompletion030,
    ) -> Result<()> {
        if serde_json::to_vec(&completion)?.len() > MAX_BYTES {
            return Err(failure(
                "INPUT_LIMIT",
                "work",
                "Work transition result exceeds the host transport limit",
            ));
        }
        validate_json(&completion.output.state_json)?;
        validate_json(&completion.output.receipt_json)?;
        let mut queue = self.queue.lock().expect("work mailbox");
        if !queue.closed
            && completion.generation == generation
            && !queue.pending.contains_key(&completion.ticket)
            && !queue.retired.contains_key(&completion.ticket)
        {
            // An evicted cancellation, duplicate, or unknown ticket can never
            // deliver a decision. The host may discard this specific error.
            return Err(failure(
                "STALE_TICKET",
                "ticket",
                "Work ticket is no longer active",
            ));
        }
        let expected = queue
            .pending
            .get(&completion.ticket)
            .filter(|pending| pending.issued)
            .map(|pending| (&pending.job.generation, &pending.job.input_digest))
            .or_else(|| queue.retired.get(&completion.ticket).map(|(g, d)| (g, d)));
        if queue.closed
            || completion.generation != generation
            || expected != Some((&completion.generation, &completion.input_digest))
        {
            return Err(failure(
                "CORRELATION",
                "ticket",
                "Work transition does not match an issued native ticket",
            ));
        }
        if let Some(pending) = queue.pending.remove(&completion.ticket) {
            let _ = pending.reply.send(Ok(completion.output));
        } else {
            // A cancelled pure evaluation may finish late. Acknowledge only its
            // identity; there is no receiver, durable commit or effect to revive.
            queue.retired.remove(&completion.ticket);
            queue
                .retired_order
                .retain(|ticket| ticket != &completion.ticket);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn input() -> HostClockInput030 {
        HostClockInput030 {
            identity: FlowIdentity030 {
                system_start_id: "run".into(),
                flow_invocation_id: "flow".into(),
                snapshot_id: "snapshot".into(),
                epoch: "capture".into(),
            },
            owner: EngineOwner {
                system_start_id: "run".into(),
                owner_epoch: "owner".into(),
            },
            event_id: "tick".into(),
            expected_revision: "0".into(),
            state_json: "".into(),
            event_json: "{}".into(),
            options_json: "{}".into(),
        }
    }
    fn completion(job: &HostClockJob030) -> HostClockCompletion030 {
        HostClockCompletion030 {
            ticket: job.ticket.clone(),
            generation: job.generation.clone(),
            input_digest: job.input_digest.clone(),
            output: HostClockOutput030 {
                state_json: "{}".into(),
                receipt_json: "{}".into(),
            },
        }
    }
    #[tokio::test]
    async fn clock_mailbox_rejects_forged_digest_generation_and_cancelled_ticket_revival() {
        let broker = Arc::new(ClockBroker030::default());
        let cancelled = CancellationToken::new();
        let worker = {
            let broker = broker.clone();
            let cancelled = cancelled.clone();
            tokio::spawn(async move { broker.evaluate("generation", input(), &cancelled).await })
        };
        let job = broker.next().await.unwrap();
        let mut forged = completion(&job);
        forged.input_digest = "forged".into();
        assert!(broker.complete("generation", forged).is_err());
        assert!(broker.complete("foreign", completion(&job)).is_err());
        cancelled.cancel();
        assert!(worker.await.unwrap().is_err());
        broker.complete("generation", completion(&job)).unwrap();
        assert!(broker.complete("generation", completion(&job)).is_err());
        broker.close();
        assert!(broker.next().await.is_err());
    }
    #[test]
    fn production_clock_keeps_a_durable_epoch_across_instances() {
        let first = MonotoneClock030::default();
        let at = first.now_ms();
        assert!(at > 1_600_000_000_000);
        let replacement = MonotoneClock030::default();
        assert!(replacement.now_ms() >= at);
    }

    #[test]
    fn production_clock_never_moves_backwards() {
        let clock = MonotoneClock030::default();
        let at = clock.now_ms();
        assert!(clock.now_ms() >= at);
    }
    #[cfg(any(test, all(feature = "agsdl-engine-qa", debug_assertions)))]
    #[test]
    fn virtual_clock_is_exact_and_refuses_time_reversal() {
        let clock = VirtualClock030::default();
        assert_eq!(clock.now_ms(), 0);
        clock.advance_to(86400001).unwrap();
        assert_eq!(clock.now_ms(), 86400001);
        assert!(clock.advance_to(86400000).is_err());
    }
}

/// Call from the handoff writer after inserting its owned receipt, BEFORE
/// settling the outbox or committing/releasing the physical future. A delivered
/// historical handoff cannot be backfilled with a new clock origin.
pub(crate) async fn record_handoff_clock_tx(
    db: &mut sqlx::SqliteConnection,
    lease: &crate::agsdl_host::HostStartLease,
    effect: &crate::db::agsdl_execution::flow030::FlowEffect030,
    clock: &dyn Clock030,
) -> Result<()> {
    use crate::db::agsdl_execution::flow030::FlowEffectKind030;
    use sqlx::Row;
    if !matches!(effect.kind, FlowEffectKind030::Start { .. }) {
        return Err(failure(
            "CORRELATION",
            "clock",
            "Clock origin requires a Start",
        ));
    }
    let id = &effect.identity;
    lease.ensure_live()?;
    let owner = lease.owner(&id.system_start_id)?;
    let row = sqlx::query("SELECT o.owner_epoch,o.generation,o.snapshot_id,o.capture_epoch,o.status,e.effect_json,e.status AS effect_status,h.receipt_json FROM engine_flow030_owners o JOIN engine_flow030_outbox e ON e.system_id=o.system_id AND e.invocation_id=o.invocation_id JOIN engine_flow030_handoffs h ON h.system_id=e.system_id AND h.invocation_id=e.invocation_id AND h.effect_id=e.effect_id WHERE o.system_id=? AND o.invocation_id=? AND e.effect_id=? AND h.owner_epoch=o.owner_epoch AND h.generation=o.generation")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&effect.id).fetch_one(&mut *db).await?;
    let handoff: serde_json::Value = serde_json::from_str(row.get("receipt_json"))?;
    if row.get::<&str, _>("status") != "live"
        || row.get::<&str, _>("owner_epoch") != owner.owner_epoch
        || row.get::<&str, _>("generation") != lease.generation()
        || row.get::<&str, _>("snapshot_id") != id.snapshot_id
        || row.get::<&str, _>("capture_epoch") != id.epoch
        || row.get::<&str, _>("effect_status") != "uncertain"
        || serde_json::from_str::<serde_json::Value>(row.get("effect_json"))?
            != serde_json::to_value(effect)?
        || handoff["kind"] != "nativeOwnedHandoff030"
        || handoff["identity"] != serde_json::to_value(id)?
        || handoff["effectId"] != effect.id
        || handoff["ownerEpoch"] != owner.owner_epoch
        || handoff["generation"] != lease.generation()
    {
        return Err(failure(
            "CORRELATION",
            "clock",
            "Clock origin requires an unsettled owned handoff",
        ));
    }
    sqlx::query(
        "INSERT INTO engine_flow030_handoff_clock VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(&id.system_start_id)
    .bind(&id.flow_invocation_id)
    .bind(&effect.id)
    .bind(&owner.owner_epoch)
    .bind(lease.generation())
    .bind(clock.now_ms().to_string())
    .execute(db)
    .await?;
    Ok(())
}
