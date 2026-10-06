import { expect, mock, test } from 'bun:test';
import type { ChatToolExecutionPorts } from './chatToolExecutionContracts';
import type { TerminalSessionDto } from './tauriIpc';
import { executeChatAgentTerminal } from './chatAgentTerminal';
import { StreamStopUnconfirmedError } from './ai/streamCancellation';
import { invokeToolHandler } from './ai/toolCallRunner';
import { createChatTurnRuntime } from './chatTurnRuntime';
import { EMPTY_CONVERSATION_RUNTIME } from '../domains/chat/runtimeState';
import type { ConversationRuntimeState } from '../types';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const session: TerminalSessionDto = {
  id: 'session', project_id: null, project_name: null, mount_name: null, workspace_path: null,
  cwd: '/workspace', status: 'idle', last_command: null, output: 'ok', exit_code: 0,
  timed_out: false, output_truncated: false, updated_at: '2026-01-01T00:00:00Z',
};

function terminalFixture() {
  return {
    cachedSession: mock<ChatToolExecutionPorts['terminal']['cachedSession']>(() => undefined),
    createSession: mock<ChatToolExecutionPorts['terminal']['createSession']>(async () => session),
    readSession: mock<ChatToolExecutionPorts['terminal']['readSession']>(async () => session),
    runCommand: mock<ChatToolExecutionPorts['terminal']['runCommand']>(async () => session),
    killSession: mock<ChatToolExecutionPorts['terminal']['killSession']>(async () => session),
  } satisfies ChatToolExecutionPorts['terminal'];
}

test('does not create or kill a terminal for an invalid owner', async () => {
  const terminal = terminalFixture();
  const isCurrent = mock(() => false);

  expect(await executeChatAgentTerminal(terminal, 'terminal_create_session', {}, new AbortController().signal, isCurrent)).toMatchObject({ kind: 'result', isError: true, errorKind: 'aborted' });
  expect(await executeChatAgentTerminal(terminal, 'terminal_kill', { session_id: 'session' }, new AbortController().signal, isCurrent)).toMatchObject({ kind: 'result', isError: true, errorKind: 'aborted' });
  expect(terminal.createSession).not.toHaveBeenCalled();
  expect(terminal.killSession).not.toHaveBeenCalled();
});

for (const invalidation of ['abort', 'owner'] as const) {
  test(`does not run after readSession when invalidated by ${invalidation}`, async () => {
    const terminal = terminalFixture();
    const read = deferred<TerminalSessionDto>();
    terminal.readSession.mockReturnValue(read.promise);
    const controller = new AbortController();
    let current = true;
    const running = executeChatAgentTerminal(
      terminal,
      'terminal_run',
      { session_id: 'session', command: 'synthetic' },
      controller.signal,
      () => current,
    );

    if (invalidation === 'abort') controller.abort();
    else current = false;
    read.resolve(session);
    expect(await running).toMatchObject({ kind: 'result', isError: true, errorKind: 'aborted' });
    expect(terminal.runCommand).not.toHaveBeenCalled();
  });
}

test('kills the exact execution after a run has started and the signal aborts', async () => {
  const terminal = terminalFixture();
  const command = deferred<typeof session>();
  terminal.runCommand.mockReturnValue(command.promise);
  const controller = new AbortController();
  const running = executeChatAgentTerminal(
    terminal,
    'terminal_run',
    { session_id: 'session', command: 'synthetic' },
    controller.signal,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  command.resolve({ ...session, status: "killed" });
  await running;
  expect(terminal.runCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', command: 'synthetic', executionId: expect.any(String) }));
  expect(terminal.killSession).toHaveBeenCalledWith('session', expect.any(String));
  expect(terminal.killSession.mock.calls[0]?.[1]).toBe(terminal.runCommand.mock.calls[0]?.[0].executionId);
});


test('terminal refusals are typed before dispatch', async () => {
  const terminal = terminalFixture();
  const signal = new AbortController().signal;
  expect(await executeChatAgentTerminal(terminal, 'terminal_run', { command: 'fixture' }, signal)).toMatchObject({ isError: true, errorKind: 'validation' });
  expect(await executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: '' }, signal)).toMatchObject({ isError: true, errorKind: 'validation' });
  terminal.readSession.mockResolvedValue({ ...session, project_id: 'manual-project' });
  expect(await executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, signal)).toMatchObject({ isError: true, errorKind: 'permission' });
  expect(terminal.runCommand).not.toHaveBeenCalled();
});

test('nonzero command exit is a confirmed executed result, not a transport error', async () => {
  const terminal = terminalFixture();
  terminal.runCommand.mockResolvedValue({ ...session, status: 'failed', exit_code: 17 });
  const result = await executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, new AbortController().signal);
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.result)).toMatchObject({ status: 'failed', exit_code: 17 });
});

test('lookup failure is execution error, loss of the final run receipt retains the local owner', async () => {
  const terminal = terminalFixture();
  const signal = new AbortController().signal;
  terminal.readSession.mockRejectedValueOnce(new Error('Session lookup failed'));
  expect(await executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, signal)).toMatchObject({ isError: true, errorKind: 'execution' });
  terminal.runCommand.mockRejectedValue(new Error('No execution receipt'));
  await expect(executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, signal)).rejects.toMatchObject({ name: 'StreamStopUnconfirmedError', message: expect.stringContaining('No execution receipt') });
});

