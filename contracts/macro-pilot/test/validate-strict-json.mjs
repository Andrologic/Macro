import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStoredJsonStrict } from '../v2/strict-json.mjs';

const privateText = 'synthetic-private-value';
for (const raw of [
  '{"id":1,"id":2}', '{"a":[{"id":1,"\\u0069d":2}]}',
  '{"a":{"__proto__":1,"__proto__":2}}', '{"a":1,"\\u0061":2}',
  '{"é":1,"\\u00e9":2}', '{"🙂":1,"\\ud83d\\ude42":2}',
  `{"${privateText}":1,"${privateText}":2}`,
]) assert.throws(() => parseStoredJsonStrict(raw), { message: 'ambiguous_json' });
for (const raw of [
  '["x",{"a":"\\\"{}:x","nested":{"a":2}},{"a":3}]',
  '{"a":"a:b","b":"\\\\","c":[null,true,2]}', '"string"', 'null', '42',
  '[{"a":1},{"a":2}]', '{"__proto__":1,"constructor":2}',
  '{"x":"\\\\\\\" braces } ] { [ :","y":{"x":2}}',
  '{"a":{"x":1},"b":{"x":2}}', '{"a" \r\n\t : 1}',
  JSON.stringify({ nested: Array.from({ length: 200 }, (_, i) => ({ id: i, text: 'é🙂' })) }),
]) assert.deepEqual(parseStoredJsonStrict(raw), JSON.parse(raw));
for (const raw of ['{"a":1,}', '{a:1}', '"unterminated', `{${privateText}`, undefined, {}, 1]) {
  assert.throws(() => parseStoredJsonStrict(raw), { message: 'invalid_json' });
}
const source = readFileSync(new URL('../v2/strict-json.mjs', import.meta.url), 'utf8');
assert.ok(!/\bimport\b|\bBuffer\b|\bprocess\b/.test(source), 'shared parser must remain portable');
console.log('Strict JSON: syntax owner, decoded duplicate keys, scopes, escapes and fixed diagnostics passed.');
