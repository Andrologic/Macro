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

async function run() {
  if (process.argv.slice(2).some((arg) => arg !== '--self-test') || process.argv.slice(2).length > 1) {
    throw new Error('Usage: bun dev/performance/native-sqlite.ts [--self-test]');
  }
  const head = git('rev-parse', 'HEAD');
  const fingerprint = sourceFingerprint();
  const dirty = Boolean(git('status', '--porcelain', '--untracked-files=all'));
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
    console.log(JSON.stringify({
      provenance: { head, dirty, sourceSha256: fingerprint, binarySha256,
        cargoTargetCache: process.env.CARGO_TARGET_DIR ? 'explicit-shared-cache' : 'local-default',
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
        cargo: execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim(),
        profile: 'dev', profileOverrides: { macroDebug: 0, incremental: false,
          testMacroDebug: 0, testIncremental: false }, cargoJobs: 1, offline: true, locked: true },
      environment: { timestamp: new Date().toISOString(), platform: platform(), release: release(),
        arch: arch(), cpu: cpus()[0].model, cpuCount: cpus().length, memoryGiB: totalmem() / 2 ** 30,
        load: 'shared machine; no idle-machine or cold-OS-cache claim' },
      measurement: JSON.parse(result),
    }, null, 2));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (import.meta.main) await run();
