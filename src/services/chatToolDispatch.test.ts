import { StreamStopUnconfirmedError } from './ai/streamCancellation';
import { ToolResultPreservationError } from './toolResultArtifacts';
import { describe, expect, mock, test } from 'bun:test';
import { createChatToolDispatch, classifyChatToolEffect, type ChatToolDispatchPorts, type ChatToolInvocationJournal } from './chatToolDispatch';
import type { FrozenToolCallContext } from './chatStreamContracts';
import type { ToolInvocation } from '../types/generated/ipc';
import { chatToolInvocationJournal } from './chatToolInvocationJournal';
import { __remoteKernelApiTestables, executeRemoteWorkspaceTool } from './remoteKernelApi';

const invocation = {} as ToolInvocation;

function fixture() {
  const events: string[] = [];
  const controller = new AbortController();
  const operation = {
    conversationId: 'conversation', turnId: 'turn', assistantMessageId: 'message',
    signal: controller.signal, allowedToolIds: ['read', 'write'],
  } as unknown as FrozenToolCallContext;
  const recorded = new Set<string>();
  const journal: ChatToolInvocationJournal = {
    isRemoteRuntime: () => false,
    record: mock(async (input) => {
      events.push(`record:${input.toolName}:${input.effectClass}`);
      const key = `${input.conversationId}:${input.turnId}:${input.messageId}:${input.callId}`;
      const is_new = !recorded.has(key);
      recorded.add(key);
      return { invocation, is_new };
    }),
    complete: mock(async () => { events.push('complete'); return invocation; }),
    markUnknown: mock(async () => { events.push('unknown'); return invocation; }),
  };
  const execute = mock<ChatToolDispatchPorts['execute']>(async () => { events.push('execute'); return 'confirmed result'; });
  const preserve = mock<ChatToolDispatchPorts['preserve']>(async (_operation, _name, _callId, value) => {
    events.push('preserve');
    return value;
  });
  const dispatch = createChatToolDispatch(operation, {
    journal, execute, preserve,
    boundError: async (_operation, _name, _callId, error) => error,
  }, () => true, () => {});
  return { operation, controller, journal, execute, preserve, dispatch, events };
}

