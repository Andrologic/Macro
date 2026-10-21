import { expect, test, spyOn } from 'bun:test';
import { assertProducerPage, assertProducerTrace, expectedProducerTrace, createProducerFixture, runProducerRecipe, type ProducerSample } from './connect-producer-fixture';
import { parseProducerArguments, projectProducerSamples, producerSourceFingerprint } from './connect-producer';
import { contractHashes, validateReport } from '../../contracts/macro-connect/metrics/v1/validate.mjs';
import { ConversationCaptures } from '../../src/services/macroPilot/conversationCaptures';
import { ContentHost } from '../../src/services/macroPilot/contentHost';
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
  const report = projectProducerSamples(samples.map(sample => [sample]), provenance(), 1);
  expect(validateReport(report).valid).toBe(true);
  for (const run of report.runs) {
    expect(run.profile).toBe('in-process-producer');
    for (const name of ['db_reads', 'native_read_ms', 'native_write_ms', 'http_compressed_bytes', 'http_decompressed_bytes', 'ipc_json_bytes', 'last_message_visible_ms', 'native_rss_bytes', 'heap_bytes', 'terminal_events']) {
      expect(run.metrics.find(metric => metric.metric === name)?.evidence).toBe('not-measured');
    }
    expect(run.metrics.find(metric => metric.metric === 'serialized_bytes')?.evidence).toBe('estimated');
  }
  expect(samples.find(sample => sample.scenario === 'visible-unrelated-update')!.checks).toEqual(['error-state-retained', 'exhaustive-event-trace']);
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


test('multi-target recipe observes both canonical appends, slow error and healthy re-observation', async () => {
  const sample = await runProducerRecipe('multiple-targets', 100);
  expect(sample.observations).toBe(4);
  expect(sample.observationTrace).toEqual([
    { target: 'pc-a', phase: 'append-2000', atMs: 2000 },
    { target: 'pc-a', phase: 'observe-6000', atMs: 6000 },
    { target: 'pc-slow', phase: 'append-2000', atMs: 2000 },
    { target: 'pc-slow', phase: 'error-4000', atMs: 4000 },
  ]);
  expect(sample.events.map(({ sha256: _hash, ...event }) => event)).toEqual(expectedProducerTrace('multiple-targets'));
  expect(sample.events).toHaveLength(6);
  expect(sample.results.unavailable).toBe(1);
  expect(sample.checks).toContain('canonical-mutations-and-observations');
});

test('exhaustive event oracle rejects every missing event, duplication, reordering and identity drift', async () => {
  const sample = await runProducerRecipe('visible-unrelated-update', 100);
  expect(sample.events).toHaveLength(10);
  for (let index = 0; index < sample.events.length; index++) {
    expect(() => assertProducerTrace(sample.events.filter((_, i) => i !== index), sample.expectedEvents)).toThrow();
  }
  expect(() => assertProducerTrace([...sample.events, sample.events[9]], sample.expectedEvents)).toThrow();
  const reordered = [...sample.events]; [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  expect(() => assertProducerTrace(reordered, sample.expectedEvents)).toThrow();
  for (const mutation of [{ phase: 'wrong' }, { target: 'pc-b' }, { revision: 999 }, { kind: 'wrong' }, { resource: 'synthetic-other' }, { atMs: 999 }]) {
    const altered = sample.events.map(event => ({ ...event })); Object.assign(altered[3], mutation);
    expect(() => assertProducerTrace(altered, sample.expectedEvents)).toThrow();
  }
});

test('recipe itself refuses observer suppression of append or final resource invalidations', async () => {
  const original = ContentHost.prototype.flush;
  for (const omitted of [2, 4, 9]) {
    const altered = spyOn(ContentHost.prototype, 'flush').mockImplementation(function (this: ContentHost, send) {
      return original.call(this, async event => { if (event.sequence !== omitted) await send(event); });
    });
    try { await expect(runProducerRecipe('visible-unrelated-update', 100)).rejects.toThrow(/sequence gap|trace mismatch/); }
    finally { altered.mockRestore(); }
  }
});

test('page oracle rejects empty/truncated windows, wrong IDs, positions, totals, offsets and cursors', async () => {
  const h = createProducerFixture(1000);
  try {
    await h.prepare(); const first = (await h.read()).response.result;
    expect(() => assertProducerPage(first, h.allMessages.filter(row => row.conversation_id === 'synthetic-active'), 0)).not.toThrow();
    const source = h.allMessages.filter(row => row.conversation_id === 'synthetic-active');
    const mutations: Array<(value: typeof first) => void> = [
      value => { value.items = []; value.page.total = 0; value.page.next_cursor = null; },
      value => { value.items.pop(); },
      value => { value.items[0].message_id = 'wrong'; },
      value => { value.items[0].position = 1; },
      value => { value.page.total--; },
      value => { value.page.offset = 100; },
      value => { value.page.next_cursor = null; },
    ];
    for (const mutate of mutations) {
      const altered = structuredClone(first); mutate(altered);
      expect(() => assertProducerPage(altered, source, 0)).toThrow();
    }
    const continuation = { snapshot_id: first.page.snapshot_id, cursor: first.page.next_cursor };
    const next = (await h.read('active', continuation)).response.result;
    expect(next.page.offset).toBe(100);
    expect(next.items).toHaveLength(100);
    expect(next.items[0].message_id).toBe('seed-active-000100');
    expect(() => assertProducerPage(next, source, 100, 'wrong-snapshot')).toThrow();
    const replay = await h.read('active', continuation);
    expect(replay.response.result.page.next_cursor).toBe(next.page.next_cursor);
  } finally { await h.host.dispose(); }
});

test('history recipe itself refuses empty, truncated and prematurely final public pages', async () => {
  const original = ConversationCaptures.prototype.conversationRead;
  for (const mutation of ['empty', 'truncated', 'no-cursor']) {
    const altered = spyOn(ConversationCaptures.prototype, 'conversationRead').mockImplementation(async function (this: ConversationCaptures, ...args) {
      const value = await original.apply(this, args);
      if (mutation === 'empty') return { ...value, page: { ...value.page, total: 0, next_cursor: null }, items: [] };
      if (mutation === 'truncated') return { ...value, items: value.items.slice(1) };
      return { ...value, page: { ...value.page, next_cursor: null } };
    });
    try { await expect(runProducerRecipe('history-pagination', 1000)).rejects.toThrow(); }
    finally { altered.mockRestore(); }
  }
});

test('explicit process indices survive projection and CLI rejects absent or invalid indices', async () => {
  const samples: ProducerSample[][] = [];
  for (const scenario of Object.keys(profiles.scenarios)) samples.push([await runProducerRecipe(scenario, 100)]);
  const provenanceValue = provenance();
  for (const index of [1, 2, 3]) {
    expect(parseProducerArguments(['b'.repeat(40), 'c'.repeat(40), String(index)]).processIndex).toBe(index);
    const report = projectProducerSamples(samples, provenanceValue, index);
    expect(report.runs.every(run => run.process_index === index)).toBe(true);
  }
  for (const index of [0, 4, 1.5, NaN, undefined]) {
    expect(() => projectProducerSamples(samples, provenanceValue, index as number)).toThrow(/process index/);
  }
  for (const args of [[], ['b'.repeat(40), 'c'.repeat(40)], ...['0', '4', '1.5', '01', '1x', 'NaN'].map(index => ['b'.repeat(40), 'c'.repeat(40), index])]) {
    expect(() => parseProducerArguments(args)).toThrow(/Usage/);
  }
});
