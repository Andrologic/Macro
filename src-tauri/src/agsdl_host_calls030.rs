//! Native ownership of 0.3 calls. No shell/network transport is qualified here.
//! The resident normalizer receives only tickets derived from native captures
//! and raw native receipts. These APIs are private, never model tools or IPC.
use crate::agsdl_host_calls::Control;
use crate::agsdl_host_route030::{HostRouteCompletion030, HostRouteJob030, RouteBroker030};
use crate::db::agsdl_execution::{
    call_protocol030 as protocol,
    flow030::{FlowEffect030, FlowIdentity030, WorkRef030},
    flow_store030::{Authority030, CheckFuture},
    start030::StartCapture030,
    Result,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, SqliteConnection, SqlitePool};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;

pub(crate) use protocol::{CallAttempt030, CallReceipt030};

/// Implemented by the native flow/policy owner. The same admission exclusion
/// must guard Stop, launch, receipt commits and generation retirement. Neither
/// registry strings alone nor neighboring agent permissions qualify a call.
/// `qualify_tx` checks captured AND current host/project policy, scope/root,
/// exact declaration and transport capability. A QA implementation must be
/// debug-only and restricted to its authenticated fixture pin.
pub(crate) trait CallAuthority030: Authority030 + Sync {
    fn generation(&self) -> &str;
    fn ensure_live(&self) -> Result<()>;
    /// The integrator also checks this fence in flow admission/dispatch.
    fn call_commits(&self) -> &CallCommitFence030;
    fn admission_lock(&self) -> Arc<Mutex<()>>;
    fn qualify_tx<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        capture: &'a StartCapture030,
        effect: &'a FlowEffect030,
        declaration_json: &'a str,
    ) -> CheckFuture<'a>;
}

/// An unknown call COMMIT blocks its flow until exact readback. The integrator
/// must consult require_clear in ALL flow dispatch/route admission paths, not
/// just calls. This fence must live with the native generation, never the UI.
#[derive(Default)]
pub(crate) struct CallCommitFence030(
    std::sync::Mutex<std::collections::BTreeMap<(String, String), protocol::CallCommitMarker030>>,
);
impl CallCommitFence030 {
    fn key(id: &FlowIdentity030) -> (String, String) {
        (id.system_start_id.clone(), id.flow_invocation_id.clone())
    }
    pub(crate) fn require_clear(&self, id: &FlowIdentity030) -> Result<()> {
        if self
            .0
            .lock()
            .expect("call commits")
            .contains_key(&Self::key(id))
        {
            Err(protocol::uncertain())
        } else {
            Ok(())
        }
    }
    pub(crate) fn pending(&self, id: &FlowIdentity030) -> Option<protocol::CallCommitMarker030> {
        self.0
            .lock()
            .expect("call commits")
            .get(&Self::key(id))
            .cloned()
    }
    pub(crate) fn begin(&self, marker: &protocol::CallCommitMarker030) -> Result<()> {
        let mut pending = self.0.lock().expect("call commits");
        protocol::require(
            !pending.contains_key(&Self::key(marker.identity())),
            "A call commit is unresolved",
        )?;
        pending.insert(Self::key(marker.identity()), marker.clone());
        Ok(())
    }
    fn acknowledge(&self, marker: &protocol::CallCommitMarker030) -> Result<()> {
        let mut pending = self.0.lock().expect("call commits");
        protocol::require(
            pending.get(&Self::key(marker.identity())) == Some(marker),
            "Call commit marker differs",
        )?;
        pending.remove(&Self::key(marker.identity()));
        Ok(())
    }
}
async fn commit_call_tx<A: CallAuthority030>(
    mut tx: sqlx::Transaction<'_, sqlx::Sqlite>,
    authority: &A,
    attempt: &CallAttempt030,
) -> Result<()> {
    let marker = protocol::commit_marker_tx(&mut tx, attempt).await?;
    authority.ensure_live()?;
    authority.call_commits().begin(&marker)?;
    tx.commit().await.map_err(|_| protocol::uncertain())?;
    authority.ensure_live().map_err(|_| protocol::uncertain())?;
    authority.call_commits().acknowledge(&marker)
}
/// A matching retained marker is the only way to clear an unknown COMMIT.
/// Missing/mismatching rows remain blocked; no status is reset for convenience.
pub(crate) async fn inspect_call_commit030<A: CallAuthority030>(
    pool: &SqlitePool,
    authority: &A,
    id: &FlowIdentity030,
) -> Result<bool> {
    let _gate = authority.admission_lock().lock_owned().await;
    let Some(marker) = authority.call_commits().pending(id) else {
        return Ok(false);
    };
    let mut tx = pool.begin().await?;
    protocol::verify_commit_marker_tx(&mut tx, authority, &marker).await?;
    tx.commit().await?;
    authority.ensure_live()?;
    authority.call_commits().acknowledge(&marker)?;
    Ok(true)
}

