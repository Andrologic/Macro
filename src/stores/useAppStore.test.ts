import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  computePlanSelectorRefreshState,
  getPlanSelectorNullLoadDisposition,
} from '../components/architect/planSelectorState';
import type {
  ArchitectPlanReplica,
  ArchitectPlanSummary,
  ArchitectPlanStatus,
} from '../services/architectPlanService';
import type { PlanNode } from '../types';

type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  isReadOnly?: boolean;
  gitFlowSettings?: { baseBranch: string };
};

type ProjectGroupRecord = {
  id: string;
  name: string;
  isOpen: boolean;
  projects: ProjectRecord[];
};

type PlanRecord = {
  id: string;
  slug: string;
  title: string;
  label?: string;
  description: string;
  status: ArchitectPlanStatus;
  conversationId?: string | null;
  projectId?: string;
  projectIds?: string[];
  expectedProjectIds?: string[];
  contextProjectIds?: string[];
  availableProjectIds?: string[];
  replicas?: ArchitectPlanReplica[];
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string>;
  nodes: unknown[];
  predictedBranches: unknown[];
  createdAt: string;
  updatedAt: string;
};

type ActivationPayloadRecord = {
  plan: PlanRecord;
  chatMessages: unknown[];
  conversationId: string | null;
  sharedConversation: boolean;
  targetBranch: string;
  resolutionMode: string;
};

type ActivationPayloadOverride = Partial<
  Pick<
    ActivationPayloadRecord,
    'chatMessages' | 'conversationId' | 'sharedConversation' | 'resolutionMode'
  >
>;

type ProjectContextRecord = {
  projectId: string;
  groupId: string | null;
  focusProjectId: string | null;
  lastPlanId: string | null;
  lastTaskId: string | null;
  architectConversationId: string | null;
  implementConversationId: string | null;
  updatedAt: string;
};

type RegistryReconcileReportRecord = {
  status: string;
  discoveredProjects: ProjectRecord[];
  addedProjects: ProjectRecord[];
  skippedProjects: Array<{
    projectId?: string | null;
    path: string;
    reason: string;
  }>;
  duplicatePaths: string[];
  invalidPaths: string[];
};

const DEFAULT_UI_PREFS = {
  leftPanelWidth: 280,
  architectLeftPanelWidth: 320,
  rightPanelWidth: 320,
  isLeftPanelOpen: true,
  isRightPanelOpen: true,
  uiZoomMode: 'auto',
  uiZoomLevel: 1,
  codeOverflowMode: 'wrap',
  lastSelectedGroupId: 'group-1',
  lastSelectedProjectId: null,
  lastOpenProjectPath: null,
  lastActiveMode: 'Implement',
  agentType: 'build',
  recentProjects: [],
  macroEnabledProjects: [],
  metadataAutoPush: false,
  metadataMissingUpstreamPolicy: 'ask',
  notificationChannelModes: {},
} as const;

const buildProjectGroup = (
  overrides: Partial<ProjectGroupRecord> = {}
): ProjectGroupRecord => ({
  id: overrides.id ?? 'group-1',
  name: overrides.name ?? 'Macro',
  isOpen: overrides.isOpen ?? true,
  projects:
    overrides.projects ??
    [
      {
        id: 'project-1',
        name: 'Web',
        path: '/repos/web',
        gitFlowSettings: { baseBranch: 'develop' },
      },
      {
        id: 'project-2',
        name: 'API',
        path: '/repos/api',
        gitFlowSettings: { baseBranch: 'develop' },
      },
    ],
});

const buildPlan = (overrides: Partial<PlanRecord> = {}): PlanRecord => ({
  id: overrides.id ?? 'plan-1',
  slug: overrides.slug ?? overrides.id ?? 'plan-1',
  title: overrides.title ?? overrides.id ?? 'plan-1',
  label: overrides.label ?? overrides.id ?? 'plan-1',
  description: overrides.description ?? '',
  status: overrides.status ?? 'draft',
  conversationId: overrides.conversationId,
  projectId: overrides.projectId ?? 'project-1',
  projectIds: overrides.projectIds ?? [overrides.projectId ?? 'project-1'],
  expectedProjectIds:
    overrides.expectedProjectIds ??
    overrides.projectIds ??
    [overrides.projectId ?? 'project-1'],
  contextProjectIds: overrides.contextProjectIds ?? [],
  availableProjectIds: overrides.availableProjectIds,
  replicas: overrides.replicas,
  targetBranch: overrides.targetBranch ?? 'develop',
  targetBranchesByProjectId:
    overrides.targetBranchesByProjectId ??
    Object.fromEntries(
      (overrides.projectIds ?? [overrides.projectId ?? 'project-1']).map(
        (projectId) => [projectId, 'develop']
      )
    ),
  nodes: overrides.nodes ?? [],
  predictedBranches: overrides.predictedBranches ?? [],
  createdAt: overrides.createdAt ?? '2026-04-17T09:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-04-17T10:00:00.000Z',
});

const collectPlanProjectIds = (
  plan: Pick<PlanRecord, 'projectId' | 'projectIds' | 'expectedProjectIds'> &
    Partial<Pick<PlanRecord, 'availableProjectIds' | 'replicas'>>
): string[] =>
  Array.from(
    new Set(
      [
        plan.projectId,
        ...(plan.projectIds ?? []),
        ...(plan.expectedProjectIds ?? []),
        ...(plan.availableProjectIds ?? []),
        ...(plan.replicas ?? []).map((replica) => replica.projectId),
      ].filter(Boolean)
    )
  ) as string[];

const resolvePlanTargetBranchesByProjectId = (
  plan: Pick<
    PlanRecord,
    'projectId' | 'projectIds' | 'expectedProjectIds' | 'targetBranch'
  > & {
    targetBranchesByProjectId?: Record<string, string>;
  }
): Record<string, string> =>
  Object.fromEntries(
    collectPlanProjectIds(plan).map((projectId) => [
      projectId,
      plan.targetBranchesByProjectId?.[projectId] ?? plan.targetBranch,
    ])
  );

const isPlanVisibleForScopedProjectIds = (
  plan: Pick<PlanRecord, 'projectId' | 'projectIds' | 'expectedProjectIds'>,
  scopedProjectIds: string[]
): boolean =>
  scopedProjectIds.length === 0 ||
  collectPlanProjectIds(plan).some((projectId) =>
    scopedProjectIds.includes(projectId)
  );

