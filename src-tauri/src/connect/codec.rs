use crate::connect_resources::{TransitCharge, TransitInstance};
use crate::core::db_state::ChatWorkLifetime;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{process::Stdio, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};

const PAGE: usize = 65_536;
const BODY: usize = 98_304;
const RAW: u64 = 28_311_552;
const BANK: u64 = 2_097_152;
pub(crate) static RAW_TURN: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)));
// Parent/child fixed fd buffers, pipe reservoirs, bounded stderr scratch and
// startup identity parsing. Logical ownership, not VM/code heap or RSS.
const STARTUP: u64 = 8 * PAGE as u64;
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Profile { Bootstrap, Persistent }
impl Profile {
    pub(crate) fn command(self) -> &'static str {
        match self { Self::Bootstrap => "connect-bootstrap", Self::Persistent => "connect-codec" }
    }
    pub(crate) fn accepts(self, op: u16) -> bool {
        match self { Self::Bootstrap => op == 10, Self::Persistent => (1..=9).contains(&op) }
    }
    fn identity(self) -> &'static str {
        match self {
            Self::Bootstrap => include_str!("../../../copilot-bridge/src/connect-bootstrap.identity.json"),
            Self::Persistent => include_str!("../../../copilot-bridge/src/connect-codec.identity.json"),
        }
    }
}

// One reservation outlives every native/Child borrow and the returned output.
// The semaphore belongs to this codec instance, including its runtime generation.
#[derive(Clone)]
pub(crate) struct BankOwner {
    budget: TransitInstance,
    gate: Arc<tokio::sync::Semaphore>,
    profile: Profile,
}
pub(crate) struct JobBank {
    owner: BankOwner,
    _charge: TransitCharge,
    _permit: tokio::sync::OwnedSemaphorePermit,
    slots: [AtomicBool; 2],
}
pub(crate) struct Admission {
    bank: Arc<JobBank>,
    op: u16,
}
pub(crate) struct AdmittedInput {
    pub(super) input: Input,
    pub(super) bank: Arc<JobBank>,
}
struct EncodedSlot {
    bank: Arc<JobBank>,
    index: usize,
}
impl Drop for EncodedSlot {
    fn drop(&mut self) { self.bank.slots[self.index].store(false, Ordering::Release); }
}
// Data is declared before its charge so its backing disappears first.
#[allow(dead_code)]
enum BytesCharge { External(TransitCharge), Bank(EncodedSlot) }
impl BankOwner {
    pub(crate) fn admit(&self, op: u16) -> Result<Admission> {
        if !self.profile.accepts(op) { return Err("codec_profile"); }
        let permit = self.gate.clone().try_acquire_owned().map_err(|_| "codec_busy")?;
        let charge = self.budget.reserve(BANK).map_err(|_| "transit_limit")?;
        Ok(Admission { op, bank: Arc::new(JobBank {
            owner: self.clone(), _charge: charge, _permit: permit,
            slots: [AtomicBool::new(false), AtomicBool::new(false)],
        }) })
    }
    pub(crate) fn owns(&self, input: &AdmittedInput) -> bool {
        Arc::ptr_eq(&self.gate, &input.bank.owner.gate) && self.profile.accepts(input.input.op)
    }
}
impl JobBank {
    fn slot(self: &Arc<Self>, index: usize) -> Result<EncodedSlot> {
        self.slots[index].compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "codec_busy")?;
        Ok(EncodedSlot { bank: self.clone(), index })
    }
    fn adopt(self: &Arc<Self>, bytes: Bytes, index: usize) -> Result<Bytes> {
        if bytes.data.capacity() > BODY { return Err("codec_limit"); }
        let slot = self.slot(index)?;
        let Bytes { data, _charge, _receive } = bytes;
        // BANK and its exclusive slot already cover the same backing.
        drop(_charge);
        Ok(Bytes { data, _charge: BytesCharge::Bank(slot), _receive })
    }
}
impl Admission {
    pub(crate) fn input(self, facts: &impl serde::Serialize, body: Bytes) -> Result<AdmittedInput> {
        let expectations = Bytes::serialize_charged(BytesCharge::Bank(self.bank.slot(0)?), facts)?;
        let body = self.bank.adopt(body, 1)?;
        Ok(AdmittedInput { input: Input { op: self.op, expectations, body }, bank: self.bank })
    }
    pub(crate) fn adopt(self, input: Input) -> Result<AdmittedInput> {
        if self.op != input.op { return Err("codec_input"); }
        let expectations = self.bank.adopt(input.expectations, 0)?;
        let body = self.bank.adopt(input.body, 1)?;
        Ok(AdmittedInput { input: Input { op: self.op, expectations, body }, bank: self.bank })
    }
}

