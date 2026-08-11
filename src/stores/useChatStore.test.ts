import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  AgentCodeCheckpoint,
  AgentType,
  AppMode,
  ChatMessage,
  Conversation,
  ContextReference,
  ProjectGroup,
  SkillManifest,
  WorkspaceFileReference,
} from '../types';
import type { Citation } from './useCitationsStore';
import {
  ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE,
  type ArchitectPlanRecord,
  type ArchitectPlanStatus,
} from '../services/architectPlanService';
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

const DEFAULT_PROVIDER_CONFIGS = [
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
];
const COMPACTED_STATE_MARKER = '[COMPACTED CONVERSATION STATE]';

const DEFAULT_MODELS_BY_PROVIDER = {
  'provider-1': [{ id: 'model-1', name: 'Model 1', isEnabled: true }],
} as Record<string, Array<{ id: string; name: string; isEnabled: boolean }>>;

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
  agentType: 'build' as AgentType,
  selectedGroupId: 'group-1' as string | null,
  selectedProjectId: 'project-1' as string | null,
  selectedTaskId: null as string | null,
  activeThemeId: 'macro-dark',
  codeOverflowMode: 'wrap' as const,
  activeArchitectPlanId: null as string | null,
  activePlanContext: null as {
    id?: string;
    targetBranch: string;
    status?: ArchitectPlanStatus;
  } | null,
  architectPlanSwitch: {
    requestId: 0,
    targetPlanId: null as string | null,
    targetBranch: null as string | null,
    status: 'idle',
    startedAt: null as number | null,
    summaryHint: null,
    errorMessage: null as string | null,
  },
  pendingArchitectPlanActivationPayload: null as Record<string, unknown> | null,
  strategyMutationPreview: null as Record<string, unknown> | null,
  projectGroups,
  getProjectById: (projectId: string) =>
    projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId),
  setActiveArchitectPlanId: (_planId: string | null) => undefined,
  setPlanNodes: (_nodes: unknown[]) => undefined,
  setPredictedBranches: (_branches: unknown[]) => undefined,
  setStrategyMutationPreview: (preview: Record<string, unknown> | null) => {
    appState.strategyMutationPreview = preview;
  },
  consumeArchitectPlanActivationPayload: (params?: {
    planId?: string | null;
    targetBranch?: string | null;
  }) => {
    const payload = appState.pendingArchitectPlanActivationPayload;
    if (!payload) {
      return null;
    }
    if (
      params?.planId &&
      (payload as { plan?: { id?: string } }).plan?.id !== params.planId
    ) {
      return null;
    }
    if (
      params?.targetBranch &&
      (payload as { targetBranch?: string }).targetBranch !== params.targetBranch
    ) {
      return null;
    }
    appState.pendingArchitectPlanActivationPayload = null;
    return payload;
  },
  setActivePlanContext: (_context: unknown) => undefined,
  setSelectedTask: (taskId: string | null) => {
    appState.selectedTaskId = taskId;
  },
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
      appState.architectPlanSwitch = {
        requestId: appState.architectPlanSwitch.requestId + 1,
        targetPlanId: plan.id,
        targetBranch: options?.targetBranch ?? plan.targetBranch,
        status: 'ready',
        startedAt: Date.now(),
        summaryHint: null,
        errorMessage: null,
      };
      appState.pendingArchitectPlanActivationPayload = null;
      return true;
    }
  ),
  switchProjectContext: mock(async (_projectId: string, _options?: unknown) => undefined),
};

const providerState = {
  providerConfigs: DEFAULT_PROVIDER_CONFIGS.map((provider) => ({ ...provider })),
  modelsByProvider: Object.fromEntries(
    Object.entries(DEFAULT_MODELS_BY_PROVIDER).map(([providerId, models]) => [
      providerId,
      models.map((model) => ({ ...model })),
    ]),
  ) as Record<string, Array<{ id: string; name: string; isEnabled: boolean }>>,
  selectedProviderId: 'provider-1' as string | null,
  selectedModelId: 'model-1' as string | null,
  selectedReasoningEffort: null as string | null,
  loadProviderModels: mock(async (providerId: string) => providerState.modelsByProvider[providerId] ?? []),
  scanModelsForProvider: mock(async (providerId: string) => providerState.modelsByProvider[providerId] ?? []),
  ensureSelectedModelContextMetadata: mock(async () => providerState.modelsByProvider[providerState.selectedProviderId ?? 'provider-1'] ?? []),
  recordProviderModelContextOverflowLimit: mock(async () => undefined),
  resolveProviderApiKey: mock(async () => undefined),
  selectedSupportsNativeToolCalling: () => false,
  markReasoningUnsupportedForModel: mock(() => undefined),
  markProviderReachable: mock(() => undefined),
  commitRestoredSelection: undefined as unknown as ReturnType<typeof mock>,
  selectModel: mock((modelId: string) => {
    const previousState = cloneProviderState();
    providerState.selectedModelId = modelId;
    emitProviderStoreUpdate(previousState);
  }),
  selectReasoningEffort: mock((effort: string | null) => {
    const previousState = cloneProviderState();
    providerState.selectedReasoningEffort = effort;
    emitProviderStoreUpdate(previousState);
  }),
  selectProvider: mock((providerId: string) => {
    const previousState = cloneProviderState();
    providerState.selectedProviderId = providerId;
    providerState.selectedModelId = null;
    providerState.selectedReasoningEffort = null;
    emitProviderStoreUpdate(previousState);
  }),
};

const setSelectedProviderModelContext = (
  contextWindowTokens = 8_000,
  outputLimitTokens = 1_200,
) => {
  providerState.modelsByProvider = {
    ...providerState.modelsByProvider,
    [providerState.selectedProviderId ?? 'provider-1']: [
      {
        id: providerState.selectedModelId ?? 'model-1',
        name: 'Small context model',
        isEnabled: true,
        contextWindowTokens,
        outputLimitTokens,
      } as never,
    ],
  };
};

const buildManualCompactionLoad = (label: string): string =>
  `${label}\n${'manual compaction retained project detail\n'.repeat(5_000)}`;

