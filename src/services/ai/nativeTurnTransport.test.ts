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
      accepted_submission_ids: submissions.map(item => item.submissionId).filter((id): id is string => !!id),
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
  expect(traces.filter(trace => trace.status === 'running' && trace.started_at_ms !== undefined)
    .map(trace => trace.order)).toEqual([0, 1, 2, 3]);
  expect(traces.filter(trace => trace.recovery_state === 'unknown').map(trace => trace.order))
    .toEqual([0, 1, 2, 3]);
});

test('native submissions stay ordered and ai:done waits for the submitted result', async () => {
  const gates = [deferred<void>(), deferred<void>()];
  const live: string[] = [];
  submissionGate = () => gates[submissions.length - 1].promise;
  const run = turn({ onToolCall: async (_name, args) => String(args.path),
    onLiveToolResult: item => live.push(item.toolCallId) });
  await started;
  request('first', 'read', { path: 'first.txt' });
  request('second', 'read', { path: 'second.txt' });
  await waitFor(() => submissions.length === 1);
  expect(submissions.map(item => item.toolCallId)).toEqual(['first']);
  gates[0].resolve();
  await waitFor(() => submissions.length === 2);
  expect(submissions.map(item => item.toolCallId)).toEqual(['first', 'second']);
  emit('ai:done', { request_id: requestId, output_text: 'Done', tool_calls: [],
    accepted_submission_ids: submissions.map(item => item.submissionId) });
  let completed = false;
  void run.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(completed).toBe(false);
  expect(live).toEqual([]);
  gates[1].resolve();
  const result = await run;
  expect(live).toEqual(['first', 'second']);
  expect(JSON.stringify(result.providerInputItems)).toContain('first.txt');
  expect(JSON.stringify(result.providerInputItems)).toContain('second.txt');
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

test('native cancellation from the first trace observer prevents tool execution', async () => {
  const controller = new AbortController();
  const executed = mock(async () => 'unexpected');
  const traces: ToolTrace[] = [];
  const run = turn({ signal: controller.signal, onToolCall: executed, onToolTrace: trace => {
    traces.push(trace);
    controller.abort();
  } });
  await started;
  request('read-call', 'read', { path: 'file' });
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  expect(executed).not.toHaveBeenCalled();
  expect(submissions).toEqual([]);
  expect(traces).toHaveLength(1);
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

test('failed native submission offers one error fallback and stays unknown without a receipt', async () => {
  const live = mock(() => undefined);
  const completed = mock(() => undefined);
  const traces: ToolTrace[] = [];
  submissionGate = async () => { throw new Error('submission outcome unknown'); };
  const run = turn({ onToolCall: async () => 'read succeeded', onLiveToolResult: live,
    onToolResult: completed, onToolTrace: trace => traces.push(trace) });
  await started;
  request('read-call', 'read', { path: 'file' });
  await waitFor(() => submissions.length === 2);
  await new Promise(resolve => setTimeout(resolve, 0));
  emit('ai:done', { request_id: requestId, output_text: 'Done', tool_calls: [] });
  const result = await run;
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toMatchObject({ toolCallId: 'read-call', result: 'read succeeded',
    submissionId: expect.any(String), isError: false });
  expect(submissions[1]).toMatchObject({ toolCallId: 'read-call', submissionId: expect.any(String),
    isError: true, errorKind: 'execution' });
  expect(submissions[1].submissionId).not.toBe(submissions[0].submissionId);
  expect(submissions[1].result).toContain('submission outcome unknown');
  expect(result.providerInputItems ?? []).toEqual([]);
  expect(traces.at(-1)).toMatchObject({ tool_call_id: 'read-call', status: 'running', recovery_state: 'unknown' });
  expect(live).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  expect(cancelCount).toBe(0);
});

for (const acceptedIndex of [0, 1]) {
  test(`bridge receipt selects submission ${acceptedIndex} after an IPC failure`, async () => {
    const gate = deferred<void>();
    const fallbackStarted = deferred<void>();
    const live: string[] = [];
    const notified: string[] = [];
    const mutate = mock(async () => 'write completed');
    submissionGate = async () => {
      if (submissions.length === 1) throw new Error('primary submission failed');
      emit('ai:done', { request_id: requestId, output_text: 'Done', tool_calls: [],
        accepted_submission_ids: [submissions[acceptedIndex].submissionId] });
      fallbackStarted.resolve();
      await gate.promise;
    };
    const run = turn({ onToolCall: mutate,
      onLiveToolResult: item => live.push(item.result),
      onToolResult: (_name, result) => notified.push(result) });
    await started;
    request('write-call', 'write', { path: 'file', content: 'changed' });
    await fallbackStarted.promise;
    expect(live).toEqual([]);
    gate.resolve();
    const result = await run;
    const accepted = submissions[acceptedIndex].result;
    expect(live).toEqual([accepted]);
    expect(notified).toEqual([accepted]);
    expect(JSON.stringify(result.providerInputItems)).toContain(accepted);
    expect(submissions).toHaveLength(2);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
}

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