/// Raw native transport data. No outcome, call-id or physical proof is accepted
/// from a model. The integer type excludes fractional/overflowing exit statuses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CallEvent030 {
    CommandReceipt {
        #[serde(default)]
        stdout: String,
        #[serde(default)]
        stderr: String,
        exit_code: i32,
    },
    ToolReturned {
        is_error: bool,
        #[serde(default)]
        text: String,
        structured_content_json: Option<String>,
    },
    StartFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PreparedCall030 {
    Command {
        command: String,
        parse: Option<String>,
    },
    Mcp {
        server: String,
        tool: String,
        arguments_json: String,
    },
}

/// Sealed return from the trusted pure-computation mailbox, not Deserialize.
struct PreparedData030(PreparedCall030);
struct NormalizedData030(protocol::CallResult030);

/// Uses the existing ticket/generation/digest/issued-once mailbox discipline.
/// The integrator may connect next/complete to a trusted resident worker only.
/// Worker algorithm:
/// - prepare: prepareCall030(stepJson, source)
/// - normalize command: commandOutput030(prepared, receipt)
/// - normalize MCP: mcpOutput030(receipt)
/// Return ready.resultJson as {kind:"prepared",prepared} or
/// {kind:"completed",outputJson}; ConformanceError as {kind:"failed",code}.
/// The outer RouteBroker failure channel is a transport failure, not a call
/// failure. A lost worker never authorizes another physical launch.
#[derive(Default)]
pub(crate) struct CallDataBroker030(RouteBroker030);
impl CallDataBroker030 {
    pub(crate) async fn next(&self) -> Result<HostRouteJob030> {
        self.0.next().await
    }
    pub(crate) fn complete(&self, generation: &str, result: HostRouteCompletion030) -> Result<()> {
        self.0.complete(generation, result)
    }
    pub(crate) fn close(&self) {
        self.0.close();
    }

    async fn prepare(
        &self,
        attempt: &CallAttempt030,
        cancel: &CancellationToken,
    ) -> Result<PreparedData030> {
        let source = serde_json::json!({"terminalId":attempt.work().activation_id,
            "producerStep":attempt.address(),"kind":"entry","outputJson":attempt.input_json(),
            "provenance":{"instructions":[]}});
        let input = serde_json::json!({"operation":"prepare","call":attempt,
            "stepJson":attempt.declaration_json(),"source":source})
        .to_string();
        let raw = self.0.evaluate(attempt.generation(), input, cancel).await?;
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
        enum Reply {
            Prepared { prepared: PreparedCall030 },
        }
        let Reply::Prepared { prepared } = serde_json::from_str(&raw)?;
        protocol::validate_prepared(attempt, &prepared)?;
        Ok(PreparedData030(prepared))
    }

