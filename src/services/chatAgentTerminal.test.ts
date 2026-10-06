import { expect, mock, test } from 'bun:test';
import type { ChatToolExecutionPorts } from './chatToolExecutionContracts';
import type { TerminalSessionDto } from './tauriIpc';
import { executeChatAgentTerminal } from './chatAgentTerminal';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
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
  command.resolve(session);
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

test('lookup failure is execution error, loss after dispatch is unknown', async () => {
  const terminal = terminalFixture();
  const signal = new AbortController().signal;
  terminal.readSession.mockRejectedValueOnce(new Error('Session lookup failed'));
  expect(await executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, signal)).toMatchObject({ isError: true, errorKind: 'execution' });
  terminal.runCommand.mockRejectedValue(new Error('No execution receipt'));
  expect(await executeChatAgentTerminal(terminal, 'terminal_run', { session_id: 'session', command: 'fixture' }, signal)).toMatchObject({ isError: true, errorKind: 'uncertain', result: expect.stringContaining('unknown') });
});

for (const outcome of [{ status: 'timed_out', timed_out: true }, { status: 'killed' }, { status: 'running', exit_code: null }]) {
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
