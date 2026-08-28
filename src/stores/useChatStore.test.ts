import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  AgentType,
  AppMode,
  Conversation,
  MCPServer,
  ProjectGroup,
  SkillManifest,
} from '../types';
import type { ScopedTurnConfiguration } from '../services/configurationClient';
import {
  type ArchitectPlanRecord,
  type ArchitectPlanStatus,
} from '../services/architectPlanService';
import { createDeferred } from '../test-utils/deferred';
import { registerComposerDraftQueueScenarios } from './__tests__/composerDraftQueue.scenarios';
import { registerArchitectLifecycleScenarios } from './__tests__/architectLifecycle.scenarios';
import { registerArchitectStrategyScenarios } from './__tests__/architectStrategy.scenarios';
import { registerChatToolsAndSourcesScenarios } from './__tests__/chatToolsAndSources.scenarios';
import { registerCompactionAndDiagnosticsScenarios } from './__tests__/compactionAndDiagnostics.scenarios';
import { registerImplementPolicyScenarios } from './__tests__/implementPolicy.scenarios';
import { registerImplementSelectionScenarios } from './__tests__/implementSelection.scenarios';
import { registerQuestionnaireFlowScenarios } from './__tests__/questionnaireFlow.scenarios';
import { registerReplayAndEditingScenarios } from './__tests__/replayAndEditing.scenarios';
import { registerSendRuntimeAndDeletionScenarios } from './__tests__/sendRuntimeAndDeletion.scenarios';
import { registerConversationSelectionScenarios } from './__tests__/conversationSelection.scenarios';
import { registerQuestionnaireNavigationScenarios } from './__tests__/questionnaireNavigation.scenarios';
const actualTauriIpc = await import('../services/tauriIpc');
const actualConfigurationClient = await import('../services/configurationClient');

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
        gitSetupState: 'ready',
        directEdit: false,
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
  language?: string;
  sizeBytes?: number;
  kind?: 'interesting' | 'used';
  reason?: string;
};

let citationCounter = 0;
let citationRecords: TestCitation[] = [];
let citationPersistenceError: Error | null = null;

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
    taskKind: 'feature' | 'bugfix' | 'hotfix';
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
            task_kind: params.taskKind,
            assigned_branch: `${params.taskKind}/${params.featureSlug}`,
            branch_name: `${params.taskKind}/${params.featureSlug}`,
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
  deleteTask: mock(async (taskId: string) => {
    await taskStoreState.deleteManualFeatureDraft(taskId);
  }),
};

const architectPlans = new Map<string, ArchitectPlanRecord>();
const architectPlanMessages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }>>();
let tauriAvailable = false;
let scopedTurnConfigurationForTest: ScopedTurnConfiguration | null = null;
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
    Math.max(
      1,
      Math.ceil(
        JSON.stringify(params.messages, (_key, value) =>
          typeof value === 'string' && value.startsWith('data:image/')
            ? '[image attachment]'
            : value
        ).length / 4
      )
    )
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
const fsExistsMock = mock(async () => true);
const fsWriteFileMock = mock(async (params: { path: string; content: string }) => ({
  path: params.path,
  bytes_written: new TextEncoder().encode(params.content).length,
  created: false,
  revision: 'written-revision',
}));
const fsDeleteMock = mock(async () => undefined);
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
const appSettingValues = new Map<string, string>();
const dbGetAppSettingMock = mock(async (key: string) => {
  const valueJson = appSettingValues.get(key);
  return valueJson === undefined
    ? null
    : { key, value_json: valueJson, updated_at: '2026-08-12T00:00:00.000Z' };
});
const dbSetAppSettingMock = mock(async ({ key, valueJson }: {
  key: string;
  valueJson: string;
}) => {
  appSettingValues.set(key, valueJson);
});
const dbDeleteAppSettingMock = mock(async (key: string) =>
  appSettingValues.delete(key)
);
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
const dbTrimConversationReplayMock = mock(async () => undefined);
const dbPrepareConversationReplayMock = mock(async () => undefined);
const dbRestoreConversationReplayMock = mock(async () => true);
const dbCompleteConversationReplayMock = mock(async () => undefined);
const dbMarkConversationReplayLaunchedMock = mock(async () => undefined);
const dbFinalizeConversationReplayMock = mock(async () => undefined);
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
const createTerminalSessionFromChatDto = (params: {
  sessionId: string;
  projectId?: string | null;
  cwd?: string | null;
}) => ({
  id: params.sessionId,
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
      ? 'C:/repos/api/.macro/worktrees/task-1'
      : 'C:/repos/web/.macro/worktrees/task-1'),
  status: 'idle',
  last_command: null,
  output: '',
  exit_code: null,
  timed_out: false,
  updated_at: '2026-03-26T10:00:00.000Z',
});
const terminalSessionsFromChat = new Map<
  string,
  ReturnType<typeof createTerminalSessionFromChatDto>
