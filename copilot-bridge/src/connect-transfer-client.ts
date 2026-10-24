import { Frame, Reject, FrameReader, FrameWriter, type Header, nextSequence } from './connect-codec-framing';
import { PortableWorkBudget } from '../../src/services/ai/portableHistoryInspection';
import { CONTROL_RESERVE, TransferFailure, ensure, integer, sum } from './connect-transfer-values';
import { decodeControl, encodeControl, validateRequest, validateResponse, validateGrant, type Facts, type Start } from './connect-transfer-protocol';

export const DATA_CREDIT = 2 * 65_536;
/** One synchronous call owner, not a registry or queue of remote functions. */
export class TransferClient {
  private nextCall = 0n;
  private lastLease: bigint;
  private controlLease = 0n;
  private active = false;
  constructor(readonly reader: FrameReader, readonly writer: FrameWriter, readonly job: bigint,
    readonly arena: bigint, readonly start: Start, readonly budget: PortableWorkBudget, readonly detectionBudget: PortableWorkBudget) { this.lastLease = arena; }
  private async read(validate: (header: Header) => void) {
    const frame = await this.reader.next(h => {
      ensure(h.job === this.job);
      if (h.type === Frame.CANCEL) { ensure(h.lease === 0n && h.sequence === 0 && h.length === 0); throw new TransferFailure(7); }
      validate(h);
    });
    return frame;
  }
  private async grant(call: bigint, kind: number, direction: number) {
    const frame = await this.read(h => ensure(h.type === Frame.GRANT && h.length === 32 && h.sequence === 0 && h.lease > this.lastLease));
    const grant = validateGrant(frame.payload);
    ensure(grant.call === call && grant.arena === this.arena && grant.kind === kind && grant.direction === direction, 8, Reject.credit);
    ensure(grant.units === (kind === 1 ? CONTROL_RESERVE : DATA_CREDIT), 8, Reject.credit);
    this.lastLease = frame.header.lease;
    if (kind === 1) this.controlLease = frame.header.lease;
    return { ...grant, lease: frame.header.lease };
  }
  async response(request: Facts): Promise<Facts> {
    await this.grant(BigInt(request.call), 1, 1);
    const frame = await this.read(h => ensure(h.type === Frame.BEGIN && h.lease === 0n && h.sequence === 0));
    const response = decodeControl(frame.payload); validateResponse(response, request);
    if (response.status) {
      await this.scope(request, response.status); throw new TransferFailure(response.status, false);
    }
    return response.result;
  }
  async receiveBytes(call: string, length: number, consume: (page: Uint8Array) => Promise<void>): Promise<void> {
    const g = await this.grant(BigInt(call), 2, 1);
    let offset = 0, sequence = 0;
    while (offset < length) {
      const frame = await this.read(h => ensure(h.type === Frame.PAGE && h.lease === g.lease && h.sequence === sequence && h.length > 0 && h.length <= g.limit && h.length <= length - offset));
      await consume(frame.payload); offset += frame.payload.length;
      frame.payload.fill(0);
      await this.writer.send(Frame.PAGE_CONSUMED, this.job, g.lease, sequence);
      sequence = nextSequence(sequence);
    }
  }
  async sendBytes(call: string, bytes: Uint8Array, beforePages?: () => Promise<void>): Promise<void> {
    const g = await this.grant(BigInt(call), 2, 2);
    if (beforePages) await beforePages();
    let offset = 0, sequence = 0;
    while (offset < bytes.length) {
      const page = bytes.subarray(offset, Math.min(bytes.length, offset + g.limit));
      const writing = this.writer.send(Frame.PAGE, this.job, g.lease, sequence, page);
      const reading = this.read(h => ensure(h.type === Frame.PAGE_CONSUMED && h.length === 0 && h.lease === g.lease && h.sequence === sequence));
      // An ACK, error or CANCEL never releases an unfinished write borrow.
      const settled = await Promise.allSettled([writing, reading]);
      for (const result of settled) if (result.status === 'rejected') throw result.reason;
      offset += page.length; sequence = nextSequence(sequence);
    }
  }
  private async scope(request: Facts, status = 0): Promise<void> {
    const frame = await this.read(h => ensure(h.type === Frame.SCOPE_FINISHED && h.length === 12 && h.sequence === 0 && h.lease === this.controlLease));
    const v = new DataView(frame.payload.buffer, frame.payload.byteOffset, 12);
    ensure(v.getBigUint64(0) === BigInt(request.call) && v.getUint32(8) === status);
  }
  async call<T>(args: Facts, consume: (request: Facts, response: Facts) => Promise<T>, produce?: (request: Facts) => Promise<void>): Promise<T> {
    ensure(!this.active); this.active = true;
    try {
      ensure(this.nextCall < 9_007_199_254_740_991n);
      const request = { ...args, call: String(++this.nextCall) }; validateRequest(request);
      await this.writer.send(Frame.BEGIN, this.job, 0n, 0, encodeControl(request));
      if (produce) await produce(request);
      const response = await this.response(request);
      const value = await consume(request, response);
      await this.scope(request); return value;
    } finally { this.active = false; }
  }
  async simple(args: Facts): Promise<Facts> { return this.call(args, async (_r, response) => response); }
  get grantUnits(): number { return sum(integer(this.start.child_units), integer(this.start.detection_units)); }
}
