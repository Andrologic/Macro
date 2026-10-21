import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sourceFingerprint } from './native-sqlite';
import { contractHashes, validateReport, metricUnits } from '../../contracts/macro-connect/metrics/v1/validate.mjs';
import { profiles } from '../../contracts/macro-connect/metrics/v1/fixtures.mjs';

const root = new URL('../../', import.meta.url);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hashFile = (path: string) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex');
const role = (metric: string) => metric.startsWith('native_') || metric === 'db_reads' ? 'native' : metric.startsWith('http_') || ['heap_bytes', 'messages_retained', 'active_read_position', 'subscriptions', 'pending_intents', 'ui_apply_ms', 'last_message_visible_ms'].includes(metric) ? 'consumer' : 'producer';

/** Convert only verified ordinary native reports. Every other phase remains
 * absent. No fixture clock, memory estimate or cold/UI claim fills the gaps. */
export function nativeConnectReport(inputs: unknown[], repositories: { desktop: string; mobile: string; relay: string }) {
  const current = { head: git('rev-parse', 'HEAD'), source: sourceFingerprint(), lock: hashFile('src-tauri/Cargo.lock') };
  if (git('status', '--porcelain', '--untracked-files=all') || repositories.desktop !== current.head) throw new Error('Clean current source required');
  return convertNativeReports(inputs, repositories, current);
}

/** Pure projection, also used with explicitly synthetic reports in unit tests.
 * Call nativeConnectReport for evidence bound to the current clean worktree. */
export function convertNativeReports(inputs: unknown[], repositories: { desktop: string; mobile: string; relay: string }, current: { head: string; source: string; lock: string }) {
  if (repositories.desktop !== current.head || inputs.length === 0) throw new Error('Native measurements required for current source');
  const fingerprint = current.source;
  const reports = inputs as Array<Record<string, any>>;
  const result: Record<string, any> = {
    format_version: 1, kind: 'macro-connect-measurements',
    provenance: { repositories, measured_repository: 'desktop', dirty: false, source_sha256: fingerprint,
      ...contractHashes(), lock_sha256: current.lock,
      timestamp: reports[0].environment?.timestamp,
      environment: { platform: reports[0].environment?.platform, arch: reports[0].environment?.arch, runtime: reports[0].provenance?.rustc } },
    limits: ['shared-machine', 'os-cache-uncontrolled', 'debug-profile', 'no-ui', 'no-transport', 'no-rss', 'no-heap', 'physical-device-pending', 'synthetic-data', ...(inputs.length === 1 ? ['single-process-series'] : [])],
    runs: [],
  };
  const invocations = new Set<string>();
  reports.forEach((report, index) => {
    const invocation = `${report.environment?.timestamp}/${report.provenance?.binarySha256}`;
    if (invocations.has(invocation)) throw new Error('Repeated native invocation');
    invocations.add(invocation);
    if (report.provenance?.head !== repositories.desktop || report.provenance?.dirty !== false || report.provenance?.sourceSha256 !== fingerprint ||
      !/^[a-f0-9]{64}$/.test(report.provenance?.binarySha256 ?? '') || report.measurement?.schema !== 2 || report.measurement?.cold_disk_cache !== false ||
      report.measurement?.samples !== 100 || report.measurement?.warmup !== 10 || report.provenance?.offline !== true || report.provenance?.locked !== true ||
      report.measurement?.cases?.length !== 3 || report.measurement?.build_profile !== 'debug' || report.measurement?.percentile !== 'nearest-rank' ||
      report.measurement?.boundary !== 'in-process Rust repository -> SQLx -> on-disk SQLite; no transport' || report.provenance?.rustc !== reports[0].provenance?.rustc ||
      report.environment?.platform !== reports[0].environment?.platform || report.environment?.arch !== reports[0].environment?.arch ||
      report.provenance?.profile !== 'dev' || report.provenance?.cargoJobs !== 1 || report.provenance?.profileOverrides?.macroDebug !== 0 || report.provenance?.profileOverrides?.incremental !== false || report.provenance?.profileOverrides?.testMacroDebug !== 0 || report.provenance?.profileOverrides?.testIncremental !== false ||
      report.provenance?.cargo !== reports[0].provenance?.cargo || JSON.stringify(report.provenance?.profileOverrides) !== JSON.stringify(reports[0].provenance?.profileOverrides)) throw new Error('Unverified ordinary native report');
    for (const size of profiles.fixture.sizes) {
      const nativeCase = report.measurement.cases.find((entry: any) => entry.initial_messages === size);
      if (!nativeCase || nativeCase.read_messages !== size || nativeCase.message_bytes !== 256 || nativeCase.diagnostics !== null || nativeCase.write_start_messages !== size + 10 || nativeCase.final_messages !== size + 110 ||
        JSON.stringify(nativeCase.migrations) !== '[1,3,4,5,6,7,8,9,10,11,12]' || nativeCase.pragmas?.journal_mode !== 'wal' || nativeCase.pragmas?.synchronous !== 1 || nativeCase.pragmas?.foreign_keys !== 1 ||
        nativeCase.read?.count !== 100 || nativeCase.create_message_commit?.count !== 100 ||
        !['opened_path_matches_owned_fixture', 'content_and_metadata_after_reopen', 'all_appends_after_reopen', 'integrity', 'cleanup'].every(key => nativeCase.checks?.[key] === true)) throw new Error('Incomplete native fixture checks');
      for (const scenario of Object.keys(profiles.scenarios)) {
        const metrics = Object.keys(metricUnits).map(metric => ({
          metric, unit: metricUnits[metric], role: role(metric), scope: ['native_rss_bytes', 'heap_bytes'].includes(metric) ? 'process' : 'operation',
          evidence: 'not-measured', reason: 'outside-boundary', recipe: scenario,
        } as Record<string, any>));
        if (scenario === 'history-pagination') {
          for (const [metric, summary] of [['native_read_ms', nativeCase.read], ['native_write_ms', nativeCase.create_message_commit]] as const) {
            const entry = metrics.find(item => item.metric === metric)!;
            delete entry.reason; delete entry.recipe;
            Object.assign(entry, { evidence: 'measured', method: 'native-repository-clock', summary: { count: summary.count, p50: summary.p50, p95: summary.p95, max: summary.max } });
          }
        }
        result.runs.push({ scenario, profile: 'native-sqlite', binary_sha256: report.provenance.binarySha256, fixture: { messages: size, content_bytes: 256, targets: scenario === 'multiple-targets' ? 3 : 1 },
          preparation: 'excluded', temperature: 'warm-operation', warmup: 10, process_index: index + 1, metrics });
      }
    }
  });
  const validity = validateReport(result);
  if (!validity.valid) throw new Error(JSON.stringify(validity.errors));
  return result;
}

if (import.meta.main) {
  const [mobile, relay, ...files] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/.test(mobile ?? '') || !/^[a-f0-9]{40}$/.test(relay ?? '') || files.length === 0) throw new Error('Usage: bun dev/performance/connect-report.ts <mobile-SHA> <relay-SHA> <native-report.json>...');
  const result = nativeConnectReport(files.map(file => JSON.parse(readFileSync(file, 'utf8'))), { desktop: git('rev-parse', 'HEAD'), mobile, relay });
  console.log(JSON.stringify(result, null, 2));
}