>();
const terminalCreateSessionFromChatMock = mock(
  async ({
    projectId,
    cwd,
  }: {
    projectId?: string | null;
    cwd?: string | null;
  }) => {
    const session = createTerminalSessionFromChatDto({
      sessionId: projectId ? `session-${projectId}` : 'session-general',
      projectId,
      cwd,
    });
    terminalSessionsFromChat.set(session.id, session);
    return session;
  }
);
const terminalReadSessionFromChatMock = mock(async (sessionId: string) => {
  const session =
    terminalSessionsFromChat.get(sessionId) ??
    createTerminalSessionFromChatDto({ sessionId, projectId: 'project-1' });
  terminalSessionsFromChat.set(sessionId, session);
  return session;
});
const terminalKillSessionFromChatMock = mock(
  async (sessionId: string, _executionId?: string | null) => {
    const session = terminalSessionsFromChat.get(sessionId);
    if (!session) {
      throw new Error(`Unknown terminal session ${sessionId}`);
    }
    return { ...session, status: 'killed' };
  }
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
    executionId?: string | null;
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
  mock.restore();

  // Scoped configuration has focused tests of its own. Keep this broad chat
  // suite on its existing preference harness so native-only tests do not need
  // to emulate the complete configuration IPC surface.
  mock.module('../services/configurationClient', () => ({
    ...actualConfigurationClient,
    isConfigurationClientAvailable: () => false,
    loadScopedTurnConfiguration: async () => scopedTurnConfigurationForTest,
  }));
  const actualPreferences = await import(
    `../services/preferences.ts?chat-store-preferences-test=${importCounter + 1}`
  );

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
      setState: (next: { citations?: TestCitation[] }) => {
        if (next.citations) citationRecords = next.citations;
      },
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
        addCitationAndPersist: async (
          citation: Omit<TestCitation, 'id' | 'timestamp'>,
        ) => {
          if (citationPersistenceError) throw citationPersistenceError;
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
        pruneConversationCitations: (conversationId: string, keepMessageIds: string[]) => {
          const keepSet = new Set(keepMessageIds);
          citationRecords = citationRecords.filter(
            (citation) =>
              citation.conversationId !== conversationId ||
              keepSet.has(citation.messageId),
          );
        },
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
        sessions: Object.fromEntries(terminalSessionsFromChat),
        createSession: terminalCreateSessionFromChatMock,
        runCommand: terminalRunCommandFromChatMock,
        readSession: terminalReadSessionFromChatMock,
        killSession: terminalKillSessionFromChatMock,
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
    resolveMutatingToolApprovalScope: mock((_toolName: string, args: Record<string, unknown>) =>
      typeof args.project_id === 'string' ? `project:${args.project_id}` : 'project:project-1'
    ),
    resolveExplicitMutatingToolProjectTargets: mock((_toolName: string, args: Record<string, unknown>) => {
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
    dbGetAppSetting: dbGetAppSettingMock,
    dbSetAppSetting: dbSetAppSettingMock,
    dbDeleteAppSetting: dbDeleteAppSettingMock,
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
    fsExists: fsExistsMock,
    fsReadFileWithOptions: fsReadFileWithOptionsMock,
	    fsWriteFile: fsWriteFileMock,
	    fsDelete: fsDeleteMock,
	    updateMessage: updateMessageMock,
    deleteMessagesAfter: deleteMessagesAfterMock,
    dbTrimConversationReplay: dbTrimConversationReplayMock,
    dbPrepareConversationReplay: dbPrepareConversationReplayMock,
    dbRestoreConversationReplay: dbRestoreConversationReplayMock,
    dbCompleteConversationReplay: dbCompleteConversationReplayMock,
    dbMarkConversationReplayLaunched: dbMarkConversationReplayLaunchedMock,
    dbFinalizeConversationReplay: dbFinalizeConversationReplayMock,
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
      projectMounts: [
        {
          projectId: 'project-1',
          groupId: 'group-1',
          mountName: 'web',
          displayName: 'Web',
          workspacePath: 'C:/repos/web/.macro/worktrees/task-1',
          isReadOnly: false,
        },
        {
          projectId: 'project-2',
          groupId: 'group-1',
          mountName: 'api',
          displayName: 'API',
          workspacePath: 'C:/repos/api/.macro/worktrees/task-1',
          isReadOnly: true,
        },
      ],
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

const savePreferenceForTest = async (key: string, value: unknown) => {
  const preferences = await import('../services/preferences');
  await preferences.savePreference(
    key as (typeof preferences.PREF_KEYS)[keyof typeof preferences.PREF_KEYS],
    value,
  );
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
  providerState.selectedSupportsNativeToolCalling = () => true;
  const preferences = await import('../services/preferences');
  await preferences.savePreference(preferences.PREF_KEYS.TOOL_RISK_LEVEL, 'yolo');
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
  contentHash: 'sha256:test-skill-content',
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
  await savePreferenceForTest('toolRiskLevel', 'yolo');
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

const useChatStoreScenarioContext = {
  COMPACTED_STATE_MARKER,
  DEFAULT_PROVIDER_CONFIGS,
  appState,
  projectGroups,
  appSettingValues,
  activateArchitectPlanForTest,
  architectPlanConversationSyncRecords,
  architectPlanMessages,
  architectPlans,
  bindArchitectPlanConversationMock,
  createArchitectStoreState,
  buildManualCompactionLoad,
  createCitationId,
  createChatMessageRecord,
  createChatSnapshotConversation,
  createCommitRestoredSelectionMock,
  createConversation,
  createConversationMock,
  createDbConversationCompactionState,
  createDeferred,
  createIdleChatStoreState,
  createImplementTask,
  createManualFeatureTask,
  createMessageMock,
  createPlan,
  createScenarioPlan,
  createSkillManifest,
  createTerminalSessionFromChatDto,
  createTranscriptEntry,
  dbCompleteConversationReplayMock,
  dbFinalizeConversationReplayMock,
  dbGetArchitectPlanConversationSyncMock,
  dbGetConversationCompactionStateMock,
  dbMarkConversationReplayLaunchedMock,
  dbPrepareConversationReplayMock,
  dbRestoreConversationReplayMock,
  dbUpsertConversationCompactionStateMock,
  dbUpsertArchitectPlanConversationSyncMock,
  deleteConversationMock,
  deleteConversationsMock,
  deleteMessagesAfterMock,
  deleteConversationToolboxStateMock,
  emitProviderStoreUpdate,
  emitTaskStoreUpdate,
  ensureCitationContentLoadedMock,
  executeWorkspaceToolMock,
  fetchWebPageMock,
  flushAsyncWork,
  fsReadFileWithOptionsMock,
  fsExistsMock,
  fsWriteFileMock,
  fsDeleteMock,
  expectArchitectSelection,
  getArchitectPlanActivationPayloadMock,
  getArchitectPlanMock,
  getArchitectPlanChatTranscriptMock,
  getChatBootstrapSnapshotMock,
  getChatSnapshotMock,
  getLatestArchitectToolHandler,
  getLatestStreamOptions,
  getConversationToolboxStateMock,
  getLocalProjectContextStateMock,
  getToolModePolicyMock,
  gitBranchListMock,
  installSkillActivationMock,
  listMessagesMock,
  loadAiSelectionsPreference,
  loadChatStore,
  importMessagesMock,
  providerState,
  queueSendChatNonStreamingImplementation,
  registerUseChatStoreMocks,
  savePreferenceForTest,
  sendArchitectMessageAndGetToolHandler,
  sendChatNonStreamingMock,
  setImplementStoreState,
  setArchitectStoreState,
  setSendChatNonStreamingImplementation,
  saveAiSelectionsPreference,
  setSelectedProviderModelContext,
  toolboxStateByConversationId,
  streamChatMock,
  startImplementToolConversation,
  taskStoreState,
  taskStoreSubscribers,
  terminalCreateSessionFromChatMock,
  terminalRunCommandFromChatMock,
  terminalSessionsFromChat,
  toolsStoreState,
  syncArchitectPlanChatFromConversationMock,
  updateArchitectPlanMock,
  updateConversationDetailsMock,
  updateConversationScopeMock,
  updateMessageMock,
  useAppStoreMock,
  useProviderStoreMock,
  updateConversationAISelectionMock,
  upsertConversationToolboxStateMock,
  waitForToolboxPersistence,
  waitForConversationDiagnostics,
  waitForStreamCallCount,
  webSearchMock,
  get tauriAvailable() {
    return tauriAvailable;
  },
  set tauriAvailable(value: boolean) {
    tauriAvailable = value;
  },
  get chatSnapshotConversations() {
    return chatSnapshotConversations;
  },
  set chatSnapshotConversations(value: ChatSnapshotConversationRecord[]) {
    chatSnapshotConversations = value;
  },
  get chatSnapshotMessages() {
    return chatSnapshotMessages;
  },
  set chatSnapshotMessages(value: typeof chatSnapshotMessages) {
    chatSnapshotMessages = value;
  },
  get citationRecords() {
    return citationRecords;
  },
  set citationRecords(value: TestCitation[]) {
    citationRecords = value;
  },
  get scopedTurnConfigurationForTest() {
    return scopedTurnConfigurationForTest;
  },
  set scopedTurnConfigurationForTest(value: ScopedTurnConfiguration | null) {
    scopedTurnConfigurationForTest = value;
  },
  get gitBranchesByRepo() {
    return gitBranchesByRepo;
  },
  set gitBranchesByRepo(value: typeof gitBranchesByRepo) {
    gitBranchesByRepo = value;
  },
  get streamingWebSearchConfig() {
    return streamingWebSearchConfig;
  },
  set streamingWebSearchConfig(value: typeof streamingWebSearchConfig) {
    streamingWebSearchConfig = value;
  },
};

export type UseChatStoreScenarioContext = typeof useChatStoreScenarioContext;

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
    const defaultProject = projectGroups[0]?.projects[0];
    projectGroups[0]?.projects.splice(1);
    if (defaultProject) {
      defaultProject.directEdit = false;
      defaultProject.gitSetupState = 'ready';
    }
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
    providerState.selectedSupportsNativeToolCalling = () => true;
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
    citationPersistenceError = null;
    ensureCitationContentLoadedMock.mockClear();
    ensureCitationContentLoadedMock.mockImplementation(async (id: string) =>
      citationRecords.find((citation) => citation.id === id) ?? null
    );
    tauriAvailable = false;
    scopedTurnConfigurationForTest = null;
    dbConversationCounter = 0;
    dbMessageCounter = 0;
    chatSnapshotConversations = [];
    chatSnapshotMessages = [];
    appSettingValues.clear();
    dbGetAppSettingMock.mockClear();
    dbSetAppSettingMock.mockClear();
    dbDeleteAppSettingMock.mockClear();
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
    fsReadFileWithOptionsMock.mockImplementation(async () => ({
      content: 'Workspace file body from disk.',
      language: 'typescript',
      is_binary: false,
      size: 30,
      encoding: 'utf-8',
    }));
    fsExistsMock.mockClear();
    fsExistsMock.mockImplementation(async () => true);
    fsWriteFileMock.mockClear();
    fsWriteFileMock.mockImplementation(async (params) => ({
      path: params.path,
      bytes_written: new TextEncoder().encode(params.content).length,
      created: false,
      revision: 'written-revision',
    }));
    fsDeleteMock.mockClear();
    fsDeleteMock.mockImplementation(async () => undefined);
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
    dbTrimConversationReplayMock.mockClear();
    dbTrimConversationReplayMock.mockImplementation(async () => undefined);
    dbPrepareConversationReplayMock.mockClear();
    dbPrepareConversationReplayMock.mockImplementation(async () => undefined);
    dbRestoreConversationReplayMock.mockClear();
    dbRestoreConversationReplayMock.mockImplementation(async () => true);
    dbCompleteConversationReplayMock.mockClear();
    dbCompleteConversationReplayMock.mockImplementation(async () => undefined);
    dbMarkConversationReplayLaunchedMock.mockClear();
    dbMarkConversationReplayLaunchedMock.mockImplementation(async () => undefined);
    dbFinalizeConversationReplayMock.mockClear();
    dbFinalizeConversationReplayMock.mockImplementation(async () => undefined);
    importMessagesMock.mockClear();
    terminalSessionsFromChat.clear();
    terminalCreateSessionFromChatMock.mockClear();
    terminalRunCommandFromChatMock.mockClear();
    terminalReadSessionFromChatMock.mockClear();
    terminalKillSessionFromChatMock.mockClear();
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
      'terminal_create_session',
      'terminal_run',
      'terminal_read',
      'terminal_kill',
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

  it('kills an active terminal_run when its conversation generation is stopped', async () => {
    const { useChatStore, onToolCall } = await startImplementToolConversation(
      'Lance les tests dans le terminal.',
    );
    terminalSessionsFromChat.set(
      'session-1',
      createTerminalSessionFromChatDto({
        sessionId: 'session-1',
        projectId: null,
      }),
    );
    const commandFinished = createDeferred<{
      id: string;
      command: string;
      timeout_ms: number | null;
      status: string;
      output: string;
      exit_code: null;
      timed_out: boolean;
      updated_at: string;
    }>();
    terminalRunCommandFromChatMock.mockImplementationOnce(
      async () => commandFinished.promise,
    );
    terminalKillSessionFromChatMock.mockImplementationOnce(async () => {
      const commandResult = {
        id: 'session-1',
        command: 'bun test',
        timeout_ms: null,
        status: 'killed',
        output: '',
        exit_code: null,
        timed_out: false,
        updated_at: '2026-03-26T10:00:00.000Z',
      };
      commandFinished.resolve(commandResult);
      return {
        ...terminalSessionsFromChat.get('session-1')!,
        status: 'killed',
      };
    });

    const toolCall = onToolCall(
      'terminal_run',
      { session_id: 'session-1', command: 'bun test' },
      'terminal-run-cancelled',
    );
    await flushAsyncWork();
    useChatStore
      .getState()
      .approvePendingToolApprovalForConversation('implement-conv');
    await flushAsyncWork();

    useChatStore.getState().stopConversationStream('implement-conv');
    await toolCall;

    expect(terminalKillSessionFromChatMock).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
    );
    expect(terminalRunCommandFromChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: expect.any(String) }),
    );
  });

  it('spills oversized tool output to a recoverable conversation artifact', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Inspecte une très grosse sortie.',
    );
    const fullOutput = `BEGIN-${'x'.repeat(60_000)}-END`;
    executeWorkspaceToolMock.mockImplementationOnce(
      (async () => fullOutput) as unknown as () => Promise<undefined>,
    );

    const preview = String(
      await onToolCall('grep', { query: 'needle' }, 'large-output-call'),
    );
    const artifactPath = preview.match(/^Full output: (tool-output:\/\/\S+)$/m)?.[1];
    const artifact = citationRecords.find(
      (citation) => citation.path === artifactPath,
    );

    expect(artifactPath).toBeTruthy();
    expect(artifact?.content).toBe(fullOutput);
    expect(artifact?.sizeBytes).toBe(new TextEncoder().encode(fullOutput).byteLength);
    expect(new TextEncoder().encode(preview).byteLength).toBeLessThan(50 * 1024);

    const firstPage = String(
      await onToolCall(
        'read_file',
        { file: artifactPath, raw: true, max_bytes: 10_000 },
        'read-large-output-1',
      ),
    );
    const cursor = firstPage.match(/^NEXT_CURSOR: (.+)$/m)?.[1];
    const firstContent = firstPage.match(
      /---BEGIN RAW CONTENT---\n([\s\S]*)\n---END RAW CONTENT---/,
    )?.[1];
    let recovered = firstContent ?? '';
    let nextCursor = cursor;
    let pageIndex = 2;
    while (nextCursor) {
      const page = String(
        await onToolCall(
          'read_file',
          {
            file: artifactPath,
            raw: true,
            max_bytes: 256_000,
            cursor: nextCursor,
          },
          `read-large-output-${pageIndex}`,
        ),
      );
      recovered += page.match(
        /---BEGIN RAW CONTENT---\n([\s\S]*)\n---END RAW CONTENT---/,
      )?.[1] ?? '';
      nextCursor = page.match(/^NEXT_CURSOR: (.+)$/m)?.[1];
      if (nextCursor === 'none') nextCursor = undefined;
      pageIndex += 1;
    }
    expect(recovered).toBe(fullOutput);
    expect(pageIndex).toBeGreaterThan(3);
  });

  it('does not publish a tool-output URI when durable artifact persistence fails', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Inspecte une sortie dont la persistance échoue.',
    );
    const fullOutput = `BEGIN-${'x'.repeat(60_000)}-END`;
    executeWorkspaceToolMock.mockImplementationOnce(
      (async () => fullOutput) as unknown as () => Promise<undefined>,
    );
    citationPersistenceError = new Error('injected citation persistence failure');

    const preview = String(
      await onToolCall('grep', { query: 'needle' }, 'failed-large-output'),
    );

    expect(preview).toContain('Full output unavailable');
    expect(preview).not.toContain('tool-output://');
    expect(citationRecords).toEqual([]);
    expect(new TextEncoder().encode(preview).byteLength).toBeLessThan(50 * 1024);
  });

  it('allocates distinct artifacts for oversized tool results without call ids', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Inspecte deux grosses sorties internes.',
    );
    const oversizedOutput = async () => `BEGIN-${'x'.repeat(60_000)}-END`;
    executeWorkspaceToolMock
      .mockImplementationOnce(oversizedOutput as unknown as () => Promise<undefined>)
      .mockImplementationOnce(oversizedOutput as unknown as () => Promise<undefined>);

    await onToolCall('grep', { query: 'first' }, undefined);
    await onToolCall('grep', { query: 'second' }, undefined);

    const paths = citationRecords
      .map((citation) => citation.path)
      .filter((path): path is string => path?.startsWith('tool-output://') ?? false);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
  });

  it('allocates a fresh artifact when the same tool call id is retried', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Réessaie une grosse sortie avec le même identifiant.',
    );
    const firstOutput = `FIRST-${'a'.repeat(60_000)}-END`;
    const secondOutput = `SECOND-${'b'.repeat(60_000)}-END`;
    executeWorkspaceToolMock
      .mockImplementationOnce((async () => firstOutput) as unknown as () => Promise<undefined>)
      .mockImplementationOnce((async () => secondOutput) as unknown as () => Promise<undefined>);

    const firstPreview = String(
      await onToolCall('grep', { query: 'first' }, 'retried-tool-call'),
    );
    const secondPreview = String(
      await onToolCall('grep', { query: 'second' }, 'retried-tool-call'),
    );
    const firstPath = firstPreview.match(/^Full output: (tool-output:\/\/\S+)$/m)?.[1];
    const secondPath = secondPreview.match(/^Full output: (tool-output:\/\/\S+)$/m)?.[1];

    expect(firstPath).toBeTruthy();
    expect(secondPath).toBeTruthy();
    expect(secondPath).not.toBe(firstPath);
    expect(citationRecords.find((citation) => citation.path === firstPath)?.content).toBe(
      firstOutput,
    );
    expect(citationRecords.find((citation) => citation.path === secondPath)?.content).toBe(
      secondOutput,
    );
    const recoveredSecond = String(
      await onToolCall(
        'read_file',
        { file: secondPath, raw: true, max_bytes: 256_000 },
        'read-retried-tool-call',
      ),
    );
    expect(recoveredSecond).toContain('SECOND-');
    expect(recoveredSecond).not.toContain('FIRST-');
  });

  it('persists oversized tool execution errors behind a recoverable bounded artifact', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Inspecte une très grosse erreur.',
    );
    const fullErrorText = `BEGIN-${'y'.repeat(60_000)}-END`;
    const oversizedError = new Error(fullErrorText);
    executeWorkspaceToolMock.mockImplementationOnce(
      (async () => {
        throw oversizedError;
      }) as unknown as () => Promise<undefined>,
    );

    let caught: unknown;
    try {
      await onToolCall('grep', { query: 'needle' }, 'large-error-call');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(oversizedError);
    const boundedMessage = caught instanceof Error ? caught.message : '';
    expect(boundedMessage.startsWith('Error executing tool')).toBe(false);
    expect(boundedMessage).toContain('BEGIN-');
    expect(boundedMessage.trim().endsWith('-END')).toBe(true);
    expect(new TextEncoder().encode(boundedMessage).byteLength).toBeLessThan(
      50 * 1024,
    );

    const artifactPath = boundedMessage.match(
      /^Full output: (tool-output:\/\/\S+)$/m,
    )?.[1];
    expect(artifactPath).toBeTruthy();
    const artifact = citationRecords.find(
      (citation) => citation.path === artifactPath,
    );
    expect(artifact?.content).toBe(fullErrorText);
    expect(artifact?.sizeBytes).toBe(
      new TextEncoder().encode(fullErrorText).byteLength,
    );

    let recovered = '';
    let nextCursor: string | undefined;
    let pageIndex = 1;
    while (pageIndex === 1 || nextCursor) {
      const page = String(
        await onToolCall(
          'read_file',
          {
            file: artifactPath,
            raw: true,
            max_bytes: pageIndex === 1 ? 10_000 : 256_000,
            cursor: pageIndex === 1 ? undefined : nextCursor,
          },
          `read-large-error-${pageIndex}`,
        ),
      );
      recovered += page.match(
        /---BEGIN RAW CONTENT---\n([\s\S]*)\n---END RAW CONTENT---/,
      )?.[1] ?? '';
      nextCursor = page.match(/^NEXT_CURSOR: (.+)$/m)?.[1];
      if (nextCursor === 'none') nextCursor = undefined;
      pageIndex += 1;
    }
    expect(recovered).toBe(fullErrorText);
  });

  it('does not announce an artifact URI when persisting an oversized tool error fails', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Inspecte une grosse erreur dont la persistance échoue.',
    );
    const fullErrorText = `BEGIN-${'y'.repeat(60_000)}-END`;
    executeWorkspaceToolMock.mockImplementationOnce(
      (async () => {
        throw new Error(fullErrorText);
      }) as unknown as () => Promise<undefined>,
    );
    citationPersistenceError = new Error('injected citation persistence failure');

    let caught: unknown;
    try {
      await onToolCall('grep', { query: 'needle' }, 'failed-large-error');
    } catch (error) {
      caught = error;
    }
    const boundedMessage = caught instanceof Error ? caught.message : '';
    expect(boundedMessage).toContain('Full output unavailable');
    expect(boundedMessage).not.toContain('tool-output://');
    expect(citationRecords).toEqual([]);
    expect(new TextEncoder().encode(boundedMessage).byteLength).toBeLessThan(
      50 * 1024,
    );
  });

  it('leaves small tool execution errors untouched', async () => {
    const { onToolCall } = await startImplementToolConversation(
      'Inspecte une petite erreur.',
    );
    const smallError = new Error('tiny tool failure');
    executeWorkspaceToolMock.mockImplementationOnce(
      (async () => {
        throw smallError;
      }) as unknown as () => Promise<undefined>,
    );

    let caught: unknown;
    try {
      await onToolCall('grep', { query: 'needle' }, 'small-error-call');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(smallError);
    expect(
      citationRecords.some((citation) =>
        citation.path?.startsWith('tool-output://') ?? false,
      ),
    ).toBe(false);
  });

  const createScopedMcpTurnConfiguration = (): ScopedTurnConfiguration => ({
    projectIds: ['project-1'],
    focusProjectId: 'project-1',
    riskLevel: 'balanced',
    maxTurns: 6,
    models: {},
    builtInTools: {},
    modeTools: {},
    allowedMcpServerIds: ['project_docs'],
    mcpServers: {
      project_docs: {
        enabled: true,
        name: 'Project docs',
        transport: { type: 'stdio', command: 'project-docs' },
      },
    },
  });

  it('injects project-scoped MCP tools absent from the global catalog and drops global selections', async () => {
    const { services } = await import('../services');
    const originalConnect = services.mcpRuntimeConnect;
    const originalRefreshCatalog = services.mcpRuntimeRefreshCatalog;
    services.mcpRuntimeConnect = mock(async (selector) => ({
      key: {
        serverId: selector.serverId,
        projectId: null,
        projectIds: selector.projectIds,
        configGeneration: 1,
      },
      status: 'ready' as const,
      updatedAt: '2026-08-24T00:00:00Z',
    }));
    services.mcpRuntimeRefreshCatalog = mock(async (key) => ({
      key,
      tools: [{
        id: 'mcp__project_docs__search',
        serverId: 'project_docs',
        name: 'search',
        enabled: true,
      }],
    }));
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
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const scopedToolsStoreState = toolsStoreState as typeof toolsStoreState & {
      mcpServers?: MCPServer[];
    };
    scopedToolsStoreState.mcpServers = [];
    scopedTurnConfigurationForTest = createScopedMcpTurnConfiguration();

    try {
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
        content: 'Cherche dans la documentation du projet.',
      });

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        mcpTools?: Array<{ id: string }>;
      }>();
      expect(streamOptions.allowedToolIds).toContain('mcp__project_docs__search');
      expect(streamOptions.allowedToolIds).not.toContain(
        'mcp__github__list_issues',
      );
      expect(streamOptions.mcpTools?.map((tool) => tool.id)).toEqual([
        'mcp__project_docs__search',
      ]);
    } finally {
      services.mcpRuntimeConnect = originalConnect;
      services.mcpRuntimeRefreshCatalog = originalRefreshCatalog;
      delete scopedToolsStoreState.mcpServers;
    }
  });

  registerConversationSelectionScenarios(useChatStoreScenarioContext);
  registerArchitectLifecycleScenarios(useChatStoreScenarioContext);
  registerArchitectStrategyScenarios(useChatStoreScenarioContext);
  registerChatToolsAndSourcesScenarios(useChatStoreScenarioContext);
  registerImplementSelectionScenarios(useChatStoreScenarioContext);
  registerCompactionAndDiagnosticsScenarios(useChatStoreScenarioContext);
  registerQuestionnaireFlowScenarios(useChatStoreScenarioContext);
  registerQuestionnaireNavigationScenarios({
    createConversation,
    loadChatStore,
    setChatMode: () => {
      appState.mode = 'Chat';
    },
  });
  registerReplayAndEditingScenarios(useChatStoreScenarioContext);
  registerImplementPolicyScenarios(useChatStoreScenarioContext);
  registerSendRuntimeAndDeletionScenarios(useChatStoreScenarioContext);
});

registerComposerDraftQueueScenarios({ loadChatStore });