const taskMatchesMockProjectId = (
  task: { project_id?: string | null; project_ids?: string[] },
  projectId?: string | null
): boolean =>
  !projectId ||
  task.project_id === projectId ||
  Boolean(task.project_ids?.includes(projectId));

const toPlanSummary = (plan: PlanRecord) => ({
  id: plan.id,
  slug: plan.slug,
  title: plan.title,
  label: plan.label,
  description: plan.description,
  status: plan.status,
  projectId: plan.projectId,
  projectIds: plan.projectIds,
  expectedProjectIds: plan.expectedProjectIds,
  availableProjectIds: plan.availableProjectIds,
  replicas: plan.replicas,
  targetBranch: plan.targetBranch,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
  nodeCount: plan.nodes.length,
});

const buildProjectContext = (
  overrides: Partial<ProjectContextRecord> = {}
): ProjectContextRecord => ({
  projectId: overrides.projectId ?? 'group-1',
  groupId: overrides.groupId ?? 'group-1',
  focusProjectId: overrides.focusProjectId ?? null,
  lastPlanId: overrides.lastPlanId ?? null,
  lastTaskId: overrides.lastTaskId ?? null,
  architectConversationId: overrides.architectConversationId ?? null,
  implementConversationId: overrides.implementConversationId ?? null,
  updatedAt: overrides.updatedAt ?? '2026-04-17T10:00:00.000Z',
});

const chatStoreState = {
  conversations: [] as Array<{
    id: string;
    scope_mode?: string;
    group_id?: string | null;
    project_id?: string | null;
    task_id?: string | null;
    updated_at?: string;
  }>,
  selectedConversationId: null as string | null,
  beginArchitectPlanSwitch: mock(() => undefined),
  reconcileProjectRegistry: mock(() => undefined),
};

const taskStoreState = {
  tasks: [] as Array<{
    id: string;
    status: string;
    project_id?: string | null;
    project_ids?: string[];
  }>,
  getTaskById: (_taskId: string) => undefined,
  activateTask: mock(async () => undefined),
  refreshFromPlan: mock(async () => undefined),
};

const useChatStoreMock = Object.assign(
  <TSelected = typeof chatStoreState>(
    selector?: (state: typeof chatStoreState) => TSelected
  ) =>
    selector
      ? selector(chatStoreState)
      : (chatStoreState as unknown as TSelected),
  {
    getState: () => chatStoreState,
    subscribe: () => () => undefined,
  }
);

const useTaskStoreMock = Object.assign(
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
);

let importCounter = 0;
let preferenceValues: Record<string, unknown> = {};
let projectSwitchPolicy: 'resume_per_project' | 'reset_on_switch' =
  'resume_per_project';
const setProjectSwitchPolicyMock = mock(
  async (_policy?: 'resume_per_project' | 'reset_on_switch') => undefined,
);
let sessionContext: {
  globalProjectId: string | null;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  mode: string | null;
  updatedAt: string;
} | null = null;
let bootstrapProjectGroups: ProjectGroupRecord[] = [];
let bootstrapStandaloneProjects: ProjectRecord[] = [];
let bootstrapPlan: unknown = null;
let bootstrapPlanNodes: unknown[] = [];
let bootstrapPredictedBranches: unknown[] = [];
let tauriAvailable = false;
let ensureProjectGroupPlanResult: { action: string; plan: PlanRecord } | null =
  null;

const projectContexts = new Map<string, ProjectContextRecord>();
const planById = new Map<string, PlanRecord>();
const activationPayloadByPlanId = new Map<string, ActivationPayloadOverride>();

const listArchitectPlansMock = mock(async () => ({
  activePlanId: null,
  plans: Array.from(planById.values()).map(toPlanSummary),
}));
const getArchitectPlanMock = mock(async (_branchName: string, planId: string) =>
  planById.get(planId) ?? null
);
const getArchitectPlanActivationPayloadMock = mock(
  async (branchName: string, planId: string) => {
    const plan = planById.get(planId);
    if (!plan || plan.status === 'deleted') {
      return null;
    }

    const override = activationPayloadByPlanId.get(planId);
    return {
      plan,
      chatMessages: override?.chatMessages ?? [],
      conversationId: override?.conversationId ?? plan.conversationId ?? null,
      sharedConversation: override?.sharedConversation ?? false,
      targetBranch: branchName,
      resolutionMode: override?.resolutionMode ?? 'blank_fast_path',
    };
  }
);
const persistActiveArchitectPlanMock = mock(
  async (_targetBranch: string, _planId: string) => undefined
);
const getAppBootstrapMock = mock(async () => ({
  plan: bootstrapPlan,
  standaloneProjects: bootstrapStandaloneProjects,
  projectGroups: bootstrapProjectGroups,
  planNodes: bootstrapPlanNodes,
  predictedBranches: bootstrapPredictedBranches,
}));
const debugResetProjectMock = mock(async (data: { projectId: string }) => {
  bootstrapProjectGroups = bootstrapProjectGroups
    .map((group) => ({
      ...group,
      projects: group.projects.filter((project) => project.id !== data.projectId),
    }))
    .filter((group) => group.projects.length > 0);
  return {
    projectId: data.projectId,
    projectName: data.projectId,
    removedRegistryEntry: true,
    removedTaskWorktrees: 1,
    removedMetadataWorktree: false,
    removedMacroBranch: false,
    warnings: [],
  };
});
const workspaceRecoverMissingMetadataMock = mock(async () => ({
  status: 'none',
  restoredCommit: null,
  message: null,
}));
const buildUnchangedRegistryReconcileReport =
  (): RegistryReconcileReportRecord => ({
    status: 'unchanged',
    discoveredProjects: [],
    addedProjects: [],
    skippedProjects: [],
    duplicatePaths: [],
    invalidPaths: [],
  });
