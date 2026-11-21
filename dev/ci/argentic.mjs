import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const macroManifest = 'src-tauri/Cargo.toml';
const [target, command, ...args] = process.argv.slice(2);
if (!['macro', 'argentic-core', 'argentic-runtime'].includes(target) || !command) {
  throw new Error('Usage: bun dev/ci/argentic.mjs <macro|argentic-core|argentic-runtime> <cargo command> [args...]');
}

const separator = args.indexOf('--');
const cargoArgs = separator === -1 ? args : args.slice(0, separator);
const offline = cargoArgs.includes('--offline') || cargoArgs.includes('--frozen');
const metadata = spawnSync('cargo', [
  'metadata', '--manifest-path', macroManifest, '--locked', '--format-version', '1',
  ...(offline ? ['--offline'] : []),
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 20 * 1024 * 1024 });
if (metadata.error) throw metadata.error;
if (metadata.status !== 0) process.exit(metadata.status ?? 1);

const { packages } = JSON.parse(metadata.stdout);
const name = target === 'macro' ? 'argentic-core' : target;
const matches = packages.filter(pkg => pkg.name === name);
if (matches.length !== 1 || !matches[0].source?.startsWith('git+https://github.com/Andrologic/argentic.git?rev=')) {
  throw new Error(`Expected one Git-pinned ${name} dependency in Macro's lockfile`);
}

const manifest = matches[0].manifest_path;
const result = spawnSync('cargo', [
  command, '--manifest-path', target === 'macro' ? macroManifest : manifest, ...args,
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(target === 'macro'
      ? { ARGENTIC_EDITOR_PARITY_CORE: dirname(manifest) }
      : { CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? resolve('src-tauri/target') }),
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
