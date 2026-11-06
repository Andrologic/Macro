/** Development-only parity with the byte-pinned AgSDL 0.3 Python oracle. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { read, parse, stringify, loadHarnessModule } from '../../src/vendor/agsdl/v0.3/reader.mjs';
import { SchemaChecker } from '../../src/vendor/agsdl/v0.3/schemacheck.mjs';
import { Graph } from '../../src/vendor/agsdl/v0.3/graph.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = join(root, 'dev/agsdl/fixtures/v0.3');
const manifest = JSON.parse(readFileSync(join(corpus, 'provenance.json'), 'utf8'));
assert.equal(manifest.tagObject, '4dd9b647cd9d477e5d07e089f23f3a1e7728ea39');
assert.equal(manifest.commit, 'bd9f8a5b16923476fd20ac2650bd1729ee151917');
const reference = mkdtempSync(join(tmpdir(), 'macro-agsdl030-parity-'));
const files = dir => readdirSync(join(corpus, dir)).filter(name => name.endsWith('.json')).sort();
const modules = new Map(['example', 'limited'].map(name => [name, loadHarnessModule(readFileSync(join(corpus, `conformance/modules/${name}/module.json`)))]));
const normalize = report => ({
  contract: report.contract, valid: report.valid,
  diagnostics: report.diagnostics.map(({ severity, code, path, step }) => ({ severity, code, path, ...(step === undefined ? {} : { step }) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  joins: report.joins,
});
const codes = (report, severity) => [...new Set(report.diagnostics.filter(d => d.severity === severity).map(d => d.code))].sort();
const expected = JSON.parse(readFileSync(join(corpus, 'conformance/expected.json'), 'utf8'));
const cases = files('conformance/cases'), examples = files('examples'), runs = files('conformance/runs');
assert.equal(cases.length, 144); assert.equal(examples.length, 10); assert.equal(runs.length, 37);
assert.deepEqual(cases, Object.keys(expected).map(name => `${name}.json`).sort(), 'The official expected set and cases must coincide');
try {
  for (const entry of manifest.files) {
    const bytes = readFileSync(join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Pinned bytes changed: ${entry.path}`);
    const target = join(reference, entry.upstream);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
  const python = spawnSync('python3', ['-B', '-c', `
import sys,json,pathlib
root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root/'tooling'))
from agsdl import validate_bytes,validate_document,load_modules
from agsdl.jsoninput import parse_bytes
mods=load_modules(str(root/'conformance/modules'));real=load_modules(str(root/'harnesses'))
out={}
for folder, registry in [('conformance/cases',mods),('examples',real)]:
 for path in sorted((root/folder).glob('*.json')):
  out[folder+'/'+path.name]=validate_bytes(path.read_bytes(),registry).as_json()
for path in sorted((root/'conformance/runs').glob('*.json')):
 scenario=parse_bytes(path.read_bytes());doc=scenario['document']
 if isinstance(doc,str): doc=parse_bytes((root/'conformance'/doc).read_bytes())
 out['conformance/runs/'+path.name]=validate_document(doc,mods).as_json()
print(json.dumps(out))
`, reference], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(python.status, 0, python.stderr);
  const oracle = JSON.parse(python.stdout);
  let compared = 0;
  for (const name of cases) {
    const report = read(readFileSync(join(corpus, 'conformance/cases', name)), { modules });
    assert.deepEqual(codes(report, 'error'), [...expected[name.slice(0, -5)].errors].sort(), `${name}: errors`);
    assert.deepEqual(codes(report, 'warning'), [...expected[name.slice(0, -5)].warnings].sort(), `${name}: warnings`);
    assert.equal(report.valid, expected[name.slice(0, -5)].errors.length === 0, `${name}: valid`);
    assert.deepEqual(normalize(report), normalize(oracle[`conformance/cases/${name}`]), `${name}: oracle`); compared++;
  }
  for (const name of examples) {
    const report = read(readFileSync(join(corpus, 'examples', name)));
    assert.equal(report.valid, true, name);
    assert.equal(codes(report, 'warning').includes('HARNESS_UNVERIFIED'), false, name);
    assert.deepEqual(normalize(report), normalize(oracle[`examples/${name}`]), `${name}: oracle`); compared++;
  }
  const schema = new SchemaChecker(JSON.parse(readFileSync(join(root, 'src/vendor/agsdl/v0.3/schema/run-scenario.schema.json'), 'utf8')));
  for (const name of runs) {
    const parsed = parse(readFileSync(join(corpus, 'conformance/runs', name)));
    assert.equal(parsed.error, undefined, name);
    const scenario = parsed.tree;
    assert.deepEqual(schema.check(scenario), [], `${name}: scenario schema`);
    const document = typeof scenario.document === 'string' ? parse(readFileSync(join(corpus, 'conformance', scenario.document))).tree : scenario.document;
    const report = read(new TextEncoder().encode(stringify(document)), { modules });
    assert.equal(report.valid, true, name);
    assert.deepEqual(normalize(report), normalize(oracle[`conformance/runs/${name}`]), `${name}: oracle`); compared++;
    const graph = Graph.for_flow(document);
    const steps = new Map([...graph.nodes].filter(([, node]) => node.decl !== null).map(([addr, node]) => [addr, node.type]));
    for (const addr of graph.composes.keys()) if (!steps.has(addr)) steps.set(addr, 'compose');
    const check = (addr, role) => {
      assert(steps.has(addr), `${name}: unknown ${role} ${addr}`);
      if (role === 'work') assert.notEqual(steps.get(addr), 'join', `${name}: join cannot do work`);
      else if (role !== 'step') assert.equal(steps.get(addr), role, `${name}: ${addr} role`);
    };
    for (const event of scenario.timeline) { if ('work' in event) check(event.work, 'work'); for (const work of event.running ?? []) check(work.step, 'work'); }
    for (const addr of Object.keys(scenario.expect.starts ?? {})) check(addr, 'work');
    for (const message of scenario.expect.messages ?? []) { check(message.to, 'work'); for (const comment of message.comments ?? []) check(comment.step, 'approval'); }
    for (const item of scenario.expect.joins ?? []) check(item.join, 'join');
    for (const item of scenario.expect.failures ?? []) check(item.step, 'step');
    for (const item of scenario.expect.cancelled ?? []) check(item.step, 'work');
    for (const item of scenario.expect.answers ?? []) check(item.work, 'work');
  }
  console.log(`AgSDL 0.3 static parity: ${compared} reports (144 cases, 10 examples, 37 scenario documents), exact diagnostic locations and joins; ${manifest.files.length} provenance hashes verified.`);
} finally { rmSync(reference, { recursive: true, force: true }); }
