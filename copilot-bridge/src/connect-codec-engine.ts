import { writeSync } from 'node:fs';
import { Frame, Reject, CodecFailure, FrameReader, FrameWriter, BODY_BYTES, RAW_UNITS, BANK_UNITS,
  nextSequence, requireCodec, u32, type Header } from './connect-codec-framing';
import { ControlBank, copyClosed, measureClosed } from './connect-codec-values';
import type { Opcode, BodyResult } from './connect-codec-operations';
type Operations = Pick<typeof import('./connect-codec-operations'), 'prepareFacts' | 'validateBody' | 'bodyDescriptor' | 'cleanDiagnostics' | 'reserveAdapter'>;
export type CodecProfile = Operations & { hello: object; accepts(op: number): boolean };

type Job = { id: bigint; op: Opcode; total: number; phase: 1 | 2; started: number;
  control: bigint; raw: bigint; bank: ControlBank };
class Cancelled extends Error {}
const exact = (header: Header, type: number, length: number, job: bigint, lease?: bigint, sequence = 0) => {
  requireCodec(header.type === type && header.length === length && header.job === job && header.sequence === sequence, Reject.state);
  if (lease !== undefined) requireCodec(header.lease === lease, Reject.credit);
};
const begin = (payload: Uint8Array) => {
  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const op = data.getUint16(0), phase = data.getUint8(2), total = data.getUint32(4);
  requireCodec(op >= 1 && op <= 10 && (phase === 1 || phase === 2) && data.getUint8(3) === 0);
  return { op: op as Opcode, phase: phase as 1 | 2, total };
};

// The JSON string and graph argument leave this synchronous scope before output waits.
function encodeResult(value: unknown, bank: ControlBank): { bytes: Uint8Array; release(): void } {
  const size = measureClosed(value);
  const releaseString = bank.graphs('result-json', 1);
  const releaseBytes = bank.bytes('result-bytes', size.jsonBytes);
  try {
    const text = JSON.stringify(value), bytes = new Uint8Array(size.jsonBytes);
    const encoded = new TextEncoder().encodeInto(text, bytes);
    requireCodec(encoded.read === text.length && encoded.written === size.jsonBytes, Reject.limit);
    return { bytes, release: releaseBytes };
  } catch (error) { releaseBytes(); throw error; }
  finally { releaseString(); }
}

