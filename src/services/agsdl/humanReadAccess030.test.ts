import { expect, it } from 'bun:test';
import type { HumanPage030 } from '../../types/generated/ipc';
import { createHumanReadAccess030, readHumanFacts030 } from './humanReadAccess030';
import { inspectionFixture030 } from './runInspection030.testSupport';

const capture = inspectionFixture030().capture;
const scope = { systemStartId: capture.systemStartId, source: capture.source };
const request = (id: string) => ({ id, revision: '0', status: 'open', workIds: ['public-work'],
  content: { kind: 'plan' as const, plan: 'Read the synthetic sample' } });

it('checks the entire public page series without treating legacy records as true-flow facts', async () => {
  const pages: HumanPage030[] = [
    { scope, cursor: 'native', total: '65', requests: Array.from({ length: 64 }, (_, i) => request(String(i))),
      nextPage: { scope, cursor: 'native', offset: 64 } },
    { scope, cursor: 'native', total: '65', requests: [request('64')], nextPage: null },
  ];
  let calls = 0;
  const result = await readHumanFacts030(scope, async (_scope, continuation) => {
    expect(continuation?.offset ?? 0).toBe(calls * 64);
    return pages[calls++];
  });
  expect(calls).toBe(2);
  expect(result).toEqual({ kind: 'unavailable', gap: 'human-flow-projection' });
  expect(await readHumanFacts030(scope, async () => ({ ...pages[1], total: '0', requests: [] }))).toEqual({ kind: 'ready', revision: 'native', value: [] });
});

it('refuses a changed human cursor or foreign source rather than publishing partial data', async () => {
  const first: HumanPage030 = { scope, cursor: 'one', total: '65', requests: Array.from({ length: 64 }, (_, i) => request(String(i))),
    nextPage: { scope, cursor: 'one', offset: 64 } };
  await expect(readHumanFacts030(scope, async (_scope, next) => next ? { ...first, cursor: 'two', requests: [request('64')], nextPage: null } : first)).rejects.toThrow();
  await expect(readHumanFacts030(scope, async () => ({ ...first, scope: { ...scope, source: { ...scope.source, revision: 'foreign' } } }))).rejects.toThrow();
});

it('does not turn a missing legacy Stored row into an empty true-flow queue', async () => {
  expect(await readHumanFacts030(scope, async () => { throw { code: 'NOT_FOUND', message: 'Legacy snapshot absent' }; }))
    .toEqual({ kind: 'unavailable', gap: 'human-flow-projection' });
});

it('submits exact user text through the native command and reads the durable resolution', async () => {
  let closed = false, submissions = 0;
  const native = () => ({ scope, id: 'human', revision: closed ? '1' : '0', workIds: ['activation'],
    occurrences: [{ workId: 'activation', activation: { kind: 'unavailable', gap: 'human-occurrence-mapping' } }],
    content: { kind: 'flowChoice', title: 'Release?', description: '', messageJson: '{}', choices: ['publish', 'revise'] },
    state: closed ? { kind: 'resolved', receiptId: 'receipt', resolution: { receiptId: 'receipt', resolvedAtMs: '12', accepted: true,
      reason: 'person', answer: { answer: {kind: 'approval', choice: 'revise', comment: 'Écrit exactement.'}, origin: 'person', receivedAtMs: '12' } } } : {kind: 'open'},
    clock: { kind: 'available', value: { openedAtMs: '1', observedAtMs: '12', timeoutMs: '1e3', works: [] } } });
  const access = createHumanReadAccess030(scope, {
    async readExecutionSnapshot030() { return capture; },
    async readExecutionHumans030(query) { const value=native();return { scope: query, cursor: String(closed), total: '1', requests: [{ ...request('human'),revision:value.revision,flowJson:JSON.stringify(value) }], nextPage: null }; },
    async submitExecutionHuman030(input) { expect(input.answer).toEqual({kind:'approval',choice:'revise',comment:'Écrit exactement.'});submissions++;closed=true;return 'receipt'; },
  });
  expect((await access.read({scope,requestId:'human'})).clock).toMatchObject({kind:'available',value:{timeoutMs:'1000'}});
  expect(await access.submit({scope,requestId:'human',expectedRevision:'0',answer:{kind:'approval',choice:'revise',comment:'Écrit exactement.'}})).toMatchObject({kind:'received',receipt:{revision:'1',state:{kind:'resolved'}}});
  expect(submissions).toBe(1);
  await expect(access.read({scope:{...scope,systemStartId:'foreign'},requestId:'human'})).rejects.toMatchObject({code:'SCOPE_INVALID'});
});

it('rejects a foreign capture before attempting human readback', async () => {
  let reads = 0;
  const access = createHumanReadAccess030(scope, {
    async readExecutionSnapshot030() { return { ...capture, source: { ...capture.source, revision: 'different' } }; },
    async readExecutionHumans030(query) { reads++; return { scope: query, cursor: '', total: '0', requests: [], nextPage: null }; },
  });
  await expect(access.read({ scope, requestId: 'human' })).rejects.toMatchObject({ code: 'CORRELATION' });
  expect(reads).toBe(0);
});

it('narrows a runtime scope to the human IPC contract before reading a request', async () => {
  const runtimeScope = { ...scope, snapshotId: 'captured-runtime' };
  const value = { scope, id: 'human', revision: '0', workIds: ['activation'], occurrences: [],
    content: { kind: 'flowChoice', title: 'Continue?', description: '', messageJson: '{}', choices: ['continue'] },
    state: { kind: 'open' }, clock: { kind: 'unavailable', gap: 'human-clock-observation' } };
  const access = createHumanReadAccess030(runtimeScope, {
    async readExecutionSnapshot030() { return capture; },
    async readExecutionHumans030(query) {
      // Tauri rejects extra fields, even when TypeScript accepts the subtype.
      expect(query).toEqual(scope);
      return { scope: query, cursor: 'native', total: '1', requests: [{ ...request('human'), flowJson: JSON.stringify(value) }], nextPage: null };
    },
  });
  expect((await access.read({ scope, requestId: 'human' })).id).toBe('human');
});
