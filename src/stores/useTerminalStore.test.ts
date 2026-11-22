import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

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
  output_sequence: number;
  generation?: number;
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
      { projectId: 'project-1', branchName: 'feature/task-1-web', worktreeKey: 'task-1-web', repoPath: undefined as string | undefined },
      { projectId: 'project-2', branchName: 'feature/task-1-api', worktreeKey: 'task-1-api', repoPath: undefined as string | undefined },
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
      { projectId: 'project-2', branchName: 'feature/task-2-api', worktreeKey: 'task-2-api', repoPath: undefined as string | undefined },
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
  standaloneProjects: [] as Array<(typeof projectGroups)[number]['projects'][number]>,
  projectGroups,
  selectedGroupId: 'group-1' as string | null,
  selectedProjectId: 'project-1' as string | null,
  selectedTaskId: 'task-1' as string | null,
  setSelectedProject: (projectId: string | null) => {
    appStoreState.selectedProjectId = projectId;
  },
};

const chatStoreState = {
  conversations: [
    {
      id: 'conversation-1',
      title: 'manual-feature-1774264545297-kowb7j',
      task_id: 'task-1',
    },
  ],
  selectedConversationId: null as string | null,
};

const taskStoreState = {
  tasks,
  activeRepositoryPath: null as string | null,
  branchWorktrees: {
    'task-1-web': 'C:/repos/web/.macro/worktrees/task-1',
    'task-1-api': 'C:/repos/api/.macro/worktrees/task-1',
    'task-2-api': 'C:/repos/api/.macro/worktrees/task-2',
  } as Record<string, string>,
  handleTaskCommandTerminalClosed: mock(() => undefined),
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
  output_sequence: 0,
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
  output_sequence: 0,
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
    output_sequence: 0,
    created_at: '2026-03-26T10:00:00.000Z',
    updated_at: '2026-03-26T10:00:00.000Z',
  })
);
const terminalStartCommandTabMock = mock(
  async (params: {
    kind?: string;
    projectId?: string;
    cwd?: string | null;
    title?: string;
    taskId?: string | null;
    command: string;
    promptContext?: {
      projectLabel?: string | null;
      taskLabel?: string | null;
      branchLabel?: string | null;
    } | null;
  }): Promise<TerminalTabDto> => ({
    ...buildTaskTabDto({
      id: `${params.kind === 'worktree_setup' ? 'setup' : 'task-command'}-tab-${params.taskId || 'none'}-${params.projectId || 'project-1'}`,
      kind: params.kind === 'worktree_setup' ? 'worktree_setup' : 'task',
      task_id: params.taskId ?? null,
      project_id: params.projectId ?? 'project-1',
      project_name: params.projectId === 'project-2' ? 'API' : 'Web',
      mount_name: params.projectId === 'project-2' ? 'api' : 'web',
      workspace_path:
        params.cwd ?? (params.projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web'),
      cwd: params.cwd ?? (params.projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web'),
      title: params.title ?? 'Task command',
      status: 'running',
      snapshot: `${params.command}\r\n`,
      last_command: params.command,
      last_exit_code: null,
      has_live_session: true,
      is_restored: false,
      output_sequence: 1,
    }),
  })
);
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
const terminalCloseTabMock = mock(async () => undefined);
const terminalCreateSessionMock = mock(
  async (params: {
    projectId?: string | null;
    cwd?: string | null;
  }) => ({
    id: params.projectId ? `session-${params.projectId}` : 'session-general',
    project_id: params.projectId ?? null,
    project_name: params.projectId == null ? null : params.projectId === 'project-2' ? 'API' : 'Web',
    mount_name: params.projectId == null ? null : params.projectId === 'project-2' ? 'api' : 'web',
    workspace_path:
      params.projectId == null
        ? null
        : params.projectId === 'project-2'
          ? 'C:/repos/api'
          : 'C:/repos/web',
    cwd:
      params.cwd ??
      (params.projectId == null
        ? 'C:/Users/test'
        : params.projectId === 'project-2'
        ? 'C:/repos/api'
        : 'C:/repos/web'),
    status: 'idle',
    last_command: null,
    output: '',
    exit_code: null,
    timed_out: false,
    updated_at: '2026-03-26T10:00:00.000Z',
  })
);
const actualTauriIpc = await import('../services/tauriIpc');
const { loadPreference: actualLoadPreference } = await import('../services/preferences');
const loadPreferenceMock = mock(
  async (key: string): Promise<unknown> =>
    actualLoadPreference(key as any)
);
const savePreferenceMock = mock(async () => undefined);
type MockExecutionContext = {
  projectId: string;
  projectName: string;
  taskId: string | null;
  workspacePath: string;
  workspacePathsByProjectId: Record<string, string>;
};
const resolveProjectExecutionContextMock = mock(
  (params?: { selectedProjectId?: string | null; selectedTaskId?: string | null }): MockExecutionContext => ({
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
const registerUseTerminalStoreMocks = async (counter: number) => {
  const actualPreferences = await import(
    `../services/preferences.ts?terminal-store-preferences-test=${counter}`
  );
  const actualTaskStoreModule = await import(
    `./useTaskStore.ts?terminal-store-task-store-test=${counter}`
  );

  mock.module('@tauri-apps/api/event', () => ({
    listen: listenMock,
  }));

  mock.module('../services/tauriIpc', () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => true,
    terminalCreateSession: terminalCreateSessionMock,
    terminalListTabs: terminalListTabsMock,
    terminalCreateTab: terminalCreateTabMock,
    terminalStartCommandTab: terminalStartCommandTabMock,
    terminalReadTab: terminalReadTabMock,
    terminalUpdateTabMetadata: terminalUpdateTabMetadataMock,
    terminalCloseTab: terminalCloseTabMock,
  }));

  mock.module('../services/preferences', () => ({
    ...actualPreferences,
    loadPreference: loadPreferenceMock,
    savePreference: savePreferenceMock,
  }));

  mock.module('../services/projectExecutionContext', () => ({
    resolveProjectExecutionContext: resolveProjectExecutionContextMock,
  }));

  mock.module('./useAppStore', () => ({
    useAppStore: Object.assign(
      <TSelected = typeof appStoreState>(
        selector?: (state: typeof appStoreState) => TSelected
      ) =>
        selector
          ? selector(appStoreState)
          : (appStoreState as unknown as TSelected),
      {
        getState: () => appStoreState,
        setState: (
          patch:
            | Partial<typeof appStoreState>
            | ((state: typeof appStoreState) => Partial<typeof appStoreState>)
        ) => {
          Object.assign(
            appStoreState,
            typeof patch === 'function' ? patch(appStoreState) : patch
          );
        },
        subscribe: () => () => undefined,
      }
    ),
  }));

  mock.module('./useChatStore', () => ({
    useChatStore: Object.assign(
      <TSelected = typeof chatStoreState>(
        selector?: (state: typeof chatStoreState) => TSelected
      ) =>
        selector
          ? selector(chatStoreState)
          : (chatStoreState as unknown as TSelected),
      {
        getState: () => chatStoreState,
        setState: (
          patch:
            | Partial<typeof chatStoreState>
            | ((state: typeof chatStoreState) => Partial<typeof chatStoreState>)
        ) => {
          Object.assign(
            chatStoreState,
            typeof patch === 'function' ? patch(chatStoreState) : patch
          );
        },
        subscribe: () => () => undefined,
      }
    ),
  }));

  mock.module('./useTaskStore', () => ({
    ...actualTaskStoreModule,
    getPlanActivationCandidateTask: () => null,
    useTaskStore: Object.assign(
      <TSelected = typeof taskStoreState>(
        selector?: (state: typeof taskStoreState) => TSelected
      ) =>
        selector
          ? selector(taskStoreState)
          : (taskStoreState as unknown as TSelected),
      {
        getState: () => taskStoreState,
        subscribe: () => () => undefined,
      }
    ),
  }));
};

let importCounter = 0;

const loadTerminalStore = async () => {
  importCounter += 1;
  await registerUseTerminalStoreMocks(importCounter);
  return import(`./useTerminalStore.ts?test=${importCounter}`);
};

describe('useTerminalStore', () => {
  afterEach(() => {
    mock.restore();
  });

  beforeEach(() => {
    Object.keys(eventHandlers).forEach((key) => {
      delete eventHandlers[key];
    });
    appStoreState.selectedGroupId = 'group-1';
    appStoreState.selectedProjectId = 'project-1';
    appStoreState.selectedTaskId = 'task-1';
    appStoreState.standaloneProjects = [];
    appStoreState.projectGroups = projectGroups;
    taskStoreState.tasks = buildTasks();
    taskStoreState.handleTaskCommandTerminalClosed.mockClear();

    terminalListTabsMock.mockReset();
    terminalCreateSessionMock.mockReset();
    terminalCreateTabMock.mockReset();
    terminalStartCommandTabMock.mockReset();
    terminalReadTabMock.mockReset();
    terminalUpdateTabMetadataMock.mockReset();
    terminalCloseTabMock.mockReset();
    terminalCloseTabMock.mockImplementation(async () => undefined);
    loadPreferenceMock.mockReset();
    savePreferenceMock.mockReset();
    savePreferenceMock.mockImplementation(async () => undefined);
    resolveProjectExecutionContextMock.mockReset();
    listenMock.mockReset();

    listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: any }) => void) => {
      eventHandlers[eventName] = handler;
      return () => {
        delete eventHandlers[eventName];
      };
    });
    terminalListTabsMock.mockImplementation(async () => []);
    terminalCreateSessionMock.mockImplementation(
      async (params: { projectId?: string | null; cwd?: string | null }) => ({
        id: params.projectId ? `session-${params.projectId}` : 'session-general',
        project_id: params.projectId ?? null,
        project_name:
          params.projectId == null ? null : params.projectId === 'project-2' ? 'API' : 'Web',
        mount_name:
          params.projectId == null ? null : params.projectId === 'project-2' ? 'api' : 'web',
        workspace_path:
          params.projectId == null
            ? null
            : params.projectId === 'project-2'
              ? 'C:/repos/api'
              : 'C:/repos/web',
        cwd:
          params.cwd ??
          (params.projectId == null
            ? 'C:/Users/test'
            : params.projectId === 'project-2'
            ? 'C:/repos/api'
            : 'C:/repos/web'),
        status: 'idle',
        last_command: null,
        output: '',
        exit_code: null,
        timed_out: false,
        updated_at: '2026-03-26T10:00:00.000Z',
      })
    );
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
        output_sequence: 0,
        created_at: '2026-03-26T10:00:00.000Z',
        updated_at: '2026-03-26T10:00:00.000Z',
      })
    );
    terminalStartCommandTabMock.mockImplementation(
      async (params: {
        kind?: string;
        projectId?: string;
        cwd?: string | null;
        title?: string;
        taskId?: string | null;
        command: string;
        promptContext?: {
          projectLabel?: string | null;
          taskLabel?: string | null;
          branchLabel?: string | null;
        } | null;
      }) =>
        buildTaskTabDto({
          id: `${params.kind === 'worktree_setup' ? 'setup' : 'task-command'}-tab-${params.taskId || 'none'}-${params.projectId || 'project-1'}`,
          kind: params.kind === 'worktree_setup' ? 'worktree_setup' : 'task',
          task_id: params.taskId ?? null,
          project_id: params.projectId ?? 'project-1',
          project_name: params.projectId === 'project-2' ? 'API' : 'Web',
          mount_name: params.projectId === 'project-2' ? 'api' : 'web',
          workspace_path:
            params.cwd ?? (params.projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web'),
          cwd: params.cwd ?? (params.projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web'),
          title: params.title ?? 'Task command',
          status: 'running',
          snapshot: `${params.command}\r\n`,
          last_command: params.command,
          last_exit_code: null,
          has_live_session: true,
          is_restored: false,
          output_sequence: 1,
        })
    );
    terminalReadTabMock.mockImplementation(async (tabId: string) => ({
      ...buildTaskTabDto({ id: tabId }),
    }));
    terminalUpdateTabMetadataMock.mockImplementation(async (params) => ({
      ...buildUpdatedTabDto(params),
    }));
    loadPreferenceMock.mockImplementation(async (key: string) => {
      if (key === 'terminalActiveTabId') return null;
      if (key === 'terminalLastManualProjectByTask') return {};
      return actualLoadPreference(key as any);
    });
    resolveProjectExecutionContextMock.mockImplementation(
      (params?: { selectedProjectId?: string | null; selectedTaskId?: string | null }): MockExecutionContext => ({
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

  it('centralizes close for simultaneous callers and ignores a late native tab event', async () => {
    const { createTerminalStore } = await loadTerminalStore();
    const store = createTerminalStore();
    const dto = buildManualTabDto({ id: 'restored-tab' });
    terminalListTabsMock.mockResolvedValueOnce([dto]);
    await store.getState().initialize();
    const tab = store.getState().tabs[dto.id];
    let finishClose!: () => void;
    terminalCloseTabMock.mockImplementationOnce(() => new Promise((resolve) => { finishClose = () => resolve(undefined); }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const close = store.getState().closeTab(tab.id);
    expect(store.getState().closeTab(tab.id)).toBe(close);
    eventHandlers['terminal:closed']?.({ payload: { tab_id: tab.id } });
    finishClose();
    await close;
    eventHandlers['terminal:tab']?.({ payload: { ...dto, generation: 2 } });
    expect(terminalCloseTabMock).toHaveBeenCalledTimes(1);
    expect(store.getState().tabs[tab.id]).toBeUndefined();
    await store.getState().stopRuntime();
  });

  it('drains late listener acquisition and native work before restart without closing native tabs', async () => {
    const { createTerminalStore } = await loadTerminalStore();
    const releases: Array<ReturnType<typeof mock>> = [];
    const registrations: Array<(release: () => void) => void> = [];
    listenMock.mockImplementation(() => new Promise((resolve) => { registrations.push(resolve); }));
    const store = createTerminalStore();
    const starting = store.getState().initialize().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registrations).toHaveLength(3);
    let drained = false;
    const stopping = store.getState().stopRuntime().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    for (const resolve of registrations) {
      const release = mock(() => undefined);
      releases.push(release);
      resolve(release);
    }
    await Promise.all([starting, stopping]);
    await store.getState().stopRuntime();
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
    expect(terminalCloseTabMock).not.toHaveBeenCalled();
    expect(store.getState().initialized).toBe(false);
  });

  it('retries failed subscriptions after cleaning up partial registrations', async () => {
    listenMock.mockImplementationOnce(async () => { throw new Error('offline'); });
    const { useTerminalStore } = await loadTerminalStore();
    await expect(useTerminalStore.getState().initialize()).rejects.toThrow('offline');
    expect(useTerminalStore.getState().initialized).toBe(false);
    expect(Object.keys(eventHandlers)).toHaveLength(0);
    await useTerminalStore.getState().initialize();
    expect(Object.keys(eventHandlers).sort()).toEqual(['terminal:closed', 'terminal:output', 'terminal:tab']);
    expect(listenMock).toHaveBeenCalledTimes(6);
  });

  it('keeps a closed tab absent after a delayed metadata response', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    const dto = buildManualTabDto({ id: 'restored-tab' });
    terminalListTabsMock.mockResolvedValueOnce([dto]);
    await useTerminalStore.getState().initialize();
    const tab = useTerminalStore.getState().tabs[dto.id];
    let finish!: (dto: TerminalTabDto) => void;
    terminalUpdateTabMetadataMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const syncing = useTerminalStore.getState().syncTerminalDisplayMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await useTerminalStore.getState().closeTab(tab.id);
    finish(buildManualTabDto({ id: tab.id }));
    await syncing;
    expect(useTerminalStore.getState().tabs[tab.id]).toBeUndefined();
    expect(useTerminalStore.getState().tabOrder).not.toContain(tab.id);
    expect(useTerminalStore.getState().activeTabId).not.toBe(tab.id);
  });

  it('subscribes before listing tabs and replays events over the initial snapshot', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    terminalListTabsMock.mockImplementationOnce(async () => {
      expect(Object.keys(eventHandlers)).toHaveLength(3);
      eventHandlers['terminal:tab']?.({ payload: buildTaskTabDto({ id: 'changed', status: 'completed', generation: 2 }) });
      eventHandlers['terminal:closed']?.({ payload: { tab_id: 'closed' } });
      eventHandlers['terminal:tab']?.({ payload: buildManualTabDto({ id: 'created' }) });
      return [buildTaskTabDto({ id: 'changed', status: 'running', generation: 1 }), buildManualTabDto({ id: 'closed' })];
    });
    await useTerminalStore.getState().initialize();
    expect(useTerminalStore.getState().tabs.changed.status).toBe('completed');
    expect(useTerminalStore.getState().tabs.closed).toBeUndefined();
    expect(useTerminalStore.getState().tabs.created).toBeDefined();
  });

  it('deduplicates concurrent task tab creation and reuses the live tab', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    await useTerminalStore.getState().initialize();
    let finish!: (dto: TerminalTabDto) => void;
    terminalCreateTabMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const open = (reveal = false) => useTerminalStore.getState().ensureTaskTab({
      taskId: 'task-1', projectId: 'project-1', cwd: '/synthetic', title: 'fixture', reveal,
    });
    const first = open();
    const second = open(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(terminalCreateTabMock).toHaveBeenCalledTimes(1);
    finish(buildTaskTabDto({ has_live_session: true }));
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(useTerminalStore.getState().activeTabId).toBe(a.id);
    await open();
    expect(terminalCreateTabMock).toHaveBeenCalledTimes(1);
  });

  it('releases a rejected task tab opening so it can be retried', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    const open = () => useTerminalStore.getState().ensureTaskTab({
      taskId: 'task-1', projectId: 'project-1', cwd: '/synthetic', title: 'fixture', reveal: false,
    });
    terminalCreateTabMock.mockImplementationOnce(async () => { throw new Error('offline'); });
    await expect(open()).rejects.toThrow('offline');
    await expect(open()).resolves.toBeDefined();
    expect(terminalCreateTabMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces output by generation before sequence', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    const dto = buildManualTabDto({ id: 'restored-tab' });
    terminalListTabsMock.mockResolvedValueOnce([dto]);
    await useTerminalStore.getState().initialize();
    const tab = useTerminalStore.getState().tabs[dto.id];
    eventHandlers['terminal:output']?.({ payload: { tab_id: tab.id, generation: 20, sequence: 101, snapshot: 'old' } });
    eventHandlers['terminal:tab']?.({ payload: buildManualTabDto({ id: tab.id, generation: 21, snapshot: 'base' }) });
    eventHandlers['terminal:output']?.({ payload: { tab_id: tab.id, generation: 21, sequence: 1, snapshot: 'PROMPT' } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(useTerminalStore.getState().tabs[tab.id].snapshot).toBe('PROMPT');
    expect(useTerminalStore.getState().tabs[tab.id].outputSequence).toBe(1);
  });

  it('keeps final command events that arrive before creation replies', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    await useTerminalStore.getState().initialize();
    for (const status of ['completed', 'failed']) {
      for (const kind of ['task', 'worktree_setup']) {
        let finish!: (dto: TerminalTabDto) => void;
        terminalStartCommandTabMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const params = { taskId: 'task-1', projectId: 'project-1', cwd: '/synthetic', title: 'fixture', command: 'echo fixture' };
        const creating = kind === 'task'
          ? useTerminalStore.getState().startTaskCommandTab(params)
          : useTerminalStore.getState().startWorktreeSetupCommandTab(params);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const id = `${kind}-${status}`;
        eventHandlers['terminal:tab']?.({ payload: buildTaskTabDto({ id, kind, status, generation: 20, snapshot: 'final', has_live_session: false }) });
        finish(buildTaskTabDto({ id, kind, status: 'running', generation: 10, has_live_session: true }));
        const tab = await creating;
        expect(tab.status).toBe(status);
        expect(tab.snapshot).toBe('final');
        expect(tab.hasLiveSession).toBe(false);
      }
    }
  });

  it('creates terminal sessions in the selected task worktree by default', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    const session = await useTerminalStore.getState().createSession({
      projectId: 'project-1',
    });

    expect(terminalCreateSessionMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: 'C:/repos/web/.macro/worktrees/task-1',
    });
    expect(session.cwd).toBe('C:/repos/web/.macro/worktrees/task-1');
  });

  it('creates general terminal sessions without resolving a project', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    const session = await useTerminalStore.getState().createSession({
      projectId: null,
      cwd: 'C:/Users/test/Documents',
    });

    expect(terminalCreateSessionMock).toHaveBeenCalledWith({
      projectId: null,
      cwd: 'C:/Users/test/Documents',
    });
    expect(session).toMatchObject({
      project_id: null,
      workspace_path: null,
      cwd: 'C:/Users/test/Documents',
    });
    expect(useTerminalStore.getState().lastSessionIdByProjectId).toEqual({});
  });

  it('retargets stale standalone task project ids when creating a terminal session', async () => {
    appStoreState.standaloneProjects = [
      {
        id: 'project-lplr-current',
        name: 'sample-app',
        mountName: 'sample-app',
        path: 'C:/repos/sample-app',
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
    ];
    appStoreState.projectGroups = [];
    appStoreState.selectedGroupId = null;
    appStoreState.selectedProjectId = 'project-lplr-current';
    appStoreState.selectedTaskId = 'task-stale';
    taskStoreState.tasks = [
      {
        id: 'task-stale',
        plan_id: '',
        project_id: 'project-sample-app-1780237886690',
        project_ids: ['project-sample-app-1780237886690'],
        execution_targets: [
          {
            projectId: 'project-sample-app-1780237886690',
            branchName: 'feature/catalogue',
            worktreeKey: 'stale-worktree',
            repoPath: 'C:/repos/sample-app',
          },
        ],
        title: 'Standalone stale task',
        description: '',
        status: 'Pending',
        dependencies: [],
        estimated_changes: [],
        task_source: 'standalone',
        standalone_kind: 'manual_feature',
        draft: false,
      },
    ];
    resolveProjectExecutionContextMock.mockImplementation(
      (params?: { selectedProjectId?: string | null; selectedTaskId?: string | null }): MockExecutionContext => ({
        projectId: params?.selectedProjectId ?? 'project-lplr-current',
        projectName: 'sample-app',
        taskId: params?.selectedTaskId ?? null,
        workspacePath: 'C:/repos/sample-app',
        workspacePathsByProjectId: {
          'project-lplr-current': 'C:/repos/sample-app',
        },
      })
    );

    const { useTerminalStore } = await loadTerminalStore();
    await useTerminalStore.getState().createSession({
      projectId: 'project-sample-app-1780237886690',
    });

    expect(terminalCreateSessionMock).toHaveBeenCalledWith({
      projectId: 'project-lplr-current',
      cwd: 'C:/repos/sample-app',
    });
  });

  it('resolves relative createSession cwd values from the task worktree', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    const session = await useTerminalStore.getState().createSession({
      projectId: 'project-2',
      cwd: 'packages/api',
    });

    expect(terminalCreateSessionMock).toHaveBeenCalledWith({
      projectId: 'project-2',
      cwd: 'C:/repos/api/.macro/worktrees/task-1/packages/api',
    });
    expect(session.cwd).toBe('C:/repos/api/.macro/worktrees/task-1/packages/api');
  });

  it('falls back to the project root when no task worktree is selected', async () => {
    appStoreState.selectedTaskId = null;

    const { useTerminalStore } = await loadTerminalStore();

    const session = await useTerminalStore.getState().createSession({
      projectId: 'project-1',
    });

    expect(terminalCreateSessionMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: 'C:/repos/web',
    });
    expect(session.cwd).toBe('C:/repos/web');
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

  it('starts task command tabs through the command-backed Tauri path', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    const tab = await useTerminalStore.getState().startTaskCommandTab({
      taskId: 'task-1',
      projectId: 'project-2',
      cwd: 'C:/repos/api/.macro/worktrees/task-1',
      title: 'Task 1 API',
      command: 'flutter install; flutter run -d macos',
      reveal: true,
      promptContext: {
        projectLabel: 'api',
        taskLabel: 'Refactor compiler',
        branchLabel: null,
      },
    });

    expect(terminalStartCommandTabMock).toHaveBeenCalledWith({
      kind: 'task',
      projectId: 'project-2',
      cwd: 'C:/repos/api/.macro/worktrees/task-1',
      title: 'Task 1 API',
      taskId: 'task-1',
      command: 'flutter install; flutter run -d macos',
      promptContext: {
        projectLabel: 'api',
        taskLabel: 'Refactor compiler',
        branchLabel: null,
      },
    });
    expect(terminalCreateTabMock).not.toHaveBeenCalled();
    expect(tab.status).toBe('running');
    expect(tab.snapshot).toBe('flutter install; flutter run -d macos\r\n');
    expect(tab.outputSequence).toBe(1);
    expect(useTerminalStore.getState().activeTabId).toBe(tab.id);
  });

  it('keeps incomplete native closes inactive and reachable after initialization', async () => {
    const retained = [
      buildManualTabDto({ status: 'closed', has_live_session: false }),
      buildTaskTabDto({
        kind: 'worktree_setup', status: 'closed', has_live_session: false, is_restored: false,
      }),
    ];
    terminalListTabsMock.mockResolvedValueOnce(retained);
    const { useTerminalStore } = await loadTerminalStore();
    await useTerminalStore.getState().initialize();

    expect(terminalUpdateTabMetadataMock).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().getVisibleTabsForScope().map((tab: { id: string }) => tab.id))
      .toEqual(retained.map((tab) => tab.id));
    for (const dto of retained) {
      expect(useTerminalStore.getState().tabs[dto.id].hasLiveSession).toBe(false);
      expect(useTerminalStore.getState().tabs[dto.id].status).toBe('closed');
      await useTerminalStore.getState().closeTab(dto.id);
      expect(terminalCloseTabMock).toHaveBeenCalledWith(dto.id);
      expect(useTerminalStore.getState().tabs[dto.id]).toBeUndefined();
    }
  });

  it('keeps successful worktree setup tabs hidden from the visible terminal scope', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    const tab = await useTerminalStore.getState().startWorktreeSetupCommandTab({
      taskId: 'task-1',
      projectId: 'project-1',
      cwd: 'C:/repos/web/.macro/worktrees/task-1',
      title: 'Setup - Web',
      command: 'bun install',
      promptContext: null,
    });

    expect(terminalStartCommandTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'worktree_setup',
        projectId: 'project-1',
        command: 'bun install',
      })
    );
    expect(tab.purpose).toBe('worktree_setup');
    expect(useTerminalStore.getState().getVisibleTabsForScope()).toEqual([]);
    expect(useTerminalStore.getState().hasAnyTabForTask('task-1')).toBe(false);
  });

  it('reveals failed worktree setup tabs in the visible terminal scope', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    await useTerminalStore.getState().initialize();

    const tab = await useTerminalStore.getState().startWorktreeSetupCommandTab({
      taskId: 'task-1',
      projectId: 'project-1',
      cwd: 'C:/repos/web/.macro/worktrees/task-1',
      title: 'Setup - Web',
      command: 'bun install',
      promptContext: null,
    });

    eventHandlers['terminal:tab']?.({
      payload: buildTaskTabDto({
        id: tab.id,
        kind: 'worktree_setup',
        task_id: 'task-1',
        project_id: 'project-1',
        status: 'failed',
        has_live_session: false,
        last_exit_code: 1,
        output_sequence: tab.outputSequence + 1,
      }),
    });

    expect(
      useTerminalStore
        .getState()
        .getVisibleTabsForScope()
        .map((candidate: { id: string }) => candidate.id)
    ).toEqual([tab.id]);
  });

  it('retargets stale standalone task project ids before creating task tabs', async () => {
    const standaloneProject = {
      id: 'project-lplr-current',
      name: 'LPLR App',
      mountName: 'sample-app',
      path: 'C:/repos/sample-app',
      created_at: '2026-03-26T08:00:00.000Z',
      status: 'active',
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    };
    appStoreState.selectedGroupId = null;
    appStoreState.selectedProjectId = standaloneProject.id;
    appStoreState.standaloneProjects = [standaloneProject];
    appStoreState.selectedTaskId = 'task-stale';
    taskStoreState.tasks = [
      {
        ...buildTasks()[0],
        id: 'task-stale',
        project_id: 'project-sample-app-1780237886690',
        project_ids: ['project-sample-app-1780237886690'],
        execution_targets: [
          {
            projectId: 'project-sample-app-1780237886690',
            branchName: 'feature/catalogue',
            worktreeKey: 'project-sample-app-1780237886690::feature/catalogue',
            repoPath: 'C:/repos/sample-app',
          },
        ],
        task_source: 'standalone',
        standalone_kind: 'manual_feature',
      },
    ];

    const { useTerminalStore } = await loadTerminalStore();

    await useTerminalStore.getState().ensureTaskTab({
      taskId: 'task-stale',
      projectId: 'project-sample-app-1780237886690',
      cwd: 'C:/repos/sample-app/.macro/worktrees/feature-catalogue',
      title: 'Catalogue',
      reveal: true,
      promptContext: null,
    });

    expect(terminalCreateTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task',
        taskId: 'task-stale',
        projectId: 'project-lplr-current',
      })
    );
  });

  it('starts a guarded command without synchronizing unrelated restored terminal metadata', async () => {
    terminalListTabsMock.mockImplementationOnce(async () => [buildManualTabDto({
      id: 'unrelated-tab', task_id: 'other-task', project_id: 'project-1', title: 'Old title',
    })]);
    const { useTerminalStore } = await loadTerminalStore();
    let authorizationCount = 0;
    await useTerminalStore.getState().startTaskCommandTab({ taskId: 'task-1', projectId: 'project-2',
      cwd: 'C:/repos/api', title: 'Run fixture', command: 'echo fixture', reveal: false,
      beforeEffect: async () => { authorizationCount++; },
    });
    expect(authorizationCount).toBe(2);
    expect(terminalStartCommandTabMock.mock.calls[0]?.[0]).toMatchObject({ pilotOnly: true });
    expect(terminalUpdateTabMetadataMock).not.toHaveBeenCalled();
    expect(terminalStartCommandTabMock).toHaveBeenCalledTimes(1);
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

  it('ignores a terminal tab event from an older runtime generation', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    const dto = buildManualTabDto({ id: 'restored-tab' });
    terminalListTabsMock.mockResolvedValueOnce([dto]);
    await useTerminalStore.getState().initialize();
    const tab = useTerminalStore.getState().tabs[dto.id];

    eventHandlers['terminal:tab']?.({
      payload: buildManualTabDto({
        id: tab.id,
        snapshot: 'new snapshot',
        generation: 2,
        output_sequence: 2,
      }),
    });
    eventHandlers['terminal:tab']?.({
      payload: buildManualTabDto({
        id: tab.id,
        snapshot: 'stale snapshot',
        generation: 1,
        output_sequence: 1,
      }),
    });

    expect(useTerminalStore.getState().tabs[tab.id]?.snapshot).toBe('new snapshot');
    expect(useTerminalStore.getState().tabs[tab.id]?.generation).toBe(2);
  });

  it('ignores terminal output from an older runtime generation', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    const dto = buildManualTabDto({ id: 'restored-tab' });
    terminalListTabsMock.mockResolvedValueOnce([dto]);
    await useTerminalStore.getState().initialize();
    const tab = useTerminalStore.getState().tabs[dto.id];

    eventHandlers['terminal:tab']?.({
      payload: buildManualTabDto({
        id: tab.id,
        snapshot: 'current snapshot',
        generation: 2,
        output_sequence: 2,
      }),
    });
    eventHandlers['terminal:output']?.({
      payload: {
        tab_id: tab.id,
        data: 'stale output',
        snapshot: 'stale snapshot',
        sequence: 9,
        generation: 1,
        updated_at: '2026-03-26T10:01:00.000Z',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useTerminalStore.getState().tabs[tab.id]?.snapshot).toBe('current snapshot');
    expect(useTerminalStore.getState().tabs[tab.id]?.generation).toBe(2);
  });

  it('closes task command tabs through Tauri and clears the associated task command run', async () => {
    const { useTerminalStore } = await loadTerminalStore();

    const tab = await useTerminalStore.getState().startTaskCommandTab({
      taskId: 'task-1',
      projectId: 'project-1',
      cwd: 'C:/repos/web/.macro/worktrees/task-1',
      title: 'Task 1 Web',
      command: 'bun test',
      reveal: true,
      promptContext: null,
    });

    await useTerminalStore.getState().closeTab(tab.id);

    expect(terminalCloseTabMock).toHaveBeenCalledWith(tab.id);
    expect(taskStoreState.handleTaskCommandTerminalClosed).toHaveBeenCalledWith(tab.id);
    expect(useTerminalStore.getState().tabs[tab.id]).toBeUndefined();
    expect(useTerminalStore.getState().panelOpen).toBe(false);
  });

  it('clears task command runs when command tabs finish', async () => {
    const { useTerminalStore } = await loadTerminalStore();
    await useTerminalStore.getState().initialize();

    const tab = await useTerminalStore.getState().startTaskCommandTab({
      taskId: 'task-1',
      projectId: 'project-1',
      cwd: 'C:/repos/web/.macro/worktrees/task-1',
      title: 'Task 1 Web',
      command: 'bun test',
      reveal: true,
      promptContext: null,
    });

    eventHandlers['terminal:tab']?.({
      payload: buildTaskTabDto({
        id: tab.id,
        task_id: 'task-1',
        project_id: 'project-1',
        status: 'completed',
        has_live_session: false,
        last_exit_code: 0,
        output_sequence: tab.outputSequence + 1,
      }),
    });

    expect(taskStoreState.handleTaskCommandTerminalClosed).toHaveBeenCalledWith(tab.id);
  });
});
