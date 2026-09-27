import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { PassThrough } from 'node:stream';
import { BridgeControlChannel } from './controlChannel';
import type { JsonRecord } from './protocol';

const channels: BridgeControlChannel[] = [];
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  jest.useRealTimers();
});

const setup = (emit = mock((_payload: JsonRecord) => {})) => {
  const input = new PassThrough();
  const channel = new BridgeControlChannel(input, emit);
  channels.push(channel);
  const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
  return { input, channel, emit, send };
};

const params = {
  requestId: 'request-1', toolCallId: 'call-1', toolName: 'read_file',
  args: { path: 'example.txt' }, sessionTimeoutMs: 60_000,
};
const reply = {
  type: 'tool_result', request_id: params.requestId, tool_call_id: params.toolCallId,
  result: '', is_error: false, error_kind: null,
  hidden_context: null, visible_content: null, interrupt: false,
};

describe('Copilot control channel', () => {
  it('reads fragmented initial JSON, ignores blanks and shares it between waiters', async () => {
    const { input, channel } = setup();
    const first = channel.readInitialJson();
    const second = channel.readInitialJson();
    input.write('\n  \n{"model_');
    input.write('id":"synthetic"}\n');
    await expect(first).resolves.toEqual({ model_id: 'synthetic' });
    await expect(second).resolves.toEqual({ model_id: 'synthetic' });
    await expect(channel.readInitialJson()).resolves.toEqual({ model_id: 'synthetic' });
  });

  it('rejects malformed initial JSON for current and subsequent readers', async () => {
    const { input, channel } = setup();
    const initial = channel.readInitialJson();
    input.write('{invalid}\n');
    await expect(initial).rejects.toMatchObject({ code: 'invalid_control_message' });
    await expect(channel.readInitialJson()).rejects.toMatchObject({ code: 'invalid_control_message' });
  });

  it('resolves initial EOF to null and refuses tool requests after EOF', async () => {
    const { input, channel, emit } = setup();
    const initial = channel.readInitialJson();
    input.end();
    await expect(initial).resolves.toBeNull();
    await expect(channel.readInitialJson()).resolves.toBeNull();
    await expect(channel.requestTool(params)).rejects.toMatchObject({ code: 'tool_result_channel_closed' });
    expect(emit).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('correlates both opaque IDs and leaves mismatches/unknown results pending', async () => {
    const { channel, send, emit } = setup();
    send({ model_id: 'synthetic' });
    const ids = { requestId: ' request:opaque ', toolCallId: ' call/opaque ' };
    const pending = channel.requestTool({ ...params, ...ids });
    const settled = mock(() => {});
    void pending.then(settled);
    expect(emit).toHaveBeenCalledWith({
      type: 'tool_request', request_id: ids.requestId, tool_call_id: ids.toolCallId,
      tool_name: params.toolName, args: params.args,
    });
    send({ ...reply, request_id: 'wrong', tool_call_id: ids.toolCallId });
    send({ ...reply, request_id: ids.requestId, tool_call_id: 'unknown' });
    send({ type: 'future_control' });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    send({ ...reply, request_id: ids.requestId, tool_call_id: ids.toolCallId });
    await expect(pending).resolves.toMatchObject({ result: '', isError: false, errorKind: null });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects pending duplicate IDs without replacing the original waiter', async () => {
    const { channel, send, emit } = setup();
    send({});
    const first = channel.requestTool(params);
    await expect(channel.requestTool({ ...params, requestId: 'other' }))
      .rejects.toMatchObject({ code: 'duplicate_tool_call_id' });
    expect(emit).toHaveBeenCalledTimes(1);
    send(reply);
    await expect(first).resolves.toMatchObject({ result: '' });
    send({ ...reply, result: 'late duplicate' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('resolves concurrent calls out of order without crossing their results', async () => {
    const { channel, send } = setup();
    send({});
    const first = channel.requestTool(params);
    const second = channel.requestTool({ ...params, toolCallId: 'call-2' });
    send({ ...reply, tool_call_id: 'call-2', result: 'second' });
    await expect(second).resolves.toMatchObject({ result: 'second' });
    expect(jest.getTimerCount()).toBe(1);
    send({ ...reply, result: 'first' });
    await expect(first).resolves.toMatchObject({ result: 'first' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps business errors and interruption data as resolved results', async () => {
    const { channel, send } = setup();
    send({});
    for (const errorKind of ['permission', 'aborted', 'validation', 'execution', 'future_kind']) {
      const pending = channel.requestTool(params);
      send({ ...reply, result: '', is_error: true, error_kind: errorKind,
        interrupt: true, visible_content: '', hidden_context: 'private context' });
      await expect(pending).resolves.toEqual({
        result: '', isError: true, errorKind, interrupt: true,
        visibleContent: '', hiddenContext: 'private context',
      });
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retains the legacy channel error separately from business error metadata', async () => {
    const { channel, send } = setup();
    send({});
    const pending = channel.requestTool(params);
    send({ ...reply, error: 'relay failed', is_error: true, error_kind: 'permission' });
    await expect(pending).rejects.toMatchObject({ code: 'tool_result_failed', message: 'relay failed' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['EOF', 'close', 'invalid JSON', 'invalid shape'])('cleans every pending timer on %s', async (ending) => {
    const { input, channel, send } = setup();
    send({});
    const first = channel.requestTool(params);
    const second = channel.requestTool({ ...params, toolCallId: 'call-2' });
    const results = Promise.allSettled([first, second]);
    if (ending === 'EOF') input.end();
    else if (ending === 'close') channel.close();
    else if (ending === 'invalid JSON') input.write('{invalid}\n');
    else send({ ...reply, is_error: 'true' });
    const code = ending.startsWith('invalid') ? 'invalid_control_message' : 'tool_result_channel_closed';
    expect(await results).toMatchObject([
      { status: 'rejected', reason: { code } }, { status: 'rejected', reason: { code } },
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('accepts a result just before expiry and expires exactly at the relay budget', async () => {
    const { channel, send } = setup();
    send({});
    const first = channel.requestTool(params);
    jest.advanceTimersByTime(29_999);
    expect(jest.getTimerCount()).toBe(1);
    send(reply);
    await expect(first).resolves.toMatchObject({ result: '' });
    jest.advanceTimersByTime(1);
    expect(jest.getTimerCount()).toBe(0);

    const timedOut = channel.requestTool(params);
    const rejection = timedOut.catch((error: unknown) => error);
    jest.advanceTimersByTime(29_999);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(1);
    expect(await rejection).toMatchObject({ code: 'tool_result_timeout' });
    send({ ...reply, result: 'late after timeout' });
    expect(jest.getTimerCount()).toBe(0);

    const replacement = channel.requestTool({ ...params, requestId: 'request-2' });
    send(reply);
    expect(jest.getTimerCount()).toBe(1);
    send({ ...reply, request_id: 'request-2', result: 'current' });
    await expect(replacement).resolves.toMatchObject({ result: 'current' });
  });

  it('registers pending calls before emitting and cleans up write failures', async () => {
    const { channel, send, emit } = setup();
    send({});
    emit.mockImplementation(() => { send(reply); });
    await expect(channel.requestTool(params)).resolves.toMatchObject({ result: '' });
    expect(jest.getTimerCount()).toBe(0);
    emit.mockImplementation(() => { throw new Error('write failed'); });
    await expect(channel.requestTool(params)).rejects.toMatchObject({ code: 'tool_result_channel_failed' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects empty outgoing IDs without emitting or starting a timer', async () => {
    const { channel, send, emit } = setup();
    send({});
    for (const ids of [{ requestId: '' }, { toolCallId: '  ' }]) {
      await expect(channel.requestTool({ ...params, ...ids }))
        .rejects.toMatchObject({ code: 'invalid_control_message' });
    }
    expect(emit).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
