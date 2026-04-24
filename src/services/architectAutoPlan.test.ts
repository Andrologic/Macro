import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  DEFAULT_NEW_PLAN_LABEL,
  getArchitectPlanEditableName,
  getNextDefaultNewPlanLabel,
  isCanonicalArchitectPlan,
  isDefaultNewPlanFamilyLabel,
  isDefaultNewPlanBaseLabel,
} from './architectPlanPresentation';
import { createArchitectAutoPlanService } from './architectAutoPlanCore';
import type { ArchitectPlanRecord, ArchitectPlanSummary } from './architectPlanService';

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

const branchName = 'develop';

const createArchitectAutoPlanHarness = () => {
  const plans = new Map<string, ArchitectPlanRecord>();
  let activePlanId: string | null = null;

  const toSummary = (plan: ArchitectPlanRecord): ArchitectPlanSummary => ({
    id: plan.id,
    slug: plan.slug,
    title: plan.title,
    label: plan.label,
    description: plan.description,
    status: plan.status,
    targetBranch: plan.targetBranch,
    conversationId: plan.conversationId,
    projectId: plan.projectId,
    projectIds: plan.projectIds,
    contextProjectIds: plan.contextProjectIds,
    expectedProjectIds: plan.expectedProjectIds,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    nodeCount: plan.nodes.length,
    predictedBranchCount: plan.predictedBranches.length,
    needCount: 0,
    chatMessageCount: 0,
  });

  const clonePlan = (plan: ArchitectPlanRecord): ArchitectPlanRecord => ({
    ...plan,
    projectIds: plan.projectIds ? [...plan.projectIds] : undefined,
    contextProjectIds: plan.contextProjectIds ? [...plan.contextProjectIds] : undefined,
    expectedProjectIds: plan.expectedProjectIds ? [...plan.expectedProjectIds] : undefined,
    nodes: [...plan.nodes],
    predictedBranches: [...plan.predictedBranches],
  });

  const createArchitectPlan = async (params: {
    branchName: string;
    planId?: string;
    label?: string;
    projectId?: string;
    projectIds?: string[];
    contextProjectIds?: string[];
    createdAt?: string;
    updatedAt?: string;
    status?: ArchitectPlanRecord['status'];
    setActive?: boolean;
  }) => {
    const id = params.planId ?? `plan-${plans.size + 1}`;
    const now = params.updatedAt ?? params.createdAt ?? new Date().toISOString();
    const projectIds = params.projectIds ?? (params.projectId ? [params.projectId] : []);
    const plan: ArchitectPlanRecord = {
      id,
      slug: id,
      title: id,
      label: params.label ?? id,
      description: '',
      status: params.status ?? 'draft',
      targetBranch: params.branchName,
      conversationId: undefined,
      projectId: params.projectId ?? projectIds[0],
      projectIds: projectIds.length > 0 ? [...projectIds] : undefined,
      contextProjectIds: params.contextProjectIds ? [...params.contextProjectIds] : undefined,
      expectedProjectIds:
        projectIds.length > 0 || params.contextProjectIds?.length
          ? [...projectIds, ...(params.contextProjectIds || [])]
          : undefined,
      createdAt: params.createdAt ?? now,
      updatedAt: params.updatedAt ?? now,
      nodes: [],
      predictedBranches: [],
    };
    plans.set(plan.id, plan);
    if (params.setActive) {
      activePlanId = plan.id;
    }
    return clonePlan(plan);
  };

  const getArchitectPlan = async (_branchName: string, planId: string) => {
    const plan = plans.get(planId);
    return plan ? clonePlan(plan) : null;
  };

  const deleteArchitectPlan = async (params: {
    branchName: string;
    planId: string;
    hardDelete?: boolean;
  }) => {
    void params.branchName;
    if (params.hardDelete) {
      plans.delete(params.planId);
      if (activePlanId === params.planId) {
        activePlanId = Array.from(plans.keys())[0] ?? null;
      }
      return;
    }

    const existing = plans.get(params.planId);
    if (!existing) {
      throw new Error(`Unknown plan ${params.planId}`);
    }
    plans.set(params.planId, {
      ...existing,
      status: 'deleted',
    });
  };

  const listArchitectPlans = async (_branchName?: string, _includeArchived?: boolean, _includeDeleted?: boolean) => ({
    activePlanId,
    plans: Array.from(plans.values()).map((plan) => toSummary(clonePlan(plan))),
  });

  const updateArchitectPlan = async (params: {
    branchName: string;
    planId: string;
    label?: string;
    description?: string;
    projectIds?: string[];
    contextProjectIds?: string[];
    expectedProjectIds?: string[];
    updatedAt?: string;
    setActive?: boolean;
  }) => {
    const existing = plans.get(params.planId);
    if (!existing) {
      throw new Error(`Unknown plan ${params.planId}`);
    }
    const updated: ArchitectPlanRecord = {
      ...existing,
      label: params.label ?? existing.label,
      description: params.description ?? existing.description,
      projectIds: params.projectIds ? [...params.projectIds] : existing.projectIds ? [...existing.projectIds] : undefined,
      contextProjectIds: params.contextProjectIds
        ? [...params.contextProjectIds]
        : existing.contextProjectIds
          ? [...existing.contextProjectIds]
          : undefined,
      expectedProjectIds: params.expectedProjectIds
        ? [...params.expectedProjectIds]
        : params.projectIds || params.contextProjectIds
          ? [
              ...(params.projectIds || existing.projectIds || []),
              ...(params.contextProjectIds || existing.contextProjectIds || []),
            ]
          : existing.expectedProjectIds
            ? [...existing.expectedProjectIds]
            : existing.projectIds
              ? [...existing.projectIds]
              : undefined,
      updatedAt: params.updatedAt ?? new Date().toISOString(),
    };
    if (updated.projectIds?.length) {
      updated.projectId = updated.projectIds[0];
    }
    plans.set(updated.id, updated);
    if (params.setActive) {
      activePlanId = updated.id;
    }
    return clonePlan(updated);
  };

  const setActiveArchitectPlan = async (_branchName: string, planId: string | null) => {
    activePlanId = planId;
  };

  const getArchitectPlanNeeds = async (_branchName: string, _planId: string) => [];
  const getArchitectPlanChatMessages = async (_branchName: string, _planId: string) => [];
  const getArchitectPlanVisibleProjectIds = (
    plan: Pick<ArchitectPlanSummary, 'projectId' | 'projectIds' | 'expectedProjectIds'>,
  ) => Array.from(new Set([plan.projectId, ...(plan.projectIds ?? []), ...(plan.expectedProjectIds ?? [])].filter(Boolean))) as string[];

  return {
    createArchitectPlan,
    getArchitectPlan,
    listArchitectPlans,
    updateArchitectPlan,
    ensureProjectGroupPlan: createArchitectAutoPlanService({
      DEFAULT_NEW_PLAN_LABEL,
      createArchitectPlan,
      deleteArchitectPlan,
      getArchitectPlan,
      getArchitectPlanChatMessages,
      getArchitectPlanEditableName,
      getArchitectPlanNeeds,
      getArchitectPlanVisibleProjectIds,
      getNextDefaultNewPlanLabel,
      isCanonicalArchitectPlan,
      isDefaultNewPlanFamilyLabel,
      isDefaultNewPlanBaseLabel,
      listArchitectPlans,
      setActiveArchitectPlan,
      updateArchitectPlan,
    }).ensureProjectGroupPlan,
    consolidateScopedBlankPlans: createArchitectAutoPlanService({
      DEFAULT_NEW_PLAN_LABEL,
      createArchitectPlan,
      deleteArchitectPlan,
      getArchitectPlan,
      getArchitectPlanChatMessages,
      getArchitectPlanEditableName,
      getArchitectPlanNeeds,
      getArchitectPlanVisibleProjectIds,
      getNextDefaultNewPlanLabel,
      isCanonicalArchitectPlan,
      isDefaultNewPlanFamilyLabel,
      isDefaultNewPlanBaseLabel,
      listArchitectPlans,
      setActiveArchitectPlan,
      updateArchitectPlan,
    }).consolidateScopedBlankPlans,
    ensureScopedBlankPlan: createArchitectAutoPlanService({
      DEFAULT_NEW_PLAN_LABEL,
      createArchitectPlan,
      deleteArchitectPlan,
      getArchitectPlan,
      getArchitectPlanChatMessages,
      getArchitectPlanEditableName,
      getArchitectPlanNeeds,
      getArchitectPlanVisibleProjectIds,
      getNextDefaultNewPlanLabel,
      isCanonicalArchitectPlan,
      isDefaultNewPlanFamilyLabel,
      isDefaultNewPlanBaseLabel,
      listArchitectPlans,
      setActiveArchitectPlan,
      updateArchitectPlan,
    }).ensureScopedBlankPlan,
  };
};

