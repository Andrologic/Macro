//! Authenticated transport for pure work transitions. SQL owns their commit;
//! this mailbox neither authorizes effects nor chooses flow successors.
use crate::db::agsdl_execution::{dto::EngineContext, failure, validate_json, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;
use tokio::sync::{oneshot, Notify};
use tokio_util::sync::CancellationToken;

/// Borrowed native 0.3 capture fields. The host authenticates the capture,
/// admitted instance and epoch before selecting a contract.
pub(crate) struct CapturedWorkPlan030<'a> {
    pub system_start_id: &'a str,
    pub source: &'a crate::db::agsdl_execution::dto::EngineSourceRevision,
    pub versions: &'a crate::db::agsdl_execution::dto::EngineVersions,
    pub compiled_plan_json: &'a str,
}

/// Select only the exact 04 contract from an authenticated 02 plan.
/// This function does not authenticate the caller or grant work admission.
pub(crate) fn captured_work_contract030(
    snapshot: &CapturedWorkPlan030<'_>,
    work: &crate::db::agsdl_execution::dto::EngineWork,
    agent_name: &str,
) -> Result<String> {
    use serde_json::Value;
    validate_json(&snapshot.compiled_plan_json)?;
    let plan: Value = serde_json::from_str(&snapshot.compiled_plan_json)?;
    if snapshot.system_start_id != work.system_start_id
        || plan.get("format").and_then(Value::as_str) != Some("macro-agsdl-compiled-plan/2")
        || snapshot.versions.snapshot != "2"
        || snapshot.versions.contract != "agsdl-0.3.0"
        || snapshot.versions.profile != "macro-agsdl-030-v1"
        || plan.get("versions") != Some(&serde_json::to_value(snapshot.versions)?)
        || plan.get("source") != Some(&serde_json::to_value(snapshot.source)?)
        || agent_name.trim().is_empty()
    {
        return Err(failure(
            "CORRELATION",
            "contract",
            "Work and captured 0.3 plan differ",
        ));
    }
    let value = match &work.step {
        Some(address) => {
            if plan.get("entry").and_then(Value::as_array).is_none() {
                return Err(failure(
                    "CORRELATION",
                    "contract",
                    "Flow work has no captured flow",
                ));
            }
            let steps = plan
                .get("steps")
                .and_then(Value::as_array)
                .ok_or_else(|| failure("CORRELATION", "contract", "Captured steps are absent"))?;
            let address_json = serde_json::to_value(address)?;
            let mut matches = steps
                .iter()
                .filter(|step| step.get("address") == Some(&address_json));
            let step = matches
                .next()
                .ok_or_else(|| failure("CORRELATION", "contract", "Work step is absent"))?;
            if matches.next().is_some()
                || step.get("type").and_then(Value::as_str) != Some("agent")
                || step.get("agent").and_then(Value::as_str) != Some(agent_name)
            {
                return Err(failure(
                    "CORRELATION",
                    "contract",
                    "Work step or agent differs",
                ));
            }
            step.get("submissionContractJson")
        }
        None => {
            if plan.get("entry") != Some(&Value::Null) {
                return Err(failure(
                    "CORRELATION",
                    "contract",
                    "Direct work requires a graphless plan",
                ));
            }
            plan.get("graphlessSubmissionContracts")
                .and_then(|contracts| contracts.get(agent_name))
        }
    };
    let contract = value.and_then(Value::as_str).ok_or_else(|| {
        failure(
            "CORRELATION",
            "contract",
            "Captured work contract is absent",
        )
    })?;
    validate_json(contract)?;
    Ok(contract.to_owned())
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptOwner030 {
    system_start_id: String,
    activation_id: String,
    agent_instance_id: String,
    owner_epoch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkReceipt030 {
    receipt_id: String,
    owner: ReceiptOwner030,
    revision: String,
    decision: ReceiptDecision030,
}

#[derive(Deserialize)]
struct ReceiptDecision030 {
    kind: String,
    check: Option<Box<serde_json::value::RawValue>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckIdentity030 {
    check_id: String,
    owner: ReceiptOwner030,
}

/// Only extracts a durable reservation. It does not qualify or launch the check.
pub(crate) fn reserved_check030(
    context: &EngineContext,
    receipt_json: &str,
) -> Result<Option<crate::db::agsdl_execution::work_dto030::CheckRequest030>> {
    use crate::db::agsdl_execution::work_dto030::CheckRequest030;
    validate_json(receipt_json)?;
    let receipt: WorkReceipt030 = serde_json::from_str(receipt_json)?;
    let instance = context
        .work
        .agent_instance_id
        .as_ref()
        .ok_or_else(|| failure("CORRELATION", "work", "Work has no agent instance"))?;
    let owner = ReceiptOwner030 {
        system_start_id: context.owner.system_start_id.clone(),
        activation_id: context.work.activation_id.clone(),
        agent_instance_id: instance.clone(),
        owner_epoch: context.owner.owner_epoch.clone(),
    };
    if receipt.owner != owner
        || receipt.revision.is_empty()
        || !receipt.revision.bytes().all(|c| c.is_ascii_digit())
        || receipt.revision.len() > 1 && receipt.revision.starts_with('0')
        || receipt.receipt_id != format!("{}:{}", owner.activation_id, receipt.revision)
    {
        return Err(failure(
            "CORRELATION",
            "receipt",
            "Work receipt identity differs",
        ));
    }
    match (receipt.decision.kind.as_str(), receipt.decision.check) {
        ("checkRequested", Some(raw)) => {
            let check: CheckIdentity030 = serde_json::from_str(raw.get())?;
            if check.owner != owner || check.check_id.trim().is_empty() {
                return Err(failure("CORRELATION", "check", "Check attribution differs"));
            }
            Ok(Some(CheckRequest030 {
                check_id: check.check_id,
                invocation_json: raw.get().to_owned(),
            }))
        }
        ("checkRequested", None) | (_, Some(_)) => {
            Err(failure("CORRELATION", "check", "Invalid check reservation"))
        }
        (
            "correction"
            | "accepted"
            | "submissionNotAdmitted"
            | "planRequired"
            | "planWaiting"
            | "planAccepted"
            | "planRevision"
            | "stopping"
            | "uncertain"
            | "waiting"
            | "finished",
            None,
        ) => Ok(None),
        _ => Err(failure("CORRELATION", "receipt", "Unknown work decision")),
    }
}

const MAX_JOBS: usize = 64;
const MAX_BYTES: usize = 8_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostWorkInput030 {
    pub context: EngineContext,
    pub event_id: String,
    pub expected_revision: String,
    pub contract_json: String,
    pub state_json: String,
    pub event_json: String,
    pub options_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostWorkJob030 {
    pub ticket: String,
    pub generation: String,
    pub input_digest: String,
    pub input: HostWorkInput030,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostWorkOutput030 {
    pub state_json: String,
    pub receipt_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostWorkCompletion030 {
    pub ticket: String,
    pub generation: String,
    pub input_digest: String,
    pub output: HostWorkOutput030,
}

struct Pending {
    job: HostWorkJob030,
    issued: bool,
    reply: oneshot::Sender<Result<HostWorkOutput030>>,
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
pub(crate) struct WorkBroker030 {
    queue: Mutex<Queue>,
    available: Notify,
    pub(crate) native: crate::agsdl_host_evaluation030::Bounded<64>,
}

struct TicketGuard<'a> {
    broker: &'a WorkBroker030,
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

impl WorkBroker030 {
    pub(crate) fn close(&self) {
        self.native.close();
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
        input: HostWorkInput030,
        cancelled: &CancellationToken,
    ) -> Result<HostWorkOutput030> {
        let bytes = validate_input(generation, &input)?;
        let ticket = uuid::Uuid::new_v4().to_string();
        let job = HostWorkJob030 {
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

    pub(crate) async fn evaluate_native(
        &self,
        generation: &str,
        input: HostWorkInput030,
        cancelled: &CancellationToken,
    ) -> Result<HostWorkOutput030> {
        let bytes = validate_input(generation, &input)?;
        if self.queue.lock().expect("work mailbox").closed {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "work",
                "Native calculation could not produce a result",
            ));
        }
        let job = HostWorkJob030 {
            ticket: uuid::Uuid::new_v4().to_string(),
            generation: generation.into(),
            input_digest: format!("sha256:{:x}", Sha256::digest(&bytes)),
            input,
        };
        let raw_job = serde_json::to_string(&job)?;
        let raw_input = String::from_utf8(bytes).expect("serialized work input");
        let raw = self
            .native
            .run(
                failure(
                    "RUNTIME_UNAVAILABLE",
                    "work",
                    "Work protocol host is unavailable or busy",
                ),
                failure("INTERRUPTED", "work", "Work transition was cancelled"),
                cancelled,
                raw_job,
                move || {
                    use crate::argentic_core::native::{JsonDecoder, Text};
                    let decoder = crate::argentic_runtime::native_json::Decoder;
                    let input = decoder.parse(&Text::from(raw_input)).map_err(|_| {
                        failure(
                            "RUNTIME_UNAVAILABLE",
                            "work",
                            "Native calculation could not produce a result",
                        )
                    })?;
                    crate::argentic_core::work::evaluate_host(&input, &decoder)
                        .map(|output| output.stringify())
                        .map_err(|_| {
                            failure(
                                "RUNTIME_UNAVAILABLE",
                                "work",
                                "Native calculation could not produce a result",
                            )
                        })
                },
            )
            .await?;
        let output: HostWorkOutput030 = serde_json::from_str(&raw)?;
        let completion = HostWorkCompletion030 {
            ticket: job.ticket,
            generation: job.generation,
            input_digest: job.input_digest,
            output,
        };
        validate_output(&completion)?;
        Ok(completion.output)
    }
    pub(crate) async fn next(&self) -> Result<HostWorkJob030> {
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
        completion: HostWorkCompletion030,
    ) -> Result<()> {
        validate_output(&completion)?;
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

fn validate_input(generation: &str, input: &HostWorkInput030) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(&input)?;
    if bytes.len() > MAX_BYTES {
        return Err(failure(
            "INPUT_LIMIT",
            "work",
            "Work transition exceeds the host transport limit",
        ));
    }
    for json in [
        &input.contract_json,
        &input.state_json,
        &input.event_json,
        &input.options_json,
    ] {
        validate_json(json)?;
    }
    if generation.is_empty()
        || input.event_id.trim().is_empty()
        || input.context.owner.system_start_id != input.context.work.system_start_id
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
    Ok(bytes)
}
fn validate_output(completion: &HostWorkCompletion030) -> Result<()> {
    if serde_json::to_vec(&completion)?.len() > MAX_BYTES {
        return Err(failure(
            "INPUT_LIMIT",
            "work",
            "Work transition result exceeds the host transport limit",
        ));
    }
    validate_json(&completion.output.state_json)?;
    validate_json(&completion.output.receipt_json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn input() -> HostWorkInput030 {
        HostWorkInput030 {
            context: serde_json::from_value(serde_json::json!({
                "owner":{"systemStartId":"run","ownerEpoch":"1"},
                "work":{"systemStartId":"run","flowInvocationId":"flow","activationId":"work","step":["task"],"agentInstanceId":"agent"},
                "permissionsJson":"{}","scopeJson":"{}","registryVersion":"registry"
            })).unwrap(),
            event_id: "event".into(), expected_revision: "0".into(),
            contract_json: "{}".into(), state_json: "{}".into(), options_json: "{}".into(),
            event_json: "{\"results\":{\"n\":9007199254740993,\"d\":1e999}}".into(),
        }
    }
    fn completion(job: &HostWorkJob030) -> HostWorkCompletion030 {
        HostWorkCompletion030 {
            ticket: job.ticket.clone(),
            generation: job.generation.clone(),
            input_digest: job.input_digest.clone(),
            output: HostWorkOutput030 {
                state_json: "{}".into(),
                receipt_json: job.input.event_json.clone(),
            },
        }
    }
    #[test]
    fn captured_contract_is_bound_to_snapshot_step_agent_and_exact_bytes() {
        use crate::db::agsdl_execution::dto::{EngineSourceRevision, EngineVersions};
        let source: EngineSourceRevision = serde_json::from_value(serde_json::json!({
            "owner":{"projectId":"project","planId":"plan","branch":"feature/test"},"revision":"1","sourceSha256":"digest"
        })).unwrap();
        let versions: EngineVersions = serde_json::from_value(serde_json::json!({
            "snapshot":"2","contract":"agsdl-0.3.0","compiler":"compiler","runtime":"runtime","registry":"registry","profile":"macro-agsdl-030-v1"
        })).unwrap();
        let exact = "{ \"limit\":9007199254740993 }";
        let mut plan = serde_json::json!({
            "format":"macro-agsdl-compiled-plan/2", "source":source,
            "versions":versions, "entry":["task"],
            "steps":[{"address":["task"],"type":"agent","agent":"agent","submissionContractJson":exact}],
            "graphlessSubmissionContracts":{"agent":exact}
        });
        let check = |plan: &serde_json::Value,
                     work: &crate::db::agsdl_execution::dto::EngineWork,
                     agent: &str| {
            let json = plan.to_string();
            captured_work_contract030(
                &CapturedWorkPlan030 {
                    system_start_id: "run",
                    source: &source,
                    versions: &versions,
                    compiled_plan_json: &json,
                },
                work,
                agent,
            )
        };
        let mut work = input().context.work;
        assert_eq!(check(&plan, &work, "agent").unwrap(), exact);
        assert!(check(&plan, &work, "other").is_err());
        let duplicate = plan["steps"][0].clone();
        plan["steps"].as_array_mut().unwrap().push(duplicate);
        assert!(check(&plan, &work, "agent").is_err());
        plan["entry"] = serde_json::Value::Null;
        work.step = None;
        assert_eq!(check(&plan, &work, "agent").unwrap(), exact);
        assert!(check(&plan, &work, "other").is_err());
        plan["versions"]["profile"] = "macro-serial-inline-v1".into();
        assert!(check(&plan, &work, "agent").is_err());
    }
    #[test]
    fn check_reservation_preserves_exact_json_and_rejects_foreign_owner() {
        let context = input().context;
        let receipt = r#"{"receiptId":"work:1","owner":{"systemStartId":"run","activationId":"work","agentInstanceId":"agent","ownerEpoch":"1"},"revision":"1","decision":{"kind":"checkRequested","check":{"checkId":"check","owner":{"systemStartId":"run","activationId":"work","agentInstanceId":"agent","ownerEpoch":"1"},"candidate":{"resultsJson":"{\"n\":9007199254740993}"},"timeoutMs":"9007199254740993"}}}"#;
        let check = reserved_check030(&context, receipt).unwrap().unwrap();
        assert_eq!(check.check_id, "check");
        assert!(check.invocation_json.contains("9007199254740993"));
        assert!(reserved_check030(
            &context,
            &receipt.replace("\"ownerEpoch\":\"1\"", "\"ownerEpoch\":\"2\"")
        )
        .is_err());
        assert!(reserved_check030(
            &context,
            &receipt.replace("\"kind\":\"checkRequested\"", "\"kind\":\"accepted\"")
        )
        .is_err());
    }
    #[tokio::test]
    async fn exact_transition_rejects_wrong_generation_digest_and_repeated_completion() {
        let broker = Arc::new(WorkBroker030::default());
        let worker = broker.clone();
        let task = tokio::spawn(async move {
            worker
                .evaluate("g", input(), &CancellationToken::new())
                .await
        });
        let job = broker.next().await.unwrap();
        assert_eq!(job.input.event_json, input().event_json);
        assert!(broker.complete("foreign", completion(&job)).is_err());
        let mut wrong = completion(&job);
        wrong.input_digest.push('x');
        assert!(broker.complete("g", wrong).is_err());
        let mut duplicate = completion(&job);
        duplicate.output.receipt_json = "{\"a\":1,\"a\":2}".into();
        assert!(broker.complete("g", duplicate).is_err());
        broker.complete("g", completion(&job)).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), completion(&job).output);
        assert!(broker.complete("g", completion(&job)).is_err());
    }
    #[tokio::test]
    async fn cancelled_evaluation_accepts_only_correlated_late_reply_without_restoring_receiver() {
        let broker = Arc::new(WorkBroker030::default());
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let worker = broker.clone();
        let task = tokio::spawn(async move { worker.evaluate("g", input(), &stop).await });
        let job = broker.next().await.unwrap();
        cancel.cancel();
        assert_eq!(task.await.unwrap().unwrap_err().code, "INTERRUPTED");
        let mut wrong = completion(&job);
        wrong.input_digest.push('x');
        assert!(broker.complete("g", wrong).is_err());
        broker.complete("g", completion(&job)).unwrap();
        assert!(broker.queue.lock().unwrap().pending.is_empty());
        assert!(broker.queue.lock().unwrap().retired.is_empty());
    }
    #[tokio::test]
    async fn cancelled_jobs_do_not_exhaust_capacity_or_restore_evicted_authority() {
        let broker = Arc::new(WorkBroker030::default());
        let mut cancelled_jobs = Vec::new();
        for _ in 0..=MAX_JOBS {
            let token = CancellationToken::new();
            let stop = token.clone();
            let worker = broker.clone();
            let task = tokio::spawn(async move { worker.evaluate("g", input(), &stop).await });
            let job = broker.next().await.unwrap();
            token.cancel();
            assert_eq!(task.await.unwrap().unwrap_err().code, "INTERRUPTED");
            cancelled_jobs.push(job);
        }
        assert_eq!(broker.queue.lock().unwrap().retired.len(), MAX_JOBS);
        let worker = broker.clone();
        let task = tokio::spawn(async move {
            worker
                .evaluate("g", input(), &CancellationToken::new())
                .await
        });
        let current = broker.next().await.unwrap();
        assert_eq!(
            broker
                .complete("g", completion(&cancelled_jobs[0]))
                .unwrap_err()
                .code,
            "STALE_TICKET"
        );
        let mut wrong = completion(&cancelled_jobs[1]);
        wrong.input_digest.push('x');
        assert_eq!(broker.complete("g", wrong).unwrap_err().code, "CORRELATION");
        broker
            .complete("g", completion(&cancelled_jobs[1]))
            .unwrap();
        assert!(!task.is_finished());
        broker.complete("g", completion(&current)).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), completion(&current).output);
    }
    #[tokio::test]
    async fn host_retirement_wakes_evaluation_and_mailbox_and_refuses_late_reply() {
        let broker = Arc::new(WorkBroker030::default());
        let worker = broker.clone();
        let task = tokio::spawn(async move {
            worker
                .evaluate("g", input(), &CancellationToken::new())
                .await
        });
        let job = broker.next().await.unwrap();
        broker.close();
        assert_eq!(task.await.unwrap().unwrap_err().code, "RUNTIME_UNAVAILABLE");
        assert!(broker.complete("g", completion(&job)).is_err());
        assert!(broker.next().await.is_err());
    }
    #[tokio::test]
    async fn already_cancelled_and_invalid_inputs_never_enter_queue() {
        let broker = WorkBroker030::default();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(broker.evaluate("g", input(), &cancelled).await.is_err());
        let mut malformed = input();
        malformed.expected_revision = "01".into();
        assert!(broker
            .evaluate("g", malformed, &CancellationToken::new())
            .await
            .is_err());
        assert!(broker.queue.lock().unwrap().pending.is_empty());
        assert!(broker.queue.lock().unwrap().ready.is_empty());
    }
}
