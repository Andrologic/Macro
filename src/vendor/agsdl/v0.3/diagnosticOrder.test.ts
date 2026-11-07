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
