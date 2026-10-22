import { expect, test } from 'bun:test';
import { controlledText, inspectWholeText } from '../macroPilot/conversationText';
import { parseStoredJsonStrict } from './jsonValues';
import { PortableWorkBudget, withInspectedPortableText } from './portableHistoryInspection';

const policy = { revision: 'synthetic', secrets: ['synthetic-secret'] };
test('inspects the admitted 4.9 MB value entirely, preserving ordinary display defaults', async () => {
  const bytes = 4_900_000;
  const budget = new PortableWorkBudget(bytes * 8 + 256);
  let loads = 0, inspected = 0;
  for (const offset of [0, 4090, bytes - 16]) {
    const source = 'a'.repeat(offset) + 'synthetic-secret' + 'a'.repeat(bytes - offset - 16);
    expect(controlledText(source, policy).content_state).toBe('withheld');
    await expect(withInspectedPortableText(bytes, async () => { loads++; return new TextEncoder().encode(source); }, policy, budget, false, async () => { inspected++; })).rejects.toThrow('unsafe_content');
    expect(budget.used).toBe(0);
  }
  const safe = 'a'.repeat(bytes);
  expect(inspectWholeText(safe, policy)).toBe(false);
  await withInspectedPortableText(bytes, async () => new TextEncoder().encode(safe), policy, budget, false, async text => { expect(text.length).toBe(bytes); inspected++; });
  expect(inspected).toBe(1); expect(loads).toBe(3); expect(budget.peak).toBe(bytes * 8 + 256);
  expect(controlledText('a'.repeat(20_000), policy)).toEqual({ content_state: 'excerpt', text: 'a'.repeat(16_384) });
  await expect(withInspectedPortableText(bytes, async () => { loads++; throw new Error('must not load'); }, policy, new PortableWorkBudget(128), false, async () => {})).rejects.toThrow('resource_limit');
  expect(loads).toBe(3);
  await expect(withInspectedPortableText(-1, async () => { loads++; return new Uint8Array(); }, policy, budget, false, async () => {})).rejects.toThrow('resource_limit');
  expect(loads).toBe(3);
});

test('one JSON syntax owner rejects duplicate decoded keys without confusing strings, arrays or siblings', () => {
  for (const text of ['{"id":1,"id":2}', '{"a":[{"id":1,"\\u0069d":2}]}', '{"a":{"__proto__":1,"__proto__":2}}']) expect(() => parseStoredJsonStrict(text)).toThrow('ambiguous_json');
  for (const text of ['["x",{"a":"\\\"{}:x","nested":{"a":2}},{"a":3}]', '{"a":"a:b","b":"\\\\","c":[null,true,2]}', '"string"']) expect(parseStoredJsonStrict(text)).toEqual(JSON.parse(text));
  for (const text of ['{"a":1,}', '{a:1}', '"unterminated']) expect(() => parseStoredJsonStrict(text)).toThrow();
});

test('examines decoded JSON strings and frees reservations after parse/consumer failures', async () => {
  const budget = new PortableWorkBudget(100_000);
  for (const raw of ['{"text":"synthetic-\\u0073ecret"}', '{"name":"safe","name":"other"}', '{"text":"safe"}']) {
    await expect(withInspectedPortableText(raw.length, async () => new TextEncoder().encode(raw), policy, budget, true, async () => { throw new Error('consumer_failure'); })).rejects.toThrow(raw.includes('0073') ? 'unsafe_content' : raw.includes('other') ? 'ambiguous_json' : 'consumer_failure');
    expect(budget.used).toBe(0);
  }
});

test('preserves an original UTF-8 BOM and refuses BOM JSON without stripping it', async () => {
  const raw = Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]);
  const budget = new PortableWorkBudget(100_000);
  await withInspectedPortableText(raw.length, async () => raw, policy, budget, false, async text => {
    expect(text).toBe('\uFEFFA');
    expect(new TextEncoder().encode(text)).toEqual(raw);
  });
  const json = new TextEncoder().encode('\uFEFF{"text":"value"}');
  await expect(withInspectedPortableText(json.length, async () => json, policy, budget, true, async () => { throw new Error('must not consume'); })).rejects.toThrow();
  expect(budget.used).toBe(0);
});
