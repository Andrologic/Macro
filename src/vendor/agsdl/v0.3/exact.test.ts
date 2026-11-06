import { describe, expect, test } from 'bun:test';
import { parse, NumberToken, stringify } from './json.mjs';
// @ts-expect-error Historical scanner has no declaration file.
import { NumberToken as HistoricalToken } from '../experimental/readers/javascript/json.mjs';
import { equal, compareNumbers, isInteger, isNumber, isObject, json_type_matches } from './values.mjs';
import { SchemaChecker, pointer } from './schemacheck.mjs';
import { consistency, validate, descend, kind_at, is_index } from './valueschema.mjs';

const bytes = (source: string) => new TextEncoder().encode(source);
const exact = (source: string) => {
  const parsed = parse(bytes(source));
  if (parsed.error) throw parsed.error;
  return parsed.tree;
};
const n = (raw: string) => new NumberToken(raw);

describe('strict exact JSON input', () => {
  test('shares token identity and preserves raw lexemes and byte spans', () => {
    expect(NumberToken).toBe(HistoricalToken);
    const source = ' {"é/~":[9007199254740993,1.00e+9999999999999999999999,-0]} ';
    const parsed = parse(bytes(source));
    expect(parsed.error).toBeUndefined();
    const span = parsed.spans.get('/é~1~0/1')!;
    expect(new TextDecoder().decode(parsed.bytes.slice(span.start, span.end))).toBe('1.00e+9999999999999999999999');
    expect(stringify(parsed.tree)).toBe(source.trim());
    expect(parsed.spans.get('')).toEqual({ start: 1, end: bytes(source).length - 1 });
  });

  test('rejects malformed JSON, escaped duplicate keys, BOM and invalid scalars', () => {
    for (const source of ['', 'NaN', 'Infinity', '-Infinity', '01', '+1', '1.', '1e', 'true false',
      '[1,]', '{"a":1,}', '{"a":1,"\\u0061":2}', '\ufeff{}', '"\\ud800"', '"\\udc00"',
      '"\\ud800x"', '"\\ud800\\u0041"', '"\n"', '{"\\ud800":1}', '[1 2]', '{"x" 1}']) {
      const parsed = parse(bytes(source));
      expect(parsed.error, source).toBeDefined();
      expect(parsed.spans.size).toBe(0);
      expect(parsed.tree).toBeNull();
    }
    for (const data of [[34, 0xc0, 0xaf, 34], [34, 0xed, 0xa0, 0x80, 34],
      [34, 0xf4, 0x90, 0x80, 0x80, 34], [34, 0xe2, 0x82], [34, 0x80, 34]])
      expect(parse(new Uint8Array(data)).error).toBeDefined();
  });

  test('accepts scalar pairs and literal replacement characters and owns bytes', () => {
    expect(exact('"\\ud83d\\ude00"')).toBe('😀');
    expect(exact('"😀�"')).toBe('😀�');
    const input = bytes('{"__proto__":1,"constructor":2,"toString":3}');
    const parsed = parse(input);
    input.fill(0);
    expect(stringify(parsed.tree)).toBe('{"__proto__":1,"constructor":2,"toString":3}');
    expect(parsed.bytes[0]).toBe(123);
  });

  test('handles deep JSON and schema traversal without a call-stack limit', () => {
    const source = '['.repeat(4000) + '1e100000000000000000000' + ']'.repeat(4000);
    const value = exact(source);
    expect(stringify(value)).toBe(source);
    expect(equal(value, exact(source))).toBe(true);
    const recursive = { anyOf: [{ type: 'number' }, { type: 'array', items: { $ref: '#' } }] };
    expect(new SchemaChecker(recursive).check(value)).toEqual([]);
    expect(parse(bytes('['.repeat(4000) + '0')).error).toBeDefined();
  }, 30000);

  test('does not apply the editor size limit to pure JSON', () => {
    const source = JSON.stringify('x'.repeat(1024 * 1024 + 1));
    expect(parse(bytes(source)).error).toBeUndefined();
  });
});

