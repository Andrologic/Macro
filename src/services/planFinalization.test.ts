import { describe, expect, it } from 'bun:test';
import {
  buildPlanFinalizationFailureState,
  resolvePlanFinalizationTaskStatus,
  resolvePlanFinalizationViewState,
  shouldCreatePlanFinalizationTask,
  shouldIncludeTaskInImplementationProgress,
} from './planFinalization';

const blockedRepository = {
  id: 'web::/repos/web',
  projectId: 'web',
  repoPath: '/repos/web',
  planBranchName: 'plan/checkout',
  baseBranchName: 'develop',
  isClean: false,
  hasChanges: true,
  mergeable: false,
  conflictFiles: ['src/conflict.ts'],
  mergeInProgress: true,
  diff: 'diff --git a/src/conflict.ts b/src/conflict.ts',
  checkStatus: 'not_run' as const,
  blockingKind: 'merge_conflict' as const,
  nextAction: 'resolve_conflicts' as const,
  blockingReason: 'Conflict detected in /repos/web.',
};

describe('planFinalization', () => {
  it('creates the synthetic finalization task only when the plan is fully completed', () => {
    expect(
      shouldCreatePlanFinalizationTask({
        planStatus: 'in_progress',
        taskCount: 2,
        completedTaskCount: 2,
      })
    ).toBe(true);

    expect(
      shouldCreatePlanFinalizationTask({
        planStatus: 'in_progress',
        taskCount: 2,
        completedTaskCount: 1,
      })
    ).toBe(false);

    expect(
      shouldCreatePlanFinalizationTask({
        planStatus: 'archived',
        taskCount: 2,
        completedTaskCount: 2,
      })
    ).toBe(false);
  });

  it('excludes synthetic finalization tasks from implementation progress', () => {
    expect(
      shouldIncludeTaskInImplementationProgress({
        draft: false,
        archived_at: null,
        task_source: 'architect',
      })
    ).toBe(true);

    expect(
      shouldIncludeTaskInImplementationProgress({
        draft: false,
        archived_at: null,
        task_source: 'plan_finalization',
      })
    ).toBe(false);

    expect(
      shouldIncludeTaskInImplementationProgress({
        draft: true,
        archived_at: null,
        task_source: 'standalone',
      })
    ).toBe(false);
  });

  it('maps phases to task statuses and footer capabilities consistently', () => {
    expect(resolvePlanFinalizationTaskStatus('ready')).toBe('Pending');
    expect(resolvePlanFinalizationTaskStatus('blocked')).toBe('Blocked');
    expect(resolvePlanFinalizationTaskStatus('merging')).toBe('InProgress');
    expect(resolvePlanFinalizationTaskStatus('failed')).toBe('Failed');

    expect(
      resolvePlanFinalizationViewState({
        planId: 'plan-1',
        branchName: 'develop',
        phase: 'blocked',
        taskStatus: 'Blocked',
        review: null,
        repositories: [blockedRepository],
        blockedRepositories: [blockedRepository],
        message: 'Blocked',
        lastLoadedAt: '2026-04-22T10:00:00.000Z',
      })
    ).toMatchObject({
      isBlocked: true,
      canMerge: false,
      canRetry: true,
      canResolveAutomatically: true,
      canArchive: true,
    });

    expect(
      resolvePlanFinalizationViewState({
        planId: 'plan-1',
        branchName: 'develop',
        phase: 'merging',
        taskStatus: 'InProgress',
        review: null,
        repositories: [],
        blockedRepositories: [],
        message: null,
        lastLoadedAt: '2026-04-22T10:00:00.000Z',
      })
    ).toMatchObject({
      isMerging: true,
      isBusy: true,
      canMerge: false,
      canArchive: false,
    });
  });

  it('preserves blocker diagnostics when building a failure state', () => {
    const error = Object.assign(new Error('Conflict detected in /repos/web.'), {
      name: 'PlanFinalizationBlockedError',
      planId: 'plan-1',
      branchName: 'develop',
      repositories: [blockedRepository],
      blockedRepositories: [blockedRepository],
    });

    expect(buildPlanFinalizationFailureState(error)).toEqual({
      lastError: 'Conflict detected in /repos/web.',
      runtimePatch: {
        phase: 'blocked',
        taskStatus: 'Blocked',
        repositories: [blockedRepository],
        blockedRepositories: [blockedRepository],
        message: 'Conflict detected in /repos/web.',
        lastLoadedAt: expect.any(String),
      },
    });
  });
});
