import { beforeEach, expect, mock, test } from 'bun:test';
import type { ToolTrace } from '../../types';
import fixture from '../../../src-tauri/src/commands/mcp/fixtures/typed-result.json';
import { normalizeToolResultBlocks, readTypedToolResult } from '../../shared/toolResultContent';

const ipc = await import('../tauriIpc');
const bridge = await import('../tauriRuntimeBridge');
type Submission = Parameters<typeof ipc.aiSubmitToolResult>[0];
type Handler = (event: { payload: Record<string, unknown> }) => void;

let handlers = new Map<string, Handler>();
let requestId = '';
let streamStarted!: () => void;
let started: Promise<void>;
let submissions: Submission[] = [];
let cancelCount = 0;
let doneAfter = 0;
let submissionGate: ((submission: Submission) => Promise<void>) | undefined;
const emit = (event: string, payload: Record<string, unknown>) => handlers.get(event)?.({ payload });

mock.module('../tauriRuntimeBridge', () => ({ ...bridge, listen: async (event: string, handler: Handler) => {
  handlers.set(event, handler);
  return () => handlers.delete(event);
} }));
mock.module('../tauriIpc', () => ({ ...ipc,
  isTauriAvailable: () => true,
  aiCancelStream: async () => { cancelCount += 1; },
  aiStreamChat: async (request: Parameters<typeof ipc.aiStreamChat>[0]) => {
    requestId = request.requestId;
    streamStarted();
  },
  aiSubmitToolResult: async (submission: Submission) => {
    submissions.push(submission);
    if (submissions.length === doneAfter) emit('ai:done', {
      request_id: requestId, output_text: 'Done', tool_calls: [],
    });
    await submissionGate?.(submission);
  },
}));

const { streamNativeTurnViaTauri } = await import('./nativeTurnTransport');
type NativeParams = Parameters<typeof streamNativeTurnViaTauri>[0];

