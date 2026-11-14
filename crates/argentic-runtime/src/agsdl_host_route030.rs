//! Bounded native preparation of a route already selected by 06.
//! A response is only data; the native flow owner authenticates and commits it.
use crate::persistence::{failure, validate_json, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::{BTreeMap, VecDeque};
#[cfg(test)]
use std::sync::Mutex;
#[cfg(test)]
use tokio::sync::{oneshot, Notify};
use tokio_util::sync::CancellationToken;

const MAX_JOBS: usize = 64;
const MAX_BYTES: usize = 8_000_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRouteJob030 {
    pub ticket: String,
    pub generation: String,
    pub input_digest: String,
    pub input_json: String,
}

#[cfg(test)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRouteCompletion030 {
    pub ticket: String,
    pub generation: String,
    pub input_digest: String,
    pub output: HostRouteOutput030,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostRouteOutput030 {
    Ready { result_json: String },
    Failed { code: String, pointer: String },
}

#[cfg(test)]
struct Pending {
    job: HostRouteJob030,
    issued: bool,
    reply: oneshot::Sender<Result<String>>,
}
#[cfg(test)]
#[derive(Default)]
struct Queue {
    closed: bool,
    ready: VecDeque<String>,
    pending: BTreeMap<String, Pending>,
}
#[derive(Default)]
pub(crate) struct RouteBroker030 {
    #[cfg(test)]
    queue: Mutex<Queue>,
    #[cfg(test)]
    available: Notify,
    pub(crate) native: crate::agsdl_host_evaluation030::Bounded<64>,
}
#[cfg(test)]
struct TicketGuard<'a> {
    broker: &'a RouteBroker030,
    ticket: String,
}
#[cfg(test)]
impl Drop for TicketGuard<'_> {
    fn drop(&mut self) {
        let mut queue = self.broker.queue.lock().expect("route mailbox");
        queue.pending.remove(&self.ticket);
        queue.ready.retain(|ticket| ticket != &self.ticket);
    }
}
impl RouteBroker030 {
    pub(crate) fn close(&self) {
        self.native.close();
        #[cfg(test)]
        {
            let mut queue = self.queue.lock().expect("route mailbox");
            queue.closed = true;
            queue.ready.clear();
            for (_, pending) in std::mem::take(&mut queue.pending) {
                let _ = pending.reply.send(Err(failure(
                    "RUNTIME_UNAVAILABLE",
                    "route",
                    "Route host was revoked",
                )));
            }
            self.available.notify_waiters();
        }
    }

    /// Only the native owner submits authenticated inputs. Cancellation never
    /// permits a late result to become a durable receipt or trigger an effect.
    #[cfg(test)]
    pub(crate) async fn evaluate(
        &self,
        generation: &str,
        input_json: String,
        cancel: &CancellationToken,
    ) -> Result<String> {
        validate_input(generation, &input_json)?;
        let ticket = uuid::Uuid::new_v4().to_string();
        let job = HostRouteJob030 {
            ticket: ticket.clone(),
            generation: generation.into(),
            input_digest: format!("sha256:{:x}", Sha256::digest(input_json.as_bytes())),
            input_json,
        };
        let (reply, receiver) = oneshot::channel();
        {
            let mut queue = self.queue.lock().expect("route mailbox");
            if queue.closed || cancel.is_cancelled() || queue.pending.len() >= MAX_JOBS {
                return Err(failure(
                    "RUNTIME_UNAVAILABLE",
                    "route",
                    "Route host is unavailable or busy",
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
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(failure("INTERRUPTED", "route", "Route preparation was cancelled")),
            result = receiver => result.map_err(|_| failure("RUNTIME_UNAVAILABLE", "route", "Route receiver was lost"))?,
        }
    }

    pub(crate) async fn evaluate_native(
        &self,
        expected_generation: &str,
        generation: &str,
        input_json: String,
        cancel: &CancellationToken,
    ) -> Result<String> {
        validate_input(generation, &input_json)?;
        if expected_generation != generation {
            return Err(failure(
                "CORRELATION",
                "route",
                "Route host generation differs",
            ));
        }
        #[cfg(test)]
        if self.queue.lock().expect("route mailbox").closed {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "route",
                "Native calculation could not produce a result",
            ));
        }
        let job = HostRouteJob030 {
            ticket: uuid::Uuid::new_v4().to_string(),
            generation: generation.into(),
            input_digest: format!("sha256:{:x}", Sha256::digest(input_json.as_bytes())),
            input_json,
        };
        let raw_job = serde_json::to_string(&job)?;
        let raw = self
            .native
            .run(
                failure(
                    "RUNTIME_UNAVAILABLE",
                    "route",
                    "Route host is unavailable or busy",
                ),
                failure("INTERRUPTED", "route", "Route preparation was cancelled"),
                cancel,
                raw_job,
                move || {
                    crate::calculation::route(&job.input_json).map_err(|_| {
                        failure(
                            "RUNTIME_UNAVAILABLE",
                            "route",
                            "Native calculation could not produce a result",
                        )
                    })
                },
            )
            .await?;
        let output: HostRouteOutput030 = serde_json::from_str(&raw)?;
        validate_output(&output)?;
        response(output)
    }
    #[cfg(test)]
    pub(crate) async fn next(&self) -> Result<HostRouteJob030> {
        loop {
            let notified = self.available.notified();
            {
                let mut queue = self.queue.lock().expect("route mailbox");
                if queue.closed {
                    return Err(failure(
                        "RUNTIME_UNAVAILABLE",
                        "route",
                        "Route host was revoked",
                    ));
                }
                while let Some(ticket) = queue.ready.pop_front() {
                    if let Some(pending) = queue.pending.get_mut(&ticket) {
                        pending.issued = true;
                        return Ok(pending.job.clone());
                    }
                }
            }
            notified.await;
        }
    }

    #[cfg(test)]
    pub(crate) fn complete(&self, generation: &str, result: HostRouteCompletion030) -> Result<()> {
        validate_output(&result.output)?;
        let mut queue = self.queue.lock().expect("route mailbox");
        if queue.closed {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "route",
                "Route host was revoked",
            ));
        }
        let pending = queue
            .pending
            .get(&result.ticket)
            .ok_or_else(|| failure("STALE_TICKET", "ticket", "Route ticket is no longer active"))?;
        if !pending.issued
            || result.generation != generation
            || pending.job.generation != generation
            || pending.job.input_digest != result.input_digest
        {
            return Err(failure(
                "CORRELATION",
                "ticket",
                "Route completion differs from its native ticket",
            ));
        }
        let pending = queue
            .pending
            .remove(&result.ticket)
            .expect("pending route ticket");
        let response = response(result.output);
        let _ = pending.reply.send(response);
        Ok(())
    }
}