describe('durable Chat tool dispatch', () => {
  test('records before effect, completes after executor response, and refuses a duplicate', async () => {
    const f = fixture();
    expect(await f.dispatch('write', { path: 'file.txt', content: 'text' }, 'call')).toBe('confirmed result');
    expect(f.events).toEqual(['record:write:workspace_mutation', 'execute', 'preserve', 'complete']);
    expect((f.journal.record as ReturnType<typeof mock>).mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'conversation', turnId: 'turn', messageId: 'message', callId: 'call',
      arguments: { path: 'file.txt', content: 'text' }, remoteExecutionId: null,
    });
    expect(await f.dispatch('write', { path: 'file.txt', content: 'text' }, 'call')).toMatchObject({ isError: true });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.journal.complete).toHaveBeenCalledTimes(1);
  });

  test('fails closed when identity or journal is unavailable', async () => {
    const f = fixture();
    expect(await f.dispatch('write', {}, undefined)).toMatchObject({ isError: true });
    expect(await f.dispatch('write', {}, '')).toMatchObject({ isError: true });
    expect(f.journal.record).not.toHaveBeenCalled();
    f.journal.record = async () => { throw new Error('database offline'); };
    expect(await f.dispatch('read', {}, 'read-call')).toMatchObject({ isError: true });
    expect(f.execute).not.toHaveBeenCalled();
  });

  test('marks unknown on abort, transport failure, or missing response', async () => {
    const stopped = fixture();
    stopped.execute.mockImplementation(async () => {
      stopped.controller.abort();
      return 'late result';
    });
    expect(await stopped.dispatch('write', {}, 'stop')).toMatchObject({ errorKind: 'uncertain' });
    expect(stopped.events).toContain('unknown');
    expect(stopped.journal.complete).not.toHaveBeenCalled();

    const failed = fixture();
    failed.execute.mockImplementation(async () => { throw new Error('transport lost'); });
    expect(await failed.dispatch('write', {}, 'failure')).toMatchObject({ errorKind: 'uncertain' });
    await Promise.resolve();
    expect(failed.events).toContain('unknown');
    expect(failed.journal.complete).not.toHaveBeenCalled();

    const empty = fixture();
    empty.execute.mockImplementation(async () => undefined);
    expect(await empty.dispatch('read', {}, 'empty')).toMatchObject({ isError: true });
    expect(empty.events).toContain('unknown');
  });

  test('does not start an effect after an abort while the intent is being recorded', async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.journal.record = async () => {
      await pending;
      return { invocation, is_new: true };
    };
    const result = f.dispatch('write', {}, 'pending');
    f.controller.abort();
    release();
    expect(await result).toMatchObject({ errorKind: 'aborted' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.events).toContain('unknown');
  });

  test('marks an unconfirmed completion unknown after an executor response', async () => {
    const f = fixture();
    f.journal.complete = async () => { throw new Error('commit failed'); };
    expect(await f.dispatch('write', {}, 'unconfirmed')).toMatchObject({ isError: true });
    expect(f.events).toEqual(['record:write:workspace_mutation', 'execute', 'preserve', 'unknown']);
  });

  test('keeps an invocation unknown if result preservation fails or is interrupted', async () => {
    const failed = fixture();
    failed.preserve.mockImplementation(async () => { throw new Error('artifact write failed'); });
    expect(await failed.dispatch('write', {}, 'preserve-failed')).toMatchObject({ errorKind: 'uncertain' });
    expect(failed.events).toEqual(['record:write:workspace_mutation', 'execute', 'unknown']);
    expect(failed.journal.complete).not.toHaveBeenCalled();

    const stopped = fixture();
    stopped.preserve.mockImplementation(async (_operation, _name, _callId, value) => {
      stopped.controller.abort();
      return value;
    });
    expect(await stopped.dispatch('write', {}, 'preserve-stopped')).toMatchObject({ errorKind: 'uncertain' });
    expect(stopped.events).toEqual(['record:write:workspace_mutation', 'execute', 'unknown']);
    expect(stopped.journal.complete).not.toHaveBeenCalled();
  });

  test('keeps completed local separate from the provider acceptance receipt', async () => {
    const f = fixture();
    expect(await f.dispatch('read', {}, 'provider-call')).toBe('confirmed result');
    expect(f.journal.complete).toHaveBeenCalledTimes(1);
    // This dispatch has no provider submission ID or accepted-submission state.
    expect(f.events).toEqual(['record:read:read_only', 'execute', 'preserve', 'complete']);
  });

  test('classifies unknown and MCP tools as external effects', () => {
    expect(classifyChatToolEffect('read')).toBe('read_only');
    expect(classifyChatToolEffect('git_commit')).toBe('workspace_mutation');
    expect(classifyChatToolEffect('mcp__server__read')).toBe('external_effect');
    expect(classifyChatToolEffect('terminal_run')).toBe('external_effect');
    expect(classifyChatToolEffect('new_tool')).toBe('external_effect');
  });

  test('journals the resolved MCP tool and its arguments before dispatch', async () => {
    const f = fixture();
    const tools = Array.from({ length: 13 }, (_, index) => ({
      id: `mcp__server__tool_${index}`, serverId: 'server', name: `tool_${index}`,
      enabled: true, inputSchema: { type: 'object', properties: {} },
    }));
    const operation = { ...f.operation, allowedToolIds: tools.map(tool => tool.id) };
    const dispatch = createChatToolDispatch(operation, {
      journal: f.journal, execute: f.execute,
      preserve: async (_operation, _name, _callId, value) => value,
      boundError: async (_operation, _name, _callId, error) => error,
    }, () => true, () => {}, tools);
    await dispatch('mcp_search', { query: 'tool_12' }, 'search');
    expect(await dispatch('mcp_call', { tool_id: tools[12].id, arguments: { key: 'value' } }, 'mcp-call')).toBe('confirmed result');
    expect((f.journal.record as ReturnType<typeof mock>).mock.calls[0]?.[0]).toMatchObject({
      toolName: tools[12].id, effectClass: 'external_effect', arguments: { key: 'value' },
    });
    expect(f.execute).toHaveBeenCalledWith(operation, tools[12].id, { key: 'value' }, 'mcp-call', expect.any(Function));
  });

  test('keeps remote reads and mutations on the existing executionId transport', async () => {
    const previousTransport = process.env.VITE_BACKEND_TRANSPORT;
    const previousUrl = process.env.VITE_REMOTE_API_BASE_URL;
    const previousFetch = globalThis.fetch;
    const sent: Array<{ tool_id: string; execution_id: string }> = [];
    try {
      process.env.VITE_BACKEND_TRANSPORT = 'remote';
      process.env.VITE_REMOTE_API_BASE_URL = 'http://127.0.0.1:8787';
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('/mode-policy')) {
          return new Response(JSON.stringify({ allowed_tool_ids: ['read', 'write'], enforce_macro_only_writes: false,
            capabilities: ['bounded_tool_output_v1', 'content_revisions_v1', 'idempotent_tool_execution_v1'] }),
          { headers: { 'content-type': 'application/json' } });
        }
        const body = JSON.parse(String(init?.body)) as { tool_id: string; execution_id: string };
        sent.push(body);
        return new Response(JSON.stringify({ result: `${body.tool_id} confirmed` }),
          { headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch;

      const f = fixture();
      expect(chatToolInvocationJournal.isRemoteRuntime()).toBe(true);
      const remoteExecute = mock<ChatToolDispatchPorts['execute']>((operation, name, args, callId) =>
        executeRemoteWorkspaceTool({ mode: 'Implement', toolId: name, args,
          invocationId: `${operation.conversationId}:${operation.turnId}:${callId}` }));
      const dispatch = createChatToolDispatch(f.operation, {
        journal: chatToolInvocationJournal, execute: remoteExecute,
        preserve: async (_operation, _name, _callId, value) => value,
        boundError: async (_operation, _name, _callId, error) => error,
      }, () => true, () => {});
      expect(await dispatch('read', { path: 'sample.txt' }, 'read-call')).toBe('read confirmed');
      expect(await dispatch('write', { path: 'sample.txt', content: 'next' }, 'write-call')).toBe('write confirmed');
      expect(sent.map(item => item.tool_id)).toEqual(['read', 'write']);
      expect(sent.every(item => item.execution_id.length > 0)).toBe(true);
      expect(await dispatch('write', { path: 'sample.txt', content: 'next' }, '')).toMatchObject({ isError: true });
      expect(sent).toHaveLength(2);
    } finally {
      if (previousTransport === undefined) delete process.env.VITE_BACKEND_TRANSPORT;
      else process.env.VITE_BACKEND_TRANSPORT = previousTransport;
      if (previousUrl === undefined) delete process.env.VITE_REMOTE_API_BASE_URL;
      else process.env.VITE_REMOTE_API_BASE_URL = previousUrl;
      globalThis.fetch = previousFetch;
      __remoteKernelApiTestables.resetDurableMutationIntents();
    }
  });

  test('keeps the SQLite journal when Tauri IPC is present with remote services', () => {
    const previousTransport = process.env.VITE_BACKEND_TRANSPORT;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
      process.env.VITE_BACKEND_TRANSPORT = 'remote';
      Object.defineProperty(globalThis, 'window', {
        configurable: true, value: { __TAURI_INTERNALS__: { invoke: () => undefined } },
      });
      expect(chatToolInvocationJournal.isRemoteRuntime()).toBe(false);
    } finally {
      if (previousTransport === undefined) delete process.env.VITE_BACKEND_TRANSPORT;
      else process.env.VITE_BACKEND_TRANSPORT = previousTransport;
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});

for (const failure of ['throw', 'empty', 'preserve', 'receipt'] as const) {
  test(`uncertain ${failure} retains original identity and never completes or replays`, async () => {
    const f = fixture();
    if (failure === 'throw') f.execute.mockImplementation(async () => { throw new Error('lost'); });
    if (failure === 'empty') f.execute.mockImplementation(async () => undefined);
    if (failure === 'preserve') f.preserve.mockImplementation(async () => undefined);
    if (failure === 'receipt') f.journal.complete = async () => { throw new Error('lost'); };
    const result = await f.dispatch('write', {}, 'original');
    expect(result).toMatchObject({ errorKind: 'uncertain', isError: true });
    if (!result || typeof result === 'string') throw new Error('Expected structured result');
    expect(JSON.parse(result.result)).toMatchObject({ outcome: 'unknown', invocation: {
      conversationId: 'conversation', turnId: 'turn', messageId: 'message', callId: 'original',
    }, instruction: expect.stringContaining('Inspect') });
    await f.dispatch('write', {}, 'original');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.events).not.toContain('complete');
  });
}

