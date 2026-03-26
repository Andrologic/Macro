import { beforeEach, describe, expect, it, mock } from 'bun:test';

type TerminalTabDto = {
  id: string;
  kind: string;
  task_id: string | null;
  project_id: string;
  project_name: string;
  mount_name: string;
  workspace_path: string;
  cwd: string;
  title: string;
  status: string;
  snapshot: string;
  last_command: string | null;
  last_exit_code: number | null;
  has_live_session: boolean;
  is_restored: boolean;
  created_at: string;
  updated_at: string;
};

const eventHandlers: Record<string, ((event: { payload: any }) => void) | undefined> = {};
const listenMock = mock(async (eventName: string, handler: (event: { payload: any }) => void) => {
  eventHandlers[eventName] = handler;
  return () => {
    delete eventHandlers[eventName];
  };
});
const terminalListTabsMock = mock(async (): Promise<TerminalTabDto[]> => []);
const terminalCreateTabMock = mock(async (): Promise<TerminalTabDto> => ({
  id: 'manual-tab-1',
  kind: 'manual',
  task_id: null,
  project_id: 'project-1',
  project_name: 'Web',
  mount_name: 'web',
  workspace_path: 'C:/repos/web',
  cwd: 'C:/repos/web',
  title: 'Terminal · Web',
  status: 'idle',
  snapshot: '',
  last_command: null,
  last_exit_code: null,
  has_live_session: true,
  is_restored: false,
  created_at: '2026-03-26T10:00:00.000Z',
  updated_at: '2026-03-26T10:00:00.000Z',
}));
const loadPreferenceMock = mock(async (_key: string): Promise<unknown> => null);
const savePreferenceMock = mock(async () => undefined);
const resolveProjectExecutionContextMock = mock(() => ({
  projectId: 'project-1',
  projectName: 'Web',
  workspacePath: 'C:/repos/web',
}));

mock.module('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

mock.module('../services/tauriIpc', () => ({
  isTauriAvailable: () => true,
  terminalListTabs: terminalListTabsMock,
  terminalCreateTab: terminalCreateTabMock,
}));

mock.module('../services/preferences', () => ({
  PREF_KEYS: {
    TERMINAL_PANEL_HEIGHT: 'terminalPanelHeight',
    TERMINAL_ACTIVE_TAB_ID: 'terminalActiveTabId',
  },
  loadPreference: loadPreferenceMock,
  savePreference: savePreferenceMock,
}));

mock.module('../services/projectExecutionContext', () => ({
  resolveProjectExecutionContext: resolveProjectExecutionContextMock,
}));

mock.module('./useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      mode: 'Implement',
      projectGroups: [],
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      selectedTaskId: null,
    }),
  },
}));

mock.module('./useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      conversations: [],
      selectedConversationId: null,
    }),
  },
}));

mock.module('./useTaskStore', () => ({
  useTaskStore: {
    getState: () => ({
      tasks: [],
      activeRepositoryPath: null,
      branchWorktrees: {},
    }),
  },
}));

let importCounter = 0;

const loadTerminalStore = async () => {
  importCounter += 1;
  return import(`./useTerminalStore.ts?test=${importCounter}`);
};

const buildTabDto = (overrides: Partial<TerminalTabDto> = {}): TerminalTabDto => ({
  id: 'task-tab-1',
  kind: 'task',
  task_id: 'task-1',
  project_id: 'project-1',
  project_name: 'Web',
  mount_name: 'web',
  workspace_path: 'C:/repos/web/.macro/worktrees/task-1',
  cwd: 'C:/repos/web/.macro/worktrees/task-1',
  title: 'Task 1 · Web',
  status: 'restored-disconnected',
  snapshot: 'npm test\r\n',
  last_command: 'npm test',
  last_exit_code: 0,
  has_live_session: false,
  is_restored: true,
  created_at: '2026-03-26T09:00:00.000Z',
  updated_at: '2026-03-26T09:05:00.000Z',
  ...overrides,
});

