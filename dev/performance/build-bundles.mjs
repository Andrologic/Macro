import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import config from '../../vite.config';
import { assertCleanBuildSource } from './build-provenance';

if (process.env.NODE_ENV !== 'production') throw new Error('Run with NODE_ENV=production');
const root = new URL('../../', import.meta.url);
const sha = assertCleanBuildSource(root);
const directory = mkdtempSync(join(tmpdir(), 'macro-bundle-baseline-'));
try {
  const resolved = typeof config === 'function' ? await config({ command: 'build', mode: 'production' }) : await config;
  await build({ ...resolved, root: fileURLToPath(root),
    configFile: false, logLevel: 'warn',
    build: { ...resolved.build, outDir: directory, emptyOutDir: true,
      terserOptions: { ...resolved.build?.terserOptions, maxWorkers: 2 } } });
  const output = execFileSync(process.execPath, ['--no-install', 'dev/performance/bundles.ts', join(directory, 'assets'), sha],
    { cwd: root, encoding: 'utf8' });
  process.stdout.write(output);
} finally { rmSync(directory, { recursive: true, force: true }); }