for (const outcome of [{ status: 'timed_out', timed_out: true }, { status: 'killed' }]) {
  test(`does not report ${outcome.status} as success`, async () => {
    const terminal = terminalFixture();
    terminal.runCommand.mockResolvedValue({ ...session, ...outcome });
    expect(await executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, new AbortController().signal)).toMatchObject({ isError: true, errorKind: 'uncertain' });
  });
}

test('Stop waits for both the exact command and its pending cancellation without confirming external effects', async () => {
  const terminal = terminalFixture();
  const command = deferred<TerminalSessionDto>();
  const kill = deferred<TerminalSessionDto>();
  terminal.runCommand.mockReturnValue(command.promise);
  terminal.killSession.mockReturnValue(kill.promise);
  const controller = new AbortController();
  const running = executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, controller.signal);
  let ended = false;
  void running.then(() => { ended = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort();
  command.resolve({ ...session, status: 'completed' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(ended).toBe(false);
  kill.resolve({ ...session, status: 'killed' });
  expect(await running).toMatchObject({ isError: true, errorKind: 'uncertain' });
});


test('a rejected exact cancellation is reported as uncertainty with its diagnostic', async () => {
  const terminal = terminalFixture();
  const command = deferred<TerminalSessionDto>();
  terminal.runCommand.mockReturnValue(command.promise);
  terminal.killSession.mockRejectedValue(new Error('kill receipt lost'));
  const controller = new AbortController();
  const running = executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'synthetic' }, controller.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  command.resolve({ ...session, status: 'completed' });
  expect(await running).toMatchObject({ errorKind: 'uncertain', result: expect.stringContaining('kill receipt lost') });
});


test('a non-final run receipt cannot confirm the local owner ended', async () => {
  const terminal = terminalFixture();
  terminal.runCommand.mockResolvedValue({ ...session, status: 'running', exit_code: null });
  await expect(executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, new AbortController().signal))
    .rejects.toBeInstanceOf(StreamStopUnconfirmedError);
});

for (const finalRun of [false, true]) {
  test(`Stop ${finalRun ? 'releases' : 'retains'} Chat ownership when kill fails ${finalRun ? 'with' : 'without'} a final run receipt`, async () => {
    const terminal = terminalFixture();
    const command = deferred<TerminalSessionDto>();
    terminal.runCommand.mockReturnValue(command.promise);
    terminal.killSession.mockRejectedValue(new Error('kill/reap failed'));
    const controller = new AbortController();
    let state: ConversationRuntimeState = { ...EMPTY_CONVERSATION_RUNTIME, phase: 'streaming', sessionId: 'run',
      turnId: 'turn', assistantMessageId: 'assistant', abortController: controller };
    const settled = mock(() => undefined);
    const owner = createChatTurnRuntime({
      state: { read: () => state, project: (_id, value) => { state = value ?? EMPTY_CONVERSATION_RUNTIME; }, isDeleted: () => false },
      cancelTransport: async () => {}, settled,
    });
    const running = invokeToolHandler(() => executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, controller.signal),
      'terminal_run', {}, 'call', controller.signal);
    const stream = running.then(() => undefined);
    void stream.catch(() => undefined);
    owner.track('conversation', stream);
    await new Promise<void>(resolve => setImmediate(resolve));
    const stopping = owner.stop('conversation');
    if (finalRun) command.resolve({ ...session, status: 'completed' });
    else command.reject(new Error('run transport lost'));
    if (finalRun) {
      await expect(running).rejects.toHaveProperty('name', 'AbortError');
      await stopping;
      owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false });
      expect(settled).toHaveBeenCalledTimes(1);
    } else {
      const failure = await running.then(() => { throw new Error('Expected missing terminal receipt'); }, error => error as StreamStopUnconfirmedError);
      expect(failure).toBeInstanceOf(StreamStopUnconfirmedError);
      expect(failure.message).toContain('run transport lost');
      expect(failure.message).toContain('kill/reap failed');
      await expect(stopping).rejects.toBe(failure);
      expect(() => owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false })).toThrow('already running');
      expect(settled).not.toHaveBeenCalled();
      let drained = false;
      void owner.drain('conversation').then(() => { drained = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
    }
  });
}


test('preserves a reliable late run receipt supplied by the terminal port', async () => {
  const terminal = terminalFixture();
  const proof = deferred<void>();
  terminal.runCommand.mockRejectedValue(new StreamStopUnconfirmedError('Run completion still owned', proof.promise));
  const pending = executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, new AbortController().signal);
  const failure = await pending.then(() => { throw new Error('Expected late run receipt'); }, error => error as StreamStopUnconfirmedError);
  expect(failure).toBeInstanceOf(StreamStopUnconfirmedError);
  expect(failure.stopped).toBe(false);
  proof.resolve();
  await failure.whenStopped;
  expect(failure.stopped).toBe(true);
});
