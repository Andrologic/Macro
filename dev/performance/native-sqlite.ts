import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { cpus, totalmem, platform, release, arch, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
export function sourceFingerprint(directory = root) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'src-tauri', 'dev/performance'], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(join(directory, file))).update('\0');
  return hash.digest('hex');
}

type BuildIdentity = { sourceSha256: string; buildNonce: string };
export function stageVerifiedBinary(source: string, destination: string, expected: BuildIdentity,
  readIdentity: (binary: string) => unknown = (binary) =>
    JSON.parse(execFileSync(binary, ['--build-identity'], { encoding: 'utf8' }))) {
  copyFileSync(source, destination);
  chmodSync(destination, 0o700);
  const identity = readIdentity(destination) as Partial<BuildIdentity> | null;
  if (!identity || identity.sourceSha256 !== expected.sourceSha256 || identity.buildNonce !== expected.buildNonce) {
    throw new Error('Compiled identity mismatch: shared-cache binary changed; discard this run');
  }
}

export function validateNativeArgs(args: string[]): void {
  const allowed = [[], ['--self-test'], ['--diagnostics'], ['--content-baseline'], ['--content-baseline', '--pilot']];
  if (!allowed.some(value => JSON.stringify(value) === JSON.stringify(args))) {
    throw new Error('Usage: native-sqlite.ts [--self-test|--diagnostics|--content-baseline [--pilot]]');
  }
}

/** Reject incomplete content evidence before the runner publishes it. */
export function validateContentBaseline(value: unknown, pilot: boolean): void {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid content baseline object');
    return value as Record<string, unknown>;
  };
  const data = object(value);
  const samples = pilot ? 3 : 100;
  if (data.schema !== 3 || data.mode !== 'content-baseline' || data.pilot !== pilot ||
      data.reference_eligible !== !pilot || data.warmup !== (pilot ? 1 : 10) || data.samples !== samples ||
      typeof data.fixture_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.fixture_sha256)) throw new Error('Invalid content baseline header');
  for (const key of ['seven_payload_fields_refused', 'sql_rejection_before_fetch', 'fetch_probe_negative_control', 'legacy_receipt_not_projected', 'cas_conflict_refused']) {
    if (object(data.admission_controls)[key] !== true) throw new Error('Missing content admission control');
  }
  for (const key of ['empty_and_missing','timestamp_id_ties','all_14_fields','unicode_preview_future_latest',
    'duplicate_and_foreign_key_errors','metadata_failure_rolls_back_message_and_fts','wal_reader_and_writer_wait',
    'commit_file_reopen_exact_content_metadata_fts']) {
    if (object(data.contract_checks)[key] !== true) throw new Error('Missing content contract check');
  }
  if (object(data.contract_checks).rows_after_reopen !== 4) throw new Error('Invalid content contract reopen count');
  if (!Array.isArray(data.cases) || data.cases.length !== 3) throw new Error('Incomplete content cases');
  const names = ['get_message', 'list_messages_bounded', 'count_exportable', 'catalog_metadata',
    'serde_get_message', 'serde_all_messages', 'serde_catalog_metadata', 'update_stream_commit',
    'import100_commit', 'delete100_commit', 'provenance_cas', 'provenance_get'];
  for (const [index, raw] of data.cases.entries()) {
    const entry = object(raw); const size = [100, 1000, 10000][index];
    if (entry.initial_messages !== size || entry.final_messages !== size ||
        entry.bounded_admitted !== (index < 2) || ['exact_14_fields', 'missing', 'writes_and_resets', 'metadata_fts', 'reopen', 'integrity', 'cleanup'].some(key => object(entry.checks)[key] !== true)) throw new Error('Invalid content fixture checks');
    const runtime = object(entry.runtime);
    if (JSON.stringify(runtime.migrations) !== JSON.stringify([1,3,4,5,6,7,8,9,10,11,12]) || runtime.journal_mode !== 'wal' || runtime.synchronous !== 1 || runtime.foreign_keys !== 1) throw new Error('Invalid content runtime');
    const cells = object(entry.cells);
    const expected = [...names, ...(entry.bounded_admitted ? ['serde_bounded_messages'] : [])].sort();
    if (JSON.stringify(Object.keys(cells).sort()) !== JSON.stringify(expected)) throw new Error('Incomplete content cells');
    for (const [name, rawCell] of Object.entries(cells)) {
      const cell = object(rawCell);
      if (!Array.isArray(cell.raw_ms) || cell.raw_ms.length !== samples || cell.raw_ms.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0) ||
          !Array.isArray(cell.outcomes) || cell.outcomes.length !== samples || object(cell.summary).count !== samples) throw new Error('Incomplete content raw samples');
      const times = (cell.raw_ms as number[]).slice().sort((a,b) => a-b);
      const summary = object(cell.summary);
      if (summary.unit !== 'ms' || summary.p50 !== times[Math.ceil(samples * 0.5)-1] || summary.p95 !== times[Math.ceil(samples * 0.95)-1] || summary.max !== times.at(-1)) throw new Error('Invalid content summary');
      for (const rawOutcome of cell.outcomes) {
        const outcome = object(rawOutcome);
        if (name.startsWith('serde_') && (!Number.isSafeInteger(outcome.bytes) || Number(outcome.bytes) <= 0)) throw new Error('Invalid content serialized bytes');
        if (['get_message','provenance_get'].includes(name) && (outcome.rows !== 1 || outcome.outcome !== 'ok')) throw new Error('Invalid content get outcome');
        if (name === 'count_exportable' && outcome.rows !== size) throw new Error('Invalid content count');
        if (name === 'catalog_metadata' && outcome.conversations !== 1) throw new Error('Invalid content metadata');
        if (['update_stream_commit', 'provenance_cas', 'import100_commit', 'delete100_commit'].includes(name) &&
            (outcome.start_rows !== size + (name === 'delete100_commit' ? 100 : 0) || outcome.end_rows !== size + (name === 'import100_commit' ? 100 : 0))) throw new Error('Invalid content write state');
        if (name === 'import100_commit' && outcome.inserted !== 100) throw new Error('Invalid content inserted count');
        if (name === 'delete100_commit' && outcome.deleted !== 100) throw new Error('Invalid content deleted count');
        if (name === 'list_messages_bounded' && (entry.bounded_admitted
          ? outcome.outcome !== 'ok' || outcome.rows !== size || 'rows_returned' in outcome
          : outcome.outcome !== 'resource_limit' || outcome.rows_returned !== 0 || 'rows' in outcome)) throw new Error('Invalid content bounded cardinality');
        if (name === 'provenance_cas' && outcome.applied !== true) throw new Error('Invalid content CAS');
      }
      if (name === 'list_messages_bounded' && cell.outcomes.some(raw => object(raw).outcome !== (entry.bounded_admitted ? 'ok' : 'resource_limit'))) throw new Error('Unexpected content admission outcome');
    }
  }
}