pub(crate) struct Bytes {
    data: Vec<u8>,
    _charge: BytesCharge,
    // Released only after the received backing and its charge.
    _receive: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Bytes {
    pub(crate) fn as_slice(&self) -> &[u8] {
        &self.data
    }
    // The caller transfers the original reservoir and its unreleased admission.
    pub(crate) fn adopt(data: Vec<u8>, charge: TransitCharge, capacity: usize) -> Result<Self> {
        if data.len() > BODY || data.capacity() > capacity {
            return Err("codec_limit");
        }
        Ok(Self {
            data,
            _charge: BytesCharge::External(charge),
            _receive: None,
        })
    }
    pub(crate) fn adopt_received(
        data: Vec<u8>, charge: TransitCharge, capacity: usize,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<Self> {
        let mut bytes = Self::adopt(data, charge, capacity)?;
        bytes._receive = Some(permit);
        Ok(bytes)
    }
    pub(crate) fn serialize(
        budget: &TransitInstance,
        value: &impl serde::Serialize,
    ) -> Result<Self> {
        let charge = budget.reserve(BODY as u64).map_err(|_| "transit_limit")?;
        Self::serialize_charged(BytesCharge::External(charge), value)
    }
    fn serialize_charged(charge: BytesCharge, value: &impl serde::Serialize) -> Result<Self> {
        struct Bounded(Vec<u8>);
        impl std::io::Write for Bounded {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if bytes.len() > BODY - self.0.len() {
                    return Err(std::io::Error::other("codec_limit"));
                }
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = Bounded(Vec::with_capacity(BODY));
        serde_json::to_writer(&mut writer, value).map_err(|_| "codec_input")?;
        if writer.0.capacity() > BODY { return Err("codec_limit"); }
        Ok(Self { data: writer.0, _charge: charge, _receive: None })
    }
    pub(crate) fn copy(budget: &TransitInstance, source: &[u8]) -> Result<Self> {
        if source.len() > BODY {
            return Err("codec_limit");
        }
        let charge = budget
            .reserve(source.len() as u64)
            .map_err(|_| "transit_limit")?;
        Ok(Self {
            data: source.to_vec(),
            _charge: BytesCharge::External(charge),
            _receive: None,
        })
    }
}
impl AsRef<[u8]> for Bytes {
    fn as_ref(&self) -> &[u8] {
        self.as_slice()
    }
}
pub(crate) struct Input {
    pub op: u16,
    pub expectations: Bytes,
    pub body: Bytes,
}
pub(crate) struct Output {
    pub status: u32,
    pub bytes: Bytes,
}
#[derive(Clone, Copy)]
struct Header {
    kind: u8,
    job: u64,
    lease: u64,
    length: usize,
    sequence: u32,
}
impl Header {
    fn exact(self, kind: u8, length: usize, job: u64, lease: u64, sequence: u32) -> bool {
        self.kind == kind
            && self.length == length
            && self.job == job
            && self.lease == lease
            && self.sequence == sequence
    }
}
#[cfg(test)]
pub(super) struct ScopeProbe {
    pub phase: u8,
    pub after: bool,
    pub reached: tokio::sync::oneshot::Sender<()>,
    pub resume: tokio::sync::oneshot::Receiver<()>,
}
pub(crate) struct Codec {
    child: Child,
    #[cfg(test)]
    pub(super) scope_probe: Option<ScopeProbe>,
    input: Option<ChildStdin>,
    output: Option<ChildStdout>,
    stderr: Option<JoinHandle<()>>,
    scratch: Box<[u8; PAGE]>,
    budget: TransitInstance,
    raw: Option<TransitCharge>,
    raw_turn: Option<tokio::sync::OwnedSemaphorePermit>,
    bank: Option<Arc<JobBank>>,
    pub(crate) bank_owner: BankOwner,
    _startup: TransitCharge,
    _a1_module: Option<TransitCharge>,
    profile: Profile,
    _database: ChatWorkLifetime,
    job: u64,
    lease: u64,
}
impl Codec {
    pub(crate) fn spawn(
        mut command: Command,
        budget: TransitInstance,
        lifetime: ChatWorkLifetime,
        profile: Profile,
    ) -> Result<Self> {
        // Persistent generated A1 module reservation, held until Child retirement.
        // This is a logical module charge, not a bound on JSC code/VM or RSS.
        let a1_module = if profile == Profile::Bootstrap { Some(budget.reserve(1_835_008).map_err(|_| "transit_limit")?) } else { None };
        let startup = budget.reserve(STARTUP).map_err(|_| "transit_limit")?;
        command
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| "codec_spawn")?;
        let input = child.stdin.take();
        let output = child.stdout.take();
        let mut error = child.stderr.take().expect("piped stderr");
        // Diagnostics never accumulate or become strings. This task owns no
        // detached callback and is always joined by retire before STARTUP returns.
        let stderr = tokio::spawn(async move {
            let mut scratch = [0u8; 4096];
            loop {
                match error.read(&mut scratch).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => scratch.fill(0),
                }
            }
        });
        Ok(Self {
            child,
            #[cfg(test)]
            scope_probe: None,
            input,
            output,
            stderr: Some(stderr),
            scratch: Box::new([0; PAGE]),
            bank_owner: BankOwner { budget: budget.clone(), gate: Arc::new(tokio::sync::Semaphore::new(1)), profile },
            budget,
            raw: None,
            raw_turn: None,
            bank: None,
            _startup: startup,
            _a1_module: a1_module,
            profile,
            _database: lifetime,
            job: 0,
            lease: 0,
        })
    }
    async fn send(
        &mut self,
        kind: u8,
        job: u64,
        lease: u64,
        sequence: u32,
        data: &[u8],
    ) -> Result<()> {
        let mut h = [0u8; 32];
        h[..4].copy_from_slice(b"MCF1");
        h[4..6].copy_from_slice(&1u16.to_be_bytes());
        h[6] = kind;
        h[8..16].copy_from_slice(&job.to_be_bytes());
        h[16..24].copy_from_slice(&lease.to_be_bytes());
        h[24..28].copy_from_slice(&(data.len() as u32).to_be_bytes());
        h[28..32].copy_from_slice(&sequence.to_be_bytes());
        let input = self.input.as_mut().ok_or("codec_closed")?;
        input.write_all(&h).await.map_err(|_| "codec_write")?;
        input.write_all(data).await.map_err(|_| "codec_write")
    }
    async fn next(&mut self, valid: impl FnOnce(Header) -> bool) -> Result<Header> {
        let mut h = [0u8; 32];
        let output = self.output.as_mut().ok_or("codec_closed")?;
        output.read_exact(&mut h).await.map_err(|_| "codec_eof")?;
        if &h[..4] != b"MCF1" || h[4..6] != [0, 1] || h[7] != 0 {
            return Err("codec_framing");
        }
        let header = Header {
            kind: h[6],
            job: u64::from_be_bytes(h[8..16].try_into().unwrap()),
            lease: u64::from_be_bytes(h[16..24].try_into().unwrap()),
            length: u32::from_be_bytes(h[24..28].try_into().unwrap()) as usize,
            sequence: u32::from_be_bytes(h[28..32].try_into().unwrap()),
        };
        let limit = if header.kind == 7 { PAGE } else { 4096 };
        if header.length > limit || !valid(header) {
            return Err("codec_framing");
        }
        // Header/state/credit validation precedes every payload read. Never drain
        // an unadmitted body after a framing failure.
        output
            .read_exact(&mut self.scratch[..header.length])
            .await
            .map_err(|_| "codec_eof")?;
        Ok(header)
    }
    #[cfg(test)]
    pub(crate) fn pid(&self) -> u32 { self.child.id().expect("live Child") }
    pub(crate) async fn hello(&mut self) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Hello {
            version: String,
            content_sha256: String,
            decision_resource_set_sha256: String,
            transit_resource_set_sha256: String,
            authority_resource_set_sha256: String,
            #[serde(default)]
            a1_resource_set_sha256: Option<String>,
            profile: String,
            source_set_sha256: String,
        }
        let h = self
            .next(|h| h.exact(1, h.length, 0, 0, 0) && h.length > 0)
            .await?;
        let hello: Hello =
            serde_json::from_slice(&self.scratch[..h.length]).map_err(|_| "codec_identity")?;
        let transit: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/macro-pilot/v2/transfer-transit/transfer-transit-contract.json"
        ))
        .map_err(|_| "codec_identity")?;
        let authority: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/macro-pilot/v2/transfer-authority/transfer-authority-contract.json"
        ))
        .map_err(|_| "codec_identity")?;
        let a1: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/services/macroPilot/schemaValidators.identity.json"
        ))
        .map_err(|_| "codec_identity")?;
        let digest = |value: &serde_json::Value| {
            format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
        };
        let identity: serde_json::Value = serde_json::from_str(self.profile.identity()).map_err(|_| "codec_identity")?;
        let expected = &identity["hello"];
        // Canonical generated dependency-set identity. A mismatch refuses before BEGIN.
        if a1["retained_units"] != 1_835_008u64
            || hello.version != "macro-connect-codec-1"
            || hello.content_sha256 != transit["content_contract_sha256"]
            || hello.decision_resource_set_sha256
                != "6133c2d9ee204a175ae6c176b9c266d4378879c1637936ebd81e85daf4d0b97a"
            || hello.transit_resource_set_sha256 != digest(&transit["resources"])
            || hello.authority_resource_set_sha256 != digest(&authority["resources"])
            || hello.profile != expected["profile"]
            || hello.source_set_sha256 != expected["source_set_sha256"]
            || match self.profile {
                Profile::Bootstrap => hello.a1_resource_set_sha256.as_deref() != Some(digest(&a1["resources"]).as_str()),
                Profile::Persistent => hello.a1_resource_set_sha256.is_some(),
            }
        {
            return Err("codec_identity");
        }
        self.scratch.fill(0);
        Ok(())
    }
    async fn grant(&mut self, units: u64, class: u32, limit: usize) -> Result<u64> {
        self.lease = self.lease.checked_add(1).ok_or("codec_limit")?;
        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&units.to_be_bytes());
        bytes[8..12].copy_from_slice(&class.to_be_bytes());
        bytes[12..].copy_from_slice(&(limit as u32).to_be_bytes());
        self.send(3, self.job, self.lease, 0, &bytes).await?;
        Ok(self.lease)
    }
    #[cfg(test)]
    async fn probe_scope(&mut self, phase: u8, after: bool) -> Result<()> {
        if self.scope_probe.as_ref().is_some_and(|p| p.phase == phase && p.after == after) {
            let probe = self.scope_probe.take().unwrap();
            let _ = probe.reached.send(());
            let _ = probe.resume.await;
            return Err("codec_test_scope");
        }
        Ok(())
    }
    async fn phase(
        &mut self,
        op: u16,
        phase: u8,
        data: &[u8],
        units: u64,
        limit: usize,
        control: bool,
    ) -> Result<u64> {
        if data.len() > limit {
            return Err("codec_limit");
        }
        self.raw_turn = Some(
            RAW_TURN
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| "codec_closed")?,
        );
        self.raw = Some(self.budget.reserve(units).map_err(|_| "transit_limit")?);
        let mut begin = [0u8; 8];
        begin[..2].copy_from_slice(&op.to_be_bytes());
        begin[2] = phase;
        begin[4..].copy_from_slice(&(data.len() as u32).to_be_bytes());
        self.send(2, self.job, 0, 0, &begin).await?;
        let bank = if control {
            self.grant(BANK, 2, BODY).await?
        } else {
            0
        };
        let raw = self.grant(units, 1, limit).await?;
        let job = self.job;
        for (sequence, page) in data.chunks(PAGE).enumerate() {
            self.send(4, job, raw, sequence as u32, page).await?;
            self.next(|h| h.exact(5, 0, job, raw, sequence as u32))
                .await?;
        }
        #[cfg(test)]
        self.probe_scope(phase, false).await?;
        self.next(|h| h.exact(6, 4, job, raw, 0)).await?;
        if u32::from_be_bytes(self.scratch[..4].try_into().unwrap()) != u32::from(phase) {
            return Err("codec_scope");
        }
        self.scratch.fill(0);
        // All parent writes completed and the trusted codec closed its raw scope.
        self.raw.take();
        self.raw_turn.take();
        #[cfg(test)]
        self.probe_scope(phase, true).await?;
        Ok(bank)
    }
    pub(crate) async fn run(&mut self, admitted: AdmittedInput) -> Result<Output> {
        if !self.bank_owner.owns(&admitted) { return Err("codec_owner"); }
        let AdmittedInput { input, bank } = admitted;
        if !self.profile.accepts(input.op) || input.expectations.data.is_empty() {
            return Err("codec_input");
        }
        self.job = self.job.checked_add(1).ok_or("codec_limit")?;
        self.bank = Some(bank.clone());
        let Input { op, expectations, body } = input;
        let control = self
            .phase(op, 1, &expectations.data, RAW, BODY, true)
            .await?;
        drop(expectations); // Child cannot enter phase2 before the following BEGIN.
        // Empty-body poll delegates to the canonical v2 owner. No native grammar
        // or success is inferred from this descriptor; status 3 remains distinct.
        let (units, limit) = match op {
            1 => (1_146_880, 4096),
            2 => (2_293_760, 8192),
            5 if body.data.is_empty() => (RAW, 0),
            _ => (RAW, BODY),
        };
        self.phase(op, 2, &body.data, units, limit, false)
            .await?;
        drop(body);
        let charge = BytesCharge::Bank(bank.slot(1)?);
        let mut result = Bytes {
            data: Vec::with_capacity(BODY),
            _charge: charge,
            _receive: None,
        };
        let mut sequence = 0u32;
        let job = self.job;
        loop {
            let remaining = BODY - result.data.len();
            let h = self
                .next(|h| {
                    h.exact(9, 4, job, control, 0)
                        || h.exact(7, h.length, job, control, sequence)
                            && h.length > 0
                            && h.length <= remaining
                })
                .await?;
            if h.kind == 9 {
                let status = u32::from_be_bytes(self.scratch[..4].try_into().unwrap());
                if status > 3 {
                    return Err("codec_status");
                }
                self.scratch.fill(0);
                self.bank.take();
                return Ok(Output {
                    status,
                    bytes: result,
                });
            }
            result.data.extend_from_slice(&self.scratch[..h.length]);
            self.scratch.fill(0);
            self.send(8, job, control, sequence, &[]).await?;
            sequence = sequence.checked_add(1).ok_or("codec_limit")?;
        }
    }
    pub(crate) async fn retire(&mut self) -> bool {
        // This private bundled codec does not spawn external children. Kill its
        // dedicated Unix group as containment, but only Child::wait proves reap
        // of the actually owned child; no universal descendant claim is made.
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
        self.input.take();
        self.output.take();
        let reaped = self.child.wait().await.is_ok();
        let drained = match self.stderr.take() {
            Some(task) => {
                task.abort();
                task.await
                    .map(|_| true)
                    .unwrap_or_else(|e| e.is_cancelled())
            }
            None => true,
        };
        if reaped && drained {
            self.scratch.fill(0);
            self.raw.take();
            self.raw_turn.take();
            self.bank.take();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod buffer_ownership_tests {
    use super::*;
    use crate::connect_resources::{TransitOwner, TRANSIT_INSTANCE_LIMIT};

    #[test]
    fn bank_slots_transfer_backings_and_keep_last_hyper_reference_charged() {
        let budget = TransitOwner::default().instance(uuid::Uuid::new_v4()).unwrap();
        let owner = BankOwner { budget: budget.clone(), gate: Arc::new(tokio::sync::Semaphore::new(1)), profile: Profile::Persistent };
        let admission = owner.admit(7).unwrap();
        let body = Bytes::copy(&budget, b"{}").unwrap();
        let pointer = body.data.as_ptr();
        let input = admission.input(&serde_json::json!({"chunk":"synthetic"}), body).unwrap();
        assert_eq!(input.input.body.data.as_ptr(), pointer);
        let other = BankOwner { budget: budget.clone(), gate: Arc::new(tokio::sync::Semaphore::new(1)), profile: Profile::Persistent };
        assert!(!other.owns(&input));
        assert!(owner.owns(&input));
        assert!(owner.admit(10).is_err());
        assert!(owner.admit(7).is_err());
        assert!(input.bank.slot(0).is_err());
        assert!(input.bank.slot(1).is_err());
        let AdmittedInput { input: Input { expectations, body, .. }, bank } = input;
        drop(expectations);
        let child_a = bank.slot(0).unwrap();
        drop(body);
        let mut data = Vec::with_capacity(BODY);
        data.extend_from_slice(b"{}");
        let result = Bytes { data, _charge: BytesCharge::Bank(bank.slot(1).unwrap()), _receive: None };
        drop(child_a);
        drop(bank);
        let shared = bytes::Bytes::from_owner(result);
        let last = shared.clone();
        drop(shared);
        assert_eq!(owner.admit(1).err().unwrap(), "codec_busy");
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT - BANK).unwrap());
        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT - BANK + 1).is_err());
        drop(last);
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        drop(owner.admit(1).unwrap());
        let bad = Bytes::adopt(Vec::with_capacity(BODY + 1), budget.reserve((BODY + 1) as u64).unwrap(), BODY + 1).unwrap();
        assert!(owner.admit(1).unwrap().input(&serde_json::json!({}), bad).is_err());
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
    }

    #[test]
    fn adopted_capacity_and_shared_backing_remain_charged_until_last_owner() {
        let owner = TransitOwner::default();
        let budget = owner.instance(uuid::Uuid::new_v4()).unwrap();
        let charge = budget.reserve(BODY as u64).unwrap();
        let mut reservoir = Vec::with_capacity(BODY);
        reservoir.extend_from_slice(b"{}");
        let pointer = reservoir.as_ptr();
        let bytes = Bytes::adopt(reservoir, charge, BODY).unwrap();
        assert_eq!(bytes.as_slice().as_ptr(), pointer);
        let shared = bytes::Bytes::from_owner(bytes);
        let last = shared.clone();
        drop(shared);
        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
        drop(
            budget
                .reserve(TRANSIT_INSTANCE_LIMIT - BODY as u64)
                .unwrap(),
        );
        drop(last);
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        let charge = budget.reserve(32).unwrap();
        assert!(Bytes::adopt(Vec::with_capacity(64), charge, 32).is_err());
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
    }

    #[test]
    fn bounded_serialization_refuses_overflow_and_returns_its_admission() {
        let owner = TransitOwner::default();
        let budget = owner.instance(uuid::Uuid::new_v4()).unwrap();
        let value = "a".repeat(BODY - 2);
        let bytes = Bytes::serialize(&budget, &value).unwrap();
        assert_eq!(bytes.as_slice().len(), BODY);
        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
        drop(bytes);
        assert!(Bytes::serialize(&budget, &format!("{value}a")).is_err());
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
    }
}