fn validate_input(generation: &str, input_json: &str) -> Result<()> {
    if generation.is_empty() || input_json.len() > MAX_BYTES {
        return Err(failure(
            "INPUT_LIMIT",
            "route",
            "Route input is invalid or too large",
        ));
    }
    validate_json(&input_json)?;
    Ok(())
}
fn validate_output(output: &HostRouteOutput030) -> Result<()> {
    match output {
        HostRouteOutput030::Ready { result_json } => {
            if result_json.len() > MAX_BYTES {
                return Err(failure("INPUT_LIMIT", "route", "Route output is too large"));
            }
            validate_json(result_json)?;
        }
        HostRouteOutput030::Failed { code, pointer } => {
            if code.len() > 128 || pointer.len() > 4096 {
                return Err(failure(
                    "INPUT_LIMIT",
                    "route",
                    "Route failure is too large",
                ));
            }
        }
    }
    Ok(())
}
fn response(output: HostRouteOutput030) -> Result<String> {
    match output {
        HostRouteOutput030::Ready { result_json } => Ok(result_json),
        HostRouteOutput030::Failed { code, pointer } => {
            let code = if matches!(code.as_str(), "CONTENT_UNAVAILABLE" | "CORRELATION") {
                code
            } else {
                "ROUTE_PREPARATION_FAILED".into()
            };
            Err(failure(
                &code,
                &pointer,
                "Captured route could not be prepared",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn exact_job_requires_issued_ticket_and_generation() {
        let broker = Arc::new(RouteBroker030::default());
        let worker = broker.clone();
        let input = r#"{"value":9007199254740993,"lexeme":1.0}"#.to_owned();
        let sent = input.clone();
        let task = tokio::spawn(async move {
            worker
                .evaluate("generation", sent, &CancellationToken::new())
                .await
        });
        let job = broker.next().await.unwrap();
        assert_eq!(job.input_json, input);
        let mut completion = HostRouteCompletion030 {
            ticket: job.ticket.clone(),
            generation: job.generation.clone(),
            input_digest: job.input_digest.clone(),
            output: HostRouteOutput030::Ready {
                result_json: r#"{"value":1e999}"#.into(),
            },
        };
        completion.input_digest = "wrong".into();
        assert!(broker.complete("generation", completion.clone()).is_err());
        completion.input_digest = job.input_digest;
        assert!(broker.complete("foreign", completion.clone()).is_err());
        broker.complete("generation", completion.clone()).unwrap();
        assert!(broker.complete("generation", completion).is_err());
        assert_eq!(task.await.unwrap().unwrap(), r#"{"value":1e999}"#);
    }

    #[tokio::test]
    async fn cancellation_releases_capacity_and_late_result_cannot_revive_ticket() {
        let broker = Arc::new(RouteBroker030::default());
        let worker = broker.clone();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task =
            tokio::spawn(async move { worker.evaluate("generation", "{}".into(), &token).await });
        let job = broker.next().await.unwrap();
        cancel.cancel();
        assert!(task.await.unwrap().is_err());
        let completion = HostRouteCompletion030 {
            ticket: job.ticket,
            generation: job.generation,
            input_digest: job.input_digest,
            output: HostRouteOutput030::Ready {
                result_json: "{}".into(),
            },
        };
        assert!(broker.complete("generation", completion).is_err());
        assert!(broker.queue.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn repeated_cancelled_evaluations_do_not_exhaust_the_mailbox() {
        let broker = Arc::new(RouteBroker030::default());
        for _ in 0..70 {
            let token = CancellationToken::new();
            let worker = broker.clone();
            let child = token.clone();
            let task =
                tokio::spawn(
                    async move { worker.evaluate("generation", "{}".into(), &child).await },
                );
            let job = broker.next().await.unwrap();
            token.cancel();
            assert!(task.await.unwrap().is_err());
            let late = HostRouteCompletion030 {
                ticket: job.ticket,
                generation: job.generation,
                input_digest: job.input_digest,
                output: HostRouteOutput030::Ready {
                    result_json: "{}".into(),
                },
            };
            assert!(broker.complete("generation", late).is_err());
        }
        assert!(broker.queue.lock().unwrap().pending.is_empty());
    }
}
