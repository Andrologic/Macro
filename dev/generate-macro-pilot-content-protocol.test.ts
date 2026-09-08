import { expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateMacroPilotContentProtocol } from './generate-macro-pilot-content-protocol';

it('keeps generated content types and browser validators current and CSP-compatible', async () => {
  const root = join(import.meta.dir, '..');
  const generated = await generateMacroPilotContentProtocol(root);
  expect(generated.validators).toBe(await readFile(join(root, 'src/services/macroPilot/contentValidators.generated.js'), 'utf8'));
  expect(generated.types).toBe(await readFile(join(root, 'src/services/macroPilot/contentTypes.generated.ts'), 'utf8'));
  expect(generated.validators).not.toMatch(/\b(?:eval|Function)\s*\(/);
  expect(generated.validators).not.toMatch(/\b(?:import)\s*\(/);
  expect(generated.validators).not.toContain('node:');
  expect(generated.validators).not.toContain('Buffer');
  expect(generated.validators).not.toContain('compileSchema');
  const directory = await mkdtemp(join(tmpdir(), 'macro-content-validator-'));
  const path = join(directory, 'validators.mjs');
  await writeFile(path, generated.validators);
  const originalFunction = globalThis.Function;
  try {
    globalThis.Function = (() => { throw new Error('CSP disallows dynamic code execution'); }) as unknown as FunctionConstructor;
    const module = await import(pathToFileURL(path).href) as { validateMessage(value: unknown): { valid: boolean } };
    const value = JSON.parse(await readFile(join(root, 'contracts/macro-pilot/v2/fixtures/valid/response-account.get.json'), 'utf8'));
    expect(module.validateMessage(value).valid).toBe(true);
    value.result.identity = {};
    expect(module.validateMessage(value).valid).toBe(false);
  } finally {
    globalThis.Function = originalFunction;
    await rm(directory, { recursive: true, force: true });
  }
});
