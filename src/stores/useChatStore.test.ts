import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AppMode, Conversation, ProjectGroup } from '../types';
import type { ArchitectPlanRecord } from '../services/architectPlanService';
const actualTauriIpc = await import('../services/tauriIpc');

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
  activeThemeId: 'macro-dark',
  codeOverflowMode: 'wrap' as const,
  activeArchitectPlanId: null as string | null,
  activePlanContext: null as { id?: string; targetBranch: string } | null,
  projectGroups,
  getProjectById: (projectId: string) =>
    projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId),
  setActiveArchitectPlanId: (_planId: string | null) => undefined,
  setPlanNodes: (_nodes: unknown[]) => undefined,
  setPredictedBranches: (_branches: unknown[]) => undefined,
  setActivePlanContext: (_context: unknown) => undefined,
  setTheme: (_themeId: string) => undefined,
  activateArchitectPlan: mock(
    async (
      planId: string,
      options?: {
        targetBranch?: string | null;
        persistActiveSelection?: boolean;
        allowScopeSwitch?: boolean;
      }
    ) => {
      const plan = architectPlans.get(planId);
      if (!plan || plan.status === 'deleted') {
        return false;
      }

      const scopedProjectIds = projectGroups.flatMap((group) => group.projects.map((project) => project.id));
      const planProjectIds = [
        ...(plan.projectIds ?? []),
        ...(plan.projectId ? [plan.projectId] : []),
      ];
      const preferredProjectId =
        planProjectIds.find((projectId) => projectId === appState.selectedProjectId) ??
        planProjectIds[0] ??
        null;
      const isPlanAlreadyInScope = planProjectIds.some((projectId) => scopedProjectIds.includes(projectId));

      if (
        options?.allowScopeSwitch !== false &&
        preferredProjectId &&
        !isPlanAlreadyInScope
      ) {
        await appState.switchProjectContext(preferredProjectId, {
          restoreProjectContext: false,
          ensureAutoPlan: false,
        });
      }

      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = {
        id: plan.id,
        targetBranch: options?.targetBranch ?? plan.targetBranch,
      };
      return true;
    }
  ),
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
  'question',
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
  isChatToolEnabled: (_toolId: string) => true,
  getEnabledChatToolIds: () => ['read_file', 'web_search', 'web_fetch', 'question'],
  loadSettings: mock(async () => undefined),
};

const useProviderStoreMock = {
  getState: () => providerState,
  setState: (patch: Partial<typeof providerState>) => {
    Object.assign(providerState, patch);
  },
  subscribe: () => () => undefined,
};

const taskStoreSubscribers = new Set<
  (
    nextState: typeof taskStoreState,
    previousState: typeof taskStoreState,
  ) => void
>();

const emitTaskStoreUpdate = (previousTasks: Array<Record<string, unknown>>) => {
  const previousState = {
    ...taskStoreState,
    tasks: previousTasks,
  };
  const nextState = {
    ...taskStoreState,
    tasks: taskStoreState.tasks,
  };
  taskStoreSubscribers.forEach((listener) => listener(nextState, previousState));
};

const appStoreSubscribers = new Set<
  (
    nextState: typeof appState,
    previousState: typeof appState,
  ) => void
>();

const cloneAppState = () => ({
  ...appState,
  activePlanContext: appState.activePlanContext
    ? { ...appState.activePlanContext }
    : appState.activePlanContext,
});

const emitAppStoreUpdate = (previousState: typeof appState) => {
  const nextState = cloneAppState();
  appStoreSubscribers.forEach((listener) => listener(nextState, previousState));
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
    const previousTasks = taskStoreState.tasks;
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
    emitTaskStoreUpdate(previousTasks);
  }),
  startTask: mock(async (taskId: string) => {
    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'InProgress',
          }
        : task
    );
    emitTaskStoreUpdate(previousTasks);
  }),
  markTaskAwaitingResponse: mock(async (taskId: string) => {
    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'AwaitingResponse',
          }
        : task
    );
    emitTaskStoreUpdate(previousTasks);
  }),
  retryTask: mock(async (taskId: string) => {
    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'InProgress',
          }
        : task
    );
    emitTaskStoreUpdate(previousTasks);
  }),
  deleteManualFeatureDraft: mock(async (taskId: string) => {
    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = taskStoreState.tasks.filter((task) => task.id !== taskId);
    emitTaskStoreUpdate(previousTasks);
  }),
};

const architectPlans = new Map<string, ArchitectPlanRecord>();
const architectPlanMessages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }>>();
let tauriAvailable = false;
let gitBranchesByRepo: Record<string, { local: Array<{ name: string; is_head: boolean; commit: string }>; remote: Array<{ name: string; is_head: boolean; commit: string }>; current: string | null }> = {};
type ChatSnapshotConversationRecord = {
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
};
let chatSnapshotConversations: ChatSnapshotConversationRecord[] = [];
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
const getToolModePolicyMock = mock(async (mode: AppMode) => {
  if (mode === 'Chat') {
    return {
      allowed_tool_ids: ['question', 'read_sources', 'read_file', 'web_search', 'web_fetch'],
      enforce_macro_only_writes: false,
    };
  }

  if (mode === 'Architect') {
    return {
      allowed_tool_ids: [
        'mark_source_passage',
        'read_sources',
        'edit_source_passage',
        'question',
        'read_file',
        'web_search',
        'web_fetch',
        'list',
        'read',
        'glob',
        'grep',
        'write',
        'edit',
        'apply_patch',
        'git_status',
        'git_log',
        'git_branch_list',
        'git_diff',
        'git_get_tree',
        'need_add',
        'strategy_generate',
        'plan_list',
        'plan_get',
        'plan_update',
        'strategy_get',
        'strategy_update',
        'strategy_delete',
      ],
      enforce_macro_only_writes: true,
    };
  }

  return {
    allowed_tool_ids: [
      'mark_source_passage',
      'read_sources',
      'edit_source_passage',
      'question',
      'read_file',
      'web_search',
      'web_fetch',
      'list',
      'read',
      'glob',
      'grep',
      'write',
      'edit',
      'apply_patch',
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
    ],
    enforce_macro_only_writes: false,
  };
});

