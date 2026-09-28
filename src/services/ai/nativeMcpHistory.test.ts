import { expect, mock, test } from 'bun:test';
import type { StreamingChatOptions, LiveStreamContextSnapshot, ToolCall } from './contracts';
import fixture from '../../../src-tauri/src/commands/mcp/fixtures/typed-result.json';
import { normalizeToolResultBlocks, readTypedToolResult } from '../../shared/toolResultContent';
import { isRecord } from './jsonValues';

const ipc = await import('../tauriIpc');
const bridge = await import('../tauriRuntimeBridge');
type Request = Parameters<typeof ipc.aiStreamChat>[0];
type Submission = Parameters<typeof ipc.aiSubmitToolResult>[0];
type Handler = (event: { payload: Record<string, unknown> }) => void;
const scenarios = ['completed', 'initial-abort', 'length', 'incomplete', 'steer-abort', 'empty-steer-abort', 'steer-completed',
  'guided-retry', 'guided-abort', 'guided-stop-before-response', 'guided-recovery', 'guided-recovery-abort', 'guided-limit', 'guided-multiple', 'guided-native-satisfied', 'native-interrupt'] as const;
type Scenario = typeof scenarios[number];
let handlers = new Map<string, Handler>();
let requests: Request[] = [];
let submissions: Submission[] = [];
let scenario: Scenario = 'completed';
let controller = new AbortController();
let pendingResolutions: Array<() => void> = [];
const emit = (type: string, payload: Record<string, unknown>) => handlers.get(type)?.({ payload });
const unexecutedCall: ToolCall = { id: 'never-executed', type: 'function', function: { name: 'mcp__fixture__read', arguments: '{}' } };
const isSteer = () => scenario.includes('steer');
const isRecovery = () => scenario === 'length' || scenario === 'incomplete';
const isGuided = () => scenario.startsWith('guided-');
const guidedRecovery = () => scenario === 'guided-recovery' || scenario === 'guided-recovery-abort';

mock.module('../tauriRuntimeBridge', () => ({ ...bridge, listen: async (type: string, fn: Handler) => {
  handlers.set(type, fn);
  return () => handlers.delete(type);
} }));
mock.module('../tauriIpc', () => ({ ...ipc,
  isTauriAvailable: () => true, frontendLog: async () => {}, aiCancelStream: async () => {},
  aiStreamChat: async (request: Request) => {
    requests.push(request);
    queueMicrotask(() => {
      if ((scenario === 'guided-stop-before-response' && requests.length === 2)
        || (scenario === 'guided-recovery-abort' && requests.length === 3)) {
        controller.abort();
        return;
      }
      if ((scenario === 'guided-retry' && requests.length === 2) || (scenario === 'guided-recovery' && requests.length === 3)) {
        emit('ai:done', { request_id: request.requestId, output_text: 'Final response', completion_reason: 'completed', tool_calls: [] });
        return;
      }
      if (isRecovery() && requests.length === 2) {
        // Recovery must also discard an unexecuted call included in provider items.
        emit('ai:done', { request_id: request.requestId, output_text: 'Final response', completion_reason: 'completed',
          tool_calls: [unexecutedCall], provider_input_items: [{ type: 'function_call', call_id: unexecutedCall.id, name: unexecutedCall.function.name, arguments: '{}' }] });
        return;
      }
      for (let index = 0; index < 3; index += 1) emit('ai:tool-request', {
        request_id: request.requestId, tool_call_id: `turn-${requests.length}-call-${index}`,
        tool_name: 'mcp__fixture__read', args: { index },
      });
    });
  },
  aiSubmitToolResult: async (submission: Submission) => {
    submissions.push(submission);
    if (submissions.filter(item => item.requestId === submission.requestId).length !== 2) return;
    if (scenario === 'initial-abort' || (scenario.endsWith('abort') && requests.length === 2)) {
      controller.abort();
      return;
    }
    if (scenario !== 'empty-steer-abort') emit('ai:stream', { request_id: submission.requestId, delta: `Response ${requests.length}` });
    emit('ai:done', { request_id: submission.requestId,
      output_text: scenario === 'native-interrupt' ? 'Choose' : scenario === 'empty-steer-abort' ? '' : `Response ${requests.length}`,
      hidden_context: scenario === 'native-interrupt' ? '<questionnaire_context>fixture</questionnaire_context>' : undefined,
      accepted_submission_ids: submissions.filter(item => item.requestId === submission.requestId).map(item => item.submissionId).filter((id): id is string => !!id),
      completion_reason: isRecovery() ? scenario : guidedRecovery() && requests.length === 2 ? 'length' : 'completed',
      tool_calls: isRecovery() || (isGuided() && scenario !== 'guided-native-satisfied' && requests.length === 1) ? [unexecutedCall] : [],
    });
  },
}));
const { createNativeAdapter } = await import('./nativeAdapter');
const { createStreamAccumulator } = await import('./streamAccumulator');
const { runToolCallingLoop } = await import('./toolCallingLoop');
const { persistAssistantCompletionResult } = await import('../chatPersistenceService');
const { parseDbProviderInputItems } = await import('../chatDbMappers');
const { buildFunctionCallOutputProviderInputItem } = await import('./responsesCodec');
const blocks = normalizeToolResultBlocks(fixture.content);
const ids = (items: unknown[], type: string) => items.filter(isRecord).filter(item => item.type === type).map(item => item.call_id);

