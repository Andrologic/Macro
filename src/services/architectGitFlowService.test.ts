import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { toBranchWorktreeKey } from './implementTaskDerivation';
import {
  createArchitectGitFlowService,
  isPlanFinalizationBlockedError,
  type PlanFinalizationBlockedError,
} from './architectGitFlowService';

const projectPaths = new Map<string, { id: string; name: string; mountName: string; path: string }>();
let currentPlan: any = null;

interface MockGitStatus {
  branch: string;
  is_clean: boolean;
  head_commit: null;
  staged_files: Array<{ path: string; status: string }>;
  unstaged_files: Array<{ path: string; status: string }>;
  modified_files: string[];
  untracked_files: Array<{ path: string; status: string }>;
  conflicted_files: string[];
  conflictedFiles: string[];
  merge_in_progress: boolean;
  mergeInProgress: boolean;
  ahead: number;
  behind: number;
}

interface MockGitBranch {
  name: string;
  is_head: boolean;
  commit: string;
}

const createGitStatus = (overrides: Partial<MockGitStatus> = {}): MockGitStatus => {
  const conflictedFiles = overrides.conflictedFiles ?? overrides.conflicted_files ?? [];
  const mergeInProgress = overrides.mergeInProgress ?? overrides.merge_in_progress ?? false;

  const base: MockGitStatus = {
    branch: 'develop',
    head_commit: null,
    is_clean: true,
    staged_files: [],
    unstaged_files: [],
    modified_files: [],
    untracked_files: [],
    conflicted_files: conflictedFiles,
    conflictedFiles,
    merge_in_progress: mergeInProgress,
    mergeInProgress,
    ahead: 0,
    behind: 0,
  };

  return Object.assign(base, overrides, {
    conflicted_files: conflictedFiles,
    conflictedFiles,
    merge_in_progress: mergeInProgress,
    mergeInProgress,
  });
};

const createGitBranches = (names: string[]): { current: string; local: MockGitBranch[]; remote: MockGitBranch[] } => ({
  current: 'develop',
  local: names.map((name) => ({ name, is_head: name === 'develop', commit: `${name}-sha` })),
  remote: [],
});

const worktreeStatusByPath = new Map<string, MockGitStatus | null>();

const gitStatusMock = mock(async (repoPath: string) => {
  if (worktreeStatusByPath.has(repoPath)) {
    const status = worktreeStatusByPath.get(repoPath);
    if (!status) {
      throw new Error(`Repository path ${repoPath} does not exist`);
    }
    return status;
  }
  return createGitStatus();
});
const gitDiffMock = mock(async (_params: { repoPath: string }) => '');
const gitMergeCheckMock = mock(async (_params: { repoPath: string }) => ({
  mergeable: true,
  conflictFiles: [],
  hasChanges: true,
}));
const gitMergeMock = mock(async (_params: { repoPath: string }) => 'merge-ok');
const gitBranchListMock = mock(async (_repoPath: string) => createGitBranches([
  'develop',
  'plan/checkout',
  'feature/checkout/checkout-web',
  'feature/checkout/checkout-api',
]));
const gitBranchDeleteMock = mock(async (_params: { repoPath: string; branchName: string; force?: boolean }) => undefined);
const gitCheckoutMock = mock(async (_params: { repoPath: string; branchOrCommit: string }) => undefined);
const gitBranchCreateMock = mock(async (_params: { repoPath: string; branchName: string; fromRef: string }) => undefined);
const gitWorktreeRemoveMock = mock(async (_params: { repoPath: string; taskId: string }) => undefined);
const gitAddMock = mock(async (_params: { repoPath: string; paths: string[] }) => undefined);
const gitCommitMock = mock(async (_params: { repoPath: string; message: string }) => 'commit-hash');
const fsWriteFileMock = mock(async (_params: { path: string; content: string }) => ({
  path: _params.path,
  bytes_written: _params.content.length,
  created: false,
}));

