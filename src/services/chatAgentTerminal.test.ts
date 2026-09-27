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

  expect(await executeChatAgentTerminal(terminal, 'terminal_create_session', {}, new AbortController().signal, isCurrent)).toBe('Tool execution aborted');
  expect(await executeChatAgentTerminal(terminal, 'terminal_kill', { session_id: 'session' }, new AbortController().signal, isCurrent)).toBe('Tool execution aborted');
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
    expect(await running).toBe('Tool execution aborted');
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
