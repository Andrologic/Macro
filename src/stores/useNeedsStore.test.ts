import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const appState = {
  selectedGroupId: null as string | null,
  selectedProjectId: null as string | null,
  activeArchitectPlanId: null as string | null,
};

const saveArchitectPlanNeedsMock = mock(async () => undefined);

let importCounter = 0;

const createMockStoreHook = <TState extends object>(state: TState) => {
  const storeHook = (<TSelected = TState>(
    selector?: (snapshot: TState) => TSelected
  ) => (selector ? selector(state) : (state as unknown as TSelected))) as ((
    selector?: <TSelected>(snapshot: TState) => TSelected
  ) => TState) & {
    getState: () => TState;
    setState: (
      patch: Partial<TState> | ((snapshot: TState) => Partial<TState>)
    ) => void;
    subscribe: () => () => void;
  };

  storeHook.getState = () => state;
  storeHook.setState = (patch) => {
    Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  };
  storeHook.subscribe = () => () => undefined;

  return storeHook;
};

const useAppStoreMock = createMockStoreHook(appState);

const registerUseNeedsStoreMocks = async () => {
  mock.restore();

  const appStoreModule = () => ({
    useAppStore: useAppStoreMock,
  });
  mock.module('./useAppStore', appStoreModule);
  mock.module('./useAppStore.ts', appStoreModule);

  importCounter += 1;
  const actualArchitectPlanService = await import(
    `../services/architectPlanService.ts?use-needs-store-architect-plan-service-test=${importCounter}`
  );

  const architectPlanServiceModule = () => ({
    ...actualArchitectPlanService,
    createArchitectPlan: mock(async () => {
      throw new Error('not implemented');
    }),
    archiveArchitectPlan: mock(async (_branchName: string, planId: string) => ({
      id: planId,
      status: 'archived',
    })),
    commitArchitectPlanMetadata: mock(async () => undefined),
    deleteArchitectPlan: mock(async () => undefined),
    getArchitectPlan: mock(async () => null),
    getArchitectPlanChatMessages: mock(async () => []),
    getArchitectPlanNeeds: mock(async () => []),
    getArchitectPlanProjectIds: (plan: { projectId?: string; projectIds?: string[] }) =>
      Array.from(new Set([plan.projectId, ...(plan.projectIds ?? [])].filter(Boolean))) as string[],
    isArchitectPlanVisibleForScope: () => true,
    isArchitectPlanReplicaDivergenceError: () => false,
    listArchitectPlans: mock(async () => ({
      activePlanId: null,
      plans: [],
    })),
    listArchitectPlanTargetBranches: () => [],
    planMatchesProjectId: (
      plan: { projectId?: string; projectIds?: string[] },
      projectId?: string | null
    ) => {
      if (!projectId) {
        return true;
      }
      const projectIds = Array.from(new Set([plan.projectId, ...(plan.projectIds ?? [])].filter(Boolean)));
      return projectIds.includes(projectId);
    },
    resolvePlanProjectContextId: (
      plan: { projectId?: string; projectIds?: string[] },
      fallbackProjectId?: string | null
    ) => plan.projectId ?? plan.projectIds?.[0] ?? fallbackProjectId ?? null,
    repairArchitectPlanReplicas: mock(async () => undefined),
    restoreArchitectPlan: mock(async () => undefined),
    saveArchitectPlanChatMessages: mock(async () => undefined),
    saveArchitectPlanNeeds: saveArchitectPlanNeedsMock,
    setActiveArchitectPlan: mock(async () => undefined),
    syncArchitectPlanChatFromConversation: mock(async () => undefined),
    toPlanIntegrationBranch: (planId: string) => `plan/${planId}`,
    toPlanScopedFeatureBranch: (planId: string, featureSlug: string) =>
      `feature/${planId}/${featureSlug}`,
    updateArchitectPlan: mock(async (params: { planId: string }) => ({
      id: params.planId,
    })),
    writeArchitectTaskExecution: mock(async () => undefined),
  });
  mock.module('../services/architectPlanService', architectPlanServiceModule);
  mock.module('../services/architectPlanService.ts', architectPlanServiceModule);
};

const loadNeedsStore = async () => {
  importCounter += 1;
  return import(`./useNeedsStore.ts?test=${importCounter}`);
};