test('explicit pre-effect denial remains a permission result', async () => {
  const f = fixture();
  f.execute.mockImplementation(async () => ({ kind: 'result', result: 'Denied', isError: true, errorKind: 'permission' }));
  expect(await f.dispatch('write', {}, 'denied')).toMatchObject({ errorKind: 'permission' });
  expect(f.events).toContain('complete');
  expect(f.events).not.toContain('unknown');
});

test('failed full-text preservation keeps typed media with the uncertain result', async () => {
  const f = fixture();
  const media = { type: 'image' as const, mimeType: 'image/png', data: 'AQID' };
  f.execute.mockImplementation(async () => ({ kind: 'result', result: 'large output',
    blocks: [{ type: 'text', text: 'large output' }, media] }));
  f.preserve.mockImplementation(async () => { throw new ToolResultPreservationError('beginning... Full output unavailable ...end'); });
  const result = await f.dispatch('mcp__synthetic__image', {}, 'media-call');
  expect(result).toMatchObject({ errorKind: 'uncertain', blocks: [{ type: 'text', text: expect.stringContaining('Full output unavailable') }, media] });
  expect(f.journal.complete).not.toHaveBeenCalled();
});
for (const errorKind of ['permission', 'validation'] as const) {
  test(`failed diagnostic preservation does not reclassify a pre-effect ${errorKind} refusal`, async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => ({ kind: 'result', result: 'Refused', isError: true, errorKind }));
    f.preserve.mockImplementation(async () => { throw new ToolResultPreservationError('Refused'); });
    expect(await f.dispatch('write', {}, 'refused')).toMatchObject({ errorKind, result: 'Refused' });
    const completion = (f.journal.complete as ReturnType<typeof mock>).mock.calls[0]?.[0] as { resultJson: string };
    expect(JSON.parse(completion.resultJson)).toMatchObject({ errorKind, result: 'Refused' });
    expect(f.events).toContain('complete');
    expect(f.events).not.toContain('unknown');
  });
}

