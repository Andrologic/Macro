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

const projectGroups = [
  {
    id: 'group-1',
    name: 'Macro',
    isOpen: true,
    projects: [
      {
        id: 'project-1',
        name: 'Web',
        mountName: 'web',
        path: 'C:/repos/web',
        created_at: '2026-03-26T08:00:00.000Z',
        status: 'active',
        metadata: {
          description: '',
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      },
      {
        id: 'project-2',
        name: 'API',
        mountName: 'api',
        path: 'C:/repos/api',
        created_at: '2026-03-26T08:00:00.000Z',
        status: 'active',
        metadata: {
          description: '',
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      },
    ],
  },
];

const buildTasks = () => [
  {
    id: 'task-1',
    plan_id: 'plan-1',
    project_id: 'project-1',
    project_ids: ['project-1', 'project-2'],
    execution_targets: [
      { projectId: 'project-1', branchName: 'feature/task-1-web', worktreeKey: 'task-1-web' },
      { projectId: 'project-2', branchName: 'feature/task-1-api', worktreeKey: 'task-1-api' },
    ],
    title: 'Refactor compiler',
    description: '',
    status: 'Pending',
    dependencies: [],
    estimated_changes: [],
    task_source: 'architect',
    standalone_kind: 'legacy',
    draft: false,
  },
  {
    id: 'task-2',
    plan_id: 'plan-1',
    project_id: 'project-2',
    project_ids: ['project-2'],
    execution_targets: [
      { projectId: 'project-2', branchName: 'feature/task-2-api', worktreeKey: 'task-2-api' },
    ],
    title: 'Task 2',
    description: '',
    status: 'Pending',
    dependencies: [],
    estimated_changes: [],
    task_source: 'architect',
    standalone_kind: 'legacy',
    draft: false,
  },
];

const tasks = buildTasks();

const appStoreState = {
  mode: 'Implement',
  projectGroups,
  selectedGroupId: 'group-1' as string | null,
  selectedProjectId: 'project-1' as string | null,
  selectedTaskId: 'task-1' as string | null,
  setSelectedProject: (projectId: string | null) => {
    appStoreState.selectedProjectId = projectId;
  },
};

const taskStoreState = {
  tasks,
  activeRepositoryPath: null as string | null,
  branchWorktrees: {
    'task-1-web': 'C:/repos/web/.macro/worktrees/task-1',
    'task-1-api': 'C:/repos/api/.macro/worktrees/task-1',
    'task-2-api': 'C:/repos/api/.macro/worktrees/task-2',
  } as Record<string, string>,
};

const eventHandlers: Record<string, ((event: { payload: any }) => void) | undefined> = {};

const buildManualTabDto = (overrides: Partial<TerminalTabDto> = {}): TerminalTabDto => ({
  id: 'manual-tab-project-1',
  kind: 'manual',
  task_id: 'task-1',
  project_id: 'project-1',
  project_name: 'Web',
  mount_name: 'web',
  workspace_path: 'C:/repos/web',
  cwd: 'C:/repos/web',
  title: 'Terminal - Web',
  status: 'idle',
  snapshot: '',
  last_command: null,
  last_exit_code: null,
  has_live_session: true,
  is_restored: false,
  created_at: '2026-03-26T09:00:00.000Z',
  updated_at: '2026-03-26T09:05:00.000Z',
  ...overrides,
});

const buildTaskTabDto = (overrides: Partial<TerminalTabDto> = {}): TerminalTabDto => ({
  id: 'task-tab-project-1',
  kind: 'task',
  task_id: 'task-1',
  project_id: 'project-1',
  project_name: 'Web',
  mount_name: 'web',
  workspace_path: 'C:/repos/web/.macro/worktrees/task-1',
  cwd: 'C:/repos/web/.macro/worktrees/task-1',
  title: 'Task 1 Web',
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

const listenMock = mock(async (eventName: string, handler: (event: { payload: any }) => void) => {
  eventHandlers[eventName] = handler;
  return () => {
    delete eventHandlers[eventName];
  };
});

const terminalListTabsMock = mock(async (): Promise<TerminalTabDto[]> => []);
const terminalCreateTabMock = mock(
  async (params?: {
    kind?: string;
    projectId?: string;
    cwd?: string | null;
    title?: string;
    taskId?: string | null;
    promptContext?: {
      projectLabel?: string | null;
      taskLabel?: string | null;
      branchLabel?: string | null;
    } | null;
  }): Promise<TerminalTabDto> => ({
    id: `${params?.kind === 'task' ? 'task' : 'manual'}-tab-${params?.taskId || 'none'}-${params?.projectId || 'project-1'}`,
    kind: params?.kind === 'task' ? 'task' : 'manual',
    task_id: params?.taskId ?? null,
    project_id: params?.projectId ?? 'project-1',
    project_name: params?.projectId === 'project-2' ? 'API' : 'Web',
    mount_name: params?.projectId === 'project-2' ? 'api' : 'web',
    workspace_path:
      params?.cwd ?? (params?.projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web'),
    cwd: params?.cwd ?? (params?.projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web'),
    title: params?.title ?? (params?.projectId === 'project-2' ? 'Terminal - API' : 'Terminal - Web'),
    status: 'idle',
    snapshot: '',
    last_command: null,
    last_exit_code: null,
    has_live_session: true,
    is_restored: false,
    created_at: '2026-03-26T10:00:00.000Z',
    updated_at: '2026-03-26T10:00:00.000Z',
  })
);
const terminalReconnectTabMock = mock(async (tabId: string): Promise<TerminalTabDto> => ({
  ...buildManualTabDto({ id: tabId }),
  has_live_session: true,
  is_restored: false,
}));
const terminalReadTabMock = mock(async (tabId: string): Promise<TerminalTabDto> => ({
  ...buildTaskTabDto({ id: tabId }),
}));
const buildUpdatedTabDto = (params: {
  tabId: string;
  title: string;
}): TerminalTabDto => {
  const isProject2 = params.tabId.includes('project-2') || params.tabId.includes('-api');
  const isTask2 = params.tabId.includes('task-2');
  return buildManualTabDto({
    id: params.tabId,
    task_id: isTask2 ? 'task-2' : 'task-1',
    project_id: isProject2 ? 'project-2' : 'project-1',
    project_name: isProject2 ? 'API' : 'Web',
    mount_name: isProject2 ? 'api' : 'web',
    workspace_path: isProject2 ? 'C:/repos/api' : 'C:/repos/web',
    cwd: isProject2 ? 'C:/repos/api' : 'C:/repos/web',
    title: params.title,
  });
};
const terminalUpdateTabMetadataMock = mock(
  async (params: {
    tabId: string;
    title: string;
    promptContext?: {
      projectLabel?: string | null;
      taskLabel?: string | null;
      branchLabel?: string | null;
    } | null;
  }): Promise<TerminalTabDto> => buildUpdatedTabDto(params)
);
const loadPreferenceMock = mock(async (_key: string): Promise<unknown> => null);
const savePreferenceMock = mock(async () => undefined);
const resolveProjectExecutionContextMock = mock(
  (params?: { selectedProjectId?: string | null; selectedTaskId?: string | null }) => ({
    projectId: params?.selectedProjectId ?? 'project-1',
    projectName: params?.selectedProjectId === 'project-2' ? 'API' : 'Web',
    taskId: params?.selectedTaskId ?? null,
    workspacePath: params?.selectedProjectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web',
    workspacePathsByProjectId: {
      'project-1': 'C:/repos/web/.macro/worktrees/task-1',
      'project-2': 'C:/repos/api/.macro/worktrees/task-1',
    },
  })
);

mock.module('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

mock.module('../services/tauriIpc', () => ({
  isTauriAvailable: () => true,
  terminalListTabs: terminalListTabsMock,
  terminalCreateTab: terminalCreateTabMock,
  terminalReconnectTab: terminalReconnectTabMock,
  terminalReadTab: terminalReadTabMock,
  terminalUpdateTabMetadata: terminalUpdateTabMetadataMock,
}));

mock.module('../services/preferences', () => ({
  PREF_KEYS: {
    TERMINAL_PANEL_HEIGHT: 'terminalPanelHeight',
    TERMINAL_ACTIVE_TAB_ID: 'terminalActiveTabId',
    TERMINAL_LAST_MANUAL_PROJECT_BY_TASK: 'terminalLastManualProjectByTask',
  },
  loadPreference: loadPreferenceMock,
  savePreference: savePreferenceMock,
}));

mock.module('../services/projectExecutionContext', () => ({
  resolveProjectExecutionContext: resolveProjectExecutionContextMock,
}));

mock.module('./useAppStore', () => ({
  useAppStore: {
    getState: () => appStoreState,
  },
}));

mock.module('./useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      conversations: [
        {
          id: 'conversation-1',
          title: 'manual-feature-1774264545297-kowb7j',
          task_id: 'task-1',
        },
      ],
      selectedConversationId: null,
    }),
  },
}));

mock.module('./useTaskStore', () => ({
  useTaskStore: {
    getState: () => taskStoreState,
  },
}));

let importCounter = 0;

const loadTerminalStore = async () => {
  importCounter += 1;
  return import(`./useTerminalStore.ts?test=${importCounter}`);
};

describe('useTerminalStore', () => {
  beforeEach(() => {
    Object.keys(eventHandlers).forEach((key) => {
      delete eventHandlers[key];
    });
    appStoreState.selectedGroupId = 'group-1';
    appStoreState.selectedProjectId = 'project-1';
    appStoreState.selectedTaskId = 'task-1';
    taskStoreState.tasks = buildTasks();

    terminalListTabsMock.mockReset();
    terminalCreateTabMock.mockReset();
    terminalReconnectTabMock.mockReset();
    terminalReadTabMock.mockReset();
    terminalUpdateTabMetadataMock.mockReset();
    loadPreferenceMock.mockReset();
    savePreferenceMock.mockReset();
    resolveProjectExecutionContextMock.mockReset();
    listenMock.mockReset();

    listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: any }) => void) => {
      eventHandlers[eventName] = handler;
      return () => {
        delete eventHandlers[eventName];
      };
    });
    terminalListTabsMock.mockImplementation(async () => []);
    terminalCreateTabMock.mockImplementation(
      async (params?: {
        kind?: string;
        projectId?: string;
        cwd?: string | null;
        title?: string;
        taskId?: string | null;
        promptContext?: {
          projectLabel?: string | null;
          taskLabel?: string | null;
          branchLabel?: string | null;
        } | null;
      }) => ({
        id: `${params?.kind === 'task' ? 'task' : 'manual'}-tab-${params?.taskId || 'none'}-${params?.projectId || 'project-1'}`,
        kind: params?.kind === 'task' ? 'task' : 'manual',
        task_id: params?.taskId ?? null,
        project_id: params?.projectId ?? 'project-1',
        project_name: params?.projectId === 'project-2' ? 'API' : 'Web',
        mount_name: params?.projectId === 'project-2' ? 'api' : 'web',
        workspace_path:
          params?.cwd ?? (params?.projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web'),
        cwd: params?.cwd ?? (params?.projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web'),
        title:
          params?.title ?? (params?.projectId === 'project-2' ? 'Terminal - API' : 'Terminal - Web'),
        status: 'idle',
        snapshot: '',
        last_command: null,
        last_exit_code: null,
        has_live_session: true,
        is_restored: false,
        created_at: '2026-03-26T10:00:00.000Z',
        updated_at: '2026-03-26T10:00:00.000Z',
      })
    );
    terminalReconnectTabMock.mockImplementation(async (tabId: string) => ({
      ...buildManualTabDto({ id: tabId }),
      has_live_session: true,
      is_restored: false,
    }));
    terminalReadTabMock.mockImplementation(async (tabId: string) => ({
      ...buildTaskTabDto({ id: tabId }),
    }));
    terminalUpdateTabMetadataMock.mockImplementation(async (params) => ({
      ...buildUpdatedTabDto(params),
    }));
    loadPreferenceMock.mockImplementation(async (key: string) => {
      if (key === 'terminalPanelHeight') return 320;
      if (key === 'terminalActiveTabId') return null;
      if (key === 'terminalLastManualProjectByTask') return {};
      return null;
    });
    resolveProjectExecutionContextMock.mockImplementation(
      (params?: { selectedProjectId?: string | null; selectedTaskId?: string | null }) => ({
        projectId: params?.selectedProjectId ?? 'project-1',
        projectName: params?.selectedProjectId === 'project-2' ? 'API' : 'Web',
        taskId: params?.selectedTaskId ?? null,
        workspacePath:
          params?.selectedProjectId === 'project-2'
            ? 'C:/repos/api/.macro/worktrees/task-1'
            : 'C:/repos/web/.macro/worktrees/task-1',
        workspacePathsByProjectId: {
          'project-1': 'C:/repos/web/.macro/worktrees/task-1',
          'project-2': 'C:/repos/api/.macro/worktrees/task-1',
        },
      })
    );
  });

  it('creates a manual terminal for the selected task and selected project', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().togglePanel();

    const state = useTerminalStore.getState();
    expect(terminalCreateTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manual',
        taskId: 'task-1',
        projectId: 'project-1',
        title: 'web - Refactor compiler',
        promptContext: {
          projectLabel: 'web',
          taskLabel: 'Refactor compiler',
          branchLabel: null,
        },
      })
    );
    expect(state.panelOpen).toBe(true);
    expect(state.lastManualProjectIdByTaskId).toEqual({ 'task-1': 'project-1' });
  });

  it('uses the remembered manual project for the current task when available', async () => {
    loadPreferenceMock.mockImplementation(async (key: string) => {
      if (key === 'terminalLastManualProjectByTask') {
        return { 'task-1': 'project-2' };
      }
      if (key === 'terminalPanelHeight') return 320;
      if (key === 'terminalActiveTabId') return null;
      return null;
    });

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().createManualTab();

    expect(terminalCreateTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manual',
        taskId: 'task-1',
        projectId: 'project-2',
        title: 'api - Refactor compiler',
        promptContext: {
          projectLabel: 'api',
          taskLabel: 'Refactor compiler',
          branchLabel: null,
        },
      })
    );
    expect(useTerminalStore.getState().lastManualProjectIdByTaskId).toEqual({ 'task-1': 'project-2' });
  });

  it('falls back to the selected project when the remembered task project is invalid', async () => {
    loadPreferenceMock.mockImplementation(async (key: string) => {
      if (key === 'terminalLastManualProjectByTask') {
        return { 'task-1': 'missing-project' };
      }
      if (key === 'terminalPanelHeight') return 320;
      if (key === 'terminalActiveTabId') return null;
      return null;
    });

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().createManualTab();

    expect(terminalCreateTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        projectId: 'project-1',
      })
    );
  });

  it('reuses an existing manual tab only when task and project both match', async () => {
    terminalListTabsMock.mockImplementationOnce(async () => [
      buildManualTabDto({
        id: 'manual-tab-task-2-project-1',
        task_id: 'task-2',
        project_id: 'project-1',
      }),
      buildManualTabDto({
        id: 'manual-tab-task-1-project-1',
        task_id: 'task-1',
        project_id: 'project-1',
      }),
    ]);

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().createManualTab();

    expect(terminalCreateTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        projectId: 'project-1',
        title: 'web - Refactor compiler #2',
      })
    );
  });

  it('creates a new manual tab even when another task already has one', async () => {
    terminalListTabsMock.mockImplementationOnce(async () => [
      buildManualTabDto({
        id: 'manual-tab-task-2-project-1',
        task_id: 'task-2',
        project_id: 'project-1',
      }),
    ]);

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().createManualTab();

    expect(terminalCreateTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manual',
        taskId: 'task-1',
        projectId: 'project-1',
        title: 'web - Refactor compiler',
      })
    );
  });

  it('filters visible tabs by selected task and selected project', async () => {
    terminalListTabsMock.mockImplementationOnce(async () => [
      buildManualTabDto({ id: 'manual-task-1-web', task_id: 'task-1', project_id: 'project-1' }),
      buildManualTabDto({ id: 'manual-task-1-api', task_id: 'task-1', project_id: 'project-2' }),
      buildManualTabDto({ id: 'manual-task-2-api', task_id: 'task-2', project_id: 'project-2' }),
      buildManualTabDto({ id: 'legacy-manual', task_id: null, project_id: 'project-1' }),
    ]);

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().initialize();

    expect(useTerminalStore.getState().getVisibleTabsForScope().map((tab: { id: string }) => tab.id)).toEqual([
      'manual-task-1-web',
    ]);

    appStoreState.selectedProjectId = 'project-2';

    expect(useTerminalStore.getState().getVisibleTabsForScope().map((tab: { id: string }) => tab.id)).toEqual([
      'manual-task-1-api',
    ]);
    expect(useTerminalStore.getState().hasAnyTabForTask('task-1')).toBe(true);
  });

  it('keeps manual-project memory isolated per task', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    useTerminalStore.getState().rememberManualProjectForTask('task-1', 'project-2');
    appStoreState.selectedTaskId = 'task-2';

    await useTerminalStore.getState().createManualTab();

    expect(terminalCreateTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-2',
        projectId: 'project-2',
        title: 'api - Task 2',
      })
    );
  });

  it('does not update the manual-project memory when creating task tabs', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().ensureTaskTab({
      taskId: 'task-1',
      projectId: 'project-2',
      cwd: 'C:/repos/api/.macro/worktrees/task-1',
      title: 'Task 1 API',
      reveal: false,
      promptContext: {
        projectLabel: 'api',
        taskLabel: 'Refactor compiler',
        branchLabel: null,
      },
    });

    expect(useTerminalStore.getState().lastManualProjectIdByTaskId).toEqual({});
    expect(terminalCreateTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task',
        title: 'Task 1 API',
        promptContext: {
          projectLabel: 'api',
          taskLabel: 'Refactor compiler',
          branchLabel: null,
        },
      })
    );
  });

  it('blocks manual terminals for uninitialized manual drafts', async () => {
    taskStoreState.tasks = [
      {
        ...buildTasks()[0],
        task_source: 'standalone',
        standalone_kind: 'manual_feature',
        draft: true,
        title: 'New feature',
      },
      buildTasks()[1],
    ];

    const { useTerminalStore } = await loadTerminalStore();

    expect(useTerminalStore.getState().getSelectedTaskTerminalScope()).toBeNull();
    await expect(useTerminalStore.getState().createManualTab()).rejects.toThrow(
      'Send a first message to name this feature and initialize its terminal.'
    );
    expect(terminalCreateTabMock).not.toHaveBeenCalled();
  });

  it('syncs stale terminal titles to the current UI task title on initialize', async () => {
    terminalListTabsMock.mockImplementationOnce(async () => [
      buildManualTabDto({
        id: 'manual-task-1-web',
        task_id: 'task-1',
        project_id: 'project-1',
        title: 'Terminal - Web',
      }),
    ]);

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().initialize();

    expect(terminalUpdateTabMetadataMock).toHaveBeenCalledWith({
      tabId: 'manual-task-1-web',
      title: 'web - Refactor compiler',
      promptContext: {
        projectLabel: 'web',
        taskLabel: 'Refactor compiler',
        branchLabel: null,
      },
    });
  });
});

