import { expect, mock, test } from 'bun:test';
import type { StreamingChatOptions, ToolCall, LiveStreamContextSnapshot } from './contracts';
import fixture from '../../../src-tauri/src/commands/mcp/fixtures/typed-result.json';
import { normalizeToolResultBlocks, readTypedToolResult } from '../../shared/toolResultContent';
import { isRecord } from './jsonValues';
import { buildAssistantProviderInputItemsFromTurn } from './responsesCodec';

const ipc = await import('../tauriIpc');
const bridge = await import('../tauriRuntimeBridge');
const http = await import('./httpTransport');
const mcp = 'mcp__fixture__read';
const blocks = normalizeToolResultBlocks(fixture.content);
const call = (id: string, name = mcp, args: Record<string, unknown> = {}): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const modes = ['success', 'error', 'abort', 'interrupt', 'callback-abort', 'steer', 'guided', 'incomplete', 'architect', 'guided-satisfied', 'guided-satisfied-stop'] as const;
type Mode = typeof modes[number];
let mode: Mode = 'success';
let requests: string[] = [];
let handlers = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
let controller = new AbortController();
const emit = (name: string, payload: Record<string, unknown>) => handlers.get(name)?.({ payload });
function nextTurn(messages: unknown) {
  requests.push(JSON.stringify(messages));
  const turn = requests.length;
  if (mode.startsWith('guided-satisfied') && turn === 1) return { text: '', calls: [call('read', 'read_file', { file: 'fixture.txt' })], reason: 'completed' };
  if (mode === 'guided' && turn === 1) return { text: 'Rejected initial answer', calls: [call('rejected')], reason: 'completed' };
  if (mode === 'guided-satisfied-stop' && turn === 3) { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }
  const batchTurn = mode.startsWith('guided') ? 2 : 1;
  if (turn === batchTurn || (mode === 'steer' && turn === 3)) return {
    text: mode.startsWith('guided-satisfied') ? 'Accepted follow-up.' : '', reason: 'completed',
    calls: [call(`${turn}-m1`), call(`${turn}-m2`), call(`${turn}-question`, 'question', { questions: [{ id: 'choice', prompt: 'Choose', choices: ['A', 'B', 'C'] }] }), call(`${turn}-tail`)],
  };
  if (mode === 'incomplete' && turn === 2) return { text: 'Partial answer.', calls: [call('unfinished')], reason: 'length' };
  if (mode === 'architect' && turn === 2) return { text: '', calls: [], reason: 'completed' };
  return { text: 'Final answer.', calls: [], reason: 'completed' };
}
mock.module('../tauriRuntimeBridge', () => ({ ...bridge, listen: async (name: string, fn: (event: { payload: Record<string, unknown> }) => void) => {
  handlers.set(name, fn); return () => handlers.delete(name);
} }));
mock.module('../tauriIpc', () => ({ ...ipc, isTauriAvailable: () => true, frontendLog: async () => {}, aiCancelStream: async () => {},
  aiStreamChat: async (request: Parameters<typeof ipc.aiStreamChat>[0]) => {
    const turn = nextTurn(request.messages);
    queueMicrotask(() => {
      if (turn.text) emit('ai:stream', { request_id: request.requestId, delta: turn.text });
      const items = buildAssistantProviderInputItemsFromTurn(turn.text, turn.calls);
      emit('ai:done', { request_id: request.requestId, output_text: turn.text, tool_calls: turn.calls, completion_reason: turn.reason,
        provider_input_items: items, provider_turn_state: { provider: 'chatgpt', response_id: request.requestId, output_items: items },
      });
    });
  },
}));
mock.module('./httpTransport', () => ({ ...http, fetchWithTimeout: async (_url: string, init: RequestInit) => {
  const turn = nextTurn(JSON.parse(String(init.body)).messages);
  const data = { choices: [{ delta: { content: turn.text, tool_calls: turn.calls.map((item, index) => ({ ...item, index })) }, finish_reason: turn.reason === 'length' ? 'length' : turn.calls.length ? 'tool_calls' : 'stop' }] };
  return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
} }));
const { createNativeAdapter } = await import('./nativeAdapter');
const { createChatCompletionsAdapter } = await import('./chatCompletionsAdapter');
const { createStreamAccumulator } = await import('./streamAccumulator');
const { runToolCallingLoop } = await import('./toolCallingLoop');
const { persistAssistantCompletionResult } = await import('../chatPersistenceService');
const { parseDbProviderInputItems } = await import('../chatDbMappers');
function pairs(items: unknown[] = []) {
  const calls: string[] = [], outputs: string[] = [];
  for (const item of items.filter(isRecord)) {
    if (item.type === 'function_call') calls.push(String(item.call_id));
    if (item.type === 'function_call_output') outputs.push(String(item.call_id));
    if (item.type === 'chat_completion_message') {
      if (Array.isArray(item.tool_calls)) calls.push(...item.tool_calls.map(call => call.id));
      if (item.role === 'tool') outputs.push(String(item.tool_call_id));
    }
  }
  return { calls, outputs };
}
for (const transport of ['responses', 'chat-completions'] as const) for (const scenario of modes) {
  test(`${transport} frontend batch ${scenario} preserves only completed pairs through reload`, async () => {
    mode = scenario; requests = []; handlers = new Map(); controller = new AbortController();
    const executed: string[] = [], completed: string[] = [], tokens: string[] = [];
    const live: LiveStreamContextSnapshot[] = [];
    let steerSent = false;
    const options: StreamingChatOptions = {
      providerId: transport, providerType: transport === 'responses' ? 'chatgpt' : 'openai', baseUrl: 'https://example.invalid', modelId: 'fixture', messages: [], signal: controller.signal,
      allowedToolIds: [mcp, 'read_file', 'question'],
      ...(mode.startsWith('guided') ? { guidedToolRetry: { requiredToolNames: [mode === 'guided' ? 'question' : 'read_file'], retrySystemPrompt: 'Use the required tool.', maxRetries: 1 } } : {}),
      ...(mode === 'architect' ? { mode: 'Architect' as const } : {}),
      mcpTools: [{ id: mcp, name: 'read', serverId: 'fixture', inputSchema: { type: 'object', properties: {} } }],
      onToken: token => tokens.push(token), onComplete() {}, onError(error) { throw error; }, onLiveContextUpdate: snapshot => live.push(snapshot),
      onToolResult: () => { if (mode === 'callback-abort') controller.abort(); },
      consumePendingSteers: () => mode === 'steer' && !steerSent ? (steerSent = true, [{ role: 'user', content: 'Continue' }]) : [],
      onToolCall: async (name, _args, id) => {
        executed.push(id!);
        if (name === 'question' && mode === 'abort') { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }
        completed.push(id!);
        if (name === 'question' && mode === 'interrupt') return { kind: 'interrupt', result: 'Question queued', visibleContent: 'Choose', hiddenContext: '<questionnaire_context>fixture</questionnaire_context>' };
        if (name === mcp) return { kind: 'result', result: 'Supplied media', blocks, isError: mode === 'error' || id?.endsWith('-m2') };
        return { kind: 'result', result: 'Completed' };
      },
    };
    const accumulator = createStreamAccumulator(options);
    const reasoning = { disableReasoning() {}, disableEffort() {} };
    const generic = transport === 'chat-completions' ? createChatCompletionsAdapter(options, reasoning) : undefined;
    const adapter = generic?.adapter ?? createNativeAdapter(options, accumulator, reasoning);
    let result;
    try { result = await runToolCallingLoop(options, adapter, accumulator); } finally { generic?.dispose(); }
    let stored = '', storedText = '';
    await persistAssistantCompletionResult({ isTauriAvailable: () => true, ipc: { ...ipc, updateMessage: async (_id, text, opts) => { storedText = text; stored = JSON.stringify(opts?.providerInputItems); } } }, { assistantMessageId: 'fixture', result });
    const restored = parseDbProviderInputItems(stored) ?? [];
    expect(pairs(restored)).toEqual({ calls: completed, outputs: completed });
    expect(new Set(completed).size).toBe(completed.length);
    const typed = restored.filter(readTypedToolResult);
    expect(typed).toHaveLength(completed.filter(id => id !== 'read' && !id.endsWith('-question')).length);
    for (const item of typed) {
      const id = String((item as Record<string, unknown>).call_id ?? (item as Record<string, unknown>).tool_call_id);
      expect(readTypedToolResult(item)).toEqual({ version: 1, blocks, isError: mode === 'error' || id.endsWith('-m2') });
    }
    for (const snapshot of live) {
      const pair = pairs(snapshot.providerInputItems);
      expect(pair.calls).toEqual(pair.outputs);
      expect(new Set(pair.calls).size).toBe(pair.calls.length);
      for (const id of pairs(snapshot.providerTurnState?.output_items).calls) expect(pair.outputs).toContain(id);
    }
    expect(executed).not.toContain('unfinished');
    expect(executed).not.toContain('rejected');
    expect(storedText).not.toContain('Rejected initial answer');
    expect(tokens.join('')).not.toContain('Rejected initial answer');
    if (mode === 'abort' || mode === 'interrupt') expect(executed.some(id => id.endsWith('-tail'))).toBe(false);
    if (mode === 'interrupt') { expect(storedText).toBe('Choose'); expect(result.hiddenContext).toContain('questionnaire_context'); }
    if (mode.startsWith('guided-satisfied')) {
      expect(requests.some(request => request.includes('Use the required tool.'))).toBe(false);
      expect(requests).toHaveLength(3);
      expect(storedText).toContain('Accepted follow-up.');
      expect(tokens.join('')).toContain('Accepted follow-up.');
    }
    if (mode === 'incomplete') expect(result.completionReason).toBe('length_recovered');
    if (mode === 'steer') expect(completed).toHaveLength(8);
    if (mode === 'architect') expect(requests).toHaveLength(3);
  });
}
