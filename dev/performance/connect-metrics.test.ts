import { describe, expect, test } from 'bun:test';
import { convertNativeReports } from './connect-report';
import { contractHashes, metricUnits, validateReport, compareMetric } from '../../contracts/macro-connect/metrics/v1/validate.mjs';
import { profiles, fixtureMessages, scenarioSchedule } from '../../contracts/macro-connect/metrics/v1/fixtures.mjs';

// This report tests declarations only. No fixture value is exported as an
// executed measurement, and no native/provider/application runtime is started.
function example() {
  return {
    format_version: 1, kind: 'macro-connect-measurements',
    provenance: { repositories: { desktop: 'a'.repeat(40), mobile: 'b'.repeat(40), relay: 'c'.repeat(40) }, measured_repository: 'desktop',
      dirty: false, source_sha256: 'd'.repeat(64), lock_sha256: 'e'.repeat(64), ...contractHashes(), timestamp: '2026-10-22T00:00:00Z',
      environment: { platform: 'darwin', arch: 'arm64', runtime: 'rustc 1.99.1' } },
    limits: ['synthetic-data'],
    runs: Object.keys(profiles.scenarios).map(scenario => ({ scenario, profile: 'loopback', fixture: { messages: 100, content_bytes: 256, targets: scenario === 'multiple-targets' ? 3 : 1 },
      preparation: 'excluded', temperature: 'warm-operation', warmup: 10, process_index: 1,
      metrics: Object.entries(metricUnits).map(([metric, unit]) => ({ metric, unit, role: 'native', scope: 'process', evidence: 'not-measured', reason: 'adapter-pending', recipe: scenario })),
    })),
  } as Record<string, any>;
}
const metric = (report: Record<string, any>, name = 'native_rss_bytes') => report.runs[0].metrics.find((entry: any) => entry.metric === name);
function recorded(report: Record<string, any>, name: string, evidence: string, method: string) {
  const entry = metric(report, name);
  delete entry.reason; delete entry.recipe;
  Object.assign(entry, { evidence, method, summary: { count: 100, p50: 10, p95: 15, max: 20 } });
  return entry;
}

