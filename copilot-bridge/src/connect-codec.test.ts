import { describe, expect, it } from 'bun:test';
import { closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CodecParent, beginBytes, grantBytes } from './connect-codec.testSupport';
import { codecVectors, metadataVectors } from './connect-codec-vectors.testSupport';
import { Frame, Reject, headerBytes, RAW_UNITS, BANK_UNITS, BODY_BYTES, nextSequence, u32 } from './connect-codec-framing';
import { measureClosed, ControlBank, copyClosed } from './connect-codec-values';
import { bodyDescriptor, validatorSlots, refuseLegacyContent } from './connect-codec-operations';

const local = process.platform === 'win32' ? it.skip : it;
const value = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
const withParent = async (run: (parent: CodecParent) => Promise<void>) => {
  const parent = await CodecParent.create();
  try { await run(parent); } finally { await parent.cleanup(); }
};

describe('persistent private Bun codec', () => {
  local('runs all nine canonical operations and maximum metadata paths in the same PID with real credits', async () => {
    await withParent(async p => {
      const pid = p.process.pid;
      const metrics: Record<string, unknown>[] = [];
      const vectors = [...codecVectors(true), ...metadataVectors()];
      for (const vector of vectors) {
        const result = await p.run(vector.op, vector.facts, vector.body, { fragmentHeader: vector.op === 1 });
        try {
          expect(result.status, vector.name).toBe(0);
          expect(result.value, vector.name).toBeDefined();
          expect(p.process.pid).toBe(pid);
          const facts = measureClosed(vector.facts), returned = measureClosed(result.value);
          const slots = validatorSlots(vector.op, vector.facts);
          expect(1 + slots).toBeLessThanOrEqual(8);
          metrics.push({ name: vector.name, factsUnits: facts.units, factsBytes: facts.jsonBytes,
            resultUnits: returned.units, resultBytes: returned.jsonBytes, validatorGraphSlots: slots,
            bodyAdmission: bodyDescriptor(vector.op).units });
        } finally { result.dispose(); }
      }
      // Maximum JSON escaping, independently of the maximum raw-byte vector above.
      const ack = codecVectors(true)[6]!;
      const text = '\\'.repeat(47_103);
      ack.facts.chunk.data_utf8 = text; ack.facts.chunk.length = String(text.length);
      ack.facts.chunk.sha256 = createHash('sha256').update(text).digest('hex');
      Object.assign(ack.body, { length: String(text.length), next_offset: String(text.length), sha256: ack.facts.chunk.sha256 });
      const escaped = await p.run(7, ack.facts, ack.body);
      expect(escaped.status).toBe(0); escaped.dispose();
      metrics.push({ name: 'ack.maximum-json-escaping', facts: measureClosed(ack.facts), validatorGraphSlots: validatorSlots(7, ack.facts) });
      expect(p.budget.rawPeak).toBe(1);
      expect(p.budget.peak).toBeLessThanOrEqual(32 * 1024 * 1024);
      console.log('codec_maximum_vectors', JSON.stringify({ vectors: metrics, parentPeak: p.budget.peak }));
      expect(await p.finish()).toBe('');
    });
  }, 30_000);

  local('rejects independent mismatches and malformed JSON, then validates a healthy job with clean canonical diagnostics', async () => {
    await withParent(async p => {
      const challenge = metadataVectors().find(v => v.name === 'reply.challenge')!;
      challenge.facts.exchange.subject_digest = 'f'.repeat(64);
      const mismatch = await p.run(challenge.op, challenge.facts, challenge.body);
      expect(mismatch.status).toBe(1); expect(mismatch.value).toBeUndefined(); mismatch.dispose();
      const ack = codecVectors()[6]!;
      const text = 'y'.repeat(Number(ack.facts.chunk.length));
      ack.facts.chunk.data_utf8 = text; ack.facts.chunk.sha256 = createHash('sha256').update(text).digest('hex');
      const wrongChunk = await p.run(7, ack.facts, ack.body);
      expect(wrongChunk.status).toBe(1); wrongChunk.dispose();
      const healthy = codecVectors()[8]!;
      for (const rawBody of [new TextEncoder().encode('{"type":"transit.open","type":"transit.open"}'), new Uint8Array([0xc0, 0xaf])]) {
        const malformed = await p.run(9, healthy.facts, null, { rawBody });
        expect(malformed.status).toBe(1); malformed.dispose();
      }
      const unknown = await p.run(9, { ...healthy.facts, secrets: ['synthetic-not-an-accepted-field'] }, healthy.body, { factsRejected: true });
      expect(unknown.status).toBe(1); unknown.dispose();
      const final = await p.run(9, healthy.facts, healthy.body);
      expect(final.status).toBe(0); final.dispose();
      expect(await p.finish()).toBe('');
    });
  });

  local('keeps errors as validated protocol results and expires authority while pages wait', async () => {
    await withParent(async p => {
      const authority = codecVectors()[1]!;
      authority.facts.time.dispatch_age_ms = 29_990;
      const expired = await p.run(2, authority.facts, authority.body, { pageSize: 64, delayPages: 3 });
      expect(expired.status).toBe(1); expired.dispose();
      const metadata = codecVectors()[3]!;
      const body = { transit_contract: 'transfer-transit-1', type: 'error', request_id: metadata.body.request_id, code: 'unavailable', retryable: true };
      const failure = await p.run(4, metadata.facts, body);
      expect(failure.status).toBe(0); expect(failure.value.type).toBe('error'); failure.dispose();
      expect(await p.finish()).toBe('');
    });
  });

  local('delegates unconfirmed v2 before body loading and validates canonical empty polls without a fake content owner', async () => {
    await withParent(async p => {
      const poll = codecVectors()[4]!;
      poll.facts.context.confirmed = null;
      const delegated = await p.run(5, poll.facts, undefined);
      expect(delegated.status).toBe(3); expect(delegated.value).toBeUndefined(); delegated.dispose();
      poll.facts.context.response_status = 204;
      const empty = await p.run(5, poll.facts, undefined);
      expect(empty.status).toBe(0); expect(empty.value).toEqual({ branch: 'empty', value: null }); empty.dispose();
      expect(await p.finish()).toBe('');
    });
  });

  local('retains the output bank through a delayed ACK and CANCEL, then joins before releasing startup/pipe charges', async () => {
    await withParent(async p => {
      const vector = codecVectors(true)[5]!;
      await p.valuePhase(6, 1, vector.facts, vector.facts);
      await p.valuePhase(6, 2, vector.body, vector.facts);
      const first = await p.receive();
      expect(first.header.type).toBe(Frame.RESULT_PAGE);
      expect(first.header.sequence).toBe(0); expect(first.header.length).toBe(65_536);
      await Bun.sleep(10);
      expect(p.assertNoOutput()).toBe(true);
      expect(p.budget.live.has(`bank:${p.control}`)).toBe(true);
      await p.send(Frame.CANCEL);
      const terminal = await p.receive();
      expect(terminal.header.type).toBe(Frame.JOB_FINISHED); expect(value(terminal.payload)).toBe(2);
      expect(p.budget.live.has(`bank:${p.control}`)).toBe(true);
      p.release(`bank:${p.control}`);
      expect(await p.finish(true)).toBe('');
      expect(p.budget.used).toBe(0);
    });
  });

  local('keeps a cancelled output write alive until the parent drains the pipe', async () => {
    await withParent(async p => {
      const vector = codecVectors(true)[5]!;
      await p.valuePhase(6, 1, vector.facts, vector.facts);
      await p.valuePhase(6, 2, vector.body, vector.facts);
      // The 32-byte header plus 64KiB page cannot finish in the host's bounded FIFO.
      // Do not consume either until CANCEL has reached the independent read side.
      await p.send(Frame.CANCEL); await Bun.sleep(10);
      expect(p.process.exitCode).toBeNull();
      expect(p.budget.live.has(`bank:${p.control}`)).toBe(true);
      const page = await p.receive(); expect(page.header.type).toBe(Frame.RESULT_PAGE);
      expect(page.header.length).toBe(65_536);
      const terminal = await p.receive();
      expect(terminal.header.type).toBe(Frame.JOB_FINISHED); expect(value(terminal.payload)).toBe(2);
      p.release(`bank:${p.control}`); expect(await p.finish(true)).toBe('');
    });
  });

  local('cancels a raw read without a private result and keeps the raw charge until SCOPE_FINISHED', async () => {
    await withParent(async p => {
      p.job = 1n; p.control = 1n; p.raw = 2n; p.lease = 2n;
      p.own('bank:1', BANK_UNITS); p.own('raw:2', RAW_UNITS);
      await p.send(Frame.BEGIN, beginBytes(9, 1, 100));
      await p.send(Frame.GRANT, grantBytes(BANK_UNITS, 2, BODY_BYTES), p.job, p.control);
      await p.send(Frame.GRANT, grantBytes(RAW_UNITS, 1, BODY_BYTES), p.job, p.raw);
      await p.send(Frame.CANCEL);
      const scope = await p.receive(); expect(scope.header.type).toBe(Frame.SCOPE_FINISHED); expect(value(scope.payload)).toBe(1);
      expect(p.budget.live.has('raw:2')).toBe(true); p.release('raw:2');
      const terminal = await p.receive(); expect(terminal.header.type).toBe(Frame.JOB_FINISHED); expect(value(terminal.payload)).toBe(2);
      p.release('bank:1'); expect(await p.finish(true)).toBe('');
    });
  });

  for (const kind of ['hostile-length', 'wrong-direction', 'no-credit', 'truncated-header', 'truncated-payload', 'replayed-job', 'replayed-lease', 'wrong-grant'] as const) {
    local(`closes ${kind} without draining an unadmitted payload`, async () => {
      await withParent(async p => {
        if (kind === 'replayed-job') {
          const v = codecVectors()[8]!; const done = await p.run(9, v.facts, v.body); done.dispose();
          await p.send(Frame.BEGIN, beginBytes(9, 1, 1));
        } else if (kind === 'hostile-length' || kind === 'wrong-direction') {
          await p.writer.bytes(headerBytes({ type: kind === 'hostile-length' ? Frame.BEGIN : Frame.RESULT_PAGE,
            job: 1n, lease: 0n, sequence: 0, length: kind === 'hostile-length' ? 0xffff_ffff : 1 }));
        } else if (kind === 'truncated-header') {
          await p.writer.bytes(headerBytes({ type: Frame.BEGIN, job: 1n, lease: 0n, sequence: 0, length: 8 }).subarray(0, 17));
          closeSync(p.inputFd);
        } else if (kind === 'replayed-lease') {
          const v = codecVectors()[8]!;
          await p.valuePhase(9, 1, v.facts, v.facts);
          await p.send(Frame.BEGIN, beginBytes(9, 2, 1));
          await p.send(Frame.GRANT, grantBytes(RAW_UNITS, 1, BODY_BYTES), p.job, 1n);
        } else {
          p.job = 1n;
          await p.send(Frame.BEGIN, beginBytes(9, 1, 10));
          if (kind === 'no-credit') {
            await p.writer.bytes(headerBytes({ type: Frame.PAGE, job: 1n, lease: 0n, sequence: 0, length: 1 }));
          } else {
            p.control = 1n; p.raw = 2n; p.own('bank:1', BANK_UNITS); p.own('raw:2', RAW_UNITS);
            await p.send(Frame.GRANT, grantBytes(BANK_UNITS, 2, BODY_BYTES), p.job, p.control);
            await p.send(Frame.GRANT, grantBytes(RAW_UNITS - (kind === 'wrong-grant' ? 1 : 0), 1, BODY_BYTES), p.job, p.raw);
            if (kind === 'truncated-payload') {
              await p.writer.bytes(headerBytes({ type: Frame.PAGE, job: 1n, lease: 2n, sequence: 0, length: 10 }));
              await p.writer.bytes(new Uint8Array(5)); closeSync(p.inputFd);
            }
          }
        }
        const rejected = await p.receive();
        expect(rejected.header.type).toBe(Frame.REJECT);
        expect(value(rejected.payload)).toBe(kind === 'hostile-length' ? Reject.limit : kind === 'no-credit' || kind === 'replayed-lease' || kind === 'wrong-grant' ? Reject.credit : kind.startsWith('truncated') ? Reject.framing : Reject.state);
        expect(p.budget.used).toBeGreaterThan(0);
        expect(await p.process.exited).toBe(1);
      });
    });
  }
});