    async fn normalize(
        &self,
        attempt: &CallAttempt030,
        prepared: &PreparedCall030,
        event: &CallEvent030,
        cancel: &CancellationToken,
    ) -> Result<NormalizedData030> {
        protocol::validate_event(prepared, event)?;
        if matches!(event, CallEvent030::StartFailed) {
            return Ok(NormalizedData030(protocol::CallResult030::failure(
                "CALL_FAILED",
            )));
        }
        let receipt = match event {
            CallEvent030::CommandReceipt {
                stdout,
                stderr,
                exit_code,
            } => serde_json::json!({
                "stdout":stdout,"stderr":stderr,"output":format!("{stdout}{stderr}"),
                "exitCodeJson":exit_code.to_string(),"complete":true}),
            CallEvent030::ToolReturned {
                is_error,
                text,
                structured_content_json,
            } => {
                let mut value = serde_json::json!({"isError":is_error,"text":text});
                if let Some(raw) = structured_content_json {
                    value["structuredContentJson"] = raw.clone().into();
                }
                value
            }
            CallEvent030::StartFailed => unreachable!(),
        };
        let input = serde_json::json!({"operation":"normalize","call":attempt,
            "prepared":prepared,"receipt":receipt})
        .to_string();
        let raw = self.0.evaluate(attempt.generation(), input, cancel).await?;
        #[derive(Deserialize)]
        #[serde(
            tag = "kind",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        enum Reply {
            Completed { output_json: String },
            Failed { code: String },
        }
        let result = match serde_json::from_str(&raw)? {
            Reply::Completed { output_json } => {
                protocol::validate_output(prepared, event, &output_json)?;
                protocol::CallResult030::Completed { output_json }
            }
            Reply::Failed { code } if code == "OUTPUT_INVALID" => {
                // Only command JSON parsing may fail for these complete typed
                // receipts. Verify that the original stdout really is invalid.
                match (prepared, event) {
                    (
                        PreparedCall030::Command {
                            parse: Some(parse), ..
                        },
                        CallEvent030::CommandReceipt { stdout, .. },
                    ) if parse == "json"
                        && crate::db::agsdl_execution::validate_json(stdout).is_err() => {}
                    _ => return Err(protocol::denied("Unexpected call normalization failure")),
                }
                protocol::CallResult030::failure(&code)
            }
            _ => {
                return Err(protocol::denied(
                    "Call normalizer returned an invalid result",
                ))
            }
        };
        Ok(NormalizedData030(result))
    }
}

/// Reserve before claiming the flow effect. Reservation never launches work;
/// repeated reservation is refused, including after a lost acknowledgement.
pub(crate) async fn reserve_call030<A: CallAuthority030>(
    pool: &SqlitePool,
    authority: &A,
    effect: &FlowEffect030,
) -> Result<CallAttempt030> {
    let _gate = authority.admission_lock().lock_owned().await;
    authority.call_commits().require_clear(&effect.identity)?;
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let attempt = protocol::reserve_tx(&mut tx, authority, effect).await?;
    commit_call_tx(tx, authority, &attempt).await?;
    Ok(attempt)
}

pub(crate) async fn prepare_call030<A: CallAuthority030>(
    pool: &SqlitePool,
    authority: &A,
    broker: &CallDataBroker030,
    attempt: &CallAttempt030,
    cancel: &CancellationToken,
) -> Result<()> {
    let prepared = broker.prepare(attempt, cancel).await?;
    let _gate = authority.admission_lock().lock_owned().await;
    authority.call_commits().require_clear(attempt.identity())?;
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    protocol::prepare_tx(&mut tx, authority, attempt, &prepared.0).await?;
    commit_call_tx(tx, authority, attempt).await?;
    Ok(())
}

/// Private native attribution for N-HUMAN. Obtain it only while this exact
/// launched MCP call is live, under the same admission gate/SQL snapshot.
/// human_open/answer/close have the same responsibilities as legacy HostPort;
/// no human implementation or default answer is provided by N-CALLS.
#[async_trait]
pub(crate) trait CallHumanPort030: Send + Sync {
    async fn human_open(
        &self,
        call: &CallAttempt030,
        server: &str,
        request_json: &str,
    ) -> Result<String>;
    async fn human_answer(&self, ticket: &str) -> Result<String>;
    async fn human_close(&self, ticket: &str, answer: &Result<String>) -> Result<()>;
}