/** The native parent owns real quota, processes and pipes. This child owns one job only. */
export async function runCodec(profile: CodecProfile, input = 0, output = 1): Promise<void> {
  const { prepareFacts, validateBody, bodyDescriptor, cleanDiagnostics, reserveAdapter } = profile;
  const reader = new FrameReader(input), writer = new FrameWriter(output);
  let lastJob = 0n, lastLease = 0n, job: Job | undefined;
  let expectation: ReturnType<typeof copyClosed> | undefined;
  let result: BodyResult | undefined;
  let pendingBytes: Uint8Array | undefined;
  let releaseEncoded: (() => void) | undefined;
  const cancelHeader = (h: Header) => {
    requireCodec(job?.control, Reject.credit);
    exact(h, Frame.CANCEL, 0, job!.id, 0n);
  };
  const finishedScope = async () => {
    const lease = job!.raw;
    requireCodec(lease > 0n, Reject.credit);
    job!.raw = 0n;
    await writer.send(Frame.SCOPE_FINISHED, job!.id, lease, 0, u32(job!.phase));
  };
  const clearClosed = () => {
    if (expectation) { expectation.release(); expectation = undefined; }
    if (result?.closed) { result.closed.release(); result.closed = undefined; }
  };
  const finishJob = async (status: number) => {
    clearClosed(); pendingBytes = undefined;
    if (releaseEncoded) { releaseEncoded(); releaseEncoded = undefined; }
    requireCodec(job!.bank.empty(), Reject.credit);
    await writer.send(Frame.JOB_FINISHED, job!.id, job!.control, 0, u32(status));
    job = undefined; result = undefined;
  };
  const phaseBytes = async (limit: number, units: number): Promise<Uint8Array> => {
    let phase: Uint8Array | undefined, received = 0, sequence = 0;
    while (true) {
      const frame = await reader.next(h => {
        if (h.type === Frame.CANCEL) { cancelHeader(h); return; }
        if (h.type === Frame.GRANT) {
          exact(h, Frame.GRANT, 16, job!.id);
          requireCodec(h.lease > lastLease && h.lease > 0n, Reject.credit); return;
        }
        exact(h, Frame.PAGE, h.length, job!.id, job!.raw, sequence);
        requireCodec(h.length > 0 && h.length <= job!.total - received, Reject.limit);
        requireCodec(job!.raw && job!.control && phase && received < job!.total, Reject.credit);
      });
      const h = frame.header;
      if (h.type === Frame.CANCEL) { phase = undefined; throw new Cancelled(); }
      if (h.type === Frame.GRANT) {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        const granted = view.getBigUint64(0), kind = view.getUint32(8), rawLimit = view.getUint32(12);
        if (kind === 2) {
          requireCodec(job!.phase === 1 && !job!.control && granted === BigInt(BANK_UNITS) && rawLimit === BODY_BYTES, Reject.credit);
          job!.control = h.lease;
        } else {
          requireCodec(kind === 1 && !job!.raw && granted === BigInt(units) && rawLimit === limit, Reject.credit);
          job!.raw = h.lease;
          // No bytes proportional to an unvalidated length or an absent grant.
          phase = new Uint8Array(job!.total);
        }
        lastLease = h.lease;
      } else {
        phase!.set(frame.payload, received); received += frame.payload.byteLength;
        frame.payload.fill(0); // The reusable pipe page no longer retains this raw copy before ACK.
        await writer.send(Frame.PAGE_CONSUMED, job!.id, job!.raw, sequence);
        sequence = nextSequence(sequence);
      }
      if (job!.control && job!.raw && received === job!.total) return phase!;
    }
  };
  try {
    const helloBytes = new TextEncoder().encode(JSON.stringify(profile.hello));
    await writer.send(Frame.HELLO, 0n, 0n, 0, helloBytes);
    while (true) {
      const first = await reader.next(h => {
        if (h.type === Frame.STOP) { exact(h, Frame.STOP, 0, 0n, 0n); return; }
        exact(h, Frame.BEGIN, 8, h.job, 0n);
        requireCodec(h.job > lastJob && h.job > 0n);
      });
      if (first.header.type === Frame.STOP) { await writer.send(Frame.STOPPED, 0n, 0n); return; }
      const start = begin(first.payload);
      requireCodec(profile.accepts(start.op), Reject.state);
      requireCodec(start.phase === 1);
      requireCodec(start.total > 0 && start.total <= BODY_BYTES, Reject.limit);
      lastJob = first.header.job;
      job = { id: lastJob, ...start, started: performance.now(), control: 0n, raw: 0n, bank: new ControlBank() };
      pendingBytes = await phaseBytes(BODY_BYTES, RAW_UNITS);
      let accepted = false;
      const adapter = reserveAdapter(RAW_UNITS);
      const release = adapter.reserve(RAW_UNITS);
      try { expectation = prepareFacts(job.op, pendingBytes, job.bank); accepted = true; }
      catch { accepted = false; }
      finally { release(); adapter.done(true); pendingBytes = undefined; cleanDiagnostics(); }
      await finishedScope();
      if (!accepted) { await finishJob(1); continue; }

      const second = await reader.next(h => {
        if (h.type === Frame.CANCEL) { cancelHeader(h); return; }
        exact(h, Frame.BEGIN, 8, job!.id, 0n);
      });
      if (second.header.type === Frame.CANCEL) throw new Cancelled();
      const body = begin(second.payload);
      const descriptor = bodyDescriptor(job.op, expectation!.value as Record<string, any>);
      requireCodec(body.op === job.op && body.phase === 2);
      requireCodec(body.total <= descriptor.limit && (body.total > 0 || descriptor.limit === 0), Reject.limit);
      job.phase = 2; job.total = body.total;
      pendingBytes = await phaseBytes(descriptor.limit, descriptor.units);
      try { result = await validateBody(job.op, pendingBytes, expectation!.value as Record<string, any>, job.started, job.bank); }
      finally { pendingBytes = undefined; }
      await finishedScope();
      const status = result.status;
      if (result.closed) {
        const encoded = encodeResult(result.closed.value, job.bank);
        pendingBytes = encoded.bytes; releaseEncoded = encoded.release;
        clearClosed();
        let offset = 0, sequence = 0;
        while (offset < pendingBytes.byteLength) {
          const page = pendingBytes.subarray(offset, Math.min(pendingBytes.byteLength, offset + 65_536));
          // ACK/CANCEL can arrive during a partial write, but never releases that write's borrow.
          const writing = writer.send(Frame.RESULT_PAGE, job.id, job.control, sequence, page);
          const reading = reader.next(h => {
            if (h.type === Frame.CANCEL) { cancelHeader(h); return; }
            exact(h, Frame.RESULT_CONSUMED, 0, job!.id, job!.control, sequence);
          });
          const completed = await Promise.allSettled([writing, reading]);
          for (const item of completed) if (item.status === 'rejected') throw item.reason;
          if (completed[1].status === 'fulfilled' && completed[1].value.header.type === Frame.CANCEL) throw new Cancelled();
          offset += page.byteLength; sequence = nextSequence(sequence);
        }
      }
      await finishJob(status);
    }
  } catch (error) {
    if (error instanceof Cancelled && job?.control) {
      pendingBytes = undefined;
      if (job.raw) await finishedScope();
      await finishJob(2); return; // Cancellation retires this pipe, with no next private result.
    }
    const code = error instanceof CodecFailure ? error.code : Reject.state;
    // Never stringify an exception or a payload, including filesystem failures.
    try { await writer.send(Frame.REJECT, job?.id ?? 0n, 0n, 0, u32(code)); } catch { /* Parent must retire and join. */ }
    writeSync(2, `connect_codec_reject_${code}\n`);
    process.exitCode = 1;
  }
}
