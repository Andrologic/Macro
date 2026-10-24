use crate::connect_resources::{TransitCharge, TransitInstance};
use crate::core::db_state::ChatWorkLifetime;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::process::Stdio;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};

const PAGE: usize = 65_536;
const BODY: usize = 98_304;
const RAW: u64 = 28_311_552;
const BANK: u64 = 2_097_152;
static RAW_TURN: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)));
// Parent/child fixed fd buffers, pipe reservoirs, bounded stderr scratch and
// startup identity parsing. Logical ownership, not VM/code heap or RSS.
const STARTUP: u64 = 8 * PAGE as u64;
type Result<T> = std::result::Result<T, &'static str>;

pub(super) struct Bytes {
    data: Vec<u8>,
    _charge: TransitCharge,
}
impl Bytes {
    pub(super) fn copy(budget: &TransitInstance, source: &[u8]) -> Result<Self> {
        if source.len() > BODY {
            return Err("codec_limit");
        }
        let charge = budget
            .reserve(source.len() as u64)
            .map_err(|_| "transit_limit")?;
        Ok(Self {
            data: source.to_vec(),
            _charge: charge,
        })
    }
}
pub(super) struct Input {
    pub op: u16,
    pub expectations: Bytes,
    pub body: Bytes,
}
pub(super) struct Output {
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
pub(super) struct Codec {
    child: Child,
    input: Option<ChildStdin>,
    output: Option<ChildStdout>,
    stderr: Option<JoinHandle<()>>,
    scratch: Box<[u8; PAGE]>,
    budget: TransitInstance,
    raw: Option<TransitCharge>,
    raw_turn: Option<tokio::sync::OwnedSemaphorePermit>,
    bank: Option<TransitCharge>,
    _startup: TransitCharge,
    _database: ChatWorkLifetime,
    job: u64,
    lease: u64,
}
impl Codec {
    pub(super) fn spawn(
        mut command: Command,
        budget: TransitInstance,
        lifetime: ChatWorkLifetime,
    ) -> Result<Self> {
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
            input,
            output,
            stderr: Some(stderr),
            scratch: Box::new([0; PAGE]),
            budget,
            raw: None,
            raw_turn: None,
            bank: None,
            _startup: startup,
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
    pub(super) async fn hello(&mut self) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Hello {
            version: String,
            content_sha256: String,
            decision_resource_set_sha256: String,
            transit_resource_set_sha256: String,
            authority_resource_set_sha256: String,
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
        let digest = |value: &serde_json::Value| {
            format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
        };
        // Canonical generated dependency-set identity. A mismatch refuses before BEGIN.
        if hello.version != "macro-connect-codec-1"
            || hello.content_sha256 != transit["content_contract_sha256"]
            || hello.decision_resource_set_sha256
                != "6133c2d9ee204a175ae6c176b9c266d4378879c1637936ebd81e85daf4d0b97a"
            || hello.transit_resource_set_sha256 != digest(&transit["resources"])
            || hello.authority_resource_set_sha256 != digest(&authority["resources"])
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
        self.next(|h| h.exact(6, 4, job, raw, 0)).await?;
        if u32::from_be_bytes(self.scratch[..4].try_into().unwrap()) != u32::from(phase) {
            return Err("codec_scope");
        }
        self.scratch.fill(0);
        // All parent writes completed and the trusted codec closed its raw scope.
        self.raw.take();
        self.raw_turn.take();
        Ok(bank)
    }
    pub(super) async fn run(&mut self, input: Input) -> Result<Output> {
        if !(1..=9).contains(&input.op) || input.expectations.data.is_empty() {
            return Err("codec_input");
        }
        self.job = self.job.checked_add(1).ok_or("codec_limit")?;
        self.bank = Some(self.budget.reserve(BANK).map_err(|_| "transit_limit")?);
        let control = self
            .phase(input.op, 1, &input.expectations.data, RAW, BODY, true)
            .await?;
        // Empty-body poll delegates to the canonical v2 owner. No native grammar
        // or success is inferred from this descriptor; status 3 remains distinct.
        let (units, limit) = match input.op {
            1 => (1_146_880, 4096),
            2 => (2_293_760, 8192),
            5 if input.body.data.is_empty() => (RAW, 0),
            _ => (RAW, BODY),
        };
        self.phase(input.op, 2, &input.body.data, units, limit, false)
            .await?;
        drop(input);
        let charge = self
            .budget
            .reserve(BODY as u64)
            .map_err(|_| "transit_limit")?;
        let mut result = Bytes {
            data: Vec::with_capacity(BODY),
            _charge: charge,
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
    pub(super) async fn retire(&mut self) -> bool {
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