/// Only produced after joining a native-owned synthetic executor. No public
/// constructor or deserializer can turn transport booleans into physical proof.
#[derive(Debug)]
pub(crate) struct JoinedCall030 {
    attempt: CallAttempt030,
    received: protocol::ReceivedCall030,
}
impl JoinedCall030 {
    pub(crate) fn attempt(&self) -> &CallAttempt030 {
        &self.attempt
    }
}

/// QA transport only: its task owns one typed receiver and has no processes,
/// network sessions or descendants. Dropping the receiver of its result does
/// not start another call. Dropping the owner cancels the task, leaving SQL
/// launched/uncertain until a native supervisor reconciles the join.
#[cfg(any(test, all(debug_assertions, feature = "agsdl-engine-qa")))]
pub(crate) struct SyntheticCallDriver030 {
    sender: oneshot::Sender<CallEvent030>,
}
#[cfg(any(test, all(debug_assertions, feature = "agsdl-engine-qa")))]
impl SyntheticCallDriver030 {
    pub(crate) fn send(self, event: CallEvent030) -> Result<()> {
        self.sender
            .send(event)
            .map_err(|_| protocol::denied("Synthetic call is no longer active"))
    }
}
#[cfg(any(test, all(debug_assertions, feature = "agsdl-engine-qa")))]
pub(crate) struct OwnedSyntheticCall030 {
    attempt: CallAttempt030,
    control: Control,
    task: Option<tokio::task::JoinHandle<protocol::CallEnd030>>,
}
#[cfg(any(test, all(debug_assertions, feature = "agsdl-engine-qa")))]
impl Drop for OwnedSyntheticCall030 {
    fn drop(&mut self) {
        if self.task.is_some() {
            self.control.stop.cancel();
        }
    }
}
#[cfg(any(test, all(debug_assertions, feature = "agsdl-engine-qa")))]
impl OwnedSyntheticCall030 {
    pub(crate) async fn join(mut self) -> Result<JoinedCall030> {
        // Retain the handle in self while awaiting: cancelling this await must
        // cancel the still-owned executor rather than detach a live receiver.
        let end = self
            .task
            .as_mut()
            .ok_or_else(|| protocol::denied("Call already joined"))?
            .await
            .map_err(|_| protocol::uncertain())?;
        self.task.take();
        Ok(JoinedCall030 {
            attempt: self.attempt.clone(),
            received: protocol::ReceivedCall030 {
                end,
                physical: protocol::CallPhysical030::SyntheticJoined {
                    receipt_id: uuid::Uuid::new_v4().to_string(),
                },
            },
        })
    }
}

/// Call only from the future transferred by DispatchLease030::handoff_host.
/// The durable 033 handoff is rechecked before consuming launch exactly once.
#[cfg(any(test, all(debug_assertions, feature = "agsdl-engine-qa")))]
pub(crate) async fn launch_synthetic030<A: CallAuthority030>(
    pool: &SqlitePool,
    authority: &A,
    attempt: &CallAttempt030,
    control: Control,
) -> Result<(SyntheticCallDriver030, OwnedSyntheticCall030)> {
    let _gate = authority.admission_lock().lock_owned().await;
    authority.call_commits().require_clear(attempt.identity())?;
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    protocol::launch_tx(&mut tx, authority, attempt, &control).await?;
    commit_call_tx(tx, authority, attempt).await?;
    // No await between acknowledged launch and ownership of the synthetic task.
    let (sender, receiver) = oneshot::channel();
    let stop = control.stop.clone();
    let timeout = control.machine_timeout.clone();
    let task = tokio::spawn(async move {
        tokio::select! { biased;
            _ = stop.cancelled() => protocol::CallEnd030::Stopped,
            _ = timeout.cancelled() => protocol::CallEnd030::TimedOut,
            event = receiver => match event {
                Ok(event) => protocol::CallEnd030::Returned { event },
                Err(_) => protocol::CallEnd030::Returned { event: CallEvent030::StartFailed },
            }
        }
    });
    Ok((
        SyntheticCallDriver030 { sender },
        OwnedSyntheticCall030 {
            attempt: attempt.clone(),
            control,
            task: Some(task),
        },
    ))
}