describe('Connect measurements preserve evidence boundaries', () => {
  test('accepts explicit missing metrics and real process memory declarations', () => {
    const report = example();
    expect(validateReport(report).valid).toBe(true);
    recorded(report, 'native_rss_bytes', 'measured', 'native-process-rss');
    recorded(report, 'heap_bytes', 'measured', 'runtime-heap');
    expect(validateReport(report).valid).toBe(true);
  });
  test('schema rejects serialized or simulated values labelled RSS or heap', () => {
    for (const name of ['native_rss_bytes', 'heap_bytes']) {
      for (const evidence of ['estimated', 'simulated', 'measured']) {
        const report = example();
        recorded(report, name, evidence, evidence === 'simulated' ? 'deterministic-clock' : 'json-utf8');
        expect(validateReport(report).valid).toBe(false);
      }
    }
    const report = example();
    recorded(report, 'serialized_bytes', 'estimated', 'json-utf8');
    expect(validateReport(report).valid).toBe(true);
  });
  test('absence cannot contain a number or silently omit a metric/scenario', () => {
    for (const change of [
      (r: any) => metric(r).summary = { count: 0, p50: 0, p95: 0, max: 0 },
      (r: any) => metric(r).value = 0,
      (r: any) => r.runs[0].metrics.pop(),
      (r: any) => r.runs.pop(),
      (r: any) => recorded(r, 'native_rss_bytes', 'measured', 'native-process-rss').summary.count = 0,
      (r: any) => { const m = metric(r); delete m.reason; m.evidence = 'measured'; },
    ]) {
      const report = example(); change(report); expect(validateReport(report).valid).toBe(false);
    }
  });
  test('preserves units, memory scope, provenance, finite values and percentile order', () => {
    for (const change of [
      (r: any) => metric(r).unit = 'ms',
      (r: any) => metric(r).role = 'producer',
      (r: any) => metric(r).scope = 'operation',
      (r: any) => r.provenance.dirty = true,
      (r: any) => r.provenance.repositories.mobile = 'branch-name',
      (r: any) => r.provenance.schema_sha256 = 'f'.repeat(64),
      (r: any) => r.provenance.profiles_sha256 = 'f'.repeat(64),
      (r: any) => recorded(r, 'native_rss_bytes', 'measured', 'native-process-rss').summary.p95 = Infinity,
      (r: any) => recorded(r, 'native_rss_bytes', 'measured', 'native-process-rss').summary.p95 = 1,
      (r: any) => recorded(r, 'native_rss_bytes', 'measured', 'native-process-rss').summary.p50 = 1.5,
      (r: any) => { recorded(r, 'native_rss_bytes', 'measured', 'native-process-rss'); r.limits.push('no-rss'); },
    ]) {
      const report = example(); change(report); expect(validateReport(report).valid).toBe(false);
    }
  });
  test('native read measurement requires binary identity', () => {
    const report = example();
    const entry = recorded(report, 'native_read_ms', 'measured', 'native-repository-clock');
    entry.scope = 'operation';
    expect(validateReport(report).valid).toBe(false);
    report.runs[0].profile = 'native-sqlite'; report.runs[0].binary_sha256 = 'f'.repeat(64);
    expect(validateReport(report).valid).toBe(true);
  });
  test('strict objects refuse transcript, credentials and private path fields', () => {
    for (const key of ['transcript', 'credentials', 'path']) {
      const report = example(); report.provenance[key] = '/private/synthetic';
      expect(validateReport(report).valid).toBe(false);
    }
    const report = example(); report.provenance.environment.runtime = '/private/synthetic';
    expect(validateReport(report).valid).toBe(false);
  });
  test('target identity prevents combining unrelated counters', () => {
    const report = example();
    const entry = metric(report, 'subscriptions'); entry.scope = 'target';
    expect(validateReport(report).valid).toBe(false);
    entry.target = 'pc-a'; expect(validateReport(report).valid).toBe(true);
    report.runs[0].metrics.push({ ...entry, target: 'pc-b' }); expect(validateReport(report).valid).toBe(true);
    report.runs[0].metrics.push({ ...entry }); expect(validateReport(report).valid).toBe(false);
  });
  test('a real gate rejects estimated, simulated and missing comparisons', () => {
    const report = example();
    const real = recorded(report, 'native_rss_bytes', 'measured', 'native-process-rss');
    expect(compareMetric(real, { ...real, summary: { ...real.summary, p95: 16 } }).verdict).toBe('regression');
    expect(compareMetric(real, real).verdict).toBe('within-policy');
    for (const evidence of ['not-measured', 'estimated', 'simulated']) expect(compareMetric(real, { ...real, evidence }).verdict).toBe('not-comparable');
    expect(compareMetric(real, { ...real, unit: 'ms' }).verdict).toBe('not-comparable');
    expect(() => compareMetric(real, real, NaN)).toThrow();
  });
});

describe('six portable scenario fixtures', () => {
  test('all sizes match native seed content/order with two isolated conversation IDs', () => {
    for (const size of profiles.fixture.sizes) {
      const first = fixtureMessages(size); const second = fixtureMessages(size, 'other');
      expect(first).toHaveLength(size);
      expect(first).toEqual(fixtureMessages(size));
      expect(first[0].id).toBe('seed-000000');
      expect(first.at(-1).id).toBe(`seed-${String(size - 1).padStart(6, '0')}`);
      expect(new Set(first.map((entry: any) => entry.id)).size).toBe(size);
      expect(first.every((entry: any) => entry.role === 'user' && entry.content === 'x'.repeat(256) && entry.created_at === '2026-01-01T00:00:00Z')).toBe(true);
      expect(first[0].conversation_id).not.toBe(second[0].conversation_id);
    }
    expect(() => fixtureMessages(7)).toThrow();
  });
  test('profiles have repeatable interruption ordering and no mutation between calls', () => {
    expect(Object.keys(profiles.scenarios)).toHaveLength(6);
    for (const scenario of Object.keys(profiles.scenarios)) {
      for (const profile of Object.keys(profiles.profiles)) {
        const schedule = scenarioSchedule(scenario, profile);
        expect(schedule).toEqual(scenarioSchedule(scenario, profile));
        expect(schedule.events.every((event: any, i: number, all: any[]) => event.at_ms >= 0 && event.at_ms <= schedule.window_ms && (!i || event.at_ms >= all[i - 1].at_ms))).toBe(true);
        if (profile === 'deterministic-interruption') expect(schedule.events.filter((event: any) => ['disconnect', 'reconnect'].includes(event.action)).map((event: any) => event.at_ms)).toEqual([500, 1500]);
      }
    }
    const result = scenarioSchedule('idle-hidden', 'loopback'); result.network.rtt_ms = 999;
    expect(scenarioSchedule('idle-hidden', 'loopback').network.rtt_ms).toBe(0);
    const terminal = scenarioSchedule('visible-unrelated-update', 'loopback').events.filter((entry: any) => ['error', 'interaction', 'finish'].includes(entry.action));
    expect(terminal.map((entry: any) => entry.action)).toEqual(['error', 'interaction', 'finish']);
  });
});


