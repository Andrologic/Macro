import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import {
  ModuleError, NumberToken, compareNumbers, equal, isInteger, loadHarnessModule,
  parse, read, stringify, validateExact,
} from './reader.mjs';
import type { ExactObject, ExactValue, HarnessModule030, Report030 } from './reader.mjs';
import { Report } from './validator.mjs';

const bytes = (text: string) => new TextEncoder().encode(text);
const fixtureRoot = new URL('../../../../dev/agsdl/fixtures/v0.3/', import.meta.url);
const fixture = (path: string) => new Uint8Array(readFileSync(new URL(path, fixtureRoot)));
const exact = (text: string): ExactValue => {
  const parsed = parse(bytes(text));
  if (parsed.error) throw parsed.error;
  return parsed.tree;
};
const object = (value: ExactValue): ExactObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof NumberToken) throw new Error('Expected an exact object');
  return value;
};
const modules = new Map(['example', 'limited'].map((name) => [name, loadHarnessModule(fixture(`conformance/modules/${name}/module.json`))]));
const codes = (report: Report030, severity: 'error' | 'warning'): string[] => [...new Set(report.diagnostics.filter((item) => item.severity === severity).map((item) => item.code))].sort();
const basic = (agent = '{"harness":"example","permissions":"workspace"}') => `{"contract":"agsdl-0.3.0","id":"test","agents":{"worker":${agent}}}`;
const moduleWith = (settings: string) => `{"name":"custom","version":"1.0.0","contract":"agsdl-0.3.0","harnessVersions":"*","properties":{},"permissions":${stringify(modules.get('example')!.permissions)},"settings":${settings}}`;

