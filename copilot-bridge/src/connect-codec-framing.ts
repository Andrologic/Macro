import { read, write } from 'node:fs';

export const HEADER_BYTES = 32;
export const PAGE_BYTES = 65_536;
export const CONTROL_BYTES = 4_096;
export const BODY_BYTES = 98_304;
export const RAW_UNITS = 28_311_552;
export const BANK_UNITS = 2_097_152;
export const GRAPH_SLOT = 196_608;
export const Frame = Object.freeze({ HELLO: 1, BEGIN: 2, GRANT: 3, PAGE: 4, PAGE_CONSUMED: 5,
  SCOPE_FINISHED: 6, RESULT_PAGE: 7, RESULT_CONSUMED: 8, JOB_FINISHED: 9,
  CANCEL: 10, STOP: 11, STOPPED: 12, REJECT: 13 });
export const Reject = Object.freeze({ framing: 1, credit: 2, limit: 3, state: 4, identities: 5 });
export type Header = { type: number; job: bigint; lease: bigint; length: number; sequence: number };
export class CodecFailure extends Error {
  constructor(readonly code: number) { super('connect_codec_rejected'); }
}
export const requireCodec: (condition: unknown, code?: number) => asserts condition = (condition, code = Reject.state) => {
  if (!condition) throw new CodecFailure(code);
};
export function headerBytes(header: Header, target: Uint8Array = new Uint8Array(HEADER_BYTES)): Uint8Array {
  const view = new DataView(target.buffer, target.byteOffset, HEADER_BYTES);
  view.setUint32(0, 0x4d434631); view.setUint16(4, 1); view.setUint8(6, header.type); view.setUint8(7, 0);
  view.setBigUint64(8, header.job); view.setBigUint64(16, header.lease);
  view.setUint32(24, header.length); view.setUint32(28, header.sequence);
  return target;
}
const retryable = (error: NodeJS.ErrnoException | null) => error?.code === 'EAGAIN' || error?.code === 'EINTR';
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1));

/** One outstanding fd read into a caller-owned view; no stream or read-ahead queue. */
export class FrameReader {
  private readonly header = new Uint8Array(HEADER_BYTES);
  private readonly scratch = new Uint8Array(PAGE_BYTES);
  constructor(readonly fd: number) {}
  async exact(buffer: Uint8Array, length: number): Promise<void> {
    requireCodec(length <= buffer.byteLength, Reject.limit);
    let offset = 0;
    while (offset < length) {
      const count = await new Promise<number>((resolve, reject) => {
        read(this.fd, buffer, offset, length - offset, null, (error, bytesRead) => {
          if (retryable(error)) resolve(-1);
          else if (error) reject(new CodecFailure(Reject.framing));
          else resolve(bytesRead);
        });
      });
      if (count < 0) { await pause(); continue; }
      requireCodec(count > 0 && count <= length - offset, Reject.framing);
      offset += count;
    }
  }
  async next(validate: (header: Header) => void): Promise<{ header: Header; payload: Uint8Array }> {
    await this.exact(this.header, HEADER_BYTES);
    const view = new DataView(this.header.buffer);
    requireCodec(view.getUint32(0) === 0x4d434631 && view.getUint16(4) === 1 && view.getUint8(7) === 0, Reject.framing);
    const header = { type: view.getUint8(6), job: view.getBigUint64(8), lease: view.getBigUint64(16),
      length: view.getUint32(24), sequence: view.getUint32(28) };
    requireCodec(header.type >= 1 && header.type <= 13, Reject.framing);
    requireCodec(header.length <= (header.type === Frame.PAGE || header.type === Frame.RESULT_PAGE ? PAGE_BYTES : CONTROL_BYTES), Reject.limit);
    // Includes direction, identities, phase, grant and sequence checks, before payload I/O.
    validate(header);
    await this.exact(this.scratch, header.length);
    return { header, payload: this.scratch.subarray(0, header.length) };
  }
}

/** Await every partial write. Only its caller may release the borrowed payload. */
export class FrameWriter {
  private readonly header = new Uint8Array(HEADER_BYTES);
  constructor(readonly fd: number) {}
  async bytes(buffer: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = await new Promise<number>((resolve, reject) => {
        write(this.fd, buffer, offset, buffer.byteLength - offset, null, (error, written) => {
          if (retryable(error)) resolve(-1);
          else if (error) reject(new CodecFailure(Reject.framing));
          else resolve(written);
        });
      });
      if (count < 0) { await pause(); continue; }
      requireCodec(count > 0 && count <= buffer.byteLength - offset, Reject.framing);
      offset += count;
    }
  }
  async send(type: number, job: bigint, lease: bigint, sequence = 0, payload: Uint8Array = EMPTY): Promise<void> {
    requireCodec(payload.byteLength <= (type === Frame.RESULT_PAGE || type === Frame.PAGE ? PAGE_BYTES : CONTROL_BYTES), Reject.limit);
    await this.bytes(headerBytes({ type, job, lease, sequence, length: payload.byteLength }, this.header));
    await this.bytes(payload);
  }
}
export const EMPTY = new Uint8Array(0);
export const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes;
};
export const nextSequence = (value: number): number => {
  requireCodec(value < 0xffff_ffff, Reject.state); return value + 1;
};