const ALL_INTERNAL_TOOL_IDS = [
  'skill_activate',
  'skill_read_resource',
  'skill_run_script',
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
  'task_todo_get',
  'task_todo_update',
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
  lastError: null as string | null,
  isToolEnabled: (_toolId: string) => true,
  isChatToolEnabled: (_toolId: string) => true,
  getEnabledChatToolIds: () => [
    'skill_activate',
    'skill_read_resource',
    'skill_run_script',
    'read_file',
    'web_search',
    'web_fetch',
    'question',
  ],
  getEnabledMCPToolIds: () => [] as string[],
  getEnabledMCPTools: () => [] as Array<{
    id: string;
    serverId: string;
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>,
  getMCPToolById: (_toolId: string) => null,
  callMCPTool: mock(async (_toolId: string, _args: Record<string, unknown>) => 'mcp-result'),
  loadSettings: mock(async () => undefined),
};

type TestCitation = {
  id: string;
  type: 'web' | 'file' | 'document' | 'source_passage';
  scope: 'context' | 'source';
  source: string;
  title: string;
  snippet?: string;
  content?: string;
  messageId: string;
  conversationId: string;
  timestamp: string;
  url?: string;
  path?: string;
  kind?: 'interesting' | 'used';
  reason?: string;
};

let citationCounter = 0;
let citationRecords: TestCitation[] = [];

const createCitationId = () => `cite-test-${++citationCounter}`;

const ensureCitationContentLoadedMock = mock(async (id: string) =>
  citationRecords.find((citation) => citation.id === id) ?? null
);

const sortSourceCitations = (citations: TestCitation[]) =>
  [...citations].sort(
    (left, right) =>
      new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
  );

const providerStoreSubscribers = new Set<
  (
    nextState: typeof providerState,
    previousState: typeof providerState,
  ) => void
>();

const cloneProviderState = () => ({
  ...providerState,
  providerConfigs: providerState.providerConfigs.map((provider) => ({ ...provider })),
  modelsByProvider: Object.fromEntries(
    Object.entries(providerState.modelsByProvider).map(([providerId, models]) => [
      providerId,
      models.map((model) => ({ ...model })),
    ]),
  ),
});

const createCommitRestoredSelectionMock = () =>
  mock(
    async (
      selection: {
        providerId: string;
        modelId?: string | null;
        reasoningEffort?: string | null;
      },
      options?: { isActive?: () => boolean }
    ) => {
      if (options?.isActive && !options.isActive()) {
        return null;
      }

      const models = providerState.modelsByProvider[selection.providerId] ?? [];
      const resolvedModelId =
        selection.modelId && models.some((model) => model.id === selection.modelId && model.isEnabled !== false)
          ? selection.modelId
          : models.find((model) => model.isEnabled !== false)?.id ?? null;
      if (!resolvedModelId) {
        return null;
      }

      const previousState = cloneProviderState();
      providerState.selectedProviderId = selection.providerId;
      providerState.selectedModelId = resolvedModelId;
      providerState.selectedReasoningEffort = selection.reasoningEffort ?? null;
      emitProviderStoreUpdate(previousState);

      return {
        providerId: selection.providerId,
        modelId: resolvedModelId,
        reasoningEffort: selection.reasoningEffort ?? null,
      };
    }
  );

providerState.commitRestoredSelection = createCommitRestoredSelectionMock();

const emitProviderStoreUpdate = (previousState: typeof providerState) => {
  const nextState = cloneProviderState();
  providerStoreSubscribers.forEach((listener) => listener(nextState, previousState));
};

const useProviderStoreMock = {
  getState: () => providerState,
  setState: (patch: Partial<typeof providerState>) => {
    const previousState = cloneProviderState();
    Object.assign(providerState, patch);
    emitProviderStoreUpdate(previousState);
  },
  subscribe: (
    listener: (
      nextState: typeof providerState,
      previousState: typeof providerState,
    ) => void,
  ) => {
    providerStoreSubscribers.add(listener);
    return () => {
      providerStoreSubscribers.delete(listener);
    };
  },
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
  architectPlanSwitch: { ...appState.architectPlanSwitch },
  strategyMutationPreview: appState.strategyMutationPreview
    ? { ...appState.strategyMutationPreview }
    : appState.strategyMutationPreview,
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
  revertManualFeatureToDraft: mock(async (params: {
    taskId: string;
    title?: string | null;
    description?: string | null;
  }) => {
    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === params.taskId
        ? {
            ...task,
            title: params.title ?? 'New feature',
            description: params.description ?? '',
            draft: true,
            feature_slug: null,
            assigned_branch: '',
            branch_name: '',
            execution_targets: [],
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
  markTaskFailed: mock(async (taskId: string) => {
    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = taskStoreState.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'Failed',
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
  promoteTaskContextProjects: mock(async (taskId: string, projectIds: string[]) => {
    const promotedProjectIds = Array.from(new Set(projectIds));
    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = taskStoreState.tasks.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      const existingProjectIds = Array.isArray(task.project_ids) ? task.project_ids : [];
      const existingContextProjectIds = Array.isArray(task.context_project_ids)
        ? task.context_project_ids
        : [];
      const existingExecutionTargets = Array.isArray(task.execution_targets)
        ? task.execution_targets
        : [];
      const existingTargetProjectIds = new Set(
        existingExecutionTargets
          .map((target) =>
            target && typeof target === 'object' && 'projectId' in target
              ? (target as { projectId?: unknown }).projectId
              : null
          )
          .filter((projectId): projectId is string => typeof projectId === 'string' && projectId.length > 0)
      );
      return {
        ...task,
        status: 'InProgress',
        project_ids: Array.from(new Set([...existingProjectIds, ...promotedProjectIds])),
        context_project_ids: existingContextProjectIds.filter(
          (projectId) => !promotedProjectIds.includes(projectId)
        ),
        execution_targets: [
          ...existingExecutionTargets,
          ...promotedProjectIds
            .filter((projectId) => !existingTargetProjectIds.has(projectId))
            .map((projectId) => ({
              projectId,
              branchName: 'feature/implement-checkout',
              worktreeKey: `task-1-${projectId}`,
            })),
        ],
      };
    });
    emitTaskStoreUpdate(previousTasks);
    return {
      task: taskStoreState.getTaskById(taskId),
      promotedProjectIds,
    };
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
  provider_id?: string | null;
  model_id?: string | null;
  reasoning_effort?: string | null;
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
type ArchitectPlanConversationSyncRecord = {
  conversation_id: string;
  plan_id: string;
  target_branch: string;
  transcript_revision: string | null;
  message_count: number;
  updated_at: string;
};
const architectPlanConversationSyncRecords = new Map<
  string,
  ArchitectPlanConversationSyncRecord
>();

const getArchitectPlanChatMessagesMock = mock(
  async (_branchName: string, planId: string) => architectPlanMessages.get(planId) ?? []
);
const getArchitectPlanChatTranscriptMock = mock(
  async (_branchName: string, planId: string) => {
    const messages = architectPlanMessages.get(planId) ?? [];
    return {
      messages,
      transcriptRevision: messages.length > 0 ? `test-revision-${planId}` : null,
      messageCount: messages.length,
    };
  }
);
const getArchitectPlanMock = mock(async (_branchName: string, planId: string) => architectPlans.get(planId) ?? null);
const getArchitectPlanActivationPayloadMock = mock(
  async (branchName: string, planId: string) => {
    const plan = architectPlans.get(planId);
    if (!plan || plan.status === 'deleted') {
      return null;
    }

    const conversationId = plan.conversationId ?? null;
    return {
      plan,
      chatMessages: architectPlanMessages.get(planId) ?? [],
      conversationId,
      sharedConversation: Boolean(
        conversationId &&
          Array.from(architectPlans.values()).some(
            (candidate) =>
              candidate.id !== planId &&
              candidate.status !== 'deleted' &&
              candidate.conversationId === conversationId
          )
      ),
      targetBranch: branchName,
      resolutionMode:
        plan.status === 'draft' &&
        plan.nodes.length === 0 &&
        plan.predictedBranches.length === 0 &&
        (architectPlanMessages.get(planId)?.length ?? 0) === 0
          ? 'blank_fast_path'
          : 'full',
    };
  }
);
const listArchitectPlansMock = mock(async (_branchName: string) => ({
  activePlanId: appState.activeArchitectPlanId,
  plans: Array.from(architectPlans.values()),
}));
const bindArchitectPlanConversationMock = mock(async (params: {
  branchName: string;
  planId: string;
  conversationId: string;
}) => {
  const existing = architectPlans.get(params.planId);
  if (!existing) {
    throw new Error(`Unknown plan ${params.planId}`);
  }
  const updated = {
    ...existing,
    conversationId: params.conversationId,
    updatedAt: '2026-03-19T01:00:00.000Z',
  };
  architectPlans.set(params.planId, updated);
  return updated;
});
const updateArchitectPlanMock = mock(async (params: {
  branchName: string;
  planId: string;
  conversationId?: string;
  title?: string;
  label?: string;
  slug?: string;
  description?: string;
  status?: string;
  nodes?: Array<Record<string, unknown>>;
  predictedBranches?: Array<Record<string, unknown>>;
  projectId?: string;
  projectIds?: string[];
  targetBranchesByProjectId?: Record<string, string>;
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
    slug: params.slug ?? existing.slug,
    description: params.description ?? existing.description,
    status: (params.status as ArchitectPlanRecord['status'] | undefined) ?? existing.status,
    nodes: (params.nodes as ArchitectPlanRecord['nodes'] | undefined) ?? existing.nodes,
    predictedBranches:
      (params.predictedBranches as ArchitectPlanRecord['predictedBranches'] | undefined) ??
      existing.predictedBranches,
    projectId: params.projectId ?? existing.projectId,
    projectIds: params.projectIds ?? existing.projectIds,
    targetBranchesByProjectId:
      params.targetBranchesByProjectId ?? existing.targetBranchesByProjectId,
    updatedAt: '2026-03-19T01:00:00.000Z',
  };
  architectPlans.set(params.planId, updated);
  return updated;
});
type SendChatNonStreaming = typeof import('../services/streamingChat').sendChatNonStreaming;

const defaultSendChatNonStreamingImpl: SendChatNonStreaming = async () =>
  JSON.stringify({
    title: 'Checkout refresh',
    description: 'Refresh checkout state and cart recovery.',
  });
let sendChatNonStreamingImpl: SendChatNonStreaming = defaultSendChatNonStreamingImpl;
const sendChatNonStreamingOnceImpls: SendChatNonStreaming[] = [];
const resetSendChatNonStreamingImplementation = () => {
  sendChatNonStreamingImpl = defaultSendChatNonStreamingImpl;
  sendChatNonStreamingOnceImpls.length = 0;
};
const setSendChatNonStreamingImplementation = (
  implementation: SendChatNonStreaming,
) => {
  sendChatNonStreamingImpl = implementation;
};
const queueSendChatNonStreamingImplementation = (
  implementation: SendChatNonStreaming,
) => {
  sendChatNonStreamingOnceImpls.push(implementation);
};
const sendChatNonStreamingMock = mock((async (
  ...args: Parameters<SendChatNonStreaming>
) => {
  const implementation =
    sendChatNonStreamingOnceImpls.shift() ?? sendChatNonStreamingImpl;
  return implementation(...args);
}) as SendChatNonStreaming);
const streamChatMock = mock(async () => ({ usage: null }));
const executeWorkspaceToolMock = mock(async () => undefined);
const estimateChatCompletionSerializedPayloadTokensMock = mock(
  (params: { messages: unknown[] }) =>
    Math.max(1, Math.ceil(JSON.stringify(params.messages).length / 4))
);
const webSearchMock = mock(async (_query: string) => [
  {
    url: 'https://example.com/search-result',
    title: 'Search Result',
    snippet: 'Relevant search context.',
  },
]);
const fetchWebPageMock = mock(async (_url: string) => ({
  url: 'https://example.com/page',
  title: 'Fetched Page',
  snippet: 'Fetched snippet.',
  content: 'Fetched full page content.',
}));
const fsReadFileWithOptionsMock = mock(async (_params: {
  path: string;
  allowOutsideWorkspace?: boolean;
  workspacePath?: string | null;
}) => ({
  content: 'Workspace file body from disk.',
  language: 'typescript',
  is_binary: false,
  size: 30,
  encoding: 'utf-8',
}));
let streamingWebSearchConfig = {
  enableWebSearch: false,
  enableWebFetch: false,
  webSearchOptions: undefined as
    | {
        provider: 'tavily' | 'brave';
        tavilyApiKey?: string;
        braveApiKey?: string;
        maxResults?: number;
      }
    | undefined,
};
const getToolModePolicyMock = mock(async (mode: AppMode) => {
  if (mode === 'Chat') {
    return {
      allowed_tool_ids: [
        'question',
        'skill_activate',
        'skill_read_resource',
        'skill_run_script',
        'mark_source_passage',
        'read_sources',
        'edit_source_passage',
        'read_file',
        'web_search',
        'web_fetch',
      ],
      enforce_macro_only_writes: false,
    };
  }

  if (mode === 'Architect') {
    return {
      allowed_tool_ids: [
        'skill_activate',
        'skill_read_resource',
        'skill_run_script',
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
        'strategy_generate',
        'plan_list',
        'plan_get',
        'plan_update',
        'strategy_get',
        'strategy_update',
      ],
      enforce_macro_only_writes: true,
    };
  }

  return {
    allowed_tool_ids: [
      'skill_activate',
      'skill_read_resource',
      'skill_run_script',
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

const getLocalProjectContextStateMock = mock(
  async (
    _groupId: string
  ): Promise<{
    architectConversationId: string | null;
    implementConversationId: string | null;
    lastTaskId: string | null;
  }> => ({
    architectConversationId: 'project-architect-conversation',
    implementConversationId: null,
    lastTaskId: null,
  })
);
const syncArchitectPlanChatFromConversationMock = mock(async () => undefined);
const getChatSnapshotMock = mock(async () => ({
  conversations: chatSnapshotConversations,
  messages: chatSnapshotMessages,
}));
const getChatBootstrapSnapshotMock = mock(async (params?: {
  preloadConversationIds?: string[];
}) => {
  const preloadConversationIds = new Set(params?.preloadConversationIds ?? []);
  const preloadedMessages = chatSnapshotMessages.filter((message) =>
    preloadConversationIds.has(message.conversation_id)
  );
  return {
    conversations: chatSnapshotConversations,
    messages_by_conversation_id: preloadedMessages.reduce(
      (grouped, message) => {
        grouped[message.conversation_id] = [
          ...(grouped[message.conversation_id] ?? []),
          message,
        ];
        return grouped;
      },
      {} as Record<string, typeof chatSnapshotMessages>
    ),
  };
});
const listMessagesMock = mock(async (conversationId: string) =>
  chatSnapshotMessages.filter((message) => message.conversation_id === conversationId)
);
const dbGetArchitectPlanConversationSyncMock = mock(
  async (conversationId: string) =>
    architectPlanConversationSyncRecords.get(conversationId) ?? null
);
const dbGetArchitectPlanConversationSyncForPlanMock = mock(
  async (params: { planId: string; targetBranch: string }) =>
    Array.from(architectPlanConversationSyncRecords.values()).find(
      (record) =>
        record.plan_id === params.planId &&
        record.target_branch === params.targetBranch
    ) ?? null
);
const dbUpsertArchitectPlanConversationSyncMock = mock(
  async (input: {
    conversation_id: string;
    plan_id: string;
    target_branch: string;
    transcript_revision?: string | null;
    message_count: number;
  }) => {
    const record = {
      conversation_id: input.conversation_id,
      plan_id: input.plan_id,
      target_branch: input.target_branch,
      transcript_revision: input.transcript_revision ?? null,
      message_count: input.message_count,
      updated_at: '2026-03-19T00:00:00.000Z',
    };
    architectPlanConversationSyncRecords.set(input.conversation_id, record);
    return record;
  }
);
const dbDeleteArchitectPlanConversationSyncMock = mock(async (conversationId: string) => {
  architectPlanConversationSyncRecords.delete(conversationId);
});
const updateConversationDetailsMock = mock(async () => undefined);
const gitBranchListMock = mock(async (repoPath: string) => (
  gitBranchesByRepo[repoPath] ?? { local: [], remote: [], current: null }
));
const dbGetConversationCompactionStateMock = mock(async () => null);
const dbUpsertConversationCompactionStateMock = mock(async () => undefined);
const toolboxStateByConversationId = new Map<
  string,
  {
    conversation_id: string;
    composer_context_refs_json: string;
    created_at: string;
    updated_at: string;
  }
>();
const getConversationToolboxStateMock = mock(async (conversationId: string) =>
  toolboxStateByConversationId.get(conversationId) ?? null
);
const upsertConversationToolboxStateMock = mock(async (input: {
  conversation_id: string;
  composer_context_refs_json: string;
  timestamp?: string | null;
}) => {
  const previous = toolboxStateByConversationId.get(input.conversation_id);
  const timestamp = input.timestamp ?? '2026-03-19T00:00:00.000Z';
  const record = {
    conversation_id: input.conversation_id,
    composer_context_refs_json: input.composer_context_refs_json,
    created_at: previous?.created_at ?? timestamp,
    updated_at: timestamp,
  };
  toolboxStateByConversationId.set(input.conversation_id, record);
  return record;
});
const deleteConversationToolboxStateMock = mock(async (conversationId: string) => {
  toolboxStateByConversationId.delete(conversationId);
});
const createDbConversationCompactionState = (
  overrides: Record<string, unknown> = {},
) => ({
  conversation_id: 'chat-conv',
  up_to_message_id: 'a1',
  summary_text: 'Previous persisted compacted summary.',
  tool_digest_json: '[]',
  used_source_passage_ids_json: '[]',
  interesting_source_passage_ids_json: '[]',
  estimated_tokens_before: 4200,
  estimated_tokens_after: 900,
  fingerprint: 'fp',
  version: 1,
  pruned_tool_context_message_ids_json: '["a1"]',
  reserved_tokens: 1200,
  footprint_before_json: null,
  footprint_after_json: JSON.stringify({
    totalEstimatedTokens: 900,
    messageTokens: 700,
    hiddenContextTokens: 0,
    systemTokens: 120,
    toolSchemaTokens: 80,
    imagePlaceholderTokens: 0,
    citationTokens: 0,
    modelContextWindowTokens: 8000,
    reservedTokens: 1200,
    usableContextTokens: 6800,
    threshold: 'none',
    reason: 'below_threshold',
    totalContextRatio: 0.11,
    usableContextRatio: 0.13,
    hiddenContextRatio: 0,
    hardStopRatio: 0.98,
    isHardStop: false,
    toolTurnCount: 0,
  }),
  degraded_reason: null,
  compaction_kind: 'manual',
  compaction_pass: 'ultra',
  summary_format_version: 3,
  summary_source: 'model',
  created_at: '2026-04-14T10:00:00.000Z',
  updated_at: '2026-04-14T10:05:00.000Z',
  ...overrides,
});
const updateConversationAISelectionMock = mock(async () => undefined);
let dbConversationCounter = 0;
let dbMessageCounter = 0;
const createConversationMock = mock(async (params?: {
  title?: string;
  scopeMode?: AppMode;
  taskId?: string | null;
  groupId?: string | null;
  projectId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
}) => ({
  id: `db-conversation-${++dbConversationCounter}`,
  title: params?.title ?? 'New Conversation',
  description: '',
  scope_mode: params?.scopeMode ?? 'Chat',
  task_id: params?.taskId ?? null,
  group_id: params?.groupId ?? null,
  project_id: params?.projectId ?? null,
  provider_id: params?.providerId ?? null,
  model_id: params?.modelId ?? null,
  reasoning_effort: params?.reasoningEffort ?? null,
  created_at: '2026-03-19T00:00:00.000Z',
  last_message: '',
  message_count: 0,
  updated_at: '2026-03-19T00:00:00.000Z',
  is_pinned: false,
}));
const createMessageMock = mock(
  async (
    conversationId: string,
    role: 'user' | 'assistant',
	    content: string,
	    options?: {
	      id?: string;
	      turnId?: string | null;
	      toolTraces?: unknown[];
	      hiddenContext?: string;
	      providerInputItems?: unknown[];
	      providerTurnState?: unknown;
	      contextRefs?: unknown[];
	    }
	  ) => ({
	    id: options?.id ?? `db-message-${++dbMessageCounter}`,
	    conversation_id: conversationId,
	    turn_id: options?.turnId ?? null,
	    role,
	    content,
	    created_at: '2026-03-19T00:00:00.000Z',
	    tool_traces_json: options?.toolTraces ? JSON.stringify(options.toolTraces) : null,
	    hidden_context: options?.hiddenContext ?? null,
	    provider_input_items_json: options?.providerInputItems
	      ? JSON.stringify(options.providerInputItems)
	      : null,
	    provider_turn_state_json: options?.providerTurnState
	      ? JSON.stringify(options.providerTurnState)
	      : null,
	    context_refs_json: options?.contextRefs
	      ? JSON.stringify(options.contextRefs)
	      : null,
	  })
	);
const deleteConversationMock = mock(async (_conversationId: string) => undefined);
const deleteConversationsMock = mock(async (_conversationIds: string[]) => undefined);
const updateConversationScopeMock = mock(async () => undefined);
const updateMessageMock = mock(
  async (
    _id?: string,
    _content?: string,
    _options?: {
      turnId?: string | null;
      tokenCount?: number;
      toolTraces?: unknown[];
	          hiddenContext?: string;
	          providerInputItems?: unknown[];
	          providerTurnState?: unknown;
	          contextRefs?: unknown[];
	        }
  ) => undefined
);
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
const terminalCreateSessionFromChatMock = mock(
  async ({ projectId, cwd }: { projectId: string; cwd?: string | null }) => ({
    id: `session-${projectId}`,
    project_id: projectId,
    project_name: projectId === 'project-2' ? 'API' : 'Web',
    mount_name: projectId === 'project-2' ? 'api' : 'web',
    workspace_path: projectId === 'project-2' ? 'C:/repos/api' : 'C:/repos/web',
    cwd:
      cwd ??
      (projectId === 'project-2'
        ? 'C:/repos/api/.macro/worktrees/task-1'
        : 'C:/repos/web/.macro/worktrees/task-1'),
    status: 'idle',
    last_command: null,
    output: '',
    exit_code: null,
    timed_out: false,
    updated_at: '2026-03-26T10:00:00.000Z',
  })
);
const terminalRunCommandFromChatMock = mock(
  async ({
    sessionId,
    command,
    timeoutMs,
  }: {
    sessionId: string;
    command: string;
    timeoutMs?: number | null;
  }) => ({
    id: sessionId,
    command,
    timeout_ms: timeoutMs ?? null,
    status: 'idle',
    output: '',
    exit_code: null,
    timed_out: false,
    updated_at: '2026-03-26T10:00:00.000Z',
  })
);

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
        clearCitations: () => {
          citationRecords = [];
        },
        citations: citationRecords,
        hydrateConversationCitations: async () => undefined,
        ensureCitationContentLoaded: ensureCitationContentLoadedMock,
        ensureConversationCitationContentsLoaded: async (
          conversationId: string,
          filter?: (citation: TestCitation) => boolean,
        ) =>
          citationRecords.filter(
            (citation) =>
              citation.conversationId === conversationId &&
              (!filter || filter(citation)),
          ),
        addCitation: (citation: Omit<TestCitation, 'id' | 'timestamp'>) => {
          const id = createCitationId();
          citationRecords.push({
            ...citation,
            id,
            timestamp: new Date().toISOString(),
          });
          return id;
        },
        addSourcePassage: (payload: {
          conversationId: string;
          messageId: string;
          title: string;
          passage: string;
          source?: string;
          url?: string;
          kind?: 'interesting' | 'used';
          reason?: string;
        }) => {
          const id = createCitationId();
          citationRecords.push({
            id,
            type: 'source_passage',
            scope: 'source',
            source: payload.source || payload.url || payload.title,
            title: payload.title.trim(),
            snippet: payload.passage.trim(),
            content: payload.passage.trim(),
            messageId: payload.messageId,
            conversationId: payload.conversationId,
            timestamp: new Date().toISOString(),
            url: payload.url,
            kind: payload.kind || 'used',
            reason: payload.reason,
          });
          return id;
        },
        addWebCitations: (
          results: Array<{ url: string; title: string; snippet: string }>,
          messageId: string,
          conversationId: string,
        ) => {
          results.forEach((result) => {
            citationRecords.push({
              id: createCitationId(),
              type: 'web',
              scope: 'context',
              source: result.url,
              title: result.title,
              snippet: result.snippet,
              messageId,
              conversationId,
              timestamp: new Date().toISOString(),
              url: result.url,
            });
          });
        },
        updateSourcePassage: (payload: {
          conversationId: string;
          citationId: string;
          title?: string;
          passage?: string;
          source?: string;
          url?: string;
          kind?: 'interesting' | 'used';
          reason?: string | null;
        }) => {
          const citation = citationRecords.find(
            (candidate) =>
              candidate.id === payload.citationId &&
              candidate.conversationId === payload.conversationId &&
              candidate.scope === 'source',
          );
          if (!citation) return false;
          if (payload.title !== undefined) citation.title = payload.title.trim();
          if (payload.passage !== undefined) {
            citation.snippet = payload.passage.trim();
            citation.content = payload.passage.trim();
          }
          if (payload.source !== undefined) citation.source = payload.source.trim();
          if (payload.url !== undefined) citation.url = payload.url.trim();
          if (payload.kind) citation.kind = payload.kind;
          if (payload.reason !== undefined) {
            citation.reason = payload.reason === null ? undefined : payload.reason.trim();
          }
          citation.timestamp = new Date().toISOString();
          return true;
        },
        removeCitation: (id: string) => {
          citationRecords = citationRecords.filter((citation) => citation.id !== id);
        },
        clearConversationCitations: (conversationId: string) => {
          citationRecords = citationRecords.filter(
            (citation) => citation.conversationId !== conversationId,
          );
        },
        clearConversationCitationsBulk: (conversationIds: string[]) => {
          const ids = new Set(conversationIds);
          citationRecords = citationRecords.filter(
            (citation) => !ids.has(citation.conversationId),
          );
        },
        getConversationCitations: (conversationId: string) =>
          citationRecords.filter(
            (citation) => citation.conversationId === conversationId,
          ),
        getConversationContextCitations: (conversationId: string) =>
          citationRecords.filter(
            (citation) =>
              citation.conversationId === conversationId &&
              citation.scope === 'context',
          ),
        getConversationSourceCitations: (conversationId: string) =>
          sortSourceCitations(
            citationRecords.filter(
              (citation) =>
                citation.conversationId === conversationId &&
                citation.scope === 'source',
            ),
          ),
        pruneConversationSourceCitations: (conversationId: string, keepMessageIds: string[]) => {
          const keepSet = new Set(keepMessageIds);
          citationRecords = citationRecords.filter(
            (citation) =>
              citation.conversationId !== conversationId ||
              citation.scope !== 'source' ||
              keepSet.has(citation.messageId),
          );
        },
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
    getTaskLifecycleCapabilities: (task: { draft?: boolean; status?: string }, published = false) => ({
      isPublished: published,
      canRename: true,
      canDelete: !published,
      canArchive: !task.draft,
      canRestore: false,
      canReopen: task.status === 'Completed',
      deleteBlockReason: published
        ? 'This feature branch has already been pushed. Archive it instead.'
        : null,
    }),
    getPlanActivationCandidateTask: () => null,
    useTaskStore: useTaskStoreMock,
  }));

  mock.module('./useTerminalStore', () => ({
    useTerminalStore: {
      getState: () => ({
        addTerminalLine: () => undefined,
        createSession: terminalCreateSessionFromChatMock,
        runCommand: terminalRunCommandFromChatMock,
      }),
    },
  }));

  mock.module('../services/streamingChat', () => ({
    streamChat: streamChatMock,
    cancelStream: mock(() => undefined),
    sendChatNonStreaming: sendChatNonStreamingMock,
    estimateCopilotSerializedPayloadTokens: estimateChatCompletionSerializedPayloadTokensMock,
    estimateChatCompletionSerializedPayloadTokens: estimateChatCompletionSerializedPayloadTokensMock,
  }));

  mock.module('../services/webSearchSettings', () => ({
    WEB_SEARCH_SETTINGS_KEY: 'macro_web_search_settings',
    DEFAULT_WEB_SEARCH_SETTINGS: {
      tavilyApiKey: '',
      braveApiKey: '',
      provider: 'tavily',
      enabled: true,
      fetchEnabled: true,
    },
    getWebSearchSettings: () => ({
      tavilyApiKey: '',
      braveApiKey: '',
      provider: 'tavily',
      enabled: true,
      fetchEnabled: true,
    }),
    saveWebSearchSettings: mock(() => undefined),
    getStreamingWebSearchConfig: () => streamingWebSearchConfig,
  }));

  mock.module('../services/webSearch', () => ({
    webSearch: webSearchMock,
    fetchWebPage: fetchWebPageMock,
    extractDomain: (url: string) => new URL(url).hostname,
    getFaviconUrl: (url: string) => `${url}/favicon.ico`,
    formatSearchResultsAsContext: (results: Array<{ url: string; title: string; snippet: string }>) =>
      results
        .map((result, index) => `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.snippet}`)
        .join('\n\n'),
  }));

  mock.module('../services/workspaceToolExecutor', () => ({
    executeWorkspaceTool: executeWorkspaceToolMock,
    resolveExplicitMutatingToolProjectTargets: mock((toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'terminal_create_session' && typeof args.project_id === 'string') {
        return [args.project_id];
      }
      if (typeof args.project_id === 'string') {
        return [args.project_id];
      }
      return [];
    }),
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
    createConversation: createConversationMock,
    createMessage: createMessageMock,
    dbGetConversationCompactionState: dbGetConversationCompactionStateMock,
    dbUpsertConversationCompactionState: dbUpsertConversationCompactionStateMock,
    getConversationToolboxState: getConversationToolboxStateMock,
    upsertConversationToolboxState: upsertConversationToolboxStateMock,
    deleteConversationToolboxState: deleteConversationToolboxStateMock,
    deleteConversation: deleteConversationMock,
    deleteConversations: deleteConversationsMock,
    gitBranchList: gitBranchListMock,
    getChatBootstrapSnapshot: getChatBootstrapSnapshotMock,
    getChatSnapshot: getChatSnapshotMock,
    importMessages: importMessagesMock,
    listMessages: listMessagesMock,
    dbGetArchitectPlanConversationSync: dbGetArchitectPlanConversationSyncMock,
    dbGetArchitectPlanConversationSyncForPlan:
      dbGetArchitectPlanConversationSyncForPlanMock,
    dbUpsertArchitectPlanConversationSync: dbUpsertArchitectPlanConversationSyncMock,
	    dbDeleteArchitectPlanConversationSync: dbDeleteArchitectPlanConversationSyncMock,
	    getToolModePolicy: getToolModePolicyMock,
	    skillsGet: async ({ skillId }: { skillId: string }) => {
	      const { useSkillsStore } = await import('./useSkillsStore');
	      const skill = useSkillsStore.getState().getSkillById(skillId) ?? createSkillManifest({ id: skillId });
	      return {
	        skill,
	        body: '# Instructions\nUse loaded skill body.',
	      };
	    },
	    skillsList: async () => ({ skills: [] }),
	    skillsReadResource: async ({ skillId, resourcePath }: { skillId: string; resourcePath: string }) => ({
	      skillId,
	      path: resourcePath,
	      content: 'resource content',
	    }),
    skillsRunScript: async ({ skillId, scriptPath }: { skillId: string; scriptPath: string }) => ({
	      skillId,
	      scriptPath,
	      stdout: 'script result',
	      stderr: '',
	      exitCode: 0,
	      timedOut: false,
	      truncated: false,
	    }),
    fsReadFileWithOptions: fsReadFileWithOptionsMock,
	    updateMessage: updateMessageMock,
    deleteMessagesAfter: deleteMessagesAfterMock,
    updateConversationDetails: updateConversationDetailsMock,
    updateConversationAISelection: updateConversationAISelectionMock,
    updateConversationScope: updateConversationScopeMock,
  }));

  importCounter += 1;
  const actualArchitectPlanService = await import(
    `../services/architectPlanService.ts?use-chat-store-architect-plan-service-test=${importCounter}`
  );

  const architectPlanServiceModule = () => ({
    ...actualArchitectPlanService,
    bindArchitectPlanConversation: bindArchitectPlanConversationMock,
    createArchitectPlan: mock(async () => {
      throw new Error('not implemented');
    }),
    deleteArchitectPlan: mock(async () => undefined),
    getArchitectPlanActivationPayload: getArchitectPlanActivationPayloadMock,
    getArchitectPlan: getArchitectPlanMock,
    getArchitectPlanChatMessages: getArchitectPlanChatMessagesMock,
    getArchitectPlanChatTranscript: getArchitectPlanChatTranscriptMock,
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
    listArchitectPlans: listArchitectPlansMock,
    resolvePlanProjectContextId: (plan: ArchitectPlanRecord, fallbackProjectId?: string | null) =>
      plan.projectId ?? plan.projectIds?.[0] ?? fallbackProjectId ?? null,
    restoreArchitectPlan: mock(async () => undefined),
    setActiveArchitectPlan: mock(async () => undefined),
    syncArchitectPlanChatFromConversation: syncArchitectPlanChatFromConversationMock,
    toPlanIntegrationBranch: (planId: string) => `plan/${planId}`,
    toPlanScopedFeatureBranch: (planId: string, featureSlug: string) => `feature/${planId}/${featureSlug}`,
    updateArchitectPlan: updateArchitectPlanMock,
  });
  mock.module('../services/architectPlanService', architectPlanServiceModule);
  mock.module('../services/architectPlanService.ts', architectPlanServiceModule);

  const localProjectContextModule = () => ({
    getLocalProjectContextState: getLocalProjectContextStateMock,
    getLocalSessionContextState: async () => null,
    getProjectSwitchPolicy: async () => 'resume_per_project',
    reconcileLocalProjectRegistryState: async () => undefined,
    setProjectSwitchPolicy: async () => undefined,
    upsertLocalProjectContextState: async () => null,
    upsertLocalSessionContextState: async () => null,
  });
  mock.module('../services/localProjectContext', localProjectContextModule);
  mock.module('../services/localProjectContext.ts', localProjectContextModule);

  mock.module('../services/macroSyncService', () => ({
    syncMacroMetadataAfterStream: mock(async () => undefined),
  }));

  mock.module('../services/projectExecutionContext', () => ({
    resolveProjectExecutionContext: mock(() => ({
      groupName: 'Macro',
      groupId: 'group-1',
      projectName: 'Web',
      projectId: 'project-1',
      focusedProjectId: 'project-1',
      projectIds: ['project-1'],
      actionableProjectIds: ['project-1'],
      contextProjectIds: [],
      taskId: null,
      branchName: 'develop',
      workspacePath: 'C:/repos/web',
      defaultWorkspacePath: 'C:/repos/web/.macro/worktrees/task-1',
      workspacePathsByProjectId: {
        'project-1': 'C:/repos/web/.macro/worktrees/task-1',
      },
      virtualRootEnabled: false,
      projectMounts: [],
    })),
  }));

};

const loadChatStore = async () => {
  importCounter += 1;
  return import(`./useChatStore.ts?test=${importCounter}`);
};

const waitForToolboxPersistence = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadAiSelectionsPreference = async () => {
  const preferences = await import('../services/preferences');
  return preferences.loadPreference(preferences.PREF_KEYS.AI_CONTEXT_SELECTIONS);
};

const saveAiSelectionsPreference = async (value: unknown) => {
  const preferences = await import('../services/preferences');
  await preferences.savePreference(preferences.PREF_KEYS.AI_CONTEXT_SELECTIONS, value);
};

const createConversation = (id: string, projectId = 'project-1'): Conversation => ({
  id,
  title: `Conversation ${id}`,
  description: '',
  scope_mode: projectId ? 'Architect' : 'Chat',
  task_id: null,
  group_id: 'group-1',
  project_id: projectId,
  provider_id: null,
  model_id: null,
  reasoning_effort: null,
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
  provider_id: overrides.provider_id ?? null,
  model_id: overrides.model_id ?? null,
  reasoning_effort: overrides.reasoning_effort ?? null,
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

const activateArchitectPlanForTest = (
  overrides: Partial<ArchitectPlanRecord> = {}
): ArchitectPlanRecord => {
  const plan = createScenarioPlan('started', overrides);
  architectPlans.set(plan.id, plan);
  appState.activeArchitectPlanId = plan.id;
  appState.activePlanContext = {
    id: plan.id,
    targetBranch: plan.targetBranch,
  };
  return plan;
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

const createImplementStoreState = (params: {
  conversationId: string;
  taskId: string;
  title?: string;
}) =>
  createIdleChatStoreState({
    conversations: [
      {
        ...createConversation(params.conversationId),
        scope_mode: 'Implement',
        task_id: params.taskId,
        title: params.title ?? 'Task - Implement checkout',
      },
    ],
    messages: [],
    selectedConversationId: params.conversationId,
    selectedConversationIdsByMode: { Implement: params.conversationId },
    sendState: 'idle',
  });

const setImplementStoreState = (
  useChatStore: { setState: (state: Record<string, unknown>) => void },
  params: Parameters<typeof createImplementStoreState>[0]
) => {
  useChatStore.setState(createImplementStoreState(params));
};

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createDeferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
};

const getLatestStreamOptions = <T extends Record<string, unknown> = Record<string, unknown>>() => {
  const lastCall = ((streamChatMock as unknown as {
    mock: { calls: Array<Array<unknown>> };
  }).mock.calls.at(-1)?.[0] ?? null) as T | null;
  expect(lastCall).not.toBeNull();
  if (!lastCall) {
    throw new Error('Expected streamChat options');
  }
  return lastCall;
};

const waitForStreamCallCount = async (expectedCallCount: number) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const callCount = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls.length);
    if (callCount >= expectedCallCount) {
      return;
    }
    await flushAsyncWork();
  }

  expect(
    ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls.length),
  ).toBeGreaterThanOrEqual(expectedCallCount);
};

const waitForConversationDiagnostics = async (
  useChatStore: Awaited<ReturnType<typeof loadChatStore>>['useChatStore'],
  conversationId: string,
) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const diagnostics =
      useChatStore.getState().contextDiagnosticsByConversationId[conversationId];
    if (diagnostics?.status === 'ready' || diagnostics?.status === 'error') {
      return diagnostics;
    }
    await flushAsyncWork();
  }
  return useChatStore.getState().contextDiagnosticsByConversationId[conversationId];
};

const getLatestArchitectToolHandler = () => {
  const lastCall = getLatestStreamOptions<{
    onToolCall?: (
      toolName: string,
      args: Record<string, unknown>,
      toolCallId?: string
    ) => Promise<unknown>;
  }>();
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
  localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
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

const createSkillManifest = (
  overrides: Partial<SkillManifest> = {},
): SkillManifest => ({
  id: 'global:agents:test-skill:aaa111',
  name: 'test-skill',
  description: 'Skill de test pour vérifier l’activation dans Macro.',
  rootPath: '/Users/test/.agents/skills/test-skill',
  skillFilePath: '/Users/test/.agents/skills/test-skill/SKILL.md',
  source: {
    kind: 'global',
    namespace: 'agents',
    projectId: null,
    projectName: null,
    rootPath: '/Users/test/.agents/skills',
    skillRootPath: '/Users/test/.agents/skills',
  },
  resources: [{ path: 'references/style.md', kind: 'reference', sizeBytes: 120 }],
  scripts: [{ path: 'scripts/check.sh', kind: 'script', sizeBytes: 80 }],
  validationErrors: [],
  isValid: true,
  ...overrides,
});

const installSkillActivationMock = (
  useSkillsStore: typeof import('./useSkillsStore')['useSkillsStore'],
) => {
  const activateSkill = mock(async (skillId: string, conversationId?: string) => {
    const skill = useSkillsStore.getState().getSkillById(skillId);
    if (conversationId) {
      useSkillsStore.setState((state) => ({
        activationsByConversationId: {
          ...state.activationsByConversationId,
          [conversationId]: [
            ...(state.activationsByConversationId[conversationId] ?? []),
            {
              skillId,
              activatedAt: '2026-03-19T00:00:00.000Z',
              body: '# Instructions\nUse loaded skill body.',
            },
          ],
        },
      }));
    }
    return [
      `<skill_content name="${skill?.name ?? skillId}" id="${skillId}">`,
      `# Skill: ${skill?.name ?? skillId}`,
      '',
      '## Instructions',
      '# Instructions',
      'Use loaded skill body.',
      '</skill_content>',
    ].join('\n');
  });
  useSkillsStore.setState({ activateSkill });
  return activateSkill;
};

const startImplementToolConversation = async (
  content = 'Travaille sur cette tâche.',
  options: { agentType?: AgentType } = {},
) => {
  providerState.selectedSupportsNativeToolCalling = () => true;
  appState.mode = 'Implement';
  appState.agentType = options.agentType ?? 'build';
  appState.selectedTaskId = 'task-1';
  localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
  taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

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
    content,
    taskId: 'task-1',
  });

  return {
    useChatStore,
    onToolCall: getLatestArchitectToolHandler(),
  };
};

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
    appState.architectPlanSwitch = {
      requestId: 0,
      targetPlanId: null,
      targetBranch: null,
      status: 'idle',
      startedAt: null,
      summaryHint: null,
      errorMessage: null,
    };
    appState.pendingArchitectPlanActivationPayload = null;
    appState.strategyMutationPreview = null;
    const { useSkillsStore } = await import('./useSkillsStore');
    useSkillsStore.setState({
      skills: [],
      settingsBySkillId: {},
      activationsByConversationId: {},
      isLoading: false,
      saving: false,
      lastError: null,
    });

    toolsStoreState.internalTools = Object.fromEntries(
      ALL_INTERNAL_TOOL_IDS.map((toolId) => [toolId, { id: toolId }])
    ) as Record<string, { id: string }>;
    toolsStoreState.lastError = null;
    toolsStoreState.loadSettings.mockClear();

    providerState.providerConfigs = DEFAULT_PROVIDER_CONFIGS.map((provider) => ({ ...provider }));
    providerState.modelsByProvider = Object.fromEntries(
      Object.entries(DEFAULT_MODELS_BY_PROVIDER).map(([providerId, models]) => [
        providerId,
        models.map((model) => ({ ...model })),
      ]),
    ) as Record<string, Array<{ id: string; name: string; isEnabled: boolean }>>;
    providerState.selectedProviderId = 'provider-1';
    providerState.selectedModelId = 'model-1';
    providerState.selectedReasoningEffort = null;
    providerState.selectedSupportsNativeToolCalling = () => false;
    providerState.commitRestoredSelection = createCommitRestoredSelectionMock();
    providerState.loadProviderModels.mockClear();
    providerState.scanModelsForProvider.mockClear();
    providerState.markProviderReachable.mockClear();
    providerState.selectModel.mockClear();
    providerState.selectProvider.mockClear();
    providerState.selectReasoningEffort.mockClear();
    providerStoreSubscribers.clear();

    architectPlans.clear();
    architectPlanMessages.clear();
    architectPlanConversationSyncRecords.clear();
    gitBranchesByRepo = {};
    taskStoreState.tasks = [];
    taskStoreState.currentTask = null;
    taskStoreSubscribers.clear();
    appStoreSubscribers.clear();
    taskStoreState.lastError = null;
    taskStoreState.refreshFromPlan.mockClear();
    taskStoreState.clearPlanRuntimeState.mockClear();
    taskStoreState.finalizeManualFeatureDraft.mockClear();
    taskStoreState.revertManualFeatureToDraft.mockClear();
    taskStoreState.startTask.mockClear();
    taskStoreState.markTaskAwaitingResponse.mockClear();
    taskStoreState.markTaskFailed.mockClear();
    taskStoreState.retryTask.mockClear();
    taskStoreState.promoteTaskContextProjects.mockClear();
    taskStoreState.deleteManualFeatureDraft.mockClear();
    citationCounter = 0;
    citationRecords = [];
    ensureCitationContentLoadedMock.mockClear();
    ensureCitationContentLoadedMock.mockImplementation(async (id: string) =>
      citationRecords.find((citation) => citation.id === id) ?? null
    );
    tauriAvailable = false;
    dbConversationCounter = 0;
    dbMessageCounter = 0;
    chatSnapshotConversations = [];
    chatSnapshotMessages = [];
    getArchitectPlanActivationPayloadMock.mockClear();
    getArchitectPlanChatMessagesMock.mockClear();
    getArchitectPlanChatTranscriptMock.mockClear();
    getArchitectPlanMock.mockClear();
    bindArchitectPlanConversationMock.mockClear();
    listArchitectPlansMock.mockClear();
    updateArchitectPlanMock.mockClear();
    streamChatMock.mockClear();
    executeWorkspaceToolMock.mockClear();
    sendChatNonStreamingMock.mockClear();
    webSearchMock.mockClear();
    fetchWebPageMock.mockClear();
    fsReadFileWithOptionsMock.mockClear();
    streamingWebSearchConfig = {
      enableWebSearch: false,
      enableWebFetch: false,
      webSearchOptions: undefined,
    };
    getToolModePolicyMock.mockClear();
    getLocalProjectContextStateMock.mockClear();
    syncArchitectPlanChatFromConversationMock.mockClear();
    getChatSnapshotMock.mockClear();
    getChatBootstrapSnapshotMock.mockClear();
    listMessagesMock.mockClear();
    dbGetArchitectPlanConversationSyncMock.mockClear();
    dbGetArchitectPlanConversationSyncForPlanMock.mockClear();
    dbUpsertArchitectPlanConversationSyncMock.mockClear();
    dbDeleteArchitectPlanConversationSyncMock.mockClear();
    updateConversationDetailsMock.mockClear();
    gitBranchListMock.mockClear();
    createConversationMock.mockClear();
    createMessageMock.mockClear();
    dbGetConversationCompactionStateMock.mockClear();
    dbUpsertConversationCompactionStateMock.mockClear();
    toolboxStateByConversationId.clear();
    getConversationToolboxStateMock.mockClear();
    getConversationToolboxStateMock.mockImplementation(async (conversationId: string) =>
      toolboxStateByConversationId.get(conversationId) ?? null
    );
    upsertConversationToolboxStateMock.mockClear();
    deleteConversationToolboxStateMock.mockClear();
    updateConversationAISelectionMock.mockClear();
    deleteConversationMock.mockClear();
    deleteConversationsMock.mockClear();
    updateConversationScopeMock.mockClear();
    updateMessageMock.mockClear();
    deleteMessagesAfterMock.mockClear();
    importMessagesMock.mockClear();
    terminalCreateSessionFromChatMock.mockClear();
    terminalRunCommandFromChatMock.mockClear();
    resetSendChatNonStreamingImplementation();
    toolsStoreState.loadSettings.mockClear();
    toolsStoreState.getEnabledChatToolIds = () => [
      'skill_activate',
      'skill_read_resource',
      'skill_run_script',
      'read_file',
      'web_search',
      'web_fetch',
      'question',
      'mark_source_passage',
      'read_sources',
      'edit_source_passage',
    ];
    toolsStoreState.getEnabledMCPToolIds = () => [];
    toolsStoreState.getEnabledMCPTools = () => [];
    toolsStoreState.getMCPToolById = () => null;
    toolsStoreState.callMCPTool.mockClear();
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

  it('keeps composer drafts isolated by context and migrates the temporary draft', async () => {
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({ composerDraftsByContextKey: {} }));

    const state = useChatStore.getState();
    state.saveComposerDraftForContext('context:temporary', {
      text: 'Temporary draft',
      images: [],
      contextRefs: [],
    });
    state.saveComposerDraftForContext('conversation:existing', {
      text: 'Existing draft',
      images: [],
      contextRefs: [],
    });

    expect(useChatStore.getState().getComposerDraftForContext('conversation:existing')?.text)
      .toBe('Existing draft');
    useChatStore.getState().migrateComposerDraftContext(
      'context:temporary',
      'conversation:created'
    );

    expect(useChatStore.getState().getComposerDraftForContext('context:temporary')).toBeNull();
    expect(useChatStore.getState().getComposerDraftForContext('conversation:created')?.text)
      .toBe('Temporary draft');
    expect(useChatStore.getState().getComposerDraftForContext('conversation:existing')?.text)
      .toBe('Existing draft');

    useChatStore.getState().clearComposerDraftForContext('conversation:created');
    expect(useChatStore.getState().getComposerDraftForContext('conversation:created')).toBeNull();
  });

  it('clears Architect conversation selection when no plan is selected', async () => {
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(
      createIdleChatStoreState({
        conversations: [createConversation('conv-a')],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        hydrationStatus: 'ready',
        restoreStatus: 'idle',
      }),
    );

    await useChatStore.getState().reapplySelectionForCurrentContext();

    expect(useChatStore.getState().selectedConversationId).toBeNull();
    expect(useChatStore.getState().selectedConversationIdsByMode.Architect).toBeNull();
    expect(useChatStore.getState().restoreStatus).toBe('ready');
    expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it('does not reuse remembered Architect conversations when no plan is selected', async () => {
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(
      createIdleChatStoreState({
        conversations: [createConversation('remembered-conv')],
        selectedConversationId: 'remembered-conv',
        selectedConversationIdsByMode: { Architect: 'remembered-conv' },
        hydrationStatus: 'ready',
        restoreStatus: 'ready',
      }),
    );

    const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();

    expect(ensuredId).toBeNull();
    expect(useChatStore.getState().selectedConversationId).toBeNull();
    expect(useChatStore.getState().selectedConversationIdsByMode.Architect).toBeNull();
    expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it('rejects Architect sends before creating messages when no plan is selected', async () => {
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(
      createIdleChatStoreState({
        conversations: [createConversation('stale-architect-conv')],
        selectedConversationId: 'stale-architect-conv',
        selectedConversationIdsByMode: { Architect: 'stale-architect-conv' },
        hydrationStatus: 'ready',
        restoreStatus: 'ready',
      }),
    );

    await expect(
      useChatStore.getState().sendMessage({
        conversationId: 'stale-architect-conv',
        content: 'Prépare un plan.',
      }),
    ).rejects.toThrow('Select a plan before sending an Architect message.');

    expect(createMessageMock).not.toHaveBeenCalled();
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().getConversationMessages('stale-architect-conv')).toHaveLength(0);
  });

  it('restores the provider, model, and thinking for the selected conversation', async () => {
    providerState.providerConfigs = [
      ...providerState.providerConfigs,
      {
        id: 'provider-2',
        name: 'Remote',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      },
    ];
    providerState.modelsByProvider = {
      'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
      'provider-2': [{ id: 'model-2a', name: 'Model 2A', isEnabled: true }],
    };

    await saveAiSelectionsPreference({
      version: 2,
      modeSelections: {
        Architect: {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
      },
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
        'conv-b': {
          providerId: 'provider-2',
          modelId: 'model-2a',
          reasoningEffort: 'high',
          updatedAt: '2026-03-19T00:01:00.000Z',
        },
      },
      providerSelectionsByConversationId: {
        'conv-a': {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        'conv-b': {
          'provider-2': {
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
      },
      providerSelectionsByMode: {
        Architect: {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'provider-2': {
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
      },
    });

    tauriAvailable = true;
    chatSnapshotConversations = [
      createChatSnapshotConversation('conv-a'),
      createChatSnapshotConversation('conv-b'),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a'), createConversation('conv-b')],
        selectedConversationId: 'conv-a',
        selectedConversationIdsByMode: { Architect: 'conv-a' },
      }),
    );

    await useChatStore.getState().reapplySelectionForCurrentContext();

    expect(providerState.selectedProviderId).toBe('provider-1');
    expect(providerState.selectedModelId).toBe('model-1a');
    expect(providerState.selectedReasoningEffort).toBe('low');

    await useChatStore.getState().selectConversation('conv-b');

    expect(useChatStore.getState().selectedConversationId).toBe('conv-b');
    expect(providerState.selectedProviderId).toBe('provider-2');
    expect(providerState.selectedModelId).toBe('model-2a');
    expect(providerState.selectedReasoningEffort).toBe('high');
  });

  it('restores persisted toolbox composer source refs after selecting a conversation', async () => {
    tauriAvailable = true;
    citationRecords = [
      {
        id: 'source-1',
        type: 'source_passage',
        scope: 'source',
        source: 'notes.md',
        title: 'Persisted source',
        snippet: 'Important passage',
        messageId: 'assistant-1',
        conversationId: 'conv-b',
        timestamp: '2026-03-19T00:00:00.000Z',
        kind: 'used',
      },
    ];
    toolboxStateByConversationId.set('conv-b', {
      conversation_id: 'conv-b',
      composer_context_refs_json: JSON.stringify([
        {
          id: 'source-1',
          kind: 'source',
          title: 'Persisted source',
          subtitle: 'notes.md',
          sourceLabel: 'notes.md',
          snippet: 'Important passage',
        },
      ]),
      created_at: '2026-03-19T00:00:00.000Z',
      updated_at: '2026-03-19T00:00:00.000Z',
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a'), createConversation('conv-b')],
        selectedConversationId: 'conv-a',
        selectedConversationIdsByMode: { Architect: 'conv-a' },
      }),
    );
    useChatStore.setState({ composerContextRefs: [] });

    await useChatStore.getState().selectConversation('conv-b');

    expect(getConversationToolboxStateMock).toHaveBeenCalledWith('conv-b');
    expect(useChatStore.getState().composerContextRefs).toEqual([
      expect.objectContaining({
        id: 'source-1',
        kind: 'source',
        title: 'Persisted source',
        subtitle: 'notes.md',
        data: expect.objectContaining({
          id: 'source-1',
          conversationId: 'conv-b',
        }),
      }),
    ]);
  });

  it('ignores removed legacy context kinds while hydrating a conversation', async () => {
    tauriAvailable = true;
    toolboxStateByConversationId.set('conv-b', {
      conversation_id: 'conv-b',
      composer_context_refs_json: JSON.stringify([
        {
          id: 'legacy-ref-1',
          kind: ['ne', 'ed'].join(''),
          title: 'Legacy structured reference',
        },
      ]),
      created_at: '2026-03-19T00:00:00.000Z',
      updated_at: '2026-03-19T00:00:00.000Z',
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a'), createConversation('conv-b')],
        selectedConversationId: 'conv-a',
        selectedConversationIdsByMode: { Architect: 'conv-a' },
      }),
    );

    await useChatStore.getState().selectConversation('conv-b');

    expect(useChatStore.getState().composerContextRefs).toEqual([]);
  });

  it('ignores stale toolbox hydration after a newer conversation switch wins', async () => {
    tauriAvailable = true;
    citationRecords = [
      {
        id: 'source-a',
        type: 'source_passage',
        scope: 'source',
        source: 'a.md',
        title: 'Source A',
        snippet: 'Passage A',
        messageId: 'assistant-a',
        conversationId: 'conv-a',
        timestamp: '2026-03-19T00:00:00.000Z',
        kind: 'used',
      },
      {
        id: 'source-b',
        type: 'source_passage',
        scope: 'source',
        source: 'b.md',
        title: 'Source B',
        snippet: 'Passage B',
        messageId: 'assistant-b',
        conversationId: 'conv-b',
        timestamp: '2026-03-19T00:01:00.000Z',
        kind: 'used',
      },
    ];
    const staleToolboxState = createDeferred<{
      conversation_id: string;
      composer_context_refs_json: string;
      created_at: string;
      updated_at: string;
    } | null>();
    getConversationToolboxStateMock.mockImplementation(async (conversationId: string) => {
      if (conversationId === 'conv-a') {
        return staleToolboxState.promise;
      }
      if (conversationId === 'conv-b') {
        return {
          conversation_id: 'conv-b',
          composer_context_refs_json: JSON.stringify([
            {
              id: 'source-b',
              kind: 'source',
              title: 'Source B',
              subtitle: 'b.md',
              sourceLabel: 'b.md',
              snippet: 'Passage B',
            },
          ]),
          created_at: '2026-03-19T00:00:00.000Z',
          updated_at: '2026-03-19T00:00:00.000Z',
        };
      }
      return null;
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a'), createConversation('conv-b')],
        selectedConversationId: 'conv-b',
        selectedConversationIdsByMode: { Architect: 'conv-b' },
      }),
    );
    useChatStore.setState({ composerContextRefs: [] });

    const staleSwitch = useChatStore.getState().selectConversation('conv-a');
    await Promise.resolve();
    await Promise.resolve();
    const winningSwitch = useChatStore.getState().selectConversation('conv-b');

    await winningSwitch;
    staleToolboxState.resolve({
      conversation_id: 'conv-a',
      composer_context_refs_json: JSON.stringify([
        {
          id: 'source-a',
          kind: 'source',
          title: 'Source A',
          subtitle: 'a.md',
          sourceLabel: 'a.md',
          snippet: 'Passage A',
        },
      ]),
      created_at: '2026-03-19T00:00:00.000Z',
      updated_at: '2026-03-19T00:00:00.000Z',
    });
    await staleSwitch;

    expect(useChatStore.getState().selectedConversationId).toBe('conv-b');
    expect(useChatStore.getState().composerContextRefs).toEqual([
      expect.objectContaining({
        id: 'source-b',
        kind: 'source',
        title: 'Source B',
      }),
    ]);
  });

  it('persists and deletes toolbox composer refs for the selected conversation', async () => {
    tauriAvailable = true;
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a')],
        selectedConversationId: 'conv-a',
        selectedConversationIdsByMode: { Architect: 'conv-a' },
      }),
    );
    useChatStore.setState({ composerContextRefs: [] });

    useChatStore.getState().addComposerContextRef({
      id: 'file-1',
      kind: 'file',
      title: 'README.md',
      subtitle: 'project-1',
      data: {
        id: 'file-1',
        path: 'README.md',
        relativePath: 'README.md',
        projectId: 'project-1',
        projectName: 'Project 1',
      },
    });
    await waitForToolboxPersistence();

    expect(upsertConversationToolboxStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'conv-a',
        composer_context_refs_json: expect.stringContaining('README.md'),
      }),
    );

    useChatStore.getState().clearComposerContextRefs();
    await waitForToolboxPersistence();

    expect(deleteConversationToolboxStateMock).toHaveBeenCalledWith('conv-a');
  });

  it('restores the conversation model from the database when preferences are empty', async () => {
    providerState.modelsByProvider = {
      'provider-1': [
        { id: 'model-1a', name: 'Model 1A', isEnabled: true },
        { id: 'model-1b', name: 'Model 1B', isEnabled: true },
      ],
    };

    await saveAiSelectionsPreference({
      version: 2,
      modeSelections: {},
      conversationSelections: {},
      providerSelectionsByConversationId: {},
      providerSelectionsByMode: {},
    });

    tauriAvailable = true;
    chatSnapshotConversations = [
      createChatSnapshotConversation('conv-a', {
        provider_id: 'provider-1',
        model_id: 'model-1b',
        reasoning_effort: 'low',
      }),
    ];
    activateArchitectPlanForTest({ conversationId: 'conv-a' });

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    await useChatStore.getState().reapplySelectionForCurrentContext();

    expect(useChatStore.getState().selectedConversationId).toBe('conv-a');
    expect(providerState.selectedProviderId).toBe('provider-1');
    expect(providerState.selectedModelId).toBe('model-1b');
    expect(providerState.selectedReasoningEffort).toBe('low');

    const storedSelections = await loadAiSelectionsPreference();
    expect(storedSelections).toMatchObject({
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1b',
          reasoningEffort: 'low',
        },
      },
    });
  });

  it('prefers the database conversation model over a stale preference entry', async () => {
    providerState.modelsByProvider = {
      'provider-1': [
        { id: 'model-1a', name: 'Model 1A', isEnabled: true },
        { id: 'model-1b', name: 'Model 1B', isEnabled: true },
      ],
    };

    await saveAiSelectionsPreference({
      version: 2,
      modeSelections: {},
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'medium',
          updatedAt: '2026-03-18T00:00:00.000Z',
        },
      },
      providerSelectionsByConversationId: {},
      providerSelectionsByMode: {},
    });

    tauriAvailable = true;
    chatSnapshotConversations = [
      createChatSnapshotConversation('conv-a', {
        provider_id: 'provider-1',
        model_id: 'model-1b',
        reasoning_effort: 'low',
        updated_at: '2026-03-19T00:00:00.000Z',
      }),
    ];
    activateArchitectPlanForTest({ conversationId: 'conv-a' });

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    await useChatStore.getState().reapplySelectionForCurrentContext();

    expect(providerState.selectedProviderId).toBe('provider-1');
    expect(providerState.selectedModelId).toBe('model-1b');
    expect(providerState.selectedReasoningEffort).toBe('low');

    const storedSelections = await loadAiSelectionsPreference();
    expect(storedSelections).toMatchObject({
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1b',
          reasoningEffort: 'low',
        },
      },
    });
  });

  it('marks restoreStatus as resolving while a manual conversation switch restores the AI selection', async () => {
    providerState.providerConfigs = [
      ...providerState.providerConfigs,
      {
        id: 'provider-2',
        name: 'Remote',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      },
    ];
    providerState.modelsByProvider = {
      'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
      'provider-2': [{ id: 'model-2a', name: 'Model 2A', isEnabled: true }],
    };

    await saveAiSelectionsPreference({
      version: 2,
      modeSelections: {
        Architect: {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
      },
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
        'conv-b': {
          providerId: 'provider-2',
          modelId: 'model-2a',
          reasoningEffort: 'high',
          updatedAt: '2026-03-19T00:01:00.000Z',
        },
      },
      providerSelectionsByConversationId: {
        'conv-a': {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        'conv-b': {
          'provider-2': {
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
      },
      providerSelectionsByMode: {
        Architect: {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'provider-2': {
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
      },
    });

    tauriAvailable = true;
    chatSnapshotConversations = [
      createChatSnapshotConversation('conv-a'),
      createChatSnapshotConversation('conv-b'),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a'), createConversation('conv-b')],
        selectedConversationId: 'conv-a',
        selectedConversationIdsByMode: { Architect: 'conv-a' },
      }),
    );
    await useChatStore.getState().reapplySelectionForCurrentContext();

    const provider2Deferred = createDeferred();
    const baseCommit = createCommitRestoredSelectionMock();
    providerState.commitRestoredSelection = mock(async (selection, options) => {
      if (selection.providerId === 'provider-2') {
        await provider2Deferred.promise;
      }
      return baseCommit(selection, options);
    });

    const selectionPromise = useChatStore.getState().selectConversation('conv-b');
    await Promise.resolve();
    await Promise.resolve();

    expect(useChatStore.getState().selectedConversationId).toBe('conv-b');
    expect(useChatStore.getState().restoreStatus).toBe('resolving');

    provider2Deferred.resolve();
    await selectionPromise;

    expect(useChatStore.getState().restoreStatus).toBe('ready');
    expect(providerState.selectedProviderId).toBe('provider-2');
    expect(providerState.selectedModelId).toBe('model-2a');
    expect(providerState.selectedReasoningEffort).toBe('high');
  });

  it('keeps the latest manual conversation switch when two restores race', async () => {
    providerState.providerConfigs = [
      ...providerState.providerConfigs,
      {
        id: 'provider-2',
        name: 'Remote',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      },
    ];
    providerState.modelsByProvider = {
      'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
      'provider-2': [{ id: 'model-2a', name: 'Model 2A', isEnabled: true }],
    };

    await saveAiSelectionsPreference({
      version: 2,
      modeSelections: {
        Architect: {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
      },
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
        'conv-b': {
          providerId: 'provider-2',
          modelId: 'model-2a',
          reasoningEffort: 'high',
          updatedAt: '2026-03-19T00:01:00.000Z',
        },
      },
      providerSelectionsByConversationId: {
        'conv-a': {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        'conv-b': {
          'provider-2': {
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
      },
      providerSelectionsByMode: {
        Architect: {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'provider-2': {
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
      },
    });

    tauriAvailable = true;
    chatSnapshotConversations = [
      createChatSnapshotConversation('conv-a'),
      createChatSnapshotConversation('conv-b'),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a'), createConversation('conv-b')],
        selectedConversationId: 'conv-a',
        selectedConversationIdsByMode: { Architect: 'conv-a' },
      }),
    );
    await useChatStore.getState().reapplySelectionForCurrentContext();

    const provider1Deferred = createDeferred();
    const provider2Deferred = createDeferred();
    const provider1Completed = createDeferred();
    const provider2Completed = createDeferred();
    const baseCommit = createCommitRestoredSelectionMock();
    providerState.commitRestoredSelection = mock(async (selection, options) => {
      if (selection.providerId === 'provider-2') {
        await provider2Deferred.promise;
      }
      if (selection.providerId === 'provider-1') {
        await provider1Deferred.promise;
      }
      const committed = await baseCommit(selection, options);
      if (selection.providerId === 'provider-1') {
        provider1Completed.resolve();
      }
      if (selection.providerId === 'provider-2') {
        provider2Completed.resolve();
      }
      return committed;
    });

    const firstSwitch = useChatStore.getState().selectConversation('conv-b');
    await Promise.resolve();
    await Promise.resolve();

    const secondSwitch = useChatStore.getState().selectConversation('conv-a');
    await Promise.resolve();
    await Promise.resolve();

    provider1Deferred.resolve();
    await secondSwitch;
    provider2Deferred.resolve();
    await firstSwitch;

    expect(useChatStore.getState().selectedConversationId).toBe('conv-a');
    expect(providerState.selectedProviderId).toBe('provider-1');
    expect(providerState.selectedModelId).toBe('model-1a');
    expect(providerState.selectedReasoningEffort).toBe('low');
  });

  it('keeps the latest provider switch when provider restores race within a conversation', async () => {
    providerState.providerConfigs = [
      ...providerState.providerConfigs,
      {
        id: 'provider-2',
        name: 'Remote',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      },
    ];
    providerState.modelsByProvider = {
      'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
      'provider-2': [{ id: 'model-2a', name: 'Model 2A', isEnabled: true }],
    };

    await saveAiSelectionsPreference({
      version: 2,
      modeSelections: {
        Architect: {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
      },
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
      },
      providerSelectionsByConversationId: {
        'conv-a': {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'provider-2': {
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
      },
      providerSelectionsByMode: {
        Architect: {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'provider-2': {
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
      },
    });

    tauriAvailable = true;
    chatSnapshotConversations = [createChatSnapshotConversation('conv-a')];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a')],
        selectedConversationId: 'conv-a',
        selectedConversationIdsByMode: { Architect: 'conv-a' },
      }),
    );
    await useChatStore.getState().reapplySelectionForCurrentContext();

    const provider1Deferred = createDeferred();
    const provider2Deferred = createDeferred();
    const provider1Completed = createDeferred();
    const provider2Completed = createDeferred();
    const baseCommit = createCommitRestoredSelectionMock();
    providerState.commitRestoredSelection = mock(async (selection, options) => {
      if (selection.providerId === 'provider-2') {
        await provider2Deferred.promise;
      }
      if (selection.providerId === 'provider-1') {
        await provider1Deferred.promise;
      }
      const committed = await baseCommit(selection, options);
      if (selection.providerId === 'provider-1') {
        provider1Completed.resolve();
      }
      if (selection.providerId === 'provider-2') {
        provider2Completed.resolve();
      }
      return committed;
    });

    providerState.selectProvider('provider-2');
    await Promise.resolve();
    await Promise.resolve();

    providerState.selectProvider('provider-1');
    await Promise.resolve();
    await Promise.resolve();

    provider1Deferred.resolve();
    await provider1Completed.promise;
    provider2Deferred.resolve();
    await provider2Completed.promise;
    await flushAsyncWork();

    expect(providerState.selectedProviderId).toBe('provider-1');
    expect(providerState.selectedModelId).toBe('model-1a');
    expect(providerState.selectedReasoningEffort).toBe('low');
  });

  it('remembers the last model and thinking used for each provider within a conversation', async () => {
    providerState.providerConfigs = [
      ...providerState.providerConfigs,
      {
        id: 'provider-2',
        name: 'Remote',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      },
    ];
    providerState.modelsByProvider = {
      'provider-1': [{ id: 'model-1b', name: 'Model 1B', isEnabled: true }],
      'provider-2': [{ id: 'model-2b', name: 'Model 2B', isEnabled: true }],
    };

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    useChatStore.setState(createArchitectStoreState());

    useProviderStoreMock.setState({
      selectedProviderId: 'provider-1',
      selectedModelId: 'model-1b',
      selectedReasoningEffort: 'low',
    });
    await flushAsyncWork();

    useProviderStoreMock.setState({
      selectedProviderId: 'provider-2',
      selectedModelId: 'model-2b',
      selectedReasoningEffort: 'high',
    });
    await flushAsyncWork();

    providerState.selectProvider('provider-1');
    await flushAsyncWork();

    expect(providerState.selectedProviderId).toBe('provider-1');
    expect(providerState.selectedModelId).toBe('model-1b');
    expect(providerState.selectedReasoningEffort).toBe('low');

    providerState.selectProvider('provider-2');
    await flushAsyncWork();

    expect(providerState.selectedProviderId).toBe('provider-2');
    expect(providerState.selectedModelId).toBe('model-2b');
    expect(providerState.selectedReasoningEffort).toBe('high');
  });

  it('inherits only the active provider-model-thinking pair when creating a new conversation', async () => {
    providerState.providerConfigs = [
      ...providerState.providerConfigs,
      {
        id: 'provider-2',
        name: 'Remote',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      },
    ];
    providerState.modelsByProvider = {
      'provider-1': [
        { id: 'model-1a', name: 'Model 1A', isEnabled: true },
        { id: 'model-1b', name: 'Model 1B', isEnabled: true },
      ],
      'provider-2': [{ id: 'model-2b', name: 'Model 2B', isEnabled: true }],
    };

    await saveAiSelectionsPreference({
      version: 2,
      modeSelections: {
        Architect: {
          providerId: 'provider-2',
          modelId: 'model-2b',
          reasoningEffort: 'high',
          updatedAt: '2026-03-19T00:02:00.000Z',
        },
      },
      conversationSelections: {
        'conv-source': {
          providerId: 'provider-2',
          modelId: 'model-2b',
          reasoningEffort: 'high',
          updatedAt: '2026-03-19T00:02:00.000Z',
        },
      },
      providerSelectionsByConversationId: {
        'conv-source': {
          'provider-1': {
            modelId: 'model-1b',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'provider-2': {
            modelId: 'model-2b',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:02:00.000Z',
          },
        },
      },
      providerSelectionsByMode: {
        Architect: {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'medium',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
          'provider-2': {
            modelId: 'model-2b',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:02:00.000Z',
          },
        },
      },
    });

    tauriAvailable = true;
    chatSnapshotConversations = [
      createChatSnapshotConversation('conv-source'),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-source')],
        selectedConversationId: 'conv-source',
        selectedConversationIdsByMode: { Architect: 'conv-source' },
      }),
    );

    await useChatStore.getState().reapplySelectionForCurrentContext();
    const createdConversation = await useChatStore
      .getState()
      .createConversation('New Conversation', null, 'project-1');
    await flushAsyncWork();

    expect(useChatStore.getState().selectedConversationId).toBe(createdConversation.id);
    expect(providerState.selectedProviderId).toBe('provider-2');
    expect(providerState.selectedModelId).toBe('model-2b');
    expect(providerState.selectedReasoningEffort).toBe('high');

    providerState.selectProvider('provider-1');
    await flushAsyncWork();

    expect(providerState.selectedProviderId).toBe('provider-1');
    expect(providerState.selectedModelId).toBe('model-1a');
    expect(providerState.selectedReasoningEffort).toBe('medium');
  });

  it('migrates legacy AI context selections to version 2 and preserves the restored selection', async () => {
    providerState.modelsByProvider = {
      'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
    };

    await saveAiSelectionsPreference({
      version: 1,
      modeSelections: {
        Architect: {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
      },
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
      },
    });

    tauriAvailable = true;
    chatSnapshotConversations = [
      createChatSnapshotConversation('conv-a'),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();
    useChatStore.setState(
      createArchitectStoreState({
        conversations: [createConversation('conv-a')],
        selectedConversationId: 'conv-a',
        selectedConversationIdsByMode: { Architect: 'conv-a' },
      }),
    );

    await useChatStore.getState().reapplySelectionForCurrentContext();

    expect(providerState.selectedProviderId).toBe('provider-1');
    expect(providerState.selectedModelId).toBe('model-1a');
    expect(providerState.selectedReasoningEffort).toBe('low');

    const storedSelections = await loadAiSelectionsPreference();
    expect(storedSelections).toMatchObject({
      version: 2,
      conversationSelections: {
        'conv-a': {
          providerId: 'provider-1',
          modelId: 'model-1a',
          reasoningEffort: 'low',
        },
      },
      providerSelectionsByConversationId: {
        'conv-a': {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
          },
        },
      },
      providerSelectionsByMode: {
        Architect: {
          'provider-1': {
            modelId: 'model-1a',
            reasoningEffort: 'low',
          },
        },
      },
    });
  });

  it('keeps strategy mutations isolated when the strategy guard loads before the plan service mocks', async () => {
    mock.restore();
    await import('../services/architectStrategyMutationGuard');
    await registerUseChatStoreMocks();

    const plan = createPlan({
      id: 'plan-early-guard',
      slug: 'plan-early-guard',
      title: 'Plan Early Guard',
      conversationId: 'plan-conv',
      status: 'draft',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Generate the strategy.',
    });
    updateArchitectPlanMock.mockClear();

    await onToolCall('strategy_generate', {
      nodes: [{ title: 'Implement checkout' }],
    });

    expect(updateArchitectPlanMock).toHaveBeenCalledTimes(1);
    expect(
      ((updateArchitectPlanMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>,
    ).toMatchObject({
      branchName: 'develop',
      planId: 'plan-early-guard',
    });
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

  it('clears the previous architect conversation immediately when switching to a blank plan', async () => {
    tauriAvailable = true;

    const advancedPlan = createScenarioPlan('started', {
      id: 'plan-advanced',
      slug: 'plan-advanced',
      title: 'plan-advanced',
      label: 'Checkout refresh',
      conversationId: 'plan-advanced-conv',
    });
    const blankPlan = createScenarioPlan('blank', {
      id: 'plan-blank',
      slug: 'plan-blank',
      title: 'plan-blank',
      conversationId: undefined,
    });
    architectPlans.set(advancedPlan.id, advancedPlan);
    architectPlans.set(blankPlan.id, blankPlan);
    appState.activeArchitectPlanId = advancedPlan.id;
    appState.activePlanContext = { id: advancedPlan.id, targetBranch: 'develop' };

    chatSnapshotConversations = [
      createChatSnapshotConversation('plan-advanced-conv', {
        title: 'Checkout refresh',
        last_message: 'latest',
        message_count: 2,
        updated_at: '2026-03-19T00:04:00.000Z',
      }),
    ];
    chatSnapshotMessages = [
      createChatMessageRecord({
        id: 'm-1',
        conversation_id: 'plan-advanced-conv',
        role: 'user',
        content: 'First question',
      }),
      createChatMessageRecord({
        id: 'm-2',
        conversation_id: 'plan-advanced-conv',
        role: 'assistant',
        content: 'Second answer',
        created_at: '2026-03-19T00:02:00.000Z',
      }),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();

    expect(useChatStore.getState().selectedConversationId).toBe('plan-advanced-conv');

    tauriAvailable = false;
    useAppStoreMock.setState({
      activeArchitectPlanId: blankPlan.id,
      activePlanContext: { id: blankPlan.id, targetBranch: 'develop' },
    });

    expect(useChatStore.getState().selectedConversationId).toBeNull();
    expect(useChatStore.getState().selectedConversationIdsByMode.Architect).toBeNull();
    expect(useChatStore.getState().restoreStatus).toBe('resolving');

    await flushAsyncWork();

    const nextConversationId = useChatStore.getState().selectedConversationId;
    expect(nextConversationId).toBeTruthy();
    expect(nextConversationId).not.toBe('plan-advanced-conv');
    expect(useChatStore.getState().restoreStatus).toBe('ready');
    expect(useChatStore.getState().getConversationMessages(nextConversationId!)).toHaveLength(0);
    expect(getArchitectPlanActivationPayloadMock).toHaveBeenCalledWith(
      'develop',
      blankPlan.id,
      expect.any(Object)
    );
    expect(bindArchitectPlanConversationMock).not.toHaveBeenCalled();
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
  });

  it('binds a blank architect plan conversation only when the first message is sent', async () => {
    const plan = createScenarioPlan('blank', {
      id: 'plan-blank-first-message',
      slug: 'plan-blank-first-message',
      title: 'plan-blank-first-message',
      conversationId: undefined,
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState());

    const conversationId =
      await useChatStore.getState().ensureConversationForCurrentMode();

    expect(conversationId).toBeTruthy();
    expect(bindArchitectPlanConversationMock).not.toHaveBeenCalled();
    expect(updateArchitectPlanMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
      }),
    );

    await useChatStore.getState().sendMessage({
      conversationId: conversationId!,
      content: 'On doit refondre le parcours checkout et la reprise panier.',
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bindArchitectPlanConversationMock).toHaveBeenCalledWith({
      branchName: 'develop',
      planId: plan.id,
      conversationId: expect.not.stringMatching(/^pending-architect-/),
    });
    expect(architectPlans.get(plan.id)?.conversationId).not.toBe(conversationId);
    expect(architectPlans.get(plan.id)?.conversationId).toBeTruthy();
    expect(syncArchitectPlanChatFromConversationMock).toHaveBeenCalledWith({
      branchName: 'develop',
      planId: plan.id,
      conversationId: architectPlans.get(plan.id)?.conversationId,
    });
  });

  it('removes a pending blank architect conversation when switching away before the first message', async () => {
    const blankPlan = createScenarioPlan('blank', {
      id: 'plan-pending-switch-away',
      slug: 'plan-pending-switch-away',
      title: 'plan-pending-switch-away',
      conversationId: undefined,
    });
    const startedPlan = createScenarioPlan('started', {
      id: 'plan-started-after-pending',
      slug: 'plan-started-after-pending',
      title: 'plan-started-after-pending',
      conversationId: 'started-plan-conv',
    });
    architectPlans.set(blankPlan.id, blankPlan);
    architectPlans.set(startedPlan.id, startedPlan);
    appState.activeArchitectPlanId = blankPlan.id;
    appState.activePlanContext = { id: blankPlan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(
      createIdleChatStoreState({
        conversations: [createConversation('started-plan-conv')],
      })
    );

    const pendingConversationId =
      await useChatStore.getState().ensureConversationForCurrentMode();
    expect(pendingConversationId).toMatch(/^pending-architect-/);
    expect(
      useChatStore
        .getState()
        .conversations.some(
          (conversation: Conversation) => conversation.id === pendingConversationId
        )
    ).toBe(true);

    appState.activeArchitectPlanId = startedPlan.id;
    appState.activePlanContext = { id: startedPlan.id, targetBranch: 'develop' };

    const selectedConversationId =
      await useChatStore.getState().ensureConversationForCurrentMode();

    expect(selectedConversationId).toBe('started-plan-conv');
    expect(
      useChatStore
        .getState()
        .conversations.some(
          (conversation: Conversation) => conversation.id === pendingConversationId
        )
    ).toBe(false);
    expect(useChatStore.getState().selectedConversationId).toBe('started-plan-conv');
  });

  it('uses a head-only architect activation without reading the transcript when DB sync matches', async () => {
    tauriAvailable = true;
    const plan = createScenarioPlan('started', {
      id: 'plan-head-sync-ok',
      slug: 'plan-head-sync-ok',
      title: 'plan-head-sync-ok',
      conversationId: 'plan-head-sync-conv',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };
    chatSnapshotConversations = [
      createChatSnapshotConversation('plan-head-sync-conv', {
        message_count: 2,
        updated_at: '2026-03-19T00:02:00.000Z',
      }),
    ];
    chatSnapshotMessages = [
      createChatMessageRecord({
        id: 'head-sync-user',
        conversation_id: 'plan-head-sync-conv',
        role: 'user',
        content: 'Existing local question',
      }),
      createChatMessageRecord({
        id: 'head-sync-assistant',
        conversation_id: 'plan-head-sync-conv',
        role: 'assistant',
        content: 'Existing local answer',
        created_at: '2026-03-19T00:02:00.000Z',
      }),
    ];
    architectPlanConversationSyncRecords.set('plan-head-sync-conv', {
      conversation_id: 'plan-head-sync-conv',
      plan_id: plan.id,
      target_branch: 'develop',
      transcript_revision: 'revision-head-ok',
      message_count: 2,
      updated_at: '2026-03-19T00:02:00.000Z',
    });
    getArchitectPlanActivationPayloadMock.mockImplementationOnce(async () => ({
      plan,
      chatMessages: [],
      chatMessagesLoaded: false,
      chatTranscriptRevision: 'revision-head-ok',
      chatMessageCount: 2,
      conversationId: 'plan-head-sync-conv',
      sharedConversation: false,
      targetBranch: 'develop',
      resolutionMode: 'full',
    }));

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();

    expect(useChatStore.getState().selectedConversationId).toBe('plan-head-sync-conv');
    expect(dbGetArchitectPlanConversationSyncMock).toHaveBeenCalledWith('plan-head-sync-conv');
    expect(getArchitectPlanChatTranscriptMock).not.toHaveBeenCalled();
    expect(
      useChatStore
        .getState()
        .getConversationMessages('plan-head-sync-conv')
        .map((message: { id: string }) => message.id)
    ).toEqual(['head-sync-user', 'head-sync-assistant']);
  });

  it('loads and imports the architect transcript when head-only activation sync is missing', async () => {
    tauriAvailable = true;
    const plan = createScenarioPlan('started', {
      id: 'plan-head-sync-missing',
      slug: 'plan-head-sync-missing',
      title: 'plan-head-sync-missing',
      conversationId: 'plan-head-missing-conv',
    });
    architectPlans.set(plan.id, plan);
    architectPlanMessages.set(plan.id, [
      createTranscriptEntry({
        id: 'missing-sync-user',
        role: 'user',
        content: 'Restore transcript from metadata.',
      }),
      createTranscriptEntry({
        id: 'missing-sync-assistant',
        role: 'assistant',
        content: 'Transcript restored.',
        createdAt: '2026-03-19T00:02:00.000Z',
      }),
    ]);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };
    chatSnapshotConversations = [
      createChatSnapshotConversation('plan-head-missing-conv', {
        message_count: 0,
      }),
    ];
    getArchitectPlanActivationPayloadMock.mockImplementationOnce(async () => ({
      plan,
      chatMessages: [],
      chatMessagesLoaded: false,
      chatTranscriptRevision: 'revision-head-missing',
      chatMessageCount: 2,
      conversationId: 'plan-head-missing-conv',
      sharedConversation: false,
      targetBranch: 'develop',
      resolutionMode: 'full',
    }));

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();

    expect(getArchitectPlanChatTranscriptMock).toHaveBeenCalledWith('develop', plan.id);
    expect(importMessagesMock).toHaveBeenCalledWith(
      'plan-head-missing-conv',
      expect.arrayContaining([
        expect.objectContaining({ id: 'missing-sync-user' }),
        expect.objectContaining({ id: 'missing-sync-assistant' }),
      ])
    );
    expect(dbUpsertArchitectPlanConversationSyncMock).toHaveBeenCalledWith({
      conversation_id: 'plan-head-missing-conv',
      plan_id: plan.id,
      target_branch: 'develop',
      transcript_revision: 'test-revision-plan-head-sync-missing',
      message_count: 2,
    });
    expect(
      useChatStore
        .getState()
        .getConversationMessages('plan-head-missing-conv')
        .map((message: { id: string }) => message.id)
    ).toEqual(['missing-sync-user', 'missing-sync-assistant']);
  });

  it('reuses the app-store activation payload before falling back to the plan service', async () => {
    const plan = createScenarioPlan('blank', {
      id: 'plan-blank-shared-payload',
      slug: 'plan-blank-shared-payload',
      title: 'plan-blank-shared-payload',
      conversationId: undefined,
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };
    appState.pendingArchitectPlanActivationPayload = {
      plan,
      chatMessages: [],
      conversationId: null,
      sharedConversation: false,
      targetBranch: 'develop',
      resolutionMode: 'blank_fast_path',
    };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState());
    getArchitectPlanActivationPayloadMock.mockClear();

    const conversationId =
      await useChatStore.getState().ensureConversationForCurrentMode();

    expect(conversationId).toBeTruthy();
    expect(getArchitectPlanActivationPayloadMock).not.toHaveBeenCalled();
    expect(appState.pendingArchitectPlanActivationPayload).toBeNull();
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

    expect(getChatBootstrapSnapshotMock).toHaveBeenCalledTimes(1);
    expect(getChatSnapshotMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().hydrationStatus).toBe('ready');
    expect(useChatStore.getState().restoreStatus).toBe('ready');
    expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
    expect(
      useChatStore.getState().getConversationMessages('plan-conv').map((message: { id: string }) => message.id)
    ).toEqual(['m-1', 'm-2']);
    expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
  });

  it('repairs stale scope metadata for the active plan conversation during initialize', async () => {
    tauriAvailable = true;

    const plan = createPlan({ conversationId: 'plan-conv' });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    chatSnapshotConversations = [
      createChatSnapshotConversation('plan-conv', {
        scope_mode: 'Chat',
        group_id: null,
        project_id: null,
        title: 'Checkout refresh',
        last_message: 'latest',
        message_count: 1,
      }),
    ];
    chatSnapshotMessages = [
      createChatMessageRecord({
        id: 'm-1',
        conversation_id: 'plan-conv',
        role: 'user',
        content: 'Restore this history.',
      }),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initialize();

    const repairedConversation = useChatStore
      .getState()
      .conversations.find((conversation: Conversation) => conversation.id === 'plan-conv');
    expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
    expect(useChatStore.getState().getConversationMessages('plan-conv')).toHaveLength(1);
    expect(repairedConversation).toEqual(
      expect.objectContaining({
        scope_mode: 'Architect',
        task_id: null,
        group_id: 'group-1',
        project_id: 'project-1',
      })
    );
    expect(updateConversationScopeMock).toHaveBeenCalledWith({
      id: 'plan-conv',
      scopeMode: 'Architect',
      taskId: null,
      groupId: 'group-1',
      projectId: 'project-1',
    });
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it('ignores stale active-plan resolutions when the project scope changes during startup', async () => {
    tauriAvailable = true;

    const plan = createPlan({ conversationId: 'plan-conv' });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    chatSnapshotConversations = [
      createChatSnapshotConversation('plan-conv', {
        title: 'Checkout refresh',
        message_count: 1,
      }),
    ];
    chatSnapshotMessages = [
      createChatMessageRecord({
        id: 'm-1',
        conversation_id: 'plan-conv',
        role: 'assistant',
        content: 'Previous answer.',
      }),
    ];

    const { useChatStore } = await loadChatStore();
    await useChatStore.getState().initializeCritical();

    const firstResolution = createDeferred<{
      plan: ArchitectPlanRecord;
      chatMessages: never[];
      conversationId: string;
      sharedConversation: false;
      targetBranch: string;
      resolutionMode: 'full';
    }>();
    getArchitectPlanActivationPayloadMock
      .mockImplementationOnce(async () => firstResolution.promise)
      .mockImplementationOnce(async (_branchName: string) => ({
        plan,
        chatMessages: [],
        conversationId: 'plan-conv',
        sharedConversation: false,
        targetBranch: 'develop',
        resolutionMode: 'full',
      }));

    const staleResolution = useChatStore.getState().ensureConversationForCurrentMode();
    await Promise.resolve();

    useAppStoreMock.setState({ selectedProjectId: null });
    firstResolution.resolve({
      plan,
      chatMessages: [],
      conversationId: 'plan-conv',
      sharedConversation: false,
      targetBranch: 'develop',
      resolutionMode: 'full',
    });
    await staleResolution;
    await flushAsyncWork();

    expect(useChatStore.getState().lastError).not.toBe(
      'Failed to select the resolved conversation.'
    );
    expect(useChatStore.getState().restoreStatus).toBe('ready');
    expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
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

  it('renames an auto-created canonical plan with the configured metadata model', async () => {
    providerState.providerConfigs = [
      ...providerState.providerConfigs,
      {
        id: 'provider-2',
        name: 'Metadata Provider',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      },
    ];
    providerState.modelsByProvider = {
      ...providerState.modelsByProvider,
      'provider-2': [{ id: 'metadata-model', name: 'Metadata Model', isEnabled: true }],
    };
    localStorage.setItem(
      'macro_metadataModelConfig',
      JSON.stringify({
        mode: 'dedicated',
        providerId: 'provider-2',
        modelId: 'metadata-model',
        reasoningEffort: null,
      })
    );
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
    expect(sendChatNonStreamingMock.mock.calls[0]?.[0]).toMatchObject({
      providerId: 'provider-2',
      modelId: 'metadata-model',
    });
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
    expect(useChatStore.getState().conversations[0]?.title).toBe(
      'Plan - Checkout refresh - 1710000000000'
    );
  });

  it('does not overwrite a manually renamed canonical plan on the first message', async () => {
    const plan = createPlan({
      id: '1710000000001',
      slug: '1710000000001',
      title: '1710000000001',
      label: 'Checkout rescue',
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
          title: 'Plan - Checkout rescue - 1710000000001',
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
      content: 'On doit stabiliser le checkout au plus vite.',
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(architectPlans.get(plan.id)?.label).toBe('Checkout rescue');
    expect(useChatStore.getState().conversations[0]?.title).toBe(
      'Plan - Checkout rescue - 1710000000001'
    );
  });

  it('opens architect plan naming recovery after three failed AI naming attempts', async () => {
    setSendChatNonStreamingImplementation(async () => {
      throw new Error('model unavailable');
    });

    const plan = createPlan({
      id: '1710000000002',
      slug: '1710000000002',
      title: '1710000000002',
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
      content: 'On doit refondre le panier et la reprise de session.',
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(3);
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(updateConversationDetailsMock).not.toHaveBeenCalled();
    expect(architectPlans.get(plan.id)?.label).toBe('new plan');
    expect(useChatStore.getState().architectPlanNamingRecovery).toMatchObject({
      conversationId: 'plan-conv',
      planId: plan.id,
      targetBranch: 'develop',
      stage: 'choice',
      isSubmitting: false,
      error: null,
    });
  });

  it('retries architect plan naming from recovery until it succeeds', async () => {
    setSendChatNonStreamingImplementation(async () => {
      throw new Error('model unavailable');
    });

    const plan = createPlan({
      id: '1710000000003',
      slug: '1710000000003',
      title: '1710000000003',
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
      content: 'On doit refondre le checkout et restaurer le panier.',
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    setSendChatNonStreamingImplementation(async () =>
      JSON.stringify({
        title: 'Checkout refresh',
        description: 'Refresh checkout state and cart recovery.',
      })
    );

    const retried = await useChatStore.getState().retryArchitectPlanNamingRecovery();

    expect(retried).toBe(true);
    expect(architectPlans.get(plan.id)?.label).toBe('Checkout refresh');
    expect(useChatStore.getState().architectPlanNamingRecovery).toBeNull();
    expect(useChatStore.getState().conversations[0]?.title).toBe(
      'Plan - Checkout refresh - 1710000000003'
    );
  });

  it('allows naming the plan manually from recovery', async () => {
    const plan = createPlan({
      id: '1710000000004',
      slug: '1710000000004',
      title: '1710000000004',
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
      architectPlanNamingRecovery: {
        conversationId: 'plan-conv',
        planId: plan.id,
        targetBranch: 'develop',
        firstUserContent: 'On doit renommer ce plan.',
        providerId: 'provider-1',
        modelId: 'model-1',
        reasoningEffort: null,
        stage: 'manual',
        isSubmitting: false,
        error: null,
      },
    });

    const saved = await useChatStore
      .getState()
      .submitArchitectPlanManualName('Checkout recovery');

    expect(saved).toBe(true);
    expect(architectPlans.get(plan.id)?.label).toBe('Checkout recovery');
    expect(useChatStore.getState().architectPlanNamingRecovery).toBeNull();
    expect(useChatStore.getState().conversations[0]?.title).toBe(
      'Plan - Checkout recovery - 1710000000004'
    );
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

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Refresh the plan context.',
    });

    expect(onToolCall).toBeDefined();
    await onToolCall('plan_update', {
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

  it('allows plan label metadata updates after strategy has been created', async () => {
    const activePlan = createPlan({
      id: 'started-plan',
      conversationId: 'plan-conv',
      nodes: [
        {
          id: 'node-1',
          title: 'Implement checkout',
          description: '',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/checkout',
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
      ],
    });
    architectPlans.set(activePlan.id, activePlan);
    appState.activeArchitectPlanId = activePlan.id;
    appState.activePlanContext = { targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Update the plan label.',
    });

    const result = await onToolCall('plan_update', {
      plan_id: activePlan.id,
      label: 'New label',
    });

    expect(result).toContain('Updated plan');
    expect(result).toContain('New label');
    expect(updateArchitectPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: activePlan.id,
        label: 'New label',
      }),
    );
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

    expect('label' in lastCall).toBe(false);
    expect('title' in lastCall).toBe(false);
  });

  it('persists a renamed draft slug through strategy generation and rebuilds rendered branches', async () => {
    const plan = createPlan({
      id: 'draft-plan',
      slug: 'checkout-refresh',
      title: 'checkout-refresh',
      label: 'Checkout refresh',
      status: 'draft',
      conversationId: 'plan-conv',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Generate the strategy.',
    });
    updateArchitectPlanMock.mockClear();

    await onToolCall('strategy_generate', {
      plan_slug: 'checkout-rework',
      nodes: [
        {
          title: 'Prepare schema',
          featureSlug: 'prepare-schema',
        },
      ],
    });

    const lastCall = ((updateArchitectPlanMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
    const predictedBranches = (lastCall.predictedBranches as Array<Record<string, unknown>>) ?? [];
    const persistedPlan = architectPlans.get(plan.id);

    expect(lastCall.slug).toBe('checkout-rework');
    expect(predictedBranches.map((branch) => branch.name)).toEqual([
      'feature/checkout-rework/prepare-schema',
    ]);
    expect(predictedBranches.map((branch) => branch.parentBranch)).toEqual([
      'plan/checkout-rework',
    ]);
    expect(
      predictedBranches.some((branch) =>
        String(branch.name || '').includes('checkout-refresh'),
      ),
    ).toBe(false);
    expect(
      predictedBranches.some((branch) =>
        String(branch.parentBranch || '').includes('checkout-refresh'),
      ),
    ).toBe(false);
    expect(persistedPlan?.slug).toBe('checkout-rework');
    expect(persistedPlan?.predictedBranches.map((branch) => branch.name)).toEqual([
      'feature/checkout-rework/prepare-schema',
    ]);
  });

  it('rejects generated strategy nodes that target outside the active plan scope', async () => {
    const plan = createPlan({
      id: 'scope-change-plan',
      slug: 'scope-change-plan',
      title: 'scope-change-plan',
      conversationId: 'plan-conv',
      status: 'draft',
      projectId: 'project-1',
      projectIds: ['project-1'],
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Generate the strategy.',
    });
    updateArchitectPlanMock.mockClear();

    await expect(
      onToolCall('strategy_generate', {
        nodes: [
          {
            title: 'Implement API release prep',
            projectId: 'project-2',
            featureSlug: 'api-release-prep',
          },
        ],
      }),
    ).rejects.toThrow('outside this plan');
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(architectPlans.get(plan.id)?.projectIds).toEqual(['project-1']);
  });

  it('returns strategy_get results when only operational transcript state differs', async () => {
    const plan = createPlan({
      id: 'strategy-readable-plan',
      conversationId: 'plan-conv',
      nodes: [
        {
          id: 'node-1',
          title: 'Readable strategy node',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
      ],
    });
    architectPlans.set(plan.id, plan);
    architectPlanMessages.set(plan.id, [
      createTranscriptEntry({
        id: 'transcript-only',
        content: 'Operational transcript mismatch only.',
      }),
    ]);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Read the strategy.',
    });

    const result = await onToolCall('strategy_get', {});

    expect(String(result)).toContain('Loaded strategy');
    expect(String(result)).toContain('Readable strategy node');
  });

  it('includes a replica warning when strategy generation writes despite post-write divergence', async () => {
    const plan = createPlan({
      id: 'post-write-warning-plan',
      conversationId: 'plan-conv',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    updateArchitectPlanMock.mockImplementationOnce(async (params) => {
      const existing = architectPlans.get(params.planId);
      if (!existing) {
        throw new Error(`Unknown plan ${params.planId}`);
      }
      const updated = {
        ...existing,
        conversationId: existing.conversationId,
        label: existing.label,
        nodes: (params.nodes as ArchitectPlanRecord['nodes'] | undefined) ?? existing.nodes,
        predictedBranches:
          (params.predictedBranches as ArchitectPlanRecord['predictedBranches'] | undefined) ??
          existing.predictedBranches,
        projectId: existing.projectId,
        projectIds: params.projectIds ?? existing.projectIds,
        targetBranchesByProjectId: existing.targetBranchesByProjectId,
        hasReplicaDivergence: true,
        replicationState: 'diverged' as const,
        replicas: [
          {
            scopeKey: 'project:project-1:/repos/web',
            projectId: 'project-1',
            repoPath: '/repos/web',
            workspacePath: '/repos/web',
            source: 'project' as const,
            updatedAt: '2026-03-19T01:00:00.000Z',
          },
        ],
      };
      architectPlans.set(params.planId, updated);
      return updated;
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Generate the strategy.',
    });

    const result = await onToolCall('strategy_generate', {
      nodes: [
        {
          title: 'Warn after write',
          projectId: 'project-1',
          featureSlug: 'warn-after-write',
        },
      ],
    });

    expect(String(result)).toContain('Strategy updated');
    expect(String(result)).toContain('replica_warning');
    expect(String(result)).toContain('repair_metadata');
  });

  it('returns structured repair metadata for true plan replica divergence', async () => {
    const plan = createPlan({
      id: 'diverged-plan',
      conversationId: 'plan-conv',
    });
    architectPlans.set(plan.id, plan);
    appState.activeArchitectPlanId = plan.id;
    appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

    const divergenceError = Object.assign(
      new Error('Plan diverged-plan has diverged metadata replicas across repositories.'),
      {
        code: 'ARCHITECT_PLAN_REPLICA_DIVERGENCE',
        divergence: {
          branchName: 'develop',
          planId: plan.id,
          reason: 'content_diverged',
          replicas: [
            {
              scopeKey: 'project:project-1:/repos/web',
              projectId: 'project-1',
              repoPath: '/repos/web',
              workspacePath: '/repos/web',
              source: 'project',
              updatedAt: '2026-03-19T01:00:00.000Z',
            },
          ],
        },
      }
    );
    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Read the strategy.',
    });

    getArchitectPlanMock.mockImplementationOnce(async () => {
      throw divergenceError;
    });

    const result = await onToolCall('strategy_get', {});

    expect(String(result)).toContain('architect_plan_replica_divergence');
    expect(String(result)).toContain('repair_metadata');
    expect(String(result)).toContain('content_diverged');
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

  it('stages a non-destructive preview during draft strategy generation when frozen work exists', async () => {
    const activePlan = createPlan({
      id: 'started-plan',
      conversationId: 'plan-conv',
      status: 'draft',
      nodes: [
        {
          id: 'task-a',
          title: 'Prepare schema',
          description: '',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/prepare-schema',
          branchType: 'feature',
          branchSlug: 'prepare-schema',
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
        {
          id: 'task-b',
          title: 'Build endpoint',
          description: '',
          type: 'task',
          status: 'in-progress',
          dependencies: ['task-a'],
          assignedBranch: 'feature/build-endpoint',
          branchType: 'feature',
          branchSlug: 'build-endpoint',
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
      ],
    });
    architectPlans.set(activePlan.id, activePlan);
    appState.activeArchitectPlanId = activePlan.id;
    appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop' };
    taskStoreState.tasks = [
      createImplementTask({
        id: 'task-a',
        title: 'Prepare schema',
        status: 'Pending',
        plan_id: activePlan.id,
        assigned_branch: 'feature/prepare-schema',
        branch_name: 'feature/prepare-schema',
      }),
      createImplementTask({
        id: 'task-b',
        title: 'Build endpoint',
        status: 'InProgress',
        plan_id: activePlan.id,
        assigned_branch: 'feature/build-endpoint',
        branch_name: 'feature/build-endpoint',
        dependencies: ['task-a'],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Regenerate the strategy safely.',
    });
    updateArchitectPlanMock.mockClear();

    const result = await onToolCall('strategy_generate', {
      nodes: [
        {
          id: 'task-a',
          title: 'Prepare schema',
          dependencies: [],
          status: 'pending',
        },
        {
          id: 'task-b',
          title: 'Build endpoint',
          dependencies: ['task-a'],
          status: 'in-progress',
        },
        {
          title: 'Ship telemetry',
          dependencies: ['task-b'],
        },
      ],
    });

    expect(String(result)).toContain('preview_staged');
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(appState.strategyMutationPreview).not.toBeNull();
    expect((appState.strategyMutationPreview as { status: string }).status).toBe('valid');
  });

  it('rejects strategy generation and updates after validation before slug checks', async () => {
    const activePlan = createPlan({
      id: 'plan-active',
      slug: 'checkout-refresh',
      title: 'checkout-refresh',
      conversationId: 'plan-conv',
      status: 'validated',
    });
    architectPlans.set(activePlan.id, activePlan);
    appState.activeArchitectPlanId = activePlan.id;
    appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Update the active strategy.',
    });
    updateArchitectPlanMock.mockClear();

    const generateResult = await onToolCall('strategy_generate', {
      plan_slug: 'checkout-rework',
      nodes: [{ title: 'Implement checkout' }],
    });
    const updateResult = await onToolCall('strategy_update', {
      replace: true,
      plan_slug: 'checkout-rework',
      nodes: [{ title: 'Implement checkout' }],
    });

    expect(String(generateResult)).toBe(ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE);
    expect(String(updateResult)).toBe(ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE);
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
  });

  it('uses plan scope for unscoped strategy_update nodes and explicit scope for targeted nodes', async () => {
    const activePlan = createPlan({
      id: 'plan-multi',
      slug: 'checkout',
      title: 'checkout',
      conversationId: 'plan-conv',
      status: 'draft',
      projectId: 'project-1',
      projectIds: ['project-1', 'project-2'],
      nodes: [
        {
          id: 'task-web',
          title: 'Build checkout UI',
          description: '',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/checkout/checkout-web',
          branchType: 'feature',
          branchSlug: 'checkout-web',
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
        {
          id: 'task-api',
          title: 'Add checkout endpoint',
          description: '',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/checkout/checkout-api',
          branchType: 'feature',
          branchSlug: 'checkout-api',
          projectId: 'project-2',
          projectIds: ['project-2'],
        },
      ],
      predictedBranches: [],
    });
    architectPlans.set(activePlan.id, activePlan);
    appState.activeArchitectPlanId = activePlan.id;
    appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop' };

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Patch the active strategy.',
    });
    updateArchitectPlanMock.mockClear();

    await onToolCall('strategy_update', {
      operations: [
        {
          action: 'update',
          node_id: 'task-api',
          description: 'Updated endpoint scope',
        },
        {
          action: 'add',
          title: 'API telemetry',
          featureSlug: 'api-telemetry',
          projectIds: ['project-2'],
        },
        {
          action: 'add',
          title: 'Checkout docs',
          featureSlug: 'checkout-docs',
        },
      ],
    });

    const lastCall = ((updateArchitectPlanMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
    const updatedNodes = (lastCall.nodes as Array<Record<string, unknown>>) ?? [];
    const predictedBranches = (lastCall.predictedBranches as Array<Record<string, unknown>>) ?? [];

    expect(updatedNodes.find((node) => node.id === 'task-api')).toMatchObject({
      projectId: 'project-2',
      projectIds: ['project-2'],
    });
    expect(updatedNodes.find((node) => node.title === 'API telemetry')).toMatchObject({
      projectId: 'project-2',
      projectIds: ['project-2'],
    });
    expect(updatedNodes.find((node) => node.title === 'Checkout docs')).toMatchObject({
      projectId: 'project-1',
      projectIds: ['project-1', 'project-2'],
    });

    expect(predictedBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: 'project-1',
          name: 'feature/checkout/checkout-web',
          branchSlug: 'checkout-web',
        }),
        expect.objectContaining({
          projectId: 'project-2',
          name: 'feature/checkout/checkout-api',
          branchSlug: 'checkout-api',
        }),
        expect.objectContaining({
          projectId: 'project-2',
          name: 'feature/checkout/api-telemetry',
          branchSlug: 'api-telemetry',
        }),
        expect.objectContaining({
          projectId: 'project-1',
          name: 'feature/checkout/checkout-docs',
          branchSlug: 'checkout-docs',
        }),
        expect.objectContaining({
          projectId: 'project-2',
          name: 'feature/checkout/checkout-docs',
          branchSlug: 'checkout-docs',
        }),
      ]),
    );
    expect(
      predictedBranches.some(
        (branch) =>
          branch.projectId === 'project-1' &&
          branch.branchSlug === 'checkout-api',
      ),
    ).toBe(false);
    expect(
      predictedBranches.some(
        (branch) =>
          branch.projectId === 'project-1' &&
          branch.branchSlug === 'api-telemetry',
      ),
    ).toBe(false);
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

  it('requests one repair attempt for frozen-node conflicts and blocks on the second invalid update', async () => {
    const activePlan = createPlan({
      id: 'started-plan',
      conversationId: 'plan-conv',
      status: 'draft',
      nodes: [
        {
          id: 'task-a',
          title: 'Prepare schema',
          description: '',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/prepare-schema',
          branchType: 'feature',
          branchSlug: 'prepare-schema',
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
        {
          id: 'task-b',
          title: 'Build endpoint',
          description: '',
          type: 'task',
          status: 'in-progress',
          dependencies: ['task-a'],
          assignedBranch: 'feature/build-endpoint',
          branchType: 'feature',
          branchSlug: 'build-endpoint',
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
      ],
    });
    architectPlans.set(activePlan.id, activePlan);
    appState.activeArchitectPlanId = activePlan.id;
    appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop' };
    taskStoreState.tasks = [
      createImplementTask({
        id: 'task-a',
        title: 'Prepare schema',
        status: 'Pending',
        plan_id: activePlan.id,
        assigned_branch: 'feature/prepare-schema',
        branch_name: 'feature/prepare-schema',
      }),
      createImplementTask({
        id: 'task-b',
        title: 'Build endpoint',
        status: 'InProgress',
        plan_id: activePlan.id,
        assigned_branch: 'feature/build-endpoint',
        branch_name: 'feature/build-endpoint',
        dependencies: ['task-a'],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    setArchitectStoreState(useChatStore, {
      conversations: [createConversation('plan-conv')],
    });

    const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
      conversationId: 'plan-conv',
      content: 'Update the active strategy.',
    });
    updateArchitectPlanMock.mockClear();

    const firstResult = await onToolCall('strategy_update', {
      replace: true,
      nodes: [
        {
          id: 'task-a',
          title: 'Prepare schema',
          dependencies: [],
          status: 'pending',
        },
        {
          id: 'task-b',
          title: 'Build endpoint',
          description: 'Changed frozen description',
          dependencies: ['task-a'],
          status: 'in-progress',
        },
      ],
    });

    expect(String(firstResult)).toContain('repair_requested');
    expect(appState.strategyMutationPreview).toBeNull();
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();

    const secondResult = await onToolCall('strategy_update', {
      replace: true,
      nodes: [
        {
          id: 'task-a',
          title: 'Prepare schema',
          dependencies: [],
          status: 'pending',
        },
        {
          id: 'task-b',
          title: 'Build endpoint',
          description: 'Changed frozen description',
          dependencies: ['task-a'],
          status: 'in-progress',
        },
      ],
    });

    expect(String(secondResult)).toContain('"action": "blocked"');
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(appState.strategyMutationPreview).not.toBeNull();
    expect((appState.strategyMutationPreview as { status: string }).status).toBe('blocked');
  });

  it('launches Architect conversations with the plan explorer internal profile', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    localStorage.setItem(
      'macro_promptPlanExplorer',
      JSON.stringify('Custom PLAN_EXPLORER prompt for tests.')
    );

    const { useChatStore } = await loadChatStore();
    activateArchitectPlanForTest({ conversationId: 'plan-conv' });
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
    expect(streamOptions.allowedToolIds).not.toContain('mark_source_passage');
    expect(streamOptions.allowedToolIds).not.toContain('read_sources');
    expect(streamOptions.allowedToolIds).not.toContain('edit_source_passage');
    expect(streamOptions.allowedToolIds).toContain('plan_get');
    expect(streamOptions.allowedToolIds).toContain('strategy_update');
    expect(streamOptions.allowedToolIds).toContain('strategy_delete');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'Custom PLAN_EXPLORER prompt for tests.'
    );
  });

  it('removes strategy mutation tools from Architect turns after plan validation', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;

    const { useChatStore } = await loadChatStore();
    activateArchitectPlanForTest({ conversationId: 'plan-conv', status: 'validated' });
    appState.activePlanContext = {
      ...(appState.activePlanContext || { id: 'plan-1', targetBranch: 'develop' }),
      status: 'validated',
    };
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
      content: 'Analyse la stratégie validée.',
    });

    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      allowedToolIds: string[];
    };
    expect(streamOptions.allowedToolIds).toContain('strategy_get');
    expect(streamOptions.allowedToolIds).not.toContain('strategy_generate');
    expect(streamOptions.allowedToolIds).not.toContain('strategy_update');
    expect(streamOptions.allowedToolIds).not.toContain('strategy_delete');
  });

  it('migrates the legacy guarded autonomy profile to strict tool risk filtering', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    localStorage.setItem(
      'macro_architectToolAutonomyProfile',
      JSON.stringify('guarded')
    );

    const { useChatStore } = await loadChatStore();
    activateArchitectPlanForTest({ conversationId: 'plan-conv' });
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
      content: 'Analyse le plan actif.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      allowedToolIds: string[];
    };
    expect(streamOptions.allowedToolIds).not.toContain('strategy_delete');
  });

  it('keeps Architect action tools available for Copilot in strict mode', async () => {
    providerState.providerConfigs = [
      {
        id: 'copilot',
        name: 'GitHub Copilot',
        providerType: 'copilot',
        isEnabled: true,
        isLocal: false,
        hasStoredApiKey: false,
        apiKeyLoaded: false,
        apiKey: '',
      },
    ];
    providerState.selectedProviderId = 'copilot';
    providerState.selectedModelId = 'claude-haiku-4.5';
    providerState.modelsByProvider = {
      copilot: [{ id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', isEnabled: true }],
    };
    providerState.selectedSupportsNativeToolCalling = () => true;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('strict'));

    const { useChatStore } = await loadChatStore();
    activateArchitectPlanForTest({ conversationId: 'plan-conv' });
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
      content: 'Génère la stratégie depuis notre conversation.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      allowedToolIds: string[];
    };
    expect(streamOptions.allowedToolIds).toContain('strategy_generate');
    expect(streamOptions.allowedToolIds).toContain('plan_update');
    expect(streamOptions.allowedToolIds).not.toContain('strategy_delete');
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

  it('passes enabled discovered MCP tools through Chat mode streaming options', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    toolsStoreState.getEnabledMCPToolIds = () => ['mcp__github__list_issues'];
    toolsStoreState.getEnabledMCPTools = () => [
      {
        id: 'mcp__github__list_issues',
        serverId: 'github',
        name: 'list_issues',
        description: 'List issues',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv')],
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
      content: 'Use GitHub context.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      allowedToolIds: string[];
      mcpTools?: Array<{ id: string }>;
    };
    expect(streamOptions.allowedToolIds).toContain('mcp__github__list_issues');
    expect(streamOptions.mcpTools?.map((tool) => tool.id)).toEqual([
      'mcp__github__list_issues',
    ]);
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
        "Pose-moi des questions pour choisir ma couleur préférée, utilise l'outil Question.",
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
        "Pose-moi des questions pour choisir ma couleur préférée, utilise l'outil Question.",
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

  it('reads the full attached file content through the chat read_file tool', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    citationRecords.push({
      id: 'context-file',
      type: 'file',
      scope: 'context',
      source: 'notes.md',
      title: 'notes.md',
      snippet: 'Short preview',
      content: 'Short preview plus the full attached file body.',
      path: 'notes.md',
      messageId: 'manual-file',
      conversationId: 'chat-conv',
      timestamp: '2026-03-19T00:00:00.000Z',
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
      content: 'Lis le fichier attache.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
    };
    const result = await streamOptions.onToolCall?.('read_file', { file: 'notes.md' }, 'call-read');

    expect(String(result)).toContain('FILE: notes.md');
    expect(String(result)).toContain('full attached file body');
  });

  it('persists slash-tagged file refs and reads their workspace content lazily', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = 'group-1';
    appState.selectedProjectId = 'project-1';
    const fileRef: WorkspaceFileReference = {
      id: 'file:project-1:src/App.tsx',
      path: 'src/App.tsx',
      relativePath: 'src/App.tsx',
      projectId: 'project-1',
      projectName: 'Web',
      language: 'typescript',
      sizeBytes: 120,
      modified: '2026-03-19T00:00:00.000Z',
      isFocused: true,
    };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          id: 'chat-conv',
          title: 'Conversation chat-conv',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: 'group-1',
          project_id: 'project-1',
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
      composerContextRefs: [{
        id: fileRef.id,
        kind: 'file',
        title: fileRef.path,
        data: fileRef,
      } satisfies ContextReference],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Regarde [file: src/App.tsx] avant de répondre.',
    });

    const userMessage = useChatStore
      .getState()
      .messages.find((message: ChatMessage) => message.role === 'user');
    expect(userMessage?.context_refs).toEqual([
      expect.objectContaining({
        kind: 'file',
        title: 'src/App.tsx',
        path: 'src/App.tsx',
        relativePath: 'src/App.tsx',
        projectId: 'project-1',
        projectName: 'Web',
      }),
    ]);

    const lightweightCitation = citationRecords.find(
      (citation) =>
        citation.type === 'file' &&
        citation.scope === 'context' &&
        citation.path === 'src/App.tsx',
    );
    expect(lightweightCitation).toBeDefined();
    expect(lightweightCitation?.content).toBeUndefined();
    expect(lightweightCitation?.snippet).toBeUndefined();

    const streamOptions = getLatestStreamOptions<{
      messages: Array<{ role: string; content: unknown }>;
      fileToolContext?: Array<{ path?: string; content?: string; snippet?: string }>;
      onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
    }>();
    expect(JSON.stringify(streamOptions.messages)).toContain(
      'Content: not preloaded. Use read_file with this exact path before analyzing file contents.',
    );
    expect(streamOptions.fileToolContext).toContainEqual(
      expect.objectContaining({
        path: 'src/App.tsx',
        content: undefined,
        snippet: undefined,
      }),
    );

    const result = await streamOptions.onToolCall?.(
      'read_file',
      { file: 'src/App.tsx' },
      'call-read-file-ref',
    );

    const readArgs = fsReadFileWithOptionsMock.mock.calls[0]?.[0];
    expect(readArgs).toEqual(expect.objectContaining({
      path: 'src/App.tsx',
      allowOutsideWorkspace: false,
    }));
    expect(readArgs?.workspacePath).toContain('/repos/web');
    expect(String(result)).toContain('FILE: src/App.tsx');
    expect(String(result)).toContain('SOURCE: WORKSPACE');
    expect(String(result)).toContain('Workspace file body from disk.');
  });

  it('persists source composer refs and injects the full passage', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    const sourceCitation: Citation = {
      id: 'source-ref-1',
      type: 'source_passage',
      scope: 'source',
      source: 'Research notes',
      title: 'Retention insight',
      snippet: 'Short retained excerpt.',
      content: 'Full retained source passage with the detail the model needs.',
      messageId: 'assistant-source',
      conversationId: 'chat-conv',
      timestamp: '2026-03-19T00:00:00.000Z',
      url: 'https://example.com/source',
      kind: 'interesting',
      reason: 'Useful for the next answer',
    };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      composerContextRefs: [{
        id: sourceCitation.id,
        kind: 'source',
        title: sourceCitation.title,
        subtitle: sourceCitation.source,
        data: sourceCitation,
      } satisfies ContextReference],
    }));

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Utilise cette source.',
    });

    const userMessage = useChatStore
      .getState()
      .messages.find((message: ChatMessage) => message.role === 'user');
    expect(userMessage?.context_refs).toEqual([
      expect.objectContaining({
        id: 'source-ref-1',
        kind: 'source',
        title: 'Retention insight',
        subtitle: 'Research notes',
        snippet: 'Full retained source passage with the detail the model needs.',
        sourceLabel: 'Research notes',
        url: 'https://example.com/source',
      }),
    ]);

    const streamOptions = getLatestStreamOptions<{
      messages: Array<{ role: string; content: unknown }>;
    }>();
    const requestContent = String(streamOptions.messages.at(-1)?.content ?? '');
    expect(requestContent).toContain('[source: Retention insight]');
    expect(requestContent).toContain(
      'Passage: Full retained source passage with the detail the model needs.',
    );
    expect(requestContent).toContain('Source: Research notes');
    expect(requestContent).toContain('URL: https://example.com/source');
  });

  it('preloads explicit skill mentions and keeps the compact enabled skill catalog', async () => {
    tauriAvailable = true;
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;

    const { useChatStore } = await loadChatStore();
    const { useSkillsStore } = await import('./useSkillsStore');
    const skill: SkillManifest = {
      id: 'project:project-1:agents:docs:aaa111',
      name: 'docs',
      description: 'Use the local documentation style.',
      rootPath: '/repos/web/.agents/skills/docs',
      skillFilePath: '/repos/web/.agents/skills/docs/SKILL.md',
      source: {
        kind: 'project',
        namespace: 'agents',
        projectId: 'project-1',
        projectName: 'Web',
        rootPath: '/repos/web',
        skillRootPath: '/repos/web/.agents/skills',
      },
      resources: [{ path: 'references/style.md', kind: 'reference', sizeBytes: 120 }],
      scripts: [{ path: 'scripts/check.sh', kind: 'script', sizeBytes: 80 }],
      validationErrors: [],
      isValid: true,
    };
    useSkillsStore.setState({
      skills: [skill],
      settingsBySkillId: {
        [skill.id]: { enabled: true, scriptsEnabled: false },
      },
    });
    installSkillActivationMock(useSkillsStore);
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
      content: 'Utilise $docs pour cette réponse. FULL BODY SHOULD NOT BE IN CATALOG',
    });

    const streamOptions = getLatestStreamOptions<{
      allowedToolIds: string[];
      skillToolIds: string[];
      runnableSkillToolIds: string[];
      messages: Array<{ role: string; content: unknown }>;
    }>();
    const serializedMessages = JSON.stringify(streamOptions.messages);
    expect(streamOptions.allowedToolIds).toContain('skill_activate');
    expect(streamOptions.allowedToolIds).toContain('skill_read_resource');
    expect(streamOptions.allowedToolIds).not.toContain('skill_run_script');
    expect(serializedMessages).toContain('Available Macro skills');
    expect(serializedMessages).toContain('id=project:project-1:agents:docs:aaa111');
    expect(serializedMessages).toContain('<skill_content name=\\"docs\\"');
    expect(serializedMessages).toContain('The user explicitly referenced these enabled skills');
    expect(serializedMessages).toContain('# Instructions');
  });

  it('keeps locked skill tools available even when hidden from chat toolbox settings', async () => {
    tauriAvailable = true;
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    toolsStoreState.getEnabledChatToolIds = () => ['read_file', 'web_search', 'web_fetch'];

    const { useChatStore } = await loadChatStore();
    const { useSkillsStore } = await import('./useSkillsStore');
    const skill: SkillManifest = {
      id: 'global:agents:test-skill:aaa111',
      name: 'test-skill',
      description: 'Skill de test pour vérifier l’activation dans Macro.',
      rootPath: '/Users/test/.agents/skills/test-skill',
      skillFilePath: '/Users/test/.agents/skills/test-skill/SKILL.md',
      source: {
        kind: 'global',
        namespace: 'agents',
        projectId: null,
        projectName: null,
        rootPath: '/Users/test/.agents/skills',
        skillRootPath: '/Users/test/.agents/skills',
      },
      resources: [],
      scripts: [{ path: 'scripts/check.sh', kind: 'script', sizeBytes: 80 }],
      validationErrors: [],
      isValid: true,
    };
    useSkillsStore.setState({
      skills: [skill],
      settingsBySkillId: {
        [skill.id]: { enabled: true, scriptsEnabled: true },
      },
    });
    installSkillActivationMock(useSkillsStore);
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
      content: 'Utilise $test-skill et lance son check.sh.',
    });

    const streamOptions = getLatestStreamOptions<{
      allowedToolIds: string[];
      skillToolIds: string[];
      runnableSkillToolIds: string[];
      messages: Array<{ role: string; content: unknown }>;
    }>();
    const serializedMessages = JSON.stringify(streamOptions.messages);

    expect(streamOptions.allowedToolIds).toContain('skill_activate');
    expect(streamOptions.allowedToolIds).toContain('skill_read_resource');
    expect(streamOptions.allowedToolIds).toContain('skill_run_script');
    expect(streamOptions.skillToolIds).toEqual([skill.id]);
    expect(streamOptions.runnableSkillToolIds).toEqual([skill.id]);
    expect(serializedMessages).toContain('Available Macro skills');
    expect(serializedMessages).toContain('id=global:agents:test-skill:aaa111');
    expect(serializedMessages).toContain('<skill_content name=\\"test-skill\\"');
    expect(serializedMessages).toContain('call skill_activate with the exact id');
    expect(serializedMessages).toContain('The user explicitly referenced these enabled skills');
  });

  it('preloads only explicit skills without native tool calling', async () => {
    providerState.selectedSupportsNativeToolCalling = () => false;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    const skill = createSkillManifest();

    const { useChatStore } = await loadChatStore();
    const { useSkillsStore } = await import('./useSkillsStore');
    useSkillsStore.setState({
      skills: [skill],
      settingsBySkillId: {
        [skill.id]: { enabled: true, scriptsEnabled: false },
      },
    });
    installSkillActivationMock(useSkillsStore);
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
      composerContextRefs: [{
        id: skill.id,
        kind: 'skill',
        title: skill.name,
        data: skill,
      }],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Utilise $test-skill.',
    });

    const streamOptions = getLatestStreamOptions<{
      allowedToolIds: string[];
      skillToolIds: string[];
      runnableSkillToolIds: string[];
      messages: Array<{ role: string; content: unknown }>;
    }>();
    const serializedMessages = JSON.stringify(streamOptions.messages);

    expect(streamOptions.allowedToolIds).toEqual([]);
    expect(serializedMessages).not.toContain('Available Macro skills');
    expect(serializedMessages).not.toContain('Activation: call skill_activate');
    expect(serializedMessages).toContain('Skill ID: global:agents:test-skill:aaa111');
    expect(serializedMessages).toContain('<skill_content name=\\"test-skill\\"');
    expect(serializedMessages).toContain('# Instructions');
  });

  it('keeps skill read tools but blocks skill scripts in strict risk mode', async () => {
    tauriAvailable = true;
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('strict'));
    const skill = createSkillManifest();

    const { useChatStore } = await loadChatStore();
    const { useSkillsStore } = await import('./useSkillsStore');
    useSkillsStore.setState({
      skills: [skill],
      settingsBySkillId: {
        [skill.id]: { enabled: true, scriptsEnabled: true },
      },
    });
    installSkillActivationMock(useSkillsStore);
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
      content: 'Utilise $test-skill.',
    });

    const streamOptions = getLatestStreamOptions<{
      allowedToolIds: string[];
      skillToolIds: string[];
      runnableSkillToolIds: string[];
      messages: Array<{ role: string; content: unknown }>;
    }>();
    const serializedMessages = JSON.stringify(streamOptions.messages);

    expect(streamOptions.allowedToolIds).toContain('skill_activate');
    expect(streamOptions.allowedToolIds).toContain('skill_read_resource');
    expect(streamOptions.allowedToolIds).not.toContain('skill_run_script');
    expect(streamOptions.skillToolIds).toEqual([skill.id]);
    expect(streamOptions.runnableSkillToolIds).toEqual([]);
    expect(serializedMessages).toContain('Available Macro skills');
  });

  it('routes skill tool calls through the skills store', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));

    const { useChatStore } = await loadChatStore();
    const { useSkillsStore } = await import('./useSkillsStore');
    const skill = createSkillManifest({
      id: 'project:project-1:docs',
      name: 'docs',
      source: {
        kind: 'project',
        namespace: 'agents',
        projectId: 'project-1',
        projectName: 'Web',
        rootPath: '/repos/web',
        skillRootPath: '/repos/web/.agents/skills',
      },
    });
    const activateSkill = mock(async (_skillId: string, _conversationId?: string) => 'activated docs');
    const readSkillResource = mock(async (_skillId: string, _path: string) => 'resource content');
    const runSkillScript = mock(async (_request: unknown, _snapshot?: unknown) => 'script result');
    useSkillsStore.setState({
      skills: [skill],
      settingsBySkillId: {
        [skill.id]: { enabled: true, scriptsEnabled: true },
      },
      activateSkill,
      readSkillResource,
      runSkillScript,
    });
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
      content: 'Use the docs skill.',
    });

    const streamOptions = getLatestStreamOptions<{
      onToolCall?: (
        toolName: string,
        args: Record<string, unknown>,
        toolCallId?: string,
      ) => Promise<unknown>;
    }>();
    expect(streamOptions.onToolCall).toBeDefined();
    if (!streamOptions.onToolCall) {
      throw new Error('Expected skill tool handler');
    }

    await expect(streamOptions.onToolCall(
      'skill_activate',
      { skill_id: 'project:project-1:docs' },
      'call-activate',
    )).resolves.toBe('activated docs');
    await expect(streamOptions.onToolCall(
      'skill_read_resource',
      { skill_id: 'project:project-1:docs', path: 'references/style.md' },
      'call-resource',
    )).resolves.toBe('resource content');
    await expect(streamOptions.onToolCall(
      'skill_run_script',
      {
        skill_id: 'project:project-1:docs',
        script_path: 'scripts/check.sh',
        args: ['--check'],
        timeout_ms: 1_000,
        allow_workspace: true,
      },
      'call-script',
    )).resolves.toBe('script result');

    expect(activateSkill).toHaveBeenCalledWith('project:project-1:docs', 'chat-conv');
    expect(readSkillResource).toHaveBeenCalledWith(
      'project:project-1:docs',
      'references/style.md',
    );
    expect(runSkillScript.mock.calls[0]?.[0]).toEqual({
      skillId: 'project:project-1:docs',
      scriptPath: 'scripts/check.sh',
      args: ['--check'],
      timeoutMs: 1_000,
      allowWorkspace: true,
    });
    expect(runSkillScript.mock.calls[0]?.[1]).toMatchObject({
      conversationId: 'chat-conv',
      skills: {
        [skill.id]: {
          enabled: true,
          scriptsEnabled: true,
          hasScripts: true,
        },
      },
    });
  });

  it('persists, reads, updates, reclassifies, and deletes chat source passages', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));

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
      content: 'Garde les sources importantes.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
    };

    citationRecords.push({
      id: createCitationId(),
      type: 'file',
      scope: 'context',
      source: 'notes.md',
      title: 'notes.md',
      snippet: 'Macro keeps source passages in the chat conversation.',
      content: 'Macro keeps source passages in the chat conversation.',
      messageId: 'context-message',
      conversationId: 'chat-conv',
      timestamp: new Date().toISOString(),
      path: 'notes.md',
    });

    const markResult = await streamOptions.onToolCall?.(
      'mark_source_passage',
      {
        title: 'Important fact',
        passage: 'Macro keeps source passages in the chat conversation.',
        kind: 'used',
        source: 'notes.md',
      },
      'call-source',
    );
    const citationId = citationRecords.find((citation) => citation.scope === 'source')?.id;
    expect(String(markResult)).toContain('Source passage marked successfully');
    expect(citationId).toBeTruthy();

    const readResult = await streamOptions.onToolCall?.('read_sources', {}, 'call-read-sources');
    expect(String(readResult)).toContain(String(citationId));
    expect(String(readResult)).toContain('Macro keeps source passages');

    await streamOptions.onToolCall?.(
      'edit_source_passage',
      {
        citation_id: citationId,
        action: 'update',
        title: 'Updated fact',
        passage: 'Updated source passage.',
      },
      'call-update-source',
    );
    expect(citationRecords.find((citation) => citation.id === citationId)?.title).toBe('Updated fact');

    await streamOptions.onToolCall?.(
      'edit_source_passage',
      {
        citation_id: citationId,
        action: 'reclassify',
        kind: 'interesting',
      },
      'call-reclassify-source',
    );
    expect(citationRecords.find((citation) => citation.id === citationId)?.kind).toBe('interesting');

    await streamOptions.onToolCall?.(
      'edit_source_passage',
      {
        citation_id: citationId,
        action: 'delete',
      },
      'call-delete-source',
    );
    expect(citationRecords.some((citation) => citation.id === citationId)).toBe(false);
  });

  it('rejects chat source passages that are absent from read source content', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));

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
      content: 'Garde les sources importantes.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
    };

    const markResult = await streamOptions.onToolCall?.(
      'mark_source_passage',
      {
        title: 'Unsupported fact',
        passage: 'This passage was never present in a read source.',
        kind: 'used',
        source: 'missing.md',
      },
      'call-source',
    );

    expect(markResult).toBe(
      'Error executing tool mark_source_passage: passage is not present in any read source content.',
    );
    expect(citationRecords.some((citation) => citation.scope === 'source')).toBe(false);
  });

  it('marks chat source passages from context snippets without loading full content', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));

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
      content: 'Garde les sources importantes.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
    };

    citationRecords.push(
      {
        id: 'context-snippet',
        type: 'file',
        scope: 'context',
        source: 'notes.md',
        title: 'notes.md',
        snippet: 'Snippet provenance is enough for this passage.',
        messageId: 'context-message',
        conversationId: 'chat-conv',
        timestamp: '2026-03-19T00:00:00.000Z',
        path: 'notes.md',
      },
      {
        id: 'context-extra',
        type: 'file',
        scope: 'context',
        source: 'other.md',
        title: 'other.md',
        snippet: 'Other snippet',
        messageId: 'context-message',
        conversationId: 'chat-conv',
        timestamp: '2026-03-19T00:00:01.000Z',
        path: 'other.md',
      },
    );
    ensureCitationContentLoadedMock.mockClear();

    const markResult = await streamOptions.onToolCall?.(
      'mark_source_passage',
      {
        title: 'Snippet fact',
        passage: 'provenance is enough',
        kind: 'used',
        source: 'notes.md',
      },
      'call-source-snippet',
    );

    expect(String(markResult)).toContain('Source passage marked successfully');
    expect(ensureCitationContentLoadedMock).not.toHaveBeenCalled();
  });

  it('stops loading context citations after the first lazy source passage match', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));

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
      content: 'Garde les sources importantes.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
    };

    citationRecords.push(
      {
        id: 'context-first',
        type: 'file',
        scope: 'context',
        source: 'first.md',
        title: 'first.md',
        snippet: 'Light preview only',
        messageId: 'context-message',
        conversationId: 'chat-conv',
        timestamp: '2026-03-19T00:00:00.000Z',
        path: 'first.md',
      },
      {
        id: 'context-second',
        type: 'file',
        scope: 'context',
        source: 'second.md',
        title: 'second.md',
        snippet: 'Another preview only',
        messageId: 'context-message',
        conversationId: 'chat-conv',
        timestamp: '2026-03-19T00:00:01.000Z',
        path: 'second.md',
      },
    );
    ensureCitationContentLoadedMock.mockClear();
    ensureCitationContentLoadedMock.mockImplementation(async (id: string) => {
      const citation = citationRecords.find((candidate) => candidate.id === id) ?? null;
      if (!citation) return null;
      if (id === 'context-first') {
        citation.content = 'The full body contains the durable passage.';
      }
      return citation;
    });

    const markResult = await streamOptions.onToolCall?.(
      'mark_source_passage',
      {
        title: 'Lazy fact',
        passage: 'durable passage',
        kind: 'used',
        source: 'first.md',
      },
      'call-source-lazy',
    );

    expect(String(markResult)).toContain('Source passage marked successfully');
    expect(ensureCitationContentLoadedMock).toHaveBeenCalledTimes(1);
    expect(ensureCitationContentLoadedMock).toHaveBeenCalledWith('context-first');
  });

  it('limits chat source reads before loading source passage content', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));

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
      content: 'Relis les sources.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
    };

    citationRecords.push(
      {
        id: 'source-new',
        type: 'source_passage',
        scope: 'source',
        source: 'new.md',
        title: 'Newest source',
        snippet: 'Newest preview',
        messageId: 'assistant-new',
        conversationId: 'chat-conv',
        timestamp: '2026-03-19T00:02:00.000Z',
        kind: 'used',
      },
      {
        id: 'source-old',
        type: 'source_passage',
        scope: 'source',
        source: 'old.md',
        title: 'Old source',
        snippet: 'Old preview',
        messageId: 'assistant-old',
        conversationId: 'chat-conv',
        timestamp: '2026-03-19T00:01:00.000Z',
        kind: 'used',
      },
    );
    ensureCitationContentLoadedMock.mockClear();
    ensureCitationContentLoadedMock.mockImplementation(async (id: string) => {
      const citation = citationRecords.find((candidate) => candidate.id === id) ?? null;
      if (citation) {
        citation.content = `Full content for ${citation.title}`;
      }
      return citation;
    });

    const readResult = await streamOptions.onToolCall?.(
      'read_sources',
      { limit: 1 },
      'call-read-limited-sources',
    );

    expect(ensureCitationContentLoadedMock).toHaveBeenCalledTimes(1);
    expect(ensureCitationContentLoadedMock).toHaveBeenCalledWith('source-new');
    expect(String(readResult)).toContain('source-new');
    expect(String(readResult)).not.toContain('source-old');
  });

  it('executes chat web search and fetch tools through the app handler', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    streamingWebSearchConfig = {
      enableWebSearch: true,
      enableWebFetch: true,
      webSearchOptions: {
        provider: 'tavily',
        tavilyApiKey: 'tvly-test',
        braveApiKey: '',
        maxResults: 5,
      },
    };

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
      content: 'Cherche puis ouvre une page.',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
    };

    const searchResult = await streamOptions.onToolCall?.(
      'web_search',
      { query: 'Macro chat sources' },
      'call-web-search',
    );
    expect(webSearchMock).toHaveBeenCalledWith(
      'Macro chat sources',
      streamingWebSearchConfig.webSearchOptions,
    );
    expect(String(searchResult)).toContain('Search Result');
    expect(citationRecords.some((citation) => citation.url === 'https://example.com/search-result')).toBe(true);

    const fetchResult = await streamOptions.onToolCall?.(
      'web_fetch',
      { url: 'https://example.com/page' },
      'call-web-fetch',
    );
    expect(fetchWebPageMock).toHaveBeenCalledWith('https://example.com/page');
    expect(String(fetchResult)).toContain('Fetched full page content');
    expect(citationRecords.some((citation) => citation.content === 'Fetched full page content.')).toBe(true);

    const markResult = await streamOptions.onToolCall?.(
      'mark_source_passage',
      {
        title: 'Fetched page',
        passage: 'Fetched full page content.',
        kind: 'used',
        url: 'https://example.com/page',
      },
      'call-mark-web-source',
    );
    expect(String(markResult)).toContain('Source passage marked successfully');
    expect(
      citationRecords.some(
        (citation) =>
          citation.scope === 'source' &&
          citation.title === 'Fetched page' &&
          citation.snippet === 'Fetched full page content.',
      ),
    ).toBe(true);
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

  it('restores an implement task from local project context before selecting its conversation', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = null;
    taskStoreState.tasks = [
      createImplementTask({ id: 'task-1', status: 'Pending' }),
      createImplementTask({
        id: 'task-2',
        title: 'Implement search',
        status: 'InProgress',
        sequence_index: 1,
      }),
    ];
    getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
      architectConversationId: null,
      implementConversationId: 'implement-task-1',
      lastTaskId: 'task-1',
    }));

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-task-1'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
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

    expect(appState.selectedTaskId as string | null).toBe('task-1');
    expect(ensuredId).toBe('implement-task-1');
    expect(useChatStore.getState().selectedConversationId).toBe('implement-task-1');
  });

  it('restores an in-progress implement task when no local task context exists', async () => {
    const originalNow = Date.now;
    Date.now = () => 1773930000000;

    try {
      appState.mode = 'Implement';
      appState.selectedTaskId = null;
      taskStoreState.tasks = [
        createImplementTask({ id: 'task-pending', status: 'Pending', sequence_index: 0 }),
        createImplementTask({
          id: 'task-active',
          title: 'Implement active task',
          status: 'InProgress',
          sequence_index: 1,
        }),
      ];
      getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
        architectConversationId: null,
        implementConversationId: null,
        lastTaskId: null,
      }));

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

      const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();
      const conversation = useChatStore
        .getState()
        .conversations.find((candidate: Conversation) => candidate.id === ensuredId);

      expect(appState.selectedTaskId as string | null).toBe('task-active');
      expect(conversation?.task_id).toBe('task-active');
      expect(conversation?.title).toBe('Task - Implement active task');
    } finally {
      Date.now = originalNow;
    }
  });

  it('clears implement selection and does not create a conversation when no task is eligible for the current scope', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = null;
    taskStoreState.tasks = [
      createImplementTask({
        id: 'task-outside-scope',
        project_id: 'project-elsewhere',
        project_ids: ['project-elsewhere'],
      }),
    ];
    getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
      architectConversationId: null,
      implementConversationId: null,
      lastTaskId: 'task-outside-scope',
    }));

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

    const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();

    expect(ensuredId).toBeNull();
    expect(appState.selectedTaskId).toBeNull();
    expect(useChatStore.getState().selectedConversationId).toBeNull();
    expect(useChatStore.getState().selectedConversationIdsByMode.Implement ?? null).toBeNull();
    expect(useChatStore.getState().conversations).toHaveLength(0);
    expect(
      useChatStore
        .getState()
        .conversations.some((conversation: Conversation) => Boolean(conversation.task_id))
    ).toBe(false);
  });

  it('clears a previously selected taskless implement conversation when no tasks are available', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = null;
    taskStoreState.tasks = [];
    getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
      architectConversationId: null,
      implementConversationId: 'debug-conv',
      lastTaskId: null,
    }));

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('debug-conv'),
          scope_mode: 'Implement',
          task_id: null,
          title: 'Repository review',
        },
      ],
      messages: [],
      selectedConversationId: 'debug-conv',
      selectedConversationIdsByMode: { Implement: 'debug-conv' },
      isLoading: false,
      isStreaming: false,
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();

    expect(ensuredId).toBeNull();
    expect(useChatStore.getState().selectedConversationId).toBeNull();
    expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBeNull();
    expect(useChatStore.getState().conversations).toHaveLength(1);
  });

  it('syncs the selected task when an existing implement conversation is restored', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = null;
    taskStoreState.tasks = [createImplementTask({ id: 'task-1' })];
    getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
      architectConversationId: null,
      implementConversationId: 'implement-conv',
      lastTaskId: null,
    }));

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

    expect(ensuredId).toBe('implement-conv');
    expect(appState.selectedTaskId as string | null).toBe('task-1');
    expect(useChatStore.getState().selectedConversationId).toBe('implement-conv');
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

      expect(useChatStore.getState().selectedConversationId).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBeNull();

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
    providerState.providerConfigs = [
      ...providerState.providerConfigs,
      {
        id: 'provider-2',
        name: 'Metadata Provider',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      },
    ];
    providerState.modelsByProvider = {
      ...providerState.modelsByProvider,
      'provider-2': [{ id: 'metadata-model', name: 'Metadata Model', isEnabled: true }],
    };
    localStorage.setItem(
      'macro_metadataModelConfig',
      JSON.stringify({
        mode: 'dedicated',
        providerId: 'provider-2',
        modelId: 'metadata-model',
        reasoningEffort: null,
      })
    );

    queueSendChatNonStreamingImplementation(async () =>
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
    expect(sendChatNonStreamingMock.mock.calls[0]?.[0]).toMatchObject({
      providerId: 'provider-2',
      modelId: 'metadata-model',
    });
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

  it('keeps a standalone manual feature initialized after assistant generation fails, then retries as an in-progress task', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [createManualFeatureTask()];

    queueSendChatNonStreamingImplementation(async () =>
      JSON.stringify({
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
        featureSlug: 'quick-export',
      })
    );

    streamChatMock
      .mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onError?: (error: Error) => void;
        };
        options.onError?.(new Error('Assistant unavailable.'));
        return { usage: null };
      }) as unknown as typeof streamChatMock)
      .mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: string;
            usage: null;
          }) => void;
        };
        options.onComplete?.({
          visibleContent: 'C’est reparti.',
          toolTraces: [],
          hiddenContext: undefined,
          usage: null,
        });
        return { usage: null };
      }) as unknown as typeof streamChatMock);

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

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(taskStoreState.revertManualFeatureToDraft).not.toHaveBeenCalled();
    expect(taskStoreState.markTaskFailed).toHaveBeenCalledWith('manual-task-1');
    expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
      draft: false,
      status: 'Failed',
      feature_slug: 'quick-export',
      branch_name: 'feature/quick-export',
    });
    expect(
      useChatStore.getState().conversations.find((conversation: Conversation) => conversation.id === 'manual-conv')
    ).toMatchObject({
      title: 'Quick export',
      description: 'Add a quick CSV export from the table.',
    });

    const firstUserMessage = useChatStore
      .getState()
      .getConversationMessages('manual-conv')
      .find((message: { role: string }) => message.role === 'user');
    expect(firstUserMessage).toBeDefined();

    await useChatStore.getState().editMessage(
      (firstUserMessage as { id: string }).id,
      (firstUserMessage as { content: string }).content,
    );

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
    expect(taskStoreState.retryTask).toHaveBeenCalledWith('manual-task-1');
    expect(taskStoreState.finalizeManualFeatureDraft).toHaveBeenLastCalledWith({
      taskId: 'manual-task-1',
      conversationId: 'manual-conv',
      title: 'Quick export',
      description: 'Add a quick CSV export from the table.',
      featureSlug: 'quick-export',
    });
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

  it('rolls a standalone manual feature back to draft when initialization fails before the assistant stream starts', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    taskStoreState.tasks = [createManualFeatureTask()];

    queueSendChatNonStreamingImplementation(async () =>
      JSON.stringify({
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
        featureSlug: 'quick-export',
      })
    );
    taskStoreState.startTask.mockImplementationOnce(async () => {
      throw new Error('Worktree could not be prepared.');
    });

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

    let thrown: unknown = null;
    try {
      await useChatStore.getState().sendMessage({
        conversationId: 'manual-conv',
        content: 'Ajoute un export CSV rapide depuis le tableau.',
        taskId: 'manual-task-1',
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { message?: string } | null)?.message).toBe(
      'Worktree could not be prepared.'
    );
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(taskStoreState.finalizeManualFeatureDraft).toHaveBeenCalledWith({
      taskId: 'manual-task-1',
      conversationId: 'manual-conv',
      title: 'Quick export',
      description: 'Add a quick CSV export from the table.',
      featureSlug: 'quick-export',
    });
    expect(taskStoreState.revertManualFeatureToDraft).toHaveBeenCalledWith({
      taskId: 'manual-task-1',
      conversationId: 'manual-conv',
      title: 'New feature',
      description: '',
    });
    expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
      draft: true,
      status: 'Pending',
      feature_slug: null,
      branch_name: '',
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

    queueSendChatNonStreamingImplementation(async () =>
      JSON.stringify({
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
        featureSlug: 'quick-export',
      })
    );
    queueSendChatNonStreamingImplementation(async () =>
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

  it('persists manual compaction pass and summary schema metadata', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    setSelectedProviderModelContext();
    queueSendChatNonStreamingImplementation(async () =>
      JSON.stringify({
        currentObjective: 'Continue the database migration safely.',
        userInstructions: ['Keep the migration reversible.'],
        decisions: ['Use a forced manual compaction for older turns.'],
        openQuestions: [],
        activeFiles: ['src-tauri/src/db/mod.rs'],
        toolFacts: ['The old schema lacks compaction_pass.'],
        remainingWork: ['Run targeted tests.'],
        summary: 'Manual compaction preserved the migration objective.',
      })
    );

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Keep this migration reversible.',
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: buildManualCompactionLoad('I will keep it reversible.'),
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Inspect the compaction table.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'The table does not persist compaction_pass.',
        timestamp: '2026-04-14T10:03:00.000Z',
      },
      {
        id: 'u3',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Now compact manually.',
        timestamp: '2026-04-14T10:04:00.000Z',
      },
    ];
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().compactConversationNow('chat-conv');

    const upsertInput = ((dbUpsertConversationCompactionStateMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.at(-1)?.[0] ?? null);
    expect(upsertInput).toMatchObject({
      conversation_id: 'chat-conv',
      compaction_kind: 'manual',
      compaction_pass: 'forced',
      summary_format_version: 3,
      summary_source: 'model',
    });
    expect(upsertInput?.summary_text).toContain('Continue the database migration safely.');
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      summaryFormatVersion: 3,
      summarySource: 'model',
    });
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
    ).toEqual([
      expect.objectContaining({
        status: 'completed',
        displayAfterMessageId: 'u3',
        logicalUpToMessageId: 'a1',
        kind: 'manual',
      }),
    ]);
  });

  it('skips manual compaction for low-context chat without creating a checkpoint', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Tiny old request.',
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'Tiny old answer.',
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Tiny recent request.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'Tiny recent answer.',
        timestamp: '2026-04-14T10:03:00.000Z',
      },
      {
        id: 'u3',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Tiny latest request.',
        timestamp: '2026-04-14T10:04:00.000Z',
      },
    ];
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const result = await useChatStore.getState().compactConversationNow('chat-conv');

    expect(result).toMatchObject({
      outcome: 'skipped',
      reason: 'below_threshold',
      userTurnCount: 3,
      retainedTurnCount: 2,
    });
    expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
    expect(dbUpsertConversationCompactionStateMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toBeUndefined();
  });

  it('preserves an existing checkpoint status when manual compaction is skipped', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Tiny old request.',
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'Tiny old answer.',
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Tiny recent request.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'Tiny recent answer.',
        timestamp: '2026-04-14T10:03:00.000Z',
      },
      {
        id: 'u3',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Tiny latest request.',
        timestamp: '2026-04-14T10:04:00.000Z',
      },
    ];
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
      conversationCompactionStatusById: {
        'chat-conv': {
          phase: 'compacted',
          upToMessageId: 'a1',
          summaryText: 'Previous compacted summary.',
          updatedAt: '2026-04-14T09:00:00.000Z',
          kind: 'manual',
        },
      },
    });

    const result = await useChatStore.getState().compactConversationNow('chat-conv');

    expect(result).toMatchObject({
      outcome: 'skipped',
      reason: 'below_threshold',
    });
    expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
    expect(dbUpsertConversationCompactionStateMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      upToMessageId: 'a1',
      summaryText: 'Previous compacted summary.',
    });
  });

  it('compacts Copilot chat through a system checkpoint instead of provider input replay', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    providerState.providerConfigs = [
      {
        ...DEFAULT_PROVIDER_CONFIGS[0],
        id: 'copilot-provider',
        name: 'Copilot',
        providerType: 'copilot',
        isLocal: true,
      },
    ];
    providerState.modelsByProvider = {
      'copilot-provider': [
        {
          id: 'copilot-model',
          name: 'Copilot Model',
          isEnabled: true,
          contextWindowTokens: 8_000,
          outputLimitTokens: 1_200,
        } as never,
      ],
    };
    providerState.selectedProviderId = 'copilot-provider';
    providerState.selectedModelId = 'copilot-model';
    providerState.selectedReasoningEffort = null;
    queueSendChatNonStreamingImplementation(async () =>
      JSON.stringify({
        currentObjective: 'Continue after compacting Copilot chat history.',
        userInstructions: ['Keep the answer focused.'],
        decisions: ['Older Copilot turns were moved into a compacted system checkpoint.'],
        openQuestions: [],
        activeFiles: [],
        toolFacts: [],
        remainingWork: ['Answer the newest user request.'],
        summary: 'Copilot must receive compacted history through system text, not provider input items.',
      })
    );

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Remember the old Copilot context.',
        timestamp: '2026-03-18T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: `Old Copilot visible payload.\n${'older visible detail\n'.repeat(1_100)}`,
        timestamp: '2026-03-18T10:01:00.000Z',
        provider_input_items: [
          {
            type: 'chat_completion_message',
            role: 'assistant',
            content: 'Old Copilot visible payload.',
            reasoning_content: 'native reasoning payload\n'.repeat(600),
          },
        ],
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Retain the recent turn.',
        timestamp: '2026-03-18T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'Recent Copilot answer.',
        timestamp: '2026-03-18T10:03:00.000Z',
      },
      {
        id: 'u3',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Compact this manually.',
        timestamp: '2026-03-18T10:04:00.000Z',
      },
    ];
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().compactConversationNow('chat-conv');

    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
    expect(sendChatNonStreamingMock.mock.calls[0]?.[0]).toMatchObject({
      providerType: 'copilot',
      copilotSendTimeoutMs: 60_000,
    });
    expect(dbUpsertConversationCompactionStateMock).toHaveBeenCalledTimes(1);
    const persistedCopilotCheckpoint = ((dbUpsertConversationCompactionStateMock as unknown as {
      mock: { calls: Array<Array<Record<string, unknown>>> };
    }).mock.calls.at(-1)?.[0] ?? null);
    expect(persistedCopilotCheckpoint).not.toBeNull();
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      kind: 'manual',
      summarySource: 'model',
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Continue with the compacted Copilot context.',
    });
    await waitForStreamCallCount(1);

    const streamOptions = getLatestStreamOptions<{
      providerType: string;
      messages: Array<Record<string, unknown>>;
    }>();
    const serializedRequest = JSON.stringify(streamOptions.messages);
    expect(streamOptions.providerType).toBe('copilot');
    expect(serializedRequest).toContain(COMPACTED_STATE_MARKER);
    expect(serializedRequest).toContain('Continue after compacting Copilot chat history.');
    expect(serializedRequest).toContain('Retain the recent turn.');
    expect(serializedRequest).not.toContain('older visible detail');
    expect(serializedRequest).not.toContain('native reasoning payload');
    expect(serializedRequest).not.toContain('provider_input_items');
  });

  it('marks manual compaction as running while preserving the previous boundary', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    setSelectedProviderModelContext();
    const summaryDeferred = createDeferred<string>();
    queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Keep this migration reversible.',
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: buildManualCompactionLoad('I will keep it reversible.'),
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Inspect the compaction table.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'The table does not persist compaction_pass.',
        timestamp: '2026-04-14T10:03:00.000Z',
      },
      {
        id: 'u3',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Now compact manually.',
        timestamp: '2026-04-14T10:04:00.000Z',
      },
    ];
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
      conversationCompactionStatusById: {
        'chat-conv': {
          phase: 'compacted',
          upToMessageId: 'a1',
          summaryText: 'Previous compacted summary.',
          updatedAt: '2026-04-14T09:00:00.000Z',
          kind: 'manual',
        },
      },
      sessionCompactionEventsByConversationId: {
        'chat-conv': [
          {
            id: 'older-session-compaction',
            status: 'completed' as const,
            displayAfterMessageId: 'u2',
            logicalUpToMessageId: 'a1',
            kind: 'manual' as const,
            startedAt: '2026-04-14T09:00:00.000Z',
            completedAt: '2026-04-14T09:01:00.000Z',
          },
          {
            id: 'same-anchor-session-compaction',
            status: 'completed' as const,
            displayAfterMessageId: 'u3',
            logicalUpToMessageId: 'a1',
            kind: 'manual' as const,
            startedAt: '2026-04-14T09:10:00.000Z',
            completedAt: '2026-04-14T09:11:00.000Z',
          },
        ],
      },
    });

    const compactionPromise = useChatStore.getState().compactConversationNow('chat-conv');

    expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      upToMessageId: 'a1',
      summaryText: 'Previous compacted summary.',
      kind: 'manual',
    });
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
    ).toEqual([
      expect.objectContaining({
        id: 'older-session-compaction',
        status: 'completed',
        displayAfterMessageId: 'u2',
      }),
      expect.objectContaining({
        id: 'same-anchor-session-compaction',
        status: 'completed',
        displayAfterMessageId: 'u3',
      }),
    ]);

    await flushAsyncWork();

    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacting',
      upToMessageId: 'a1',
      summaryText: 'Previous compacted summary.',
      kind: 'manual',
    });
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
    ).toEqual([
      expect.objectContaining({
        id: 'older-session-compaction',
        status: 'completed',
        displayAfterMessageId: 'u2',
      }),
      expect.objectContaining({
        status: 'running',
        displayAfterMessageId: 'u3',
        kind: 'manual',
      }),
    ]);

    summaryDeferred.resolve(
      JSON.stringify({
        currentObjective: 'Continue the database migration safely.',
        userInstructions: ['Keep the migration reversible.'],
        decisions: ['Use a forced manual compaction for older turns.'],
        openQuestions: [],
        activeFiles: ['src-tauri/src/db/mod.rs'],
        toolFacts: ['The old schema lacks compaction_pass.'],
        remainingWork: ['Run targeted tests.'],
        summary: 'Manual compaction preserved the migration objective.',
      })
    );
    await compactionPromise;

    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      summaryText: expect.stringContaining('Continue the database migration safely.'),
    });
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
    ).toEqual([
      expect.objectContaining({
        id: 'older-session-compaction',
        status: 'completed',
        displayAfterMessageId: 'u2',
      }),
      expect.objectContaining({
        status: 'completed',
        displayAfterMessageId: 'u3',
        logicalUpToMessageId: 'a1',
        kind: 'manual',
      }),
    ]);
  });

  it('keeps manual compaction running when a persisted checkpoint is loaded during the compaction', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    setSelectedProviderModelContext();
    const summaryDeferred = createDeferred<string>();
    queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);
    (dbGetConversationCompactionStateMock as unknown as {
      mockImplementationOnce: (
        implementation: () => Promise<unknown>,
      ) => void;
    }).mockImplementationOnce(async () => createDbConversationCompactionState());

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Keep this migration reversible.',
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: buildManualCompactionLoad('I will keep it reversible.'),
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Inspect the compaction table.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'The table does not persist compaction_pass.',
        timestamp: '2026-04-14T10:03:00.000Z',
      },
      {
        id: 'u3',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Now compact manually.',
        timestamp: '2026-04-14T10:04:00.000Z',
      },
    ];
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const compactionPromise = useChatStore.getState().compactConversationNow('chat-conv');

    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toBeUndefined();

    await flushAsyncWork();

    expect(dbGetConversationCompactionStateMock).toHaveBeenCalledTimes(1);
    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacting',
      kind: 'manual',
      summaryText: 'Previous persisted compacted summary.',
    });

    summaryDeferred.resolve(
      JSON.stringify({
        currentObjective: 'Continue safely after a concurrent checkpoint load.',
        userInstructions: [],
        decisions: [],
        openQuestions: [],
        activeFiles: [],
        toolFacts: [],
        remainingWork: [],
        summary: 'Concurrent checkpoint load did not stop activity.',
      })
    );
    await compactionPromise;

    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      summaryText: expect.stringContaining('Continue safely after a concurrent checkpoint load.'),
    });
  });

  it('keeps manual compaction running when the persisted checkpoint is already cached', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    setSelectedProviderModelContext();
    const summaryDeferred = createDeferred<string>();
    queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);
    (dbGetConversationCompactionStateMock as unknown as {
      mockImplementationOnce: (
        implementation: () => Promise<unknown>,
      ) => void;
    }).mockImplementationOnce(async () => createDbConversationCompactionState());

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Keep this migration reversible.',
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: buildManualCompactionLoad('I will keep it reversible.'),
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Inspect the compaction table.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'The table does not persist compaction_pass.',
        timestamp: '2026-04-14T10:03:00.000Z',
      },
      {
        id: 'u3',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Now compact manually.',
        timestamp: '2026-04-14T10:04:00.000Z',
      },
    ];
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      hydrationStatus: 'ready',
      restoreStatus: 'idle',
      messageImagesByMessageId: {},
      composerContextRefs: [],
    }));

    await useChatStore.getState().selectConversation('chat-conv');
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      summaryText: 'Previous persisted compacted summary.',
    });

    const compactionPromise = useChatStore.getState().compactConversationNow('chat-conv');

    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      summaryText: 'Previous persisted compacted summary.',
    });

    await flushAsyncWork();

    expect(dbGetConversationCompactionStateMock).toHaveBeenCalledTimes(1);
    expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacting',
      kind: 'manual',
      summaryText: 'Previous persisted compacted summary.',
    });

    summaryDeferred.resolve(
      JSON.stringify({
        currentObjective: 'Continue safely with cached compaction state.',
        userInstructions: [],
        decisions: [],
        openQuestions: [],
        activeFiles: [],
        toolFacts: [],
        remainingWork: [],
        summary: 'Cached checkpoint did not stop activity.',
      })
    );
    await compactionPromise;

    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      summaryText: expect.stringContaining('Continue safely with cached compaction state.'),
    });
  });

  it('hydrates persisted compaction metadata when a conversation is reselected', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    (dbGetConversationCompactionStateMock as unknown as {
      mockImplementationOnce: (
        implementation: () => Promise<unknown>,
      ) => void;
    }).mockImplementationOnce(async () => ({
      conversation_id: 'chat-conv',
      up_to_message_id: 'a1',
      summary_text: 'Current objective: continue safely.',
      tool_digest_json: '[]',
      used_source_passage_ids_json: '[]',
      interesting_source_passage_ids_json: '[]',
      estimated_tokens_before: 4200,
      estimated_tokens_after: 900,
      fingerprint: 'fp',
      version: 1,
      pruned_tool_context_message_ids_json: '["a1"]',
      reserved_tokens: 1200,
      footprint_before_json: null,
      footprint_after_json: JSON.stringify({
        totalEstimatedTokens: 900,
        messageTokens: 700,
        hiddenContextTokens: 0,
        systemTokens: 120,
        toolSchemaTokens: 80,
        imagePlaceholderTokens: 0,
        citationTokens: 0,
        modelContextWindowTokens: 8000,
        reservedTokens: 1200,
        usableContextTokens: 6800,
        threshold: 'none',
        reason: 'below_threshold',
        totalContextRatio: 0.11,
        usableContextRatio: 0.13,
        hiddenContextRatio: 0,
        hardStopRatio: 0.98,
        isHardStop: false,
        toolTurnCount: 0,
      }),
      degraded_reason: null,
      compaction_kind: 'manual',
      compaction_pass: 'ultra',
      summary_format_version: 3,
      summary_source: 'fallback',
      created_at: '2026-04-14T10:00:00.000Z',
      updated_at: '2026-04-14T10:05:00.000Z',
    }));

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      hydrationStatus: 'ready',
      restoreStatus: 'idle',
    }));

    await useChatStore.getState().selectConversation('chat-conv');

    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      summaryText: 'Current objective: continue safely.',
      summaryFormatVersion: 3,
      summarySource: 'fallback',
    });
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
    ).toBeUndefined();
  });

  it('normalizes invalid persisted compaction metadata instead of trusting DB strings', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    (dbGetConversationCompactionStateMock as unknown as {
      mockImplementationOnce: (
        implementation: () => Promise<unknown>,
      ) => void;
    }).mockImplementationOnce(async () => ({
      conversation_id: 'chat-conv',
      up_to_message_id: 'a1',
      summary_text: 'Legacy compacted summary.',
      tool_digest_json: '[]',
      used_source_passage_ids_json: '[]',
      interesting_source_passage_ids_json: '[]',
      estimated_tokens_before: 4200,
      estimated_tokens_after: 900,
      fingerprint: 'fp',
      version: 1,
      pruned_tool_context_message_ids_json: '[]',
      reserved_tokens: null,
      footprint_before_json: null,
      footprint_after_json: null,
      degraded_reason: 'not_a_reason',
      compaction_kind: 'not_a_kind',
      compaction_pass: 'dangerously_wrong',
      summary_format_version: -10,
      summary_source: 'robot_guess',
      created_at: '2026-04-14T10:00:00.000Z',
      updated_at: '2026-04-14T10:05:00.000Z',
    }));

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      hydrationStatus: 'ready',
      restoreStatus: 'idle',
    }));

    await useChatStore.getState().selectConversation('chat-conv');

    const status =
      useChatStore.getState().conversationCompactionStatusById['chat-conv'];
    expect(status).toMatchObject({
      phase: 'compacted',
      summaryText: 'Legacy compacted summary.',
      reason: null,
      summaryFormatVersion: 1,
    });
    expect(status?.kind).toBeUndefined();
    expect(status?.summarySource).toBeUndefined();
  });

  it('rejects concurrent manual compaction for the same conversation', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    const summaryDeferred = createDeferred<string>();
    queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Keep this migration reversible.',
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'I will keep it reversible.',
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Now compact manually.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
    ];
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    const firstPromise = useChatStore.getState().compactConversationNow('chat-conv');
    const secondPromise = useChatStore.getState().compactConversationNow('chat-conv');

    await expect(secondPromise).rejects.toThrow('already in progress');

    summaryDeferred.resolve(
      JSON.stringify({
        currentObjective: 'Continue safely.',
        userInstructions: [],
        decisions: [],
        openQuestions: [],
        activeFiles: [],
        toolFacts: [],
        remainingWork: [],
        summary: 'Safe continuation.',
      })
    );
    await firstPromise;
  });

  it('runs safety prestream compaction before streaming when the projected payload is full', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    providerState.modelsByProvider = {
      'provider-1': [
        {
          id: 'model-1',
          name: 'Small context model',
          isEnabled: true,
          contextWindowTokens: 8000,
          outputLimitTokens: 1200,
        } as never,
      ],
    };
    const summaryDeferred = createDeferred<string>();
    queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);
    const oldContext = 'ancien contexte utile\n'.repeat(5000);
    (dbGetConversationCompactionStateMock as unknown as {
      mockImplementationOnce: (
        implementation: () => Promise<unknown>,
      ) => void;
    }).mockImplementationOnce(async () => ({
      conversation_id: 'chat-conv',
      up_to_message_id: 'a1',
      summary_text: 'Previous compacted state that must not hide active safety compaction.',
      tool_digest_json: '[]',
      used_source_passage_ids_json: '[]',
      interesting_source_passage_ids_json: '[]',
      estimated_tokens_before: 12000,
      estimated_tokens_after: 1200,
      fingerprint: 'previous-fingerprint',
      version: 1,
      pruned_tool_context_message_ids_json: '[]',
      reserved_tokens: 1200,
      footprint_before_json: null,
      footprint_after_json: JSON.stringify({
        totalEstimatedTokens: 1200,
        messageTokens: 1000,
        hiddenContextTokens: 0,
        systemTokens: 120,
        toolSchemaTokens: 80,
        imagePlaceholderTokens: 0,
        citationTokens: 0,
        modelContextWindowTokens: 8000,
        reservedTokens: 1200,
        usableContextTokens: 6800,
        threshold: 'none',
        reason: 'below_threshold',
        totalContextRatio: 0.15,
        usableContextRatio: 0.18,
        hiddenContextRatio: 0,
        hardStopRatio: 0.98,
        isHardStop: false,
        toolTurnCount: 0,
      }),
      degraded_reason: null,
      compaction_kind: 'manual',
      compaction_pass: 'forced',
      summary_format_version: 3,
      summary_source: 'model',
      created_at: '2026-04-14T09:00:00.000Z',
      updated_at: '2026-04-14T09:05:00.000Z',
    }));

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: `Analyse ce gros historique.\n${oldContext}`,
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: `Historique analysé.\n${oldContext}`,
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Garde les conclusions importantes.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'Je garde les conclusions.',
        timestamp: '2026-04-14T10:03:00.000Z',
      },
    ];
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    const sendPromise = useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Continue avec une réponse courte.',
    });
    await flushAsyncWork();

    expect(streamChatMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'safety_compacting',
      kind: 'safety_prestream',
      upToMessageId: 'a1',
      summaryText: 'Previous compacted state that must not hide active safety compaction.',
    });
    const latestUserMessage = useChatStore
      .getState()
      .messages.find(
        (message: ChatMessage) =>
          message.content === 'Continue avec une réponse courte.',
      );
    expect(latestUserMessage).toBeDefined();
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
    ).toEqual([
      expect.objectContaining({
        status: 'running',
        displayAfterMessageId: latestUserMessage!.id,
        kind: 'safety_prestream',
      }),
    ]);

    summaryDeferred.resolve(
      JSON.stringify({
        currentObjective: 'Continue from the compacted older context.',
        userInstructions: ['Keep the answer short.'],
        decisions: ['Older context was compacted before streaming.'],
        openQuestions: [],
        activeFiles: [],
        toolFacts: [],
        remainingWork: ['Answer the latest user request.'],
        summary: 'The old history contained useful context but no pending blocker.',
      }),
    );
    await sendPromise;
    await waitForStreamCallCount(1);

    const streamOptions = getLatestStreamOptions<{
      messages: Array<{ role: string; content: string }>;
    }>();
    const serializedRequest = JSON.stringify(streamOptions.messages);
    expect(serializedRequest).toContain(COMPACTED_STATE_MARKER);
    expect(serializedRequest).toContain('Continue from the compacted older context.');
    expect(useChatStore.getState().lastError).toBeNull();
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
    ).toEqual([
      expect.objectContaining({
        status: 'completed',
        displayAfterMessageId: latestUserMessage!.id,
        logicalUpToMessageId: 'a1',
        kind: 'safety_prestream',
      }),
    ]);
  });

  it('ignores legacy compaction preferences and still runs safety prestream compaction', async () => {
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    localStorage.setItem('macro_compaction.auto', JSON.stringify(false));
    localStorage.setItem('macro_compaction.prune', JSON.stringify(false));
    localStorage.setItem('macro_compaction.reservedTokens', JSON.stringify(0));
    providerState.modelsByProvider = {
      'provider-1': [
        {
          id: 'model-1',
          name: 'Small context model',
          isEnabled: true,
          contextWindowTokens: 8000,
          outputLimitTokens: 1200,
        } as never,
      ],
    };
    const summaryDeferred = createDeferred<string>();
    queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);

    const { useChatStore } = await loadChatStore();
    const oldContext = 'ancien contexte utile\n'.repeat(5000);
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: `Analyse ce gros historique.\n${oldContext}`,
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: `Historique analysé.\n${oldContext}`,
        timestamp: '2026-04-14T10:01:00.000Z',
      },
    ];
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    const sendPromise = useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Continue avec une réponse courte.',
    });
    await flushAsyncWork();

    expect(streamChatMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'safety_compacting',
      kind: 'safety_prestream',
    });

    summaryDeferred.resolve(
      JSON.stringify({
        currentObjective: 'Continue from the compacted older context.',
        userInstructions: ['Keep the answer short.'],
        decisions: ['Legacy compaction preferences are ignored.'],
        openQuestions: [],
        activeFiles: [],
        toolFacts: [],
        remainingWork: ['Answer the latest user request.'],
        summary: 'The old history contained useful context.',
      }),
    );
    await sendPromise;
    await waitForStreamCallCount(1);

    expect(useChatStore.getState().lastError).toBeNull();
  });

  it('blocks clearly when the latest user request is too large to compact away', async () => {
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    providerState.modelsByProvider = {
      'provider-1': [
        {
          id: 'model-1',
          name: 'Tiny context model',
          isEnabled: true,
          contextWindowTokens: 2000,
        } as never,
      ],
    };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    await expect(
      useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: `Réponds à ce payload impossible.\n${'dernier message énorme\n'.repeat(6000)}`,
      }),
    ).rejects.toThrow('The conversation is still too large');
    await flushAsyncWork();

    expect(streamChatMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'too_large',
      kind: 'safety_prestream',
    });
    expect(useChatStore.getState().lastError).toContain(
      'The conversation is still too large',
    );
    expect(
      useChatStore
        .getState()
        .getConversationMessages('chat-conv')
        .filter((message: { role: string }) => message.role === 'user'),
    ).toHaveLength(1);
  });

  it('recovers a provider context overflow by compacting and retrying once', async () => {
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    queueSendChatNonStreamingImplementation(async () =>
      JSON.stringify({
        currentObjective: 'Retry after provider context overflow.',
        userInstructions: [],
        decisions: ['Use stream overflow compaction before retrying.'],
        openQuestions: [],
        activeFiles: [],
        toolFacts: [],
        remainingWork: ['Retry the provider request once.'],
        summary: 'Older turns can be represented by this summary.',
      })
    );
    streamChatMock
      .mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onError?: (error: Error) => void;
        };
        options.onError?.(
          new Error('input is too long for requested model'),
        );
        return { usage: null };
      }) as unknown as typeof streamChatMock)
      .mockImplementationOnce((async () => ({ usage: null })) as unknown as typeof streamChatMock);

    const { useChatStore } = await loadChatStore();
    const messages = [
      {
        id: 'u1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Ancienne demande.',
        timestamp: '2026-04-14T10:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'Ancienne réponse.',
        timestamp: '2026-04-14T10:01:00.000Z',
      },
      {
        id: 'u2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content: 'Conserve ce contexte.',
        timestamp: '2026-04-14T10:02:00.000Z',
      },
      {
        id: 'a2',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
        content: 'Contexte conservé.',
        timestamp: '2026-04-14T10:03:00.000Z',
      },
    ];
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        {
          ...createConversation('chat-conv', ''),
          message_count: messages.length,
        },
      ],
      messages,
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Continue après overflow.',
    });
    await waitForStreamCallCount(2);

    expect(streamChatMock).toHaveBeenCalledTimes(2);
    const retryOptions = getLatestStreamOptions<{
      messages: Array<{ role: string; content: string }>;
    }>();
    expect(JSON.stringify(retryOptions.messages)).toContain(
      COMPACTED_STATE_MARKER,
    );
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toMatchObject({
      phase: 'compacted',
      kind: 'stream_overflow',
      recoveredFromOverflow: true,
    });
  });

  it('does not retry provider context overflow after useful assistant progress', async () => {
    appState.mode = 'Chat';
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as {
        onToolTracesUpdate?: (toolTraces: unknown[]) => void;
        onError?: (error: Error) => void;
      };
      options.onToolTracesUpdate?.([
        {
          tool_call_id: 'call-1',
          tool_name: 'read_file',
          detail: 'src/app.ts',
          status: 'done',
        },
      ]);
      options.onError?.(
        Object.assign(new Error('maximum context length is 100 tokens'), {
          name: 'ProviderRuntimeError',
          providerError: true,
          kind: 'context_overflow',
          status: 400,
          retryable: false,
          providerMessage: 'maximum context length is 100 tokens',
        }),
      );
      return { usage: null };
    }) as unknown as typeof streamChatMock);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Lance une requête provider.',
    });
    await flushAsyncWork();

    expect(streamChatMock).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().conversationCompactionStatusById['chat-conv'],
    ).toBeUndefined();
    const runtime = useChatStore.getState().getConversationRuntime('chat-conv');
    expect(runtime.lastErrorOrigin).toBe('provider');
    expect(runtime.lastErrorDisplayTarget).toBe('transcript');
  });

  it('passes Architect mode and the post-tool recap instruction into streaming requests', async () => {
    appState.mode = 'Architect';
    appState.selectedTaskId = null;
    localStorage.setItem('macro_chatMaxTurns', JSON.stringify(7));

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
            completionReason?: 'completed' | 'tool_turn_limit' | 'post_tool_empty_fallback';
          }) => void;
        }) => Promise<void>) => void;
      }
    ).mockImplementationOnce(async ({ onComplete }) => {
      onComplete?.({
        visibleContent: 'Plan prêt.',
        toolTraces: [],
        hiddenContext: undefined,
        completionReason: 'tool_turn_limit',
      });
    });

    const { useChatStore } = await loadChatStore();
    activateArchitectPlanForTest({ conversationId: 'conv-1' });
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
          calls: Array<Array<{
            maxTurns?: number | null;
            mode?: AppMode;
            messages: Array<{ role: string; content: string }>;
          }>>;
        };
      }
    ).mock.calls[0]?.[0];

    expect(firstCall?.mode).toBe('Architect');
    expect(firstCall?.maxTurns).toBe(7);
    expect(firstCall?.messages[0]?.role).toBe('system');
    expect(firstCall?.messages[0]?.content).toContain(
      'always answer in natural language with a concise recap'
    );
    expect(
      useChatStore
        .getState()
        .getConversationMessages('conv-1')
        .find((message: { role: string }) => message.role === 'assistant')
    ).toMatchObject({
      content: 'Plan prêt.',
      completion_reason: 'tool_turn_limit',
    });
  });

  it('keeps the tool-turn-limit notice out of the next model request', async () => {
    appState.mode = 'Architect';
    appState.selectedTaskId = null;

    const { streamChat } = await import('../services/streamingChat');
    const streamChatMockForTest = streamChat as unknown as {
      mockImplementationOnce: (implementation: (options: {
        messages: Array<{ role: string; content: string }>;
        onComplete?: (result: {
          visibleContent: string;
          toolTraces: unknown[];
          hiddenContext?: unknown;
          completionReason?: 'completed' | 'tool_turn_limit' | 'post_tool_empty_fallback';
        }) => void;
      }) => Promise<void>) => void;
      mock: {
        calls: Array<Array<{
          messages: Array<{ role: string; content: string }>;
        }>>;
      };
    };
    streamChatMockForTest.mockImplementationOnce(async ({ onComplete }) => {
      onComplete?.({
        visibleContent: 'Plan prêt.',
        toolTraces: [],
        hiddenContext: undefined,
        completionReason: 'tool_turn_limit',
      });
    });
    streamChatMockForTest.mockImplementationOnce(async ({ onComplete }) => {
      onComplete?.({
        visibleContent: 'Suite prête.',
        toolTraces: [],
        hiddenContext: undefined,
        completionReason: 'completed',
      });
    });

    const { useChatStore } = await loadChatStore();
    activateArchitectPlanForTest({ conversationId: 'conv-1' });
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
      content: 'Inspecte avec des outils.',
    });
    await Promise.resolve();

    await useChatStore.getState().sendMessage({
      conversationId: 'conv-1',
      content: 'Continue.',
    });
    await Promise.resolve();

    const calls = streamChatMockForTest.mock.calls;
    const secondRequest = calls[1]?.[0];
    const serializedMessages = JSON.stringify(secondRequest?.messages ?? []);

    expect(serializedMessages).toContain('Plan prêt.');
    expect(serializedMessages).not.toContain('Tool turn limit reached');
    expect(serializedMessages).not.toContain('Macro stopped the agent loop');
    expect(serializedMessages).not.toContain('Limite de tours');
    expect(
      secondRequest?.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === 'Plan prêt.' &&
          !('completion_reason' in message)
      )
    ).toBe(true);
  });

  it('keeps live context diagnostics pinned to the provider and model used to launch the stream', async () => {
    appState.mode = 'Chat';
    providerState.providerConfigs = [
      { ...DEFAULT_PROVIDER_CONFIGS[0], id: 'provider-1', providerType: 'openai' },
      { ...DEFAULT_PROVIDER_CONFIGS[0], id: 'provider-2', providerType: 'anthropic' },
    ];
    providerState.modelsByProvider = {
      'provider-1': [{ id: 'model-1', name: 'Model 1', isEnabled: true, contextWindowTokens: 32_000, outputLimitTokens: 4_000 } as never],
      'provider-2': [{ id: 'model-2', name: 'Model 2', isEnabled: true, contextWindowTokens: 96_000, outputLimitTokens: 4_000 } as never],
    };
    providerState.selectedProviderId = 'provider-1';
    providerState.selectedModelId = 'model-1';

    streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
      const options = args[0] as {
        onLiveContextUpdate?: (snapshot: {
          version: number;
          visibleContent: string;
          visibleContentLength: number;
          toolTraces: unknown[];
        }) => void;
      };
      options.onLiveContextUpdate?.({
        version: 1,
        visibleContent: 'Réponse partielle',
        visibleContentLength: 'Réponse partielle'.length,
        toolTraces: [],
      });
    }) as unknown as typeof streamChatMock);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Mesure ce stream.',
    });
    await flushAsyncWork();

    providerState.selectedProviderId = 'provider-2';
    providerState.selectedModelId = 'model-2';
    await useChatStore.getState().refreshConversationContextDiagnostics('chat-conv', {
      mode: 'live_stream',
    });

    const diagnostics =
      useChatStore.getState().contextDiagnosticsByConversationId['chat-conv'];
    expect(diagnostics).toMatchObject({
      source: 'live_stream',
      providerId: 'provider-1',
      providerType: 'openai',
      modelId: 'model-1',
    });
    expect(diagnostics?.footprintAfter?.modelContextWindowTokens).toBe(32_000);
  });

  it('keeps live context diagnostics isolated from context changes made after send', async () => {
    appState.mode = 'Chat';
    streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
      const options = args[0] as {
        onLiveContextUpdate?: (snapshot: {
          version: number;
          visibleContent: string;
          visibleContentLength: number;
          toolTraces: unknown[];
        }) => void;
      };
      options.onLiveContextUpdate?.({
        version: 1,
        visibleContent: 'Réponse en cours',
        visibleContentLength: 'Réponse en cours'.length,
        toolTraces: [],
      });
    }) as unknown as typeof streamChatMock);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Ne mesure que le contexte initial.',
    });
    await flushAsyncWork();

    useChatStore.setState({
      composerContextRefs: [
        {
          kind: 'file',
          id: 'file-after-send',
          title: 'Late file context ref',
          subtitle: 'Should not affect live diagnostics',
          data: { description: 'Added after the stream started.' },
        },
      ],
    });
    citationRecords.push({
      id: 'late-citation',
      type: 'file',
      scope: 'context',
      source: 'src/late.ts',
      title: 'Late file',
      snippet: 'This source was attached after send.',
      content: 'This source was attached after send.',
      messageId: 'late-message',
      conversationId: 'chat-conv',
      timestamp: '2026-05-10T00:00:00.000Z',
      path: 'src/late.ts',
    });

    await useChatStore.getState().refreshConversationContextDiagnostics('chat-conv', {
      mode: 'live_stream',
    });

    const diagnostics =
      useChatStore.getState().contextDiagnosticsByConversationId['chat-conv'];
    expect(diagnostics?.counts.citations).toBe(0);
    expect(JSON.stringify(diagnostics?.breakdown ?? [])).not.toContain('Late file');
  });

  it('ignores older live context snapshots after a newer version is recorded', async () => {
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Teste les versions live.',
    });
    await flushAsyncWork();

    const streamOptions = getLatestStreamOptions<{
      onLiveContextUpdate?: (snapshot: {
        version: number;
        visibleContent: string;
        visibleContentLength: number;
        toolTraces: unknown[];
      }) => void;
    }>();
    streamOptions.onLiveContextUpdate?.({
      version: 2,
      visibleContent: 'snapshot récent',
      visibleContentLength: 'snapshot récent'.length,
      toolTraces: [],
    });
    streamOptions.onLiveContextUpdate?.({
      version: 1,
      visibleContent: 'snapshot ancien',
      visibleContentLength: 'snapshot ancien'.length,
      toolTraces: [],
    });

    expect(
      useChatStore.getState().liveStreamContextEstimatesByConversationId['chat-conv']
        ?.visibleContent,
    ).toBe('snapshot récent');
  });

  it('uses the completed stream provider for the final full context refresh', async () => {
    appState.mode = 'Chat';
    providerState.providerConfigs = [
      { ...DEFAULT_PROVIDER_CONFIGS[0], id: 'provider-1', providerType: 'openai' },
      { ...DEFAULT_PROVIDER_CONFIGS[0], id: 'provider-2', providerType: 'anthropic' },
    ];
    providerState.modelsByProvider = {
      'provider-1': [{ id: 'model-1', name: 'Model 1', isEnabled: true, contextWindowTokens: 32_000, outputLimitTokens: 4_000 } as never],
      'provider-2': [{ id: 'model-2', name: 'Model 2', isEnabled: true, contextWindowTokens: 96_000, outputLimitTokens: 4_000 } as never],
    };
    providerState.selectedProviderId = 'provider-1';
    providerState.selectedModelId = 'model-1';
    streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
      const options = args[0] as {
        onComplete?: (result: {
          visibleContent: string;
          toolTraces: unknown[];
          hiddenContext?: string;
        }) => void;
      };
      providerState.selectedProviderId = 'provider-2';
      providerState.selectedModelId = 'model-2';
      options.onComplete?.({
        visibleContent: 'Réponse finale.',
        toolTraces: [],
        hiddenContext: undefined,
      });
    }) as unknown as typeof streamChatMock);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv', '')],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Termine puis mesure.',
    });

    const diagnostics = await waitForConversationDiagnostics(useChatStore, 'chat-conv');
    expect(diagnostics).toMatchObject({
      source: 'full',
      providerId: 'provider-1',
      providerType: 'openai',
      modelId: 'model-1',
    });
    expect(diagnostics?.footprintAfter?.modelContextWindowTokens).toBe(32_000);
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

  it('reopens questionnaire response edits from conversation-indexed messages after reload', async () => {
    appState.mode = 'Chat';

    const assistantMessage = {
      id: 'assistant-questionnaire',
      task_id: '',
      conversation_id: 'chat-conv',
      role: 'assistant' as const,
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
        source: 'tool' as const,
        questions: [
          {
            id: 'scope',
            prompt: 'Which scope should I use?',
            choices: ['Minimal', 'Balanced', 'Large'] as [string, string, string],
          },
          {
            id: 'risk',
            prompt: 'How risky can the change be?',
            choices: ['Safe', 'Moderate', 'Aggressive'] as [string, string, string],
            free_text_placeholder: 'Custom answer',
          },
        ],
      },
    };
    const responseMessage = {
      id: 'user-questionnaire',
      task_id: '',
      conversation_id: 'chat-conv',
      role: 'user' as const,
      content:
        'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
      timestamp: '2026-04-14T10:01:00.000Z',
      questionnaire_response_summary: {
        assistantMessageId: 'assistant-questionnaire',
        source: 'tool' as const,
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
    };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [],
      messagesByConversationId: {
        'chat-conv': [assistantMessage, responseMessage],
      },
      messageIndexById: {},
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
    expect(
      useChatStore.getState().questionnaireDraftsByConversationId['chat-conv'],
    ).toMatchObject({
      mode: 'editing_response',
      assistantMessageId: 'assistant-questionnaire',
      responseMessageId: 'user-questionnaire',
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

  it('prunes session compaction markers at and after a replayed message', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        createConversation('chat-conv', ''),
        createConversation('other-conv', ''),
      ],
      messages: [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user',
          content: 'First user request',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'First assistant answer',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user',
          content: 'Second user request',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Second assistant answer',
          timestamp: '2026-04-14T10:03:00.000Z',
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
      sessionCompactionEventsByConversationId: {
        'chat-conv': [
          {
            id: 'compaction-before-replay',
            status: 'completed' as const,
            displayAfterMessageId: 'u1',
            logicalUpToMessageId: 'a1',
            kind: 'manual' as const,
            startedAt: '2026-04-14T10:01:10.000Z',
            completedAt: '2026-04-14T10:01:20.000Z',
          },
          {
            id: 'compaction-at-replay',
            status: 'completed' as const,
            displayAfterMessageId: 'u2',
            logicalUpToMessageId: 'u2',
            kind: 'safety_prestream' as const,
            startedAt: '2026-04-14T10:02:10.000Z',
            completedAt: '2026-04-14T10:02:20.000Z',
          },
          {
            id: 'compaction-after-replay',
            status: 'running' as const,
            displayAfterMessageId: 'a2',
            kind: 'manual' as const,
            startedAt: '2026-04-14T10:03:10.000Z',
          },
          {
            id: 'compaction-without-anchor',
            status: 'completed' as const,
            displayAfterMessageId: null,
            kind: 'manual' as const,
            startedAt: '2026-04-14T10:04:10.000Z',
            completedAt: '2026-04-14T10:04:20.000Z',
          },
        ],
        'other-conv': [
          {
            id: 'other-compaction',
            status: 'completed' as const,
            displayAfterMessageId: 'other-message',
            kind: 'manual' as const,
            startedAt: '2026-04-14T10:05:10.000Z',
            completedAt: '2026-04-14T10:05:20.000Z',
          },
        ],
      },
    });

    await useChatStore.getState().editMessage('u2', 'Second user request updated', {
      skipAgentCodeReplayCheck: true,
    });
    await flushAsyncWork();

    expect(deleteMessagesAfterMock).toHaveBeenCalledWith('chat-conv', 'u2');
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId[
        'chat-conv'
      ],
    ).toEqual([
      expect.objectContaining({
        id: 'compaction-before-replay',
        displayAfterMessageId: 'u1',
      }),
    ]);
    expect(
      useChatStore.getState().sessionCompactionEventsByConversationId[
        'other-conv'
      ],
    ).toEqual([
      expect.objectContaining({
        id: 'other-compaction',
      }),
    ]);
  });

  it('blocks direct edits that would rewind agent code checkpoints without confirmation', async () => {
    tauriAvailable = false;
    appState.mode = 'Chat';

    const checkpoint: AgentCodeCheckpoint = {
      id: 'checkpoint-1',
      conversationId: 'chat-conv',
      assistantMessageId: 'assistant-after',
      toolCallId: 'call-write',
      toolName: 'write',
      sequence: 1,
      createdAt: '2026-05-11T10:00:00.000Z',
      files: [
        {
          path: 'src/new-file.ts',
          realPath: '/repo/src/new-file.ts',
          status: 'created',
          before: { exists: false, content: null },
          after: { exists: true, content: 'export const value = 1;\n' },
        },
      ],
    };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [
        {
          id: 'user-before-code',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user',
          content: 'Change the code',
          timestamp: '2026-05-11T09:59:00.000Z',
        },
        {
          id: 'assistant-after',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: 'Done.',
          timestamp: '2026-05-11T10:00:00.000Z',
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      agentCodeCheckpointsByConversationId: {
        'chat-conv': [checkpoint],
      },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {},
      composerContextRefs: [],
    });

    await useChatStore
      .getState()
      .editMessage('user-before-code', 'Change the code again');

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(deleteMessagesAfterMock).not.toHaveBeenCalled();
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().lastError).toContain(
      'confirm the code checkpoint restore',
    );
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
    setImplementStoreState(useChatStore, {
      conversationId: 'implement-conv',
      taskId: 'task-1',
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
    expect(streamOptions.allowedToolIds).not.toContain('mark_source_passage');
    expect(streamOptions.allowedToolIds).not.toContain('read_sources');
    expect(streamOptions.allowedToolIds).not.toContain('edit_source_passage');
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

  it('blocks standalone tasks before streaming when repository or branch metadata is missing', async () => {
    appState.mode = 'Implement';
    appState.agentType = 'build';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [
      createImplementTask({
        status: 'InProgress',
        task_source: 'standalone',
        plan_id: '',
        project_id: 'project-1',
        project_ids: ['project-1'],
        branch_name: '',
        assigned_branch: '',
        execution_targets: [],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Standalone export',
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
        content: 'Lance cette tâche indépendante.',
        taskId: 'task-1',
      })
    ).rejects.toThrow('missing its execution target');

    expect(streamChatMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().getConversationMessages('implement-conv')).toHaveLength(0);
  });

  it('returns worktree-based terminal sessions for terminal_create_session tool calls in implement tasks', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [
      createImplementTask({
        status: 'InProgress',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/implement-checkout',
            worktreeKey: 'task-1-web',
          },
        ],
      }),
    ];

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
      content: 'Ouvre un terminal pour travailler sur cette tâche.',
      taskId: 'task-1',
    });

    const onToolCall = getLatestArchitectToolHandler();
    const result = await onToolCall('terminal_create_session', {
      project_id: 'project-1',
    });

    expect(terminalCreateSessionFromChatMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: null,
    });

    const parsed = JSON.parse(String(result));
    expect(parsed.cwd).toBe('C:/repos/web/.macro/worktrees/task-1');
  });

  it('challenges git_commit once before allowing the same assistant turn to commit', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Corrige le code, mais ne commit rien.',
    );

    const firstResult = await onToolCall(
      'git_commit',
      { message: 'fix: update checkout flow' },
      'call-commit-1',
    );

    expect(String(firstResult)).toContain(
      'Do not stage or commit unless the user explicitly asked',
    );
    expect(executeWorkspaceToolMock).not.toHaveBeenCalled();

    const secondResult = await onToolCall(
      'git_commit',
      { message: 'fix: update checkout flow' },
      'call-commit-2',
    );

    expect(secondResult).toBeUndefined();
    expect(executeWorkspaceToolMock).toHaveBeenCalledTimes(1);
    expect(
      (executeWorkspaceToolMock as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]?.[0],
    ).toBe('git_commit');
  });

  it('does not recreate checkpoints when deletion wins a completed workspace mutation', async () => {
    tauriAvailable = false;
    const mutationFinished = createDeferred<void>();
    executeWorkspaceToolMock.mockImplementationOnce(
      (async (...args: unknown[]) => {
        const executionContext = args[3] as {
          onCodeCheckpoint?: (checkpoint: {
            toolName: string;
            files: unknown[];
          }) => Promise<void>;
        };
        await mutationFinished.promise;
        await executionContext.onCodeCheckpoint?.({
          toolName: 'write',
          files: [
            {
              path: 'src/late.ts',
              realPath: 'C:/repo/src/late.ts',
              status: 'created',
              before: { exists: false, content: null, isBinary: false, size: 0 },
              after: {
                exists: true,
                content: 'export const late = true;\n',
                isBinary: false,
                size: 25,
              },
            },
          ],
        });
      }) as unknown as () => Promise<undefined>,
    );
    const { useChatStore, onToolCall } = await startImplementToolConversation();

    const toolCall = onToolCall('write', {
      path: 'src/late.ts',
      content: 'export const late = true;\n',
    });
    await Promise.resolve();
    await useChatStore.getState().deleteConversation('implement-conv', {
      mode: 'implement',
    });
    mutationFinished.resolve();
    await toolCall;

    expect(useChatStore.getState().conversations).toEqual([]);
    expect(
      useChatStore.getState().agentCodeCheckpointsByConversationId['implement-conv'],
    ).toBeUndefined();
  });

  it('limits implement plan agent turns to read-only inspection tools', async () => {
    await startImplementToolConversation(
      'Analyse la correction avant de toucher au code.',
      { agentType: 'plan' },
    );

    const streamOptions = getLatestStreamOptions<{
      allowedToolIds: string[];
      messages: Array<{ role: string; content: string }>;
    }>();

    expect(streamOptions.allowedToolIds).toContain('read');
    expect(streamOptions.allowedToolIds).toContain('grep');
    expect(streamOptions.allowedToolIds).toContain('git_diff');
    expect(streamOptions.allowedToolIds).toContain('task_todo_get');
    expect(streamOptions.allowedToolIds).not.toContain('write');
    expect(streamOptions.allowedToolIds).not.toContain('edit');
    expect(streamOptions.allowedToolIds).not.toContain('delete');
    expect(streamOptions.allowedToolIds).not.toContain('apply_patch');
    expect(streamOptions.allowedToolIds).not.toContain('task_todo_update');
    expect(streamOptions.allowedToolIds).not.toContain('git_add');
    expect(streamOptions.allowedToolIds).not.toContain('git_commit');
    expect(streamOptions.allowedToolIds).not.toContain('terminal_run');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'Plan mode is read-only',
    );
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'end with a concrete implementation plan',
    );
  });

  it('exposes build tools but hides Architect task tools for standalone tasks', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Implement';
    appState.agentType = 'build';
    appState.selectedTaskId = 'task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [
      createImplementTask({
        status: 'InProgress',
        task_source: 'standalone',
        plan_id: '',
        project_id: 'project-1',
        project_ids: ['project-1'],
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/standalone-export',
            worktreeKey: 'standalone-export-web',
          },
        ],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Standalone export',
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
      content: 'Implémente cette tâche indépendante.',
      taskId: 'task-1',
    });

    const streamOptions = getLatestStreamOptions<{
      allowedToolIds: string[];
      messages: Array<{ role: string; content: string }>;
    }>();

    expect(streamOptions.allowedToolIds).toContain('terminal_create_session');
    expect(streamOptions.allowedToolIds).toContain('terminal_run');
    expect(streamOptions.allowedToolIds).toContain('write');
    expect(streamOptions.allowedToolIds).toContain('git_status');
    expect(streamOptions.allowedToolIds).not.toContain('task_todo_get');
    expect(streamOptions.allowedToolIds).not.toContain('task_todo_update');
    expect(streamOptions.allowedToolIds).not.toContain('task_artifact_list');
    expect(streamOptions.allowedToolIds).not.toContain('task_artifact_get');
    expect(streamOptions.allowedToolIds).not.toContain('task_artifact_put');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'This is a standalone implementation task',
    );
    expect(String(streamOptions.messages[0]?.content)).not.toContain('[Task Todos]');
  });

  it('keeps standalone Plan mode read-only without Architect task tools', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Implement';
    appState.agentType = 'plan';
    appState.selectedTaskId = 'task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [
      createImplementTask({
        status: 'InProgress',
        task_source: 'standalone',
        plan_id: '',
        project_id: 'project-1',
        project_ids: ['project-1'],
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/standalone-export',
            worktreeKey: 'standalone-export-web',
          },
        ],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Standalone export',
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
      content: 'Analyse avant de coder.',
      taskId: 'task-1',
    });

    const streamOptions = getLatestStreamOptions<{
      allowedToolIds: string[];
      messages: Array<{ role: string; content: string }>;
    }>();

    expect(streamOptions.allowedToolIds).toContain('read');
    expect(streamOptions.allowedToolIds).toContain('grep');
    expect(streamOptions.allowedToolIds).toContain('git_diff');
    expect(streamOptions.allowedToolIds).not.toContain('terminal_run');
    expect(streamOptions.allowedToolIds).not.toContain('write');
    expect(streamOptions.allowedToolIds).not.toContain('task_todo_get');
    expect(streamOptions.allowedToolIds).not.toContain('task_artifact_list');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'Plan mode is read-only',
    );
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'This is a standalone implementation task',
    );
  });

  it('returns a clear unavailable result for legacy Architect task tools on standalone tasks', async () => {
    providerState.selectedSupportsNativeToolCalling = () => true;
    appState.mode = 'Implement';
    appState.agentType = 'build';
    appState.selectedTaskId = 'task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [
      createImplementTask({
        status: 'InProgress',
        task_source: 'standalone',
        plan_id: '',
        project_id: 'project-1',
        project_ids: ['project-1'],
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/standalone-export',
            worktreeKey: 'standalone-export-web',
          },
        ],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Standalone export',
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
      content: 'Implémente cette tâche indépendante.',
      taskId: 'task-1',
    });

    const onToolCall = getLatestArchitectToolHandler();
    const todoResult = await onToolCall('task_todo_get', {});
    const artifactResult = await onToolCall('task_artifact_list', {});

    expect(String(todoResult)).toContain('unavailable for standalone tasks');
    expect(String(artifactResult)).toContain('unavailable for standalone tasks');
  });

  it('denies forced mutating tool calls during implement plan agent turns', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Prépare le plan de correction.',
      { agentType: 'plan' },
    );

    const patchResult = await onToolCall(
      'apply_patch',
      {
        patch_text:
          '*** Begin Patch\n*** Update File: src/App.tsx\n@@\n console.log("x")\n*** End Patch',
      },
      'call-plan-patch',
    );
    const commitResult = await onToolCall(
      'git_commit',
      { message: 'fix: update checkout flow' },
      'call-plan-commit',
    );

    expect(String(patchResult)).toContain('Plan mode is read-only');
    expect(String(commitResult)).toContain('Plan mode is read-only');
    expect(executeWorkspaceToolMock).not.toHaveBeenCalled();
  });

  it('challenges git_add once before allowing the same assistant turn to stage', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Corrige le code, mais ne stage rien.',
    );

    const firstResult = await onToolCall(
      'git_add',
      { paths: ['src/App.tsx'] },
      'call-add-1',
    );

    expect(String(firstResult)).toContain(
      'Do not stage or commit unless the user explicitly asked',
    );
    expect(executeWorkspaceToolMock).not.toHaveBeenCalled();

    await onToolCall('git_add', { paths: ['src/App.tsx'] }, 'call-add-2');

    expect(executeWorkspaceToolMock).toHaveBeenCalledTimes(1);
    expect(
      (executeWorkspaceToolMock as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]?.[0],
    ).toBe('git_add');
  });

  it('resets the git stage/commit challenge for a new assistant turn', async () => {
    const firstStreamCompletion = createDeferred<void>();
    const secondStreamCompletion = createDeferred<void>();
    streamChatMock
      .mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: string;
            usage: null;
          }) => void;
        };
        await firstStreamCompletion.promise;
        options.onComplete?.({
          visibleContent: 'Premier tour terminé.',
          toolTraces: [],
          hiddenContext: undefined,
          usage: null,
        });
        return { usage: null };
      }) as unknown as typeof streamChatMock)
      .mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: string;
            usage: null;
          }) => void;
        };
        await secondStreamCompletion.promise;
        options.onComplete?.({
          visibleContent: 'Second tour terminé.',
          toolTraces: [],
          hiddenContext: undefined,
          usage: null,
        });
        return { usage: null };
      }) as unknown as typeof streamChatMock);

    const { useChatStore, onToolCall } = await startImplementToolConversation(
      'Tu peux commit après vérification.',
    );

    await onToolCall(
      'git_commit',
      { message: 'fix: update checkout flow' },
      'call-commit-first-challenge',
    );
    await onToolCall(
      'git_commit',
      { message: 'fix: update checkout flow' },
      'call-commit-first-execute',
    );
    expect(executeWorkspaceToolMock).toHaveBeenCalledTimes(1);

    firstStreamCompletion.resolve();
    await flushAsyncWork();
    await useChatStore.getState().sendMessage({
      conversationId: 'implement-conv',
      content: 'Continue.',
      taskId: 'task-1',
    });
    await waitForStreamCallCount(2);

    const nextTurnToolCall = getLatestArchitectToolHandler();
    const nextTurnResult = await nextTurnToolCall(
      'git_commit',
      { message: 'fix: update checkout flow' },
      'call-commit-second-turn',
    );

    expect(String(nextTurnResult)).toContain(
      'Do not stage or commit unless the user explicitly asked',
    );
    expect(executeWorkspaceToolMock).toHaveBeenCalledTimes(1);

    secondStreamCompletion.resolve();
    await flushAsyncWork();
  });

  it('includes explicit anti stage/commit instructions when git tools are exposed', async () => {
    await startImplementToolConversation('Implémente la correction.');

    const streamOptions = getLatestStreamOptions<{
      allowedToolIds: string[];
      messages: Array<{ role: string; content: string }>;
    }>();

    expect(streamOptions.allowedToolIds).toContain('git_add');
    expect(streamOptions.allowedToolIds).toContain('git_commit');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'Never stage or commit on your own initiative',
    );
  });

  it('reminds build turns to execute the previous plan after a plan turn', async () => {
    streamChatMock
      .mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: string;
            usage: null;
          }) => void;
        };
        options.onComplete?.({
          visibleContent: 'Plan: inspecter les fichiers puis patcher.',
          toolTraces: [],
          hiddenContext: undefined,
          usage: null,
        });
        return { usage: null };
      }) as unknown as typeof streamChatMock)
      .mockImplementationOnce((async () => ({ usage: null })) as unknown as typeof streamChatMock);

    const { useChatStore } = await startImplementToolConversation(
      'Fais le plan.',
      { agentType: 'plan' },
    );
    await flushAsyncWork();

    appState.agentType = 'build';
    await useChatStore.getState().sendMessage({
      conversationId: 'implement-conv',
      content: 'Applique maintenant.',
      taskId: 'task-1',
    });
    await waitForStreamCallCount(2);

    const streamOptions = getLatestStreamOptions<{
      messages: Array<{ role: string; content: string }>;
      allowedToolIds: string[];
    }>();

    expect(streamOptions.allowedToolIds).toContain('write');
    expect(streamOptions.allowedToolIds).toContain('git_commit');
    expect(streamOptions.allowedToolIds).toContain('terminal_run');
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'The previous assistant turn used Plan mode',
    );
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'Execute the latest plan unless the user changed direction',
    );
  });

  it('lets implement agents read and update the selected task todos', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    architectPlans.set(
      'plan-1',
      createPlan({
        status: 'in_progress',
        targetBranch: 'develop',
        nodes: [
          {
            id: 'task-1',
            title: 'Implement checkout',
            description: 'Ship the checkout flow.',
            type: 'task',
            status: 'in-progress',
            dependencies: [],
            assignedBranch: 'feature/implement-checkout',
            branchType: 'feature',
            branchSlug: 'implement-checkout',
            projectId: 'project-1',
            projectIds: ['project-1'],
            todos: [
              { id: 'todo-1', title: 'Wire checkout API', status: 'done' },
              { id: 'todo-2', title: 'Update branch checklist', status: 'pending' },
            ],
          },
        ],
      }),
    );
    taskStoreState.tasks = [
      createImplementTask({
        status: 'InProgress',
        plan_storage_branch: 'develop',
        plan_target_branch: 'develop',
        todos: [
          { id: 'todo-1', title: 'Wire checkout API', status: 'done' },
          { id: 'todo-2', title: 'Update branch checklist', status: 'open' as never },
        ],
      }),
    ];

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
      content: 'Mets a jour la checklist.',
      taskId: 'task-1',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(String(streamOptions.messages[0]?.content)).toContain('[Task Todos]');
    expect(String(streamOptions.messages[0]?.content)).toContain('Update branch checklist');
    expect(String(streamOptions.messages[0]?.content)).toContain('progress="1/2"');
    expect(String(streamOptions.messages[0]?.content)).toContain('"status":"pending"');
    expect(String(streamOptions.messages[0]?.content)).not.toContain('"status":"open"');

    const onToolCall = getLatestArchitectToolHandler();
    const readResult = await onToolCall('task_todo_get', {});
    expect(String(readResult)).toContain('Update branch checklist');

    const updateResult = await onToolCall('task_todo_update', {
      operations: [
        {
          action: 'set_status',
          todo_id: 'todo-2',
          status: 'done',
        },
      ],
    });

    expect(String(updateResult)).toContain('2/2 todos done');
    expect(architectPlans.get('plan-1')?.nodes[0]?.todos?.[1]).toMatchObject({
      id: 'todo-2',
      status: 'done',
    });
    expect(taskStoreState.refreshFromPlan).toHaveBeenCalled();
  });

  it('reports legacy missing task todos and initializes them with add', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    architectPlans.set(
      'plan-1',
      createPlan({
        status: 'in_progress',
        targetBranch: 'develop',
        nodes: [
          {
            id: 'task-1',
            title: 'Legacy checkout',
            description: 'Ship the checkout flow.',
            type: 'task',
            status: 'in-progress',
            dependencies: [],
            assignedBranch: 'feature/legacy-checkout',
            branchType: 'feature',
            branchSlug: 'legacy-checkout',
            projectId: 'project-1',
            projectIds: ['project-1'],
          },
        ],
      }),
    );
    taskStoreState.tasks = [
      createImplementTask({
        title: 'Legacy checkout',
        status: 'InProgress',
        plan_storage_branch: 'develop',
        plan_target_branch: 'develop',
        todos: undefined,
      }),
    ];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Legacy checkout',
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
      content: 'Lis la checklist.',
      taskId: 'task-1',
    });

    const streamOptions = ((streamChatMock as unknown as {
      mock: { calls: Array<Array<unknown>> };
    }).mock.calls[0]?.[0] ?? null) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(String(streamOptions.messages[0]?.content)).toContain(
      'has no generated task checklist available'
    );
    expect(String(streamOptions.messages[0]?.content)).not.toContain('implicit:task-1');
    expect(String(streamOptions.messages[0]?.content)).not.toContain('Legacy checkout","description"');

    const onToolCall = getLatestArchitectToolHandler();
    const readResult = await onToolCall('task_todo_get', {});
    expect(String(readResult)).toContain('legacy_missing_todos');
    expect(String(readResult)).toContain('has no generated todos');

    const updateResult = await onToolCall('task_todo_update', {
      operations: [
        {
          action: 'add',
          title: 'Create first real todo',
        },
      ],
    });

    expect(String(updateResult)).toContain('0/1 todos done');
    expect(architectPlans.get('plan-1')?.nodes[0]?.todos).toEqual([
      expect.objectContaining({
        title: 'Create first real todo',
        status: 'pending',
      }),
    ]);
  });

  it('promotes a context project before opening an explicit implement terminal session', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [
      createImplementTask({
        status: 'InProgress',
        plan_storage_branch: 'develop',
        plan_target_branch: 'develop',
        project_ids: ['project-1'],
        context_project_ids: ['project-2'],
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/implement-checkout',
            worktreeKey: 'task-1-web',
          },
        ],
      }),
    ];

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
      content: 'Ouvre un terminal sur le projet API.',
      taskId: 'task-1',
    });

    const onToolCall = getLatestArchitectToolHandler();
    const result = await onToolCall('terminal_create_session', {
      project_id: 'project-2',
    });

    expect(taskStoreState.promoteTaskContextProjects).toHaveBeenCalledWith(
      'task-1',
      ['project-2'],
      { triggerTool: 'terminal_create_session' }
    );
    expect(terminalCreateSessionFromChatMock).toHaveBeenCalledWith({
      projectId: 'project-2',
      cwd: null,
    });
    expect(taskStoreState.getTaskById('task-1')).toMatchObject({
      project_ids: ['project-1', 'project-2'],
      context_project_ids: [],
      status: 'InProgress',
    });

    const resultText = String(result);
    const newlineIndex = resultText.indexOf('\n');
    const notice = resultText.slice(0, newlineIndex);
    const sessionJson = resultText.slice(newlineIndex + 1);
    expect(notice).toBe(
      '[macro_scope_promotion] {"promoted_project_ids":["project-2"],"retried_tool":"terminal_create_session"}'
    );
    const parsed = JSON.parse(sessionJson);
    expect(parsed.cwd).toBe('C:/repos/api/.macro/worktrees/task-1');
  });

  it('returns a controlled tool result instead of promoting context for standalone tasks', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [
      createManualFeatureTask({
        draft: false,
        status: 'InProgress',
        project_ids: ['project-1'],
        context_project_ids: ['project-2'],
        assigned_branch: 'feature/quick-export',
        branch_name: 'feature/quick-export',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/quick-export',
            worktreeKey: 'manual-task-1-web',
          },
        ],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    setImplementStoreState(useChatStore, {
      conversationId: 'manual-conv',
      taskId: 'manual-task-1',
      title: 'Manual feature',
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Ouvre un terminal sur le projet API.',
      taskId: 'manual-task-1',
    });

    taskStoreState.promoteTaskContextProjects.mockClear();
    terminalCreateSessionFromChatMock.mockClear();

    const onToolCall = getLatestArchitectToolHandler();
    const result = await onToolCall('terminal_create_session', {
      project_id: 'project-2',
    });

    expect(taskStoreState.promoteTaskContextProjects).not.toHaveBeenCalled();
    expect(terminalCreateSessionFromChatMock).not.toHaveBeenCalled();
    expect(String(result)).toContain('Cannot execute terminal_create_session');
    expect(String(result)).toContain('context promotion is only available for Architect tasks');
    expect(useChatStore.getState().lastError).toBeNull();
  });

  it('does not promote a standalone conversation even when the selected task is architect', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [
      createImplementTask({
        id: 'task-1',
        status: 'InProgress',
        plan_storage_branch: 'develop',
        plan_target_branch: 'develop',
        project_ids: ['project-1'],
        context_project_ids: ['project-2'],
      }),
      createManualFeatureTask({
        draft: false,
        status: 'InProgress',
        project_ids: ['project-1'],
        context_project_ids: ['project-2'],
        assigned_branch: 'feature/quick-export',
        branch_name: 'feature/quick-export',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/quick-export',
            worktreeKey: 'manual-task-1-web',
          },
        ],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    setImplementStoreState(useChatStore, {
      conversationId: 'manual-conv',
      taskId: 'manual-task-1',
      title: 'Manual feature',
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'manual-conv',
      content: 'Ouvre un terminal sur le projet API.',
      taskId: 'manual-task-1',
    });

    taskStoreState.promoteTaskContextProjects.mockClear();
    terminalCreateSessionFromChatMock.mockClear();

    const onToolCall = getLatestArchitectToolHandler();
    const result = await onToolCall('terminal_create_session', {
      project_id: 'project-2',
    });

    expect(taskStoreState.promoteTaskContextProjects).not.toHaveBeenCalled();
    expect(terminalCreateSessionFromChatMock).not.toHaveBeenCalled();
    expect(String(result)).toContain('Cannot execute terminal_create_session');
  });

  it('uses the conversation architect task for context promotion when selection is stale', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'manual-task-1';
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [
      createManualFeatureTask({
        draft: false,
        status: 'InProgress',
      }),
      createImplementTask({
        id: 'task-1',
        status: 'InProgress',
        plan_storage_branch: 'develop',
        plan_target_branch: 'develop',
        project_ids: ['project-1'],
        context_project_ids: ['project-2'],
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/implement-checkout',
            worktreeKey: 'task-1-web',
          },
        ],
      }),
    ];

    const { useChatStore } = await loadChatStore();
    setImplementStoreState(useChatStore, {
      conversationId: 'implement-conv',
      taskId: 'task-1',
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'implement-conv',
      content: 'Ouvre un terminal sur le projet API.',
      taskId: 'task-1',
    });

    taskStoreState.promoteTaskContextProjects.mockClear();

    const onToolCall = getLatestArchitectToolHandler();
    const result = await onToolCall('terminal_create_session', {
      project_id: 'project-2',
    });

    expect(taskStoreState.promoteTaskContextProjects).toHaveBeenCalledWith(
      'task-1',
      ['project-2'],
      { triggerTool: 'terminal_create_session' }
    );
    expect(taskStoreState.promoteTaskContextProjects).not.toHaveBeenCalledWith(
      'manual-task-1',
      ['project-2'],
      { triggerTool: 'terminal_create_session' }
    );
    expect(terminalCreateSessionFromChatMock).toHaveBeenCalledWith({
      projectId: 'project-2',
      cwd: null,
    });
    expect(String(result)).toContain('[macro_scope_promotion]');
  });

  it('returns the user denial reason when a pending tool approval is rejected', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    providerState.selectedSupportsNativeToolCalling = () => true;
    taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

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
      content: 'Lance une commande en terminal.',
      taskId: 'task-1',
    });

    const onToolCall = getLatestArchitectToolHandler();
    const toolCallPromise = onToolCall(
      'terminal_run',
      { command: 'npm test', session_id: 'session-1' },
      'tool-call-1'
    );

    await flushAsyncWork();

    expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolId).toBe(
      'terminal_run'
    );

    useChatStore
      .getState()
      .denyPendingToolApproval('implement-conv', 'Stay inside the workspace only.');

    await expect(toolCallPromise).resolves.toBe(
      'Tool terminal_run was denied by the user. User reason: Stay inside the workspace only.'
    );
    expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toBeNull();
  });

  it('clears conversation-scoped approval grants when the user switches conversations', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    providerState.selectedSupportsNativeToolCalling = () => true;
    taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
        },
        {
          ...createConversation('implement-conv-2'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement fallback',
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
      content: 'Lance une commande en terminal.',
      taskId: 'task-1',
    });

    const onToolCall = getLatestArchitectToolHandler();
    const firstToolCall = onToolCall(
      'terminal_run',
      { command: 'npm test', session_id: 'session-1' },
      'tool-call-1'
    );

    await flushAsyncWork();
    useChatStore.getState().approvePendingToolApprovalForConversation('implement-conv');
    await firstToolCall;

    expect(
      useChatStore.getState().conversationApprovalGrantsByConversationId['implement-conv']
    ).toHaveLength(1);

    useChatStore.getState().selectConversation('implement-conv-2');

    expect(
      useChatStore.getState().conversationApprovalGrantsByConversationId['implement-conv']
    ).toBeUndefined();

    const secondToolCall = onToolCall(
      'terminal_run',
      { command: 'npm test -- --watch=false', session_id: 'session-1' },
      'tool-call-2'
    );

    await flushAsyncWork();

    expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolCallId).toBe(
      'tool-call-2'
    );

    useChatStore.getState().denyPendingToolApproval('implement-conv');
    await expect(secondToolCall).resolves.toBe('Tool terminal_run was denied by the user.');
  });

  it('cancels a pending approval when the conversation stream is stopped', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    providerState.selectedSupportsNativeToolCalling = () => true;
    taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

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
      content: 'Lance une commande en terminal.',
      taskId: 'task-1',
    });

    const onToolCall = getLatestArchitectToolHandler();
    const toolCallPromise = onToolCall(
      'terminal_run',
      { command: 'npm test', session_id: 'session-1' },
      'tool-call-1'
    );
    const queuedToolCallPromise = onToolCall(
      'terminal_run',
      { command: 'npm test -- --watch=false', session_id: 'session-2' },
      'tool-call-2'
    );

    await flushAsyncWork();
    expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolCallId).toBe(
      'tool-call-1'
    );

    useChatStore.getState().stopConversationStream('implement-conv');

    await expect(toolCallPromise).resolves.toBe('Tool terminal_run was denied by the user.');
    await expect(queuedToolCallPromise).resolves.toBe('Tool terminal_run was denied by the user.');
    expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toBeNull();
    expect(terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().conversationApprovalGrantsByConversationId['implement-conv']
    ).toBeUndefined();
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

  it('does not start streaming when the user message cannot be persisted', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    createMessageMock.mockImplementationOnce(async () => {
      throw new Error('database unavailable');
    });

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
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
        conversationId: 'chat-conv',
        content: 'Hello',
      })
    ).rejects.toThrow('Failed to save the message before sending: database unavailable');

    expect(streamChatMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().getConversationMessages('chat-conv')).toHaveLength(0);
    expect(useChatStore.getState().sendState).toBe('error');
  });

  it('routes provider stream errors to the transcript without setting the composer error', async () => {
    appState.mode = 'Chat';
    streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as {
        onError?: (error: Error) => void;
      };
      const providerError = Object.assign(new Error('Provider returned error'), {
        name: 'ProviderRuntimeError',
        providerError: true,
        kind: 'rate_limited',
        status: 429,
        retryable: true,
        retryAfterMs: 45000,
        providerMessage: 'Too many requests for this model.',
        providerCode: 'rate_limit_exceeded',
        providerType: 'rate_limit',
      });
      options.onError?.(providerError);
      return { usage: null };
    }) as unknown as typeof streamChatMock);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Hello',
    });
    await flushAsyncWork();

    const assistantMessage = useChatStore
      .getState()
      .getConversationMessages('chat-conv')
      .find((message: { role: string }) => message.role === 'assistant');
    const runtime = useChatStore.getState().getConversationRuntime('chat-conv');

    expect(useChatStore.getState().lastError).toBeNull();
    expect(runtime.lastErrorOrigin).toBe('provider');
    expect(runtime.lastErrorDisplayTarget).toBe('transcript');
    expect(assistantMessage?.content).toContain('### Erreur du provider');
    expect(assistantMessage?.content).toContain('Too many requests for this model.');
    expect(assistantMessage?.content).toContain('Statut HTTP: `429`');
  });

  it('keeps launch-time Macro errors in the composer and removes the empty assistant placeholder', async () => {
    appState.mode = 'Chat';
    toolsStoreState.internalTools = {};
    toolsStoreState.lastError = 'settings unavailable';

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
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
        conversationId: 'chat-conv',
        content: 'Hello',
      }),
    ).rejects.toThrow('Failed to load tool settings');
    await flushAsyncWork();

    const messages = useChatStore.getState().getConversationMessages('chat-conv');
    const runtime = useChatStore.getState().getConversationRuntime('chat-conv');

    expect(messages.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(0);
    expect(useChatStore.getState().lastError).toContain('Failed to load tool settings');
    expect(runtime.lastErrorOrigin).toBe('macro');
    expect(runtime.lastErrorDisplayTarget).toBe('composer');
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it('preserves conversation-indexed messages when a launch-time Macro error removes a placeholder', async () => {
    appState.mode = 'Chat';
    toolsStoreState.internalTools = {};
    toolsStoreState.lastError = 'settings unavailable';

    const cachedOtherMessage = {
      id: 'cached-other-message',
      task_id: '',
      conversation_id: 'other-conv',
      role: 'user' as const,
      content: 'Keep me indexed only.',
      timestamp: '2026-04-14T10:00:00.000Z',
    };

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [
        createConversation('chat-conv', ''),
        createConversation('other-conv', ''),
      ],
      messages: [],
      messagesByConversationId: {
        'other-conv': [cachedOtherMessage],
      },
      messageIndexById: {},
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
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
        conversationId: 'chat-conv',
        content: 'Hello',
      }),
    ).rejects.toThrow('Failed to load tool settings');
    await flushAsyncWork();

    expect(useChatStore.getState().messagesByConversationId['other-conv']).toEqual([
      cachedOtherMessage,
    ]);
    expect(useChatStore.getState().getConversationMessages('other-conv')).toEqual([
      cachedOtherMessage,
    ]);
  });

  it('surfaces assistant persistence failures instead of losing them silently', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    createMessageMock.mockImplementationOnce(
      async (
        conversationId: string,
        role: 'user' | 'assistant',
        content: string,
        options?: {
          id?: string;
          turnId?: string | null;
          toolTraces?: unknown[];
          hiddenContext?: string;
          providerInputItems?: unknown[];
          providerTurnState?: unknown;
          contextRefs?: unknown[];
        }
      ) => ({
        id: 'db-user-message',
        conversation_id: conversationId,
        turn_id: options?.turnId ?? null,
        role,
        content,
        created_at: '2026-03-19T00:00:00.000Z',
        tool_traces_json: options?.toolTraces ? JSON.stringify(options.toolTraces) : null,
        hidden_context: options?.hiddenContext ?? null,
        provider_input_items_json: options?.providerInputItems
          ? JSON.stringify(options.providerInputItems)
          : null,
        provider_turn_state_json: options?.providerTurnState
          ? JSON.stringify(options.providerTurnState)
          : null,
        context_refs_json: options?.contextRefs
          ? JSON.stringify(options.contextRefs)
          : null,
      })
    );
    updateMessageMock.mockImplementation(async (_id, content) => {
      if (content === 'Persist me') {
        throw new Error('assistant write failed');
      }
    });
    streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as {
        onComplete?: (result: {
          visibleContent: string;
          toolTraces: unknown[];
          hiddenContext?: string;
        }) => void;
      };
      options.onComplete?.({
        visibleContent: 'Persist me',
        toolTraces: [],
        hiddenContext: undefined,
      });
    }) as unknown as typeof streamChatMock);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState({
      conversations: [createConversation('chat-conv', '')],
      messages: [],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      composerContextRefs: [],
    });

    await useChatStore.getState().sendMessage({
      conversationId: 'chat-conv',
      content: 'Hello',
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createMessageMock).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().lastError).toBe(
      'Failed to save assistant response: assistant write failed'
    );
    expect(useChatStore.getState().sendState).toBe('error');
    expect(
      useChatStore
        .getState()
        .getConversationMessages('chat-conv')
        .some((message: { role: string; content: string }) =>
          message.role === 'assistant' && message.content === 'Persist me'
        )
    ).toBe(true);
    updateMessageMock.mockImplementation(async () => undefined);
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

  it('stops an active Implement stream when the linked task becomes completed', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';
    taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

    const { cancelStream } = await import('../services/streamingChat');
    const cancelStreamMock = cancelStream as unknown as { mockClear: () => void; mock: { calls: unknown[][] } };
    cancelStreamMock.mockClear();

    const { useChatStore } = await loadChatStore();
    await Promise.resolve();

    const abortController = new AbortController();
    useChatStore.setState({
      conversations: [
        {
          ...createConversation('implement-conv'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          title: 'Task - Implement checkout',
        },
      ],
      conversationRuntimeById: {
        'implement-conv': {
          phase: 'streaming',
          sessionId: 'session-task-1',
          assistantMessageId: 'assistant-1',
          abortController,
          lastError: null,
        },
      },
      selectedConversationId: 'implement-conv',
      selectedConversationIdsByMode: { Implement: 'implement-conv' },
    });

    const previousTasks = taskStoreState.tasks;
    taskStoreState.tasks = [createImplementTask({ status: 'Completed' })];
    emitTaskStoreUpdate(previousTasks);
    await Promise.resolve();

    expect(useChatStore.getState().getConversationRuntime('implement-conv').phase).toBe('idle');
    expect(abortController.signal.aborted).toBe(true);
    expect(cancelStreamMock.mock.calls).toEqual([['session-task-1']]);
  });

  it('keeps an active Implement stream running for non-completed task transitions', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-1';

    for (const status of ['InReview', 'AwaitingResponse']) {
      taskStoreSubscribers.clear();
      taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

      const { cancelStream } = await import('../services/streamingChat');
      const cancelStreamMock = cancelStream as unknown as { mockClear: () => void; mock: { calls: unknown[][] } };
      cancelStreamMock.mockClear();

      const { useChatStore } = await loadChatStore();
      await Promise.resolve();

      useChatStore.setState({
        conversations: [
          {
            ...createConversation(`implement-conv-${status}`),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        conversationRuntimeById: {
          [`implement-conv-${status}`]: {
            phase: 'streaming',
            sessionId: `session-${status}`,
            assistantMessageId: 'assistant-1',
            abortController: new AbortController(),
            lastError: null,
          },
        },
        selectedConversationId: `implement-conv-${status}`,
        selectedConversationIdsByMode: { Implement: `implement-conv-${status}` },
      });

      const previousTasks = taskStoreState.tasks;
      taskStoreState.tasks = [createImplementTask({ status })];
      emitTaskStoreUpdate(previousTasks);
      await Promise.resolve();

      expect(useChatStore.getState().getConversationRuntime(`implement-conv-${status}`).phase).toBe('streaming');
      expect(cancelStreamMock.mock.calls).toEqual([]);
    }
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
    expect(deleteConversationToolboxStateMock).toHaveBeenCalledWith('chat-1');
    expect(deleteConversationToolboxStateMock).toHaveBeenCalledWith('chat-2');
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

  it('does not restore messages when deletion wins a deferred conversation load', async () => {
    tauriAvailable = true;
    const deferredMessages = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
    listMessagesMock.mockImplementationOnce(async () => deferredMessages.promise);
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        { ...createConversation('chat-1'), scope_mode: 'Chat', message_count: 1 },
      ],
      selectedConversationId: 'chat-1',
      selectedConversationIdsByMode: { Chat: 'chat-1' },
    }));

    const loading = useChatStore.getState().ensureMessagesLoaded('chat-1');
    await Promise.resolve();
    await useChatStore.getState().deleteChatConversations(['chat-1']);
    deferredMessages.resolve([
      createChatMessageRecord({ id: 'late-message', conversation_id: 'chat-1' }),
    ]);
    await loading;

    expect(useChatStore.getState().conversations).toEqual([]);
    expect(useChatStore.getState().getConversationMessages('chat-1')).toEqual([]);
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
      content: 'rép',
      timestamp: '2026-03-19T00:02:00.000Z',
      tool_traces: [],
    });

    const beforeMessages = useChatStore.getState().messages;

    useChatStore.getState().appendToMessage('m-assistant', 'onse');

    const afterMessages = useChatStore.getState().messages;
    expect(afterMessages[0]).toBe(beforeMessages[0]);
    expect(afterMessages[1]).not.toBe(beforeMessages[1]);
    expect(afterMessages[1]?.content).toBe('réponse');
    expect(
      useChatStore
        .getState()
        .getConversationMessages('conv-1')
        .map((message: { id: string }) => message.id)
    ).toEqual(['m-user', 'm-assistant']);
  });

  it('claims an edited conversation before credential loading so a second replay cannot trim it', async () => {
    appState.mode = 'Chat';
    providerState.providerConfigs = [
      {
        ...DEFAULT_PROVIDER_CONFIGS[0],
        isLocal: false,
      },
    ];
    const credential = createDeferred<undefined>();
    providerState.resolveProviderApiKey.mockImplementationOnce(
      async () => credential.promise,
    );

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv')],
      messages: [
        {
          id: 'user-1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user',
          content: 'Original request',
          timestamp: '2026-03-19T00:01:00.000Z',
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    const firstEdit = useChatStore.getState().editMessage(
      'user-1',
      'First replay request',
      { skipAgentCodeReplayCheck: true },
    );
    await Promise.resolve();

    expect(useChatStore.getState().getConversationRuntime('chat-conv').phase).toBe(
      'preparing',
    );
    await expect(
      useChatStore.getState().editMessage(
        'user-1',
        'Second replay request',
        { skipAgentCodeReplayCheck: true },
      ),
    ).rejects.toThrow(
      'This conversation is already running. Wait for it to finish before sending again.',
    );

    useChatStore.getState().stopConversationStream('chat-conv');
    credential.resolve(undefined);
    await firstEdit;

    expect(useChatStore.getState().getConversationRuntime('chat-conv').phase).toBe('idle');
    expect(useChatStore.getState().getConversationMessages('chat-conv')).toHaveLength(1);
    expect(deleteMessagesAfterMock).not.toHaveBeenCalled();
  });

  it('removes a deferred edit-replay placeholder when Stop wins after its creation', async () => {
    tauriAvailable = true;
    appState.mode = 'Chat';
    const placeholderCreated = createDeferred<ReturnType<typeof createChatMessageRecord>>();
    (
      createMessageMock as unknown as {
        mockImplementationOnce: (
          implementation: (...args: unknown[]) => Promise<ReturnType<typeof createChatMessageRecord>>,
        ) => void;
      }
    ).mockImplementationOnce(async () => placeholderCreated.promise);

    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-conv')],
      messages: [
        {
          id: 'user-1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user',
          content: 'Original request',
          timestamp: '2026-03-19T00:01:00.000Z',
        },
      ],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
    }));

    const edit = useChatStore.getState().editMessage(
      'user-1',
      'Edited request',
      { skipAgentCodeReplayCheck: true },
    );
    await flushAsyncWork();
    expect(createMessageMock).toHaveBeenCalledWith(
      'chat-conv',
      'assistant',
      '',
      expect.objectContaining({ turnId: 'legacy-turn-user-1' }),
    );

    useChatStore.getState().stopConversationStream('chat-conv');
    placeholderCreated.resolve(
      createChatMessageRecord({
        id: 'deferred-assistant',
        conversation_id: 'chat-conv',
        role: 'assistant',
        content: '',
      }),
    );
    await edit;

    expect(
      useChatStore.getState().getConversationMessages('chat-conv'),
    ).not.toContainEqual(expect.objectContaining({ id: 'deferred-assistant' }));
    expect(deleteMessagesAfterMock).toHaveBeenCalledWith('chat-conv', 'user-1');
  });

  it('keeps generation A bound to its captured context after delayed loading', async () => {
    appState.mode = 'Implement';
    appState.agentType = 'build';
    appState.selectedTaskId = 'task-1';
    tauriAvailable = true;
    localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
    taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];
    const deferredA = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
    listMessagesMock.mockImplementationOnce(async () => deferredA.promise);
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        {
          ...createConversation('chat-a'),
          scope_mode: 'Implement',
          task_id: 'task-1',
          message_count: 1,
        },
        { ...createConversation('chat-b'), scope_mode: 'Chat', message_count: 0 },
      ],
      selectedConversationId: 'chat-a',
      selectedConversationIdsByMode: { Implement: 'chat-a' },
    }));

    const sendA = useChatStore.getState().sendMessage({
      conversationId: 'chat-a', content: 'A stays isolated.', taskId: 'task-1',
    });
    await Promise.resolve();
    appState.mode = 'Chat';
    appState.selectedTaskId = 'task-b';
    appState.selectedProjectId = 'project-2';
    providerState.selectedProviderId = 'provider-2';
    providerState.selectedModelId = 'model-2';
    deferredA.resolve([createChatMessageRecord({
      id: 'history-a', conversation_id: 'chat-a', role: 'user',
    })]);

    await expect(sendA).resolves.toMatchObject({ status: 'sent', conversationId: 'chat-a' });
    const options = getLatestStreamOptions<{
      conversationId?: string;
      providerId?: string;
      modelId?: string;
      onToolCall?: (
        toolName: string,
        args: Record<string, unknown>,
        toolCallId?: string,
      ) => Promise<unknown>;
    }>();
    expect(options.conversationId).toBe('chat-a');
    expect(options.providerId).toBe('provider-1');
    expect(options.modelId).toBe('model-1');
    expect(useChatStore.getState().getConversationMessages('chat-a').every(
      (message: ChatMessage) => message.conversation_id === 'chat-a',
    )).toBe(true);
    await options.onToolCall?.('read', { path: 'src/a.ts' }, 'read-from-a');
    expect(executeWorkspaceToolMock).toHaveBeenCalledWith(
      'read',
      { path: 'src/a.ts' },
      'Implement',
      expect.objectContaining({ projectId: 'project-1' }),
    );
  });

  it('does not revive stopped preparation A after generation B starts', async () => {
    appState.mode = 'Chat';
    tauriAvailable = true;
    const deferredA = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
    listMessagesMock.mockImplementationOnce(async () => deferredA.promise);
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        { ...createConversation('chat-a'), scope_mode: 'Chat', message_count: 1 },
        { ...createConversation('chat-b'), scope_mode: 'Chat', message_count: 0 },
      ],
      selectedConversationId: 'chat-a',
      selectedConversationIdsByMode: { Chat: 'chat-a' },
    }));

    const sendA = useChatStore.getState().sendMessage({
      conversationId: 'chat-a', content: 'late A',
    });
    await Promise.resolve();
    expect(listMessagesMock).toHaveBeenCalledWith('chat-a');
    expect(useChatStore.getState().getConversationRuntime('chat-a').phase).toBe('preparing');
    useChatStore.getState().stopConversationStream('chat-a');
    const sendB = await useChatStore.getState().sendMessage({
      conversationId: 'chat-b', content: 'live B',
    });
    deferredA.resolve([createChatMessageRecord({
      id: 'history-a', conversation_id: 'chat-a', role: 'user',
    })]);

    await expect(sendA).resolves.toMatchObject({ status: 'cancelled', conversationId: 'chat-a' });
    expect(sendB).toMatchObject({ status: 'sent', conversationId: 'chat-b' });
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    expect(getLatestStreamOptions<{ conversationId?: string }>().conversationId).toBe('chat-b');
    expect(executeWorkspaceToolMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().getConversationRuntime('chat-a').phase).toBe('idle');
    expect(useChatStore.getState().getConversationRuntime('chat-b').phase).toBe('streaming');
    expect(useChatStore.getState().getConversationMessages('chat-a').some(
      (message: ChatMessage) => message.content === 'late A',
    )).toBe(false);
  });

  it('does not clear B composer references when A finishes preparing', async () => {
    appState.mode = 'Chat';
    tauriAvailable = true;
    const deferredA = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
    listMessagesMock.mockImplementationOnce(async () => deferredA.promise);
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        { ...createConversation('chat-a'), message_count: 1 },
        createConversation('chat-b'),
      ],
      selectedConversationId: 'chat-a',
      selectedConversationIdsByMode: { Chat: 'chat-a' },
    }));
    useChatStore.getState().replaceComposerContextRefs([
      { id: 'src/a.ts', kind: 'file', title: 'a.ts', path: 'src/a.ts' },
    ], 'chat-a');

    const sendA = useChatStore.getState().sendMessage({
      conversationId: 'chat-a', content: 'A keeps its references.',
    });
    await Promise.resolve();
    useChatStore.setState({
      selectedConversationId: 'chat-b',
      selectedConversationIdsByMode: { Chat: 'chat-b' },
    });
    const bRefs = [
      { id: 'src/b.ts', kind: 'file' as const, title: 'b.ts', path: 'src/b.ts' },
    ];
    useChatStore.getState().replaceComposerContextRefs(bRefs, 'chat-b');
    deferredA.resolve([createChatMessageRecord({
      id: 'history-a', conversation_id: 'chat-a', role: 'user',
    })]);

    await expect(sendA).resolves.toMatchObject({ status: 'sent', conversationId: 'chat-a' });
    expect(useChatStore.getState().composerContextRefs).toEqual(bRefs);
  });

  it('clears A toolbox references without touching B after a selection-only switch', async () => {
    appState.mode = 'Chat';
    tauriAvailable = true;
    const deferredA = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
    listMessagesMock.mockImplementationOnce(async () => deferredA.promise);
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [
        { ...createConversation('chat-a'), message_count: 1 },
        createConversation('chat-b'),
      ],
      selectedConversationId: 'chat-a',
      selectedConversationIdsByMode: { Chat: 'chat-a' },
    }));
    useChatStore.getState().replaceComposerContextRefs([
      { id: 'src/a.ts', kind: 'file', title: 'a.ts', path: 'src/a.ts' },
    ], 'chat-a');

    const sendA = useChatStore.getState().sendMessage({
      conversationId: 'chat-a', content: 'A sends while B is selected.',
    });
    await Promise.resolve();
    const bRefs = [
      { id: 'src/b.ts', kind: 'file' as const, title: 'b.ts', path: 'src/b.ts' },
    ];
    useChatStore.setState({
      selectedConversationId: 'chat-b',
      selectedConversationIdsByMode: { Chat: 'chat-b' },
      composerContextRefs: bRefs,
    });
    deferredA.resolve([createChatMessageRecord({
      id: 'history-a', conversation_id: 'chat-a', role: 'user',
    })]);

    await expect(sendA).resolves.toMatchObject({ status: 'sent', conversationId: 'chat-a' });
    await waitForToolboxPersistence();
    expect(useChatStore.getState().composerContextRefs).toEqual(bRefs);
    expect(deleteConversationToolboxStateMock).toHaveBeenCalledWith('chat-a');
    expect(deleteConversationToolboxStateMock).not.toHaveBeenCalledWith('chat-b');
  });

  it('keeps the Architect plan and branch captured at send when the selection changes', async () => {
    appState.mode = 'Architect';
    const planA = createScenarioPlan('blank', {
      id: 'plan-a-at-send', targetBranch: 'feature/plan-a', conversationId: undefined,
    });
    const planB = createScenarioPlan('started', {
      id: 'plan-b-after-send', targetBranch: 'feature/plan-b', conversationId: 'chat-b',
    });
    architectPlans.set(planA.id, planA);
    architectPlans.set(planB.id, planB);
    appState.activeArchitectPlanId = planA.id;
    appState.activePlanContext = { id: planA.id, targetBranch: planA.targetBranch };
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState());
    const conversationId = await useChatStore.getState().ensureConversationForCurrentMode();
    expect(conversationId).toMatch(/^pending-architect-/);

    providerState.providerConfigs = [{ ...DEFAULT_PROVIDER_CONFIGS[0], isLocal: false }];
    const credential = createDeferred<undefined>();
    providerState.resolveProviderApiKey.mockImplementationOnce(async () => credential.promise);

    const send = useChatStore.getState().sendMessage({
      conversationId: conversationId!, content: 'Keep plan A.',
    });
    await flushAsyncWork();
    expect(providerState.resolveProviderApiKey).toHaveBeenCalledWith('provider-1');
    appState.activeArchitectPlanId = planB.id;
    appState.activePlanContext = { id: planB.id, targetBranch: planB.targetBranch };
    credential.resolve(undefined);

    const result = await send;
    expect(result).toMatchObject({ status: 'sent' });
    expect(bindArchitectPlanConversationMock).toHaveBeenCalledWith({
      branchName: planA.targetBranch,
      planId: planA.id,
      conversationId: result.conversationId,
    });
    expect(syncArchitectPlanChatFromConversationMock).toHaveBeenCalledWith({
      branchName: planA.targetBranch,
      planId: planA.id,
      conversationId: result.conversationId,
    });
    expect(bindArchitectPlanConversationMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ planId: planB.id }),
    );
  });

  it('publishes a user message persisted just before Stop without deleting its anchor', async () => {
    appState.mode = 'Chat';
    tauriAvailable = true;
    const persistedUser = createDeferred<Awaited<ReturnType<typeof createMessageMock>>>();
    createMessageMock.mockImplementationOnce(async () => persistedUser.promise);
    const { useChatStore } = await loadChatStore();
    useChatStore.setState(createIdleChatStoreState({
      conversations: [createConversation('chat-a')],
      selectedConversationId: 'chat-a',
      selectedConversationIdsByMode: { Chat: 'chat-a' },
    }));

    const send = useChatStore.getState().sendMessage({
      conversationId: 'chat-a', content: 'Persisted before Stop.',
    });
    await Promise.resolve();
    useChatStore.getState().stopConversationStream('chat-a');
    persistedUser.resolve({
      id: 'persisted-user',
      conversation_id: 'chat-a',
      turn_id: null,
      role: 'user',
      content: 'Persisted before Stop.',
      created_at: '2026-03-19T00:00:00.000Z',
      tool_traces_json: null,
      hidden_context: null,
      provider_input_items_json: null,
      provider_turn_state_json: null,
      context_refs_json: null,
    });

    await expect(send).resolves.toMatchObject({
      status: 'sent',
      conversationId: 'chat-a',
      userMessageId: 'persisted-user',
      assistantMessageId: null,
    });
    expect(useChatStore.getState().getConversationMessages('chat-a')).toEqual([
      expect.objectContaining({ id: 'persisted-user', role: 'user' }),
    ]);
    expect(deleteMessagesAfterMock).not.toHaveBeenCalled();
  });
});

