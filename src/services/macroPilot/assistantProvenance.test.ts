import { expect, it } from 'bun:test';
import { assistantProvenance, type AssistantProvenanceStorage } from './assistantProvenance';
import { persistAssistantCompletionResult, persistAssistantPartialResult, type ChatPersistenceIpc } from '../chatPersistenceService';
import { messageText } from './conversationText';
import type { DbMessage } from '../tauriIpc';
import { __testables } from '../streamingChat';

function setup() {
  const records = new Map<string, string>(); const calls: string[] = [];
  let failWrite = false;
  const storage: AssistantProvenanceStorage = {
    load: async key => records.get(key) ?? null,
    compareAndSwap: async (key, previous, next) => {
      calls.push('receipt');
      if (failWrite || (records.get(key) ?? null) !== previous) return false;
      records.set(key, next); return true;
    },
  };
  const proof = assistantProvenance(storage);
  const row: DbMessage = { id: 'assistant', conversation_id: 'chat', role: 'assistant', content: '', created_at: '2026-01-01T00:00:00Z',
    token_count: null, tool_traces_json: null, hidden_context: null, provider_input_items_json: null, provider_turn_state_json: null };
  const ipc = { updateMessage: async (_id: string, content: string) => { calls.push('message'); row.content = content; } } as ChatPersistenceIpc;
  const adapters = { isTauriAvailable: () => true, ipc, assistantProvenance: proof };
  return { row, proof, adapters, records, calls, failWrite: () => { failWrite = true; } };
}
const policy = { revision: 'visible-1', secrets: [] };

it('records exact new final content at the shared persistence boundary for native and generic provider results', async () => {
  const nativeReasoning = __testables.buildChatGptVisibleTurnContent('Final native', 'Private reasoning');
  const generic = __testables.buildAssistantChatCompletionProviderItem({ apiContent: 'Final generic',
    visibleContent: '<think>Private reasoning</think>Final generic', reasoningContent: 'Private reasoning', reasoningDetails: [], toolCalls: [] });
  for (const [content, expected, providerItems] of [
    ['Plain native final', 'Plain native final', undefined],
    [nativeReasoning, 'Final native', undefined],
    [generic!.visible_content!, 'Final generic', [generic]],
    ['First answer<think>Second private block</think>\nFinal answer', 'First answer\nFinal answer', undefined],
  ] as const) {
    const env = setup();
    await persistAssistantCompletionResult(env.adapters, { assistantMessageId: env.row.id,
      result: { visibleContent: content, hiddenContext: 'Hidden tool output', providerInputItems: providerItems ? [...providerItems] : undefined } });
    expect(env.calls).toEqual(['message', 'receipt']);
    expect(await env.proof.verifies(env.row.id, env.row.content)).toBe(true);
    expect(messageText(env.row, false, policy, true)).toEqual({ content_state: 'complete', text: expected });
    expect(messageText(env.row, true, policy, true)).toEqual({ content_state: 'pending', reason: 'generating' });
    expect([...env.records.values()].join()).not.toContain('Private'); expect([...env.records.values()].join()).not.toContain('Final');
    expect(await env.proof.verifies('different-message', content)).toBe(false);
    expect(await env.proof.verifies(env.row.id, content + 'edited')).toBe(false);
  }
});

it('does not manufacture receipts for history, partial writes, failed writes or explicit analysis', async () => {
  const env = setup(); env.row.content = 'Historical final'; env.row.completion_reason = 'completed';
  expect(messageText(env.row, false, policy, await env.proof.verifies(env.row.id, env.row.content)).content_state).toBe('withheld');
  await persistAssistantPartialResult(env.adapters, { id: env.row.id, conversation_id: 'chat', task_id: '', role: 'assistant', content: 'Partial', timestamp: env.row.created_at });
  expect(env.records.size).toBe(0);
  env.failWrite();
  await persistAssistantCompletionResult(env.adapters, { assistantMessageId: env.row.id, result: { visibleContent: 'Saved locally' } });
  expect(env.row.content).toBe('Saved locally'); expect(await env.proof.verifies(env.row.id, env.row.content)).toBe(false);
  const content = '<think>first</think>private analysis';
  env.row.content = content;
  env.row.provider_turn_state_json = JSON.stringify({ provider: 'chatgpt', output_items: [{ type: 'message', role: 'assistant', channel: 'analysis', status: 'completed', content: [{ type: 'output_text', text: content }] }] });
  expect(messageText(env.row, false, policy, true)).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
});

it('uses a matching recorded final suffix for multi-turn native state without accepting analysis or mismatches', () => {
  const env = setup(); env.row.content = 'Earlier visible commentary\n<think>private</think>Final native answer';
  env.row.provider_turn_state_json = JSON.stringify({ provider: 'chatgpt', output_items: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final native answer' }] },
  ] });
  expect(messageText(env.row, false, policy, false).content_state).toBe('withheld');
  expect(messageText(env.row, false, policy, true)).toEqual({ content_state: 'complete', text: 'Final native answer' });
  env.row.content = 'Different display answer';
  expect(messageText(env.row, false, policy, true)).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
});
