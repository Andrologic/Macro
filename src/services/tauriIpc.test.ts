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

  it('uses camelCase payload keys for workspace project mutations', async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.workspaceCreateProject({
      name: 'Web',
      description: '',
      groupId: 'group-1',
      groupName: 'Suite',
      path: 'C:/dev/web',
    });
    await tauriIpc.workspaceImportGitRepo({
      gitUrl: 'https://example.com/repo.git',
      projectName: 'API',
      branch: 'main',
      groupId: 'group-1',
      groupName: 'Suite',
      path: 'C:/dev/api',
    });
    await tauriIpc.workspaceRenameProjectGroup({ groupId: 'group-1', name: 'Renamed' });
    await tauriIpc.workspaceRenameProject({ projectId: 'project-1', name: 'Renamed Project' });
    await tauriIpc.workspaceArchiveProjectGroup({ groupId: 'group-1' });
    await tauriIpc.workspaceArchiveProject({ projectId: 'project-1' });
    await tauriIpc.workspaceRemoveProjectGroup({ groupId: 'group-1' });
    await tauriIpc.workspaceRemoveProject({ projectId: 'project-1' });
    await tauriIpc.workspaceCloseProject({ projectId: 'project-1' });

    expect(invokeCalls).toEqual([
      {
        command: 'workspace_create_project',
        payload: {
          name: 'Web',
          description: '',
          groupId: 'group-1',
          groupName: 'Suite',
          path: 'C:/dev/web',
        },
      },
      {
        command: 'workspace_import_git_repo',
        payload: {
          gitUrl: 'https://example.com/repo.git',
          projectName: 'API',
          branch: 'main',
          groupId: 'group-1',
          groupName: 'Suite',
          path: 'C:/dev/api',
        },
      },
      {
        command: 'workspace_rename_project_group',
        payload: {
          groupId: 'group-1',
          name: 'Renamed',
        },
      },
      {
        command: 'workspace_rename_project',
        payload: {
          projectId: 'project-1',
          name: 'Renamed Project',
        },
      },
      {
        command: 'workspace_archive_project_group',
        payload: {
          groupId: 'group-1',
        },
      },
      {
        command: 'workspace_archive_project',
        payload: {
          projectId: 'project-1',
        },
      },
      {
        command: 'workspace_remove_project_group',
        payload: {
          groupId: 'group-1',
        },
      },
      {
        command: 'workspace_remove_project',
        payload: {
          projectId: 'project-1',
        },
      },
      {
        command: 'workspace_close_project',
        payload: {
          projectId: 'project-1',
        },
      },
    ]);
  });

  it('uses camelCase payload keys for terminal commands', async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.terminalCreateSession({
      projectId: 'project-1',
      cwd: 'packages/api',
    });
    await tauriIpc.terminalRun({
      sessionId: 'terminal-1',
      command: 'git status',
      timeoutMs: 5000,
    });
    await tauriIpc.terminalRead('terminal-1');
    await tauriIpc.terminalKill('terminal-1');

    expect(invokeCalls).toEqual([
      {
        command: 'terminal_create_session',
        payload: {
          projectId: 'project-1',
          cwd: 'packages/api',
        },
      },
      {
        command: 'terminal_run',
        payload: {
          sessionId: 'terminal-1',
          command: 'git status',
          timeoutMs: 5000,
        },
      },
      {
        command: 'terminal_read',
        payload: {
          sessionId: 'terminal-1',
        },
      },
      {
        command: 'terminal_kill',
        payload: {
          sessionId: 'terminal-1',
        },
      },
    ]);
  });

  it('uses camelCase payload keys for interactive terminal tabs', async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.terminalCreateTab({
      kind: 'task',
      projectId: 'project-1',
      cwd: 'C:/dev/worktree',
      title: 'Build · API',
      taskId: 'task-1',
    });
    await tauriIpc.terminalReconnectTab('tab-1');
    await tauriIpc.terminalReadTab('tab-1');
    await tauriIpc.terminalWriteInput({ tabId: 'tab-1', input: 'pwd\\r' });
    await tauriIpc.terminalResize({ tabId: 'tab-1', cols: 120, rows: 32 });
    await tauriIpc.terminalExecuteCommand({ tabId: 'tab-1', command: 'bun test' });
    await tauriIpc.terminalInterrupt('tab-1');
    await tauriIpc.terminalClearTab('tab-1');
    await tauriIpc.terminalCloseTab('tab-1');

    expect(invokeCalls).toEqual([
      {
        command: 'terminal_create_tab',
        payload: {
          kind: 'task',
          projectId: 'project-1',
          cwd: 'C:/dev/worktree',
          title: 'Build · API',
          taskId: 'task-1',
        },
      },
      {
        command: 'terminal_reconnect_tab',
        payload: {
          tabId: 'tab-1',
        },
      },
      {
        command: 'terminal_read_tab',
        payload: {
          tabId: 'tab-1',
        },
      },
      {
        command: 'terminal_write_input',
        payload: {
          tabId: 'tab-1',
          input: 'pwd\\r',
        },
      },
      {
        command: 'terminal_resize',
        payload: {
          tabId: 'tab-1',
          cols: 120,
          rows: 32,
        },
      },
      {
        command: 'terminal_execute_command',
        payload: {
          tabId: 'tab-1',
          command: 'bun test',
        },
      },
      {
        command: 'terminal_interrupt',
        payload: {
          tabId: 'tab-1',
        },
      },
      {
        command: 'terminal_clear_tab',
        payload: {
          tabId: 'tab-1',
        },
      },
      {
        command: 'terminal_close_tab',
        payload: {
          tabId: 'tab-1',
        },
      },
    ]);
  });

  afterAll(() => {
    mock.restore();
  });
});
