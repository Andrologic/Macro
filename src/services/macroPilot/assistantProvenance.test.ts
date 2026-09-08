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
const nativeItem = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

it('attests provider output ranges through the actual accumulator and shared final persistence, excluding system/tool text', async () => {
  const nativeReasoning = __testables.buildChatGptVisibleTurnContent('Final native', 'Private reasoning');
  const generic = __testables.buildAssistantChatCompletionProviderItem({ apiContent: 'Final generic',
    visibleContent: '<think>Private reasoning</think>Final generic', reasoningContent: 'Private reasoning', reasoningDetails: [], toolCalls: [] });
  for (const [content, expected, providerItems] of [
    ['Plain native final', 'Plain native final', [nativeItem('Plain native final')]],
    [nativeReasoning, 'Final native', [nativeItem(nativeReasoning)]],
    [generic!.visible_content!, 'Final generic', [generic]],
  ] as const) {
    const env = setup();
    const accumulator = __testables.createStreamAccumulator({ onToken: () => undefined });
    accumulator.appendSystemChunk('\nInternal web query and tool arguments /private/tool\n');
    accumulator.appendProviderDelta(content); accumulator.flushProviderDelta();
    accumulator.appendSystemChunk('\nInternal API error detail\n');
    await persistAssistantCompletionResult(env.adapters, { assistantMessageId: env.row.id,
      result: { ...accumulator.buildResult(), providerInputItems: [...providerItems] } });
    expect(env.calls).toEqual(['message', 'receipt']);
    const attested = await env.proof.readFinal(env.row.id, env.row.content);
    expect(attested).not.toBeNull();
    expect(messageText(env.row, false, policy, attested)).toEqual({ content_state: 'complete', text: expected });
    expect(messageText(env.row, true, policy, attested)).toEqual({ content_state: 'pending', reason: 'generating' });
    expect(env.row.content).toContain('Internal web query');
    expect([...env.records.values()].join()).not.toContain('Private'); expect([...env.records.values()].join()).not.toContain('Final');
    expect(await env.proof.readFinal('different-message', env.row.content)).toBeNull();
    expect(await env.proof.readFinal(env.row.id, env.row.content + 'edited')).toBeNull();
  }
});

it('does not attest display-only results, history, partial writes, failed receipts or explicit analysis', async () => {
  const env = setup(); env.row.content = 'Historical final'; env.row.completion_reason = 'completed';
  expect(messageText(env.row, false, policy, await env.proof.readFinal(env.row.id, env.row.content)).content_state).toBe('withheld');
  await persistAssistantPartialResult(env.adapters, { id: env.row.id, conversation_id: 'chat', task_id: '', role: 'assistant', content: 'Partial', timestamp: env.row.created_at });
  expect(env.records.size).toBe(0);
  await persistAssistantCompletionResult(env.adapters, { assistantMessageId: env.row.id, result: { visibleContent: 'Display only without evidence' } });
  expect(await env.proof.readFinal(env.row.id, env.row.content)).toBeNull();
  env.failWrite();
  await persistAssistantCompletionResult(env.adapters, { assistantMessageId: env.row.id,
    result: { visibleContent: 'Saved locally', providerInputItems: [nativeItem('Saved locally')] } });
  expect(env.row.content).toBe('Saved locally'); expect(await env.proof.readFinal(env.row.id, env.row.content)).toBeNull();
  const content = '<think>first</think>private analysis'; env.row.content = content;
  env.row.provider_turn_state_json = JSON.stringify({ provider: 'chatgpt', output_items: [{ type: 'message', role: 'assistant', channel: 'analysis', status: 'completed', content: [{ type: 'output_text', text: content }] }] });
  expect(messageText(env.row, false, policy, content)).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
});

it('rejects terminal tools, unknown grammars and output mismatches instead of attesting an earlier assistant turn', async () => {
  for (const items of [
    [nativeItem('Earlier text'), { type: 'function_call_output', output: 'tool output' }],
    [{ type: 'chat_completion_message', role: 'tool', content: 'Earlier text' }],
    [{ ...nativeItem('Earlier text'), channel: 'analysis' }],
    [{ ...nativeItem('Earlier text'), status: 'in_progress' }],
    [{ type: 'chat_completion_message', role: 'assistant', content: 'Earlier text', tool_calls: [{ id: 'tool' }] }],
    [nativeItem('Unrelated provider output')],
  ]) {
    const env = setup(); await env.proof.recordFinal(env.row.id, 'Earlier text', items);
    expect(env.records.size).toBe(0);
  }
});

it('uses only the matching final provider range after multiple turns, retaining the native state veto', async () => {
  const env = setup();
  const content = 'Earlier commentary\n<think>private</think>Final native answer';
  await persistAssistantCompletionResult(env.adapters, { assistantMessageId: env.row.id,
    result: { visibleContent: content, providerInputItems: [nativeItem('Earlier commentary'), nativeItem('Final native answer')] } });
  env.row.provider_turn_state_json = JSON.stringify({ provider: 'chatgpt', output_items: [nativeItem('Final native answer')] });
  expect(messageText(env.row, false, policy).content_state).toBe('withheld');
  const attested = await env.proof.readFinal(env.row.id, env.row.content);
  expect(messageText(env.row, false, policy, attested)).toEqual({ content_state: 'complete', text: 'Final native answer' });
  env.row.provider_turn_state_json = JSON.stringify({ provider: 'chatgpt', output_items: [nativeItem('Different output')] });
  expect(messageText(env.row, false, policy, attested)).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
});
