import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  DEFAULT_NEW_PLAN_LABEL,
  getArchitectPlanEditableName,
  getNextDefaultNewPlanLabel,
  isCanonicalArchitectPlan,
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
    status?: ArchitectPlanRecord['status'];
    setActive?: boolean;
  }) => {
    const id = params.planId ?? `plan-${plans.size + 1}`;
    const now = new Date().toISOString();
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
      expectedProjectIds: projectIds.length > 0 ? [...projectIds] : undefined,
      createdAt: now,
      updatedAt: now,
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
        : existing.expectedProjectIds
          ? [...existing.expectedProjectIds]
          : existing.projectIds
            ? [...existing.projectIds]
            : undefined,
      updatedAt: new Date().toISOString(),
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
  const getArchitectPlanProjectIds = (plan: Pick<ArchitectPlanSummary, 'projectId' | 'projectIds'>) =>
    Array.from(new Set([plan.projectId, ...(plan.projectIds ?? [])].filter(Boolean))) as string[];

  return {
    createArchitectPlan,
    getArchitectPlan,
    listArchitectPlans,
    updateArchitectPlan,
    ensureProjectGroupPlan: createArchitectAutoPlanService({
      DEFAULT_NEW_PLAN_LABEL,
      createArchitectPlan,
      getArchitectPlan,
      getArchitectPlanChatMessages,
      getArchitectPlanEditableName,
      getArchitectPlanNeeds,
      getArchitectPlanProjectIds,
      getNextDefaultNewPlanLabel,
      isCanonicalArchitectPlan,
      isDefaultNewPlanBaseLabel,
      listArchitectPlans,
      setActiveArchitectPlan,
      updateArchitectPlan,
    }).ensureProjectGroupPlan,
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

    const reloaded = await getArchitectPlan(branchName, created.id);
    expect(reloaded?.projectIds).toEqual(['web', 'api']);
    expect(reloaded?.contextProjectIds).toEqual(['docs', 'storybook']);
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
  });
});
