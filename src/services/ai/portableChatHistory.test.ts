import { expect, test } from 'bun:test';
import { portableDigest, recognizeHiddenHistory, normalizePortableChatHistory, normalizePortableChatHistoryTwoPass } from './portableChatHistory';
import { buildToolContextBlock } from './toolPresentation';
import { recognizePortableProviderItems } from './portableProviderHistory';
import { fixture, policy } from './portableHistoryFixtures.testSupport';
const encoder = new TextEncoder();
test('recognized real Codex and Macro AI producers keep exact data and exclude private continuation', async () => {
  for (const provider of ['codex', 'macro-ai'] as const) {
    const f = await fixture(provider); const first = await f.run();
    expect(f.budget.used).toBe(0);
    const archive = JSON.stringify(f.output);
    expect(archive).toContain('PROVIDER_ONLY_FACT'); expect(archive).toContain('HIDDEN_ONLY_FACT'); expect(archive).toContain('CITATION_FACT'); expect(archive).toContain(f.reflection);
    expect(archive).not.toContain('fixture-private-token');
    expect(archive).not.toContain(await portableDigest(encoder.encode('fixture-private-token')));
    const argumentRecord = f.output.find(record => record.text.includes('arguments_json'))!;
    expect(JSON.parse(argumentRecord.text).arguments_json).toBe(f.args);
    const before = f.output.splice(0); const second = await f.run();
    expect(second).toEqual(first); expect(f.output).toEqual(before);
  }
});

test('missing context, contradictory final provenance, incomplete and unknown provider shapes refuse', async () => {
  for (const mutation of [
    (messages: unknown[][]) => { messages[1][4] = 'Contradictory display'; },
    (messages: unknown[][]) => { messages[1][9] = '[{"type":"unknown_fact","text":"unique"}]'; },
    (messages: unknown[][]) => { messages[1][9] = '[{"type":"function_call_output","call_id":"missing","output":"unique"}]'; },
    (messages: unknown[][]) => { messages[0][11] = '[{"kind":"file","id":"required","title":"file"}]'; },
    (messages: unknown[][]) => { messages[1][9] = '[{"type":"message","role":"assistant","role":"user","content":[]}]'; },
    (messages: unknown[][]) => { messages[1][13] = '[{"acceptedText":"unique"}]'; },
  ]) {
    const f = await fixture('codex', mutation); await expect(f.run()).rejects.toThrow(); expect(f.budget.used).toBe(0);
  }
});

test('hidden-only inverse requires complete unambiguous producer framing', () => {
  const block = buildToolContextBlock('call&', 'read_sources', 'a"b', 'complete é🙂')!;
  expect(recognizeHiddenHistory(block)).toEqual([block]);
  for (const raw of [block + 'tail', block.replace('</tool_context>', ''), block.replace('complete', '</tool_context> complete'), '<unknown>fact</unknown>']) expect(() => recognizeHiddenHistory(raw)).toThrow();
  expect(() => recognizePortableProviderItems([{ type: 'reasoning', summary: [], remote_fact: 'unique' }])).toThrow();
});

test('policy invalidation and decoded JSON secret refuse; reservations release', async () => {
  const f = await fixture('codex', messages => { messages[1][9] = JSON.stringify([{ type: 'function_call', call_id: 'call', name: 'read_sources', arguments: '{"value":"fixture-private-\\u0074oken"}' }]); });
  await expect(f.run()).rejects.toThrow('unsafe_content'); expect(f.budget.used).toBe(0);
  const valid = await fixture('codex'); let checks = 0;
  await expect(normalizePortableChatHistory(valid.source, async () => ({ ...policy, revision: checks++ ? 'changed' : policy.revision }), valid.budget, { append: async () => {} })).rejects.toThrow('policy_changed');
  expect(valid.budget.used).toBe(0);
});

test('same visible revision with changed secret forms invalidates the operation and two-pass gap', async () => {
  const f = await fixture('codex'); let calls = 0;
  await expect(normalizePortableChatHistory(f.source, async () => ({ ...policy, secrets: calls++ ? [...policy.secrets, 'newly-configured'] : policy.secrets }), f.budget, { append: async () => {} })).rejects.toThrow('policy_changed');
  expect(f.budget.used).toBe(0);
  let policyCalls = 0, writes = 0;
  await expect(normalizePortableChatHistoryTwoPass(f.source, async () => ({ ...policy, secrets: ++policyCalls >= 4 ? [...policy.secrets, 'gap-change'] : policy.secrets }), f.budget, { append: async () => { writes++; } })).rejects.toThrow('policy_changed');
  expect(writes).toBe(0); expect(f.budget.used).toBe(0);
});

test('real user codec enrichment is retained without restoring active context references', async () => {
  const f = await fixture('codex', messages => { messages[0][9] = JSON.stringify([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original user é🙂 plus an admissible enrichment' }] }]); });
  await f.run(); expect(JSON.stringify(f.output)).toContain('admissible enrichment'); expect(f.budget.used).toBe(0);
});

test('assistant-owned required attachments refuse before a portable destination write', async () => {
  const f = await fixture('codex'); const bytes = encoder.encode('indispensable assistant asset');
  await f.appendRow(8, ['assistant-asset', 'a', 'synthetic.txt', 'text/plain', BigInt(bytes.length), await portableDigest(bytes), bytes]);
  let writes = 0;
  await expect(normalizePortableChatHistoryTwoPass(f.source, async () => policy, f.budget, { append: async () => { writes++; } })).rejects.toThrow('unsupported_assistant_asset');
  expect(writes).toBe(0); expect(f.budget.used).toBe(0);
});

test('unknown or omitted source limitations refuse before target publication', async () => {
  const f = await fixture('codex'); let writes = 0;
  for (const limits of [[...f.source.limits, 'future_unevaluated_family'], f.source.limits.filter(limit => limit !== 'browser_unobserved')]) {
    await expect(normalizePortableChatHistoryTwoPass({ ...f.source, limits }, async () => policy, f.budget, { append: async () => { writes++; } })).rejects.toThrow('integrity_failed');
  }
  expect(writes).toBe(0); expect(f.budget.used).toBe(0);
});