async function run() {
  validateNativeArgs(process.argv.slice(2));
  const head = git('rev-parse', 'HEAD');
  const fingerprint = sourceFingerprint();
  const dirty = Boolean(git('status', '--porcelain', '--untracked-files=all'));
  const content = process.argv.includes('--content-baseline');
  const pilot = process.argv.includes('--pilot');
  if (content && !pilot && dirty) throw new Error('Content reference requires clean committed sources');
  const identity = { sourceSha256: fingerprint, buildNonce: randomUUID() };
  const build = Bun.spawn(['cargo', 'build', '--manifest-path', 'src-tauri/Cargo.toml',
    '--example', 'performance-sqlite', '--locked', '--offline', '-j', '1',
    '--config', 'profile.dev.package.macro.debug=0',
    '--config', 'profile.test.package.macro.debug=0',
    '--config', 'profile.dev.incremental=false',
    '--config', 'profile.test.incremental=false'], {
    cwd: root, env: { ...process.env, TAURI_CONFIG: '{"bundle":{"externalBin":[]}}',
      MACRO_NATIVE_PERF_SOURCE_SHA256: identity.sourceSha256, MACRO_NATIVE_PERF_BUILD_NONCE: identity.buildNonce },
    stdout: 'inherit', stderr: 'inherit',
  });
  if (await build.exited !== 0) throw new Error('Native benchmark build failed');
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, 'src-tauri/target');
  const executable = `performance-sqlite${process.platform === 'win32' ? '.exe' : ''}`;
  // A private copy cannot be replaced by the next owner of the shared Cargo cache.
  const directory = mkdtempSync(join(tmpdir(), 'macro-native-perf-runner-'));
  try {
    const binary = join(directory, executable);
    stageVerifiedBinary(join(target, 'debug/examples', executable), binary, identity);
    const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
    const result = execFileSync(binary, process.argv.slice(2), { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (head !== git('rev-parse', 'HEAD') || fingerprint !== sourceFingerprint()) {
      throw new Error('Sources changed during measurement; discard the report');
    }
    const measurement: unknown = JSON.parse(result);
    if (content) validateContentBaseline(measurement, pilot);
    console.log(JSON.stringify({
      provenance: { head, dirty, sourceSha256: fingerprint, binarySha256,
        cargoLockSha256: createHash('sha256').update(readFileSync(join(root, 'src-tauri/Cargo.lock'))).digest('hex'),
        cargoTargetCache: process.env.CARGO_TARGET_DIR ? 'explicit-shared-cache' : 'local-default',
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
        cargo: execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim(),
        profile: 'dev', profileOverrides: { macroDebug: 0, incremental: false,
          testMacroDebug: 0, testIncremental: false }, cargoJobs: 1, offline: true, locked: true },
      environment: { timestamp: new Date().toISOString(), platform: platform(), release: release(),
        arch: arch(), cpu: cpus()[0].model, cpuCount: cpus().length, memoryGiB: totalmem() / 2 ** 30,
        load: 'shared machine; no idle-machine or cold-OS-cache claim' },
      measurement,
    }, null, 2));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (import.meta.main) await run();
