//! Native tickets bind the embedded compiler to captured source and registry bytes.
//! They authenticate the component, not its semantics against a compromised host.
use crate::db::agsdl_execution::{dto::EngineSourceRevision, failure, validate_json, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;
use tokio::sync::{oneshot, Notify};

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCompileJob {
    pub ticket: String,
    pub generation: String,
    pub source: EngineSourceRevision,
    pub authored_source: String,
    pub registry_json: String,
}
pub(crate) struct CompileReceipt {
    pub generation: String,
    pub result_json: String,
}
struct Pending {
    job: HostCompileJob,
    issued: bool,
    reply: oneshot::Sender<Result<CompileReceipt>>,
}
#[derive(Default)]
struct Queue {
    closed: bool,
    ready: VecDeque<String>,
    pending: BTreeMap<String, Pending>,
    // Only jobs actually delivered to JS can reply after their waiter expires.
    // Together with pending, these retain at most the mailbox's 32 captures.
    expired: BTreeMap<String, HostCompileJob>,
}
#[derive(Default)]
pub(crate) struct CompileBroker {
    queue: Mutex<Queue>,
    available: Notify,
}
struct TicketGuard<'a> {
    broker: &'a CompileBroker,
    ticket: String,
}
impl Drop for TicketGuard<'_> {
    fn drop(&mut self) {
        let mut queue = self.broker.queue.lock().expect("compiler queue");
        if let Some(pending) = queue.pending.remove(&self.ticket) {
            if pending.issued && !queue.closed {
                queue.expired.insert(self.ticket.clone(), pending.job);
            }
        }
        queue.ready.retain(|ticket| ticket != &self.ticket);
    }
}
impl CompileBroker {
    pub(crate) fn close(&self) {
        let mut queue = self.queue.lock().expect("compiler queue");
        queue.closed = true;
        queue.ready.clear();
        queue.expired.clear();
        for (_, pending) in std::mem::take(&mut queue.pending) {
            let _ = pending.reply.send(Err(failure(
                "RUNTIME_UNAVAILABLE",
                "",
                "Compiler host was revoked",
            )));
        }
        self.available.notify_waiters();
    }
    pub(crate) async fn compile(
        &self,
        generation: &str,
        source: EngineSourceRevision,
        authored_source: String,
        registry_json: String,
    ) -> Result<CompileReceipt> {
        validate_json(&registry_json)?;
        if authored_source.len() > 4_000_000
            || registry_json.len() > 4_000_000
            || format!("{:x}", Sha256::digest(authored_source.as_bytes())) != source.source_sha256
        {
            return Err(failure(
                "CORRELATION",
                "source",
                "Compiler input does not match the native capture",
            ));
        }
        let registry: Value = serde_json::from_str(&registry_json)?;
        if registry
            .get("version")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(failure(
                "CORRELATION",
                "registry",
                "Captured registry version is absent",
            ));
        }
        let ticket = uuid::Uuid::new_v4().to_string();
        let (reply, receiver) = oneshot::channel();
        {
            let mut queue = self.queue.lock().expect("compiler queue");
            if queue.closed || queue.pending.len() + queue.expired.len() >= 32 {
                return Err(failure(
                    "RUNTIME_UNAVAILABLE",
                    "",
                    "Compiler is unavailable or busy",
                ));
            }
            let job = HostCompileJob {
                ticket: ticket.clone(),
                generation: generation.into(),
                source,
                authored_source,
                registry_json,
            };
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
        let _ticket_guard = TicketGuard {
            broker: self,
            ticket: ticket.clone(),
        };
        self.available.notify_one();
        let received = tokio::time::timeout(std::time::Duration::from_secs(30), receiver).await;
        // The guard retires an issued ticket on timeout or cancellation. Its late
        // reply is checked but can never become authority for another Start.
        received
            .map_err(|_| {
                failure(
                    "RUNTIME_UNAVAILABLE",
                    "",
                    "Compiler did not acknowledge its ticket",
                )
            })?
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Compiler ticket was lost"))?
    }
    pub(crate) async fn next(&self) -> Result<HostCompileJob> {
        loop {
            let wake = self.available.notified();
            {
                let mut queue = self.queue.lock().expect("compiler queue");
                if queue.closed {
                    return Err(failure(
                        "RUNTIME_UNAVAILABLE",
                        "",
                        "Compiler host was revoked",
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
        ticket: &str,
        result_json: String,
    ) -> Result<()> {
        if result_json.len() > 8_000_000 {
            return Err(failure(
                "CORRELATION",
                "compiler",
                "Compiler result exceeds its limit",
            ));
        }
        validate_json(&result_json)?;
        let result: Value = serde_json::from_str(&result_json)?;
        let mut queue = self.queue.lock().expect("compiler queue");
        let job = queue
            .pending
            .get(ticket)
            .map(|pending| &pending.job)
            .or_else(|| queue.expired.get(ticket))
            .ok_or_else(|| failure("CORRELATION", "ticket", "Compiler ticket is absent"))?;
        let registry: Value = serde_json::from_str(&job.registry_json)?;
        if queue.closed
            || job.generation != generation
            || result.get("runtime").and_then(|v| v.get("registryVersion"))
                != registry.get("version")
            || result.get("runtime").and_then(|v| v.get("source"))
                != Some(&serde_json::to_value(&job.source)?)
        {
            return Err(failure(
                "CORRELATION",
                "compiler",
                "Compiler result does not describe its native ticket",
            ));
        }
        if let Some(input) = registry.get("callInput") {
            if result.pointer("/callValidation/input") != Some(input) {
                return Err(failure(
                    "CORRELATION",
                    "call",
                    "Call validation differs from its native input ticket",
                ));
            }
        }
        if let Some(input) = registry.get("toolPolicyInput") {
            if result.pointer("/toolPolicy/input") != Some(input)
                || !matches!(
                    result
                        .pointer("/toolPolicy/decision")
                        .and_then(Value::as_str),
                    Some("allow" | "ask" | "deny")
                )
            {
                return Err(failure(
                    "CORRELATION",
                    "policy",
                    "Tool policy does not describe its native invocation ticket",
                ));
            }
        }
        if let Some(input) = registry.get("deliveryInput") {
            if result.pointer("/deliveryValidation/input") != Some(input) {
                return Err(failure(
                    "CORRELATION",
                    "message",
                    "Delivery validation differs from its native ticket",
                ));
            }
        }
        if let Some(entry) = registry.get("startEntry") {
            let expected_message = entry.get("messageJson").unwrap_or(&Value::Null);
            if result.pointer("/entryValidation/messageJson") != Some(expected_message) {
                return Err(failure(
                    "CORRELATION",
                    "entry",
                    "Entry validation differs from the native ticket",
                ));
            }
        }
        if registry.get("format").and_then(Value::as_str)
            == Some("macro-native-registry-observation/1")
            && result
                .pointer("/runtime/supported")
                .and_then(Value::as_bool)
                == Some(true)
        {
            let captured_json = result
                .get("capturedRegistryJson")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("CORRELATION", "registry", "Compiled registry is absent"))?;
            validate_json(captured_json)?;
            let captured: Value = serde_json::from_str(captured_json)?;
            if captured.get("version") != registry.get("version")
                || captured.get("models") != registry.get("models")
            {
                return Err(failure(
                    "CORRELATION",
                    "registry",
                    "Compiled registry changed native observations",
                ));
            }
            let observed = registry
                .get("configurations")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    failure(
                        "CORRELATION",
                        "registry",
                        "Native configurations are absent",
                    )
                })?;
            let configurations = captured
                .get("configurations")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    failure(
                        "CORRELATION",
                        "registry",
                        "Compiled configurations are absent",
                    )
                })?;
            if configurations.len() != observed.len() {
                return Err(failure(
                    "CORRELATION",
                    "registry",
                    "Configuration observations changed",
                ));
            }
            for (native, compiled) in observed.iter().zip(configurations) {
                for field in [
                    "agentName",
                    "effectiveSettingsJson",
                    "permissionsJson",
                    "scopeJson",
                    "verifiedRequirementsJson",
                ] {
                    if native.get(field) != compiled.get(field) {
                        return Err(failure(
                            "CORRELATION",
                            "registry",
                            "Compiled configuration changed native authority",
                        ));
                    }
                }
            }
        }
        if let Some(plan_json) = result.get("compiledPlanJson").and_then(Value::as_str) {
            validate_json(plan_json)?;
            let plan: Value = serde_json::from_str(plan_json)?;
            if plan.get("source") != Some(&serde_json::to_value(&job.source)?)
                || plan.pointer("/versions/registry") != registry.get("version")
                || plan.get("format").and_then(Value::as_str) != Some("macro-agsdl-compiled-plan/1")
            {
                return Err(failure(
                    "CORRELATION",
                    "compiler",
                    "Compiled plan contradicts the captured source or registry",
                ));
            }
            let document = plan
                .get("documentJson")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("CORRELATION", "compiler", "Compiled document is absent"))?;
            if !crate::db::exact_json::equal(document, &job.authored_source)? {
                return Err(failure(
                    "CORRELATION",
                    "compiler",
                    "Compiled document differs from captured source",
                ));
            }
        } else if result
            .pointer("/runtime/supported")
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Err(failure(
                "CORRELATION",
                "compiler",
                "Supported assessment has no compiled plan",
            ));
        }
        if let Some(pending) = queue.pending.remove(ticket) {
            let _ = pending.reply.send(Ok(CompileReceipt {
                generation: generation.into(),
                result_json,
            }));
        } else {
            // Acknowledge only this known, fully correlated late response so JS
            // can keep serving the mailbox. No receiver or admission is restored.
            queue.expired.remove(ticket);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn source() -> EngineSourceRevision {
        EngineSourceRevision {
            owner: crate::db::agsdl_execution::dto::EngineSourceOwner {
                project_id: "project".into(),
                plan_id: "plan".into(),
                branch: "feature/fixture".into(),
            },
            revision: "1".into(),
            source_sha256: format!("{:x}", Sha256::digest(b"{\"n\":9007199254740993}")),
        }
    }
    fn result(job: &HostCompileJob) -> String {
        serde_json::json!({"runtime":{"registryVersion":"registry","source":job.source,"supported":false},"compiledPlanJson":null}).to_string()
    }
    #[tokio::test]
    async fn compiler_ticket_correlates_native_source_generation_and_registry() {
        let broker = Arc::new(CompileBroker::default());
        let task = broker.clone();
        let pending = tokio::spawn(async move {
            task.compile(
                "generation",
                source(),
                "{\"n\":9007199254740993}".into(),
                "{\"version\":\"registry\"}".into(),
            )
            .await
        });
        let job = broker.next().await.unwrap();
        assert!(broker
            .complete("foreign", &job.ticket, result(&job))
            .is_err());
        let mut wrong: Value = serde_json::from_str(&result(&job)).unwrap();
        wrong["runtime"]["source"]["revision"] = Value::String("2".into());
        assert!(broker
            .complete("generation", &job.ticket, wrong.to_string())
            .is_err());
        broker
            .complete("generation", &job.ticket, result(&job))
            .unwrap();
        let receipt = pending.await.unwrap().unwrap();
        assert_eq!(receipt.generation, "generation");
        assert_eq!(receipt.result_json, result(&job));
        assert!(broker
            .complete("generation", &job.ticket, result(&job))
            .is_err());
    }
    #[tokio::test]
    async fn host_loss_closes_pending_compilation_without_replay() {
        let broker = Arc::new(CompileBroker::default());
        let task = broker.clone();
        let pending = tokio::spawn(async move {
            task.compile(
                "generation",
                source(),
                "{\"n\":9007199254740993}".into(),
                "{\"version\":\"registry\"}".into(),
            )
            .await
        });
        let job = broker.next().await.unwrap();
        broker.close();
        assert!(pending.await.unwrap().is_err());
        assert!(broker.next().await.is_err());
        assert!(broker
            .complete("generation", &job.ticket, result(&job))
            .is_err());
    }
    #[tokio::test]
    async fn compiler_rejects_rounded_source_before_enqueuing() {
        let broker = CompileBroker::default();
        assert!(broker
            .compile(
                "generation",
                source(),
                "{\"n\":9007199254740992}".into(),
                "{\"version\":\"registry\"}".into()
            )
            .await
            .is_err());
        assert!(broker.queue.lock().unwrap().pending.is_empty());
    }
    #[tokio::test]
    async fn issued_cancelled_ticket_checks_late_reply_without_recreating_a_receipt() {
        let broker = Arc::new(CompileBroker::default());
        let task = broker.clone();
        let pending = tokio::spawn(async move {
            task.compile(
                "generation",
                source(),
                "{\"n\":9007199254740993}".into(),
                "{\"version\":\"registry\"}".into(),
            )
            .await
        });
        let job = broker.next().await.unwrap();
        pending.abort();
        assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
        assert!(broker.queue.lock().unwrap().pending.is_empty());
        assert_eq!(broker.queue.lock().unwrap().expired.len(), 1);
        assert!(broker
            .complete("generation", "unknown", result(&job))
            .is_err());
        assert!(broker
            .complete("foreign", &job.ticket, result(&job))
            .is_err());
        let mut wrong: Value = serde_json::from_str(&result(&job)).unwrap();
        wrong["runtime"]["source"]["revision"] = "foreign".into();
        assert!(broker
            .complete("generation", &job.ticket, wrong.to_string())
            .is_err());
        wrong = serde_json::from_str(&result(&job)).unwrap();
        wrong["runtime"]["registryVersion"] = "foreign".into();
        assert!(broker
            .complete("generation", &job.ticket, wrong.to_string())
            .is_err());
        broker
            .complete("generation", &job.ticket, result(&job))
            .unwrap();
        assert!(broker.queue.lock().unwrap().expired.is_empty());
        assert!(broker.queue.lock().unwrap().pending.is_empty());
        assert!(broker
            .complete("generation", &job.ticket, result(&job))
            .is_err());
        let task = broker.clone();
        let next = tokio::spawn(async move {
            task.compile(
                "generation",
                source(),
                "{\"n\":9007199254740993}".into(),
                "{\"version\":\"registry\"}".into(),
            )
            .await
        });
        let next_job = broker.next().await.unwrap();
        broker
            .complete("generation", &next_job.ticket, result(&next_job))
            .unwrap();
        assert_eq!(next.await.unwrap().unwrap().result_json, result(&next_job));
    }

    #[tokio::test]
    async fn expired_issued_captures_share_the_mailbox_bound_and_close_with_the_generation() {
        let broker = Arc::new(CompileBroker::default());
        for _ in 0..32 {
            let task = broker.clone();
            let pending = tokio::spawn(async move {
                task.compile(
                    "generation",
                    source(),
                    "{\"n\":9007199254740993}".into(),
                    "{\"version\":\"registry\"}".into(),
                )
                .await
            });
            broker.next().await.unwrap();
            pending.abort();
            assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
        }
        assert_eq!(broker.queue.lock().unwrap().expired.len(), 32);
        assert!(broker
            .compile(
                "generation",
                source(),
                "{\"n\":9007199254740993}".into(),
                "{\"version\":\"registry\"}".into()
            )
            .await
            .is_err());
        broker.close();
        assert!(broker.queue.lock().unwrap().expired.is_empty());
    }
}