/// Persist raw data before invoking the normalizer. Re-entry uses the exact
/// stored receipt; it never reruns a transport or replaces a conflicting result.
/// Terminal + physical reducer event commit in ONE transaction.
pub(crate) async fn finish_joined_call030<A: CallAuthority030>(
    pool: &SqlitePool,
    authority: &A,
    broker: &CallDataBroker030,
    joined: &JoinedCall030,
    cancel: &CancellationToken,
) -> Result<CallReceipt030> {
    let prepared = {
        let _gate = authority.admission_lock().lock_owned().await;
        authority
            .call_commits()
            .require_clear(joined.attempt.identity())?;
        let mut db = pool.acquire().await?;
        sqlx::query("PRAGMA synchronous=FULL")
            .execute(&mut *db)
            .await?;
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(receipt) = protocol::read_receipt_tx(
            &mut tx,
            authority,
            joined.attempt.identity(),
            joined.attempt.work(),
        )
        .await?
        {
            protocol::require(
                receipt.attempt() == &joined.attempt && receipt.received() == &joined.received,
                "Joined call conflicts with its terminal receipt",
            )?;
            tx.commit().await?;
            return Ok(receipt);
        }
        let prepared =
            protocol::receive_tx(&mut tx, authority, &joined.attempt, &joined.received).await?;
        commit_call_tx(tx, authority, &joined.attempt).await?;
        prepared
    };
    let result = match &joined.received.end {
        protocol::CallEnd030::Returned { event } => {
            broker
                .normalize(&joined.attempt, &prepared, event, cancel)
                .await?
                .0
        }
        protocol::CallEnd030::Stopped => protocol::CallResult030::Stopped,
        protocol::CallEnd030::TimedOut => protocol::CallResult030::failure("TIMEOUT"),
    };
    let _gate = authority.admission_lock().lock_owned().await;
    authority
        .call_commits()
        .require_clear(joined.attempt.identity())?;
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let receipt = protocol::finish_tx(
        &mut tx,
        authority,
        &joined.attempt,
        &joined.received,
        result,
    )
    .await?;
    commit_call_tx(tx, authority, &joined.attempt).await?;
    Ok(receipt)
}

/// Stop must already have been admitted by the native flow/control owner.
/// No executor existed, so the only admissible proof here is NotStarted.
pub(crate) async fn stop_before_launch030<A: CallAuthority030>(
    pool: &SqlitePool,
    authority: &A,
    attempt: &CallAttempt030,
) -> Result<CallReceipt030> {
    let _gate = authority.admission_lock().lock_owned().await;
    authority.call_commits().require_clear(attempt.identity())?;
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let receipt = protocol::stop_before_launch_tx(&mut tx, authority, attempt).await?;
    commit_call_tx(tx, authority, attempt).await?;
    Ok(receipt)
}

/// Readback grants no launch capability and never calls the pure worker.
pub(crate) async fn read_call_receipt030<A: CallAuthority030>(
    pool: &SqlitePool,
    authority: &A,
    identity: &FlowIdentity030,
    work: &WorkRef030,
) -> Result<Option<CallReceipt030>> {
    let mut tx = pool.begin().await?;
    let receipt = protocol::read_receipt_tx(&mut tx, authority, identity, work).await?;
    tx.commit().await?;
    authority.ensure_live()?;
    Ok(receipt)
}

#[cfg(test)]
#[path = "agsdl_host_calls030_tests.rs"]
pub(crate) mod tests;
