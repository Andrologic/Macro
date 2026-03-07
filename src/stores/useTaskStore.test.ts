import { describe, expect, it } from 'bun:test';

const { clearPlanRuntimeStateSnapshot } = await import('./planRuntimeState');

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
