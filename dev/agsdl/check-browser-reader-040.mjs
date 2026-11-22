/** Bundle for browsers and execute in a realm with no Node or Bun globals. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = mkdtempSync(join(tmpdir(), 'macro-agsdl040-browser-'));
try {
  const entry = join(temporary, 'entry.mjs');
  writeFileSync(entry, `import * as reader from ${JSON.stringify(join(root, 'src/vendor/agsdl/v0.4/reader.mjs'))}; globalThis.reader = reader;`);
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife', minify: false });
  assert.equal(result.success, true, result.logs.map(String).join('\n'));
  const source = await result.outputs[0].text();
  const corpus = join(root, 'dev/agsdl/fixtures/v0.4/conformance');
  const fixtures = readdirSync(join(corpus, 'cases')).filter(name => name.endsWith('.json')).map(name => ({ name, bytes: new Uint8Array(readFileSync(join(corpus, 'cases', name))) }));
  const moduleBytes = ['example', 'limited'].map(name => [name, new Uint8Array(readFileSync(join(corpus, 'modules', name, 'module.json')))]);
  const context = { TextEncoder, TextDecoder, Uint8Array, fixtures, moduleBytes };
  const reports = runInNewContext(`${source}\n
    if (typeof process !== 'undefined' || typeof Buffer !== 'undefined' || typeof Bun !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined') throw Error('Unexpected host API');
    const modules = new Map(moduleBytes.map(([name, bytes]) => [name, reader.loadHarnessModule(bytes)]));
    JSON.stringify(fixtures.map(({name, bytes}) => ({name, report:reader.read(bytes, {modules})})));
  `, context, { timeout: 30000 });
  const expected = JSON.parse(readFileSync(join(corpus, 'expected.json'), 'utf8'));
  const parsed = JSON.parse(reports);
  assert.equal(parsed.length, 147);
  for (const { name, report } of parsed) {
    if (name === 'shape-wrong-contract.json') {
      assert.equal(report.contract, 'agsdl-0.3.0');
      assert.equal(report.valid, true);
      continue;
    }
    const exp = expected[name.slice(0, -5)];
    for (const [severity, key] of [['error', 'errors'], ['warning', 'warnings']]) assert.deepEqual([...new Set(report.diagnostics.filter(d => d.severity === severity).map(d => d.code))].sort(), [...exp[key]].sort(), name);
    assert.equal(report.valid, exp.errors.length === 0, name);
  }
  console.log(`AgSDL 0.4 browser bundle: ${result.outputs[0].size} bytes, all 147 cases pass in an isolated realm without Node/Bun/network APIs. This is not a browser UI test.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
