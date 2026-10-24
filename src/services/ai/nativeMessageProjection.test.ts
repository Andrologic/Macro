import { expect, test } from 'bun:test';
import { projectNativeMessages } from './nativeMessageProjection';
import type { StreamMessage } from './contracts';

test('native DTO projection keeps historical tools, images and provider replay on their existing paths', () => {
  const items = [{ type: 'function_call_output', call_id: 'historical-call', output: 'complete result' }];
  const state = { provider: 'chatgpt', output_items: items } as StreamMessage['provider_turn_state'];
  const messages: StreamMessage[] = [{ role: 'assistant', content: 'historical call',
    tool_calls: [{ id: 'historical-call', type: 'function', function: { name: 'read_sources', arguments: '{}' } }],
    provider_input_items: items, provider_turn_state: state },
    { role: 'tool', content: 'complete result', tool_call_id: 'historical-call' },
    { role: 'user', content: [{ type: 'text', text: 'image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic' } }] }];
  const codex = projectNativeMessages(messages, 'chatgpt');
  expect(codex[0]?.provider_turn_state).toBe(state); expect(codex[0]?.provider_input_items).toBe(items);
  expect(codex[0]?.tool_calls).toBe(messages[0]?.tool_calls); expect(codex[1]?.tool_call_id).toBe('historical-call');
  expect(codex[2]?.content).toBe(messages[2]?.content);
  const macro = projectNativeMessages(messages, 'openai');
  expect(macro[0]).not.toHaveProperty('provider_turn_state'); expect(macro[0]?.provider_input_items).toBe(items);
  expect(messages[0]?.provider_turn_state).toBe(state);
});