describe('closed control bank admission', () => {
  it('counts nodes, keys, UTF-16 occurrences and UTF-8 separately at the exact limits', () => {
    expect(measureClosed(Array(767).fill(null)).units).toBe(196_608);
    expect(() => measureClosed(Array(768).fill(null))).toThrow();
    expect(measureClosed('x'.repeat(98_176)).units).toBe(196_608);
    expect(() => measureClosed('x'.repeat(98_177))).toThrow();
    expect(measureClosed('é'.repeat(49_151)).jsonBytes).toBe(98_304);
    expect(() => measureClosed('é'.repeat(49_152))).toThrow();
    expect(() => measureClosed('\ud800')).toThrow();
    const alias = { a: '🙂' };
    expect(measureClosed([alias, alias]).units).toBe(5 * 256 + 2 * 2 * (1 + 2));
    let deep: unknown = null; for (let i = 0; i < 32; i++) deep = [deep];
    expect(measureClosed(deep).nodes).toBe(33); expect(() => measureClosed([deep])).toThrow();
    let getterCalled = false;
    expect(() => measureClosed({ get value() { getterCalled = true; return 0; } })).toThrow();
    expect(getterCalled).toBe(false);
    const cycle: unknown[] = []; cycle.push(cycle); expect(() => measureClosed(cycle)).toThrow();
    expect(() => nextSequence(0xffff_ffff)).toThrow();
  });
  it('refuses unexpected legacy content ports', () => { expect(() => refuseLegacyContent()).toThrow('validation_failed'); });
  it('owns and releases copies without aliases, refuses repeated slot ownership and overcommit', () => {
    const bank = new ControlBank(), source = { nested: { text: 'synthetic' } };
    const copy = copyClosed(source, bank, 'expected'); source.nested.text = 'changed';
    expect(copy.value).toEqual({ nested: { text: 'synthetic' } });
    expect(() => bank.graphs('expected', 1)).toThrow();
    const rest = bank.graphs('temporaries', 7); expect(() => bank.graphs('extra', 1)).toThrow();
    rest(); copy.release(); expect(bank.empty()).toBe(true);
  });
});