describe('native report projection', () => {
  const repositories = { desktop: 'a'.repeat(40), mobile: 'b'.repeat(40), relay: 'c'.repeat(40) };
  const current = { head: repositories.desktop, source: 'd'.repeat(64), lock: 'e'.repeat(64) };
  function raw() {
    return {
      provenance: { head: current.head, dirty: false, sourceSha256: current.source, binarySha256: 'f'.repeat(64), rustc: 'rustc 1.99.1', cargo: 'cargo 1.99.1', offline: true, locked: true, profile: 'dev', cargoJobs: 1,
        profileOverrides: { macroDebug: 0, testMacroDebug: 0, incremental: false, testIncremental: false } },
      environment: { platform: 'darwin', arch: 'arm64', timestamp: '2026-10-22T00:00:00Z' },
      measurement: { schema: 2, samples: 100, warmup: 10, cold_disk_cache: false, build_profile: 'debug', percentile: 'nearest-rank', boundary: 'in-process Rust repository -> SQLx -> on-disk SQLite; no transport',
        cases: [100, 1000, 10000].map(size => ({ initial_messages: size, read_messages: size, message_bytes: 256, diagnostics: null, write_start_messages: size + 10, final_messages: size + 110,
          migrations: [1,3,4,5,6,7,8,9,10,11,12], pragmas: { journal_mode: 'wal', synchronous: 1, foreign_keys: 1 },
          read: { count: 100, p50: 1, p95: 2, max: 3 }, create_message_commit: { count: 100, p50: 4, p95: 5, max: 6 },
          checks: { opened_path_matches_owned_fixture: true, content_and_metadata_after_reopen: true, all_appends_after_reopen: true, integrity: true, cleanup: true } })) },
    } as Record<string, any>;
  }
  test('projects only executed native operations and keeps every other phase absent', () => {
    const report = convertNativeReports([raw()], repositories, current);
    expect(validateReport(report).valid).toBe(true);
    expect(report.runs).toHaveLength(18);
    const observations = report.runs.flatMap((run: any) => run.metrics);
    expect(observations.filter((entry: any) => entry.evidence === 'measured')).toHaveLength(6);
    expect(observations.filter((entry: any) => entry.metric === 'native_rss_bytes').every((entry: any) => entry.evidence === 'not-measured')).toBe(true);
    expect(report.runs.find((run: any) => run.scenario === 'history-pagination').metrics.find((entry: any) => entry.metric === 'native_read_ms').summary).toEqual({ count: 100, p50: 1, p95: 2, max: 3 });
  });
  test('rejects source drift, missing checks, diagnostics, altered boundaries and duplicate inputs', () => {
    for (const change of [
      (r: any) => r.provenance.dirty = true,
      (r: any) => r.provenance.sourceSha256 = '0'.repeat(64),
      (r: any) => r.measurement.boundary = 'simulated',
      (r: any) => r.measurement.cases[0].diagnostics = {},
      (r: any) => r.measurement.cases[0].checks.cleanup = false,
      (r: any) => r.measurement.cases[0].read.count = 0,
      (r: any) => r.measurement.cases[0].read.p95 = NaN,
      (r: any) => r.measurement.cases[0].pragmas.synchronous = 0,
      (r: any) => r.measurement.cases[0].final_messages = 999,
    ]) {
      const report = raw(); change(report); expect(() => convertNativeReports([report], repositories, current)).toThrow();
    }
    expect(() => convertNativeReports([raw(), raw()], repositories, current)).toThrow('Repeated native invocation');
  });
});