describe('decimal arithmetic without float coercion or exponent expansion', () => {
  test('compares exact large integers, close fractions, signs and zeros', () => {
    for (const [a, b, order] of [
      ['9007199254740993', '9007199254740992', 1],
      ['1.00000000000000000001', '1.00000000000000000002', -1],
      ['1', '1.0', 0], ['1.0', '1e0', 0], ['-0e99999999999', '0', 0],
      ['1e999999999999999999999999', '9e999999999999999999999998', 1],
      ['1e-999999999999999999999999', '9e-999999999999999999999998', -1],
      ['-2e100000000000000000000', '-1e100000000000000000000', -1],
      ['1200', '12e2', 0], ['1.20', '1.20001', -1], ['-0.1', '0', -1],
    ] as const) {
      expect(compareNumbers(n(a), n(b))).toBe(order);
      expect(compareNumbers(n(b), n(a))).toBe(order === 1 ? -1 : order === -1 ? 1 : 0);
      expect(equal(n(a), n(b))).toBe(order === 0);
    }
    expect(compareNumbers(n('2e0'), 2)).toBe(0);
    expect(compareNumbers(n('1e99999999999999999999'), Number.MAX_VALUE)).toBe(1);
    expect(() => compareNumbers(n('1'), Infinity)).toThrow();
    expect(() => compareNumbers(n('1\n'), 1)).toThrow();
  });

  test('recognizes mathematical integers without safe-integer restrictions', () => {
    for (const raw of ['0', '-0.000e-99999999999999999999', '1.00', '0.01e2', '-42', '1e999999999999999999999']) {
      expect(isInteger(n(raw))).toBe(true);
      expect(is_index(n(raw))).toBe(true);
    }
    for (const raw of ['1.01', '1e-99999999999999999999', '1001e-3']) expect(isInteger(n(raw))).toBe(false);
    for (const value of [true, null, {}, [], '1', NaN, Infinity]) expect(isInteger(value)).toBe(false);
    expect(isInteger(1)).toBe(true);
    expect(isNumber(false)).toBe(false);
    expect(isObject(n('1'))).toBe(false);
    expect(json_type_matches(n('1'), 'object')).toBe(false);
  });

  test('keeps booleans, numbers and objects distinct in structural equality', () => {
    expect(equal(exact('{"a":[1,2]}'), exact('{"a":[1.0,2e0]}'))).toBe(true);
    expect(equal(exact('{"a":1,"b":2}'), exact('{"b":2,"a":1}'))).toBe(true);
    expect(equal(n('1'), true)).toBe(false);
    expect(equal(n('1'), { raw: '1' })).toBe(false);
    expect(equal([n('1')], [true])).toBe(false);
    expect(equal({}, [])).toBe(false);
    expect(equal(exact('{"__proto__":1}'), {})).toBe(false);
    expect(stringify({ count: 2, exact: n('1e9999999999999'), ok: true })).toBe('{"count":2,"exact":1e9999999999999,"ok":true}');
    expect(() => stringify({ x: Infinity })).toThrow();
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => stringify(cyclic)).toThrow();
  });
});

