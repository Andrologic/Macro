import { constants, openSync, closeSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Frame, FrameReader, FrameWriter, type Header } from './connect-codec-framing';
import { PortableWorkBudget } from '../../src/services/ai/portableHistoryInspection';
import { portableDigest, type PortableRecord, type RawHistoryField, type RawHistoryRow } from '../../src/services/ai/portableChatHistory';
import type { PortableArchiveFragment } from '../../src/services/ai/portableHistoryArchive';
import { TRANSFER_HELLO } from './connect-transfer-identities.generated';
import { decodeControl, encodeControl, validateHello, validateStart, validateRequest, validateResponse, grantBytes, type Start, type Facts } from './connect-transfer-protocol';
import { CONTROL_RESERVE, integer, decimal, ensure, measureValue, secretQuote, sum } from './connect-transfer-values';
import { DATA_CREDIT } from './connect-transfer-client';

export const repository = resolve(import.meta.dir, '../..');
export class TransferParent {
  readonly reader: FrameReader;
  readonly writer: FrameWriter;
  frameCount = 0;
  sentPages = 0;
  finalResult: Facts | undefined;
  readonly retained: { kind: string; value: any }[] = [];
  readonly records: { header: PortableRecord; bytes: Uint8Array }[] = [];
  readonly release: (() => void)[] = [];
  readonly data = new Map<string, Map<number, Uint8Array>>();
  readonly roots = new Map<string, Facts>();
  fields: RawHistoryField[] = [];
  relations: Facts[] = [];
  fragments: PortableArchiveFragment[] = [];
  readonly starts: Start[] = [];
  lastCall = 0n; lease = 1n; readonly job = 1n;
  control = 0n;
  appended = 0;
  draftHeld = 0;
  pageSize = 65_536;
  delayAck?: () => Promise<void>;
  beforeRequest?: (request: Facts, parent: TransferParent) => Promise<boolean | void>;
  transform?: (request: Facts, result: Facts) => Facts;
  private collection: { kind: string; total: number; next: number } | undefined;
  private closed = false;
  private pipesClosed = false;
  private arenaRelease: (() => void) | undefined;
  constructor(readonly process: ReturnType<typeof Bun.spawn>, readonly directory: string, readonly inputFd: number, readonly outputFd: number,
    readonly stderrPath: string, readonly budget: PortableWorkBudget, releaseStartup: () => void) {
    this.reader = new FrameReader(outputFd); this.writer = new FrameWriter(inputFd); this.release.push(releaseStartup);
  }
  static async create(budget: PortableWorkBudget): Promise<TransferParent> {
    const release = budget.reserve(2 * CONTROL_RESERVE + 8 * 65_536);
    const directory = await mkdtemp(join(tmpdir(), 'macro-transfer-'));
    const fifo = (name: string) => {
      const path = join(directory, name); ensure(spawnSync('mkfifo', ['-m', '600', path]).status === 0);
      const bootstrap = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
      return { bootstrap, read: openSync(path, constants.O_RDONLY | constants.O_NONBLOCK), write: openSync(path, constants.O_WRONLY | constants.O_NONBLOCK) };
    };
    const input = fifo('input'), output = fifo('output');
    const stderrPath = join(directory, 'stderr'), stderr = openSync(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const executable = globalThis.process.env.MACRO_TRANSFER_TEST_EXECUTABLE;
    const command = executable ? [resolve(executable), 'connect-transfer'] : [globalThis.process.execPath,
      '--preload', resolve(import.meta.dir, 'connect-transfer-import-guard.testSupport.ts'), resolve(import.meta.dir, 'entry.ts'), 'connect-transfer'];
    const process = Bun.spawn(command, { cwd: repository, stdin: input.read, stdout: output.write, stderr, env: { NODE_ENV: 'test' } });
    for (const fd of [input.bootstrap, input.read, output.bootstrap, output.write, stderr]) closeSync(fd);
    const parent = new TransferParent(process, directory, input.write, output.read, stderrPath, budget, release);
    try {
      const hello = await parent.receive(); ensure(hello.header.type === Frame.HELLO && hello.header.job === 0n && hello.header.lease === 0n && hello.header.sequence === 0);
      const value = decodeControl(hello.payload); validateHello(value); ensure(JSON.stringify(value) === JSON.stringify(TRANSFER_HELLO));
      return parent;
    } catch (error) { await parent.cleanup(); throw error; }
  }
  async receive(validate?: (header: Header) => void) {
    const frame = await this.reader.next(header => {
      ensure([Frame.HELLO, Frame.BEGIN, Frame.PAGE, Frame.PAGE_CONSUMED, Frame.JOB_FINISHED, Frame.STOPPED, Frame.REJECT].some(type => type === header.type));
      validate?.(header);
    }); this.frameCount++; return frame;
  }
  async send(type: number, payload: Uint8Array = new Uint8Array(), lease = 0n, sequence = 0, job = this.job) { await this.writer.send(type, job, lease, sequence, payload); }
  async start(kind: Start['kind'], childUnits = 96 * 1024 * 1024, detectionUnits?: number, policyRevision = 'policy-1') {
    detectionUnits ??= secretQuote(0, 0) + 512 + 8 * policyRevision.length;
    const handles = Object.fromEntries(({ normalize: ['source', 'policy', 'sink'], import: ['staging', 'policy', 'sink'],
      prepare: ['archive', 'policy', 'target', 'draft'], recover: ['archive', 'policy', 'selector', 'sink'] }[kind]).map((name, i) => [name, String(i + 10)]));
    const start: Start = { op: 0, kind, handles, child_units: decimal(childUnits), detection_units: decimal(detectionUnits), native_units: decimal(CONTROL_RESERVE + DATA_CREDIT) };
    validateStart(start);
    // Real shared parent counter, acquired BEFORE START/GRANT. Kept until Child AND pipes are joined.
    this.arenaRelease = this.budget.reserve(sum(childUnits, detectionUnits));
    this.starts.push(start);
    await this.send(Frame.BEGIN, encodeControl(start));
    await this.send(Frame.GRANT, grantBytes({ units: sum(childUnits, detectionUnits), call: 0n, arena: 1n, limit: 0, kind: 3, direction: 0 }), 1n);
    const revision = new TextEncoder().encode(policyRevision);
    this.data.set(handles.policy, new Map([[0, revision]]));
    this.roots.set(handles.policy, { kind: 'detection', count: '0', bytes: '0', revision: { ordinal: 0, bytes: revision.length, sha256: await portableDigest(revision) } });
    return start;
  }
  source(rows: RawHistoryRow[], manifest: string, limits: readonly string[], data: Map<number, Uint8Array>) {
    const h = this.starts[0].handles.source; this.fields = rows.flatMap(row => row.fields); this.data.set(h, data);
    this.roots.set(h, { kind: 'source', manifest, limits, rows: decimal(rows.length), fields: decimal(this.fields.length), relations: decimal(this.relations.length) });
  }
  async archive(records: readonly { header: PortableRecord; bytes: Uint8Array }[]) {
    const h = this.starts[0].handles.archive;
    this.roots.set(h, { kind: 'archive', profile: 'portable_chat_history_v1', binding: { version: 1, importKey: 'b'.repeat(64), manifest: 'c'.repeat(64) },
      records: decimal(records.length), storage_revision: '1', mapping_sha256: 'd'.repeat(64) });
    for (const record of records) {
      const length = record.bytes.length;
      for (let offset = 0; offset < length || offset === 0; offset += 4093) {
        this.release.push(this.budget.reserve(8192 + Math.min(4093, length - offset)));
        this.fragments.push({ record: record.header, offset, bytes: record.bytes.subarray(offset, offset + 4093),
          targetUuid: record.header.entry.kind === 'association' ? null : `00000000-0000-4000-8000-${String(record.header.ordinal).padStart(12, '0')}` });
        if (!length) break;
      }
    }
  }
  private async grant(call: string, kind: number, direction: number): Promise<bigint> {
    const units = kind === 1 ? CONTROL_RESERVE : DATA_CREDIT;
    // These buffers are separately owned by the pre-spawn protocol reservation.
    const lease = ++this.lease;
    if (kind === 1) this.control = lease;
    await this.send(Frame.GRANT, grantBytes({ units, call: BigInt(call), arena: 1n, limit: kind === 1 ? 4096 : this.pageSize, kind, direction }), lease);
    return lease;
  }
  async response(request: Facts, result?: Facts, status = 0) {
    const value = status ? { op: request.op, call: request.call, status } : { op: request.op, call: request.call, status, result };
    validateResponse(value, request); await this.grant(request.call, 1, 1);
    await this.send(Frame.BEGIN, encodeControl(value));
  }
  async scope(request: Facts, status = 0) {
    const payload = new Uint8Array(12), v = new DataView(payload.buffer); v.setBigUint64(0, BigInt(request.call)); v.setUint32(8, status);
    await this.send(Frame.SCOPE_FINISHED, payload, this.control);
  }
  private async sending(call: string, bytes: Uint8Array) {
    const lease = await this.grant(call, 2, 1);
    for (let offset = 0, sequence = 0; offset < bytes.length; sequence++) {
      const page = bytes.subarray(offset, offset + this.pageSize); await this.send(Frame.PAGE, page, lease, sequence); this.sentPages++;
      const ack = await this.receive(); ensure(ack.header.type === Frame.PAGE_CONSUMED && ack.header.job === this.job && ack.header.lease === lease && ack.header.sequence === sequence && ack.header.length === 0);
      offset += page.length;
    }
  }
  private async receiving(request: Facts, length: number, encoded = false): Promise<Uint8Array> {
    const lease = await this.grant(request.call, 2, 2);
    let expectedHash = request.sha256;
    if (encoded) {
      const frame = await this.receive(); ensure(frame.header.type === Frame.BEGIN && frame.header.job === this.job && frame.header.lease === 0n && frame.header.sequence === 0);
      const announced = decodeControl(frame.payload); validateRequest(announced, this.starts[0].handles.policy);
      ensure(announced.op === 6 && announced.stage === 'encoded' && announced.call === request.call && announced.kind === request.kind && announced.handle === request.handle);
      ensure(integer(announced.bytes) === length); expectedHash = announced.sha256;
    }
    const bytes = new Uint8Array(length); let position = 0, sequence = 0;
    while (position < length) {
      const frame = await this.receive(header => ensure(header.type === Frame.PAGE && header.job === this.job && header.lease === lease && header.sequence === sequence && header.length > 0 && header.length <= this.pageSize && header.length <= length - position));
      bytes.set(frame.payload, position); position += frame.payload.length;
      if (this.delayAck) await this.delayAck();
      await this.send(Frame.PAGE_CONSUMED, undefined, lease, sequence++);
    }
    ensure(await portableDigest(bytes) === expectedHash); return bytes;
  }
  async run(): Promise<number> {
    while (true) {
      const frame = await this.receive(); ensure(frame.header.job === this.job && frame.header.sequence === 0);
      if (frame.header.type === Frame.JOB_FINISHED) { ensure(frame.header.lease === 1n && frame.payload.length === 4); return new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0); }
      ensure(frame.header.type === Frame.BEGIN && frame.header.lease === 0n);
      const request = decodeControl(frame.payload); validateRequest(request, this.starts[0].handles.policy); ensure(BigInt(request.call) === ++this.lastCall);
      if (this.beforeRequest && await this.beforeRequest(request, this)) continue;
      let result: Facts;
      if (request.op === 1) {
        let value: Facts | null = null, next: Facts | null = null;
        if (request.kind === 'root') { value = this.roots.get(request.handle)!; ensure(value); }
        else if (request.kind === 'field') {
          const ordinal = request.cursor ? integer(request.cursor.ordinal) : 0;
          value = this.fields[ordinal] ?? null; next = ordinal + 1 < this.fields.length ? { ordinal: decimal(ordinal + 1) } : null;
        } else if (request.kind === 'relation') {
          value = this.relations[0] ?? null;
        } else if (request.kind === 'detection') {
          const entries = [...(this.data.get(request.handle)?.entries() ?? [])].filter(([ordinal]) => ordinal > 0);
          const ordinal = request.cursor ? integer(request.cursor.ordinal) : 1;
          const entry = entries.find(([n]) => n === ordinal);
          if (entry) { value = { ordinal, bytes: entry[1].length, sha256: await portableDigest(entry[1]) }; next = entries.some(([n]) => n === ordinal + 1) ? { ordinal: decimal(ordinal + 1) } : null; }
        }
        result = { value, next };
      } else if (request.op === 2) {
        const raw = this.data.get(request.handle)?.get(integer(request.ordinal)); ensure(raw);
        const offset = integer(request.offset), page = raw.subarray(offset, offset + integer(request.max_bytes)); ensure(page.length > 0);
        result = { bytes: decimal(page.length), sha256: await portableDigest(page), next: offset + page.length === raw.length ? null : decimal(offset + page.length) };
        await this.response(request, this.transform?.(request, result) ?? result); await this.sending(request.call, page); await this.scope(request); continue;
      } else if (request.op === 3) {
        // Source plan is only an export descriptor. No synthetic SQLite begin/receipt.
        if (this.starts[0].kind === 'import' && request.stage === 'end') { await this.response(request, undefined, 5); await this.scope(request, 5); continue; }
        result = { stage: request.stage };
      } else if (request.op === 4) {
        this.release.push(this.budget.reserve(8192 + integer(request.bytes) * 2));
        const bytes = await this.receiving(request, integer(request.bytes));
        let record = this.records[request.header.ordinal];
        if (!record) { this.release.push(this.budget.reserve(request.header.bytes)); record = { header: request.header, bytes: new Uint8Array(request.header.bytes) }; this.records.push(record); }
        record.bytes.set(bytes, integer(request.offset)); this.appended++;
        result = { kind: 'export', ordinal: decimal(request.header.ordinal), next_offset: decimal(integer(request.offset) + bytes.length) };
      } else if (request.op === 5) {
        const begin = request.cursor ? this.fragments.findIndex(f => f.record.ordinal === integer(request.cursor.ordinal) && f.offset === integer(request.cursor.offset)) : 0;
        ensure(begin >= 0); const end = Math.min(this.fragments.length, begin + integer(request.limit));
        for (let index = begin; index < end; index++) {
          const fragment = this.fragments[index];
          await this.response(request, { stage: 'fragment', record: fragment.record, offset: decimal(fragment.offset), bytes: decimal(fragment.bytes.length), targetUuid: fragment.targetUuid });
          await this.sending(request.call, fragment.bytes);
        }
        const after = this.fragments[end]; result = { stage: 'end', next: after ? { ordinal: decimal(after.record.ordinal), offset: decimal(after.offset) } : null };
      } else if (request.op === 6) {
        if (request.stage === 'item') {
          ensure(this.collection);
          ensure(this.collection.kind === request.kind && integer(request.index) === this.collection.next && this.collection.next < this.collection.total);
          this.collection.next++;
          const length = integer(request.upper_json_bytes), units = integer(request.units);
          // Assembly, JSON string, parsed graph AND retained result. Held after every PAGE ACK.
          const retainedUnits = sum(4096, units, length * 4);
          this.release.push(this.budget.reserve(retainedUnits)); this.draftHeld += retainedUnits;
          const bytes = await this.receiving(request, length, true);
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          const measured = measureValue(value); ensure(measured.jsonBytes <= length && measured.units + length <= units);
          this.retained.push({ kind: request.kind, value });
          result = { stage: 'item', kind: request.kind, index: request.index };
        } else {
          if (request.stage === 'begin') { ensure(!this.collection); this.collection = { kind: request.kind, total: integer(request.total), next: 0 }; }
          else { ensure(this.collection); ensure(request.stage === 'end' && this.collection.kind === request.kind && this.collection.total === integer(request.total) && this.collection.next === this.collection.total); this.collection = undefined; }
          result = { stage: request.stage, kind: request.kind, total: request.total };
        }
      } else { this.finalResult = request.result; result = { kind: request.kind }; } // Calculation data only, never native-prepared/pin/activation.
      await this.response(request, this.transform?.(request, result) ?? result); await this.scope(request);
    }
  }
  async finish(): Promise<void> {
    ensure(await this.process.exited === 0); ensure(readFileSync(this.stderrPath, 'utf8') === '');
    closeSync(this.inputFd); closeSync(this.outputFd); this.pipesClosed = true;
    this.arenaRelease?.(); this.arenaRelease = undefined; // Only child arena. Retained records/drafts remain charged.
  }
  async cleanup(): Promise<void> {
    if (this.closed) return; this.closed = true;
    if (this.process.exitCode === null) this.process.kill(); await this.process.exited;
    if (!this.pipesClosed) { for (const fd of [this.inputFd, this.outputFd]) { try { closeSync(fd); } catch (error) { ensure((error as NodeJS.ErrnoException).code === 'EBADF'); } } this.pipesClosed = true; }
    this.arenaRelease?.(); this.arenaRelease = undefined; // Join pipes before returning ANY work credit.
    this.data.clear(); this.roots.clear(); this.fields = []; this.relations = []; this.fragments = []; this.retained.length = 0; this.records.length = 0; this.finalResult = undefined;
    for (const release of this.release.splice(0).reverse()) release();
    await rm(this.directory, { recursive: true, force: true });
  }
}