describe('architectAutoPlan', () => {
  let storage: LocalStorageMock;

  beforeEach(() => {
    storage = createLocalStorageMock();
    const windowValue =
      globalThis.window && typeof globalThis.window === 'object'
        ? (globalThis.window as unknown as Record<string, unknown>)
        : {};
    Object.defineProperty(windowValue, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: windowValue,
      configurable: true,
      writable: true,
    });
    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    mock.restore();
  });

  it('creates and activates a default blank plan when none exists for the scope', async () => {
    const { ensureProjectGroupPlan, listArchitectPlans } = createArchitectAutoPlanHarness();
    const ensured = await ensureProjectGroupPlan({
      branchName,
      scopedProjectIds: ['web'],
    });

    expect(ensured).not.toBeNull();
    expect(ensured?.action).toBe('created');
    expect(ensured?.plan.label).toBe('new plan');
    expect(ensured?.plan.projectIds).toEqual(['web']);

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.activePlanId).toBe(ensured!.plan.id);
    expect(listed.plans).toHaveLength(1);
  });

  it('expands an existing blank plan scope instead of creating a second plan', async () => {
    const { createArchitectPlan, ensureProjectGroupPlan, listArchitectPlans, getArchitectPlan } =
      createArchitectAutoPlanHarness();
    const created = await createArchitectPlan({
      branchName,
      planId: 'blank-plan',
      label: 'new plan',
      projectIds: ['web'],
      status: 'draft',
      setActive: true,
    });

    const ensured = await ensureProjectGroupPlan({
      branchName,
      scopedProjectIds: ['web', 'api'],
    });

    expect(ensured).not.toBeNull();
    expect(ensured?.action).toBe('expanded_blank');
    expect(ensured?.plan.id).toBe(created.id);
    expect(ensured?.plan.projectIds).toEqual(['web', 'api']);
    expect(ensured?.plan.expectedProjectIds).toEqual(['web', 'api']);

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans).toHaveLength(1);

    const reloaded = await getArchitectPlan(branchName, created.id);
    expect(reloaded?.projectIds).toEqual(['web', 'api']);
    expect(reloaded?.expectedProjectIds).toEqual(['web', 'api']);
  });

  it('keeps read-only subprojects as context when expanding a blank plan', async () => {
    const { createArchitectPlan, ensureProjectGroupPlan, getArchitectPlan } =
      createArchitectAutoPlanHarness();
    const created = await createArchitectPlan({
      branchName,
      planId: 'blank-plan-with-context',
      label: 'new plan',
      projectIds: ['web'],
      contextProjectIds: ['docs'],
      status: 'draft',
      setActive: true,
    });

    const ensured = await ensureProjectGroupPlan({
      branchName,
      scopedProjectIds: ['web', 'api'],
      contextProjectIds: ['docs', 'storybook'],
    });

    expect(ensured).not.toBeNull();
    expect(ensured?.action).toBe('expanded_blank');
    expect(ensured?.plan.id).toBe(created.id);
    expect(ensured?.plan.projectIds).toEqual(['web', 'api']);
    expect(ensured?.plan.contextProjectIds).toEqual(['docs', 'storybook']);
    expect(ensured?.plan.expectedProjectIds).toEqual(['web', 'api', 'docs', 'storybook']);

    const reloaded = await getArchitectPlan(branchName, created.id);
    expect(reloaded?.projectIds).toEqual(['web', 'api']);
    expect(reloaded?.contextProjectIds).toEqual(['docs', 'storybook']);
    expect(reloaded?.expectedProjectIds).toEqual(['web', 'api', 'docs', 'storybook']);
  });

  it('does not expand a plan automatically once it is no longer blank', async () => {
    const { createArchitectPlan, ensureProjectGroupPlan, getArchitectPlan, updateArchitectPlan } =
      createArchitectAutoPlanHarness();
    const created = await createArchitectPlan({
      branchName,
      planId: 'started-plan',
      label: 'new plan',
      projectIds: ['web'],
      status: 'draft',
      setActive: true,
    });

    await updateArchitectPlan({
      branchName,
      planId: created.id,
      description: 'Started planning',
    });

    const ensured = await ensureProjectGroupPlan({
      branchName,
      scopedProjectIds: ['web', 'api'],
    });

    expect(ensured).toBeNull();

    const reloaded = await getArchitectPlan(branchName, created.id);
    expect(reloaded?.projectIds).toEqual(['web']);
    expect(reloaded?.expectedProjectIds).toEqual(['web']);
    expect(reloaded?.label).toBe('new plan');
  });

  it('does not reuse an unscoped legacy blank draft from another selected project scope', async () => {
    const { createArchitectPlan, ensureScopedBlankPlan, listArchitectPlans } = createArchitectAutoPlanHarness();
    await createArchitectPlan({
      branchName,
      planId: 'legacy-unscoped',
      label: 'new plan',
      status: 'draft',
      setActive: true,
    });

    const ensured = await ensureScopedBlankPlan({
      branchName,
      scopedProjectIds: ['web'],
      trigger: 'explicit_create',
    });

    expect(ensured).not.toBeNull();
    expect(ensured?.plan.id).not.toBe('legacy-unscoped');
    expect(ensured?.plan.projectIds).toEqual(['web']);

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans).toHaveLength(2);
  });

  it('does not implicitly resume placeholder blanks when a renamed empty draft is visible in the scope', async () => {
    const { createArchitectPlan, ensureProjectGroupPlan } = createArchitectAutoPlanHarness();
    await createArchitectPlan({
      branchName,
      planId: 'renamed-empty-plan',
      label: 'research scratchpad',
      projectIds: ['web'],
      status: 'draft',
      setActive: true,
    });
    await createArchitectPlan({
      branchName,
      planId: 'blank-plan-newer',
      label: 'new plan 2',
      projectIds: ['web'],
      status: 'draft',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const ensured = await ensureProjectGroupPlan({
      branchName,
      scopedProjectIds: ['web'],
      trigger: 'implicit_resume',
    });

    expect(ensured).toBeNull();
  });

  it('does not implicitly resume a blank draft when a real non-blank plan is visible in the scope', async () => {
    const { createArchitectPlan, ensureProjectGroupPlan, updateArchitectPlan } = createArchitectAutoPlanHarness();
    await createArchitectPlan({
      branchName,
      planId: 'blank-plan',
      label: 'new plan',
      projectIds: ['web'],
      status: 'draft',
      setActive: true,
    });
    const startedPlan = await createArchitectPlan({
      branchName,
      planId: 'started-plan',
      label: 'new plan 2',
      projectIds: ['web'],
      status: 'draft',
    });
    await updateArchitectPlan({
      branchName,
      planId: startedPlan.id,
      description: 'Started planning',
    });

    const ensured = await ensureProjectGroupPlan({
      branchName,
      scopedProjectIds: ['web'],
      trigger: 'implicit_resume',
    });

    expect(ensured).toBeNull();
  });

  it('creates a new explicit placeholder without renaming a started new plan', async () => {
    const { createArchitectPlan, ensureScopedBlankPlan, listArchitectPlans, getArchitectPlan, updateArchitectPlan } =
      createArchitectAutoPlanHarness();
    const created = await createArchitectPlan({
      branchName,
      planId: 'started-plan',
      label: 'new plan',
      projectIds: ['web'],
      status: 'draft',
      setActive: true,
    });

    await updateArchitectPlan({
      branchName,
      planId: created.id,
      description: 'Started planning',
    });

    const ensured = await ensureScopedBlankPlan({
      branchName,
      scopedProjectIds: ['web'],
      trigger: 'explicit_create',
    });

    expect(ensured).not.toBeNull();
    expect(ensured?.action).toBe('created');
    expect(ensured?.plan.id).not.toBe(created.id);
    expect(ensured?.plan.label).toBe('new plan 2');

    const reloadedOriginal = await getArchitectPlan(branchName, created.id);
    expect(reloadedOriginal?.label).toBe('new plan');

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans.map((plan) => plan.label)).toEqual(['new plan', 'new plan 2']);
  });

  it('creates a new placeholder instead of reusing a renamed empty draft during explicit create', async () => {
    const { createArchitectPlan, ensureScopedBlankPlan, listArchitectPlans, getArchitectPlan } =
      createArchitectAutoPlanHarness();
    const created = await createArchitectPlan({
      branchName,
      planId: 'renamed-blank-plan',
      label: 'architecture scratchpad',
      projectIds: ['web'],
      status: 'draft',
      setActive: true,
    });

    const ensured = await ensureScopedBlankPlan({
      branchName,
      scopedProjectIds: ['web'],
      trigger: 'explicit_create',
    });

    expect(ensured).not.toBeNull();
    expect(ensured?.action).toBe('created');
    expect(ensured?.plan.id).not.toBe(created.id);
    expect(ensured?.plan.label).toBe('new plan');

    const reloadedOriginal = await getArchitectPlan(branchName, created.id);
    expect(reloadedOriginal?.label).toBe('architecture scratchpad');

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans).toHaveLength(2);
  });

  it('expands a reusable blank draft during explicit create instead of creating a second plan', async () => {
    const { createArchitectPlan, ensureScopedBlankPlan, listArchitectPlans, getArchitectPlan } =
      createArchitectAutoPlanHarness();
    const created = await createArchitectPlan({
      branchName,
      planId: 'blank-plan-custom-label',
      label: 'new plan',
      projectIds: ['web'],
      contextProjectIds: ['docs'],
      status: 'draft',
      setActive: true,
    });

    const ensured = await ensureScopedBlankPlan({
      branchName,
      scopedProjectIds: ['web', 'api'],
      contextProjectIds: ['docs', 'storybook'],
      trigger: 'explicit_create',
    });

    expect(ensured?.action).toBe('expanded_blank');
    expect(ensured?.plan.id).toBe(created.id);
    expect(ensured?.plan.projectIds).toEqual(['web', 'api']);
    expect(ensured?.plan.expectedProjectIds).toEqual(['web', 'api', 'docs', 'storybook']);
    expect(ensured?.plan.contextProjectIds).toEqual(['docs', 'storybook']);

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans).toHaveLength(1);

    const reloaded = await getArchitectPlan(branchName, created.id);
    expect(reloaded?.projectIds).toEqual(['web', 'api']);
    expect(reloaded?.contextProjectIds).toEqual(['docs', 'storybook']);
  });

  it('reuses an existing blank numbered placeholder as-is during explicit create', async () => {
    const { createArchitectPlan, ensureScopedBlankPlan, listArchitectPlans } = createArchitectAutoPlanHarness();
    const created = await createArchitectPlan({
      branchName,
      planId: 'blank-plan-2',
      label: 'new plan 2',
      projectIds: ['web'],
      status: 'draft',
      setActive: true,
    });

    const ensured = await ensureScopedBlankPlan({
      branchName,
      scopedProjectIds: ['web'],
      trigger: 'explicit_create',
    });

    expect(ensured?.action).toBe('reused_blank');
    expect(ensured?.plan.id).toBe(created.id);
    expect(ensured?.plan.label).toBe('new plan 2');

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans).toHaveLength(1);
    expect(listed.plans[0]?.label).toBe('new plan 2');
  });

  it('prefers the active blank draft over newer blank duplicates during explicit create', async () => {
    const { createArchitectPlan, ensureScopedBlankPlan, listArchitectPlans } = createArchitectAutoPlanHarness();
    const activeBlank = await createArchitectPlan({
      branchName,
      planId: 'blank-plan-active',
      label: 'new plan',
      projectIds: ['web'],
      status: 'draft',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      setActive: true,
    });
    await createArchitectPlan({
      branchName,
      planId: 'blank-plan-newer',
      label: 'new plan 2',
      projectIds: ['web'],
      status: 'draft',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const ensured = await ensureScopedBlankPlan({
      branchName,
      scopedProjectIds: ['web'],
      trigger: 'explicit_create',
    });

    expect(ensured?.action).toBe('reused_blank');
    expect(ensured?.plan.id).toBe(activeBlank.id);

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans).toHaveLength(1);
    expect(listed.plans[0]?.id).toBe(activeBlank.id);
  });

  it('falls back to the most recent blank draft when no active blank is set', async () => {
    const { createArchitectPlan, ensureScopedBlankPlan, listArchitectPlans } = createArchitectAutoPlanHarness();
    await createArchitectPlan({
      branchName,
      planId: 'blank-plan-older',
      label: 'new plan',
      projectIds: ['web'],
      status: 'draft',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const newerBlank = await createArchitectPlan({
      branchName,
      planId: 'blank-plan-newer',
      label: 'new plan 2',
      projectIds: ['web'],
      status: 'draft',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    });

    const ensured = await ensureScopedBlankPlan({
      branchName,
      scopedProjectIds: ['web'],
      trigger: 'explicit_create',
    });

    expect(ensured?.action).toBe('reused_blank');
    expect(ensured?.plan.id).toBe(newerBlank.id);

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans).toHaveLength(1);
    expect(listed.plans[0]?.id).toBe(newerBlank.id);
  });

  it('hard-deletes duplicate blank placeholders that share the same scope', async () => {
    const { consolidateScopedBlankPlans, createArchitectPlan, listArchitectPlans } =
      createArchitectAutoPlanHarness();
    await createArchitectPlan({
      branchName,
      planId: 'blank-plan-older',
      label: 'new plan',
      projectIds: ['web'],
      status: 'draft',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const winner = await createArchitectPlan({
      branchName,
      planId: 'blank-plan-newer',
      label: 'new plan 2',
      projectIds: ['web'],
      status: 'draft',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    });

    const result = await consolidateScopedBlankPlans({
      branchName,
      scopedProjectIds: ['web'],
    });

    expect(result.deletedPlanIds).toEqual(['blank-plan-older']);

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans).toHaveLength(1);
    expect(listed.plans[0]?.id).toBe(winner.id);
  });

  it('returns new plan 2 as the next numbered placeholder after a single base label', () => {
    expect(getNextDefaultNewPlanLabel([{ label: 'new plan' } as Pick<ArchitectPlanSummary, 'label'>])).toBe(
      'new plan 2'
    );
  });
});