describe('published schema checker keywords', () => {
  test('applies $ref siblings and resolves escaped local and root references', () => {
    const checker = new SchemaChecker({ $defs: { 'a/b~c': { type: 'integer' } },
      $ref: '#/$defs/a~1b~0c', minimum: n('9007199254740993') });
    expect(checker.check(n('9007199254740992')).map(([p]) => p)).toEqual(['']);
    expect(checker.check(n('9007199254740993'))).toEqual([]);
    expect(checker.check(true).length).toBe(1);
    expect(pointer(['a/b~c', 0])).toBe('/a~1b~0c/0');
    expect(() => new SchemaChecker({ $ref: 'https://invalid.example' }).check(1)).toThrow();
  });

  test('counts Unicode scalars and uses strict pattern ends', () => {
    expect(new SchemaChecker({ minLength: 2 }).check('😀').length).toBe(1);
    expect(new SchemaChecker({ minLength: n('2') }).check('😀é')).toEqual([]);
    expect(new SchemaChecker({ pattern: '^abc$' }).check('abc\n').length).toBe(1);
    expect(new SchemaChecker({ pattern: 'abc' }).check('zabc')).toEqual([]);
    expect(new SchemaChecker({ pattern: '^x\\$$' }).check('x$')).toEqual([]);
  });

  test('checks enum, const, exact minimum, uniqueItems and prefix/items', () => {
    expect(new SchemaChecker({ enum: [n('1')] }).check(true).length).toBe(1);
    expect(new SchemaChecker({ const: n('9007199254740993') }).check(n('9007199254740992')).length).toBe(1);
    const checker = new SchemaChecker({ uniqueItems: true, prefixItems: [{ type: 'object' }], items: true,
      minItems: 1, maxItems: n('1e10000000000000000000') });
    expect(checker.check(exact('[{"v":1},{"v":1.00}]')).map(([p]) => p)).toEqual(['/1']);
    expect(new SchemaChecker({ prefixItems: [true], items: false }).check([1, 2]).map(([p]) => p)).toEqual(['/1']);
    expect(new SchemaChecker({ maxItems: 1 }).check([1, 2]).length).toBe(1);
    expect(new SchemaChecker({ minItems: n('9007199254740993') }).check([]).length).toBe(1);
  });

  test('checks object names, own properties and alternatives with deepest failure', () => {
    expect(new SchemaChecker({ required: ['toString'] }).check({}).length).toBe(1);
    const shape = { type: 'object', properties: { x: { type: 'string' } },
      propertyNames: { pattern: '^[a-z]+$' }, additionalProperties: false };
    expect(new SchemaChecker(shape).check({ X: 1, y: 2, x: 3 }).map(([p]) => p)).toEqual(['/X', '/y', '/x']);
    expect(new SchemaChecker({ anyOf: [{ type: 'string' }, shape] }).check({ x: 2 }).map(([p]) => p)).toEqual(['/x']);
    expect(new SchemaChecker({ oneOf: [true, true] }).check(null).length).toBe(1);
    expect(new SchemaChecker({ not: { required: ['x'] } }).check({ x: 1 }).length).toBe(1);
    expect(new SchemaChecker({ type: ['null', 'string'] }).check(null)).toEqual([]);
  });
});

describe('value schemas', () => {
  test('checks consistency, exact enum duplicates and bounds', () => {
    const problems = consistency(exact('{"type":"object","minItems":2,"maxItems":1,"required":["x"],"properties":{"a":{"type":"number","enum":[1,1.0,true]}}}'));
    expect(problems.map(([p]) => p).sort()).toEqual(['/minItems', '/maxItems', '/required/0', '/minItems', '/properties/a/enum/1', '/properties/a/enum/2'].sort());
    expect(consistency(exact('{"type":"array","minItems":9007199254740993,"maxItems":9007199254740992}')).length).toBe(1);
  });

  test('validates nested values and preserves error locations', () => {
    const schema = { type: 'object', properties: { a: { type: 'array', minItems: n('2'), items: { type: 'integer' } } },
      required: ['a', 'b'], additionalProperties: false };
    expect(validate(exact('{"a":[true],"x":1}'), schema).map(([p, m]) => [p, m.split(' ')[0]])).toEqual([
      ['', 'missing'], ['/a', 'expected'], ['/a/0', 'expected'], ['/x', 'unknown'],
    ]);
    expect(validate([n('1')], { type: 'array', enum: [[true]] }).length).toBe(1);
  });

  test('selects mathematical indices without converting huge numbers', () => {
    const schema = { type: 'object', properties: { list: { type: 'array', maxItems: n('9007199254740993'), items: { type: 'string' } } }, additionalProperties: false };
    expect(descend(schema, ['list', n('1.0')])).toEqual([true, null]);
    expect(descend(schema, ['list', n('9007199254740992')])).toEqual([true, null]);
    expect(descend(schema, ['list', n('9007199254740993')])[0]).toBe(false);
    expect(descend(schema, ['list', true as never])[0]).toBe(false);
    expect(descend(schema, ['unknown'])[0]).toBe(false);
    expect(descend({ type: 'object' }, ['unknown', 'x'])).toEqual([null, null]);
    expect(kind_at(schema, ['list', n('1e0')])).toBe('string');
    expect(kind_at(schema, ['list', '0'])).toBeNull();
    expect(kind_at({ type: 'array' }, [n('0'), 'x'])).toBeNull();
  });
});
