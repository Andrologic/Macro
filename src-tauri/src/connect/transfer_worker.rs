//! Private one-shot E framing. Database admission/dispatch is not yet connected.
//! In particular, a worker reply never creates a database or policy capability.
use super::codec::ChildIo;
use crate::connect_resources::{WorkingCharge, WorkingLease};
use crate::core::db_state::ChatWorkLifetime;
use serde::Deserialize;
use std::sync::Arc;
use tokio::process::Command;
use tokio::time::Instant;

type Result<T> = std::result::Result<T, &'static str>;
const CONTROL: usize = 4096;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Hello {
    version: String,
    portable_contract_sha256: String,
    preparation_set_sha256: String,
}

// No Deserialize and deliberately no production constructor until the real DB
// owners provide the scoped handles. START bytes are not an authority token.
struct AdmittedEWork {
    generation: u64,
    job: u64,
    arena: u64,
    child_units: u64,
    detection_units: u64,
    start: [u8; CONTROL],
    start_len: usize,
    expected: Hello,
    _database: ChatWorkLifetime,
    _working: Arc<WorkingLease>,
    _charges: Vec<WorkingCharge>,
}

#[derive(PartialEq, Eq)]
enum Phase { Hello, Admitted, Running, Dispatch, Finished, Failed }
struct Owned {
    io: ChildIo,
    // This includes native scratch/control, Child arena and detection charges.
    // They must all be reserved by the DB admission owner before spawn/GRANT.
    work: AdmittedEWork,
}

