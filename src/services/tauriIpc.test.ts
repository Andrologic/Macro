import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const invokeCalls: Array<{ command: string; payload: unknown }> = [];
const invokeMock = mock(async (command: string, payload?: unknown) => {
  invokeCalls.push({ command, payload });
  return '{"ok":true}';
});

const registerTauriIpcMocks = () => {
  mock.restore();
  mock.module('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
  }));
};

let tauriIpcImportCounter = 0;

const loadTauriIpc = async () => {
  registerTauriIpcMocks();
  tauriIpcImportCounter += 1;
  return import(`./tauriIpc.ts?test=${tauriIpcImportCounter}`);
};

describe('tauriIpc executeWorkspaceTool', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    invokeMock.mockClear();
  });

  it('passes workspacePath to tool_execute_workspace', async () => {
    const tauriIpc = await loadTauriIpc();

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
          workspaceScope: null,
        },
      },
    ]);
  });

  it('calls ai_get_dev_provider_overrides without payload', async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.aiGetDevProviderOverrides();

    expect(invokeCalls).toEqual([
      {
        command: 'ai_get_dev_provider_overrides',
        payload: undefined,
      },
    ]);
  });

  afterAll(() => {
    mock.restore();
  });
});
