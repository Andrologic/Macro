import { expect, test, spyOn } from 'bun:test';
import { createProducerFixture, runProducerRecipe } from './connect-producer-fixture';
import { projectProducerSamples, producerSourceFingerprint } from './connect-producer';
import { contractHashes, validateReport } from '../../contracts/macro-connect/metrics/v1/validate.mjs';
import { profiles } from '../../contracts/macro-connect/metrics/v1/fixtures.mjs';

const provenance = () => ({ repositories: { desktop: 'a'.repeat(40), mobile: 'b'.repeat(40), relay: 'c'.repeat(40) }, measured_repository: 'desktop', dirty: false,
  source_sha256: producerSourceFingerprint(), ...contractHashes(), lock_sha256: 'e'.repeat(64), timestamp: '2026-10-22T00:00:00Z', environment: { platform: 'darwin', arch: 'arm64', runtime: 'bun 1.3.14' } });

test('executes six real library recipes and exports honest missing phases', async () => {
  const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { throw new Error('Network forbidden in producer test'); }, { preconnect: () => { throw new Error('Network forbidden'); } }));
  try {
  const samples = [];
  for (const scenario of Object.keys(profiles.scenarios)) samples.push(await runProducerRecipe(scenario, 100));
  expect(samples.every(sample => sample.checks.length > 0)).toBe(true);
  expect(samples.every(sample => Object.values(sample.sourceCalls).reduce((sum, count) => sum + count, 0) > 0)).toBe(true);
  const report = projectProducerSamples(samples.map(sample => [sample]), provenance());
  expect(validateReport(report).valid).toBe(true);
  for (const run of report.runs) {
    expect(run.profile).toBe('in-process-producer');
    for (const name of ['db_reads', 'native_read_ms', 'native_write_ms', 'http_compressed_bytes', 'http_decompressed_bytes', 'ipc_json_bytes', 'last_message_visible_ms', 'native_rss_bytes', 'heap_bytes', 'terminal_events']) {
      expect(run.metrics.find(metric => metric.metric === name)?.evidence).toBe('not-measured');
    }
    expect(run.metrics.find(metric => metric.metric === 'serialized_bytes')?.evidence).toBe('estimated');
  }
  expect(samples.find(sample => sample.scenario === 'visible-unrelated-update')!.checks).toEqual(['error-state-retained', 'error-invalidation-retained', 'unrelated-resource-isolated', 'interaction-and-finish-invalidations-ordered']);
  expect(samples.find(sample => sample.scenario === 'foreground-reconnect')!.checks).toContain('lost-ack-retains-canonical-event');
  expect(samples.find(sample => sample.scenario === 'multiple-targets')!.sourceCalls).toHaveProperty('pc-slow/listMessages:synthetic-active');
  expect(samples.find(sample => sample.scenario === 'multiple-targets')!.results.unavailable).toBe(1);
  const resumed = samples.find(sample => sample.scenario === 'foreground-reconnect')!;
  expect(resumed.eventAttempts[0].sequence).toBe(resumed.eventAttempts[1].sequence);
  expect(resumed.eventAttempts[0].sha256).toBe(resumed.eventAttempts[1].sha256);
  expect(resumed.eventAttempts).toHaveLength(resumed.events.length + 1);
  expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

test('counts exact source-port calls, public captures and immutable continuation content', async () => {
  const h = createProducerFixture(1000);
  try {
    await h.prepare(); h.reset();
    const first = await h.read(); const initial = h.sample('history-pagination', 0, []);
    expect(initial.sourceCalls['listMessages:synthetic-active']).toBe(6);
    expect(initial.sourceCalls['listMessages:synthetic-other']).toBeUndefined();
    expect(initial.sourceRows).toBe(6000);
    expect(initial.newCaptures).toBe(1);
    expect(initial.captureApiCalls).toBe(1);
    const continuation = { snapshot_id: first.response.result.page.snapshot_id, cursor: first.response.result.page.next_cursor };
    expect(continuation.cursor).toBeTruthy();
    h.reset(); const next = await h.read('active', continuation); const current = h.sample('history-pagination', 0, []);
    expect(next.response.result.page.offset).toBe(100);
    expect(current.newCaptures).toBe(0);
    expect(current.sourceCalls['listMessages:synthetic-active']).toBe(6);
    h.edit();
    const late = await h.host.prepareConversationEmission(next.delivery, next.result);
    expect(late.type).toBe('invalidated');
    if (late.type === 'invalidated') expect(late.result.response).toMatchObject({ type: 'error', code: 'stale_revision' });
  } finally { await h.host.dispose(); }
});

test('long history uses actual continuations and preserves stale/expiry refusals', async () => {
  const sample = await runProducerRecipe('history-pagination', 1000);
  expect(sample.pageOffsets).toEqual([0, 100, 200]);
  expect(sample.results).toEqual({ response: 4, stale_revision: 1, snapshot_expired: 1 });
  expect(sample.captureApiFailures).toBe(2);
  expect(sample.checks).toContain('stale-continuation-refused');
});

test('new host does not inherit another target state and unchanged source observations emit no events', async () => {
  const idle = await runProducerRecipe('idle-hidden', 100);
  expect(idle.observations).toBe(10);
  expect(idle.events).toEqual([]);
  expect(idle.deliveries).toBe(0);
  expect(idle.sourceCalls['listMessages:synthetic-active']).toBe(20);
  expect(idle.captureApiCalls).toBe(0);
  expect(idle.newCaptures).toBe(0);
});