const workspaceReconcileProjectRegistryFromHintsMock = mock(
  async (): Promise<RegistryReconcileReportRecord> =>
    buildUnchangedRegistryReconcileReport()
);
const ensureProjectGroupPlanMock = mock(async () => {
  if (ensureProjectGroupPlanResult?.plan) {
    planById.set(
      ensureProjectGroupPlanResult.plan.id,
      ensureProjectGroupPlanResult.plan
    );
  }
  return ensureProjectGroupPlanResult;
});
const consolidateScopedBlankPlansMock = mock(async () => ({
  deletedPlanIds: [],
}));
const upsertLocalProjectContextStateMock = mock(
  async (input: {
    projectId: string;
    groupId?: string | null;
    focusProjectId?: string | null;
    lastPlanId?: string | null;
    lastTaskId?: string | null;
    architectConversationId?: string | null;
    implementConversationId?: string | null;
  }) => {
    const next = buildProjectContext({
      projectId: input.projectId,
      groupId: input.groupId ?? null,
      focusProjectId: input.focusProjectId ?? null,
      lastPlanId: input.lastPlanId ?? null,
      lastTaskId: input.lastTaskId ?? null,
      architectConversationId: input.architectConversationId ?? null,
      implementConversationId: input.implementConversationId ?? null,
      updatedAt: '2026-04-17T12:00:00.000Z',
    });
    projectContexts.set(input.projectId, next);
    return next;
  }
);
const getLocalProjectContextStateMock = mock(async (projectId: string) =>
  projectContexts.get(projectId) ?? null
);
const deleteLocalProjectContextStateMock = mock(async (projectId: string) => {
  projectContexts.delete(projectId);
});
const upsertLocalSessionContextStateMock = mock(async (input: {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  mode: string;
}) => {
  sessionContext = {
    globalProjectId: input.selectedGroupId,
    selectedGroupId: input.selectedGroupId,
    selectedProjectId: input.selectedProjectId,
    mode: input.mode,
    updatedAt: '2026-04-17T12:00:00.000Z',
  };
  return sessionContext;
});

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const registerMockModulePair = (
  basePath: string,
  factory: Parameters<typeof mock.module>[1]
) => {
  mock.module(basePath, factory);
  mock.module(`${basePath}.ts`, factory);
};

const registerUseAppStoreMocks = async () => {
  mock.restore();

  const actualPreferences = await import(
    `../services/preferences.ts?use-app-store-preferences-test=${++importCounter}`
  );
  const actualImplementTaskCatalog = await import(
    `../services/implementTaskCatalog.ts?use-app-store-implement-task-catalog-test=${importCounter}`
  );
  const actualTauriIpc = await import(
    `../services/tauriIpc.ts?use-app-store-tauri-ipc-test=${importCounter}`
  );

  registerMockModulePair('./useChatStore', () => ({
    useChatStore: useChatStoreMock,
  }));
  registerMockModulePair('./useTaskStore', () => ({
    useTaskStore: useTaskStoreMock,
  }));

  mock.module('../services', () => ({
    services: {
      getAppBootstrap: getAppBootstrapMock,
      debugResetProject: debugResetProjectMock,
    },
  }));
  mock.module('../services/index.ts', () => ({
    services: {
      getAppBootstrap: getAppBootstrapMock,
      debugResetProject: debugResetProjectMock,
    },
  }));

  registerMockModulePair('../services/preferences', () => ({
    ...actualPreferences,
    loadPreference: async (key: string) =>
      key in preferenceValues
        ? preferenceValues[key]
        : actualPreferences.PREF_DEFAULTS[key as keyof typeof actualPreferences.PREF_DEFAULTS],
    savePreference: async () => undefined,
    savePreferenceDebounced: () => undefined,
    purgeLegacyImplementExecutionModePreference: async () => undefined,
  }));

  registerMockModulePair('../services/localProjectContext', () => ({
    getLocalProjectContextState: getLocalProjectContextStateMock,
    getLocalSessionContextState: async () => sessionContext,
    getProjectSwitchPolicy: async () => projectSwitchPolicy,
    reconcileLocalProjectRegistryState: async () => undefined,
    deleteLocalProjectContextState: deleteLocalProjectContextStateMock,
    setProjectSwitchPolicy: setProjectSwitchPolicyMock,
    upsertLocalProjectContextState: upsertLocalProjectContextStateMock,
    upsertLocalSessionContextState: upsertLocalSessionContextStateMock,
  }));

  registerMockModulePair('../services/architectPlanService', () => ({
    getArchitectPlanActivationPayload: getArchitectPlanActivationPayloadMock,
    getArchitectPlan: getArchitectPlanMock,
    getGitFlowBaseBranch: () => 'develop',
    listArchitectPlanTargetBranches: async () => ['develop'],
    getArchitectPlanProjectIds: collectPlanProjectIds,
    getArchitectPlanVisibleProjectIds: collectPlanProjectIds,
    getArchitectPlanTargetBranchesByProjectId:
      resolvePlanTargetBranchesByProjectId,
    isArchitectPlanVisibleForScope: isPlanVisibleForScopedProjectIds,
    listArchitectPlans: listArchitectPlansMock,
    planMatchesProjectId: (
      plan: Pick<PlanRecord, 'projectId' | 'projectIds' | 'expectedProjectIds'>,
      projectId?: string | null
    ) => {
      if (!projectId) {
        return true;
      }
      return collectPlanProjectIds(plan).includes(projectId);
    },
    resolvePlanProjectContextId: (
      plan: Pick<PlanRecord, 'projectId' | 'projectIds'>,
      fallbackProjectId?: string | null
    ) => plan.projectId ?? plan.projectIds?.[0] ?? fallbackProjectId ?? null,
    resolveTargetBranch: (branchName: string) => branchName.replace(/^refs\/heads\//, ''),
    setActiveArchitectPlan: persistActiveArchitectPlanMock,
  }));

  registerMockModulePair('../services/architectAutoPlan', () => ({
    consolidateScopedBlankPlans: consolidateScopedBlankPlansMock,
    ensureProjectGroupPlan: ensureProjectGroupPlanMock,
  }));

  registerMockModulePair('../services/implementTaskCatalog', () => ({
    ...actualImplementTaskCatalog,
    taskMatchesProjectId: taskMatchesMockProjectId,
  }));

  registerMockModulePair('../services/tauriIpc', () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => tauriAvailable || actualTauriIpc.isTauriAvailable(),
    workspaceArchitectInvalidate: async () => undefined,
    workspaceRecoverMissingMetadata: workspaceRecoverMissingMetadataMock,
    workspaceReconcileProjectRegistryFromHints:
      workspaceReconcileProjectRegistryFromHintsMock,
  }));

  registerMockModulePair('../utils/devLogger', () => ({
    devLogger: {
      info: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    },
  }));
};

const loadIsolatedUseAppStore = async () => {
  importCounter += 1;
  return import(`./useAppStore.ts?architect-plan-resolution-test=${importCounter}`);
};

