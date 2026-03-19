import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createArchitectPlan,
  getArchitectPlan,
  listArchitectPlans,
  updateArchitectPlan,
} from './architectPlanService';
import { ensureProjectGroupPlan } from './architectAutoPlan';

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

describe('architectAutoPlan', () => {
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

  it('creates and activates a default blank plan when none exists for the scope', async () => {
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

  it('does not expand a plan automatically once it is no longer blank', async () => {
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
