import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ArchitectPlanRecord, ArchitectPlanSummary } from './architectPlanService';
import {
  archiveArchitectPlan,
  createArchitectPlan,
  getArchitectPlan,
  listArchitectPlans,
  toPlanIntegrationBranch,
  updateArchitectPlan,
} from './architectPlanService';

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

const seedLegacyPlan = (storage: LocalStorageMock, plan: ArchitectPlanRecord) => {
  const summary: ArchitectPlanSummary = {
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
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    nodeCount: plan.nodes.length,
  };

  storage.setItem(
    `macro_architect_plan_index:${branchName}`,
    JSON.stringify({
      version: 2,
      activePlanId: plan.id,
      plans: [summary],
      reservedPlanSlugs: [plan.slug],
    })
  );
  storage.setItem(
    `macro_architect_plan:${branchName}:${plan.id}`,
    JSON.stringify(plan)
  );
};

describe('architectPlanService', () => {
  let storage: LocalStorageMock;

  beforeEach(() => {
    storage = createLocalStorageMock();
    (globalThis as { window?: unknown }).window = {
      localStorage: storage,
    };
    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('creates canonical plans without requiring a title and allows duplicate labels', async () => {
    const created = await createArchitectPlan({
      branchName,
      planId: '1710000000000',
    });

    expect(created.id).toBe('1710000000000');
    expect(created.slug).toBe('1710000000000');
    expect(created.title).toBe('1710000000000');
    expect(created.label).toBeUndefined();

    const firstLabeled = await createArchitectPlan({
      branchName,
      planId: '1710000000001',
      title: 'Checkout refresh',
    });
    const secondLabeled = await createArchitectPlan({
      branchName,
      planId: '1710000000002',
      label: 'Checkout refresh',
    });

    expect(firstLabeled.title).toBe('1710000000001');
    expect(firstLabeled.label).toBe('Checkout refresh');
    expect(secondLabeled.title).toBe('1710000000002');
    expect(secondLabeled.label).toBe('Checkout refresh');

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans.map((plan) => plan.id)).toEqual([
      '1710000000000',
      '1710000000001',
      '1710000000002',
    ]);
  });

  it('treats title updates as label updates for canonical plans', async () => {
    const created = await createArchitectPlan({
      branchName,
      planId: '1710000000010',
      title: 'Initial label',
    });

    const updated = await updateArchitectPlan({
      branchName,
      planId: created.id,
      title: 'Renamed label',
    });

    expect(updated.id).toBe('1710000000010');
    expect(updated.slug).toBe('1710000000010');
    expect(updated.title).toBe('1710000000010');
    expect(updated.label).toBe('Renamed label');

    const cleared = await updateArchitectPlan({
      branchName,
      planId: created.id,
      label: '',
    });

    expect(cleared.title).toBe('1710000000010');
    expect(cleared.slug).toBe('1710000000010');
    expect(cleared.label).toBeUndefined();
  });

  it('refuses to archive canonical plans still named new plan', async () => {
    const created = await createArchitectPlan({
      branchName,
      planId: '1710000000011',
      label: 'new plan',
    });

    await expect(archiveArchitectPlan(branchName, created.id)).rejects.toThrow(
      'Rename the plan before archiving it.'
    );

    const reloaded = await getArchitectPlan(branchName, created.id);
    expect(reloaded?.status).toBe('draft');

    await expect(
      updateArchitectPlan({
        branchName,
        planId: created.id,
        status: 'archived',
      })
    ).rejects.toThrow('Rename the plan before archiving it.');
  });

  it('allows explicitly expanding expected project ids on update', async () => {
    const created = await createArchitectPlan({
      branchName,
      planId: '1710000000012',
      projectIds: ['web'],
    });

    const updated = await updateArchitectPlan({
      branchName,
      planId: created.id,
      projectIds: ['web', 'api'],
      expectedProjectIds: ['web', 'api'],
    });

    expect(updated.projectIds).toEqual(['web', 'api']);
    expect(updated.expectedProjectIds).toEqual(['web', 'api']);

    const reloaded = await getArchitectPlan(branchName, created.id);
    expect(reloaded?.projectIds).toEqual(['web', 'api']);
    expect(reloaded?.expectedProjectIds).toEqual(['web', 'api']);
  });

  it('preserves legacy title rename behavior and uses stored slugs for branch naming', async () => {
    const legacyPlan: ArchitectPlanRecord = {
      id: 'legacy-plan',
      slug: 'checkout',
      title: 'Checkout',
      description: 'Legacy plan',
      status: 'validated',
      targetBranch: branchName,
      projectId: 'web',
      projectIds: ['web'],
      createdAt: '2026-03-15T00:00:00.000Z',
      updatedAt: '2026-03-15T00:00:00.000Z',
      nodes: [],
      predictedBranches: [],
    };

    seedLegacyPlan(storage, legacyPlan);

    const canonicalPlan = await createArchitectPlan({
      branchName,
      planId: '1710000000020',
      title: 'Checkout',
    });

    const loadedLegacyPlan = await getArchitectPlan(branchName, legacyPlan.id);
    expect(loadedLegacyPlan).not.toBeNull();
    expect(loadedLegacyPlan?.slug).toBe('checkout');
    expect(loadedLegacyPlan?.title).toBe('Checkout');

    const renamedLegacyPlan = await updateArchitectPlan({
      branchName,
      planId: legacyPlan.id,
      title: 'Checkout v2',
    });

    expect(renamedLegacyPlan.slug).toBe('checkout');
    expect(renamedLegacyPlan.title).toBe('Checkout v2');
    expect(toPlanIntegrationBranch(renamedLegacyPlan.slug)).toBe('plan/checkout');
    expect(toPlanIntegrationBranch(canonicalPlan.slug)).toBe('plan/1710000000020');

    const listed = await listArchitectPlans(branchName, true, true);
    expect(listed.plans.find((plan) => plan.id === legacyPlan.id)?.slug).toBe('checkout');
    expect(listed.plans.find((plan) => plan.id === canonicalPlan.id)?.slug).toBe('1710000000020');
  });
});