describe('useAppStore architect plan resolution', () => {
  it('preserves selector state when a null load represents a catalog error or stale scope', () => {
    expect(getPlanSelectorNullLoadDisposition({
      catalogStatus: 'error',
      isCatalogForCurrentScope: true,
    })).toBe('preserve');
    expect(getPlanSelectorNullLoadDisposition({
      catalogStatus: 'ready',
      isCatalogForCurrentScope: false,
    })).toBe('preserve');
    expect(getPlanSelectorNullLoadDisposition({
      catalogStatus: 'ready',
      isCatalogForCurrentScope: true,
    })).toBe('clear');
  });
  beforeEach(async () => {
    preferenceValues = { ...DEFAULT_UI_PREFS };
    projectSwitchPolicy = 'resume_per_project';
    sessionContext = null;
    bootstrapStandaloneProjects = [];
    bootstrapProjectGroups = [buildProjectGroup()];
    bootstrapPlan = null;
    bootstrapPlanNodes = [];
    bootstrapPredictedBranches = [];
    tauriAvailable = false;
    ensureProjectGroupPlanResult = null;
    projectContexts.clear();
    planById.clear();
    activationPayloadByPlanId.clear();
    listArchitectPlansMock.mockClear();
    getArchitectPlanActivationPayloadMock.mockClear();
    getArchitectPlanMock.mockClear();
    setProjectSwitchPolicyMock.mockClear();
    persistActiveArchitectPlanMock.mockClear();
    getAppBootstrapMock.mockClear();
    getAppBootstrapMock.mockImplementation(async () => ({
      plan: bootstrapPlan,
      standaloneProjects: bootstrapStandaloneProjects,
      projectGroups: bootstrapProjectGroups,
      planNodes: bootstrapPlanNodes,
      predictedBranches: bootstrapPredictedBranches,
    }));
    debugResetProjectMock.mockClear();
    debugResetProjectMock.mockImplementation(async (data: { projectId: string }) => {
      bootstrapProjectGroups = bootstrapProjectGroups
        .map((group) => ({
          ...group,
          projects: group.projects.filter((project) => project.id !== data.projectId),
        }))
        .filter((group) => group.projects.length > 0);
      return {
        projectId: data.projectId,
        projectName: data.projectId,
        removedRegistryEntry: true,
        removedTaskWorktrees: 1,
        removedMetadataWorktree: false,
        removedMacroBranch: false,
        warnings: [],
      };
    });
    workspaceRecoverMissingMetadataMock.mockClear();
    workspaceRecoverMissingMetadataMock.mockImplementation(async () => ({
      status: 'none',
      restoredCommit: null,
      message: null,
    }));
    workspaceReconcileProjectRegistryFromHintsMock.mockClear();
    workspaceReconcileProjectRegistryFromHintsMock.mockImplementation(
      async (): Promise<RegistryReconcileReportRecord> =>
        buildUnchangedRegistryReconcileReport()
    );
    ensureProjectGroupPlanMock.mockClear();
    consolidateScopedBlankPlansMock.mockClear();
    upsertLocalProjectContextStateMock.mockClear();
    deleteLocalProjectContextStateMock.mockClear();
    upsertLocalSessionContextStateMock.mockClear();
    chatStoreState.beginArchitectPlanSwitch.mockClear();
    taskStoreState.activateTask.mockClear();
    taskStoreState.refreshFromPlan.mockClear();
    chatStoreState.reconcileProjectRegistry.mockClear();
    taskStoreState.tasks = [];
    chatStoreState.conversations = [];
    chatStoreState.selectedConversationId = null;
    await registerUseAppStoreMocks();
  });

  afterEach(() => {
    mock.restore();
  });

  it('persists the requested project context storage policy', async () => {
    const { useAppStore } = await loadIsolatedUseAppStore();

    await useAppStore.getState().setProjectSwitchPolicy('reset_on_switch');

    expect(useAppStore.getState().projectSwitchPolicy).toBe('reset_on_switch');
    expect(setProjectSwitchPolicyMock).toHaveBeenCalledWith('reset_on_switch');
  });

  it('selects a recovered standalone project on initialize when no remembered selection is valid', async () => {
    bootstrapProjectGroups = [];
    bootstrapStandaloneProjects = [
      {
        id: 'project-lplr-app-1780329499166',
        name: 'octan_sales',
        path: '/Users/oscarlahaie/github/octan_sales',
        gitFlowSettings: { baseBranch: 'main' },
      },
    ];
    preferenceValues.lastSelectedGroupId = 'missing-group';
    preferenceValues.lastSelectedProjectId = null;
    preferenceValues.lastOpenProjectPath = null;
    preferenceValues.recentProjects = [];

    const { useAppStore } = await loadIsolatedUseAppStore();
    await useAppStore.getState().initializeCritical();

    expect(useAppStore.getState().selectedGroupId).toBeNull();
    expect(useAppStore.getState().selectedProjectId).toBe(
      'project-lplr-app-1780329499166',
    );
    expect(useAppStore.getState().standaloneProjects).toHaveLength(1);
  });

  it('loads the newest visible plan during initialize when no remembered plan is available', async () => {
    const olderPlan = buildPlan({
      id: 'plan-older',
      updatedAt: '2026-04-17T10:00:00.000Z',
      projectIds: ['project-1', 'project-2'],
      expectedProjectIds: ['project-1', 'project-2'],
    });
    const newestPlan = buildPlan({
      id: 'plan-newest',
      updatedAt: '2026-04-17T12:00:00.000Z',
      projectIds: ['project-1', 'project-2'],
      expectedProjectIds: ['project-1', 'project-2'],
    });
    planById.set(olderPlan.id, olderPlan);
    planById.set(newestPlan.id, newestPlan);
    preferenceValues.lastActiveMode = 'Architect';

    const { useAppStore } = await loadIsolatedUseAppStore();
    await useAppStore.getState().initialize();

    expect(useAppStore.getState().activeArchitectPlanId).toBe('plan-newest');
    expect(projectContexts.get('group-1')?.lastPlanId).toBe('plan-newest');
    expect(useAppStore.getState().architectPlanCatalogScopedProjectIds).toEqual([
      'project-1',
      'project-2',
    ]);
    expect(useAppStore.getState().architectPlanCatalogModernPlanCount).toBe(2);
    expect(useAppStore.getState().architectPlanCatalogVisiblePlanCount).toBe(2);
    expect(
      useAppStore
        .getState()
        .visibleArchitectPlans.map((plan: { id: string }) => plan.id)
    ).toEqual(['plan-newest', 'plan-older']);

    const selectorState = computePlanSelectorRefreshState({
      plans: Array.from(planById.values()).map(toPlanSummary),
      scopedProjectIds: ['project-1', 'project-2'],
      showArchived: false,
      preferredActivePlanId: useAppStore.getState().activeArchitectPlanId,
      currentActivePlanId: useAppStore.getState().activeArchitectPlanId,
    });
    expect(selectorState.nextActivePlanId).toBe(
      useAppStore.getState().activeArchitectPlanId
    );
  });

  it('does not recover metadata automatically when the initial bootstrap fails', async () => {
    tauriAvailable = true;
    getAppBootstrapMock.mockImplementationOnce(async () => {
      throw new Error('metadata missing');
    });

    const { useAppStore } = await loadIsolatedUseAppStore();
    await useAppStore.getState().initializeCritical();

    expect(workspaceRecoverMissingMetadataMock).not.toHaveBeenCalled();
    expect(workspaceReconcileProjectRegistryFromHintsMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().projectGroups).toHaveLength(0);
    expect(useAppStore.getState().standaloneProjects).toHaveLength(0);
    expect(useAppStore.getState().lastError).toContain(
      'Macro opened an empty shell',
    );
  });

  it('does not restore a remembered standalone project missing from workspace metadata during startup', async () => {
    tauriAvailable = true;
    bootstrapProjectGroups = [];
    bootstrapStandaloneProjects = [];
    const currentProject: ProjectRecord = {
      id: 'project-octan-sales-1780653766405',
      name: 'octan_sales',
      path: '/repos/octan_sales',
      gitFlowSettings: { baseBranch: 'main' },
    };
    const staleProjectId = 'project-lplr-app-1780329499166';
    const visiblePhysicalPlan = buildPlan({
      id: 'plan-refonte-catalogue',
      title: 'Refonte catalogue produit',
      label: 'Refonte catalogue produit',
      conversationId: 'architect-conversation-refonte',
      projectId: staleProjectId,
      projectIds: [staleProjectId],
      expectedProjectIds: [staleProjectId],
      availableProjectIds: [currentProject.id],
      targetBranch: 'main',
      targetBranchesByProjectId: {
        [staleProjectId]: 'main',
        [currentProject.id]: 'main',
      },
      nodes: [
        {
          id: 'node-catalogue',
          title: 'Catalogue migration',
          projectId: staleProjectId,
          projectIds: [staleProjectId],
          artifactContracts: [
            {
              id: 'migration-map',
              title: 'Migration map',
            },
          ],
        },
      ],
      predictedBranches: [
        {
          id: 'branch-catalogue',
          projectId: staleProjectId,
          name: 'feature/refonte-catalogue',
        },
      ],
      updatedAt: '2026-05-22T09:00:00.000Z',
    });
    const restoredChatMessages = [
      {
        id: 'message-architect-user',
        role: 'user',
        content: 'Refondre le catalogue produit.',
        createdAt: '2026-05-22T08:30:00.000Z',
      },
      {
        id: 'message-architect-assistant',
        role: 'assistant',
        content: 'Plan chargé depuis @macro.',
        createdAt: '2026-05-22T08:31:00.000Z',
      },
    ];
    planById.set(visiblePhysicalPlan.id, visiblePhysicalPlan);
    activationPayloadByPlanId.set(visiblePhysicalPlan.id, {
      chatMessages: restoredChatMessages,
      conversationId: 'architect-conversation-refonte',
      resolutionMode: 'full',
    });
    preferenceValues.lastActiveMode = 'Architect';
    preferenceValues.lastSelectedGroupId = null;
    preferenceValues.lastSelectedProjectId = currentProject.id;
    preferenceValues.lastOpenProjectPath = currentProject.path;
    preferenceValues.macroEnabledProjects = [
      {
        projectId: currentProject.id,
        groupId: null,
        name: currentProject.name,
        path: currentProject.path,
        lastOpenedAt: '2026-05-22T08:00:00.000Z',
      },
    ];
    workspaceReconcileProjectRegistryFromHintsMock.mockImplementation(
      async (): Promise<RegistryReconcileReportRecord> => {
        bootstrapStandaloneProjects = [currentProject];
        return {
          status: 'reconciled',
          discoveredProjects: [],
          addedProjects: [currentProject],
          skippedProjects: [],
          duplicatePaths: [],
          invalidPaths: [],
        };
      },
    );

    const { useAppStore } = await loadIsolatedUseAppStore();
    const taskRefreshSnapshots: Array<{
      selectedProjectId: string | null;
      activeArchitectPlanId: string | null;
      planNodeProjectIds: Array<string | undefined>;
      planNodeArtifactContractIds: string[];
      pendingPlanProjectIds: string[];
      visiblePlanIds: string[];
    }> = [];
    taskStoreState.refreshFromPlan.mockImplementation(async () => {
      const state = useAppStore.getState();
      const planNodes = state.planNodes as PlanNode[];
      const visiblePlans = state.visibleArchitectPlans as ArchitectPlanSummary[];
      taskRefreshSnapshots.push({
        selectedProjectId: state.selectedProjectId,
        activeArchitectPlanId: state.activeArchitectPlanId,
        planNodeProjectIds: planNodes.map((node) => node.projectId),
        planNodeArtifactContractIds: planNodes.flatMap((node) =>
          (node.artifactContracts ?? [])
            .map((contract) => contract.id)
            .filter((id): id is string => Boolean(id)),
        ),
        pendingPlanProjectIds:
          state.pendingArchitectPlanActivationPayload?.plan.projectIds ?? [],
        visiblePlanIds: Array.from(
          new Set(visiblePlans.map((plan) => plan.id)),
        ),
      });
    });
    await useAppStore.getState().initialize();

    expect(workspaceRecoverMissingMetadataMock).not.toHaveBeenCalled();
    expect(workspaceReconcileProjectRegistryFromHintsMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().standaloneProjects).toHaveLength(0);
    expect(useAppStore.getState().selectedGroupId).toBeNull();
    expect(useAppStore.getState().selectedProjectId).toBeNull();
    expect(useAppStore.getState().activeArchitectPlanId).toBeNull();
    expect(useAppStore.getState().activePlanContext).toBeNull();
    expect(useAppStore.getState().planNodes).toEqual([]);
    expect(useAppStore.getState().predictedBranches).toEqual([]);
    expect(useAppStore.getState().pendingArchitectPlanActivationPayload).toBeNull();
    expect(taskRefreshSnapshots).toEqual([
      {
        selectedProjectId: null,
        activeArchitectPlanId: null,
        planNodeProjectIds: [],
        planNodeArtifactContractIds: [],
        pendingPlanProjectIds: [],
        visiblePlanIds: [],
      },
    ]);
    expect(useAppStore.getState().visibleArchitectPlans).toEqual([]);
    expect(useAppStore.getState().macroEnabledProjects).toEqual([
      expect.objectContaining({
        projectId: currentProject.id,
        name: currentProject.name,
        path: currentProject.path,
      }),
    ]);
  });

  it('keeps remembered project hints without reconciling them automatically', async () => {
    tauriAvailable = true;
    bootstrapProjectGroups = [];
    bootstrapStandaloneProjects = [];
    const rememberedProject: ProjectRecord = {
      id: 'project-octan-sales-1780653766405',
      name: 'octan_sales',
      path: '/repos/octan_sales',
      gitFlowSettings: { baseBranch: 'main' },
    };
    preferenceValues.lastSelectedGroupId = null;
    preferenceValues.lastSelectedProjectId = rememberedProject.id;
    preferenceValues.lastOpenProjectPath = rememberedProject.path;
    preferenceValues.macroEnabledProjects = [
      {
        projectId: rememberedProject.id,
        groupId: null,
        name: rememberedProject.name,
        path: rememberedProject.path,
        lastOpenedAt: '2026-06-05T08:00:00.000Z',
      },
    ];
    const { useAppStore } = await loadIsolatedUseAppStore();
    await useAppStore.getState().initialize();

    expect(workspaceReconcileProjectRegistryFromHintsMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().standaloneProjects).toEqual([]);
    expect(useAppStore.getState().selectedProjectId).toBeNull();
    expect(useAppStore.getState().macroEnabledProjects).toEqual([
      expect.objectContaining({
        projectId: rememberedProject.id,
        name: rememberedProject.name,
        path: rememberedProject.path,
      }),
    ]);
    expect(useAppStore.getState().recentProjects).toEqual([]);
  });

  it('does not restore discovered sibling @macro projects automatically', async () => {
    tauriAvailable = true;
    const knownGroup = buildProjectGroup({
      id: 'group-sysml',
      name: 'sysml',
      projects: [
        {
          id: 'project-sysml',
          name: 'sysml-drone-demo',
          path: '/repos/sysml-drone-demo',
          gitFlowSettings: { baseBranch: 'main' },
        },
      ],
    });
    bootstrapProjectGroups = [knownGroup];
    bootstrapStandaloneProjects = [];
    preferenceValues.recentProjects = [];
    preferenceValues.macroEnabledProjects = [];
    preferenceValues.lastOpenProjectPath = null;
    const { useAppStore } = await loadIsolatedUseAppStore();
    await useAppStore.getState().initialize();

    expect(workspaceReconcileProjectRegistryFromHintsMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().standaloneProjects).toEqual([
      expect.objectContaining({
        id: 'project-sysml',
        name: 'sysml-drone-demo',
        path: '/repos/sysml-drone-demo',
      }),
    ]);
    expect(useAppStore.getState().projectGroups).toEqual([]);
  });

  it('opens an empty degraded shell when bootstrap and local recovery fail', async () => {
    tauriAvailable = true;
    getAppBootstrapMock.mockImplementation(async () => {
      throw new Error('metadata corrupt');
    });

    const { useAppStore } = await loadIsolatedUseAppStore();
    await useAppStore.getState().initializeCritical();

    expect(workspaceRecoverMissingMetadataMock).not.toHaveBeenCalled();
    expect(workspaceReconcileProjectRegistryFromHintsMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().projectGroups).toEqual([]);
    expect(useAppStore.getState().lastError).toContain(
      'Macro opened an empty shell',
    );
  });

  it('debug-resets the selected project without surfacing a registry repair banner', async () => {
    projectContexts.set('project-1', buildProjectContext({ projectId: 'project-1' }));

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Implement',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      projectRegistryRepairSummary: null,
    });

    await useAppStore.getState().debugResetProject('project-1');

    expect(useAppStore.getState().selectedGroupId).toBeNull();
    expect(useAppStore.getState().selectedProjectId).toBe('project-2');
    expect(useAppStore.getState().projectRegistryRepairSummary).toBeNull();
    expect(projectContexts.has('project-1')).toBe(false);
    expect(deleteLocalProjectContextStateMock.mock.calls).toHaveLength(1);
    expect(sessionContext?.selectedProjectId).toBe('project-2');
  });

  it('debug-resets a non-selected project while preserving the current valid focus', async () => {
    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Implement',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-2',
      projectRegistryRepairSummary: null,
    });

    await useAppStore.getState().debugResetProject('project-1');

    expect(useAppStore.getState().selectedGroupId).toBeNull();
    expect(useAppStore.getState().selectedProjectId).toBe('project-2');
    expect(useAppStore.getState().projectRegistryRepairSummary).toBeNull();
    expect(sessionContext?.selectedProjectId).toBe('project-2');
  });

  it('debug-resets the last project into an empty clean selection', async () => {
    bootstrapProjectGroups = [
      buildProjectGroup({
        projects: [
          {
            id: 'project-only',
            name: 'Only',
            path: '/repos/only',
            gitFlowSettings: { baseBranch: 'develop' },
          },
        ],
      }),
    ];

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Implement',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-only',
      projectRegistryRepairSummary: null,
    });

    await useAppStore.getState().debugResetProject('project-only');

    expect(useAppStore.getState().projectGroups).toEqual([]);
    expect(useAppStore.getState().selectedGroupId).toBeNull();
    expect(useAppStore.getState().selectedProjectId).toBeNull();
    expect(useAppStore.getState().projectRegistryRepairSummary).toBeNull();
    expect(sessionContext?.selectedProjectId).toBeNull();
  });

  it('hydrates the remembered plan when entering Architect mode', async () => {
    const rememberedPlan = buildPlan({
      id: 'plan-remembered',
      projectIds: ['project-1', 'project-2'],
      expectedProjectIds: ['project-1', 'project-2'],
    });
    planById.set(rememberedPlan.id, rememberedPlan);
    projectContexts.set(
      'group-1',
      buildProjectContext({
        projectId: 'group-1',
        groupId: 'group-1',
        lastPlanId: 'plan-remembered',
      })
    );

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Chat',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      activeArchitectPlanId: null,
      activePlanContext: null,
      planNodes: [],
      predictedBranches: [],
    });

    useAppStore.getState().setMode('Architect');
    await flushAsyncWork();

    expect(useAppStore.getState().activeArchitectPlanId).toBe(
      'plan-remembered'
    );
  });

  it('resolves a visible plan on same-group project focus changes when no plan is active', async () => {
    const visiblePlan = buildPlan({
      id: 'plan-visible',
      updatedAt: '2026-04-17T11:00:00.000Z',
      projectIds: ['project-1', 'project-2'],
      expectedProjectIds: ['project-1', 'project-2'],
    });
    planById.set(visiblePlan.id, visiblePlan);

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Architect',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      activeArchitectPlanId: null,
      activePlanContext: null,
      planNodes: [],
      predictedBranches: [],
    });

    await useAppStore.getState().switchProjectContext('project-2');

    expect(useAppStore.getState().selectedProjectId).toBe('project-2');
    expect(useAppStore.getState().activeArchitectPlanId).toBe('plan-visible');
    expect(projectContexts.get('group-1')?.lastPlanId).toBe('plan-visible');
  });

  it('keeps the current visible plan instead of replacing it with the remembered fallback', async () => {
    const currentPlan = buildPlan({
      id: 'plan-current',
      updatedAt: '2026-04-17T09:00:00.000Z',
      projectIds: ['project-1', 'project-2'],
      expectedProjectIds: ['project-1', 'project-2'],
    });
    const rememberedPlan = buildPlan({
      id: 'plan-remembered',
      updatedAt: '2026-04-17T12:00:00.000Z',
      projectIds: ['project-1', 'project-2'],
      expectedProjectIds: ['project-1', 'project-2'],
    });
    planById.set(currentPlan.id, currentPlan);
    planById.set(rememberedPlan.id, rememberedPlan);
    projectContexts.set(
      'group-1',
      buildProjectContext({
        projectId: 'group-1',
        groupId: 'group-1',
        lastPlanId: 'plan-remembered',
      })
    );

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Architect',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      activeArchitectPlanId: 'plan-current',
      activePlanContext: {
        id: 'plan-current',
        title: 'plan-current',
        label: 'plan-current',
        description: '',
        status: 'draft',
        targetBranch: 'develop',
      },
      planNodes: [],
      predictedBranches: [],
    });

    await useAppStore.getState().switchProjectContext('project-2');

    expect(useAppStore.getState().activeArchitectPlanId).toBe('plan-current');
    expect(projectContexts.get('group-1')?.lastPlanId).toBe('plan-current');
  });

  it('falls back to the newest visible plan when the remembered plan is archived', async () => {
    const archivedRememberedPlan = buildPlan({
      id: 'plan-archived',
      status: 'archived',
      updatedAt: '2026-04-17T13:00:00.000Z',
      projectIds: ['project-1', 'project-2'],
      expectedProjectIds: ['project-1', 'project-2'],
    });
    const newestVisiblePlan = buildPlan({
      id: 'plan-visible',
      updatedAt: '2026-04-17T12:00:00.000Z',
      projectIds: ['project-1', 'project-2'],
      expectedProjectIds: ['project-1', 'project-2'],
    });
    planById.set(archivedRememberedPlan.id, archivedRememberedPlan);
    planById.set(newestVisiblePlan.id, newestVisiblePlan);
    projectContexts.set(
      'group-1',
      buildProjectContext({
        projectId: 'group-1',
        groupId: 'group-1',
        lastPlanId: 'plan-archived',
      })
    );

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Chat',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      activeArchitectPlanId: null,
      activePlanContext: null,
      planNodes: [],
      predictedBranches: [],
    });

    useAppStore.getState().setMode('Architect');
    await flushAsyncWork();

    expect(useAppStore.getState().activeArchitectPlanId).toBe('plan-visible');
    expect(projectContexts.get('group-1')?.lastPlanId).toBe('plan-visible');
  });

  it('does not create a blank auto-plan when no visible plan exists', async () => {
    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Chat',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      activeArchitectPlanId: null,
      activePlanContext: null,
      planNodes: [],
      predictedBranches: [],
    });

    useAppStore.getState().setMode('Architect');
    await flushAsyncWork();

    expect(ensureProjectGroupPlanMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeArchitectPlanId).toBeNull();
  });

  it('hydrates a switched architect plan from the activation payload and starts the chat transition immediately', async () => {
    const currentPlan = buildPlan({
      id: 'plan-current',
      updatedAt: '2026-04-17T10:00:00.000Z',
    });
    const nextPlan = buildPlan({
      id: 'plan-next',
      updatedAt: '2026-04-17T11:00:00.000Z',
      label: 'Checkout refresh',
    });
    planById.set(currentPlan.id, currentPlan);
    planById.set(nextPlan.id, nextPlan);
    projectContexts.set(
      'group-1',
      buildProjectContext({
        projectId: 'group-1',
        groupId: 'group-1',
        lastPlanId: currentPlan.id,
      })
    );
    preferenceValues.lastActiveMode = 'Architect';

    const { useAppStore } = await loadIsolatedUseAppStore();
    await useAppStore.getState().initialize();

    getArchitectPlanActivationPayloadMock.mockClear();
    chatStoreState.beginArchitectPlanSwitch.mockClear();

    await useAppStore.getState().activateArchitectPlan(nextPlan.id);

    expect(chatStoreState.beginArchitectPlanSwitch).toHaveBeenCalledTimes(1);
    expect(getArchitectPlanActivationPayloadMock).toHaveBeenCalledWith(
      'develop',
      nextPlan.id,
      expect.any(Object)
    );
    expect(useAppStore.getState().activeArchitectPlanId).toBe(nextPlan.id);
    expect(useAppStore.getState().activePlanContext?.id).toBe(nextPlan.id);
    expect(
      useAppStore.getState().pendingArchitectPlanActivationPayload?.plan.id
    ).toBe(nextPlan.id);
  });

  it('retargets activated architect strategy nodes after a standalone project rename', async () => {
    const staleProjectId = 'project-lplr-app-1780329499166';
    const currentProjectId = 'project-octan-sales-1780653766405';
    const renamedPlan = buildPlan({
      id: 'plan-renamed-project',
      projectId: staleProjectId,
      projectIds: [staleProjectId],
      expectedProjectIds: [staleProjectId],
      availableProjectIds: [currentProjectId],
      nodes: [
        {
          id: 'node-1',
          projectId: staleProjectId,
          projectIds: [staleProjectId],
        },
      ],
      predictedBranches: [
        {
          id: 'branch-1',
          projectId: staleProjectId,
        },
      ],
    });
    planById.set(renamedPlan.id, renamedPlan);

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Architect',
      standaloneProjects: [
        {
          id: currentProjectId,
          name: 'octan_sales',
          path: '/repos/octan_sales',
          gitFlowSettings: { baseBranch: 'develop' },
        },
      ],
      projectGroups: [],
      selectedGroupId: null,
      selectedProjectId: currentProjectId,
    });

    await useAppStore.getState().activateArchitectPlan(renamedPlan.id, {
      allowScopeSwitch: false,
      planSummaryHint: toPlanSummary(renamedPlan),
      scopedProjectIdsHint: [currentProjectId],
    });

    const state = useAppStore.getState();
    expect(state.activeArchitectPlanId).toBe(renamedPlan.id);
    expect(
      (state.planNodes[0] as { projectId?: string; projectIds?: string[] })
        .projectId
    ).toBe(currentProjectId);
    expect(
      (state.planNodes[0] as { projectId?: string; projectIds?: string[] })
        .projectIds
    ).toEqual([currentProjectId]);
    expect(
      (state.predictedBranches[0] as { projectId?: string }).projectId
    ).toBe(currentProjectId);
    expect(
      state.pendingArchitectPlanActivationPayload?.plan.projectIds
    ).toEqual([currentProjectId]);
  });

  it('clears the previous strategy state immediately while an architect plan switch is resolving', async () => {
    const currentPlan = buildPlan({
      id: 'plan-current',
      updatedAt: '2026-04-17T10:00:00.000Z',
    });
    const nextPlan = buildPlan({
      id: 'plan-next-pending',
      updatedAt: '2026-04-17T11:00:00.000Z',
      label: 'Checkout refresh',
    });
    planById.set(currentPlan.id, currentPlan);
    planById.set(nextPlan.id, nextPlan);

    let resolveActivation!: (value: ActivationPayloadRecord) => void;
    getArchitectPlanActivationPayloadMock.mockImplementationOnce(
      async (_branchName: string, _planId: string) =>
        await new Promise((resolve) => {
          resolveActivation = resolve;
        })
    );

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Architect',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      activeArchitectPlanId: currentPlan.id,
      activePlanContext: {
        id: currentPlan.id,
        title: currentPlan.title,
        label: currentPlan.label,
        description: currentPlan.description,
        status: currentPlan.status,
        targetBranch: currentPlan.targetBranch,
      },
      planNodes: [{ id: 'node-1' } as never],
      predictedBranches: [{ id: 'branch-1' } as never],
    });

    const activationPromise = useAppStore.getState().activateArchitectPlan(
      nextPlan.id,
      {
        planSummaryHint: toPlanSummary(nextPlan),
      }
    );
    await Promise.resolve();

    expect(useAppStore.getState().activeArchitectPlanId).toBe(nextPlan.id);
    expect(useAppStore.getState().activePlanContext?.id).toBe(nextPlan.id);
    expect(useAppStore.getState().planNodes).toEqual([]);
    expect(useAppStore.getState().predictedBranches).toEqual([]);
    expect(useAppStore.getState().architectPlanSwitch.status).toBe('resolving');

    resolveActivation({
      plan: nextPlan,
      chatMessages: [],
      conversationId: null,
      sharedConversation: false,
      targetBranch: 'develop',
      resolutionMode: 'blank_fast_path',
    });
    await activationPromise;

    expect(useAppStore.getState().architectPlanSwitch.status).toBe('ready');
    expect(useAppStore.getState().activeArchitectPlanId).toBe(nextPlan.id);
  });

  it('ignores stale architect plan switch payloads when a newer selection resolves later', async () => {
    const currentPlan = buildPlan({ id: 'plan-current-race' });
    const slowPlan = buildPlan({
      id: 'plan-slow',
      updatedAt: '2026-04-17T11:00:00.000Z',
    });
    const fastPlan = buildPlan({
      id: 'plan-fast',
      updatedAt: '2026-04-17T12:00:00.000Z',
    });
    planById.set(currentPlan.id, currentPlan);
    planById.set(slowPlan.id, slowPlan);
    planById.set(fastPlan.id, fastPlan);

    let resolveSlow!: (value: ActivationPayloadRecord) => void;
    let resolveFast!: (value: ActivationPayloadRecord) => void;
    let resolveSlowPersistence!: () => void;
    let persistedPlanId: string | null = null;
    persistActiveArchitectPlanMock
      .mockImplementationOnce(
        async (_targetBranch: string, planId: string) =>
          await new Promise<void>((resolve) => {
            resolveSlowPersistence = () => {
              persistedPlanId = planId;
              resolve();
            };
          }).then(() => undefined)
      )
      .mockImplementationOnce(async (_targetBranch: string, planId: string) => {
        persistedPlanId = planId;
        return undefined;
      });
    getArchitectPlanActivationPayloadMock
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            resolveSlow = resolve;
          })
      )
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            resolveFast = resolve;
          })
      );

    const { useAppStore } = await loadIsolatedUseAppStore();
    useAppStore.setState({
      mode: 'Architect',
      projectGroups: bootstrapProjectGroups,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      activeArchitectPlanId: currentPlan.id,
      activePlanContext: {
        id: currentPlan.id,
        title: currentPlan.title,
        label: currentPlan.label,
        description: currentPlan.description,
        status: currentPlan.status,
        targetBranch: currentPlan.targetBranch,
      },
      planNodes: [],
      predictedBranches: [],
    });

    const slowActivation = useAppStore.getState().activateArchitectPlan(
      slowPlan.id,
      {
        planSummaryHint: toPlanSummary(slowPlan),
      }
    );
    const fastActivation = useAppStore.getState().activateArchitectPlan(
      fastPlan.id,
      {
        planSummaryHint: toPlanSummary(fastPlan),
      }
    );
    await Promise.resolve();

    resolveFast({
      plan: fastPlan,
      chatMessages: [],
      conversationId: null,
      sharedConversation: false,
      targetBranch: 'develop',
      resolutionMode: 'blank_fast_path',
    });
    expect(await fastActivation).toBe(true);

    resolveSlowPersistence();
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
    expect(persistActiveArchitectPlanMock).toHaveBeenCalledTimes(2);
    expect(String(persistedPlanId)).toBe(fastPlan.id);

    resolveSlow({
      plan: slowPlan,
      chatMessages: [],
      conversationId: null,
      sharedConversation: false,
      targetBranch: 'develop',
      resolutionMode: 'blank_fast_path',
    });
    expect(await slowActivation).toBe(false);

    expect(useAppStore.getState().activeArchitectPlanId).toBe(fastPlan.id);
    expect(useAppStore.getState().activePlanContext?.id).toBe(fastPlan.id);
    expect(useAppStore.getState().architectPlanSwitch.targetPlanId).toBe(
      fastPlan.id
    );
  });
});