const getLocalProjectContextStateMock = mock(async (_groupId: string) => ({
  architectConversationId: 'project-architect-conversation',
  implementConversationId: null,
}));
const syncArchitectPlanChatFromConversationMock = mock(async () => undefined);
const saveArchitectPlanNeedsMock = mock(async () => undefined);
const getChatSnapshotMock = mock(async () => ({
  conversations: chatSnapshotConversations,
  messages: chatSnapshotMessages,
}));
const updateConversationDetailsMock = mock(async () => undefined);
const gitBranchListMock = mock(async (repoPath: string) => (
  gitBranchesByRepo[repoPath] ?? { local: [], remote: [], current: null }
));
const dbGetConversationCompactionStateMock = mock(async () => null);
const dbUpsertConversationCompactionStateMock = mock(async () => undefined);
let dbMessageCounter = 0;
const createMessageMock = mock(
  async (
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    options?: {
      hiddenContext?: string;
      providerInputItems?: unknown[];
    }
  ) => ({
    id: `db-message-${++dbMessageCounter}`,
    conversation_id: conversationId,
    role,
    content,
    created_at: '2026-03-19T00:00:00.000Z',
    hidden_context: options?.hiddenContext ?? null,
    provider_input_items_json: options?.providerInputItems
      ? JSON.stringify(options.providerInputItems)
      : null,
  })
);
const deleteConversationMock = mock(async (_conversationId: string) => undefined);
const deleteConversationsMock = mock(async (_conversationIds: string[]) => undefined);
const updateMessageMock = mock(async () => undefined);
const deleteMessagesAfterMock = mock(async () => undefined);
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
const hydrateNeedsForPlanMock = mock(() => undefined);
const replaceNeedsForPlanMock = mock(() => undefined);

let importCounter = 0;

const createMockStoreHook = <TState extends object>(
  getSnapshot: () => TState,
  setSnapshot?: (
    patch: Partial<TState> | ((snapshot: TState) => Partial<TState>)
  ) => void
) => {
  const storeHook = (<TSelected = TState>(
    selector?: (snapshot: TState) => TSelected
  ) => (selector ? selector(getSnapshot()) : (getSnapshot() as unknown as TSelected))) as ((
    selector?: <TSelected>(snapshot: TState) => TSelected
  ) => TState) & {
    getState: () => TState;
    setState: (
      patch: Partial<TState> | ((snapshot: TState) => Partial<TState>)
    ) => void;
    subscribe: (listener?: (...args: unknown[]) => void) => () => void;
  };

  storeHook.getState = getSnapshot;
  storeHook.setState =
    setSnapshot ??
    (() => {
      return undefined;
    });
  storeHook.subscribe = () => () => undefined;

  return storeHook;
};

const useAppStoreMock = createMockStoreHook(
  () => appState,
  (patch) => {
    const previousState = cloneAppState();
    Object.assign(appState, typeof patch === 'function' ? patch(appState) : patch);
    emitAppStoreUpdate(previousState);
  }
);

appState.setTheme = (themeId: string) => {
  useAppStoreMock.setState({ activeThemeId: themeId });
};

useAppStoreMock.subscribe = (
  listener?: (
    nextState: typeof appState,
    previousState: typeof appState,
  ) => void
) => {
  if (!listener) {
    return () => undefined;
  }

  appStoreSubscribers.add(listener);
  return () => appStoreSubscribers.delete(listener);
};

const useTaskStoreMock = createMockStoreHook(
  () => taskStoreState,
  (patch) => {
    const nextState =
      typeof patch === 'function' ? patch(taskStoreState) : patch;
    Object.assign(taskStoreState, nextState);
  }
);

useTaskStoreMock.subscribe = (
  listener?: (
    nextState: typeof taskStoreState,
    previousState: typeof taskStoreState,
  ) => void
) => {
  if (!listener) {
    return () => undefined;
  }

  taskStoreSubscribers.add(listener);
  return () => taskStoreSubscribers.delete(listener);
};

