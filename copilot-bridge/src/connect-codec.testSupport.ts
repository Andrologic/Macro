import { constants, openSync, closeSync, readFileSync, readSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import transitManifest from '../../contracts/macro-pilot/v2/transfer-transit/transfer-transit-contract.json';
import a1Manifest from '../../src/services/macroPilot/schemaValidators.identity.json';
import authorityManifest from '../../contracts/macro-pilot/v2/transfer-authority/transfer-authority-contract.json';
import { IDENTITIES } from '../../contracts/macro-pilot/v2/transfer-transit/identities.generated.mjs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Frame, FrameReader, FrameWriter, headerBytes, u32, RAW_UNITS, BANK_UNITS, BODY_BYTES, type Header } from './connect-codec-framing';
import { bodyDescriptor, type Opcode } from './connect-codec-operations';

export const repository = resolve(import.meta.dir, '../..');
export class ParentBudget {
  readonly live = new Map<string, number>();
  peak = 0;
  rawPeak = 0;
  acquire(name: string, units: number): () => void {
    if (this.live.has(name) || units < 0 || this.used + units > 32 * 1024 * 1024) throw Error('parent_resource_limit');
    if (name.startsWith('raw:') && [...this.live.keys()].some(key => key.startsWith('raw:'))) throw Error('two_raw_scopes');
    this.live.set(name, units); this.peak = Math.max(this.peak, this.used);
    this.rawPeak = Math.max(this.rawPeak, [...this.live.keys()].filter(key => key.startsWith('raw:')).length);
    let held = true;
    return () => { if (!held || !this.live.delete(name)) throw Error('double_release'); held = false; };
  }
  get used(): number { return [...this.live.values()].reduce((sum, value) => sum + value, 0); }
}
export const beginBytes = (op: number, phase: number, length: number) => {
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  view.setUint16(0, op); view.setUint8(2, phase); view.setUint32(4, length); return bytes;
};
export const grantBytes = (units: number, kind: number, limit: number) => {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(units)); view.setUint32(8, kind); view.setUint32(12, limit); return bytes;
};
const assert: (condition: unknown, code: string) => asserts condition = (condition, code) => { if (!condition) throw Error(code); };
export class CodecParent {
  readonly reader: FrameReader;
  readonly writer: FrameWriter;
  readonly budget: ParentBudget;
  readonly frames: Header[] = [];
  readonly releases = new Map<string, () => void>();
  job = 0n; lease = 0n; control = 0n; raw = 0n;
  private closed = false;
  private readonly startup: () => void;
  constructor(readonly process: ReturnType<typeof Bun.spawn>, readonly directory: string, readonly inputFd: number,
    readonly outputFd: number, readonly stderrPath: string, budget: ParentBudget, startup: () => void) {
    this.reader = new FrameReader(outputFd); this.writer = new FrameWriter(inputFd);
    // Child/parent fixed fd buffers, two bounded POSIX pipe reservoirs, startup identity work and stderr.
    this.budget = budget; this.startup = startup;
  }
  static async create(entry = resolve(import.meta.dir, 'entry.ts'), guard = true, native = false): Promise<CodecParent> {
    const budget = new ParentBudget();
    const startup = budget.acquire('startup-and-pipes', 8 * 65_536);
    // Admitted before callers construct synthetic input facts/body. Held through join.
    const module = budget.acquire('a1-module', a1Manifest.retained_units);
    const inputs = budget.acquire('parent-input-graphs-and-serialization', 6 * BODY_BYTES);
    const dir = await mkdtemp(join(tmpdir(), 'macro-codec-'));
    const pipe = (name: string) => {
      const path = join(dir, name);
      assert(spawnSync('mkfifo', ['-m', '600', path]).status === 0, 'mkfifo');
      const bootstrap = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
      const read = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const write = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
      return { bootstrap, read, write };
    };
    const input = pipe('input'), output = pipe('output');
    const stderrPath = join(dir, 'stderr');
    const stderr = openSync(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const args = native ? [] : [globalThis.process.execPath];
    if (guard) args.push('--preload', resolve(import.meta.dir, 'connect-codec-import-guard.testSupport.ts'));
    args.push(entry, 'connect-codec');
    const child = Bun.spawn(args, { cwd: repository, stdin: input.read, stdout: output.write, stderr,
      env: { NODE_ENV: 'test' } });
    for (const fd of [input.bootstrap, input.read, output.bootstrap, output.write, stderr]) closeSync(fd);
    const parent = new CodecParent(child, dir, input.write, output.read, stderrPath, budget, startup);
    parent.releases.set('parent-input-graphs-and-serialization', inputs);
    parent.releases.set('a1-module', module);
    try {
      const hello = await parent.receive();
      assert(hello.header.type === Frame.HELLO && hello.header.job === 0n && hello.header.lease === 0n, 'hello');
      const identity = JSON.parse(new TextDecoder().decode(hello.payload));
      const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
      const expected = { version: 'macro-connect-codec-1', content_sha256: IDENTITIES.content_contract_sha256,
        decision_resource_set_sha256: IDENTITIES.decision_resource_set_sha256,
        transit_resource_set_sha256: digest(transitManifest.resources), authority_resource_set_sha256: digest(authorityManifest.resources), a1_resource_set_sha256: digest(a1Manifest.resources) };
      assert(Object.keys(identity).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => identity[key] === value), 'hello_identities');
      return parent;
    } catch (error) { await parent.cleanup(); throw error; }
  }
  async receive() {
    const frame = await this.reader.next(header => {
      assert([Frame.HELLO, Frame.PAGE_CONSUMED, Frame.SCOPE_FINISHED, Frame.RESULT_PAGE, Frame.JOB_FINISHED, Frame.STOPPED, Frame.REJECT].some(type => type === header.type), 'child_direction');
    });
    this.frames.push({ ...frame.header });
    return frame; // Borrowed parent scratch, consumed before the next receive.
  }
  own(name: string, units: number) { this.releases.set(name, this.budget.acquire(name, units)); }
  release(name: string) { const release = this.releases.get(name); assert(release, 'missing_lease'); release(); this.releases.delete(name); }
  async send(type: number, payload: Uint8Array = new Uint8Array(0), job = this.job, lease = 0n, sequence = 0) {
    await this.writer.send(type, job, lease, sequence, payload);
  }
  async phase(op: Opcode, phase: 1 | 2, bytes: Uint8Array, facts: Record<string, any>, options: { fragmentHeader?: boolean; delayPages?: number; pageSize?: number } = {}) {
    const descriptor = phase === 1 ? { units: RAW_UNITS, limit: BODY_BYTES } : bodyDescriptor(op, facts);
    if (phase === 1) { this.job++; this.control = ++this.lease; this.own(`bank:${this.control}`, BANK_UNITS); }
    this.raw = ++this.lease; this.own(`raw:${this.raw}`, descriptor.units);
    await this.send(Frame.BEGIN, beginBytes(op, phase, bytes.byteLength));
    if (phase === 1) await this.send(Frame.GRANT, grantBytes(BANK_UNITS, 2, BODY_BYTES), this.job, this.control);
    await this.send(Frame.GRANT, grantBytes(descriptor.units, 1, descriptor.limit), this.job, this.raw);
    let offset = 0, sequence = 0;
    while (offset < bytes.byteLength) {
      const page = bytes.subarray(offset, Math.min(offset + (options.pageSize ?? 65_536), bytes.byteLength));
      if (options.fragmentHeader) {
        const header = headerBytes({ type: Frame.PAGE, job: this.job, lease: this.raw, sequence, length: page.byteLength });
        for (const byte of header) await this.writer.bytes(new Uint8Array([byte]));
        await this.writer.bytes(page);
      } else await this.send(Frame.PAGE, page, this.job, this.raw, sequence);
      const ack = await this.receive();
      assert(ack.header.type === Frame.PAGE_CONSUMED && ack.header.job === this.job && ack.header.lease === this.raw && ack.header.sequence === sequence && ack.header.length === 0, 'page_ack');
      offset += page.byteLength; sequence++;
      if (options.delayPages) await Bun.sleep(options.delayPages);
    }
    const scope = await this.receive();
    assert(scope.header.type === Frame.SCOPE_FINISHED && scope.header.lease === this.raw && scope.header.job === this.job && new DataView(scope.payload.buffer, scope.payload.byteOffset).getUint32(0) === phase, 'scope_finished');
    this.release(`raw:${this.raw}`); this.raw = 0n;
  }
  async valuePhase(op: Opcode, phase: 1 | 2, value: unknown, facts: Record<string, any>, options: { fragmentHeader?: boolean; delayPages?: number; pageSize?: number } = {}, raw?: Uint8Array) {
    this.own('parent-input-bytes', BODY_BYTES);
    let bytes: Uint8Array | undefined;
    try {
      bytes = raw ?? (value === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(value)));
      assert(bytes.byteLength <= BODY_BYTES, 'parent_input_size');
      await this.phase(op, phase, bytes, facts, options);
    } finally { bytes = undefined; this.release('parent-input-bytes'); }
  }
  async run(op: Opcode, facts: Record<string, any>, body: unknown, options: { fragmentHeader?: boolean; delayPages?: number; pageSize?: number; factsRejected?: boolean; rawBody?: Uint8Array } = {}) {
    await this.valuePhase(op, 1, facts, facts, options);
    this.own('parent-result-buffer', BODY_BYTES);
    const resultBytes = new Uint8Array(BODY_BYTES);
    if (!options.factsRejected) {
      await this.valuePhase(op, 2, body, facts, options, options.rawBody);
    }
    let length = 0, sequence = 0;
    while (true) {
      const next = await this.receive();
      assert(next.header.job === this.job && next.header.lease === this.control, 'result_identity');
      if (next.header.type === Frame.JOB_FINISHED) {
        const status = new DataView(next.payload.buffer, next.payload.byteOffset).getUint32(0);
        this.release(`bank:${this.control}`);
        let value: any;
        if (length) {
          this.own('parent-retained-result', 3 * BODY_BYTES + 196_608);
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(resultBytes.subarray(0, length)));
        }
        this.release('parent-result-buffer');
        return { status, value, dispose: () => { if (length) { length = 0; this.release('parent-retained-result'); } } };
      }
      assert(next.header.type === Frame.RESULT_PAGE && next.header.sequence === sequence && length + next.header.length <= BODY_BYTES, 'result_page');
      resultBytes.set(next.payload, length); length += next.payload.byteLength;
      await this.send(Frame.RESULT_CONSUMED, undefined, this.job, this.control, sequence++);
    }
  }
  assertNoOutput(): boolean {
    try { const bytes = new Uint8Array(1); return readSync(this.outputFd, bytes, 0, 1, null) === 0; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EAGAIN'; }
  }
  async finish(cancelled = false): Promise<string> {
    if (!cancelled) { await this.send(Frame.STOP, undefined, 0n); const stopped = await this.receive(); assert(stopped.header.type === Frame.STOPPED, 'stopped'); }
    const code = await this.process.exited;
    assert(code === 0, 'child_exit');
    const stderr = readFileSync(this.stderrPath, 'utf8');
    await this.cleanup();
    return stderr;
  }
  async cleanup() {
    if (this.closed) return;
    this.closed = true;
    if (this.process.exitCode === null) this.process.kill();
    await this.process.exited; // Neither a timeout nor a counter reset substitutes for join.
    try { closeSync(this.inputFd); } catch { /* Already closed by an EOF test. */ }
    closeSync(this.outputFd);
    for (const release of this.releases.values()) release();
    this.releases.clear(); this.startup();
    assert(this.budget.used === 0, 'parent_leak');
    await rm(this.directory, { recursive: true, force: true });
  }
}
