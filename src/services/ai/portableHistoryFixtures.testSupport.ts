import { secretForms } from '../macroPilot/desktopContentHost';
import { assistantProvenance } from '../macroPilot/assistantProvenance';
import { buildAssistantProviderInputItemsFromTurn, buildChatGptProviderTurnState, buildChatGptVisibleTurnContent, buildFunctionCallOutputProviderInputItem } from './responsesCodec';
import { buildAssistantChatCompletionProviderItem, buildToolChatCompletionProviderItem } from './chatCompletionsCodec';
import { PORTABLE_SOURCE_LIMITS, normalizePortableChatHistory, portableDigest, type RawHistoryField, type RawHistoryRow, type PortableRecord, type SealedHistorySource } from './portableChatHistory';
import { PortableWorkBudget } from './portableHistoryInspection';
import { buildToolContextBlock } from './toolPresentation';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const policy = { revision: 'policy-1', secrets: secretForms(['synthetic-private-token']) };
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
    { type: 'reasoning', summary: [{ type: 'summary_text', text: reflection }], encrypted_content: 'synthetic-private-token' },
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
  const source: SealedHistorySource = { manifest: 'a'.repeat(64), limits: [...PORTABLE_SOURCE_LIMITS], async *rows() { yield* rows; }, async *relations() {}, async *read(field) { const raw = data.get(field.ordinal)!; for (let offset = 0; offset < raw.length; offset += 4093) yield raw.subarray(offset, offset + 4093); } };
  const output: { header: PortableRecord; text: string }[] = [];
  const budget = new PortableWorkBudget(128 * 1024 * 1024);
  const run = () => normalizePortableChatHistory(source, async () => policy, budget, { append: async (header, bytes) => { output.push({ header, text: decoder.decode(bytes) }); } });
  return { source, rows, data, output, budget, run, args, reflection, appendRow };
}

/** Small complete-source checkpoint from the real compaction owner, independent
 * of the large private native recipe. Used to mutate one captured dependency. */
export async function checkpointFixture() {
  const f = await fixture('codex', messages => {
    const older = Array.from({ length: 20 }, (_, i) => [`older-${i}`, 's', `turn-${i}`, 'user', `history-${i} ${'recoverable fact '.repeat(200)}`, String(i + 1), null, null, null, null, null, '[]', null, null]);
    messages.splice(1, 0, ...older);
  });
  const { mapDbMessageToChatMessage } = await import('../chatDbMappers');
  const { buildCompactedMessagesForRequest } = await import('../contextCompaction');
  const keys = ['id', 'conversation_id', 'turn_id', 'role', 'content', 'created_at', 'token_count', 'tool_traces_json', 'hidden_context', 'provider_input_items_json', 'provider_turn_state_json', 'context_refs_json', 'completion_reason', 'generation_attempts_json'];
  const messages = f.rows.filter(row => row.family === 1).map(row => mapDbMessageToChatMessage(Object.fromEntries(row.fields.map(field => [keys[field.tag], field.sql_type === 0 ? null : decoder.decode(f.data.get(field.ordinal))])) as unknown as import('../tauriIpc').DbMessage, new Map()));
  const citation: import('../../types/citation').Citation = { id: 'used', conversationId: 's', messageId: 'u', type: 'source_passage', scope: 'source', kind: 'used', title: 'Evidence', source: 'synthetic', content: 'Complete citation', timestamp: 't' };
  await f.appendRow(6, ['used', 's', 'u', 'source_passage', 'source', 'synthetic', 'Evidence', null, 'Complete citation', null, null, null, null, null, 'used', null, 't', 't']);
  const result = await buildCompactedMessagesForRequest({ systemMessage: 'Trusted local instructions', preparedMessages: messages.map(message => ({ role: message.role, content: message.content })), orderedMessages: messages, citations: [citation], toolDefinitions: [], modelContextWindowTokens: 8000, mode: 'manual', forceCompaction: true, generateSummary: async () => 'Historical checkpoint summary' });
  const state = result.compactionState;
  if (!state) throw new Error('fixture_checkpoint_not_created');
  const optionalJson = (value: unknown) => value === undefined ? null : JSON.stringify(value);
  await f.appendRow(5, [state.conversationId, state.upToMessageId, state.summaryText, JSON.stringify(state.toolDigest), JSON.stringify(state.usedSourcePassageIds), JSON.stringify(state.interestingSourcePassageIds), BigInt(state.estimatedTokensBefore), BigInt(state.estimatedTokensAfter), state.fingerprint, BigInt(state.version), JSON.stringify(state.prunedToolContextMessageIds ?? []), BigInt(state.reservedTokens ?? 0), optionalJson(state.footprintBefore), optionalJson(state.footprintAfter), state.degradedReason ?? null, state.compactionKind ?? null, state.compactionPass ?? null, BigInt(state.summaryFormatVersion!), state.summarySource ?? null, BigInt(state.policyVersion!), state.fingerprintInputsJson!, state.sourceHashesJson!, BigInt(state.modelContextWindowTokens!), state.providerId ?? null, state.modelId ?? null, state.checkpointHealth ?? null, state.lastTrigger ?? null, state.createdAt, state.updatedAt]);
  const change = async (family: number, tag: number, value: string | bigint) => {
    const field = f.rows.find(row => row.family === family)!.fields[tag];
    const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(8);
    if (typeof value === 'bigint') new DataView(bytes.buffer).setBigInt64(0, value, true);
    Object.assign(field, { sql_type: typeof value === 'string' ? 2 : 1, bytes: bytes.length, sha256: await portableDigest(bytes) }); f.data.set(field.ordinal, bytes);
  };
  return { ...f, state, change };
}
