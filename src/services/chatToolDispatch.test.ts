import { describe, expect, mock, test } from 'bun:test';
import { createChatToolDispatch, classifyChatToolEffect, type ChatToolDispatchPorts, type ChatToolInvocationJournal } from './chatToolDispatch';
import type { FrozenToolCallContext } from './chatStreamContracts';
import type { ToolInvocation } from '../types/generated/ipc';

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
  const dispatch = createChatToolDispatch(operation, {
    journal, execute,
    preserve: async (_operation, _name, _callId, value) => { events.push('preserve'); return value; },
    boundError: async (_operation, _name, _callId, error) => error,
  }, () => true, () => {});
  return { operation, controller, journal, execute, dispatch, events };
}

describe('durable Chat tool dispatch', () => {
  test('records before effect, completes after executor response, and refuses a duplicate', async () => {
    const f = fixture();
    expect(await f.dispatch('write', { path: 'file.txt', content: 'text' }, 'call')).toBe('confirmed result');
    expect(f.events).toEqual(['record:write:workspace_mutation', 'execute', 'complete', 'preserve']);
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
    expect(await stopped.dispatch('write', {}, 'stop')).toMatchObject({ errorKind: 'aborted' });
    expect(stopped.events).toContain('unknown');
    expect(stopped.journal.complete).not.toHaveBeenCalled();

    const failed = fixture();
    failed.execute.mockImplementation(async () => { throw new Error('transport lost'); });
    expect(failed.dispatch('write', {}, 'failure')).rejects.toThrow('transport lost');
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
    expect(f.events).toEqual(['record:write:workspace_mutation', 'execute', 'unknown', 'preserve']);
  });

  test('keeps completed local separate from the provider acceptance receipt', async () => {
    const f = fixture();
    expect(await f.dispatch('read', {}, 'provider-call')).toBe('confirmed result');
    expect(f.journal.complete).toHaveBeenCalledTimes(1);
    // This dispatch has no provider submission ID or accepted-submission state.
    expect(f.events).toEqual(['record:read:read_only', 'execute', 'complete', 'preserve']);
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
});