describe('private authenticated session response', () => {
  local('validates exact /me with shared A1, independent correlations, expiry and reusable clean diagnostics', async () => {
    await withParent(async p => {
      const requestId = '11111111-1111-4111-8111-111111111111';
      const facts = { method: 'GET', path: '/pilot/v1/me', request_id_header: requestId,
        response_request_id_header: requestId, expected_origin: 'https://relay.example.invalid',
        connection_origin: 'https://relay.example.invalid', session_id: 'session:synthetic:a',
        account_id: 'account:synthetic', device_id: 'device:synthetic', now_ms: Date.parse('2026-10-24T12:00:00Z') };
      const body = { transport_version: '1.0', account: { contract_version: '1.0', type: 'account',
        account_id: facts.account_id, identity: { provider: 'github', subject: 'synthetic', login: 'synthetic' }, revision: 1 },
        device_session: { contract_version: '1.0', type: 'device_session',
          ref: { type: 'session', account_id: facts.account_id, session_id: facts.session_id },
          device_id: facts.device_id, state: 'active', issued_at: '2026-10-24T00:00:00Z',
          expires_at: '2026-10-25T00:00:00Z', revision: 1 } };
      for (const mutate of [
        (v: any) => { v.device_session.ref.session_id = 'session:synthetic:b'; },
        (v: any) => { v.device_session.ref.account_id = 'account:other'; },
        (v: any) => { v.device_session.device_id = 'device:other'; },
        (v: any) => { v.device_session.state = 'revoked'; v.device_session.revoked_at = '2026-10-24T01:00:00Z'; },
        (v: any) => { v.device_session.expires_at = '2026-10-24T11:59:59Z'; },
        (v: any) => { v.unknown = true; },
        (v: any) => { v.account.identity.avatar_url = 'https://user@example.invalid'; },
      ]) {
        const bad = structuredClone(body); mutate(bad);
        const rejected = await p.run(10, facts, bad);
        expect(rejected.status).toBe(1); expect(rejected.value).toBeUndefined(); rejected.dispose();
        const accepted = await p.run(10, facts, body);
        expect(accepted.status).toBe(0);
        expect(accepted.value.session_id).toBe(facts.session_id); accepted.dispose();
      }
      const long = structuredClone(body);
      long.device_session.issued_at = '2026-10-24T00:00:00.' + '0'.repeat(90_000) + 'Z';
      const accepted = await p.run(10, facts, long);
      expect(accepted.status).toBe(0); expect(Object.keys(accepted.value).sort()).toEqual(['account_id', 'device_id', 'expires_at_ms', 'session_id', 'session_revision']); accepted.dispose();
      const malformed = new TextEncoder().encode(JSON.stringify(body).replace('"transport_version":"1.0"', '"transport_version":"1.0","transport_version":"1.0"'));
      const duplicate = await p.run(10, facts, body, { rawBody: malformed });
      expect(duplicate.status).toBe(1); duplicate.dispose();
      const correlation = await p.run(10, { ...facts, response_request_id_header: '22222222-2222-4222-8222-222222222222' }, body, { factsRejected: true });
      expect(correlation.status).toBe(1); correlation.dispose();
      await p.finish(); expect(p.budget.used).toBe(0);
    });
  });
});
