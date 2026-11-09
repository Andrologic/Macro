import { expect, it } from 'bun:test';
import type { HumanPage030 } from '../../types/generated/ipc';
import { createHumanReadAccess030, readHumanFacts030, submitHumanUnqualified030 } from './humanReadAccess030';
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
  expect(await readHumanFacts030(scope, async () => ({ ...pages[1], total: '0', requests: [] }))).toEqual(result);
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

it('provides a closed submit and exact-scope read for the lot 8 client', async () => {
  let reads = 0;
  const access = createHumanReadAccess030(scope, {
    async readExecutionSnapshot030() { return capture; },
    async readExecutionHumans030(query) { reads++; return { scope: query, cursor: 'native', total: '1', requests: [request('human')], nextPage: null }; },
  });
  await expect(access.read({ scope, requestId: 'human' })).rejects.toMatchObject({ code: 'DTO_UNAVAILABLE',
    details: { kind: 'unavailable', gap: 'human-flow-projection' } });
  const before = reads;
  await expect(access.read({ scope: { ...scope, systemStartId: 'other' }, requestId: 'human' })).rejects.toMatchObject({ code: 'SCOPE_INVALID' });
  expect(reads).toBe(before);
  const result = await access.submit({ scope, requestId: 'human', expectedRevision: '0', answer: { kind: 'decision', decision: 'yes', comment: '' } });
  expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'CONTRACT_UNSUPPORTED', message: expect.stringContaining('non qualifié') } });
  expect(reads).toBe(before);
  expect(access.submit).toBe(submitHumanUnqualified030);
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