const getArchitectPlanMock = mock(async (_branchName: string, _planId: string) => currentPlan);
const updateArchitectPlanMock = mock(async (params: { status?: string }) => {
  currentPlan = {
    ...currentPlan,
    status: params.status ?? currentPlan?.status ?? 'validated',
  };
  return currentPlan;
});
const archiveArchitectPlanMock = mock(async (_branchName: string, _planId: string) => {
  currentPlan = {
    ...currentPlan,
    status: 'archived',
  };
  return currentPlan;
});
const deleteArchitectPlanMock = mock(async () => undefined);

const buildPlan = () => ({
  id: 'plan-1',
  slug: 'checkout',
  title: 'Checkout',
  description: '',
  status: 'validated',
  targetBranch: 'develop',
  projectId: 'web',
  projectIds: ['web', 'api'],
  createdAt: '2026-03-07T00:00:00.000Z',
  updatedAt: '2026-03-07T00:00:00.000Z',
  nodes: [
    {
      id: 'task-web',
      title: 'Build checkout UI',
      type: 'task',
      status: 'completed',
      dependencies: [],
      assignedBranch: 'feature/checkout/checkout-web',
      projectId: 'web',
      projectIds: ['web'],
    },
    {
      id: 'task-api',
      title: 'Add checkout endpoint',
      type: 'task',
      status: 'completed',
      dependencies: [],
      assignedBranch: 'feature/checkout/checkout-api',
      projectId: 'api',
      projectIds: ['api'],
    },
  ],
  predictedBranches: [
    {
      id: 'branch-web',
      name: 'feature/checkout/checkout-web',
      color: '#3b82f6',
      parentBranch: 'plan/checkout',
      projectId: 'web',
      taskIds: ['task-web'],
      status: 'completed',
    },
    {
      id: 'branch-api',
      name: 'feature/checkout/checkout-api',
      color: '#10b981',
      parentBranch: 'plan/checkout',
      projectId: 'api',
      taskIds: ['task-api'],
      status: 'completed',
    },
  ],
});

const getExpectedWorktreePath = (projectId: string, repoPath: string, branchName: string) =>
  `${repoPath}/.macro/worktrees/task${toBranchWorktreeKey(projectId, branchName)}`;

let architectGitFlowService: ReturnType<typeof createArchitectGitFlowService>;

