import { describe, expect, it } from 'bun:test';
import type { ArchitectPlanSummary } from '../../services/architectPlanService';
import {
  computePlanSelectorEmptyState,
  computePlanSelectorRefreshState,
  resolveVerifiedPlanDeletionRecovery,
} from './planSelectorState';

const buildPlanSummary = (
  overrides: Partial<ArchitectPlanSummary> & Pick<ArchitectPlanSummary, 'id'>
): ArchitectPlanSummary => ({
  id: overrides.id,
  slug: overrides.slug ?? overrides.id,
  title: overrides.title ?? overrides.id,
  description: overrides.description ?? '',
  status: overrides.status ?? 'draft',
  targetBranch: overrides.targetBranch ?? 'develop',
  projectId: 'projectId' in overrides ? overrides.projectId : 'web',
  projectIds: 'projectIds' in overrides ? overrides.projectIds : ['web'],
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
  it('recognizes verified deletion success while warning only for pending linked conversation cleanup', () => {
    expect(resolveVerifiedPlanDeletionRecovery({
      mutationApplied: true,
      linkedConversationCleanupPending: true,
    })).toBe('conversation_cleanup_pending');
    expect(resolveVerifiedPlanDeletionRecovery({
      mutationApplied: true,
      linkedConversationCleanupPending: false,
    })).toBe('succeeded');
    expect(resolveVerifiedPlanDeletionRecovery({
      mutationApplied: false,
      linkedConversationCleanupPending: true,
    })).toBe('not_applied');
  });

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

  it('falls back to the most recently updated visible plan when no preferred plan is available', () => {
    const refreshState = computePlanSelectorRefreshState({
      plans: [
        buildPlanSummary({ id: 'plan-a', status: 'validated', updatedAt: '2026-03-19T09:00:00.000Z' }),
        buildPlanSummary({ id: 'plan-b', status: 'draft', updatedAt: '2026-03-19T12:00:00.000Z' }),
        buildPlanSummary({ id: 'plan-c', status: 'draft', updatedAt: '2026-03-19T11:00:00.000Z' }),
      ],
      scopedProjectIds: ['web'],
      showArchived: false,
      preferredActivePlanId: 'missing-plan',
    });

    expect(refreshState.visiblePlans.map((plan) => plan.id)).toEqual(['plan-b', 'plan-c', 'plan-a']);
    expect(refreshState.nextActivePlanId).toBe('plan-b');
  });

  it('hides unscoped legacy plans when a project scope is selected', () => {
    const refreshState = computePlanSelectorRefreshState({
      plans: [
        buildPlanSummary({ id: 'legacy-unscoped', projectId: undefined, projectIds: [], expectedProjectIds: [] }),
        buildPlanSummary({ id: 'scoped-plan', projectIds: ['web'], expectedProjectIds: ['web'] }),
      ],
      scopedProjectIds: ['web'],
      showArchived: false,
      preferredActivePlanId: 'legacy-unscoped',
    });

    expect(refreshState.visiblePlans.map((plan) => plan.id)).toEqual(['scoped-plan']);
    expect(refreshState.nextActivePlanId).toBe('scoped-plan');
  });

  it('keeps unscoped legacy plans visible only when there is no selected project scope', () => {
    const refreshState = computePlanSelectorRefreshState({
      plans: [
        buildPlanSummary({ id: 'legacy-unscoped', projectId: undefined, projectIds: [], expectedProjectIds: [] }),
      ],
      scopedProjectIds: [],
      showArchived: false,
      preferredActivePlanId: 'legacy-unscoped',
    });

    expect(refreshState.visiblePlans.map((plan) => plan.id)).toEqual(['legacy-unscoped']);
    expect(refreshState.nextActivePlanId).toBe('legacy-unscoped');
  });

  it('does not show the outside-scope empty state for a stale catalog scope', () => {
    expect(
      computePlanSelectorEmptyState({
        hasError: false,
        isLoading: false,
        hasLoadedPlans: true,
        isWorkspaceMissing: false,
        isReadOnlyOnlyScope: false,
        displayedPlanCount: 0,
        catalogStatus: 'ready',
        isCatalogForCurrentScope: false,
        catalogModernPlanCount: 2,
        catalogVisiblePlanCount: 0,
      })
    ).toBe('hidden');
  });

  it('does not show an empty state when the current catalog has visible plans', () => {
    expect(
      computePlanSelectorEmptyState({
        hasError: false,
        isLoading: false,
        hasLoadedPlans: true,
        isWorkspaceMissing: false,
        isReadOnlyOnlyScope: false,
        displayedPlanCount: 0,
        catalogStatus: 'ready',
        isCatalogForCurrentScope: true,
        catalogModernPlanCount: 2,
        catalogVisiblePlanCount: 1,
      })
    ).toBe('hidden');
  });

  it('shows the outside-scope empty state only for the current loaded catalog', () => {
    expect(
      computePlanSelectorEmptyState({
        hasError: false,
        isLoading: false,
        hasLoadedPlans: true,
        isWorkspaceMissing: false,
        isReadOnlyOnlyScope: false,
        displayedPlanCount: 0,
        catalogStatus: 'ready',
        isCatalogForCurrentScope: true,
        catalogModernPlanCount: 2,
        catalogVisiblePlanCount: 0,
      })
    ).toBe('outside-scope');
  });

  it('shows the regular empty state when the current loaded catalog has no plans', () => {
    expect(
      computePlanSelectorEmptyState({
        hasError: false,
        isLoading: false,
        hasLoadedPlans: true,
        isWorkspaceMissing: false,
        isReadOnlyOnlyScope: false,
        displayedPlanCount: 0,
        catalogStatus: 'ready',
        isCatalogForCurrentScope: true,
        catalogModernPlanCount: 0,
        catalogVisiblePlanCount: 0,
      })
    ).toBe('empty');
  });
});