describe('useTerminalStore', () => {
  beforeEach(() => {
    Object.keys(eventHandlers).forEach((key) => {
      delete eventHandlers[key];
    });
    terminalListTabsMock.mockReset();
    terminalCreateTabMock.mockReset();
    loadPreferenceMock.mockReset();
    savePreferenceMock.mockReset();
    resolveProjectExecutionContextMock.mockReset();
    listenMock.mockReset();

    listenMock.mockImplementation(async () => () => undefined);
    terminalListTabsMock.mockImplementation(async () => []);
    terminalCreateTabMock.mockImplementation(async () => ({
      id: 'manual-tab-1',
      kind: 'manual',
      task_id: null,
      project_id: 'project-1',
      project_name: 'Web',
      mount_name: 'web',
      workspace_path: 'C:/repos/web',
      cwd: 'C:/repos/web',
      title: 'Terminal · Web',
      status: 'idle',
      snapshot: '',
      last_command: null,
      last_exit_code: null,
      has_live_session: true,
      is_restored: false,
      created_at: '2026-03-26T10:00:00.000Z',
      updated_at: '2026-03-26T10:00:00.000Z',
    }));
    loadPreferenceMock.mockImplementation(async (key: string) => {
      if (key === 'terminalPanelHeight') {
        return 320;
      }
      if (key === 'terminalActiveTabId') {
        return null;
      }
      return null;
    });
    resolveProjectExecutionContextMock.mockImplementation(() => ({
      projectId: 'project-1',
      projectName: 'Web',
      workspacePath: 'C:/repos/web',
    }));
  });

  it('restores tabs at bootstrap without reopening the terminal split', async () => {
    terminalListTabsMock.mockImplementationOnce(async () => [
      buildTabDto(),
    ]);
    loadPreferenceMock.mockImplementation(async (key: string) => {
      if (key === 'terminalPanelHeight') {
        return 360;
      }
      if (key === 'terminalActiveTabId') {
        return 'task-tab-1';
      }
      return null;
    });

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().initialize();

    const state = useTerminalStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.panelOpen).toBe(false);
    expect(state.panelHeight).toBe(360);
    expect(state.activeTabId).toBe('task-tab-1');
    expect(state.tabOrder).toEqual(['task-tab-1']);
    expect(state.tabs['task-tab-1']).toMatchObject({
      id: 'task-tab-1',
      status: 'restored-disconnected',
      hasLiveSession: false,
      isRestored: true,
      snapshot: 'npm test\r\n',
    });
  });

  it('opens the split and creates a manual terminal when toggled with no existing tab', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().togglePanel();

    const state = useTerminalStore.getState();
    expect(terminalCreateTabMock).toHaveBeenCalledWith({
      kind: 'manual',
      projectId: 'project-1',
      cwd: 'C:/repos/web',
      title: 'Terminal · Web',
    });
    expect(resolveProjectExecutionContextMock).toHaveBeenCalled();
    expect(state.panelOpen).toBe(true);
    expect(state.activeTabId).toBe('manual-tab-1');
    expect(state.tabOrder).toEqual(['manual-tab-1']);
    expect(state.tabs['manual-tab-1']).toMatchObject({
      id: 'manual-tab-1',
      kind: 'manual',
      hasLiveSession: true,
      title: 'Terminal · Web',
    });
  });

  it('keeps the existing tab order when terminal output updates a newer tab', async () => {
    terminalListTabsMock.mockImplementationOnce(async () => [
      buildTabDto({
        id: 'tab-1',
        title: 'Tab 1',
        updated_at: '2026-03-26T09:00:00.000Z',
      }),
      buildTabDto({
        id: 'tab-2',
        title: 'Tab 2',
        task_id: 'task-2',
        updated_at: '2026-03-26T09:01:00.000Z',
      }),
    ]);

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().initialize();
    expect(useTerminalStore.getState().tabOrder).toEqual(['tab-1', 'tab-2']);

    const outputHandler = eventHandlers['terminal:output'];
    expect(outputHandler).toBeDefined();

    outputHandler?.({
      payload: {
        tab_id: 'tab-2',
        data: 'next line\r\n',
        snapshot: 'npm test\r\nnext line\r\n',
        updated_at: '2026-03-26T10:30:00.000Z',
      },
    });

    const state = useTerminalStore.getState();
    expect(state.tabOrder).toEqual(['tab-1', 'tab-2']);
    expect(state.tabs['tab-2']?.updatedAt).toBe('2026-03-26T10:30:00.000Z');
    expect(state.tabs['tab-2']?.hasUnreadOutput).toBe(true);
  });
});