test('persists short structured and refused results before continuation', async () => {
  for (const value of ['short', { kind: 'result' as const, result: 'Denied', isError: true, errorKind: 'permission' as const }]) {
    const f = fixture();
    f.execute.mockImplementation(async () => value);
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    let payload: string | undefined;
    f.journal.complete = async input => {
      payload = input.resultJson;
      await persisted;
      f.events.push('complete');
      return invocation;
    };
    let continued = false;
    const running = f.dispatch('write', {}, 'result').then(result => { continued = true; return result; });
    for (let index = 0; index < 10 && payload === undefined; index++) await Promise.resolve();
    expect(payload).toBe(JSON.stringify(value));
    expect(continued).toBe(false);
    release();
    expect(await running).toEqual(value);
    expect(continued).toBe(true);
  }
});

test('stores exactly the normalized result supplied to continuation', async () => {
  const f = fixture();
  f.execute.mockImplementation(async () => 'Cannot safely write the file');
  const result = await f.dispatch('write', {}, 'normalized');
  const input = (f.journal.complete as ReturnType<typeof mock>).mock.calls[0]?.[0] as { resultJson: string };
  expect(JSON.parse(input.resultJson)).toEqual(JSON.parse(JSON.stringify(result)));
  expect(JSON.parse(input.resultJson)).toMatchObject({ kind: 'result', isError: true, errorKind: 'execution' });
});

