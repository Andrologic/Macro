import { beforeEach, describe, expect, it, mock } from 'bun:test';
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
  switchProjectContext: async (_projectId: string) => undefined,
};

const providerState = {
  providerConfigs: [
    {
      id: 'provider-1',
      name: 'Local',
      providerType: 'openai',
      isEnabled: true,
      isLocal: true,
      apiKey: '',
    },
  ],
  modelsByProvider: {
    'provider-1': [{ id: 'model-1', name: 'Model 1', isEnabled: true }],
  } as Record<string, Array<{ id: string; name: string; isEnabled: boolean }>>,
  selectedProviderId: 'provider-1' as string | null,
  selectedModelId: 'model-1' as string | null,
  loadProviderModels: mock(async (providerId: string) => providerState.modelsByProvider[providerId] ?? []),
  scanModelsForProvider: mock(async (providerId: string) => providerState.modelsByProvider[providerId] ?? []),
  selectedSupportsNativeToolCalling: () => false,
  selectModel: mock((modelId: string) => {
    providerState.selectedModelId = modelId;
  }),
  selectProvider: mock((providerId: string) => {
    providerState.selectedProviderId = providerId;
  }),
};

const useProviderStoreMock = {
  getState: () => providerState,
  setState: (patch: Partial<typeof providerState>) => {
    Object.assign(providerState, patch);
  },
  subscribe: () => () => undefined,
};

const architectPlans = new Map<string, ArchitectPlanRecord>();
const architectPlanMessages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }>>();
let tauriAvailable = false;
let chatSnapshotConversations: Array<{
  id: string;
  title: string;
  description: string | null;
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

const getLocalProjectContextStateMock = mock(async (_groupId: string) => ({
  architectConversationId: 'project-architect-conversation',
  implementConversationId: null,
}));
const syncArchitectPlanChatFromConversationMock = mock(async () => undefined);
const getChatSnapshotMock = mock(async () => ({
  conversations: chatSnapshotConversations,
  messages: chatSnapshotMessages,
}));
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

mock.module('./useProviderStore', () => ({
  useProviderStore: useProviderStoreMock,
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
    getState: () => ({
      selectedTools: [],
      setSelectedTools: () => undefined,
    }),
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
    getState: () => ({
      currentTask: null,
      refreshFromPlan: async () => undefined,
      clearPlanRuntimeState: () => undefined,
    }),
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
  streamChat: mock(async () => ({ usage: null })),
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

mock.module('../services/toolModePolicy', () => ({
  getToolModePolicy: () => 'none',
}));

mock.module('../services/workspaceToolExecutor', () => ({
  executeWorkspaceTool: mock(async () => undefined),
}));

mock.module('../services/preferences', () => ({
  PREF_KEYS: {
    AI_CONTEXT_SELECTIONS: 'ai-context-selections',
  },
  loadPreference: mock(async () => null),
  savePreference: mock(async () => undefined),
}));

mock.module('../services/remoteKernelApi', () => ({
  canUseRemoteKernel: () => false,
  getRemoteToolModePolicy: () => 'none',
}));

mock.module('../services/tauriIpc', () => ({
  isTauriAvailable: () => tauriAvailable,
  createMessage: mock(async () => {
    throw new Error('unavailable');
  }),
  deleteConversation: deleteConversationMock,
  deleteConversations: deleteConversationsMock,
  getChatSnapshot: getChatSnapshotMock,
  importMessages: importMessagesMock,
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

mock.module('../services/architectPlanPresentation', () => ({
  getArchitectPlanConversationTitle: (plan: ArchitectPlanRecord) => plan.label ?? plan.title,
  getArchitectPlanDisplayName: (plan: ArchitectPlanRecord) => plan.label ?? plan.title,
  isDefaultNewPlanFamilyLabel: (value?: string | null) => /^new plan(?:\s+\d+)?$/i.test(value ?? ''),
  isCanonicalArchitectPlan: () => true,
}));

mock.module('../services/architectToolNames', () => ({
  normalizeArchitectToolId: (toolId: string) => toolId,
}));

mock.module('../services/implementTaskDerivation', () => ({
  normalizeStrategyDependencies: (deps: string[]) => deps,
}));

mock.module('../services/localProjectContext', () => ({
  getLocalProjectContextState: getLocalProjectContextStateMock,
}));

mock.module('../services/globalProjects', () => ({
  getFocusedProjectForGroup: (groups: ProjectGroup[], groupId: string | null, selectedProjectId?: string | null) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return null;
    return group.projects.find((project) => project.id === selectedProjectId) ?? group.projects[0] ?? null;
  },
  getGlobalProjectById: (groups: ProjectGroup[], groupId: string | null) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return null;
    return {
      id: group.id,
      name: group.name,
      primarySubProjectId: group.projects[0]?.id ?? null,
    };
  },
  getProjectGroupByProjectId: (groups: ProjectGroup[], projectId: string | null) =>
    groups.find((group) => group.projects.some((project) => project.id === projectId)) ?? null,
  getScopedProjectIds: (_groups: ProjectGroup[], _groupId: string | null, selectedProjectId: string | null) =>
    selectedProjectId ? [selectedProjectId] : [],
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

mock.module('../services/chatQuickReplies', () => ({
  parseMessageQuickReplies: () => [],
}));

let importCounter = 0;

const loadChatStore = async () => {
  importCounter += 1;
  return import(`./useChatStore.ts?test=${importCounter}`);
};

const createConversation = (id: string, projectId = 'project-1'): Conversation => ({
  id,
  title: `Conversation ${id}`,
  description: '',
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

describe('useChatStore ensureArchitectConversationForPlan', () => {
  let localStorageMock: LocalStorageMock;

  beforeEach(() => {
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
    appState.selectedGroupId = 'group-1';
    appState.selectedProjectId = 'project-1';
    appState.selectedTaskId = null;
    appState.activeArchitectPlanId = null;
    appState.activePlanContext = null;

    providerState.selectedProviderId = 'provider-1';
    providerState.selectedModelId = 'model-1';
    providerState.loadProviderModels.mockClear();
    providerState.scanModelsForProvider.mockClear();
    providerState.selectModel.mockClear();
    providerState.selectProvider.mockClear();

    architectPlans.clear();
    architectPlanMessages.clear();
    tauriAvailable = false;
    chatSnapshotConversations = [];
    chatSnapshotMessages = [];
    getArchitectPlanChatMessagesMock.mockClear();
    getArchitectPlanMock.mockClear();
    listArchitectPlansMock.mockClear();
    updateArchitectPlanMock.mockClear();
    sendChatNonStreamingMock.mockClear();
    getLocalProjectContextStateMock.mockClear();
    syncArchitectPlanChatFromConversationMock.mockClear();
    getChatSnapshotMock.mockClear();
    deleteConversationMock.mockClear();
    deleteConversationsMock.mockClear();
    importMessagesMock.mockClear();
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
    expect(useChatStore.getState().conversations[0]?.title).toBe('Checkout refresh');
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
});