describe('architectGitFlowService', () => {
  beforeEach(() => {
    projectPaths.clear();
    projectPaths.set('web', { id: 'web', name: 'Web', mountName: 'web', path: '/repos/web' });
    projectPaths.set('api', { id: 'api', name: 'API', mountName: 'api', path: '/repos/api' });
    currentPlan = buildPlan();
    worktreeStatusByPath.clear();
    worktreeStatusByPath.set(
      getExpectedWorktreePath('web', '/repos/web', 'feature/checkout/checkout-web'),
      createGitStatus({ branch: 'feature/checkout/checkout-web' })
    );
    worktreeStatusByPath.set(
      getExpectedWorktreePath('api', '/repos/api', 'feature/checkout/checkout-api'),
      createGitStatus({ branch: 'feature/checkout/checkout-api' })
    );

    gitStatusMock.mockReset();
    gitStatusMock.mockImplementation(async (repoPath: string) => {
      if (worktreeStatusByPath.has(repoPath)) {
        const status = worktreeStatusByPath.get(repoPath);
        if (!status) {
          throw new Error(`Repository path ${repoPath} does not exist`);
        }
        return status;
      }
      return createGitStatus();
    });

    gitDiffMock.mockReset();
    gitDiffMock.mockImplementation(async ({ repoPath }: { repoPath: string }) =>
      repoPath === '/repos/web' ? 'diff --git a/file.ts b/file.ts' : ''
    );

    gitMergeCheckMock.mockReset();
    gitMergeCheckMock.mockImplementation(async ({ repoPath }: { repoPath: string }) => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: repoPath === '/repos/web',
    }));

    gitMergeMock.mockReset();
    gitMergeMock.mockImplementation(async ({ repoPath }: { repoPath: string }) => `merged:${repoPath}`);

    gitBranchListMock.mockReset();
    gitBranchListMock.mockImplementation(async (repoPath: string) => createGitBranches([
      'develop',
      'plan/checkout',
      repoPath === '/repos/web' ? 'feature/checkout/checkout-web' : 'feature/checkout/checkout-api',
    ]));

    gitBranchDeleteMock.mockReset();
    gitCheckoutMock.mockReset();
    gitBranchCreateMock.mockReset();
    gitWorktreeRemoveMock.mockReset();
    gitAddMock.mockReset();
    gitCommitMock.mockReset();
    fsWriteFileMock.mockReset();
    getArchitectPlanMock.mockClear();
    updateArchitectPlanMock.mockClear();
    archiveArchitectPlanMock.mockClear();
    deleteArchitectPlanMock.mockClear();

    architectGitFlowService = createArchitectGitFlowService({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        gitMergeCheck: gitMergeCheckMock,
        gitMerge: gitMergeMock,
        gitBranchList: gitBranchListMock,
        gitBranchDelete: gitBranchDeleteMock,
        gitCheckout: gitCheckoutMock,
        gitBranchCreate: gitBranchCreateMock,
        gitWorktreeRemove: gitWorktreeRemoveMock,
      },
      getAppState: () => ({
        selectedProjectId: 'web',
        getProjectById: (projectId: string) => projectPaths.get(projectId),
      }),
      getArchitectPlan: getArchitectPlanMock,
      updateArchitectPlan: updateArchitectPlanMock,
      archiveArchitectPlan: archiveArchitectPlanMock,
      deleteArchitectPlan: deleteArchitectPlanMock,
      getGitFlowBaseBranch: () => 'develop',
      toPlanIntegrationBranch: (slug: string) => `plan/${slug}`,
      toPlanScopedFeatureBranch: (slug: string, branchName: string) => `feature/${slug}/${branchName.split('/').pop()}`,
    });
  });

  it('surfaces repository blocking state in the plan review', async () => {
    gitStatusMock.mockImplementation(async (repoPath: string) => {
      if (worktreeStatusByPath.has(repoPath)) {
        return worktreeStatusByPath.get(repoPath)!;
      }
      return createGitStatus({
        is_clean: repoPath !== '/repos/api',
        modified_files: repoPath === '/repos/api' ? ['dirty.ts'] : [],
      });
    });

    const review = await architectGitFlowService.loadPlanReview({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(review.tasks.map((task: { id: string }) => task.id)).toEqual(['task-web', 'task-api']);
    expect(review.repositories.map((repository: { repoPath: string }) => repository.repoPath)).toEqual(['/repos/web', '/repos/api']);
    expect(review.repositories[0]?.mergeable).toBe(true);
    expect(review.repositories[0]?.blockingReason).toBeNull();
    expect(review.repositories[0]?.blockingKind).toBeNull();
    expect(review.repositories[0]?.nextAction).toBeNull();
    expect(review.repositories[0]?.mergeInProgress).toBe(false);
    expect(review.repositories[1]?.mergeable).toBe(false);
    expect(review.repositories[1]?.blockingReason).toContain('uncommitted changes');
    expect(review.repositories[1]?.blockingKind).toBe('repository_dirty');
    expect(review.repositories[1]?.nextAction).toBe('clean_repository');
    expect(gitMergeCheckMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces already conflicted repositories in the plan review without running merge-check', async () => {
    gitStatusMock.mockImplementation(async (repoPath: string) => {
      if (worktreeStatusByPath.has(repoPath)) {
        return worktreeStatusByPath.get(repoPath)!;
      }

      if (repoPath === '/repos/api') {
        return createGitStatus({
          is_clean: false,
          conflicted_files: ['src/conflict.ts'],
          merge_in_progress: true,
        });
      }

      return createGitStatus();
    });

    const review = await architectGitFlowService.loadPlanReview({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(review.repositories[1]).toMatchObject({
      repoPath: '/repos/api',
      mergeable: false,
      mergeInProgress: true,
      conflictFiles: ['src/conflict.ts'],
      blockingKind: 'merge_conflict',
      nextAction: 'resolve_conflicts',
    });
    expect(review.repositories[1]?.blockingReason).toContain('src/conflict.ts');
    expect(gitMergeCheckMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces merge-in-progress repositories in the plan review', async () => {
    gitStatusMock.mockImplementation(async (repoPath: string) => {
      if (worktreeStatusByPath.has(repoPath)) {
        return worktreeStatusByPath.get(repoPath)!;
      }

      if (repoPath === '/repos/api') {
        return createGitStatus({
          is_clean: true,
          merge_in_progress: true,
        });
      }

      return createGitStatus();
    });

    const review = await architectGitFlowService.loadPlanReview({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(review.repositories[1]).toMatchObject({
      repoPath: '/repos/api',
      mergeable: true,
      mergeInProgress: true,
      blockingKind: 'merge_in_progress',
      nextAction: 'finish_or_abort_merge',
      conflictFiles: [],
    });
    expect(review.repositories[1]?.blockingReason).toContain('merge in progress');
    expect(gitMergeCheckMock).toHaveBeenCalledTimes(2);
  });

  it('blocks finalization before any mutation when plan tasks are incomplete', async () => {
    currentPlan = {
      ...currentPlan,
      nodes: currentPlan.nodes.map((node: any, index: number) =>
        index === 0 ? { ...node, status: 'in-progress' } : node
      ),
    };

    await expect(architectGitFlowService.finalizePlanIntoBaseBranch({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('tasks are incomplete');

    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(archiveArchitectPlanMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
  });

  it('blocks finalization before any mutation when preflight fails', async () => {
    gitStatusMock.mockImplementation(async (repoPath: string) => {
      if (worktreeStatusByPath.has(repoPath)) {
        return worktreeStatusByPath.get(repoPath)!;
      }
      return createGitStatus({
        is_clean: repoPath !== '/repos/api',
        modified_files: repoPath === '/repos/api' ? ['dirty.ts'] : [],
      });
    });

    await expect(architectGitFlowService.finalizePlanIntoBaseBranch({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('uncommitted changes');

    let blockedError: unknown;
    try {
      await architectGitFlowService.finalizePlanIntoBaseBranch({
        branchName: 'feature/implement',
        planId: 'plan-1',
      });
    } catch (error) {
      blockedError = error;
    }

    expect(isPlanFinalizationBlockedError(blockedError)).toBe(true);
    if (isPlanFinalizationBlockedError(blockedError)) {
      const typedBlockedError = blockedError as PlanFinalizationBlockedError;
      expect(typedBlockedError.planId).toBe('plan-1');
      expect(typedBlockedError.branchName).toBe('feature/implement');
      expect(typedBlockedError.blockedRepositories).toHaveLength(1);
      expect(typedBlockedError.blockedRepositories[0]).toMatchObject({
        repoPath: '/repos/api',
        blockingKind: 'repository_dirty',
        nextAction: 'clean_repository',
      });
    }

    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(archiveArchitectPlanMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
  });

  it('blocks finalization before any mutation when a repository is already conflicted', async () => {
    gitStatusMock.mockImplementation(async (repoPath: string) => {
      if (worktreeStatusByPath.has(repoPath)) {
        return worktreeStatusByPath.get(repoPath)!;
      }

      if (repoPath === '/repos/api') {
        return createGitStatus({
          is_clean: false,
          conflicted_files: ['src/conflict.ts'],
          merge_in_progress: true,
        });
      }

      return createGitStatus();
    });

    let blockedError: unknown;
    try {
      await architectGitFlowService.finalizePlanIntoBaseBranch({
        branchName: 'feature/implement',
        planId: 'plan-1',
      });
    } catch (error) {
      blockedError = error;
    }

    expect(isPlanFinalizationBlockedError(blockedError)).toBe(true);
    if (isPlanFinalizationBlockedError(blockedError)) {
      const typedBlockedError = blockedError as PlanFinalizationBlockedError;
      expect(typedBlockedError.blockedRepositories[0]).toMatchObject({
        repoPath: '/repos/api',
        mergeInProgress: true,
        conflictFiles: ['src/conflict.ts'],
        blockingKind: 'merge_conflict',
        nextAction: 'resolve_conflicts',
      });
    }

    expect(gitMergeCheckMock).toHaveBeenCalledTimes(1);
    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(archiveArchitectPlanMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
  });

  it('fails closed before any git mutation when plan metadata replicas diverge', async () => {
    const divergenceError = Object.assign(
      new Error('Plan metadata replicas diverged across repositories.'),
      {
        name: 'ArchitectPlanReplicaDivergenceError',
        divergence: {
          branchName: 'feature/implement',
          planId: 'plan-1',
          replicas: [
            {
              scopeKey: 'repo:/repos/web',
              repoPath: '/repos/web',
              updatedAt: '2026-03-07T00:00:00.000Z',
              missing: false,
            },
            {
              scopeKey: 'repo:/repos/api',
              repoPath: '/repos/api',
              updatedAt: '2026-03-06T00:00:00.000Z',
              missing: false,
            },
          ],
        },
      }
    );
    getArchitectPlanMock.mockImplementationOnce(async () => {
      throw divergenceError;
    });

    await expect(architectGitFlowService.finalizePlanIntoBaseBranch({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('Plan metadata replicas diverged across repositories.');

    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(archiveArchitectPlanMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
  });

  it('finalizes mergeable repositories, archives the plan, and cleans plan branches/worktrees', async () => {
    const result = await architectGitFlowService.finalizePlanIntoBaseBranch({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(result.plan.status).toBe('archived');
    expect(result.repositories).toEqual([
      {
        projectId: 'web',
        repoPath: '/repos/web',
        planBranchName: 'plan/checkout',
        baseBranchName: 'develop',
        mergeOutput: 'merged:/repos/web',
      },
      {
        projectId: 'api',
        repoPath: '/repos/api',
        planBranchName: 'plan/checkout',
        baseBranchName: 'develop',
        mergeOutput: undefined,
      },
    ]);
    expect(updateArchitectPlanMock).toHaveBeenCalledWith({
      branchName: 'feature/implement',
      planId: 'plan-1',
      status: 'completed',
      setActive: false,
    });
    expect(archiveArchitectPlanMock).toHaveBeenCalledWith('feature/implement', 'plan-1');
    expect(gitMergeMock).toHaveBeenCalledTimes(1);
    expect(gitWorktreeRemoveMock.mock.calls.map(([params]) => params)).toEqual([
      {
        repoPath: '/repos/web',
        taskId: toBranchWorktreeKey('web', 'feature/checkout/checkout-web'),
      },
      {
        repoPath: '/repos/api',
        taskId: toBranchWorktreeKey('api', 'feature/checkout/checkout-api'),
      },
    ]);
    expect(gitBranchDeleteMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repos/web', branchName: 'feature/checkout/checkout-web', force: false },
      { repoPath: '/repos/web', branchName: 'plan/checkout', force: false },
      { repoPath: '/repos/api', branchName: 'feature/checkout/checkout-api', force: false },
      { repoPath: '/repos/api', branchName: 'plan/checkout', force: false },
    ]);
    expect(result.cleanup).toEqual([
      {
        projectId: 'web',
        repoPath: '/repos/web',
        deletedBranches: ['feature/checkout/checkout-web', 'plan/checkout'],
        deletedWorktrees: [{
          worktreeKey: toBranchWorktreeKey('web', 'feature/checkout/checkout-web'),
          branchName: 'feature/checkout/checkout-web',
          worktreePath: getExpectedWorktreePath('web', '/repos/web', 'feature/checkout/checkout-web'),
        }],
        retainedBranches: [],
        retainedWorktrees: [],
        cleanupError: null,
      },
      {
        projectId: 'api',
        repoPath: '/repos/api',
        deletedBranches: ['feature/checkout/checkout-api', 'plan/checkout'],
        deletedWorktrees: [{
          worktreeKey: toBranchWorktreeKey('api', 'feature/checkout/checkout-api'),
          branchName: 'feature/checkout/checkout-api',
          worktreePath: getExpectedWorktreePath('api', '/repos/api', 'feature/checkout/checkout-api'),
        }],
        retainedBranches: [],
        retainedWorktrees: [],
        cleanupError: null,
      },
    ]);
  });

  it('keeps cleanup idempotent when branches and worktrees are already gone', async () => {
    worktreeStatusByPath.set(getExpectedWorktreePath('web', '/repos/web', 'feature/checkout/checkout-web'), null);
    worktreeStatusByPath.set(getExpectedWorktreePath('api', '/repos/api', 'feature/checkout/checkout-api'), null);
    gitBranchListMock.mockImplementation(async () => createGitBranches(['develop']));

    const cleanup = await architectGitFlowService.cleanupPlanBranches(currentPlan);

    expect(cleanup).toEqual([
      {
        projectId: 'web',
        repoPath: '/repos/web',
        deletedBranches: [],
        deletedWorktrees: [],
        retainedBranches: [],
        retainedWorktrees: [],
        cleanupError: null,
      },
      {
        projectId: 'api',
        repoPath: '/repos/api',
        deletedBranches: [],
        deletedWorktrees: [],
        retainedBranches: [],
        retainedWorktrees: [],
        cleanupError: null,
      },
    ]);
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
  });

  it('falls back to the selected project when a plan has no explicit project ids', async () => {
    currentPlan = {
      ...buildPlan(),
      projectId: undefined,
      projectIds: [],
      expectedProjectIds: [],
      nodes: [],
      predictedBranches: [],
    };
    gitBranchListMock.mockImplementation(async () => createGitBranches(['develop']));

    const cleanup = await architectGitFlowService.cleanupPlanBranches(currentPlan);

    expect(cleanup).toEqual([
      {
        projectId: 'web',
        repoPath: '/repos/web',
        deletedBranches: [],
        deletedWorktrees: [],
        retainedBranches: [],
        retainedWorktrees: [],
        cleanupError: null,
      },
    ]);
  });

  it('refuses soft delete when cleanup preflight detects a dirty worktree', async () => {
    worktreeStatusByPath.set(
      getExpectedWorktreePath('web', '/repos/web', 'feature/checkout/checkout-web'),
      createGitStatus({
        branch: 'feature/checkout/checkout-web',
        is_clean: false,
        modified_files: ['README.md'],
      })
    );

    await expect(architectGitFlowService.deletePlanAndCleanupBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('has uncommitted changes');

    expect(deleteArchitectPlanMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
  });

  it('soft deletes only after cleanup succeeds', async () => {
    const result = await architectGitFlowService.deletePlanAndCleanupBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(deleteArchitectPlanMock).toHaveBeenCalledWith({
      branchName: 'feature/implement',
      planId: 'plan-1',
      hardDelete: undefined,
    });
    expect(result.deletedBranches).toEqual([
      'feature/checkout/checkout-web',
      'plan/checkout',
      'feature/checkout/checkout-api',
      'plan/checkout',
    ]);
    expect(result.deletedWorktreeKeys).toEqual([
      toBranchWorktreeKey('web', 'feature/checkout/checkout-web'),
      toBranchWorktreeKey('api', 'feature/checkout/checkout-api'),
    ]);
  });

  it('hard deletes an already deleted plan without requiring cleanup', async () => {
    currentPlan = {
      ...buildPlan(),
      status: 'deleted',
    };

    const result = await architectGitFlowService.deletePlanAndCleanupBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
      hardDelete: true,
    });

    expect(deleteArchitectPlanMock).toHaveBeenCalledWith({
      branchName: 'feature/implement',
      planId: 'plan-1',
      hardDelete: true,
    });
    expect(result).toEqual({
      deletedBranches: [],
      deletedWorktreeKeys: [],
      repositories: [],
    });
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
  });
});
