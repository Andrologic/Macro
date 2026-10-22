import { expect, test } from 'bun:test';
import { assistantProvenance } from '../macroPilot/assistantProvenance';
import { buildAssistantProviderInputItemsFromTurn, buildChatGptProviderTurnState, buildChatGptVisibleTurnContent, buildFunctionCallOutputProviderInputItem } from './responsesCodec';
import { buildAssistantChatCompletionProviderItem, buildToolChatCompletionProviderItem } from './chatCompletionsCodec';
import { normalizePortableChatHistory, portableDigest, recognizeHiddenHistory, type RawHistoryField, type RawHistoryRow, type PortableRecord, type SealedHistorySource } from './portableChatHistory';
import { PortableWorkBudget } from './portableHistoryInspection';
import { buildToolContextBlock } from './toolPresentation';
import { recognizePortableProviderItems } from './portableProviderHistory';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const policy = { revision: 'synthetic-policy', secrets: ['fixture-private-token'] };
async function fixture(provider: 'codex' | 'macro-ai', change?: (messages: unknown[][]) => void) {
  const final = 'A complete final answer.';
  const reflection = 'OBSERVABLE_REFLECTION_é🙂';
  const args = '{"integer":9007199254740993,"overflow":1e400,"location":"sample"}';
  const call = { id: 'call', type: 'function' as const, function: { name: 'read_sources', arguments: args } };
  const visible = buildChatGptVisibleTurnContent(final, reflection);
  const items = provider === 'codex'
    ? [...buildAssistantProviderInputItemsFromTurn('', [call]), buildFunctionCallOutputProviderInputItem('call', 'PROVIDER_ONLY_FACT'), ...buildAssistantProviderInputItemsFromTurn(final, [])]
    : [buildAssistantChatCompletionProviderItem({ visibleContent: '', apiContent: '', reasoningContent: '', reasoningDetails: [], toolCalls: [call] }), buildToolChatCompletionProviderItem('call', 'PROVIDER_ONLY_FACT'), buildAssistantChatCompletionProviderItem({ visibleContent: visible, apiContent: final, reasoningContent: reflection, reasoningDetails: [], toolCalls: [] })];
  const state = provider === 'codex' ? buildChatGptProviderTurnState('local-session', [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: reflection }], encrypted_content: 'fixture-private-token' },
    ...buildAssistantProviderInputItemsFromTurn(final, []),
  ]) : null;
  const storedReceipts = new Map<string, string>();
  await assistantProvenance({ load: async key => storedReceipts.get(key) ?? null, compareAndSwap: async (key, _old, value) => { storedReceipts.set(key, value); return true; } }).recordFinal('a', visible, buildAssistantProviderInputItemsFromTurn(final, []));
  const messages: unknown[][] = [
    ['u', 's', 'turn', 'user', 'Original user é🙂', '000', null, null, null, null, null, '[]', null, null],
    ['a', 's', 'turn', 'assistant', visible, '001', null, '[]', buildToolContextBlock('hidden', 'read_sources', undefined, 'HIDDEN_ONLY_FACT'), JSON.stringify(items), state && JSON.stringify(state), '[]', 'final', null],
  ];
  change?.(messages);
  const values: [number, unknown[]][] = [
    [0, ['s', 'Synthetic', null, 'Chat', null, null, null, provider, 'model', null, 't', 't', null, 2n, 0n]],
    ...messages.map(row => [1, row] as [number, unknown[]]),
    ...[...storedReceipts].map(([key, value]) => [2, [key, value]] as [number, unknown[]]),
    [6, ['citation', 's', 'toolbox-only', 'document', 'context', 'synthetic', 'Toolbox source', null, 'CITATION_FACT', null, null, null, null, null, null, null, 't', 't']],
    [7, ['s', JSON.stringify([{ id: 'citation', kind: 'source', title: 'Toolbox source' }]), 't', 't']],
  ];
  const data = new Map<number, Uint8Array>(), rows: RawHistoryRow[] = [];
  let ordinal = 0;
  for (const [family, valuesForRow] of values) {
    const row = rows.length, fields: RawHistoryField[] = [];
    for (const [tag, value] of valuesForRow.entries()) {
      let raw: Uint8Array;
      const sql_type = value === null ? 0 : typeof value === 'bigint' ? 1 : 2;
      if (sql_type === 1) { raw = new Uint8Array(8); new DataView(raw.buffer).setBigInt64(0, value as bigint, true); }
      else raw = encoder.encode(value === null ? '' : String(value));
      fields.push({ ordinal, row, family, tag, sql_type, bytes: raw.length, sha256: await portableDigest(raw) }); data.set(ordinal++, raw);
    }
    rows.push({ family, row, fields });
  }
  const source: SealedHistorySource = { manifest: 'a'.repeat(64), async *rows() { yield* rows; }, async *relations() {}, async *read(field) { const raw = data.get(field.ordinal)!; for (let offset = 0; offset < raw.length; offset += 4093) yield raw.subarray(offset, offset + 4093); } };
  const output: { header: PortableRecord; text: string }[] = [];
  const budget = new PortableWorkBudget(128 * 1024 * 1024);
  const run = () => normalizePortableChatHistory(source, async () => policy, budget, { append: async (header, bytes) => { output.push({ header, text: decoder.decode(bytes) }); } });
  return { source, rows, data, output, budget, run, args, reflection };
}

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
