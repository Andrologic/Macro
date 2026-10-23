import { expect, test } from 'bun:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import vectors from '../contracts/macro-pilot/v2/portable-chat-history/provider-vectors.json';
import { generatePortableHistoryValidator } from './generate-portable-history-validator';

test('portable provider validator is current, standalone and CSP-compatible', async () => {
  const root = resolve(import.meta.dir, '..');
  const generated = await generatePortableHistoryValidator(root);
  expect(generated).toBe(await readFile(resolve(root, 'contracts/macro-pilot/v2/portable-chat-history/provider-validator.generated.mjs'), 'utf8'));
  expect(generated).not.toMatch(/\b(?:eval|Function)\s*\(/);
  expect(generated).not.toContain('node:'); expect(generated).not.toContain('compileSchema');
  const runtime = await readFile(resolve(root, 'contracts/macro-pilot/v2/portable-chat-history/validate.mjs'), 'utf8');
  expect(runtime).not.toContain('ajv');
  const { default: shape, clearErrors } = await import('../contracts/macro-pilot/v2/portable-chat-history/provider-validator.generated.mjs');
  const { validatePortableProviderShape } = await import('../contracts/macro-pilot/v2/portable-chat-history/validate.mjs');
  expect(() => validatePortableProviderShape([{ type: 'unknown', untrustedKey: 'synthetic' }])).toThrow('unknown_required_shape');
  expect(shape.errors).toBeNull();
  shape([{ type: 'message', role: 'assistant', content: [], unknown: 'synthetic' }]);
  clearErrors(); expect(shape.errors).toBeNull();

  const child = Bun.spawn(['node', '--disallow-code-generation-from-strings', '--input-type=module', '-e', `
    import {validatePortableProviderShape} from './contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
    validatePortableProviderShape([]);
    try {validatePortableProviderShape([{type:'unknown'}]);process.exitCode=1} catch(e) {if(e.message!=='unknown_required_shape')throw e}
  `], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  const bun = Bun.spawn(['bun', '-e', `
    globalThis.Function = () => {throw new Error('dynamic generation forbidden')};
    const {validatePortableProviderShape} = await import('./contracts/macro-pilot/v2/portable-chat-history/validate.mjs');
    validatePortableProviderShape([]);
    try {validatePortableProviderShape([{type:'unknown'}]);process.exitCode=1} catch(e) {if(e.message!=='unknown_required_shape')throw e}
  `], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(await bun.exited).toBe(0);
  const browser = await build({ entryPoints: [resolve(root, 'contracts/macro-pilot/v2/portable-chat-history/validate.mjs')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  expect(browser.outputFiles[0].text).not.toMatch(/\b(?:eval|Function)\s*\(/);
  expect(browser.outputFiles[0].text).not.toContain('node:');
  // Test-only observation of every closed compiler slot, including nested ones.
  // Instrument the generated module, then compose the actual runtime wrapper.
  const names = [...new Set([...generated.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\.errors\s*=/g)].map(match => match[1]))];
  expect(names.length).toBeGreaterThan(1);
  const observed = await build({
    stdin: { contents: `export {validatePortableProviderShape as validate} from './contracts/macro-pilot/v2/portable-chat-history/validate.mjs'; export {readErrors} from './contracts/macro-pilot/v2/portable-chat-history/provider-validator.generated.mjs';`, resolveDir: root, loader: 'js' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    plugins: [{ name: 'observe-closed-generated-errors', setup(plugin) {
      plugin.onLoad({ filter: /provider-validator\.generated\.mjs$/ }, () => ({ contents: generated + `\nexport function readErrors(){return [${names.map(name => `${name}.errors`).join(',')}]}`, loader: 'js' }));
    } }],
  });
  const directory = await mkdtemp(resolve(tmpdir(), 'portable-validator-'));
  try {
  const path = resolve(directory, 'observed.mjs'); await writeFile(path, observed.outputFiles[0].text, { mode: 0o600 });
  const instrumented = await import(pathToFileURL(path).href) as { validate(value: unknown): void; readErrors(): unknown[] };
  let branches = 0;
  const paths = (value: unknown, at: (string | number)[] = []): (string | number)[][] => {
    if (!value || typeof value !== 'object') return [];
    const children = Object.entries(value).flatMap(([key, nested]) => paths(nested, [...at, Array.isArray(value) ? Number(key) : key]));
    return Array.isArray(value) ? children : [at, ...children];
  };
  for (const vector of vectors.filter(vector => vector.valid)) for (const path of paths(vector.value)) {
    const value = structuredClone(vector.value); let selected: unknown = value;
    for (const key of path) selected = (selected as Record<string | number, unknown>)[key];
    (selected as Record<string, unknown>).synthetic_rejected_key = 'synthetic';
    expect(() => instrumented.validate(value)).toThrow('unknown_required_shape');
    expect(instrumented.readErrors().every(error => error === null)).toBe(true); branches++;
  }
  expect(branches).toBeGreaterThan(10);
  const throwing = [{ type: 'message', role: 'assistant', get content(): unknown { throw new Error('synthetic getter failure'); } }];
  expect(() => instrumented.validate(throwing)).toThrow('synthetic getter failure');
  expect(instrumented.readErrors().every(error => error === null)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
