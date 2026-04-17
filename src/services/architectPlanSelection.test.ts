import { describe, expect, it } from 'bun:test';
import {
  compareArchitectPlanSelectionPriority,
  computeArchitectPlanResolutionState,
} from './architectPlanSelection';
import type { ArchitectPlanStatus } from './architectPlanService';
import { computePlanSelectorRefreshState } from '../components/architect/planSelectorState';

const buildPlanSummary = (overrides: Partial<{
  id: string;
  status: ArchitectPlanStatus;
  projectId: string;
  projectIds: string[];
  expectedProjectIds: string[];
  createdAt: string;
  updatedAt: string;
}> = {}) => ({
  id: overrides.id ?? 'plan-1',
  slug: overrides.id ?? 'plan-1',
  title: overrides.id ?? 'plan-1',
  label: overrides.id ?? 'plan-1',
  description: '',
  status: overrides.status ?? 'draft',
  projectId: overrides.projectId ?? 'project-1',
  projectIds: overrides.projectIds ?? [overrides.projectId ?? 'project-1'],
  expectedProjectIds:
    overrides.expectedProjectIds ??
    overrides.projectIds ??
    [overrides.projectId ?? 'project-1'],
  nodeCount: 0,
  createdAt: overrides.createdAt ?? '2026-04-17T09:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-04-17T10:00:00.000Z',
  targetBranch: 'develop',
});

describe('architectPlanSelection', () => {
  it('prefers the current visible plan before the remembered or newest visible plan', () => {
    const currentPlan = buildPlanSummary({
      id: 'plan-current',
      updatedAt: '2026-04-17T08:00:00.000Z',
    });
    const rememberedPlan = buildPlanSummary({
      id: 'plan-remembered',
      updatedAt: '2026-04-17T11:00:00.000Z',
    });

    const resolution = computeArchitectPlanResolutionState({
      plans: [rememberedPlan, currentPlan],
      scopedProjectIds: ['project-1'],
      currentActivePlanId: 'plan-current',
      rememberedPlanId: 'plan-remembered',
    });

    expect(resolution.visiblePlans.map((plan) => plan.id)).toEqual([
      'plan-remembered',
      'plan-current',
    ]);
    expect(resolution.nextActivePlanId).toBe('plan-current');
  });

  it('falls back to the remembered visible plan before the newest visible plan', () => {
    const rememberedPlan = buildPlanSummary({
      id: 'plan-remembered',
      updatedAt: '2026-04-17T09:00:00.000Z',
    });
    const newestPlan = buildPlanSummary({
      id: 'plan-newest',
      updatedAt: '2026-04-17T12:00:00.000Z',
    });

    const resolution = computeArchitectPlanResolutionState({
      plans: [newestPlan, rememberedPlan],
      scopedProjectIds: ['project-1'],
      currentActivePlanId: 'plan-out-of-scope',
      rememberedPlanId: 'plan-remembered',
    });

    expect(resolution.nextActivePlanId).toBe('plan-remembered');
  });

  it('ignores archived and deleted plans and aligns with the selector refresh state once resolved', () => {
    const hiddenArchived = buildPlanSummary({
      id: 'plan-archived',
      status: 'archived',
      updatedAt: '2026-04-17T13:00:00.000Z',
    });
    const visibleNewest = buildPlanSummary({
      id: 'plan-visible',
      updatedAt: '2026-04-17T12:00:00.000Z',
    });
    const visibleOlder = buildPlanSummary({
      id: 'plan-older',
      updatedAt: '2026-04-17T10:00:00.000Z',
    });

    const resolution = computeArchitectPlanResolutionState({
      plans: [hiddenArchived, visibleOlder, visibleNewest],
      scopedProjectIds: ['project-1'],
      rememberedPlanId: 'plan-archived',
    });

    expect(resolution.visiblePlans.map((plan) => plan.id)).toEqual([
      'plan-visible',
      'plan-older',
    ]);
    expect(resolution.nextActivePlanId).toBe('plan-visible');

    const selectorState = computePlanSelectorRefreshState({
      plans: [hiddenArchived, visibleOlder, visibleNewest],
      scopedProjectIds: ['project-1'],
      showArchived: false,
      preferredActivePlanId: resolution.nextActivePlanId,
      currentActivePlanId: resolution.nextActivePlanId,
    });

    expect(selectorState.nextActivePlanId).toBe(resolution.nextActivePlanId);
    expect(
      compareArchitectPlanSelectionPriority(visibleNewest, visibleOlder),
    ).toBeLessThan(0);
  });
});