describe('useChatStore composer draft queue', () => {
  let useChatStore: Awaited<ReturnType<typeof loadChatStore>>['useChatStore'];

  beforeEach(async () => {
    ({ useChatStore } = await loadChatStore());
    useChatStore.setState((state: { pendingComposerDraftByConversationId?: Record<string, string> }) => ({
      ...state,
      pendingComposerDraftByConversationId: {},
    }));
  });

  it('records a draft prompt keyed by conversation id', () => {
    useChatStore.getState().setComposerDraft('conv-1', 'Resolve the merge blocker.');
    expect(
      useChatStore.getState().pendingComposerDraftByConversationId['conv-1']
    ).toBe('Resolve the merge blocker.');
  });

  it('returns and removes the draft when consumed', () => {
    useChatStore.getState().setComposerDraft('conv-1', 'Draft text');

    const consumed = useChatStore.getState().consumeComposerDraft('conv-1');

    expect(consumed).toBe('Draft text');
    expect(
      useChatStore.getState().pendingComposerDraftByConversationId['conv-1']
    ).toBeUndefined();
  });

  it('returns null and does not mutate state when no draft exists', () => {
    const before = useChatStore.getState().pendingComposerDraftByConversationId;
    const consumed = useChatStore.getState().consumeComposerDraft('missing-conv');

    expect(consumed).toBeNull();
    expect(useChatStore.getState().pendingComposerDraftByConversationId).toBe(before);
  });

  it('keeps drafts for other conversations isolated', () => {
    useChatStore.getState().setComposerDraft('conv-1', 'First draft');
    useChatStore.getState().setComposerDraft('conv-2', 'Second draft');

    useChatStore.getState().consumeComposerDraft('conv-1');

    const state = useChatStore.getState().pendingComposerDraftByConversationId;
    expect(state['conv-1']).toBeUndefined();
    expect(state['conv-2']).toBe('Second draft');
  });

  it('peekComposerDraft reads without consuming the draft', () => {
    useChatStore.getState().setComposerDraft('conv-1', 'Draft for review.');

    const peeked = useChatStore.getState().peekComposerDraft('conv-1');
    expect(peeked).toBe('Draft for review.');

    // Peek is idempotent.
    expect(useChatStore.getState().peekComposerDraft('conv-1')).toBe('Draft for review.');
    expect(
      useChatStore.getState().pendingComposerDraftByConversationId['conv-1']
    ).toBe('Draft for review.');
  });

  it('peekComposerDraft returns null for an unknown conversation', () => {
    expect(useChatStore.getState().peekComposerDraft('missing')).toBeNull();
  });

  it('acknowledgeComposerDraft drops the draft without returning it', () => {
    useChatStore.getState().setComposerDraft('conv-1', 'Will be dropped.');

    const returned = useChatStore.getState().acknowledgeComposerDraft('conv-1');
    expect(returned).toBeUndefined();
    expect(
      useChatStore.getState().pendingComposerDraftByConversationId['conv-1']
    ).toBeUndefined();
  });
});
