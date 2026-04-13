import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AppMode, Conversation, ProjectGroup } from '../types';
import type { ArchitectPlanRecord } from '../services/architectPlanService';

interface LocalStorageMock {
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
  readonly length: number;
}

const createLocalStorageMock = (): LocalStorageMock => {
  const store = new Map<string, string>();

  return {
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    get length() {
      return store.size;
    },
  };
};

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

const projectGroups: ProjectGroup[] = [
  {
    id: 'group-1',
    name: 'Macro',
    isOpen: true,
    projects: [
      {
        id: 'project-1',
        name: 'Web',
        path: '/repos/web',
        mountName: 'web',
        created_at: '2026-03-19T00:00:00.000Z',
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

const appState = {
  mode: 'Architect' as AppMode,
  agentType: 'build' as const,
  selectedGroupId: 'group-1' as string | null,
  selectedProjectId: 'project-1' as string | null,
  selectedTaskId: null as string | null,
  activeArchitectPlanId: null as string | null,
  activePlanContext: null as { targetBranch: string } | null,
  projectGroups,
  getProjectById: (projectId: string) =>
    projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId),
  setActiveArchitectPlanId: (_planId: string | null) => undefined,
  setPlanNodes: (_nodes: unknown[]) => undefined,
  setPredictedBranches: (_branches: unknown[]) => undefined,
  setActivePlanContext: (_context: unknown) => undefined,
  switchProjectContext: mock(async (_projectId: string, _options?: unknown) => undefined),
};

const providerState = {
  providerConfigs: [
    {
      id: 'provider-1',
      name: 'Local',
      providerType: 'openai',
      isEnabled: true,
      isLocal: true,
      hasStoredApiKey: false,
      apiKeyLoaded: true,
      apiKey: '',
    },
  ],
  modelsByProvider: {
    'provider-1': [{ id: 'model-1', name: 'Model 1', isEnabled: true }],
  } as Record<string, Array<{ id: string; name: string; isEnabled: boolean }>>,
  selectedProviderId: 'provider-1' as string | null,
  selectedModelId: 'model-1' as string | null,
  selectedReasoningEffort: null as string | null,
  loadProviderModels: mock(async (providerId: string) => providerState.modelsByProvider[providerId] ?? []),
  scanModelsForProvider: mock(async (providerId: string) => providerState.modelsByProvider[providerId] ?? []),
  resolveProviderApiKey: mock(async () => undefined),
  selectedSupportsNativeToolCalling: () => false,
  markReasoningUnsupportedForModel: mock(() => undefined),
  markProviderReachable: mock(() => undefined),
  selectModel: mock((modelId: string) => {
    providerState.selectedModelId = modelId;
  }),
  selectReasoningEffort: mock((effort: string | null) => {
    providerState.selectedReasoningEffort = effort;
  }),
  selectProvider: mock((providerId: string) => {
    providerState.selectedProviderId = providerId;
  }),
};

const ALL_INTERNAL_TOOL_IDS = [
  'mark_source_passage',
  'read_sources',
  'edit_source_passage',
  'read_file',
  'web_search',
  'web_fetch',
  'list',
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  'git_status',
  'git_log',
  'git_branch_list',
  'git_diff',
  'git_get_tree',
  'git_add',
  'git_commit',
  'git_checkout',
  'git_merge',
  'git_reset',
  'git_stash',
  'terminal_create_session',
  'terminal_run',
  'terminal_read',
  'terminal_kill',
  'need_add',
  'strategy_generate',
  'plan_create',
  'plan_list',
  'plan_get',
  'plan_update',
  'plan_delete',
  'plan_restore',
  'plan_set_active',
  'strategy_get',
  'strategy_update',
  'strategy_delete',
] as const;

const toolsStoreState = {
  selectedTools: [] as string[],
  setSelectedTools: () => undefined,
  internalTools: Object.fromEntries(
    ALL_INTERNAL_TOOL_IDS.map((toolId) => [toolId, { id: toolId }])
  ) as Record<string, { id: string }>,
  isToolEnabled: (_toolId: string) => true,
  getEnabledChatToolIds: () => ['read_file', 'web_search', 'web_fetch'],
  loadSettings: mock(async () => undefined),
};

const useProviderStoreMock = {
  getState: () => providerState,
  setState: (patch: Partial<typeof providerState>) => {
    Object.assign(providerState, patch);
  },
  subscribe: () => () => undefined,
};

const taskStoreState = {
  tasks: [] as Array<Record<string, unknown>>,
  lastError: null as string | null,
  currentTask: null as Record<string, unknown> | null,
  refreshFromPlan: mock(async () => undefined),
  clearPlanRuntimeState: mock(() => undefined),
  getTaskById: (taskId: string) =>
    (taskStoreState.tasks.find((task) => task.id === taskId) as Record<string, unknown> | undefined),
  finalizeManualFeatureDraft: mock(async (params: {
    taskId: string;
    title: string;
    description: string;
    featureSlug: string;
  }) => {
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === params.taskId
        ? {
            ...task,
            title: params.title,
            description: params.description,
            draft: false,
            feature_slug: params.featureSlug,
            assigned_branch: `feature/${params.featureSlug}`,
            branch_name: `feature/${params.featureSlug}`,
            status: 'Pending',
          }
        : task
    );
  }),
  startTask: mock(async (taskId: string) => {
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'InProgress',
          }
        : task
    );
  }),
  markTaskAwaitingResponse: mock(async (taskId: string) => {
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'AwaitingResponse',
          }
        : task
    );
  }),
  retryTask: mock(async (taskId: string) => {
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'InProgress',
          }
        : task
    );
  }),
  deleteManualFeatureDraft: mock(async (taskId: string) => {
    taskStoreState.tasks = taskStoreState.tasks.filter((task) => task.id !== taskId);
  }),
};

const architectPlans = new Map<string, ArchitectPlanRecord>();
const architectPlanMessages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }>>();
let tauriAvailable = false;
let gitBranchesByRepo: Record<string, { local: Array<{ name: string; is_head: boolean; commit: string }>; remote: Array<{ name: string; is_head: boolean; commit: string }>; current: string | null }> = {};
let chatSnapshotConversations: Array<{
  id: string;
  title: string;
  description: string | null;
  scope_mode: AppMode;
  task_id: string | null;
  group_id: string | null;
  project_id: string | null;
  last_message: string | null;
  message_count: number;
  updated_at: string;
}> = [];
let chatSnapshotMessages: Array<{
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}> = [];

const getArchitectPlanChatMessagesMock = mock(
  async (_branchName: string, planId: string) => architectPlanMessages.get(planId) ?? []
);
const getArchitectPlanMock = mock(async (_branchName: string, planId: string) => architectPlans.get(planId) ?? null);
const listArchitectPlansMock = mock(async (_branchName: string) => ({
  activePlanId: appState.activeArchitectPlanId,
  plans: Array.from(architectPlans.values()),
}));
const updateArchitectPlanMock = mock(async (params: {
  branchName: string;
  planId: string;
  conversationId?: string;
  title?: string;
  label?: string;
  description?: string;
}) => {
  const existing = architectPlans.get(params.planId);
  if (!existing) {
    throw new Error(`Unknown plan ${params.planId}`);
  }
  const updated = {
    ...existing,
    conversationId: params.conversationId ?? existing.conversationId,
    title: params.title ?? existing.title,
    label: params.label ?? existing.label,
    description: params.description ?? existing.description,
    updatedAt: '2026-03-19T01:00:00.000Z',
  };
  architectPlans.set(params.planId, updated);
  return updated;
});