describe('useNeedsStore', () => {
  beforeEach(async () => {
    await registerUseNeedsStoreMocks();
    appState.selectedGroupId = null;
    appState.selectedProjectId = null;
    appState.activeArchitectPlanId = null;
    saveArchitectPlanNeedsMock.mockClear();
  });

  afterEach(() => {
    mock.restore();
  });

  it('defaults new needs to the selected global project without forcing a subproject', async () => {
    const { useNeedsStore } = await loadNeedsStore();
    useNeedsStore.setState({
      needs: [],
      selectedNeedId: null,
    });

    appState.selectedGroupId = 'macro-suite';
    appState.selectedProjectId = 'macro-api';

    const needId = useNeedsStore.getState().addNeed({
      title: 'Define mobile auth flow',
      description: 'Need a shared auth contract across the suite.',
      category: 'functional',
      status: 'identified',
      priority: 'high',
      tags: ['auth'],
    });

    const createdNeed = useNeedsStore.getState().getNeed(needId);
    expect(createdNeed?.groupId).toBe('macro-suite');
    expect(createdNeed?.projectId).toBeUndefined();
  });

  it('hydrates needs for a plan without persisting metadata', async () => {
    const { useNeedsStore } = await loadNeedsStore();
    useNeedsStore.setState({
      needs: [],
      selectedNeedId: null,
    });

    appState.selectedGroupId = 'macro-suite';

    useNeedsStore.getState().hydrateNeedsForPlan('plan-1', [
      {
        id: 'need-1',
        planId: 'other-plan',
        title: 'Clarify economy loop',
        description: 'Need a tight framing for resource pressure.',
        category: 'functional',
        status: 'identified',
        priority: 'high',
        tags: [],
        createdAt: '2026-04-14T10:00:00.000Z',
        updatedAt: '2026-04-14T10:00:00.000Z',
      },
    ]);

    expect(useNeedsStore.getState().getNeedsForPlan('plan-1')).toEqual([
      expect.objectContaining({
        id: 'need-1',
        planId: 'plan-1',
        groupId: 'macro-suite',
      }),
    ]);
    expect(saveArchitectPlanNeedsMock).not.toHaveBeenCalled();
  });

  it('persists plan needs when replacing them through the mutating action', async () => {
    const { useNeedsStore } = await loadNeedsStore();
    useNeedsStore.setState({
      needs: [],
      selectedNeedId: null,
    });

    useNeedsStore.getState().replaceNeedsForPlan('plan-2', [
      {
        id: 'need-2',
        planId: 'plan-2',
        title: 'Define factions',
        description: 'Need a clear list of playable factions.',
        category: 'business',
        status: 'identified',
        priority: 'medium',
        tags: ['design'],
        createdAt: '2026-04-14T10:10:00.000Z',
        updatedAt: '2026-04-14T10:10:00.000Z',
      },
    ]);

    await useNeedsStore.getState().flushPendingPersistence('plan-2');

    expect(saveArchitectPlanNeedsMock).toHaveBeenCalledTimes(1);
    expect(saveArchitectPlanNeedsMock).toHaveBeenCalledWith('main', 'plan-2', [
      expect.objectContaining({
        id: 'need-2',
        planId: 'plan-2',
      }),
    ]);
  });

  it('flushes queued need persistence for successive additions', async () => {
    const { useNeedsStore } = await loadNeedsStore();
    useNeedsStore.setState({
      needs: [],
      selectedNeedId: null,
    });
    appState.activeArchitectPlanId = 'plan-flush';

    useNeedsStore.getState().addNeed({
      title: 'First requirement',
      description: 'Capture the first requirement.',
      category: 'functional',
      status: 'identified',
      priority: 'high',
      tags: [],
    });
    useNeedsStore.getState().addNeed({
      title: 'Second requirement',
      description: 'Capture the second requirement.',
      category: 'technical',
      status: 'identified',
      priority: 'medium',
      tags: [],
    });

    await useNeedsStore.getState().flushPendingPersistence('plan-flush');

    const calls = saveArchitectPlanNeedsMock.mock.calls as unknown as Array<
      [string, string, Array<{ title: string }>]
    >;
    const lastCall = calls.at(-1);
    expect(lastCall?.[0]).toBe('main');
    expect(lastCall?.[1]).toBe('plan-flush');
    expect((lastCall?.[2] as Array<{ title: string }>).map((need) => need.title)).toEqual([
      'First requirement',
      'Second requirement',
    ]);
  });

  it('persists partial need updates on the same plan', async () => {
    const { useNeedsStore } = await loadNeedsStore();
    useNeedsStore.setState({
      needs: [
        {
          id: 'need-3',
          planId: 'plan-3',
          title: 'Initial scope',
          description: 'Original description.',
          category: 'functional',
          status: 'identified',
          priority: 'medium',
          tags: ['scope'],
          createdAt: '2026-04-14T10:20:00.000Z',
          updatedAt: '2026-04-14T10:20:00.000Z',
        },
      ],
      selectedNeedId: null,
    });

    useNeedsStore.getState().updateNeed('need-3', {
      status: 'validated',
      priority: 'high',
      tags: ['scope', 'approved'],
    });

    await useNeedsStore.getState().flushPendingPersistence('plan-3');

    expect(useNeedsStore.getState().getNeed('need-3')).toEqual(
      expect.objectContaining({
        status: 'validated',
        priority: 'high',
        tags: ['scope', 'approved'],
      })
    );
    expect(saveArchitectPlanNeedsMock).toHaveBeenCalledTimes(1);
    expect(saveArchitectPlanNeedsMock).toHaveBeenCalledWith('main', 'plan-3', [
      expect.objectContaining({
        id: 'need-3',
        planId: 'plan-3',
        status: 'validated',
      }),
    ]);
  });

  it('persists need deletions and clears the selection when needed', async () => {
    const { useNeedsStore } = await loadNeedsStore();
    useNeedsStore.setState({
      needs: [
        {
          id: 'need-4',
          planId: 'plan-4',
          title: 'Remove me',
          description: 'Temporary requirement.',
          category: 'other',
          status: 'identified',
          priority: 'low',
          tags: [],
          createdAt: '2026-04-14T10:30:00.000Z',
          updatedAt: '2026-04-14T10:30:00.000Z',
        },
      ],
      selectedNeedId: 'need-4',
    });

    useNeedsStore.getState().deleteNeed('need-4');

    await useNeedsStore.getState().flushPendingPersistence('plan-4');

    expect(useNeedsStore.getState().getNeed('need-4')).toBeUndefined();
    expect(useNeedsStore.getState().selectedNeedId).toBeNull();
    expect(saveArchitectPlanNeedsMock).toHaveBeenCalledTimes(1);
    expect(saveArchitectPlanNeedsMock).toHaveBeenCalledWith('main', 'plan-4', []);
  });
});
