import { describe, expect, it } from 'bun:test';
import {
  buildPlanFinalizationFailureState,
  buildPlanFinalizationRefreshState,
  buildPlanFinalizationSuccessState,
  toBlockedPlanFinalizationState,
} from './taskStorePlanFinalizationState';
import { getAutoLaunchCandidateTask, type ImplementTask } from './useTaskStore';

const { clearPlanRuntimeStateSnapshot } = await import('./planRuntimeState');

const blockedRepository = {
  id: 'api::/repos/api',
  projectId: 'api',
  repoPath: '/repos/api',
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
  blockingReason: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
};

const createBlockedFinalizationError = () =>
  Object.assign(new Error(blockedRepository.blockingReason), {
    name: 'PlanFinalizationBlockedError',
    planId: 'plan-1',
    branchName: 'develop',
    repositories: [blockedRepository],
    blockedRepositories: [blockedRepository],
  });

describe('clearPlanRuntimeStateSnapshot', () => {
  it('removes deleted worktrees and clears active plan runtime when the active plan is cleaned up', () => {
    const result = clearPlanRuntimeStateSnapshot({
      currentState: {
        branchWorktrees: {
          'web::feature-checkout': '/repos/web/.macro/worktrees/taskweb::feature-checkout',
          'api::feature-checkout': '/repos/api/.macro/worktrees/taskapi::feature-checkout',
        },
        activeBranchName: 'feature/checkout',
        activeRepositoryPath: '/repos/web/.macro/worktrees/taskweb::feature-checkout',
      },
      activePlanId: 'plan-1',
      planId: 'plan-1',
      deletedWorktreeKeys: ['web::feature-checkout'],
    });

    expect(result.branchWorktrees).toEqual({
      'api::feature-checkout': '/repos/api/.macro/worktrees/taskapi::feature-checkout',
    });
    expect(result.activeBranchName).toBeNull();
    expect(result.activeRepositoryPath).toBeNull();
    expect(result.shouldClearActivePlan).toBe(true);
    expect(result.shouldSyncWorkspaceRoot).toBe(true);
  });

  it('preserves unrelated active plan state when only other worktrees are removed', () => {
    const result = clearPlanRuntimeStateSnapshot({
      currentState: {
        branchWorktrees: {
          'web::feature-checkout': '/repos/web/.macro/worktrees/taskweb::feature-checkout',
          'api::feature-checkout': '/repos/api/.macro/worktrees/taskapi::feature-checkout',
        },
        activeBranchName: 'feature/checkout',
        activeRepositoryPath: '/repos/web/.macro/worktrees/taskweb::feature-checkout',
      },
      activePlanId: 'plan-1',
      planId: 'plan-2',
      deletedWorktreeKeys: ['api::feature-checkout'],
    });

    expect(result.branchWorktrees).toEqual({
      'web::feature-checkout': '/repos/web/.macro/worktrees/taskweb::feature-checkout',
    });
    expect(result.activeBranchName).toBe('feature/checkout');
    expect(result.activeRepositoryPath).toBe('/repos/web/.macro/worktrees/taskweb::feature-checkout');
    expect(result.shouldClearActivePlan).toBe(false);
    expect(result.shouldSyncWorkspaceRoot).toBe(false);
  });
});

describe('taskStorePlanFinalizationState', () => {
  it('maps a blocked finalization error into typed store state', () => {
    expect(toBlockedPlanFinalizationState(createBlockedFinalizationError())).toEqual({
      planId: 'plan-1',
      branchName: 'develop',
      message: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
      repositories: [blockedRepository],
      blockedRepositories: [blockedRepository],
    });
  });

  it('builds failure state with blocker diagnostics', () => {
    expect(buildPlanFinalizationFailureState(createBlockedFinalizationError())).toEqual({
      finalizingPlanId: null,
      blockedPlanFinalization: {
        planId: 'plan-1',
        branchName: 'develop',
        message: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
        repositories: [blockedRepository],
        blockedRepositories: [blockedRepository],
      },
      lastError: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
    });
  });

  it('clears blocker state on refresh and explicit retry success', () => {
    expect(buildPlanFinalizationRefreshState()).toEqual({
      blockedPlanFinalization: null,
      lastError: null,
    });
    expect(buildPlanFinalizationSuccessState()).toEqual({
      finalizingPlanId: null,
      blockedPlanFinalization: null,
      lastError: null,
    });
  });
});

const buildTask = (overrides: Partial<ImplementTask> = {}): ImplementTask => ({
  id: 'task-1',
  plan_id: 'plan-1',
  project_id: 'project-1',
  project_ids: ['project-1'],
  title: 'Task 1',
  description: 'Task description',
  status: 'Pending',
  dependencies: [],
  estimated_changes: [],
  assigned_branch: 'feature/plan-1/task-1',
  branch_name: 'feature/plan-1/task-1',
  branch_id: null,
  branch_task_index: 0,
  blocked_by_task_ids: [],
  blocked_by: [],
  is_blocked: false,
  is_ready: true,
  sequence_index: 0,
  execution_targets: [],
  task_source: 'architect',
  plan_title: 'Plan 1',
  plan_status: 'validated',
  plan_target_branch: 'develop',
  draft: false,
  standalone_kind: 'legacy',
  base_branch: null,
  feature_slug: null,
  conversation_id: null,
  ...overrides,
});

describe('getAutoLaunchCandidateTask', () => {
  it('returns the first eligible task for the plan using task queue ordering', () => {
    const candidate = getAutoLaunchCandidateTask([
      buildTask({ id: 'completed', status: 'Completed', sequence_index: 0 }),
      buildTask({ id: 'failed', status: 'Failed', sequence_index: 1 }),
      buildTask({ id: 'in-progress', status: 'InProgress', sequence_index: 4 }),
      buildTask({ id: 'pending', status: 'Pending', sequence_index: 2 }),
    ], 'plan-1');

    expect(candidate?.id).toBe('in-progress');
  });

  it('prefers tasks inside the current scope and ignores in-review or draft tasks', () => {
    const candidate = getAutoLaunchCandidateTask([
      buildTask({ id: 'other-project', project_id: 'project-2', project_ids: ['project-2'], sequence_index: 0 }),
      buildTask({ id: 'draft', draft: true, sequence_index: 1 }),
      buildTask({ id: 'review', status: 'InReview', sequence_index: 2 }),
      buildTask({ id: 'scoped', sequence_index: 3 }),
    ], 'plan-1', ['project-1']);

    expect(candidate?.id).toBe('scoped');
  });
});
