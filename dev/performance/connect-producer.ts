import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, platform, release, cpus } from 'node:os';
import { runProducerRecipe, type ProducerSample } from './connect-producer-fixture';
import { distribution } from './stats';
import { contractHashes, metricUnits, validateReport } from '../../contracts/macro-connect/metrics/v1/validate.mjs';
import { profiles } from '../../contracts/macro-connect/metrics/v1/fixtures.mjs';

const root = new URL('../../', import.meta.url);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hashFile = (path: string) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex');
export function producerSourceFingerprint() {
  // Include the whole tracked frontend source and contracts rather than assume a
  // transitive import list. No native operation is exercised by this fingerprint.
  const files = git('ls-files', '--', 'src', 'contracts', 'dev/performance', 'package.json', 'bun.lock').split('\n').sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(new URL(file, root))).update('\0');
  return hash.digest('hex');
}
export function projectProducerSamples(groups: ProducerSample[][], provenance: Record<string, unknown>) {
  const runs = groups.map(samples => {
    assert(samples.length > 0, 'empty measurement group');
    const { scenario, size } = samples[0];
    assert(samples.every(sample => sample.scenario === scenario && sample.size === size), 'mixed fixture');
    const metrics = Object.entries(metricUnits).map(([metric, unit]) => ({ metric, unit, role: metric.startsWith('native_') || metric === 'db_reads' ? 'native' : 'producer',
      scope: ['native_rss_bytes', 'heap_bytes'].includes(metric) ? 'process' : 'operation', evidence: 'not-measured', reason: 'outside-boundary', recipe: scenario } as Record<string, any>));
    const set = (name: string, values: number[], evidence: 'measured' | 'estimated', method: string) => {
      const metric = metrics.find(entry => entry.metric === name)!;
      delete metric.reason; delete metric.recipe;
      Object.assign(metric, { evidence, method, summary: distribution(values) });
    };
    set('sources_read', samples.map(sample => Object.values(sample.sourceCalls).reduce((sum, count) => sum + count, 0)), 'measured', 'runtime-counter');
    set('states_rebuilt', samples.map(sample => sample.newCaptures), 'measured', 'runtime-counter');
    set('useful_content_bytes', samples.map(sample => sample.usefulBytes), 'measured', 'payload-observer');
    set('serialized_bytes', samples.map(sample => sample.serializedBytes), 'estimated', 'json-utf8');
    // API wall durations only where an API actually ran, including failed calls.
    // This is cumulative across calls/hosts and can overlap in multiple-targets.
    const timed = samples.filter(sample => sample.captureApiCalls > 0);
    if (timed.length) set('capture_build_ms', timed.map(sample => sample.captureApiMs), 'measured', 'monotonic-clock');
    return { scenario, profile: 'in-process-producer', fixture: { messages: size, content_bytes: 256, targets: scenario === 'multiple-targets' ? 3 : 1,
      definition_sha256: hashFile('dev/performance/connect-producer-fixture.ts') }, preparation: scenario === 'cold-open-return' ? 'included' : 'excluded',
      temperature: 'warm-operation', warmup: 10, process_index: 1, metrics };
  });
  const report = { format_version: 1, kind: 'macro-connect-measurements', provenance,
    limits: ['synthetic-data', 'shared-machine', 'single-process-series', 'no-transport', 'no-ui', 'no-rss', 'no-heap', 'physical-device-pending'], runs };
  const result = validateReport(report);
  assert(result.valid, JSON.stringify(result.errors));
  return report;
}

/** One fresh process, 18 cells. Seeding and optional preopened captures precede
 * each action window. Report only successful groups; unexpected failure aborts
 * and prints a structured cell/sample diagnostic to stderr, never a fake zero. */
export async function producerCampaign(mobile: string, relay: string) {
  assert(/^[a-f0-9]{40}$/.test(mobile) && /^[a-f0-9]{40}$/.test(relay), 'exact cohort SHAs required');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'clean committed source required');
  const head = git('rev-parse', 'HEAD'); const fingerprint = producerSourceFingerprint();
  const timestamp = new Date().toISOString(); const groups: ProducerSample[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => { throw new Error('Network forbidden in in-process producer campaign'); }, { preconnect: () => { throw new Error('Network forbidden'); } }) as typeof fetch;
  try {
    for (const size of profiles.fixture.sizes) {
      for (const scenario of Object.keys(profiles.scenarios)) {
        const samples: ProducerSample[] = [];
        for (let index = -10; index < 100; index++) {
          try {
            const sample = await runProducerRecipe(scenario, size);
            if (index >= 0) samples.push(sample);
          } catch (error) {
            console.error(JSON.stringify({ kind: 'producer-campaign-failure', head, size, scenario, index,
              error: error instanceof Error ? error.name : 'unknown' }));
            throw error;
          }
        }
        groups.push(samples);
        // Checkpoint complete cells outside timed windows. A later failure keeps
        // raw successful observations in the local stderr log, without claiming
        // that an incomplete campaign is a valid full report.
        console.error(JSON.stringify({ kind: 'producer-cell-complete', size, scenario, count: samples.length, samples }));
      }
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(git('rev-parse', 'HEAD'), head, 'source revision changed');
  assert.equal(producerSourceFingerprint(), fingerprint, 'source fingerprint changed');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'worktree changed');
  const provenance = { repositories: { desktop: head, mobile, relay }, measured_repository: 'desktop', dirty: false,
    source_sha256: fingerprint, ...contractHashes(), lock_sha256: hashFile('bun.lock'), timestamp,
    environment: { platform: platform(), arch: arch(), runtime: `bun ${Bun.version}` } };
  const report = projectProducerSamples(groups, provenance);
  return { kind: 'typescript-producer-library-campaign', provenance, report,
    boundary: { capabilities: ['network-reliability-1', 'conversations-1', 'conversation-interactions-1'], classes: ['ConversationCaptures', 'ContentHost', 'ConversationInteractions'], source: 'in-memory typed ports; no SQLite or IPC',
      clock: 'performance.now for API and scenario wall time; injected Date clock for TTL/event schedule',
      states_rebuilt: 'distinct capture snapshot IDs first returned within window; internal observations not counted',
      capture_build_ms: 'sum of wall durations of public capture APIs, including failures, queueing and cloned in-memory source data; not pure assembly; can overlap between hosts',
      serialized_bytes: 'UTF-8 JSON request/result/event observations, including retries; estimated allocations, no transport framing',
      useful_content_bytes: 'UTF-8 public text fields in returned results and events; repeated deliveries counted',
      terminal_events: 'not measured; raw ContentHost invalidation sequence and state checks only; no PilotRuntime or run kernel',
      preparation: 'fixture seeding excluded; host prepare included only cold-open-return; other preopened captures excluded',
      window: 'business clock simulates 10-second schedule; history adds expiry at 300001ms; no real idle/wakeup rate' },
    environment: { os: release(), cpu: cpus()[0]?.model, load: 'shared machine; OS and runtime GC uncontrolled' },
    samples: groups.flat(),
  };
}
if (import.meta.main) {
  const [mobile, relay] = process.argv.slice(2);
  assert.equal(process.argv.length, 4, 'Usage: bun dev/performance/connect-producer.ts <mobile-SHA> <relay-SHA>');
  console.log(JSON.stringify(await producerCampaign(mobile, relay)));
}
