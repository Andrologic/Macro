import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'vite';
import config from '../../vite.config';
import { assertCleanBuildSource } from './build-provenance';
import { bundleGraph, deferredStartupViolations } from './bundle-graph.mjs';
import assert from 'node:assert/strict';
import postcss from 'postcss';

if (process.env.NODE_ENV !== 'production') throw new Error('Run with NODE_ENV=production');
const root = new URL('../../', import.meta.url);
const sha = assertCleanBuildSource(root);
const directory = mkdtempSync(join(tmpdir(), 'macro-bundle-baseline-'));
try {
  let graph;
  const locales = [];
  const resolved = typeof config === 'function' ? await config({ command: 'build', mode: 'production' }) : await config;
  await build({ ...resolved, root: fileURLToPath(root),
    configFile: false, logLevel: 'warn',
    plugins: [...(resolved.plugins ?? []), { name: 'performance-bundle-graph',
      enforce: 'post', writeBundle(_, bundle) {
        graph = bundleGraph(bundle, fileURLToPath(root));
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk' && chunk.facadeModuleId?.includes('/src/i18n/locales/') && chunk.facadeModuleId.endsWith('.json')) {
            locales.push({ file: chunk.fileName, source: chunk.facadeModuleId });
          }
        }
      } }],
    build: { ...resolved.build, outDir: directory, emptyOutDir: true,
      terserOptions: { ...resolved.build?.terserOptions, maxWorkers: 2 } } });
  const output = execFileSync(process.execPath, ['--no-install', 'dev/performance/bundles.ts', join(directory, 'assets'), sha],
    { cwd: root, encoding: 'utf8' });
  for (const locale of locales) {
    const emitted = await import(pathToFileURL(join(directory, locale.file)).href);
    assert.deepEqual(emitted.default, JSON.parse(readFileSync(locale.source, 'utf8')), `Locale changed: ${locale.file}`);
  }
  const scan = JSON.parse(output);
  const xtermRules = [];
  for (const row of scan.rows.filter(row => row.name.endsWith('.css'))) {
    postcss.parse(readFileSync(join(directory, 'assets', row.name), 'utf8')).walkRules(rule => {
      if (rule.selector.includes('.xterm')) xtermRules.push({ selector: rule.selector,
        declarations: rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value, Boolean(node.important)]) });
    });
  }
  assert.ok(locales.length > 0, 'No emitted locales verified');
  assert.ok(xtermRules.length > 0, 'Missing terminal styles');
  if (assertCleanBuildSource(root) !== sha) throw new Error('Source changed during build');
  const budget = spawnSync(process.execPath, ['dev/check-bundle-size.mjs', join(directory, 'assets')],
    { cwd: root, encoding: 'utf8' });
  if (budget.error) throw budget.error;
  const startupViolations = deferredStartupViolations(graph);
  console.log(JSON.stringify({ ...scan, graph, localeDefaultsVerified: locales.length, xtermRules, startupViolations,
    budget: { exitCode: budget.status, output: (budget.stdout + budget.stderr).trim() } }, null, 2));
  if (budget.status !== 0 || startupViolations.length > 0) process.exitCode = 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