const sendChatNonStreamingMock = mock(
  async () =>
    JSON.stringify({
      title: 'Checkout refresh',
      description: 'Refresh checkout state and cart recovery.',
    })
);
const streamChatMock = mock(async () => ({ usage: null }));

const getLocalProjectContextStateMock = mock(async (_groupId: string) => ({
  architectConversationId: 'project-architect-conversation',
  implementConversationId: null,
}));
const syncArchitectPlanChatFromConversationMock = mock(async () => undefined);
const getChatSnapshotMock = mock(async () => ({
  conversations: chatSnapshotConversations,
  messages: chatSnapshotMessages,
}));
const updateConversationDetailsMock = mock(async () => undefined);
const gitBranchListMock = mock(async (repoPath: string) => (
  gitBranchesByRepo[repoPath] ?? { local: [], remote: [], current: null }
));
const deleteConversationMock = mock(async (_conversationId: string) => undefined);
const deleteConversationsMock = mock(async (_conversationIds: string[]) => undefined);
const importMessagesMock = mock(
  async (
    conversationId: string,
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; created_at: string }>
  ) =>
    messages.map((message) => ({
      ...message,
      conversation_id: conversationId,
    }))
);

let importCounter = 0;
let restoreCounter = 0;

const SHARED_MODULE_RESTORES = [
  ['../services/localProjectContext', '../services/localProjectContext.ts'],
  ['../services/macroSyncService', '../services/macroSyncService.ts'],
  ['../services/projectExecutionContext', '../services/projectExecutionContext.ts'],
  ['../services/tauriIpc', '../services/tauriIpc.ts'],
  ['../services/streamingChat', '../services/streamingChat.ts'],
  ['../services/webSearchSettings', '../services/webSearchSettings.ts'],
  ['../services/workspaceToolExecutor', '../services/workspaceToolExecutor.ts'],
  ['../services/architectPlanService', '../services/architectPlanService.ts'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

const restoreSharedModules = async () => {
  mock.restore();

  for (const [specifier, actualPath] of SHARED_MODULE_RESTORES) {
    restoreCounter += 1;
    const actualModule = await import(`${actualPath}?restore=${restoreCounter}`);
    mock.module(specifier, () => actualModule);
  }
};

const registerUseChatStoreMocks = () => {
  mock.restore();

  mock.module('./useProviderStore', () => ({
    useProviderStore: useProviderStoreMock,
    providerHasCredentials: (provider: {
      isEnabled?: boolean;
      isLocal?: boolean;
      apiKey?: string;
      hasStoredApiKey?: boolean;
      providerType?: string;
      authStatus?: string;
    }) =>
      !!provider.isEnabled &&
      (!!provider.isLocal ||
        !!provider.apiKey ||
        !!provider.hasStoredApiKey ||
        provider.authStatus === 'connected' ||
        provider.authStatus === 'authenticated'),
  }));

  mock.module('./useCitationsStore', () => ({
    useCitationsStore: {
      getState: () => ({
        clearCitations: () => undefined,
        citations: [],
        getConversationContextCitations: () => [],
        getConversationSourceCitations: () => [],
      }),
    },
  }));

  mock.module('./useToolsStore', () => ({
    useToolsStore: {
      getState: () => toolsStoreState,
    },
  }));

  mock.module('./useAppStore', () => ({
    useAppStore: {
      getState: () => appState,
      subscribe: () => () => undefined,
    },
  }));

  mock.module('./useTaskStore', () => ({
    useTaskStore: {
      getState: () => taskStoreState,
    },
  }));

  mock.module('./useNeedsStore', () => ({
    useNeedsStore: {
      getState: () => ({
        replaceNeedsForPlan: () => undefined,
      }),
    },
  }));

  mock.module('./useTerminalStore', () => ({
    useTerminalStore: {
      getState: () => ({
        addTerminalLine: () => undefined,
      }),
    },
  }));

  mock.module('../services/streamingChat', () => ({
    streamChat: streamChatMock,
    cancelStream: mock(() => undefined),
    sendChatNonStreaming: sendChatNonStreamingMock,
  }));

  mock.module('../services/webSearchSettings', () => ({
    getStreamingWebSearchConfig: () => ({
      enableWebSearch: false,
      enableWebFetch: false,
      webSearchOptions: undefined,
    }),
  }));

  mock.module('../services/workspaceToolExecutor', () => ({
    executeWorkspaceTool: mock(async () => undefined),
  }));

  mock.module('../services/tauriIpc', () => ({
    isTauriAvailable: () => tauriAvailable,
    createMessage: mock(async () => {
      throw new Error('unavailable');
    }),
    deleteConversation: deleteConversationMock,
    deleteConversations: deleteConversationsMock,
    gitBranchList: gitBranchListMock,
    getChatSnapshot: getChatSnapshotMock,
    importMessages: importMessagesMock,
    updateMessage: mock(async () => undefined),
    updateConversationDetails: updateConversationDetailsMock,
  }));

  mock.module('../services/architectPlanService', () => ({
    createArchitectPlan: mock(async () => {
      throw new Error('not implemented');
    }),
    deleteArchitectPlan: mock(async () => undefined),
    getArchitectPlan: getArchitectPlanMock,
    getArchitectPlanChatMessages: getArchitectPlanChatMessagesMock,
    getArchitectPlanProjectIds: (plan: ArchitectPlanRecord) =>
      Array.from(new Set([plan.projectId, ...(plan.projectIds ?? [])].filter(Boolean))) as string[],
    isArchitectPlanVisibleForScope: (plan: ArchitectPlanRecord, scopedProjectIds: string[]) => {
      if (scopedProjectIds.length === 0) {
        return true;
      }
      const projectIds = Array.from(new Set([plan.projectId, ...(plan.projectIds ?? [])].filter(Boolean))) as string[];
      if (projectIds.length === 0) {
        return false;
      }
      const scopedProjectIdSet = new Set(scopedProjectIds);
      return projectIds.some((projectId) => scopedProjectIdSet.has(projectId));
    },
    getArchitectPlanNeeds: mock(async () => []),
    getGitFlowBaseBranch: () => 'develop',
    listArchitectPlans: listArchitectPlansMock,
    resolvePlanProjectContextId: (plan: ArchitectPlanRecord, fallbackProjectId?: string | null) =>
      plan.projectId ?? plan.projectIds?.[0] ?? fallbackProjectId ?? null,
    resolveTargetBranch: (branchName?: string | null) => branchName ?? 'develop',
    restoreArchitectPlan: mock(async () => undefined),
    saveArchitectPlanNeeds: mock(async () => undefined),
    setActiveArchitectPlan: mock(async () => undefined),
    syncArchitectPlanChatFromConversation: syncArchitectPlanChatFromConversationMock,
    toPlanIntegrationBranch: (planId: string) => `plan/${planId}`,
    toPlanScopedFeatureBranch: (planId: string, featureSlug: string) => `feature/${planId}/${featureSlug}`,
    updateArchitectPlan: updateArchitectPlanMock,
  }));

  mock.module('../services/localProjectContext', () => ({
    getLocalProjectContextState: getLocalProjectContextStateMock,
  }));

  mock.module('../services/macroSyncService', () => ({
    syncMacroMetadataAfterStream: mock(async () => undefined),
  }));

  mock.module('../services/projectExecutionContext', () => ({
    resolveProjectExecutionContext: mock(async () => ({
      groupName: 'Macro',
      groupId: 'group-1',
      projectName: 'Web',
      projectId: 'project-1',
      focusedProjectId: 'project-1',
      projectIds: ['project-1'],
      taskId: null,
      branchName: 'develop',
      virtualRootEnabled: false,
      projectMounts: [],
    })),
  }));

};

const loadChatStore = async () => {
  importCounter += 1;
  return import(`./useChatStore.ts?test=${importCounter}`);
};

const createConversation = (id: string, projectId = 'project-1'): Conversation => ({
  id,
  title: `Conversation ${id}`,
  description: '',
  scope_mode: projectId ? 'Architect' : 'Chat',
  task_id: null,
  group_id: 'group-1',
  project_id: projectId,
  last_message: '',
  message_count: 0,
  updated_at: '2026-03-19T00:00:00.000Z',
  is_unread: false,
});

const createPlan = (overrides: Partial<ArchitectPlanRecord> = {}): ArchitectPlanRecord => ({
  id: 'plan-1',
  slug: 'plan-1',
  title: 'Plan 1',
  label: 'Checkout refresh',
  description: 'Restore checkout chat',
  status: 'draft',
  targetBranch: 'develop',
  conversationId: 'conv-1',
  projectId: 'project-1',
  projectIds: ['project-1'],
  createdAt: '2026-03-19T00:00:00.000Z',
  updatedAt: '2026-03-19T00:00:00.000Z',
  nodes: [],
  predictedBranches: [],
  ...overrides,
});

const createManualFeatureTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'manual-task-1',
  plan_id: '',
  project_id: 'project-1',
  project_ids: ['project-1'],
  title: 'New feature',
  description: '',
  status: 'Pending',
  dependencies: [],
  estimated_changes: [],
  task_source: 'standalone',
  standalone_kind: 'manual_feature',
  draft: true,
  base_branch: 'develop',
  feature_slug: null,
  conversation_id: 'manual-conv',
  assigned_branch: '',
  branch_name: '',
  branch_id: null,
  branch_task_index: -1,
  sequence_index: 0,
  blocked_by: [],
  is_blocked: false,
  is_ready: false,
  execution_targets: [],
  ...overrides,
});

const createImplementTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  plan_id: 'plan-1',
  project_id: 'project-1',
  project_ids: ['project-1'],
  title: 'Implement checkout',
  description: 'Ship the checkout flow.',
  status: 'Pending',
  dependencies: [],
  estimated_changes: [],
  task_source: 'architect',
  draft: false,
  base_branch: 'develop',
  feature_slug: 'implement-checkout',
  conversation_id: null,
  assigned_branch: 'feature/implement-checkout',
  branch_name: 'feature/implement-checkout',
  branch_id: null,
  branch_task_index: 0,
  sequence_index: 0,
  blocked_by: [],
  is_blocked: false,
  is_ready: true,
  execution_targets: [],
  ...overrides,
});

describe('useChatStore ensureArchitectConversationForPlan', () => {
  let localStorageMock: LocalStorageMock;

  beforeEach(() => {
    registerUseChatStoreMocks();
    localStorageMock = createLocalStorageMock();
    (globalThis as { window?: unknown }).window = {
      localStorage: localStorageMock,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined,
    };
    (globalThis as { localStorage?: unknown }).localStorage = localStorageMock;

    appState.mode = 'Architect';
    appState.agentType = 'build';
    appState.selectedGroupId = 'group-1';
    appState.selectedProjectId = 'project-1';
    appState.selectedTaskId = null;
    appState.activeArchitectPlanId = null;
    appState.activePlanContext = null;

    providerState.selectedProviderId = 'provider-1';
    providerState.selectedModelId = 'model-1';
    providerState.selectedSupportsNativeToolCalling = () => false;
    providerState.loadProviderModels.mockClear();
    providerState.scanModelsForProvider.mockClear();
    providerState.markProviderReachable.mockClear();
    providerState.selectModel.mockClear();
    providerState.selectProvider.mockClear();

    architectPlans.clear();
    architectPlanMessages.clear();
    gitBranchesByRepo = {};
    taskStoreState.tasks = [];
    taskStoreState.currentTask = null;
    taskStoreState.lastError = null;
    taskStoreState.refreshFromPlan.mockClear();
    taskStoreState.clearPlanRuntimeState.mockClear();
    taskStoreState.finalizeManualFeatureDraft.mockClear();
    taskStoreState.startTask.mockClear();
    taskStoreState.markTaskAwaitingResponse.mockClear();
    taskStoreState.retryTask.mockClear();
    taskStoreState.deleteManualFeatureDraft.mockClear();
    tauriAvailable = false;
    chatSnapshotConversations = [];
    chatSnapshotMessages = [];
    getArchitectPlanChatMessagesMock.mockClear();
    getArchitectPlanMock.mockClear();
    listArchitectPlansMock.mockClear();
    updateArchitectPlanMock.mockClear();
    streamChatMock.mockClear();
    sendChatNonStreamingMock.mockClear();
    getLocalProjectContextStateMock.mockClear();
    syncArchitectPlanChatFromConversationMock.mockClear();
    getChatSnapshotMock.mockClear();
    updateConversationDetailsMock.mockClear();
    gitBranchListMock.mockClear();
    deleteConversationMock.mockClear();
    deleteConversationsMock.mockClear();
    importMessagesMock.mockClear();
    toolsStoreState.loadSettings.mockClear();
    appState.switchProjectContext.mockClear();
  });

  afterEach(async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: originalLocalStorage,
    });
    await restoreSharedModules();
  });

  afterAll(async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: originalLocalStorage,
    });
    await restoreSharedModules();
  });

  it('restores a plan transcript into an existing empty conversation', async () => {
    const plan = createPlan();
    architectPlans.set(plan.id, plan);
    architectPlanMessages.set(plan.id, [
      {
        id: 'm-1',
        role: 'user',
        content: 'Where is the checkout regression?',
        createdAt: '2026-03-19T00:01:00.000Z',
      },
      {
        id: 'm-2',
        role: 'assistant',
        content: 'It comes from stale plan hydration.',
        createdAt: '2026-03-19T00:02:00.000Z',
      },
    ]);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('conv-1')],
      messages: [],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const result = await useChatStore.getState().ensureArchitectConversationForPlan({
      plan,
      targetBranch: 'develop',
      fallbackProjectId: 'project-1',
      fallbackGroupId: 'group-1',
    });

    expect(result).toEqual({
      conversationId: 'conv-1',
      restoredTranscript: true,
      createdConversation: false,
    });
    expect(useChatStore.getState().selectedConversationId).toBe('conv-1');
    expect(
      useChatStore
        .getState()
        .getConversationMessages('conv-1')
        .map((message: { content: string }) => message.content)
    ).toEqual(['Where is the checkout regression?', 'It comes from stale plan hydration.']);
    expect(
      useChatStore
        .getState()
        .conversations.find((conversation: Conversation) => conversation.id === 'conv-1')?.message_count
    ).toBe(2);
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
  });

  it('does not duplicate restored transcript messages when called twice', async () => {
    const plan = createPlan();
    architectPlans.set(plan.id, plan);
    architectPlanMessages.set(plan.id, [
      {
        id: 'm-1',
        role: 'user',
        content: 'User question',
        createdAt: '2026-03-19T00:01:00.000Z',
      },
      {
        id: 'm-2',
        role: 'assistant',
        content: 'Assistant answer',
        createdAt: '2026-03-19T00:02:00.000Z',
      },
    ]);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('conv-1')],
      messages: [],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const first = await useChatStore.getState().ensureArchitectConversationForPlan({
      plan,
      targetBranch: 'develop',
    });
    const second = await useChatStore.getState().ensureArchitectConversationForPlan({
      plan,
      targetBranch: 'develop',
    });

    expect(first.restoredTranscript).toBe(true);
    expect(second.restoredTranscript).toBe(false);
    expect(useChatStore.getState().getConversationMessages('conv-1')).toHaveLength(2);
  });

  it('imports only the missing metadata suffix for a partially restored plan transcript', async () => {
    tauriAvailable = true;

    const plan = createPlan();
    architectPlans.set(plan.id, plan);
    architectPlanMessages.set(plan.id, [
      {
        id: 'm-1',
        role: 'user',
        content: 'First question',
        createdAt: '2026-03-19T00:01:00.000Z',
      },
      {
        id: 'm-2',
        role: 'assistant',
        content: 'Second answer',
        createdAt: '2026-03-19T00:02:00.000Z',
      },
    ]);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('conv-1')],
      messages: [
        {
          id: 'm-1',
          task_id: '',
          conversation_id: 'conv-1',
          role: 'user',
          content: 'First question',
          timestamp: '2026-03-19T00:01:00.000Z',
        },
      ],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const result = await useChatStore.getState().ensureArchitectConversationForPlan({
      plan,
      targetBranch: 'develop',
    });

    expect(result.restoredTranscript).toBe(true);
    expect(importMessagesMock).toHaveBeenCalledWith('conv-1', [
      {
        id: 'm-2',
        role: 'assistant',
        content: 'Second answer',
        created_at: '2026-03-19T00:02:00.000Z',
      },
    ]);
    expect(
      useChatStore.getState().getConversationMessages('conv-1').map((message: { id: string; timestamp: string }) => ({
        id: message.id,
        timestamp: message.timestamp,
      }))
    ).toEqual([
      { id: 'm-1', timestamp: '2026-03-19T00:01:00.000Z' },
      { id: 'm-2', timestamp: '2026-03-19T00:02:00.000Z' },
    ]);
  });

  it('resynchronizes architect metadata when the local DB transcript is ahead', async () => {
    const plan = createPlan();
    architectPlans.set(plan.id, plan);
    architectPlanMessages.set(plan.id, [
      {
        id: 'm-1',
        role: 'user',
        content: 'First question',
        createdAt: '2026-03-19T00:01:00.000Z',
      },
    ]);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('conv-1')],
      messages: [
        {
          id: 'm-1',
          task_id: '',
          conversation_id: 'conv-1',
          role: 'user',
          content: 'First question',
          timestamp: '2026-03-19T00:01:00.000Z',
        },
        {
          id: 'm-2',
          task_id: '',
          conversation_id: 'conv-1',
          role: 'assistant',
          content: 'Second answer',
          timestamp: '2026-03-19T00:02:00.000Z',
        },
      ],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const result = await useChatStore.getState().ensureArchitectConversationForPlan({
      plan,
      targetBranch: 'develop',
    });

    expect(result.restoredTranscript).toBe(false);
    expect(syncArchitectPlanChatFromConversationMock).toHaveBeenCalledWith({
      branchName: 'develop',
      planId: plan.id,
      conversationId: 'conv-1',
    });
    expect(importMessagesMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().getConversationMessages('conv-1')).toHaveLength(2);
  });

  it('creates a dedicated conversation and restores transcript when the plan conversation is shared', async () => {
    const originalNow = Date.now;
    Date.now = () => 1773900000000;
    try {
      const plan = createPlan({ conversationId: 'shared-conv' });
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [
        {
          id: 'm-1',
          role: 'assistant',
          content: 'Shared transcripts should move.',
          createdAt: '2026-03-19T00:03:00.000Z',
        },
      ]);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('shared-conv')],
        messages: [],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const result = await useChatStore.getState().ensureArchitectConversationForPlan({
        plan,
        targetBranch: 'develop',
        fallbackProjectId: 'project-1',
        fallbackGroupId: 'group-1',
        sharedConversation: true,
      });

      expect(result.createdConversation).toBe(true);
      expect(result.restoredTranscript).toBe(true);
      expect(result.conversationId).toBe('conv-1773900000000');
      expect(updateArchitectPlanMock).toHaveBeenCalledWith({
        branchName: 'develop',
        planId: plan.id,
        conversationId: 'conv-1773900000000',
      });
      expect(useChatStore.getState().getConversationMessages('conv-1773900000000')).toHaveLength(1);
      expect(useChatStore.getState().selectedConversationId).toBe('conv-1773900000000');
    } finally {
      Date.now = originalNow;
    }
  });

  it('prefers the active plan conversation over the project architect conversation fallback', async () => {
    const plan = createPlan({ conversationId: 'plan-conv' });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('plan-conv'), createConversation('project-architect-conversation')],
      messages: [],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const selectedConversationId = await useChatStore.getState().ensureConversationForCurrentMode();

    expect(selectedConversationId).toBe('plan-conv');
    expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
    expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
  });

  it('hydrates the chat snapshot and resolves the active plan conversation during initialize', async () => {
    tauriAvailable = true;

    const plan = createPlan({ conversationId: 'plan-conv' });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { targetBranch: 'develop' };

    chatSnapshotConversations = [
      {
        id: 'project-architect-conversation',
        title: 'Architect - Macro',
        description: '',
        scope_mode: 'Architect',
        task_id: null,
        group_id: 'group-1',
        project_id: 'project-1',
        last_message: 'fallback',
        message_count: 1,
        updated_at: '2026-03-19T00:03:00.000Z',
      },
      {
        id: 'plan-conv',
        title: 'Checkout refresh',
        description: '',
        scope_mode: 'Architect',
        task_id: null,
        group_id: 'group-1',
        project_id: 'project-1',
        last_message: 'latest',
        message_count: 2,
        updated_at: '2026-03-19T00:04:00.000Z',
      },
    ];
    chatSnapshotMessages = [
      {
        id: 'm-2',
        conversation_id: 'plan-conv',
        role: 'assistant',
        content: 'Second answer',
        created_at: '2026-03-19T00:02:00.000Z',
      },
      {
        id: 'm-1',
        conversation_id: 'plan-conv',
        role: 'user',
        content: 'First question',
        created_at: '2026-03-19T00:01:00.000Z',
      },
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();

    expect(getChatSnapshotMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().hydrationStatus).toBe('ready');
    expect(useChatStore.getState().restoreStatus).toBe('ready');
    expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
    expect(
      useChatStore.getState().getConversationMessages('plan-conv').map((message: { id: string }) => message.id)
    ).toEqual(['m-1', 'm-2']);
    expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
  });

  it('renames an auto-created canonical plan after the first message', async () => {
    const plan = createPlan({
      id: '1710000000000',
      slug: '1710000000000',
      title: '1710000000000',
      label: 'new plan',
      description: '',
      conversationId: 'plan-conv',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('plan-conv'),
          title: 'Plan - new plan',
        },
      ],
      messages: [],
      selectedConversationId: 'plan-conv',
      selectedConversationIdsByMode: { Architect: 'plan-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'plan-conv',
      content: 'On doit refondre le flux checkout et restaurer le panier.',
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
    expect(updateArchitectPlanMock).toHaveBeenCalledWith({
      branchName: 'develop',
      planId: '1710000000000',
      label: 'Checkout refresh',
      description: 'Refresh checkout state and cart recovery.',
    });
    expect(architectPlans.get('1710000000000')?.label).toBe('Checkout refresh');
    expect(architectPlans.get('1710000000000')?.description).toBe(
      'Refresh checkout state and cart recovery.'
    );
    expect(useChatStore.getState().conversations[0]?.title).toBe('Plan - Checkout refresh - 1710000000000');
  });

  it('hydrates the active plan after a tool update without triggering implicit auto-plan on project switch', async () => {
    const plan = createPlan({
      id: 'plan-1',
      conversationId: 'plan-conv',
      projectId: 'project-2',
      projectIds: ['project-2'],
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { targetBranch: 'develop' };
    appState.selectedProjectId = 'project-1';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('plan-conv')],
      messages: [],
      selectedConversationId: 'plan-conv',
      selectedConversationIdsByMode: { Architect: 'plan-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'plan-conv',
      content: 'Refresh the plan context.',
    });

    const onToolCall = (((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0]) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<string | void>;
    } | undefined)?.onToolCall;

    expect(onToolCall).toBeDefined();
    await onToolCall?.('plan_update', {
      plan_id: plan.id,
      description: 'Updated scope',
    });

    expect(appState.switchProjectContext).toHaveBeenCalledWith('project-2', {
      restoreProjectContext: false,
      ensureAutoPlan: false,
    });
    expect(appState.activeArchitectPlanId).toBe(plan.id);
    expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
  });

  it('does not pass label metadata during strategy generation unless explicitly requested', async () => {
    const plan = createPlan({
      id: 'plan-1',
      slug: 'plan-1',
      title: 'plan-1',
      label: 'Checkout refresh',
      conversationId: 'plan-conv',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('plan-conv')],
      messages: [],
      selectedConversationId: 'plan-conv',
      selectedConversationIdsByMode: { Architect: 'plan-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'plan-conv',
      content: 'Generate the strategy.',
    });
    updateArchitectPlanMock.mockClear();

    const onToolCall = (((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0]) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<string | void>;
    } | undefined)?.onToolCall;

    await onToolCall?.('strategy_generate', {
      nodes: [{ title: 'Implement checkout' }],
    });

    const lastCall = ((updateArchitectPlanMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

    expect('label' in lastCall).toBe(false);
    expect('title' in lastCall).toBe(false);
  });

  it('does not pass label metadata during strategy updates unless explicitly requested', async () => {
    const plan = createPlan({
      id: 'plan-1',
      slug: 'plan-1',
      title: 'plan-1',
      label: 'Checkout refresh',
      conversationId: 'plan-conv',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('plan-conv')],
      messages: [],
      selectedConversationId: 'plan-conv',
      selectedConversationIdsByMode: { Architect: 'plan-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'plan-conv',
      content: 'Update the strategy.',
    });
    updateArchitectPlanMock.mockClear();

    const onToolCall = (((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0]) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<string | void>;
    } | undefined)?.onToolCall;

    await onToolCall?.('strategy_update', {
      replace: true,
      nodes: [{ title: 'Implement checkout' }],
    });

    const lastCall = ((updateArchitectPlanMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

    expect('label' in lastCall).toBe(false);
    expect('title' in lastCall).toBe(false);
  });

  it('launches Architect conversations with the plan explorer internal profile', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    localStorage.setItem(
      'macro_promptPlanExplorer',
      JSON.stringify('Custom PLAN_EXPLORER prompt for tests.')
    );

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('plan-conv')],
      messages: [],
      selectedConversationId: 'plan-conv',
      selectedConversationIdsByMode: { Architect: 'plan-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'plan-conv',
      content: 'Structure le plan pour refondre le checkout.',
    });

    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      internalAgentProfile?: string | null;
      allowedToolIds: string[];
      messages: Array<{ role: string; content: string }>;
    };
    expect(streamOptions.internalAgentProfile).toBe('plan_explorer');
    expect(streamOptions.allowedToolIds).not.toContain('write');
    expect(streamOptions.allowedToolIds).not.toContain('edit');
    expect(streamOptions.allowedToolIds).not.toContain('apply_patch');
    expect(streamOptions.allowedToolIds).toContain('plan_get');
    expect(streamOptions.allowedToolIds).toContain('strategy_update');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'Custom PLAN_EXPLORER prompt for tests.'
    );
  });

  it('reuses the same implement conversation for the selected task', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [createImplementTask()];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-latest'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
          updated_at: '2026-03-19T00:05:00.000Z',
        },
        {
          ...createConversation('implement-older'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
          updated_at: '2026-03-19T00:01:00.000Z',
        },
      ],
      messages: [],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();
    const conversation = await useChatStore.getState().createConversation('New Conversation', null, null);

    expect(ensuredId).toBe('implement-latest');
    expect(conversation.id).toBe('implement-latest');
    expect(useChatStore.getState().conversations).toHaveLength(2);
    expect(useChatStore.getState().selectedConversationId).toBe('implement-latest');
    expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBe('implement-latest');
  });

  it('creates a task-scoped implement conversation when none exists yet', async () => {
    const originalNow = Date.now;
    Date.now = () => 1773910000000;

    try {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask()];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [],
        messages: [],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const conversation = await useChatStore.getState().createConversation('New Conversation', null, null);

      expect(conversation.id).toBe('conv-1773910000000');
      expect(conversation.task_id).toBe('task-1');
      expect(conversation.project_id).toBe('project-1');
      expect(conversation.title).toBe('Task - Implement checkout');
      expect(useChatStore.getState().selectedConversationId).toBe('conv-1773910000000');
      expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBe('conv-1773910000000');
    } finally {
      Date.now = originalNow;
    }
  });

  it('keeps chat conversations detached from task and project context', async () => {
    appState.mode = 'Chat';
    appState.selectedGroupId = 'group-1';
    appState.selectedProjectId = 'project-1';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [createImplementTask()];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [],
      messages: [],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const conversation = await useChatStore.getState().createConversation(
      'New Conversation',
      'task-1',
      'project-1',
      'group-1'
    );

    expect(conversation.task_id).toBeNull();
    expect(conversation.project_id).toBeNull();
    expect(conversation.group_id).toBeNull();
    expect(useChatStore.getState().selectedConversationIdsByMode.Chat).toBe(conversation.id);
  });

  it('recreates a fresh implement conversation after deleting the previous one', async () => {
    const originalNow = Date.now;
    Date.now = () => 1773920000000;

    try {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask()];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().deleteConversation('implement-conv', { mode: 'implement' });
      const recreatedId = await useChatStore.getState().ensureConversationForCurrentMode();

      expect(recreatedId).toBe('conv-1773920000000');
      expect(useChatStore.getState().conversations).toHaveLength(1);
      expect(useChatStore.getState().conversations[0]?.task_id).toBe('task-1');
      expect(useChatStore.getState().selectedConversationId).toBe('conv-1773920000000');
      expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBe('conv-1773920000000');
    } finally {
      Date.now = originalNow;
    }
  });

  it('finalizes a manual feature draft before the first assistant response', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [createManualFeatureTask()];

    sendChatNonStreamingMock.mockImplementationOnce(async () =>
      JSON.stringify({
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
        featureSlug: 'quick-export',
      })
    );

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('manual-conv'),
          scope_mode: 'Implement',
          task_id: 'manual-task-1',
          title: 'New feature',
        },
      ],
      messages: [],
      selectedConversationId: 'manual-conv',
      selectedConversationIdsByMode: { Implement: 'manual-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Ajoute un export CSV rapide depuis le tableau.',
      taskId: 'manual-task-1',
    });

    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
    expect(taskStoreState.finalizeManualFeatureDraft).toHaveBeenCalledWith({
      taskId: 'manual-task-1',
      conversationId: 'manual-conv',
      title: 'Quick export',
      description: 'Add a quick CSV export from the table.',
      featureSlug: 'quick-export',
    });
    expect(taskStoreState.startTask).toHaveBeenCalledWith('manual-task-1');
    expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
      draft: false,
      status: 'InProgress',
      feature_slug: 'quick-export',
      branch_name: 'feature/quick-export',
    });
    expect(
      useChatStore.getState().conversations.find((conversation: Conversation) => conversation.id === 'manual-conv')
    ).toMatchObject({
      title: 'Quick export',
      description: 'Add a quick CSV export from the table.',
    });
  });

  it('deletes the linked manual feature draft when deleting its empty implement conversation', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [createManualFeatureTask()];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('manual-conv'),
          scope_mode: 'Implement',
          task_id: 'manual-task-1',
        },
      ],
      messages: [],
      selectedConversationId: 'manual-conv',
      selectedConversationIdsByMode: { Implement: 'manual-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().deleteConversation('manual-conv', { mode: 'implement' });

    expect(taskStoreState.deleteManualFeatureDraft).toHaveBeenCalledWith('manual-task-1');
    expect(useChatStore.getState().conversations).toHaveLength(0);
    expect(taskStoreState.tasks).toHaveLength(0);
  });

  it('requests a different manual feature slug when the first branch name is already taken', async () => {
    tauriAvailable = true;
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [createManualFeatureTask()];
    gitBranchesByRepo = {
      '/repos/web': {
        local: [{ name: 'feature/quick-export', is_head: false, commit: 'abc123' }],
        remote: [],
        current: 'develop',
      },
    };

    sendChatNonStreamingMock
      .mockImplementationOnce(async () =>
        JSON.stringify({
          title: 'Quick export',
          description: 'Add a quick CSV export from the table.',
          featureSlug: 'quick-export',
        })
      )
      .mockImplementationOnce(async () =>
        JSON.stringify({
          title: 'Quick export',
          description: 'Add a quick CSV export from the table.',
          featureSlug: 'quick-export-fast',
        })
      );

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('manual-conv'),
          scope_mode: 'Implement',
          task_id: 'manual-task-1',
          title: 'New feature',
        },
      ],
      messages: [],
      selectedConversationId: 'manual-conv',
      selectedConversationIdsByMode: { Implement: 'manual-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Ajoute un export CSV rapide depuis le tableau.',
      taskId: 'manual-task-1',
    });

    expect(gitBranchListMock).toHaveBeenCalledWith('/repos/web');
    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(2);
    expect(taskStoreState.finalizeManualFeatureDraft).toHaveBeenCalledWith({
      taskId: 'manual-task-1',
      conversationId: 'manual-conv',
      title: 'Quick export',
      description: 'Add a quick CSV export from the table.',
      featureSlug: 'quick-export-fast',
    });
    expect(updateConversationDetailsMock).toHaveBeenCalledWith({
      id: 'manual-conv',
      title: 'Quick export',
      description: 'Add a quick CSV export from the table.',
    });
  });

  it('keeps an implement task in progress when the assistant reply has no quick replies', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [
      createManualFeatureTask({
        draft: false,
        title: 'Quick export',
        status: 'Pending',
        feature_slug: 'quick-export',
        assigned_branch: 'feature/quick-export',
        branch_name: 'feature/quick-export',
      }),
    ];

    const { streamChat } = await import('../services/streamingChat');
    (
      streamChat as unknown as {
        mockImplementationOnce: (implementation: (options: {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: unknown;
            usage: null;
          }) => void;
        }) => Promise<{ usage: null }>) => void;
      }
    ).mockImplementationOnce(async ({ onComplete }) => {
      onComplete?.({
        visibleContent: 'Implementation ready.',
        toolTraces: [],
        hiddenContext: undefined,
        usage: null,
      });
      return { usage: null };
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('manual-conv'),
          scope_mode: 'Implement',
          task_id: 'manual-task-1',
          title: 'Quick export',
        },
      ],
      messages: [],
      selectedConversationId: 'manual-conv',
      selectedConversationIdsByMode: { Implement: 'manual-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Implémente l’export CSV.',
      taskId: 'manual-task-1',
    });

    expect(taskStoreState.startTask).toHaveBeenCalledWith('manual-task-1');
    expect(taskStoreState.markTaskAwaitingResponse).not.toHaveBeenCalled();
    expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
      status: 'InProgress',
    });
  });

  it('passes Architect mode and the post-tool recap instruction into streaming requests', async () => {
    appState.mode = 'Architect';
    appState.selectedTaskId = null;

    const { streamChat } = await import('../services/streamingChat');
    (
      streamChat as unknown as {
        mockImplementationOnce: (implementation: (options: {
          mode?: AppMode;
          messages: Array<{ role: string; content: string }>;
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: unknown;
          }) => void;
        }) => Promise<void>) => void;
      }
    ).mockImplementationOnce(async ({ onComplete }) => {
      onComplete?.({
        visibleContent: 'Plan prêt.',
        toolTraces: [],
        hiddenContext: undefined,
      });
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('conv-1')],
      messages: [],
      selectedConversationId: 'conv-1',
      selectedConversationIdsByMode: { Architect: 'conv-1' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'conv-1',
      content: 'Utilise les outils puis fais-moi un bilan.',
    });

    const firstCall = (
      streamChat as unknown as {
        mock: {
          calls: Array<Array<{ mode?: AppMode; messages: Array<{ role: string; content: string }> }>>;
        };
      }
    ).mock.calls[0]?.[0];

    expect(firstCall?.mode).toBe('Architect');
    expect(firstCall?.messages[0]?.role).toBe('system');
    expect(firstCall?.messages[0]?.content).toContain(
      'always answer in natural language with a concise recap'
    );
  });

  it('moves an implement task to awaiting response when the assistant reply contains valid quick replies', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [
      createManualFeatureTask({
        draft: false,
        title: 'Quick export',
        status: 'Pending',
        feature_slug: 'quick-export',
        assigned_branch: 'feature/quick-export',
        branch_name: 'feature/quick-export',
      }),
    ];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('manual-conv'),
          scope_mode: 'Implement',
          task_id: 'manual-task-1',
          title: 'Quick export',
        },
      ],
      messages: [],
      selectedConversationId: 'manual-conv',
      selectedConversationIdsByMode: { Implement: 'manual-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Implémente l’export CSV.',
      taskId: 'manual-task-1',
    });
    const onComplete = (((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0]) as {
      onComplete?: (result: {
        visibleContent: string;
        toolTraces: unknown[];
        hiddenContext?: unknown;
        usage: null;
      }) => void;
    } | undefined)?.onComplete;
    onComplete?.({
      visibleContent: [
        'I need one blocking choice before I continue.',
        '',
        '[quick-replies]',
        '- Use CSV download only',
        '- Add CSV and TSV',
        '- Keep it behind a feature flag',
        '[/quick-replies]',
      ].join('\n'),
      toolTraces: [],
      hiddenContext: undefined,
      usage: null,
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(taskStoreState.startTask).toHaveBeenCalledWith('manual-task-1');
    expect(taskStoreState.markTaskAwaitingResponse).toHaveBeenCalledWith('manual-task-1');
    expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
      status: 'AwaitingResponse',
    });
  });

  it('keeps an implement task in progress when the assistant reply has malformed quick replies', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [
      createManualFeatureTask({
        draft: false,
        title: 'Quick export',
        status: 'Pending',
        feature_slug: 'quick-export',
        assigned_branch: 'feature/quick-export',
        branch_name: 'feature/quick-export',
      }),
    ];

    const { streamChat } = await import('../services/streamingChat');
    (
      streamChat as unknown as {
        mockImplementationOnce: (implementation: (options: {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: unknown;
            usage: null;
          }) => void;
        }) => Promise<{ usage: null }>) => void;
      }
    ).mockImplementationOnce(async ({ onComplete }) => {
      onComplete?.({
        visibleContent: [
          'I still need clarification.',
          '',
          '[quick-replies]',
          '- Only one option',
          '[/quick-replies]',
        ].join('\n'),
        toolTraces: [],
        hiddenContext: undefined,
        usage: null,
      });
      return { usage: null };
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('manual-conv'),
          scope_mode: 'Implement',
          task_id: 'manual-task-1',
          title: 'Quick export',
        },
      ],
      messages: [],
      selectedConversationId: 'manual-conv',
      selectedConversationIdsByMode: { Implement: 'manual-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Implémente l’export CSV.',
      taskId: 'manual-task-1',
    });

    expect(taskStoreState.startTask).toHaveBeenCalledWith('manual-task-1');
    expect(taskStoreState.markTaskAwaitingResponse).not.toHaveBeenCalled();
    expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
      status: 'InProgress',
    });
  });

  it('commits the first Implement reply on an existing awaiting-response thread before the stream completes', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [
      createImplementTask({
        status: 'AwaitingResponse',
        conversation_id: 'implement-conv',
      }),
    ];

    const { streamChat } = await import('../services/streamingChat');
    (
      streamChat as unknown as {
        mockImplementationOnce: (implementation: () => Promise<never>) => void;
      }
    ).mockImplementationOnce(() => new Promise<never>(() => undefined));

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
        },
      ],
      messages: [],
      selectedConversationId: 'implement-conv',
      selectedConversationIdsByMode: { Implement: 'implement-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const result = await useChatStore.getState().sendMessage({
      conversationId: 'implement-conv',
      content: 'J’ai besoin du prochain lot de changements.',
      taskId: 'task-1',
    });

    expect(result.status).toBe('sent');
    expect(taskStoreState.retryTask).toHaveBeenCalledWith('task-1');
    expect(taskStoreState.getTaskById('task-1')).toMatchObject({
      status: 'InProgress',
    });
    expect(
      useChatStore
        .getState()
        .getConversationMessages('implement-conv')
        .map((message: { role: string; content: string }) => ({
          role: message.role,
          content: message.content,
        }))
    ).toEqual([
      { role: 'user', content: 'J’ai besoin du prochain lot de changements.' },
      { role: 'assistant', content: '' },
    ]);
    expect(useChatStore.getState().sendState).toBe('streaming');
    useChatStore.getState().stopStreaming();
  });

  it('launches InReview Implement conversations with the task reviewer profile', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [createImplementTask({ status: 'InReview' })];
    localStorage.setItem(
      'macro_promptTaskReviewer',
      JSON.stringify('Custom TASK_REVIEWER prompt for tests.')
    );

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
        },
      ],
      messages: [],
      selectedConversationId: 'implement-conv',
      selectedConversationIdsByMode: { Implement: 'implement-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'implement-conv',
      content: 'Passe une review critique puis corrige ce qui est minimal.',
      taskId: 'task-1',
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      internalAgentProfile?: string | null;
      allowedToolIds: string[];
      messages: Array<{ role: string; content: string }>;
    };
    expect(streamOptions.internalAgentProfile).toBe('task_reviewer');
    expect(streamOptions.allowedToolIds).toContain('apply_patch');
    expect(streamOptions.allowedToolIds).toContain('git_diff');
    expect(streamOptions.allowedToolIds).toContain('terminal_run');
    expect(streamOptions.allowedToolIds).not.toContain('git_commit');
    expect(streamOptions.allowedToolIds).not.toContain('git_merge');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'Custom TASK_REVIEWER prompt for tests.'
    );
  });

  it('loads the repo auditor prompt override for implement conflict assistance flows', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Implement';
    appState.selectedTaskId = null;
    localStorage.setItem(
      'macro_promptRepoAuditor',
      JSON.stringify('Custom REPO_AUDITOR prompt for tests.')
    );

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('debug-conv'),
          scope_mode: 'Implement',
          title: 'Repository review',
        },
      ],
      messages: [],
      selectedConversationId: 'debug-conv',
      selectedConversationIdsByMode: { Implement: 'debug-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'debug-conv',
      content: 'Diagnose the git conflict safely.',
      internalAgentProfile: 'repo_auditor',
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      internalAgentProfile?: string | null;
      allowedToolIds: string[];
      messages: Array<{ role: string; content: string }>;
    };
    expect(streamOptions.internalAgentProfile).toBe('repo_auditor');
    expect(streamOptions.allowedToolIds).not.toContain('terminal_run');
    expect(streamOptions.allowedToolIds).not.toContain('apply_patch');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'Custom REPO_AUDITOR prompt for tests.'
    );
  });

  it('rejects Implement sends when task preflight does not move the task into progress', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [createImplementTask({ status: 'Pending' })];
    taskStoreState.startTask.mockImplementationOnce(async () => {
      taskStoreState.lastError = 'Task worktree is not ready yet.';
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
        },
      ],
      messages: [],
      selectedConversationId: 'implement-conv',
      selectedConversationIdsByMode: { Implement: 'implement-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await expect(
      useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Lance le travail.',
        taskId: 'task-1',
      })
    ).rejects.toThrow('Task worktree is not ready yet.');

    expect(useChatStore.getState().getConversationMessages('implement-conv')).toHaveLength(0);
    expect(useChatStore.getState().lastError).toBe('Task worktree is not ready yet.');
    expect(useChatStore.getState().sendState).toBe('error');
  });

  it('rejects sends without a selected provider or model before committing any message', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];
    providerState.selectedProviderId = null;
    providerState.selectedModelId = null;

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
        },
      ],
      messages: [],
      selectedConversationId: 'implement-conv',
      selectedConversationIdsByMode: { Implement: 'implement-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await expect(
      useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Réponds à la demande du développeur.',
        taskId: 'task-1',
      })
    ).rejects.toThrow('Select a provider and model before sending a message.');

    expect(useChatStore.getState().getConversationMessages('implement-conv')).toHaveLength(0);
    expect(useChatStore.getState().lastError).toBe('Select a provider and model before sending a message.');
    expect(useChatStore.getState().sendState).toBe('error');
  });

  it('rejects concurrent sends while an Implement message is still preparing', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [createImplementTask({ status: 'Pending' })];

    const releaseStartTaskRef: { current: (() => void) | null } = { current: null };
    taskStoreState.startTask.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStartTaskRef.current = () => {
            taskStoreState.tasks = taskStoreState.tasks.map((task) =>
              task.id === 'task-1'
                ? {
                    ...task,
                    status: 'InProgress',
                  }
                : task
            );
            resolve();
          };
        })
    );

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
        },
      ],
      messages: [],
      selectedConversationId: 'implement-conv',
      selectedConversationIdsByMode: { Implement: 'implement-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const firstSend = useChatStore.getState().sendMessage({
      conversationId: 'implement-conv',
      content: 'Premier envoi.',
      taskId: 'task-1',
    });

    await Promise.resolve();

    await expect(
      useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Deuxième envoi.',
        taskId: 'task-1',
      })
    ).rejects.toThrow('A message is already being prepared.');

    expect(useChatStore.getState().getConversationMessages('implement-conv')).toHaveLength(0);

    if (releaseStartTaskRef.current) {
      releaseStartTaskRef.current();
    }
    const result = await firstSend;

    expect(result.status).toBe('sent');
    expect(
      useChatStore
        .getState()
        .getConversationMessages('implement-conv')
        .map((message: { role: string; content: string }) => ({
          role: message.role,
          content: message.content,
        }))
    ).toEqual([
      { role: 'user', content: 'Premier envoi.' },
      { role: 'assistant', content: '' },
    ]);
  });

  it('deletes multiple chat conversations in a single batch and recalculates selection once', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          id: 'chat-1',
          title: 'Chat 1',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 2,
          updated_at: '2026-03-19T00:03:00.000Z',
          is_unread: false,
        },
        {
          id: 'chat-2',
          title: 'Chat 2',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 1,
          updated_at: '2026-03-19T00:02:00.000Z',
          is_unread: false,
        },
        {
          id: 'chat-3',
          title: 'Chat 3',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 1,
          updated_at: '2026-03-19T00:01:00.000Z',
          is_unread: false,
        },
      ],
      messages: [
        {
          id: 'm-1',
          task_id: '',
          conversation_id: 'chat-1',
          role: 'user',
          content: 'one',
          timestamp: '2026-03-19T00:01:00.000Z',
        },
        {
          id: 'm-2',
          task_id: '',
          conversation_id: 'chat-1',
          role: 'assistant',
          content: 'two',
          timestamp: '2026-03-19T00:02:00.000Z',
        },
        {
          id: 'm-3',
          task_id: '',
          conversation_id: 'chat-2',
          role: 'user',
          content: 'three',
          timestamp: '2026-03-19T00:03:00.000Z',
        },
        {
          id: 'm-4',
          task_id: '',
          conversation_id: 'chat-3',
          role: 'assistant',
          content: 'four',
          timestamp: '2026-03-19T00:04:00.000Z',
        },
      ],
      selectedConversationId: 'chat-1',
      selectedConversationIdsByMode: { Chat: 'chat-1' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {
        'm-1': [
          {
            id: 'img-1',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,aaa',
            createdAt: '2026-03-19T00:01:00.000Z',
          },
        ],
        'm-4': [
          {
            id: 'img-2',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,bbb',
            createdAt: '2026-03-19T00:04:00.000Z',
          },
        ],
      },
      composerContextRefs: [],
    });

    await useChatStore.getState().deleteChatConversations(['chat-1', 'chat-2']);

    expect(deleteConversationsMock).toHaveBeenCalledWith(['chat-1', 'chat-2']);
    expect(useChatStore.getState().conversations.map((conversation: Conversation) => conversation.id)).toEqual([
      'chat-3',
    ]);
    expect(
      useChatStore.getState().messages.map((message: { id: string }) => message.id)
    ).toEqual(['m-4']);
    expect(useChatStore.getState().selectedConversationId).toBe('chat-3');
    expect(useChatStore.getState().selectedConversationIdsByMode.Chat).toBe('chat-3');
    expect(Object.keys(useChatStore.getState().messageImagesByMessageId)).toEqual(['m-4']);
  });

  it('restores the previous snapshot when bulk chat deletion fails', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    deleteConversationsMock.mockImplementationOnce(async () => {
      throw new Error('db unavailable');
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          id: 'chat-1',
          title: 'Chat 1',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 1,
          updated_at: '2026-03-19T00:02:00.000Z',
          is_unread: false,
        },
        {
          id: 'chat-2',
          title: 'Chat 2',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 1,
          updated_at: '2026-03-19T00:01:00.000Z',
          is_unread: false,
        },
      ],
      messages: [
        {
          id: 'm-1',
          task_id: '',
          conversation_id: 'chat-1',
          role: 'user',
          content: 'one',
          timestamp: '2026-03-19T00:01:00.000Z',
        },
        {
          id: 'm-2',
          task_id: '',
          conversation_id: 'chat-2',
          role: 'assistant',
          content: 'two',
          timestamp: '2026-03-19T00:02:00.000Z',
        },
      ],
      selectedConversationId: 'chat-1',
      selectedConversationIdsByMode: { Chat: 'chat-1' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {
        'm-1': [
          {
            id: 'img-1',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,aaa',
            createdAt: '2026-03-19T00:01:00.000Z',
          },
        ],
      },
      composerContextRefs: [],
    });

    await expect(useChatStore.getState().deleteChatConversations(['chat-1'])).rejects.toThrow(
      'db unavailable'
    );
    expect(useChatStore.getState().conversations.map((conversation: Conversation) => conversation.id)).toEqual([
      'chat-1',
      'chat-2',
    ]);
    expect(
      useChatStore.getState().messages.map((message: { id: string }) => message.id)
    ).toEqual(['m-1', 'm-2']);
    expect(useChatStore.getState().selectedConversationId).toBe('chat-1');
    expect(Object.keys(useChatStore.getState().messageImagesByMessageId)).toEqual(['m-1']);
  });

  it('rejects bulk deletion for non-chat conversations', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('architect-conv')],
      messages: [],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await expect(
      useChatStore.getState().deleteChatConversations(['architect-conv'])
    ).rejects.toThrow('La suppression groupée est réservée aux conversations Chat.');
    expect(deleteConversationsMock).not.toHaveBeenCalled();
  });

  it('updates only the targeted message object when appending streamed content', async () => {
    const { useChatStore } = await loadChatStore();

    useChatStore.setState({
      conversations: [createConversation('conv-1')],
      messages: [],
      messagesByConversationId: {},
      messageIndexById: {},
      selectedConversationId: 'conv-1',
      selectedConversationIdsByMode: { Chat: 'conv-1' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    useChatStore.getState().addMessage({
      id: 'm-user',
      task_id: '',
      conversation_id: 'conv-1',
      role: 'user',
      content: 'bonjour',
      timestamp: '2026-03-19T00:01:00.000Z',
    });
    useChatStore.getState().addMessage({
      id: 'm-assistant',
      task_id: '',
      conversation_id: 'conv-1',
      role: 'assistant',
      content: 'rep',
      timestamp: '2026-03-19T00:02:00.000Z',
      tool_traces: [],
    });

    const beforeMessages = useChatStore.getState().messages;

    useChatStore.getState().appendToMessage('m-assistant', 'onse');

    const afterMessages = useChatStore.getState().messages;
    expect(afterMessages[0]).toBe(beforeMessages[0]);
    expect(afterMessages[1]).not.toBe(beforeMessages[1]);
    expect(afterMessages[1]?.content).toBe('reponse');
    expect(
      useChatStore
        .getState()
        .getConversationMessages('conv-1')
        .map((message: { id: string }) => message.id)
    ).toEqual(['m-user', 'm-assistant']);
  });
});
