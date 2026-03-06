import { beforeEach, describe, expect, it, mock } from 'bun:test';

const invokeCalls: Array<{ command: string; payload: unknown }> = [];
const invokeMock = mock(async (command: string, payload?: unknown) => {
  invokeCalls.push({ command, payload });
  return '{"ok":true}';
});

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('tauriIpc executeWorkspaceTool', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    invokeMock.mockClear();
  });

  it('passes workspacePath to tool_execute_workspace', async () => {
    const tauriIpc = await import('./tauriIpc');

    await tauriIpc.executeWorkspaceTool({
      mode: 'Architect',
      toolId: 'read',
      args: { path: 'src/App.tsx' },
      workspacePath: 'C:/dev/Smartcards',
    });

    expect(invokeCalls).toEqual([
      {
        command: 'tool_execute_workspace',
        payload: {
          mode: 'Architect',
          toolId: 'read',
          args: { path: 'src/App.tsx' },
          workspacePath: 'C:/dev/Smartcards',
        },
      },
    ]);
  });
});
