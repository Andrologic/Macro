import { describe, expect, it } from 'bun:test';
import type { ArchitectPlanSummary } from '../../services/architectPlanService';
import { computePlanSelectorRefreshState } from './planSelectorState';

const buildPlanSummary = (
  overrides: Partial<ArchitectPlanSummary> & Pick<ArchitectPlanSummary, 'id'>
): ArchitectPlanSummary => ({
  id: overrides.id,
  slug: overrides.slug ?? overrides.id,
  title: overrides.title ?? overrides.id,
  description: overrides.description ?? '',
  status: overrides.status ?? 'draft',
  targetBranch: overrides.targetBranch ?? 'develop',
  projectId: overrides.projectId ?? 'web',
  projectIds: overrides.projectIds ?? ['web'],
  createdAt: overrides.createdAt ?? '2026-03-19T10:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-03-19T10:00:00.000Z',
  nodeCount: overrides.nodeCount ?? 0,
  conversationId: overrides.conversationId,
  label: overrides.label,
  expectedProjectIds: overrides.expectedProjectIds,
  availableProjectIds: overrides.availableProjectIds,
  missingProjectIds: overrides.missingProjectIds,
  replicationState: overrides.replicationState,
  revision: overrides.revision,
  replicas: overrides.replicas,
  hasReplicaDivergence: overrides.hasReplicaDivergence,
});

describe('planSelectorState', () => {
  it('removes a deleted plan from the visible list and selects the next visible plan', () => {
    const refreshState = computePlanSelectorRefreshState({
      plans: [
        buildPlanSummary({ id: 'plan-a', status: 'deleted' }),
        buildPlanSummary({ id: 'plan-b', status: 'draft', updatedAt: '2026-03-19T11:00:00.000Z' }),
      ],
      scopedProjectIds: ['web'],
      showArchived: false,
      preferredActivePlanId: 'plan-a',
      mutation: {
        type: 'delete',
        planId: 'plan-a',
      },
    });

    expect(refreshState.mutationApplied).toBe(true);
    expect(refreshState.visiblePlans.map((plan) => plan.id)).toEqual(['plan-b']);
    expect(refreshState.nextActivePlanId).toBe('plan-b');
  });

  it('removes an archived plan from the default view and selects the next active plan', () => {
    const refreshState = computePlanSelectorRefreshState({
      plans: [
        buildPlanSummary({ id: 'plan-a', status: 'archived' }),
        buildPlanSummary({ id: 'plan-b', status: 'validated' }),
      ],
      scopedProjectIds: ['web'],
      showArchived: false,
      preferredActivePlanId: 'plan-a',
      mutation: {
        type: 'archive',
        planId: 'plan-a',
      },
    });

    expect(refreshState.mutationApplied).toBe(true);
    expect(refreshState.visiblePlans.map((plan) => plan.id)).toEqual(['plan-b']);
    expect(refreshState.nextActivePlanId).toBe('plan-b');
  });

  it('keeps archived view focused on archived plans only', () => {
    const refreshState = computePlanSelectorRefreshState({
      plans: [
        buildPlanSummary({ id: 'plan-a', status: 'archived' }),
        buildPlanSummary({ id: 'plan-b', status: 'validated' }),
      ],
      scopedProjectIds: ['web'],
      showArchived: true,
      preferredActivePlanId: 'plan-a',
      mutation: {
        type: 'archive',
        planId: 'plan-a',
      },
    });

    expect(refreshState.visiblePlans.map((plan) => plan.id)).toEqual(['plan-a']);
    expect(refreshState.nextActivePlanId).toBe('plan-a');
  });

  it('treats an absent target plan as a completed delete mutation', () => {
    const refreshState = computePlanSelectorRefreshState({
      plans: [
        buildPlanSummary({ id: 'plan-b', status: 'validated' }),
      ],
      scopedProjectIds: ['web'],
      showArchived: false,
      preferredActivePlanId: 'plan-a',
      mutation: {
        type: 'delete',
        planId: 'plan-a',
      },
    });

    expect(refreshState.targetPlan).toBeNull();
    expect(refreshState.mutationApplied).toBe(true);
    expect(refreshState.nextActivePlanId).toBe('plan-b');
  });
});
