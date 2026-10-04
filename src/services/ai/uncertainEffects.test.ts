import { expect, test } from 'bun:test';
import { createChatToolDispatch } from '../chatToolDispatch';
import type { FrozenToolCallContext } from '../chatStreamContracts';
import type { ToolInvocation } from '../../types/generated/ipc';
import type { StreamingChatOptions, StreamMessage } from './contracts';
import { runToolCallingLoop } from './toolCallingLoop';
import { createStreamAccumulator } from './streamAccumulator';
import { parseToolTracesJson } from '../toolTraceState';
import { toSdkToolResult } from '../../../copilot-bridge/src/sdkToolResult';

// Regression of the audit's effects-probe: real dispatch, loop and accumulator,
// with an in-memory journal and a scripted provider, no network or external effect.
test('lost acknowledgement reaches the next turn and reload as uncertain with its original identity', async () => {
  const rows = new Map<string, string>();
  let effects = 0;
  const name = 'mcp__synthetic__append_event';
  const invocation = {} as ToolInvocation;
  const dispatch = createChatToolDispatch({ conversationId: 'c', turnId: 't', assistantMessageId: 'm',
    allowedToolIds: [name], signal: new AbortController().signal } as unknown as FrozenToolCallContext, {
    journal: {
      isRemoteRuntime: () => false,
      record: async input => {
        const is_new = !rows.has(input.callId);
        if (is_new) rows.set(input.callId, 'pending');
        return { is_new, invocation };
      },
      markUnknown: async input => { rows.set(input.callId, 'unknown'); return invocation; },
      complete: async input => { rows.set(input.callId, 'completed'); return invocation; },
    },
    execute: async () => { effects++; if (effects === 1) throw new Error('transport closed'); return 'appended'; },
    preserve: async (_op, _name, _id, value) => value,
    boundError: async (_op, _name, _id, error) => error,
  }, () => true, () => {});
  const options: StreamingChatOptions = { providerId: 'synthetic', providerType: 'openai', modelId: 'synthetic',
    baseUrl: 'https://example.invalid', messages: [{ role: 'user', content: 'Append one event' }],
    allowedToolIds: [name], mcpTools: [{ id: name, serverId: 'synthetic', name: 'append_event', inputSchema: { type: 'object', properties: {} } }],
    onToolCall: dispatch, onToken() {}, onComplete() {}, onError() {}, maxTurns: 5 };
  const seen: StreamMessage[][] = [];
  const result = await runToolCallingLoop(options, {
    kind: 'generic',
    streamTurn: async ({ messages }) => {
      seen.push(structuredClone(messages));
      const n = seen.length;
      return { result: { content: '', toolCalls: n <= 2 ? [{ id: `call-${n}`, type: 'function',
        function: { name, arguments: '{"event":"one"}' } }] : [], completionReason: 'completed' },
      projectAssistant: (content, tool_calls) => ({ items: [{ role: 'assistant', content, tool_calls }] }) };
    },
    projectTool: r => ({ role: 'tool', content: r.content, tool_call_id: r.tool_call_id }), afterToolResults() {},
  }, createStreamAccumulator(options));
  const first = seen[1].find(message => message.role === 'tool')!;
  expect(JSON.parse(first.content as string)).toMatchObject({ outcome: 'unknown', invocation: { callId: 'call-1' },
    instruction: expect.stringContaining('Inspect') });
  expect(result.hiddenContext).toContain(first.content as string);
  expect(rows.get('call-1')).toBe('unknown');
  expect(result.toolTraces[0]).toMatchObject({ recovery_state: 'unknown' });
  expect(parseToolTracesJson(JSON.stringify(result.toolTraces))?.[0].recovery_state).toBe('unknown');
  expect(result.toolTraces[1].recovery_state).toBe('completed');
  // A new identity is allowed: the warning is not semantic deduplication.
  expect(effects).toBe(2);
  expect(await dispatch(name, { event: 'one' }, 'call-1')).toMatchObject({ isError: true });
  expect(effects).toBe(2);
  const sdk = toSdkToolResult({ result: first.content as string, isError: true, errorKind: 'uncertain' });
  expect(sdk).toMatchObject({ textResultForLlm: first.content, toolTelemetry: { error_kind: 'uncertain' } });
});
