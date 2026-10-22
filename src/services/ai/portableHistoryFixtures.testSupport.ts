import { secretForms } from '../macroPilot/desktopContentHost';
import { assistantProvenance } from '../macroPilot/assistantProvenance';
import { buildAssistantProviderInputItemsFromTurn, buildChatGptProviderTurnState, buildChatGptVisibleTurnContent, buildFunctionCallOutputProviderInputItem } from './responsesCodec';
import { buildAssistantChatCompletionProviderItem, buildToolChatCompletionProviderItem } from './chatCompletionsCodec';
import { normalizePortableChatHistory, portableDigest, type RawHistoryField, type RawHistoryRow, type PortableRecord, type SealedHistorySource } from './portableChatHistory';
import { PortableWorkBudget } from './portableHistoryInspection';
import { buildToolContextBlock } from './toolPresentation';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const policy = { revision: 'synthetic-policy', secrets: secretForms(['fixture-private-token']) };
export async function fixture(provider: 'codex' | 'macro-ai', change?: (messages: unknown[][]) => void) {
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
  const appendRow = async (family: number, valuesForRow: unknown[]) => {
    const row = rows.length, fields: RawHistoryField[] = [];
    for (const [tag, value] of valuesForRow.entries()) {
      let raw: Uint8Array;
      const sql_type = value === null ? 0 : typeof value === 'bigint' ? 1 : value instanceof Uint8Array ? 3 : 2;
      if (sql_type === 1) { raw = new Uint8Array(8); new DataView(raw.buffer).setBigInt64(0, value as bigint, true); }
      else raw = value instanceof Uint8Array ? value : encoder.encode(value === null ? '' : String(value));
      fields.push({ ordinal, row, family, tag, sql_type, bytes: raw.length, sha256: await portableDigest(raw) }); data.set(ordinal++, raw);
    }
    rows.push({ family, row, fields });
  };
  for (const [family, valuesForRow] of values) await appendRow(family, valuesForRow);
  const source: SealedHistorySource = { manifest: 'a'.repeat(64), limits: ['not_normalized', 'not_F_admission', 'runtime_intentions_unattested'], async *rows() { yield* rows; }, async *relations() {}, async *read(field) { const raw = data.get(field.ordinal)!; for (let offset = 0; offset < raw.length; offset += 4093) yield raw.subarray(offset, offset + 4093); } };
  const output: { header: PortableRecord; text: string }[] = [];
  const budget = new PortableWorkBudget(128 * 1024 * 1024);
  const run = () => normalizePortableChatHistory(source, async () => policy, budget, { append: async (header, bytes) => { output.push({ header, text: decoder.decode(bytes) }); } });
  return { source, rows, data, output, budget, run, args, reflection, appendRow };
}