// All pinned cases are exercised without network access or a Python dependency.
describe('AgSDL 0.3 complete static corpus', () => {
  const expected = JSON.parse(new TextDecoder().decode(fixture('conformance/expected.json'))) as Record<string, { errors: string[]; warnings: string[] }>;
  it('has an expectation for every case and a case for every expectation', () => {
    const files = readdirSync(new URL('conformance/cases/', fixtureRoot)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    expect(files.sort()).toEqual(Object.keys(expected).sort());
    expect(files).toHaveLength(144);
  });
  for (const [name, wanted] of Object.entries(expected)) {
    it(name, () => {
      const report = read(fixture(`conformance/cases/${name}.json`), { modules });
      expect(codes(report, 'error')).toEqual(wanted.errors);
      expect(codes(report, 'warning')).toEqual(wanted.warnings);
      expect(report.valid).toBe(wanted.errors.length === 0);
    });
  }
  it('accepts all ten published examples with the default four modules', () => {
    const files = readdirSync(new URL('examples/', fixtureRoot)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(10);
    for (const file of files) {
      const report = read(fixture(`examples/${file}`));
      expect(codes(report, 'error')).toEqual([]);
      expect(codes(report, 'warning')).not.toContain('HARNESS_UNVERIFIED');
    }
  });
  it('validates all 37 run documents without claiming to execute their timelines', () => {
    const files = readdirSync(new URL('conformance/runs/', fixtureRoot)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(37);
    for (const file of files) {
      const scenario = object(parse(fixture(`conformance/runs/${file}`)).tree);
      expect(validateExact(scenario.document, { modules }).valid).toBe(true);
    }
  });
});

describe('native reports and expanded addresses', () => {
  it('validates a deep chain without a fixed composition limit', () => {
    const compositions: Record<string, unknown> = {};
    const depth = 300;
    for (let i = 0; i < depth; i++) {
      compositions[`c${i}`] = { entry: 's', outputs: ['done'], steps: { s: i === depth - 1
        ? { type: 'agent', agent: 'a', next: { output: 'done' } }
        : { type: 'compose', composition: `c${i + 1}`, next: { done: { output: 'done' } } } } };
    }
    const document = { contract: 'agsdl-0.3.0', id: 'deep', agents: { a: { harness: 'unknown', permissions: 'full' } },
      flow: { entry: 's', steps: { s: { type: 'compose', composition: 'c0', next: { done: [] } } } }, compositions };
    const report = read(bytes(JSON.stringify(document)), { modules: new Map() });
    expect(report.valid).toBe(true);
    expect(report.joins).toEqual({});
  });
  it('analyzes each binding and preserves distinct expanded diagnostics', () => {
    const document = JSON.parse(new TextDecoder().decode(fixture('conformance/cases/compose-parameter-prompt.json')));
    document.agents.b = { harness: 'example', permissions: 'full' };
    document.flow.steps.c.next.done = 'c2';
    document.flow.steps.c2 = structuredClone(document.flow.steps.c);
    document.flow.steps.c2.agents.p = 'b';
    document.flow.steps.c2.next.done = [];
    const errors = () => read(bytes(JSON.stringify(document)), { modules }).diagnostics.filter((item) => item.severity === 'error');
    expect(errors().map(({ code, path, step }) => ({ code, path, step }))).toEqual([
      { code: 'PROMPT', path: '/compositions/c/steps/z', step: ['c2', 'z'] },
    ]);
    document.flow.steps.c.agents.p = 'b';
    expect(errors().map(({ code, path, step }) => ({ code, path, step }))).toEqual([
      { code: 'PROMPT', path: '/compositions/c/steps/z', step: ['c', 'z'] },
      { code: 'PROMPT', path: '/compositions/c/steps/z', step: ['c2', 'z'] },
    ]);
    delete document.flow;
    document.compositions.unused = { entry: 'use', outputs: ['done'], steps: {
      use: { type: 'compose', composition: 'c', agents: { p: 'b' }, next: { done: { output: 'done' } } },
    } };
    expect(errors().map(({ code, path, step }) => ({ code, path, step }))).toEqual([
      { code: 'PROMPT', path: '/compositions/c/steps/z', step: undefined },
    ]);
  });
  it('checks shared instances against the agent bound in each branch', () => {
    const document = JSON.parse(new TextDecoder().decode(fixture('conformance/cases/compose-branches.json')));
    document.agents.b = { harness: 'example', permissions: 'full' };
    document.compositions.c.parameters = ['p'];
    document.compositions.c.steps.s.agent = { parameter: 'p' };
    delete document.compositions.c.steps.s.instance;
    document.flow.steps.c1.agents = { p: 'a' };
    document.flow.steps.c2.agents = { p: 'b' };
    const check = () => read(bytes(JSON.stringify(document)), { modules });
    expect(codes(check(), 'warning')).not.toContain('SHARED_INSTANCE_PARALLEL');
    document.flow.steps.c2.agents.p = 'a';
    const report = check();
    expect(report.joins).toEqual({ j: { origin: 'start', branches: ['c1', 'c2'] } });
    expect(report.diagnostics.filter((item) => item.code === 'SHARED_INSTANCE_PARALLEL')).toMatchObject([
      { severity: 'warning', path: '/compositions/c/steps/s', step: ['c2', 's'] },
    ]);
  });
  it('preserves warning severity and native fields only', () => {
    const report = read(bytes(basic()), { modules: new Map() });
    expect(report.valid).toBe(true);
    expect(codes(report, 'warning')).toEqual(['HARNESS_UNVERIFIED']);
    expect(Object.keys(report).sort()).toEqual(['contract', 'diagnostics', 'joins', 'valid']);
  });
  it('reports the authored pointer and the expanded step independently', () => {
    const report = read(fixture('conformance/cases/approval-composition-entry-resource.json'), { modules });
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      severity: 'error', code: 'MESSAGE_PATH',
      path: '/compositions/gate/steps/publish/arguments/notes/path', step: ['g', 'approve'],
    });
  });
  it('reports nested composition joins by complete address', () => {
    const report = read(fixture('conformance/cases/nested-compositions.json'), { modules });
    expect(report.joins).toEqual({
      'review/check/vote': { origin: 'review/check/spread', branches: ['r1', 'r2', 'r3'] },
    });
  });
  it('does not resolve an unbound parameter to an agent literally named null', () => {
    const document = exact(`{
      "contract":"agsdl-0.3.0","id":"parameters",
      "agents":{"null":{"harness":"example","permissions":"workspace"}},
      "compositions":{"unused":{"parameters":["worker"],"entry":"p","outputs":["done"],"steps":{
        "p":{"type":"agent","agent":{"parameter":"worker"},"next":{"step":"q","message":{"resources":{"data":{"from":["results","unknown"]}}}}},
        "q":{"type":"agent","agent":{"parameter":"worker"},"next":{"output":"done"}}
      }}}
    }`);
    expect(validateExact(document, { modules }).diagnostics).toEqual([]);
  });
  it('deduplicates exactly like Python, including message and step', () => {
    const report = new Report();
    report.error('REFERENCE', ['a/b', '~x'], 'missing', ['first', 'use']);
    report.error('REFERENCE', '/a~1b/~0x', 'missing', ['first', 'use']);
    report.error('REFERENCE', '/a~1b/~0x', 'missing');
    report.error('REFERENCE', '/a~1b/~0x', 'missing', ['second', 'use']);
    report.error('REFERENCE', '/a~1b/~0x', 'another message');
    report.warning('REFERENCE', '/a~1b/~0x', 'missing');
    expect(report.diagnostics).toHaveLength(4);
    expect(report.diagnostics.map((item) => item.step)).toEqual([['first', 'use'], ['second', 'use'], undefined, undefined]);
    const reverse = new Report();
    reverse.error('REFERENCE', '', 'missing');
    reverse.error('REFERENCE', '', 'missing', ['expanded']);
    expect(reverse.diagnostics).toHaveLength(2);
  });
});

describe('module registry boundary', () => {
  it('keeps an empty registry empty, independently of the defaults', () => {
    const document = bytes(basic('{"harness":"codex","permissions":"workspace"}'));
    expect(codes(read(document), 'warning')).not.toContain('HARNESS_UNVERIFIED');
    expect(codes(read(document, { modules: new Map() }), 'warning')).toEqual(['HARNESS_UNVERIFIED']);
  });
  it('uses the module schema root and rejects approximate planFirst.ask', () => {
    expect(() => loadHarnessModule(bytes(basic()))).toThrow(ModuleError);
    const example = modules.get('example')!;
    const invalid = { ...example, properties: { ...example.properties, 'planFirst.ask': { support: 'approximate' } } };
    expect(() => loadHarnessModule(bytes(stringify(invalid)))).toThrow(ModuleError);
    expect(() => loadHarnessModule(bytes('{"name":'))).toThrow(ModuleError);
  });
  it('rejects inconsistent settings and unsupported schema keywords', () => {
    for (const schema of [
      '{"type":"array","minItems":2,"maxItems":1}',
      '{"type":"integer","enum":[1,1.0]}',
      '{"type":"object","required":["missing"],"properties":{}}',
      '{"type":"string","pattern":"x"}',
    ]) expect(() => loadHarnessModule(bytes(moduleWith(schema)))).toThrow(ModuleError);
  });
  it('validates every supplied module, including unused entries and key/name mismatches', () => {
    const invalid = { ...modules.get('example')!, version: 'broken' };
    expect(() => read(bytes(basic()), { modules: new Map([['example', invalid]]) })).toThrow(ModuleError);
    expect(() => read(bytes(basic()), { modules: new Map([['alias', modules.get('example')!]]) })).toThrow(ModuleError);
    expect(() => read(bytes(basic()), { modules: new Map([['unused', { name: 'unused' } as HarnessModule030]]) })).toThrow(ModuleError);
  });
  it('copies nested module data before reading the document', () => {
    const module = loadHarnessModule(fixture('conformance/modules/example/module.json'));
    module.properties['model.effort'] = { support: 'native', values: ['high'] };
    const document = object(exact(basic('{"harness":"example","permissions":"workspace","model":{"effort":"high"}}')));
    const agents = document.agents;
    Object.defineProperty(document, 'agents', { enumerable: true, get() {
      module.properties['model.effort']!.values![0] = 'low';
      return agents;
    } });
    expect(validateExact(document, { modules: new Map([['example', module]]) }).valid).toBe(true);
    expect(module.properties['model.effort']!.values).toEqual(['low']);
  });
  it('retains exact numeric tokens in loaded module settings', () => {
    const text = moduleWith('{"type":"object","properties":{"limit":{"type":"number","enum":[900719925474099312345,1e999999]}}}');
    const module = loadHarnessModule(bytes(text));
    expect(module.settings!.properties!.limit.enum![0]).toBeInstanceOf(NumberToken);
    expect(stringify(module.settings!.properties!.limit.enum)).toBe('[900719925474099312345,1e999999]');
    const document = exact(basic('{"harness":"custom","permissions":"workspace","harnessSettings":{"limit":900719925474099312345}}'));
    expect(validateExact(document, { modules: new Map([['custom', module]]) }).valid).toBe(true);
  });
});

describe('exact authored numbers and reader boundaries', () => {
  it('exports the scanner token identity and exact comparisons', () => {
    const value = exact('900719925474099312345');
    expect(value).toBeInstanceOf(NumberToken);
    expect(stringify(value)).toBe('900719925474099312345');
    expect(equal(exact('1'), exact('1.0'))).toBe(true);
    expect(equal(exact('true'), exact('1'))).toBe(false);
    expect(isInteger(exact('1e999999'))).toBe(true);
    expect(compareNumbers(new NumberToken('900719925474099312345'), new NumberToken('900719925474099312346'))).toBe(-1);
    expect(codes(validateExact(new NumberToken('1'), { modules }), 'error')).toEqual(['SHAPE']);
  });
  it('compares fanout maxVisits exactly beyond the safe integer range', () => {
    const document = object(parse(fixture('conformance/cases/fanout-visits.json')).tree);
    const steps = object(object(document.flow).steps);
    const split = object(object(object(steps.plan).next).split);
    split.max = new NumberToken('900719925474099312346');
    object(steps.fix).maxVisits = new NumberToken('900719925474099312345');
    expect(codes(validateExact(document, { modules }), 'warning')).toContain('FANOUT_VISITS');
    object(steps.fix).maxVisits = new NumberToken('900719925474099312346');
    expect(codes(validateExact(document, { modules }), 'warning')).not.toContain('FANOUT_VISITS');
    object(steps.fix).maxVisits = new NumberToken('1e999999');
    expect(validateExact(document, { modules }).valid).toBe(true);
  });
  it('rejects unpaired UTF-16 surrogates in mutated exact values and keys', () => {
    for (const raw of ['\ud800', '\udc00', 'x\ud800y']) {
      const document = object(exact('{"contract":"agsdl-0.3.0","id":"test","agents":{},"content":{"item":{"value":"ok"}}}'));
      object(object(document.content).item).value = raw;
      const report = validateExact(document);
      expect(report.valid).toBe(false);
      expect(codes(report, 'error')).toEqual(['PARSE']);
      expect(() => stringify(document)).toThrow('surrogate');
      const keyDocument = object(exact('{"contract":"agsdl-0.3.0","id":"test","agents":{},"content":{"item":{"value":{}}}}'));
      object(object(object(keyDocument.content).item).value)[raw] = 'literal';
      expect(codes(validateExact(keyDocument), 'error')).toEqual(['PARSE']);
      expect(() => stringify(keyDocument)).toThrow('surrogate');
    }
    for (const raw of ['😀', '\ufffd']) {
      const document = object(exact('{"contract":"agsdl-0.3.0","id":"test","agents":{},"content":{"item":{"value":"ok"}}}'));
      object(object(document.content).item).value = raw;
      expect(validateExact(document).valid).toBe(true);
      expect(read(bytes(stringify(document))).valid).toBe(true);
    }
  });
  it('rejects invalid bytes, duplicate escaped keys, BOM and isolated surrogates', () => {
    const invalid = [
      new Uint8Array([0xff]), new Uint8Array([0xef, 0xbb, 0xbf, 123, 125]),
      bytes('{"a":1,"\\u0061":2}'), bytes('"\\ud800"'), bytes('NaN'), bytes('{} x'),
    ];
    for (const source of invalid) {
      const report = read(source);
      expect(report.valid).toBe(false);
      expect(codes(report, 'error')).toEqual(['PARSE']);
    }
  });
  it('preserves literal prototype-like value keys without confusing numeric tokens with objects', () => {
    const source = basic('{"harness":"example","permissions":"workspace","resources":{"data":{"value":{"__proto__":{"x":1},"constructor":2}}}}');
    const parsed = object(exact(source));
    const value = object(object(object(object(parsed.agents).worker).resources).data).value;
    expect(Object.hasOwn(object(value), '__proto__')).toBe(true);
    expect(stringify(value)).toBe('{"__proto__":{"x":1},"constructor":2}');
    expect(validateExact(parsed, { modules }).valid).toBe(true);
  });
  it('keeps settings enum numbers distinct even when doubles would round them together', () => {
    const module = loadHarnessModule(bytes(moduleWith('{"type":"object","properties":{"limit":{"type":"number","enum":[0.10000000000000000001]}}}')));
    const options = { modules: new Map([['custom', module]]) };
    const valid = exact(basic('{"harness":"custom","permissions":"workspace","harnessSettings":{"limit":0.10000000000000000001}}'));
    const invalid = exact(basic('{"harness":"custom","permissions":"workspace","harnessSettings":{"limit":0.10000000000000000002}}'));
    expect(validateExact(valid, options).valid).toBe(true);
    expect(codes(validateExact(invalid, options), 'error')).toContain('HARNESS_SETTINGS');
  });
});
