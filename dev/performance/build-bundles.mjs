import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import config from '../../vite.config';

if (process.env.NODE_ENV !== 'production') throw new Error('Run with NODE_ENV=production');
const root = new URL('../../', import.meta.url);
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (execFileSync('git', ['diff', 'HEAD', '--', 'src', 'public', 'vite.config.ts', 'package.json', 'bun.lock'], { cwd: root }).length) {
  throw new Error('Commit product/build changes before attributing bundle sizes to HEAD');
}
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
