import { expect, it } from 'bun:test';
import { NumberToken, decode } from './exact';
import { connectValueSchemaValidator030 } from './valueSchemaPort030';
it('connects reader030 schema diagnostics without converting exact AST values', () => {
  const value = decode('9007199254740993'), schema = decode('{"type":"integer"}');
  const validate = connectValueSchemaValidator030({ NumberToken, validate: (actual, constraint, path) => {
    expect(actual).toBe(value); expect(constraint).toBe(schema); expect(path).toEqual(['results', 'a/b~c']);
    return [['/results/a~1b~0c', 'Reader diagnostic']];
  } });
  expect(validate(value, schema, '/results/a~1b~0c')).toEqual([{ pointer: '/results/a~1b~0c', rule: 'VALUE_SCHEMA', message: 'Reader diagnostic' }]);
  expect(() => connectValueSchemaValidator030({ NumberToken: class Other { raw: string; constructor(raw: string) { this.raw = raw; } }, validate: () => [] })).toThrow('exact parse bridge');
});
it('bridges differing scanner classes with exact serialization and the supplied parser', () => {
  const raw: string[] = [];
  const validate = connectValueSchemaValidator030({
    NumberToken: class Other { raw: string; constructor(value: string) { this.raw = value; } },
    parse: bytes => { const text = new TextDecoder().decode(bytes); raw.push(text); return { tree: { lexical: text } }; },
    validate: (value, schema) => {
      expect(value).toEqual({ lexical: '9007199254740993' });
      expect(schema).toEqual({ lexical: '{"type":"integer"}' });
      return [];
    },
  });
  expect(validate(decode('9007199254740993'), decode('{"type":"integer"}'), '')).toEqual([]);
  expect(raw).toEqual(['9007199254740993', '{"type":"integer"}']);
});