const registerUseChatStoreMocks = async () => {
  const actualPreferences = await import(
    `../services/preferences.ts?chat-store-preferences-test=${importCounter + 1}`
  );

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
        pruneConversationSourceCitations: () => undefined,
      }),
    },
  }));

  mock.module('./useToolsStore', () => ({
    useToolsStore: {
      getState: () => toolsStoreState,
    },
  }));

  mock.module('./useAppStore', () => ({
    useAppStore: useAppStoreMock,
  }));

  mock.module('./useTaskStore', () => ({
    getPlanActivationCandidateTask: () => null,
    useTaskStore: useTaskStoreMock,
  }));

  mock.module('./useNeedsStore', () => ({
    useNeedsStore: {
      getState: () => ({
        addNeed: () => 'need-1',
        hydrateNeedsForPlan: hydrateNeedsForPlanMock,
        replaceNeedsForPlan: replaceNeedsForPlanMock,
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

  mock.module('../services/preferences', () => ({
    ...actualPreferences,
  }));

  mock.module('../services/tauriIpc', () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => tauriAvailable,
    aiStreamChat: async (params: {
      requestId: string;
      providerId: string;
      modelId: string;
      reasoningEffort?: string | null;
      conversationId?: string | null;
      messages: unknown[];
      tools?: unknown[];
      toolChoice?: string;
      parallelToolCalls?: boolean;
      workspacePath?: string | null;
      defaultWorkspacePath?: string | null;
      projectMounts?: Array<{
        projectId: string;
        mountName: string;
        workspacePath?: string | null;
        displayName: string;
      }>;
      virtualRootEnabled?: boolean | null;
      focusedProjectId?: string | null;
      allowedToolIds?: string[];
    }) => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('ai_stream_chat', {
        request: {
          request_id: params.requestId,
          provider_id: params.providerId,
          model_id: params.modelId,
          reasoning_effort: params.reasoningEffort ?? null,
          conversation_id: params.conversationId ?? null,
          messages: params.messages,
          tools: params.tools ?? [],
          tool_choice: params.toolChoice ?? 'auto',
          parallel_tool_calls: params.parallelToolCalls ?? false,
          workspace_path: params.workspacePath ?? null,
          default_workspace_path: params.defaultWorkspacePath ?? null,
          project_mounts: (params.projectMounts ?? []).map((mount) => ({
            project_id: mount.projectId,
            mount_name: mount.mountName,
            workspace_path: mount.workspacePath ?? null,
            display_name: mount.displayName,
          })),
          virtual_root_enabled: params.virtualRootEnabled ?? null,
          focused_project_id: params.focusedProjectId ?? null,
          allowed_tool_ids: params.allowedToolIds ?? [],
        },
      });
    },
    aiCancelStream: async (requestId: string) => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('ai_cancel_stream', { requestId });
    },
    createMessage: createMessageMock,
    dbGetConversationCompactionState: dbGetConversationCompactionStateMock,
    dbUpsertConversationCompactionState: dbUpsertConversationCompactionStateMock,
    deleteConversation: deleteConversationMock,
    deleteConversations: deleteConversationsMock,
    gitBranchList: gitBranchListMock,
    getChatSnapshot: getChatSnapshotMock,
    importMessages: importMessagesMock,
    getToolModePolicy: getToolModePolicyMock,
    updateMessage: updateMessageMock,
    deleteMessagesAfter: deleteMessagesAfterMock,
    updateConversationDetails: updateConversationDetailsMock,
  }));

  importCounter += 1;
  const actualArchitectPlanService = await import(
    `../services/architectPlanService.ts?use-chat-store-architect-plan-service-test=${importCounter}`
  );

  const architectPlanServiceModule = () => ({
    ...actualArchitectPlanService,
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
    listArchitectPlans: listArchitectPlansMock,
    resolvePlanProjectContextId: (plan: ArchitectPlanRecord, fallbackProjectId?: string | null) =>
      plan.projectId ?? plan.projectIds?.[0] ?? fallbackProjectId ?? null,
    restoreArchitectPlan: mock(async () => undefined),
    saveArchitectPlanNeeds: saveArchitectPlanNeedsMock,
    setActiveArchitectPlan: mock(async () => undefined),
    syncArchitectPlanChatFromConversation: syncArchitectPlanChatFromConversationMock,
    toPlanIntegrationBranch: (planId: string) => `plan/${planId}`,
    toPlanScopedFeatureBranch: (planId: string, featureSlug: string) => `feature/${planId}/${featureSlug}`,
    updateArchitectPlan: updateArchitectPlanMock,
  });
  mock.module('../services/architectPlanService', architectPlanServiceModule);
  mock.module('../services/architectPlanService.ts', architectPlanServiceModule);

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

const createChatSnapshotConversation = (
  id: string,
  overrides: Partial<ChatSnapshotConversationRecord> = {}
): ChatSnapshotConversationRecord => ({
  id,
  title: overrides.title ?? `Conversation ${id}`,
  description: overrides.description ?? '',
  scope_mode: overrides.scope_mode ?? 'Architect',
  task_id: overrides.task_id ?? null,
  group_id: overrides.group_id ?? 'group-1',
  project_id: overrides.project_id ?? 'project-1',
  last_message: overrides.last_message ?? '',
  message_count: overrides.message_count ?? 0,
  updated_at: overrides.updated_at ?? '2026-03-19T00:00:00.000Z',
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

type ArchitectScenarioPlanKind =
  | 'blank'
  | 'started'
  | 'legacy_unscoped'
  | 'renamed_blank'
  | 'scoped_multi_project';

const createScenarioPlan = (
  kind: ArchitectScenarioPlanKind,
  overrides: Partial<ArchitectPlanRecord> = {}
): ArchitectPlanRecord => {
  switch (kind) {
    case 'blank':
      return createPlan({
        label: 'new plan',
        description: '',
        status: 'draft',
        nodes: [],
        predictedBranches: [],
        ...overrides,
      });
    case 'started':
      return createPlan({
        label: 'Checkout refresh',
        description: 'Started planning',
        status: 'draft',
        ...overrides,
      });
    case 'legacy_unscoped':
      return createPlan({
        label: 'new plan',
        description: '',
        projectId: undefined,
        projectIds: [],
        nodes: [],
        predictedBranches: [],
        ...overrides,
      });
    case 'renamed_blank':
      return createPlan({
        label: 'Research scratchpad',
        description: '',
        status: 'draft',
        nodes: [],
        predictedBranches: [],
        ...overrides,
      });
    case 'scoped_multi_project':
      return createPlan({
        label: 'Checkout refresh',
        projectId: 'project-2',
        projectIds: ['project-2'],
        status: 'draft',
        ...overrides,
      });
    default:
      return createPlan(overrides);
  }
};

const createTranscriptEntry = (
  overrides: Partial<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }> = {}
) => ({
  id: overrides.id ?? 'm-1',
  role: overrides.role ?? 'assistant',
  content: overrides.content ?? 'Architect transcript entry',
  createdAt: overrides.createdAt ?? '2026-03-19T00:01:00.000Z',
});

const createChatMessageRecord = (
  overrides: Partial<{
    id: string;
    conversation_id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
  }> = {}
) => ({
  id: overrides.id ?? 'm-1',
  conversation_id: overrides.conversation_id ?? 'plan-conv',
  role: overrides.role ?? 'assistant',
  content: overrides.content ?? 'Architect transcript entry',
  created_at: overrides.created_at ?? '2026-03-19T00:01:00.000Z',
});

const createIdleChatStoreState = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

const createArchitectStoreState = (params: {
  conversations?: Conversation[];
  messages?: Array<Record<string, unknown>>;
  selectedConversationId?: string | null;
  selectedConversationIdsByMode?: Record<string, string>;
} = {}) =>
  createIdleChatStoreState({
    conversations: params.conversations ?? [createConversation('plan-conv')],
    messages: params.messages ?? [],
    selectedConversationId: params.selectedConversationId ?? 'plan-conv',
    selectedConversationIdsByMode: params.selectedConversationIdsByMode ?? { Architect: 'plan-conv' },
  });

const setArchitectStoreState = (
  useChatStore: { setState: (state: Record<string, unknown>) => void },
  params: Parameters<typeof createArchitectStoreState>[0] = {}
) => {
  useChatStore.setState(createArchitectStoreState(params));
};

const getLatestArchitectToolHandler = () => {
  const lastCall = ((streamChatMock as unknown as {
    mock: { calls: Array<Array<unknown>> };
  }).mock.calls.at(-1)?.[0] ?? null) as {
    onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  } | null;
  expect(lastCall?.onToolCall).toBeDefined();
  if (!lastCall?.onToolCall) {
    throw new Error('Expected Architect tool handler');
  }
  return lastCall.onToolCall;
};

const sendArchitectMessageAndGetToolHandler = async (
  useChatStore: Awaited<ReturnType<typeof loadChatStore>>['useChatStore'],
  params: {
    conversationId?: string;
    content: string;
  }
) => {
  await useChatStore.getState().sendMessage({
    conversationId: params.conversationId ?? 'plan-conv',
    content: params.content,
  });
  return getLatestArchitectToolHandler();
};

const expectArchitectSelection = (
  useChatStore: Awaited<ReturnType<typeof loadChatStore>>['useChatStore'],
  params: {
    planId: string;
    conversationId: string;
  }
) => {
  expect(appState.activeArchitectPlanId).toBe(params.planId);
  expect(useChatStore.getState().selectedConversationId).toBe(params.conversationId);
  expect(useChatStore.getState().selectedConversationIdsByMode.Architect).toBe(params.conversationId);
};

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

  beforeEach(async () => {
    await registerUseChatStoreMocks();
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
    appState.activeThemeId = 'macro-dark';
    appState.codeOverflowMode = 'wrap';
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
    taskStoreSubscribers.clear();
    appStoreSubscribers.clear();
    taskStoreState.lastError = null;
    taskStoreState.refreshFromPlan.mockClear();
    taskStoreState.clearPlanRuntimeState.mockClear();
    taskStoreState.finalizeManualFeatureDraft.mockClear();
    taskStoreState.startTask.mockClear();
    taskStoreState.markTaskAwaitingResponse.mockClear();
    taskStoreState.retryTask.mockClear();
    taskStoreState.deleteManualFeatureDraft.mockClear();
    tauriAvailable = false;
    dbMessageCounter = 0;
    chatSnapshotConversations = [];
    chatSnapshotMessages = [];
    getArchitectPlanChatMessagesMock.mockClear();
    getArchitectPlanMock.mockClear();
    listArchitectPlansMock.mockClear();
    updateArchitectPlanMock.mockClear();
    streamChatMock.mockClear();
    sendChatNonStreamingMock.mockClear();
    getToolModePolicyMock.mockClear();
    getLocalProjectContextStateMock.mockClear();
    syncArchitectPlanChatFromConversationMock.mockClear();
    saveArchitectPlanNeedsMock.mockClear();
    getChatSnapshotMock.mockClear();
    updateConversationDetailsMock.mockClear();
    gitBranchListMock.mockClear();
    createMessageMock.mockClear();
    dbGetConversationCompactionStateMock.mockClear();
    dbUpsertConversationCompactionStateMock.mockClear();
    deleteConversationMock.mockClear();
    deleteConversationsMock.mockClear();
    updateMessageMock.mockClear();
    deleteMessagesAfterMock.mockClear();
    importMessagesMock.mockClear();
    hydrateNeedsForPlanMock.mockClear();
    replaceNeedsForPlanMock.mockClear();
    toolsStoreState.loadSettings.mockClear();
    toolsStoreState.getEnabledChatToolIds = () => ['read_file', 'web_search', 'web_fetch', 'question'];
    appState.activateArchitectPlan.mockClear();
    appState.switchProjectContext.mockClear();
  });

  afterEach(() => {
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
    mock.restore();
  });

  afterAll(() => {
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
    mock.restore();
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
      createChatSnapshotConversation('project-architect-conversation', {
        title: 'Architect - Macro',
        last_message: 'fallback',
        message_count: 1,
        updated_at: '2026-03-19T00:03:00.000Z',
      }),
      createChatSnapshotConversation('plan-conv', {
        title: 'Checkout refresh',
        last_message: 'latest',
        message_count: 2,
        updated_at: '2026-03-19T00:04:00.000Z',
      }),
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

  it('keeps the active plan conversation during initialize without replaying a project scope switch', async () => {
    tauriAvailable = true;

    const plan = createScenarioPlan('scoped_multi_project', {
      id: 'plan-cross-project',
      conversationId: 'plan-conv',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { targetBranch: 'develop' };
    appState.selectedProjectId = 'project-1';

    chatSnapshotConversations = [
      createChatSnapshotConversation('project-architect-conversation', {
        description: '',
        title: 'Architect - Web',
        last_message: 'fallback',
        message_count: 1,
        updated_at: '2026-03-19T00:03:00.000Z',
      }),
      createChatSnapshotConversation('project-2-architect-fallback', {
        description: '',
        project_id: 'project-2',
        title: 'Architect - API',
        last_message: 'other fallback',
        message_count: 1,
        updated_at: '2026-03-19T00:05:00.000Z',
      }),
      createChatSnapshotConversation('plan-conv', {
        description: '',
        project_id: 'project-2',
        title: 'Checkout refresh',
        last_message: 'latest',
        message_count: 2,
        updated_at: '2026-03-19T00:04:00.000Z',
      }),
    ];
    chatSnapshotMessages = [
      createChatMessageRecord({
        id: 'm-1',
        conversation_id: 'plan-conv',
        role: 'user',
        content: 'First question',
      }),
      createChatMessageRecord({
        id: 'm-2',
        conversation_id: 'plan-conv',
        role: 'assistant',
        content: 'Second answer',
        created_at: '2026-03-19T00:02:00.000Z',
      }),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();

    expect(appState.switchProjectContext).not.toHaveBeenCalled();
    expectArchitectSelection(useChatStore, {
      planId: plan.id,
      conversationId: 'plan-conv',
    });
    expect(
      useChatStore.getState().getConversationMessages('plan-conv').map((message: { id: string }) => message.id)
    ).toEqual(['m-1', 'm-2']);
  });

  it('reuses the dedicated plan conversation after splitting a shared architect conversation once', async () => {
    const originalNow = Date.now;
    Date.now = () => 1773900000001;

    try {
      const plan = createScenarioPlan('blank', {
        id: 'plan-shared',
        conversationId: 'shared-conv',
      });
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [
        createTranscriptEntry({
          id: 'm-1',
          content: 'Shared transcripts should move.',
          createdAt: '2026-03-19T00:03:00.000Z',
        }),
      ]);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createIdleChatStoreState({
          conversations: [createConversation('shared-conv')],
        })
      );

      const first = await useChatStore.getState().ensureArchitectConversationForPlan({
        plan,
        targetBranch: 'develop',
        fallbackProjectId: 'project-1',
        fallbackGroupId: 'group-1',
        sharedConversation: true,
      });

      updateArchitectPlanMock.mockClear();
      const updatedPlan = architectPlans.get(plan.id)!;
      const second = await useChatStore.getState().ensureArchitectConversationForPlan({
        plan: updatedPlan,
        targetBranch: 'develop',
        fallbackProjectId: 'project-1',
        fallbackGroupId: 'group-1',
      });

      expect(first.createdConversation).toBe(true);
      expect(second).toEqual({
        conversationId: first.conversationId,
        restoredTranscript: false,
        createdConversation: false,
      });
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().conversations.filter((conversation: Conversation) => conversation.id === first.conversationId)).toHaveLength(1);
      expect(useChatStore.getState().selectedConversationId).toBe(first.conversationId);
    } finally {
      Date.now = originalNow;
    }
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
      onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
    } | undefined)?.onToolCall;

    expect(onToolCall).toBeDefined();
    await onToolCall?.('plan_update', {
      plan_id: plan.id,
      description: 'Updated scope',
    });

    expect(appState.activateArchitectPlan).toHaveBeenCalledWith(plan.id, {
      targetBranch: 'develop',
      persistActiveSelection: false,
    });
    expect(appState.switchProjectContext).toHaveBeenCalledWith('project-2', {
      restoreProjectContext: false,
      ensureAutoPlan: false,
    });
    expect(appState.activeArchitectPlanId).toBe(plan.id);
    expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
  });

  it('keeps the active plan and conversation on plan updates even when blank sibling drafts exist', async () => {
    const activePlan = createScenarioPlan('scoped_multi_project', {
      id: 'started-plan',
      conversationId: 'plan-conv',
      description: 'Started planning',
    });
    const blankSibling = createScenarioPlan('renamed_blank', {
      id: 'blank-sibling',
      conversationId: 'blank-conv',
      projectId: 'project-2',
      projectIds: ['project-2'],
    });
    architectPlans.set(activePlan.id, activePlan);
    architectPlans.set(blankSibling.id, blankSibling);
    appState.activeArchitectPlanId = activePlan.id;
    appState.activePlanContext = { targetBranch: 'develop' };
    appState.selectedProjectId = 'project-1';

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [
        createConversation('plan-conv'),
        createConversation('blank-conv', 'project-2'),
        {
          ...createConversation('project-2-architect-fallback', 'project-2'),
          title: 'Architect - API',
        },
      ],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Refresh the active plan context.',
    });

    await onToolCall('plan_update', {
      plan_id: activePlan.id,
      description: 'Updated scope',
    });

    expect(appState.activateArchitectPlan).toHaveBeenCalledWith(activePlan.id, {
      targetBranch: 'develop',
      persistActiveSelection: false,
    });
    expect(appState.switchProjectContext).toHaveBeenCalledWith('project-2', {
      restoreProjectContext: false,
      ensureAutoPlan: false,
    });
    expectArchitectSelection(useChatStore, {
      planId: activePlan.id,
      conversationId: 'plan-conv',
    });
    expect((updateArchitectPlanMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.every((call) => call[0]?.planId === activePlan.id)).toBe(true);
    expect(architectPlans.get(blankSibling.id)?.label).toBe(blankSibling.label);
  });

  it('does not re-resolve the architect conversation when only the selected task changes', async () => {
    tauriAvailable = true;

    const plan = createPlan({ conversationId: 'plan-conv' });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    chatSnapshotConversations = [
      createChatSnapshotConversation('plan-conv', {
        title: 'Checkout refresh',
        last_message: 'latest',
        message_count: 2,
        updated_at: '2026-03-19T00:04:00.000Z',
      }),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();

    const initialSelectionRequestId = useChatStore.getState().selectionRequestId;
    useAppStoreMock.setState({ selectedTaskId: 'task-1' });
    await Promise.resolve();

    expect(useChatStore.getState().selectionRequestId).toBe(initialSelectionRequestId);
    expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
    expect(useChatStore.getState().restoreStatus).toBe('ready');
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
      onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
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

  it('keeps the active plan and conversation stable during strategy generation with blank sibling drafts', async () => {
    const activePlan = createScenarioPlan('started', {
      id: 'started-plan',
      conversationId: 'plan-conv',
    });
    const blankSibling = createScenarioPlan('blank', {
      id: 'blank-sibling',
      conversationId: 'blank-conv',
      label: 'new plan 2',
    });
    architectPlans.set(activePlan.id, activePlan);
    architectPlans.set(blankSibling.id, blankSibling);
    appState.activeArchitectPlanId = activePlan.id;
    appState.activePlanContext = { targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv'), createConversation('blank-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Generate the strategy.',
    });
    updateArchitectPlanMock.mockClear();

    await onToolCall('strategy_generate', {
      nodes: [{ title: 'Implement checkout' }],
    });

    const lastCall = ((updateArchitectPlanMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

    expectArchitectSelection(useChatStore, {
      planId: activePlan.id,
      conversationId: 'plan-conv',
    });
    expect('label' in lastCall).toBe(false);
    expect('title' in lastCall).toBe(false);
    expect(architectPlans.get(blankSibling.id)?.label).toBe('new plan 2');
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
      onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
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

  it('keeps the active plan and conversation stable during strategy updates with blank sibling drafts', async () => {
    const activePlan = createScenarioPlan('started', {
      id: 'started-plan',
      conversationId: 'plan-conv',
    });
    const blankSibling = createScenarioPlan('renamed_blank', {
      id: 'blank-sibling',
      conversationId: 'blank-conv',
    });
    architectPlans.set(activePlan.id, activePlan);
    architectPlans.set(blankSibling.id, blankSibling);
    appState.activeArchitectPlanId = activePlan.id;
    appState.activePlanContext = { targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv'), createConversation('blank-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Update the strategy.',
    });
    updateArchitectPlanMock.mockClear();

    await onToolCall('strategy_update', {
      replace: true,
      nodes: [{ title: 'Implement checkout' }],
    });

    const lastCall = ((updateArchitectPlanMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

    expectArchitectSelection(useChatStore, {
      planId: activePlan.id,
      conversationId: 'plan-conv',
    });
    expect('label' in lastCall).toBe(false);
    expect('title' in lastCall).toBe(false);
    expect(architectPlans.get(blankSibling.id)?.label).toBe(blankSibling.label);
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

  it('uses the backend tool policy in Chat mode and keeps question available when enabled', async () => {
    tauriAvailable = true;
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    getToolModePolicyMock.mockResolvedValueOnce({
      allowed_tool_ids: ['question', 'read_file', 'web_search'],
      enforce_macro_only_writes: false,
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          id: 'chat-conv',
          title: 'Conversation chat-conv',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-19T00:00:00.000Z',
          is_unread: false,
        },
      ],
      messages: [],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Pose-moi des questions pour cadrer le besoin.',
    });

    expect(getToolModePolicyMock).toHaveBeenCalledWith('Chat');
    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      allowedToolIds: string[];
    };
    expect(streamOptions.allowedToolIds).toContain('question');
  });

  it('adds a guided retry when the user explicitly asks to use the question tool', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          id: 'chat-conv',
          title: 'Conversation chat-conv',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-19T00:00:00.000Z',
          is_unread: false,
        },
      ],
      messages: [],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content:
        "Pose moi des questions pour choisir ma couleur preferee, utilise l'outil Question.",
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      guidedToolRetry?: {
        requiredToolNames: string[];
        retrySystemPrompt: string;
      };
    };
    expect(streamOptions.guidedToolRetry?.requiredToolNames).toEqual(['question']);
    expect(streamOptions.guidedToolRetry?.retrySystemPrompt).toContain(
      'explicitly asked you to use the question tool',
    );
  });

  it('does not force the question tool retry when question is disabled in chat tools', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    toolsStoreState.getEnabledChatToolIds = () => ['read_file', 'web_search', 'web_fetch'];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          id: 'chat-conv',
          title: 'Conversation chat-conv',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-19T00:00:00.000Z',
          is_unread: false,
        },
      ],
      messages: [],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content:
        "Pose moi des questions pour choisir ma couleur preferee, utilise l'outil Question.",
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      guidedToolRetry?: {
        requiredToolNames: string[];
      };
      allowedToolIds: string[];
    };
    expect(streamOptions.allowedToolIds).not.toContain('question');
    expect(streamOptions.guidedToolRetry).toBeUndefined();
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

  it('returns an interruptive resolution for the question tool', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [
      createManualFeatureTask({
        draft: false,
        status: 'Pending',
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
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Continue.',
      taskId: 'manual-task-1',
    });

    const onToolCall = (((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0]) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
    } | undefined)?.onToolCall;

    const result = await onToolCall?.('question', {
      intro: 'Need one blocking choice.',
      questions: [
        {
          id: 'scope',
          prompt: 'Which scope should I use?',
          choices: ['Minimal', 'Balanced', 'Large'],
        },
      ],
    });

    expect(result).toMatchObject({
      kind: 'interrupt',
      visibleContent: 'Need one blocking choice.',
    });
    expect(
      (result as { hiddenContext?: string } | undefined)?.hiddenContext,
    ).toContain('<questionnaire_context>');
  });

  it('moves an implement task to awaiting response when a question tool interrupt completes the assistant turn', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [
      createManualFeatureTask({
        draft: false,
        title: 'Quick export',
        status: 'InProgress',
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
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Continue.',
      taskId: 'manual-task-1',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? {}) as {
      onComplete?: (result: {
        visibleContent: string;
        toolTraces: unknown[];
        hiddenContext?: string;
        usage: null;
      }) => void;
      onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
    };

    const interruptResult = await streamOptions.onToolCall?.('question', {
      intro: 'Need one blocking choice.',
      questions: [
        {
          id: 'scope',
          prompt: 'Which scope should I use?',
          choices: ['Minimal', 'Balanced', 'Large'],
        },
      ],
    });

    streamOptions.onComplete?.({
      visibleContent:
        (interruptResult as { visibleContent?: string } | undefined)?.visibleContent ??
        'Need one blocking choice.',
      toolTraces: [],
      hiddenContext: (interruptResult as { hiddenContext?: string } | undefined)?.hiddenContext,
      usage: null,
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(taskStoreState.markTaskAwaitingResponse).toHaveBeenCalledWith('manual-task-1');
    expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
      status: 'AwaitingResponse',
    });
    expect(useChatStore.getState().getConversationRuntime('manual-conv').phase).toBe('idle');
  });

  it('moves an implement task to awaiting response when the assistant reply contains a structured questionnaire', async () => {
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
      questionnaireDraftsByConversationId: {},
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
      visibleContent: 'Need one blocking choice.',
      toolTraces: [],
      hiddenContext:
        '<questionnaire_context>\n' +
        '{"intro":"Need one blocking choice.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]}]}\n' +
        '</questionnaire_context>',
      usage: null,
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(taskStoreState.markTaskAwaitingResponse).toHaveBeenCalledWith('manual-task-1');
    expect(
      useChatStore
        .getState()
        .getConversationMessages('manual-conv')
        .find((message: { role: string }) => message.role === 'assistant')?.questionnaire?.questions
        .length
    ).toBe(1);
  });

  it('reapplies AwaitingResponse after a task refresh when an implement questionnaire is still unresolved', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [
      createManualFeatureTask({
        draft: false,
        title: 'Quick export',
        status: 'InProgress',
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
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: 'manual-task-1',
          conversation_id: 'manual-conv',
          role: 'assistant',
          content: 'Need one blocking choice.',
          timestamp: '2026-04-14T10:00:00.000Z',
          questionnaire: {
            intro: 'Need one blocking choice.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        },
      ],
      selectedConversationId: 'manual-conv',
      selectedConversationIdsByMode: { Implement: 'manual-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    taskStoreState.markTaskAwaitingResponse.mockClear();
    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = taskStoreState.tasks.map((task) => ({ ...task }));
    emitTaskStoreUpdate(previousTasks);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

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

  it('tracks questionnaire progress locally, stores a structured summary, and resolves the question tool output on submit', async () => {
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Need two clarifications.',
          timestamp: '2026-04-14T10:00:00.000Z',
          provider_input_items: [
            {
              type: 'function_call',
              call_id: 'call_question',
              name: 'question',
              arguments:
                '{"intro":"Need two clarifications.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]},{"id":"risk","prompt":"How risky can the change be?","choices":["Safe","Moderate","Aggressive"],"free_text_placeholder":"Custom answer"}]}',
            },
          ],
          questionnaire: {
            intro: 'Need two clarifications.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
                free_text_placeholder: 'Custom answer',
              },
            ],
          },
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    const initialQuestionnaire = useChatStore
      .getState()
      .getActiveQuestionnaire('chat-conv');
    expect(initialQuestionnaire?.currentStep.id).toBe('scope');

    const firstStep = useChatStore
      .getState()
      .recordActiveQuestionnaireAnswer('chat-conv', 'Balanced');
    expect(firstStep?.completed).toBe(false);
    expect(
      useChatStore.getState().getActiveQuestionnaire('chat-conv')?.currentStep.id,
    ).toBe('risk');

    useChatStore
      .getState()
      .setActiveQuestionnaireDraftText('chat-conv', 'Stay below one day of rework');
    const secondStep = useChatStore
      .getState()
      .recordActiveQuestionnaireAnswer(
        'chat-conv',
        'Stay below one day of rework',
      );
    expect(secondStep?.completed).toBe(true);

    await useChatStore.getState().submitActiveQuestionnaire('chat-conv');

    const userMessages = useChatStore
      .getState()
      .getConversationMessages('chat-conv')
      .filter((message: { role: string }) => message.role === 'user');
    expect(userMessages.at(-1)?.content).toBe(
      'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
    );
    expect(userMessages.at(-1)?.questionnaire_response_summary).toEqual({
      assistantMessageId: 'assistant-questionnaire',
      source: 'tool',
      originToolCallId: 'call_question',
      items: [
        {
          id: 'scope',
          prompt: 'Which scope should I use?',
          answer: 'Balanced',
        },
        {
          id: 'risk',
          prompt: 'How risky can the change be?',
          answer: 'Stay below one day of rework',
        },
      ],
    });
    expect(userMessages.at(-1)?.provider_input_items).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_question',
        output:
          'Questionnaire responses:\n- Which scope should I use?: Balanced\n- How risky can the change be?: Stay below one day of rework',
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
          },
        ],
      },
    ]);
    expect(
      useChatStore.getState().questionnaireDraftsByConversationId['chat-conv'],
    ).toBeUndefined();
  });

  it('reopens, cancels, and restores questionnaire response edits from the original summary', async () => {
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Need two clarifications.',
          timestamp: '2026-04-14T10:00:00.000Z',
          provider_input_items: [
            {
              type: 'function_call',
              call_id: 'call_question',
              name: 'question',
              arguments:
                '{"intro":"Need two clarifications.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]},{"id":"risk","prompt":"How risky can the change be?","choices":["Safe","Moderate","Aggressive"],"free_text_placeholder":"Custom answer"}]}',
            },
          ],
          questionnaire: {
            intro: 'Need two clarifications.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
                free_text_placeholder: 'Custom answer',
              },
            ],
          },
        },
        {
          id: 'user-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user',
          content:
            'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
          timestamp: '2026-04-14T10:01:00.000Z',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'tool',
            originToolCallId: 'call_question',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                answer: 'Stay below one day of rework',
              },
            ],
          },
        },
        {
          id: 'assistant-after',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Thanks, I can continue.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    expect(
      useChatStore.getState().startQuestionnaireResponseEdit('user-questionnaire'),
    ).toBe(true);
    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
      mode: 'editing_response',
      responseMessageId: 'user-questionnaire',
      currentStepIndex: 0,
      answersByStepId: {
        scope: 'Balanced',
        risk: 'Stay below one day of rework',
      },
    });

    useChatStore
      .getState()
      .recordActiveQuestionnaireAnswer('chat-conv', 'Large');
    useChatStore
      .getState()
      .setActiveQuestionnaireDraftText('chat-conv', 'Use two-day budget');
    useChatStore.getState().cancelQuestionnaireSession('chat-conv');

    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toBeNull();

    expect(
      useChatStore.getState().startQuestionnaireResponseEdit('user-questionnaire'),
    ).toBe(true);
    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
      mode: 'editing_response',
      currentStepIndex: 0,
      answersByStepId: {
        scope: 'Balanced',
        risk: 'Stay below one day of rework',
      },
      draftTextByStepId: {
        risk: 'Stay below one day of rework',
      },
    });
  });

  it('navigates between questionnaire steps while preserving existing answers and drafts', async () => {
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Need two clarifications.',
          timestamp: '2026-04-14T10:00:00.000Z',
          questionnaire: {
            intro: 'Need two clarifications.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
                free_text_placeholder: 'Custom scope',
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
                free_text_placeholder: 'Custom risk',
              },
            ],
          },
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {
        'chat-conv': {
          assistantMessageId: 'assistant-questionnaire',
          currentStepIndex: 0,
          answersByStepId: {
            scope: 'Balanced',
          },
          draftTextByStepId: {
            risk: 'Stay below one day of rework',
          },
        },
      },
      composerContextRefs: [],
    });

    useChatStore.getState().setActiveQuestionnaireStep('chat-conv', 1);

    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
      currentStepIndex: 1,
      currentStep: {
        id: 'risk',
      },
      answersByStepId: {
        scope: 'Balanced',
      },
      draftTextByStepId: {
        risk: 'Stay below one day of rework',
      },
    });

    useChatStore.getState().setActiveQuestionnaireStep('chat-conv', 0);

    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
      currentStepIndex: 0,
      currentStep: {
        id: 'scope',
      },
      answersByStepId: {
        scope: 'Balanced',
      },
      draftTextByStepId: {
        risk: 'Stay below one day of rework',
      },
    });
  });

  it('returns to the first unanswered questionnaire step before finishing', async () => {
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Need three clarifications.',
          timestamp: '2026-04-14T10:00:00.000Z',
          questionnaire: {
            intro: 'Need three clarifications.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
              {
                id: 'timing',
                prompt: 'How soon do you need it?',
                choices: ['Today', 'This week', 'Later'],
              },
            ],
          },
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {
        'chat-conv': {
          assistantMessageId: 'assistant-questionnaire',
          currentStepIndex: 2,
          answersByStepId: {
            scope: 'Balanced',
          },
          draftTextByStepId: {},
        },
      },
      composerContextRefs: [],
    });

    const result = useChatStore
      .getState()
      .recordActiveQuestionnaireAnswer('chat-conv', 'This week');

    expect(result?.completed).toBe(false);
    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
      currentStepIndex: 1,
      currentStep: {
        id: 'risk',
      },
      answersByStepId: {
        scope: 'Balanced',
        timing: 'This week',
      },
    });
  });

  it('repositions direct questionnaire submission to the first unanswered step', async () => {
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Need three clarifications.',
          timestamp: '2026-04-14T10:00:00.000Z',
          questionnaire: {
            intro: 'Need three clarifications.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
              {
                id: 'timing',
                prompt: 'How soon do you need it?',
                choices: ['Today', 'This week', 'Later'],
              },
            ],
          },
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {
        'chat-conv': {
          assistantMessageId: 'assistant-questionnaire',
          currentStepIndex: 2,
          answersByStepId: {
            scope: 'Balanced',
            timing: 'This week',
          },
          draftTextByStepId: {},
        },
      },
      composerContextRefs: [],
    });

    const result = await useChatStore
      .getState()
      .submitActiveQuestionnaire('chat-conv');

    expect(result).toBeNull();
    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
      currentStepIndex: 1,
      currentStep: {
        id: 'risk',
      },
      answersByStepId: {
        scope: 'Balanced',
        timing: 'This week',
      },
    });
    expect(
      useChatStore
        .getState()
        .getConversationMessages('chat-conv')
        .filter((message: { role: string }) => message.role === 'user'),
    ).toHaveLength(0);
  });

  it('replaces an edited questionnaire response, trims later messages, and restarts the chat from the updated answer', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Need two clarifications.',
          timestamp: '2026-04-14T10:00:00.000Z',
          provider_input_items: [
            {
              type: 'function_call',
              call_id: 'call_question',
              name: 'question',
              arguments:
                '{"intro":"Need two clarifications.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]},{"id":"risk","prompt":"How risky can the change be?","choices":["Safe","Moderate","Aggressive"],"free_text_placeholder":"Custom answer"}]}',
            },
          ],
          questionnaire: {
            intro: 'Need two clarifications.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
                free_text_placeholder: 'Custom answer',
              },
            ],
          },
        },
        {
          id: 'user-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user',
          content:
            'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
          timestamp: '2026-04-14T10:01:00.000Z',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'tool',
            originToolCallId: 'call_question',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                answer: 'Stay below one day of rework',
              },
            ],
          },
          provider_input_items: [
            {
              type: 'function_call_output',
              call_id: 'call_question',
              output:
                'Questionnaire responses:\n- Which scope should I use?: Balanced\n- How risky can the change be?: Stay below one day of rework',
            },
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text:
                    'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
                },
              ],
            },
          ],
        },
        {
          id: 'assistant-after',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Thanks, I can continue.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    expect(
      useChatStore.getState().startQuestionnaireResponseEdit('user-questionnaire'),
    ).toBe(true);
    useChatStore
      .getState()
      .recordActiveQuestionnaireAnswer('chat-conv', 'Large');
    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
      mode: 'editing_response',
      responseMessageId: 'user-questionnaire',
      currentStepIndex: 0,
      answersByStepId: {
        scope: 'Large',
        risk: 'Stay below one day of rework',
      },
    });

    await useChatStore.getState().submitActiveQuestionnaire('chat-conv');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const conversationMessages = useChatStore.getState().getConversationMessages('chat-conv');
    const updatedUserMessage = conversationMessages.find(
      (message: { id: string }) => message.id === 'user-questionnaire'
    );
    expect(updatedUserMessage?.questionnaire_response_summary).toEqual({
      assistantMessageId: 'assistant-questionnaire',
      source: 'tool',
      originToolCallId: 'call_question',
      items: [
        {
          id: 'scope',
          prompt: 'Which scope should I use?',
          answer: 'Large',
        },
        {
          id: 'risk',
          prompt: 'How risky can the change be?',
          answer: 'Stay below one day of rework',
        },
      ],
    });
    expect(updatedUserMessage?.content).toBe(
      'Which scope should I use?: Large\nHow risky can the change be?: Stay below one day of rework',
    );
    expect(
      conversationMessages.some((message: { id: string }) => message.id === 'assistant-after')
    ).toBe(false);
    expect(useChatStore.getState().questionnaireDraftsByConversationId['chat-conv']).toBeUndefined();

    expect(updateMessageMock).toHaveBeenCalledWith(
      'user-questionnaire',
      'Which scope should I use?: Large\nHow risky can the change be?: Stay below one day of rework',
      expect.objectContaining({
        hiddenContext: expect.stringContaining('<questionnaire_response_context>'),
        providerInputItems: [
          {
            type: 'function_call_output',
            call_id: 'call_question',
            output:
              'Questionnaire responses:\n- Which scope should I use?: Large\n- How risky can the change be?: Stay below one day of rework',
          },
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  'Which scope should I use?: Large\nHow risky can the change be?: Stay below one day of rework',
              },
            ],
          },
        ],
      }),
    );
    expect(deleteMessagesAfterMock).toHaveBeenCalledWith('chat-conv', 'user-questionnaire');
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(streamOptions.messages.some((message) =>
      message.role === 'user' &&
      message.content ===
        'Which scope should I use?: Large\nHow risky can the change be?: Stay below one day of rework'
    )).toBe(true);
  });

  it('submits legacy quick-reply questionnaires without fabricating a function call output', async () => {
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Need one decision.',
          timestamp: '2026-04-14T10:00:00.000Z',
          questionnaire: {
            intro: 'Need one decision.',
            source: 'legacy_quick_replies',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    useChatStore
      .getState()
      .recordActiveQuestionnaireAnswer('chat-conv', 'Balanced');

    await useChatStore.getState().submitActiveQuestionnaire('chat-conv');

    const userMessage = useChatStore
      .getState()
      .getConversationMessages('chat-conv')
      .filter((message: { role: string }) => message.role === 'user')
      .at(-1);

    expect(userMessage?.questionnaire_response_summary).toEqual({
      assistantMessageId: 'assistant-questionnaire',
      source: 'legacy_quick_replies',
      items: [
        {
          id: 'scope',
          prompt: 'Which scope should I use?',
          answer: 'Balanced',
        },
      ],
    });
    expect(userMessage?.provider_input_items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Which scope should I use?: Balanced',
          },
        ],
      },
    ]);
  });

  it('keeps edited legacy questionnaire responses free of function_call_output items', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'assistant-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Need one decision.',
          timestamp: '2026-04-14T10:00:00.000Z',
          questionnaire: {
            intro: 'Need one decision.',
            source: 'legacy_quick_replies',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        },
        {
          id: 'user-questionnaire',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user',
          content: 'Which scope should I use?: Balanced',
          timestamp: '2026-04-14T10:01:00.000Z',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'legacy_quick_replies',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
            ],
          },
          provider_input_items: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'Which scope should I use?: Balanced',
                },
              ],
            },
          ],
        },
        {
          id: 'assistant-after',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Thanks, I can continue.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    expect(
      useChatStore.getState().startQuestionnaireResponseEdit('user-questionnaire'),
    ).toBe(true);
    useChatStore
      .getState()
      .recordActiveQuestionnaireAnswer('chat-conv', 'Large');
    expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
      mode: 'editing_response',
      responseMessageId: 'user-questionnaire',
      currentStepIndex: 0,
      answersByStepId: {
        scope: 'Large',
      },
    });

    await useChatStore.getState().submitActiveQuestionnaire('chat-conv');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updatedUserMessage = useChatStore
      .getState()
      .getConversationMessages('chat-conv')
      .find((message: { id: string }) => message.id === 'user-questionnaire');

    expect(updatedUserMessage?.provider_input_items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Which scope should I use?: Large',
          },
        ],
      },
    ]);
    expect(updateMessageMock).toHaveBeenCalledWith(
      'user-questionnaire',
      'Which scope should I use?: Large',
      expect.objectContaining({
        providerInputItems: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Which scope should I use?: Large',
              },
            ],
          },
        ],
      }),
    );
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
    ).rejects.toThrow(
      'This conversation is already running. Wait for it to finish before sending again.'
    );

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

  it('keeps conversation runtimes independent across parallel chat streams and targeted stops', async () => {
    appState.mode = 'Chat';

    const activeStreams = new Map<string, () => void>();
    (streamChatMock as unknown as {
      mockImplementation: (
        implementation: (options: {
          conversationId?: string;
          signal?: AbortSignal;
          onComplete: (result: { visibleContent: string; toolTraces: [] }) => void;
        }) => Promise<void>
      ) => void;
    }).mockImplementation(async (options) => {
      await new Promise<void>((resolve) => {
        const finish = () => {
          options.onComplete({
            visibleContent: '',
            toolTraces: [],
          });
          resolve();
        };

        activeStreams.set(options.conversationId ?? 'unknown', finish);
        options.signal?.addEventListener('abort', finish, { once: true });
      });
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('chat-1'),
          scope_mode: 'Chat',
          title: 'Chat 1',
        },
        {
          ...createConversation('chat-2'),
          scope_mode: 'Chat',
          title: 'Chat 2',
        },
      ],
      messages: [],
      selectedConversationId: 'chat-1',
      selectedConversationIdsByMode: { Chat: 'chat-1' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-1',
      content: 'Stream A',
    });
    await useChatStore.getState().sendMessage({
      conversationId: 'chat-2',
      content: 'Stream B',
    });

    expect(useChatStore.getState().getConversationRuntime('chat-1').phase).toBe('streaming');
    expect(useChatStore.getState().getConversationRuntime('chat-2').phase).toBe('streaming');

    useChatStore.getState().stopConversationStream('chat-1');
    await Promise.resolve();

    expect(useChatStore.getState().getConversationRuntime('chat-1').phase).toBe('idle');
    expect(useChatStore.getState().getConversationRuntime('chat-2').phase).toBe('streaming');

    activeStreams.get('chat-2')?.();
    await Promise.resolve();

    expect(useChatStore.getState().getConversationRuntime('chat-2').phase).toBe('idle');
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
