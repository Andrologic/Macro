import { describe, expect, it } from 'bun:test';
import { resolveMergeWorkflowActivationContext } from './mergeWorkflowRuntime';

describe('resolveMergeWorkflowActivationContext', () => {
  const task = {
    assigned_branch: 'plan/mixed-plan',
    plan_target_branch: 'develop',
    execution_targets: [
      {
        projectId: 'docs',
        repoPath: '/repos/docs',
        branchName: '',
        targetBranchName: '',
        executionMode: 'direct' as const,
        worktreeKey: 'docs::direct',
      },
      {
        projectId: 'api',
        repoPath: '/repos/api',
        branchName: 'feature/api-task',
        targetBranchName: 'develop',
        executionMode: 'git' as const,
        worktreeKey: 'api::feature/api-task',
      },
    ],
  };

  it('does not fall back to a task-level branch when a mixed plan focuses a direct target', () => {
    expect(resolveMergeWorkflowActivationContext({
      task,
      preferredProjectId: 'docs',
      resolveRepoPath: (_projectId, repoPath) => repoPath ?? null,
    })).toEqual({
      repoPath: '/repos/docs',
      branchName: null,
    });
  });

  it('keeps the target branch when the same mixed plan focuses a Git target', () => {
    expect(resolveMergeWorkflowActivationContext({
      task,
      preferredProjectId: 'api',
      resolveRepoPath: (_projectId, repoPath) => repoPath ?? null,
    })).toEqual({
      repoPath: '/repos/api',
      branchName: 'develop',
    });
  });

  it('does not restore a branch for a legacy direct checkpoint without executionMode', () => {
    expect(resolveMergeWorkflowActivationContext({
      task: {
        assigned_branch: 'plan/legacy-plan',
        plan_target_branch: 'develop',
        execution_targets: [{
          projectId: 'docs',
          repoPath: '/repos/docs',
          branchName: '',
          targetBranchName: '',
          checkpointId: 'checkpoint-1',
          worktreeKey: 'docs::legacy-direct',
        }],
      },
      preferredProjectId: 'docs',
      resolveRepoPath: (_projectId, repoPath) => repoPath ?? null,
    })).toEqual({
      repoPath: '/repos/docs',
      branchName: null,
    });
  });
});