pub(super) struct TransferWorker {
    owned: Option<Owned>,
    phase: Phase,
}
impl TransferWorker {
    fn spawn(mut command: Command, work: AdmittedEWork, generation: u64) -> Result<Self> {
        if work.generation != generation { return Err("transfer_generation"); }
        if work.job == 0 || work.arena == 0 || work.start_len == 0 || work.start_len > CONTROL
            || work.child_units == 0 || work.detection_units == 0
            || work.child_units.checked_add(work.detection_units).filter(|n| *n <= MAX_SAFE).is_none()
        { return Err("transfer_admission"); }
        command.arg("connect-transfer");
        let io = ChildIo::spawn(command)?;
        Ok(Self { owned: Some(Owned { io, work }), phase: Phase::Hello })
    }
    async fn hello(&mut self) -> Result<()> {
        if self.phase != Phase::Hello { return Err("transfer_state"); }
        // Cancellation or parse failure cannot leave this state retryable.
        self.phase = Phase::Failed;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let h = owned.io.next(|_| CONTROL, |h| h.exact(1, h.length, 0, 0, 0) && h.length > 0).await?;
        let result = serde_json::from_slice::<Hello>(&owned.io.scratch[..h.length])
            .map_err(|_| "transfer_identity");
        owned.io.scratch.fill(0);
        if result? != owned.work.expected { return Err("transfer_identity"); }
        self.phase = Phase::Admitted;
        Ok(())
    }
    // Caller must freshly revalidate the native DB/policy scope after HELLO and
    // before this effect. That concrete caller remains blocked on the DB ports.
    async fn begin(&mut self, generation: u64) -> Result<()> {
        if self.phase != Phase::Admitted { return Err("transfer_state"); }
        self.phase = Phase::Failed;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let w = &mut owned.work;
        if generation != w.generation { return Err("transfer_generation"); }
        owned.io.send(2, w.job, 0, 0, &w.start[..w.start_len]).await?;
        w.start.fill(0);
        let mut grant = [0u8; 32];
        grant[..8].copy_from_slice(&(w.child_units + w.detection_units).to_be_bytes());
        grant[16..24].copy_from_slice(&w.arena.to_be_bytes());
        grant[28] = 3;
        owned.io.send(3, w.job, w.arena, 0, &grant).await?;
        self.phase = Phase::Running;
        Ok(())
    }
    // Only the E dispatcher may consume these bytes. Opcodes 1..7 are native
    // port calls, not codec operations 1..9; they confer no authority themselves.
    // The borrow forbids another read or retirement while the request is used.
    async fn request(&mut self) -> Result<&[u8]> {
        if self.phase != Phase::Running { return Err("transfer_state"); }
        self.phase = Phase::Failed;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let job = owned.work.job;
        let h = owned.io.next(|_| CONTROL, |h| h.exact(2, h.length, job, 0, 0) && h.length > 0).await?;
        self.phase = Phase::Dispatch;
        Ok(&owned.io.scratch[..h.length])
    }
    // Called only after the concrete dispatcher has completed all scopes. A
    // JOB_FINISHED frame alone is not completion: pipes and Child must be joined.
    async fn finish(&mut self, deadline: Instant) -> Result<u32> {
        if self.phase != Phase::Running { return Err("transfer_state"); }
        self.phase = Phase::Failed;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let job = owned.work.job;
        let arena = owned.work.arena;
        owned.io.next(|_| CONTROL, |h| h.exact(9, 4, job, arena, 0)).await?;
        let status = u32::from_be_bytes(owned.io.scratch[..4].try_into().unwrap());
        owned.io.scratch.fill(0);
        if status > 2 { return Err("transfer_status"); }
        if !owned.io.retire_until(deadline).await { return Err("transfer_retirement"); }
        self.phase = Phase::Finished;
        self.owned.take();
        Ok(status)
    }
    pub(super) async fn retire_until(&mut self, deadline: Instant) -> bool {
        self.phase = Phase::Failed;
        if let Some(owned) = self.owned.as_mut() {
            if !owned.io.retire_until(deadline).await { return false; }
        }
        self.owned.take();
        true
    }
}
impl Drop for TransferWorker {
    fn drop(&mut self) {
        if let Some(owned) = self.owned.take() {
            if !owned.io.retirement_complete() {
                // Same last-owner closure as runtime quarantine. Never detach a
                // Busy Windows pipe or refund a still-live Child's reservation.
                std::mem::forget(owned);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connect_resources::{TransitOwner, TRANSIT_INSTANCE_LIMIT};
    use std::time::Duration;

    // This is a real worker protocol refusal, not a successful fake DB port.
    // No archive, draft, policy authority or provider result is manufactured.
    #[tokio::test]
    async fn real_e_worker_refusal_finishes_once_and_retires_all_pipes() {
        let budget = TransitOwner::default().instance(uuid::Uuid::new_v4()).unwrap();
        // The worker retains a second control reservation before requesting
        // its policy root. Fund that real refusal path and the parent IO.
        let charge = budget.reserve(4 * 1024 * 1024).unwrap();
        let mut command = Command::new(super::super::runtime::test_bun());
        command.arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../copilot-bridge/src/entry.ts")).arg("connect-transfer");
        let mut io = ChildIo::spawn(command).unwrap();
        let exchange = async {
            let h = io.next(|_| CONTROL, |h| h.exact(1, h.length, 0, 0, 0)).await?;
            let hello: Hello = serde_json::from_slice(&io.scratch[..h.length]).map_err(|_| "hello")?;
            if hello.version != "macro-connect-transfer-1" { return Err("hello_version"); }
            let start = br#"{"op":0,"kind":"normalize","handles":{"source":"1","policy":"2","sink":"3"},"child_units":"2293760","detection_units":"1024","native_units":"1212416"}"#;
            io.send(2, 1, 0, 0, start).await?;
            let mut grant = [0u8; 32];
            grant[..8].copy_from_slice(&2_294_784u64.to_be_bytes());
            grant[16..24].copy_from_slice(&1u64.to_be_bytes());
            grant[28] = 3;
            io.send(3, 1, 1, 0, &grant).await?;
            let h = io.next(|_| CONTROL, |h| h.exact(2, h.length, 1, 0, 0)).await?;
            let request: serde_json::Value = serde_json::from_slice(&io.scratch[..h.length]).map_err(|_| "request")?;
            if request["op"] != 1 || request["kind"] != "root"
                || request["handle"] != "2" || request["call"] != "1"
            { return Err("detection_request"); }
            // Explicit unavailable response. No permission or successful effect.
            grant[..8].copy_from_slice(&1_081_344u64.to_be_bytes());
            grant[8..16].copy_from_slice(&1u64.to_be_bytes());
            grant[24..28].copy_from_slice(&4096u32.to_be_bytes());
            grant[28] = 1;
            grant[29] = 1;
            io.send(3, 1, 2, 0, &grant).await?;
            io.send(2, 1, 0, 0, br#"{"op":1,"call":"1","status":5}"#).await?;
            let mut scope = [0u8; 12];
            scope[..8].copy_from_slice(&1u64.to_be_bytes());
            scope[8..].copy_from_slice(&5u32.to_be_bytes());
            io.send(6, 1, 2, 0, &scope).await?;
            io.next(|_| CONTROL, |h| h.exact(9, 4, 1, 1, 0)).await?;
            if io.scratch[..4] != 1u32.to_be_bytes() { return Err("finished_status"); }
            Ok::<_, &'static str>(())
        };
        let result = tokio::time::timeout(Duration::from_secs(10), exchange).await;
        let retired = io.retire_until(Instant::now() + Duration::from_secs(10)).await;
        if !retired {
            // Preserve both IO and its charge even when reporting fixture failure.
            std::mem::forget((io, charge));
            panic!("worker retirement not demonstrated");
        }
        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
        drop(io);
        drop(charge);
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        assert_eq!(result, Ok(Ok(())));
    }
}