beforeEach(() => {
  handlers = new Map();
  requestId = '';
  started = new Promise(resolve => { streamStarted = resolve; });
  submissions = [];
  cancelCount = 0;
  doneAfter = 0;
  submissionGate = undefined;
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for native tool activity');
};

const turn = (overrides: Partial<NativeParams>) => streamNativeTurnViaTauri({
  providerId: 'copilot', providerType: 'copilot', modelId: 'fixture',
  messages: [], tools: [], allowedToolIds: ['read', 'write', 'question', 'mcp__fixture__read', 'unknown_tool'],
  onDelta() {}, ...overrides,
});

const request = (id: string, toolName: string, args: Record<string, unknown> = {}) => emit('ai:tool-request', {
  request_id: requestId, tool_call_id: id, tool_name: toolName, args,
});

test('native reads respect the limit and publish out-of-order completions in request order', async () => {
  doneAfter = 4;
  const gates = Array.from({ length: 4 }, () => deferred<string>());
  const running: number[] = [];
  const launched: number[] = [];
  let peak = 0;
  const live: string[][] = [];
  const traces: ToolTrace[] = [];
  const run = turn({
    onToolCall: async (_name, args) => {
      const index = args.index as number;
      launched.push(index);
      running.push(index);
      peak = Math.max(peak, running.length);
      try { return await gates[index].promise; }
      finally { running.splice(running.indexOf(index), 1); }
    },
    onToolTrace: trace => traces.push(trace),
    onLiveToolResult: result => live.push((result.providerInputItems ?? [])
      .filter((item): item is { type: string; call_id: string } => typeof item === 'object' && item !== null && 'type' in item && 'call_id' in item)
      .filter(item => item.type === 'function_call_output').map(item => item.call_id)),
  });
  await started;
  for (let index = 0; index < 4; index += 1) request(`call-${index}`, 'read', { path: `file-${index}`, index });
  expect(launched).toEqual([0, 1, 2]);
  gates[2].resolve('third');
  await waitFor(() => launched.length === 4);
  gates[1].reject(new Error('failed second read'));
  gates[3].resolve('fourth');
  await waitFor(() => running.length === 1);
  expect(submissions).toEqual([]);
  gates[0].resolve('first');
  const result = await run;
  expect(peak).toBe(3);
  expect(submissions.map(item => item.toolCallId)).toEqual(['call-0', 'call-1', 'call-2', 'call-3']);
  expect(submissions[1]).toMatchObject({ isError: true, errorKind: 'execution' });
  expect(live).toEqual([['call-0'], ['call-0', 'call-1'], ['call-0', 'call-1', 'call-2'], ['call-0', 'call-1', 'call-2', 'call-3']]);
  expect((result.providerInputItems ?? []).filter((item): item is { type: string; call_id: string } =>
    typeof item === 'object' && item !== null && 'type' in item && 'call_id' in item)
    .filter(item => item.type === 'function_call_output').map(item => item.call_id))
    .toEqual(['call-0', 'call-1', 'call-2', 'call-3']);
  expect(traces.filter(trace => trace.status === 'running').map(trace => trace.order)).toEqual([0, 1, 2, 3]);
});

for (const [barrier, args] of [
  ['write', { path: 'file', content: 'changed' }],
  ['question', { questions: [{ id: 'q', prompt: 'Choose', choices: ['A', 'B', 'C'] }] }],
  ['mcp__fixture__read', {}],
  ['unknown_tool', {}],
] as const) {
  test(`native ${barrier} is a barrier between reads`, async () => {
    doneAfter = 3;
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const launched: string[] = [];
    const run = turn({
      onToolCall: (_name, _args, id) => {
        launched.push(id ?? '');
        return gates[Number(id?.at(-1))].promise;
      },
    });
    await started;
    request('call-0', 'read', { path: 'before' });
    request('call-1', barrier, args);
    request('call-2', 'read', { path: 'after' });
    expect(launched).toEqual(['call-0']);
    gates[0].resolve('before');
    await waitFor(() => launched.length === 2);
    expect(submissions.map(item => item.toolCallId)).toEqual(['call-0']);
    gates[1].resolve('barrier');
    await waitFor(() => launched.length === 3);
    expect(submissions.map(item => item.toolCallId)).toEqual(['call-0', 'call-1']);
    gates[2].resolve('after');
    await run;
    expect(submissions.map(item => item.toolCallId)).toEqual(['call-0', 'call-1', 'call-2']);
  });
}

test('native cancellation drops running and queued tool results', async () => {
  const controller = new AbortController();
  const gates = Array.from({ length: 3 }, () => deferred<string>());
  const launched: string[] = [];
  const live = mock(() => undefined);
  const run = turn({ signal: controller.signal,
    onToolCall: (_name, _args, id) => {
      launched.push(id ?? '');
      return gates[Number(id?.at(-1))].promise;
    },
    onLiveToolResult: live,
  });
  await started;
  for (let index = 0; index < 4; index += 1) request(`call-${index}`, 'read', { path: `file-${index}` });
  expect(launched).toEqual(['call-0', 'call-1', 'call-2']);
  controller.abort();
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  gates.forEach(gate => gate.resolve('late'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancelCount).toBe(1);
  expect(launched).toEqual(['call-0', 'call-1', 'call-2']);
  expect(submissions).toEqual([]);
  expect(live).not.toHaveBeenCalled();
});

test('native question interrupt prevents a queued write from starting or submitting', async () => {
  doneAfter = 1;
  const launched: string[] = [];
  const run = turn({
    onToolCall: async (name) => {
      launched.push(name);
      return name === 'question'
        ? { kind: 'interrupt', result: 'Question queued', visibleContent: 'Choose' }
        : 'unexpected write';
    },
  });
  await started;
  request('question-call', 'question', { questions: [{ id: 'q', prompt: 'Choose', choices: ['A', 'B'] }] });
  request('write-call', 'write', { path: 'file', content: 'changed' });
  const result = await run;
  expect(launched).toEqual(['question']);
  expect(submissions).toMatchObject([{ toolCallId: 'question-call', interrupt: true }]);
  expect(result.content).toBe('Done');
});

test('failed native submission rejects without publishing success or resubmitting the call id', async () => {
  doneAfter = 1;
  const gate = deferred<void>();
  submissionGate = () => gate.promise;
  const live = mock(() => undefined);
  const completed = mock(() => undefined);
  const run = turn({ onToolCall: async () => 'read succeeded', onLiveToolResult: live, onToolResult: completed });
  await started;
  request('read-call', 'read', { path: 'file' });
  await waitFor(() => submissions.length === 1);
  gate.reject(new Error('submission outcome unknown'));
  await expect(run).rejects.toThrow('submission outcome unknown');
  expect(submissions).toEqual([{ requestId, toolCallId: 'read-call', result: 'read succeeded',
    hiddenContext: undefined, visibleContent: undefined, interrupt: undefined, isError: false, errorKind: undefined }]);
  expect(live).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  expect(cancelCount).toBe(1);
});

test('ai:done during submission waits for confirmed MCP media before completing', async () => {
  doneAfter = 1;
  const gate = deferred<void>();
  submissionGate = () => gate.promise;
  const blocks = normalizeToolResultBlocks(fixture.content);
  const live: unknown[][] = [];
  const run = turn({
    onToolCall: async () => ({ kind: 'result', result: 'MCP media', blocks }),
    onLiveToolResult: item => live.push(item.providerInputItems ?? []),
  });
  await started;
  request('mcp-call', 'mcp__fixture__read');
  await waitFor(() => submissions.length === 1);
  let completed = false;
  void run.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(completed).toBe(false);
  expect(live).toEqual([]);
  gate.resolve();
  const result = await run;
  expect(live).toHaveLength(1);
  expect((result.providerInputItems ?? []).map(readTypedToolResult).filter(Boolean).map(item => item?.blocks)).toEqual([blocks]);
  expect(live[0].map(readTypedToolResult).filter(Boolean).map(item => item?.blocks)).toEqual([blocks]);
});

test('failed submission during cancellation publishes no success', async () => {
  const controller = new AbortController();
  const gate = deferred<void>();
  submissionGate = () => gate.promise;
  const live = mock(() => undefined);
  const completed = mock(() => undefined);
  const run = turn({ signal: controller.signal, onToolCall: async () => 'read succeeded',
    onLiveToolResult: live, onToolResult: completed });
  await started;
  request('read-call', 'read', { path: 'file' });
  await waitFor(() => submissions.length === 1);
  controller.abort();
  gate.reject(new Error('cancelled submission'));
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelCount).toBe(1);
  expect(submissions).toHaveLength(1);
  expect(live).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
});

test('cancellation settles promptly while native submission remains pending', async () => {
  const controller = new AbortController();
  const gate = deferred<void>();
  submissionGate = () => gate.promise;
  const live = mock(() => undefined);
  const run = turn({ signal: controller.signal, onToolCall: async () => 'first', onLiveToolResult: live });
  await started;
  request('read-call', 'read', { path: 'file' });
  await waitFor(() => submissions.length === 1);
  controller.abort();
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  expect(live).not.toHaveBeenCalled();
  gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(live).not.toHaveBeenCalled();
});

test('a failing trace observer cannot strand native tool execution', async () => {
  doneAfter = 1;
  const run = turn({ onToolCall: async () => 'read completed', onToolTrace: () => {
    throw new Error('trace observer failed');
  } });
  await started;
  request('read-call', 'read', { path: 'file' });
  const result = await run;
  expect(submissions.map(item => item.toolCallId)).toEqual(['read-call']);
  expect(result.providerInputItems).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'function_call_output', call_id: 'read-call' }),
  ]));
});

test('native cancellation during live-result callback skips later result notification', async () => {
  doneAfter = 1;
  const controller = new AbortController();
  const notified = mock(() => undefined);
  const run = turn({
    signal: controller.signal,
    onToolCall: async () => 'first',
    onLiveToolResult: () => controller.abort(),
    onToolResult: notified,
  });
  await started;
  request('read-call', 'read', { path: 'file' });
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  expect(submissions.map(item => item.toolCallId)).toEqual(['read-call']);
  expect(notified).not.toHaveBeenCalled();
});