for (const mode of scenarios) {
  test(`${mode}: native executed pairs survive the loop, persistence and reload exactly once`, async () => {
    scenario = mode; requests = []; submissions = []; handlers = new Map(); controller = new AbortController(); pendingResolutions = [];
    let steerSent = false;
    const live: LiveStreamContextSnapshot[] = [];
    const oldItems = [
      { type: 'function_call', call_id: 'old-call', name: 'mcp__fixture__read', arguments: '{}' },
      buildFunctionCallOutputProviderInputItem('old-call', 'previous message', blocks),
    ];
    const options: StreamingChatOptions = {
      providerId: 'copilot', providerType: 'copilot', baseUrl: 'copilot://cli', modelId: 'fixture', signal: controller.signal,
      messages: [{ role: 'assistant', content: 'Previous message', provider_input_items: oldItems }],
      allowedToolIds: ['mcp__fixture__read', ...(isGuided() ? ['read_file'] : [])],
      ...(isGuided() ? { guidedToolRetry: { requiredToolNames: [mode === 'guided-native-satisfied' ? 'mcp__fixture__read' : 'read_file'], retrySystemPrompt: 'Read the attached file before answering.', maxRetries: mode === 'guided-limit' ? 3 : mode === 'guided-multiple' ? 2 : 1 } } : {}),
      ...(mode === 'guided-limit' ? { maxTurns: 3 } : {}),
      mcpTools: [{ id: 'mcp__fixture__read', name: 'read', serverId: 'fixture', inputSchema: { type: 'object', properties: {} } }],
      onToken() {}, onComplete() {}, onError(error) { throw error; }, onLiveContextUpdate: context => live.push(context),
      onToolCall: async (_name, args) => {
        // A still-running call must never enter the persisted executed pairs.
        if (args.index === 2) await new Promise<void>(resolve => { pendingResolutions.push(resolve); });
        if (mode === 'native-interrupt' && args.index === 1) return { kind: 'interrupt', result: 'Question queued', visibleContent: 'Choose', hiddenContext: '<questionnaire_context>fixture</questionnaire_context>' };
        return { kind: 'result', result: 'Supplied media', blocks, isError: args.index === 1 };
      },
      consumePendingSteers: () => isSteer() && !steerSent ? (steerSent = true, [{ role: 'user', content: 'Inspect another result' }]) : [],
    };
    const accumulator = createStreamAccumulator(options);
    const adapter = createNativeAdapter(options, accumulator, { disableReasoning() {}, disableEffort() {} });
    const result = await runToolCallingLoop(options, adapter, accumulator);
    pendingResolutions.forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 0));
    let stored = '';
    await persistAssistantCompletionResult({ isTauriAvailable: () => true, ipc: { ...ipc,
      updateMessage: async (_id, _text, persistenceOptions) => { stored = JSON.stringify(persistenceOptions?.providerInputItems); },
    } }, { assistantMessageId: 'fixture-message', result });
    const restored = parseDbProviderInputItems(stored)!;
    const turns = mode === 'guided-multiple' || mode === 'guided-limit' ? 3 : isSteer() || mode === 'guided-abort' || guidedRecovery() ? 2 : 1;
    const expectedIds = Array.from({ length: turns }, (_, turn) => [0, 1].map(index => `turn-${turn + 1}-call-${index}`)).flat();
    expect(ids(restored, 'function_call')).toEqual(expectedIds);
    expect(ids(restored, 'function_call_output')).toEqual(expectedIds);
    expect(submissions.map(item => item.toolCallId)).toEqual(expectedIds);
    const typed = restored.map(readTypedToolResult).filter(item => item !== undefined);
    const typedIds = mode === 'native-interrupt' ? expectedIds.slice(0, 1) : expectedIds;
    expect(typed.map(item => item.blocks)).toEqual(typedIds.map(() => blocks));
    expect(typed.map(item => item.isError)).toEqual(typedIds.map(id => id.endsWith('-1')));
    expect(JSON.stringify(restored)).not.toContain('old-call');
    expect(JSON.stringify(restored)).not.toContain('never-executed');
    expect(ids(live.at(-1)?.providerInputItems ?? [], 'function_call_output')).toEqual(expectedIds);
    for (const snapshot of live) {
      const resultIds = ids(snapshot.providerInputItems ?? [], 'function_call_output');
      expect(new Set(resultIds).size).toBe(resultIds.length);
    }
    if (isRecovery()) {
      const replay = JSON.stringify(requests[1].messages);
      expect(replay).toContain('turn-1-call-0');
      expect(replay).toContain('macro_tool_result');
      expect(replay).toContain('not sent as media by Copilot historical prompt replay');
      expect(replay).toContain('tool reported an error');
      expect(replay).not.toContain('never-executed');
      expect(requests[1].allowedToolIds).toEqual([]);
    }
    if (mode === 'guided-native-satisfied') {
      expect(requests).toHaveLength(1);
      expect(result.visibleContent).toBe('Response 1');
    }
    if (mode === 'native-interrupt') expect(result.hiddenContext).toContain('questionnaire_context');
    if (isGuided() && mode !== 'guided-native-satisfied') {
      expect(result.visibleContent).not.toContain('Response 1');
      expect(JSON.stringify(restored)).not.toContain('Response 1');
      const rejectedTurns = mode === 'guided-limit' ? 3 : mode === 'guided-multiple' ? 2 : 1;
      for (const request of requests.slice(1)) {
        const replay = JSON.stringify(request.messages);
        expect(replay).toContain('turn-1-call-0');
        expect(replay).toContain('macro_tool_result');
        expect(replay).toContain('not sent as media by Copilot historical prompt replay');
        expect(replay).toContain('tool reported an error');
        expect(replay).not.toContain('never-executed');
        for (let rejected = 1; rejected <= Math.min(rejectedTurns, requests.indexOf(request)); rejected += 1) {
          expect(replay).not.toContain(`Response ${rejected}`);
        }
      }
      if (mode === 'guided-multiple') {
        expect(result.visibleContent).toBe('Response 3');
        expect(JSON.stringify(restored)).not.toContain('Response 2');
      }
      if (mode === 'guided-recovery') expect(result.completionReason).toBe('length_recovered');
      if (mode === 'guided-limit') {
        expect(requests).toHaveLength(3);
        expect(result.visibleContent).toBe('');
        expect(restored.filter(isRecord).some(item => item.type === 'message')).toBe(false);
      }
    }
    if (isSteer() && mode !== 'empty-steer-abort') {
      const firstMessages = restored.filter(isRecord).filter(item => item.type === 'message' && JSON.stringify(item).includes('Response 1'));
      expect(firstMessages).toHaveLength(1);
    }
  });
}