test('does not continue with a refusal before its durable completion is confirmed', async () => {
  const f = fixture();
  f.execute.mockImplementation(async () => ({ kind: 'result', result: 'Denied', isError: true, errorKind: 'permission' }));
  f.journal.complete = async () => { throw new Error('completion response lost'); };
  expect(await f.dispatch('write', {}, 'denied-unconfirmed')).toMatchObject({ errorKind: 'uncertain' });
  expect(f.events).toContain('unknown');
});

test('typed terminal uncertainty stays unknown and is never durably completed', async () => {
  const f = fixture();
  f.execute.mockImplementation(async () => ({ kind: 'result', result: 'command receipt lost', isError: true, errorKind: 'uncertain' }));
  expect(await f.dispatch('terminal_run', {}, 'terminal-call')).toMatchObject({ errorKind: 'uncertain' });
  expect(f.events).toEqual(['record:terminal_run:external_effect', 'unknown']);
  expect(f.journal.complete).not.toHaveBeenCalled();
});


for (const errorKind of ['permission', 'validation'] as const) {
  test(`Stop preserves ${errorKind} when the executor proves no effect was dispatched`, async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      f.controller.abort();
      return { kind: 'result', result: 'Refused before dispatch', isError: true, errorKind };
    });
    expect(await f.dispatch('terminal_run', {}, 'refused')).toMatchObject({ errorKind });
    expect(f.journal.complete).not.toHaveBeenCalled();
    expect(f.preserve).not.toHaveBeenCalled();
  });
}


test('keeps a terminal local-stop receipt and journal unknown through dispatch after Stop', async () => {
  const f = fixture();
  let confirm!: () => void;
  const receipt = new Promise<void>(resolve => { confirm = resolve; });
  const failure = new StreamStopUnconfirmedError('Run and kill receipts missing', receipt);
  f.execute.mockImplementation(async () => { f.controller.abort(); throw failure; });
  await expect(f.dispatch('terminal_run', {}, 'terminal-call')).rejects.toBe(failure);
  expect(f.events).toEqual(['record:terminal_run:external_effect', 'unknown']);
  expect(f.journal.complete).not.toHaveBeenCalled();
  expect(f.preserve).not.toHaveBeenCalled();
  expect(failure.stopped).toBe(false);
  confirm();
  await failure.whenStopped;
});

for (const errorKind of ['permission', 'validation'] as const) {
  test(`Stop during diagnostic preservation keeps a typed ${errorKind} refusal without completing`, async () => {
    const f = fixture();
    const refusal = { kind: 'result' as const, result: 'Refused before dispatch', isError: true, errorKind };
    f.execute.mockImplementation(async () => refusal);
    f.preserve.mockImplementation(async () => {
      f.controller.abort();
      throw new ToolResultPreservationError('Refused before dispatch');
    });
    expect(await f.dispatch('terminal_run', {}, 'refused-during-preservation')).toBe(refusal);
    expect(f.events).toContain('unknown');
    expect(f.journal.complete).not.toHaveBeenCalled();
  });
}
