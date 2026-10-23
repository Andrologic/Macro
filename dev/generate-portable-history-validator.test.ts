import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
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

});
