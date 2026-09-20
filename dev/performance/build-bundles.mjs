import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'vite';
import config from '../../vite.config';
import { assertCleanBuildSource } from './build-provenance';
import { bundleGraph } from './bundle-graph.mjs';

if (process.env.NODE_ENV !== 'production') throw new Error('Run with NODE_ENV=production');
const root = new URL('../../', import.meta.url);
const sha = assertCleanBuildSource(root);
const directory = mkdtempSync(join(tmpdir(), 'macro-bundle-baseline-'));
try {
  let graph;
  const resolved = typeof config === 'function' ? await config({ command: 'build', mode: 'production' }) : await config;
  await build({ ...resolved, root: fileURLToPath(root),
    configFile: false, logLevel: 'warn',
    plugins: [...(resolved.plugins ?? []), { name: 'performance-bundle-graph',
      enforce: 'post', writeBundle(_, bundle) { graph = bundleGraph(bundle, fileURLToPath(root)); } }],
    build: { ...resolved.build, outDir: directory, emptyOutDir: true,
      terserOptions: { ...resolved.build?.terserOptions, maxWorkers: 2 } } });
  const output = execFileSync(process.execPath, ['--no-install', 'dev/performance/bundles.ts', join(directory, 'assets'), sha],
    { cwd: root, encoding: 'utf8' });
  if (assertCleanBuildSource(root) !== sha) throw new Error('Source changed during build');
  const budget = spawnSync(process.execPath, ['dev/check-bundle-size.mjs', join(directory, 'assets')],
    { cwd: root, encoding: 'utf8' });
  if (budget.error) throw budget.error;
  console.log(JSON.stringify({ ...JSON.parse(output), graph,
    budget: { exitCode: budget.status, output: (budget.stdout + budget.stderr).trim() } }, null, 2));
  if (budget.status !== 0) process.exitCode = 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
