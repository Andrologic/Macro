import { expect, test } from 'bun:test';
import { evaluateClock030 } from './clock-oracle030';
import { buildClockCorpus030 } from './clock-corpus030';
test('clock corpus contains distinct requests and every required family', () => {
  const corpus = buildClockCorpus030();
  expect(new Set(corpus.cases.map(c => JSON.stringify(c.request))).size).toBe(corpus.cases.length);
  for (const [family, minimum] of Object.entries(corpus.minimums)) expect(corpus.cases.filter(c => c.family === family).length).toBeGreaterThanOrEqual(minimum);
});
test('direct clock oracle exposes a persistent state after an error', async () => {
  const raw = await evaluateClock030({ op: 'clock', json: JSON.stringify({ timeoutMs: '100', nowMs: '0', steps: [{ op: 'advance', nowMs: '30' }, { op: 'advance', nowMs: '29' }, { op: 'snapshot' }] }) });
  const result = JSON.parse(JSON.parse(raw).json);
  expect(result.steps[1].result).toMatchObject({ status: 'failure', code: 'CORRELATION' });
  expect(result.steps[2].snapshot.elapsedMachineMs).toBe('30');
});
test('clock branch reports malformed internal data before route content', async () => {
  const result = await evaluateClock030({ op: 'broker', json: JSON.stringify({ job: { generation: 'generation', inputJson: JSON.stringify({ operation: 'humanClock', input: null, contentReceipts: false }) } }) });
  expect(JSON.parse(JSON.parse(result).json)).toEqual({ kind: 'failed', code: 'ROUTE_PREPARATION_FAILED', pointer: '' });
});
