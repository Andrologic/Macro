import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse, stringify, read, loadHarnessModule } from './reader.mjs';
import { SchemaChecker } from './schemacheck.mjs';
import { consistency, validate } from './valueschema.mjs';

const tree = (source: string) => {
  const result = parse(new TextEncoder().encode(source));
  if (result.error) throw result.error;
  return result.tree;
};

describe('AgSDL 0.3 diagnostic traversal order', () => {
  test('retains numeric property order through parsing, serialization and module snapshots', () => {
    const source = '{"other":0,"2":9007199254740993,"1":0,"nested":{"9":0,"8":1}}';
    expect(stringify(tree(source))).toBe(source);
    const schema = new SchemaChecker({ type: 'object', additionalProperties: false });
    expect(schema.check(tree(source)).map(([path]) => path)).toEqual(['/other', '/2', '/1', '/nested']);
    const module = readFileSync(new URL('./harnesses/codex/module.json', import.meta.url), 'utf8');
    expect(() => loadHarnessModule(new TextEncoder().encode('{"2":0,"1":0,' + module.trim().slice(1)))).toThrow('/2:');
    const valid = loadHarnessModule(new TextEncoder().encode(module));
    Object.assign(valid, { settings: tree('{"type":"object","properties":{"2":{"type":"string","items":{"type":"string"}},"1":{"type":"string","items":{"type":"string"}}}}') });
    expect(() => read(new TextEncoder().encode('{"contract":"agsdl-0.3.0","id":"order"}'), { modules: new Map([['codex', valid]]) })).toThrow('/settings/properties/2/items');
  });
  test('mutable exact records track deletions, reinsertions and new numeric keys', () => {
    const value = tree('{"2":0,"1":0,"x":9007199254740993}') as Record<string, unknown>;
    delete value['2']; value['2'] = false;
    expect(stringify(value)).toBe('{"1":0,"x":9007199254740993,"2":false}');
    const schema = new SchemaChecker({ type: 'object', additionalProperties: false });
    expect(schema.check(value).map(([path]) => path)).toEqual(['/1', '/x', '/2']);
    const added = tree('{"x":9007199254740993}') as Record<string, unknown>;
    added['2'] = false; added['1'] = true;
    expect(stringify(added)).toBe('{"x":9007199254740993,"2":false,"1":true}');
    Object.defineProperty(added, '3', { value: null, enumerable: true, configurable: true });
    expect(Object.keys(added)).toEqual(['x', '2', '1', '3']);
    Object.freeze(added);
    expect(Object.keys(added)).toEqual(['x', '2', '1', '3']);
    expect(Object.getPrototypeOf(added)).toBeNull();
    expect(Reflect.defineProperty(added, 'later', { value: true })).toBe(false);
    expect(Reflect.deleteProperty(added, '1')).toBe(false);
    expect(Object.keys(added)).toEqual(['x', '2', '1', '3']);
  });
  test('module snapshots preserve mutation order through exact serialization', () => {
    const bytes = new TextEncoder().encode('{"contract":"agsdl-0.3.0","id":"order"}');
    const module = loadHarnessModule(readFileSync(new URL('./harnesses/codex/module.json', import.meta.url)));
    Object.assign(module, { '2': false }); Object.assign(module, { '1': true });
    expect(() => read(bytes, { modules: new Map([['codex', module]]) })).toThrow('/2:');
    Reflect.deleteProperty(module, '2'); Object.assign(module, { '2': false });
    expect(() => read(bytes, { modules: new Map([['codex', module]]) })).toThrow('/1:');
  });
  test('keeps directory permission errors in the declared source order', () => {
    const source = '{"contract":"agsdl-0.3.0","id":"order","agents":{"a":{"harness":"unknown","permissions":{"preset":"read-only","directories":{"2":"write","1":"write"}}}}}';
    const report = read(new TextEncoder().encode(source), { modules: new Map() });
    expect(report.valid).toBe(false);
    expect(report.diagnostics.map(({ code, path }) => [code, path])).toEqual([
      ['PERMISSIONS', '/agents/a/permissions/directories/2'],
      ['PERMISSIONS', '/agents/a/permissions/directories/1'],
      ['HARNESS_UNVERIFIED', '/agents/a/harness'],
    ]);
  });
  test('checks object schema children before the parent bound and array items after their bound', () => {
    const schema = tree('{"type":"object","properties":{"child":{"type":"string","items":{"type":"string"}}},"minItems":2,"maxItems":1}');
    expect(consistency(schema).map(([path]) => path)).toEqual(['/minItems', '/maxItems', '/properties/child/items', '/minItems']);
    const nested = tree('{"type":"array","minItems":2,"maxItems":1,"items":{"type":"object","properties":{"2":{"type":"string","items":{"type":"string"}},"1":{"type":"string","items":{"type":"string"}}},"minItems":2,"maxItems":1}}');
    expect(consistency(nested).map(([path]) => path)).toEqual(['/minItems', '/items/minItems', '/items/maxItems', '/items/properties/2/items', '/items/properties/1/items', '/items/minItems']);
  });
  test('validates values in source property order without losing exact tokens', () => {
    const schema = tree('{"type":"object","properties":{"2":{"type":"integer"},"1":{"type":"integer"}},"additionalProperties":false}');
    expect(validate(tree('{"2":"bad","1":"bad","0":false}'), schema).map(([path]) => path)).toEqual(['/2', '/1', '/0']);
    const value = tree('{"2":9007199254740993,"1":0,"__proto__":true}') as Record<string, unknown>;
    delete value['2']; value['new'] = true;
    expect(stringify(value)).toBe('{"1":0,"__proto__":true,"new":true}');
    expect(Object.getPrototypeOf(value)).toBeNull();
  });
});
