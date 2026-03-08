import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { toBranchWorktreeKey } from './implementTaskDerivation';

const projectPaths = new Map<string, { id: string; name: string; path: string }>();
let currentPlan: any = null;

interface MockGitStatus {
  branch: string;
  is_clean: boolean;
  staged_files: string[];
  modified_files: string[];
  untracked_files: string[];
  conflicted_files: string[];
  ahead: number;
  behind: number;
}

interface MockGitBranch {
  name: string;
  upstream: string | null;
}

const createGitStatus = (overrides: Partial<MockGitStatus> = {}): MockGitStatus => ({
  branch: 'develop',
  is_clean: true,
  staged_files: [],
  modified_files: [],
  untracked_files: [],
  conflicted_files: [],
  ahead: 0,
  behind: 0,
  ...overrides,
});

const createGitBranches = (names: string[]): { current: string; local: MockGitBranch[]; remote: MockGitBranch[] } => ({
  current: 'develop',
  local: names.map((name) => ({ name, upstream: null })),
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
const gitBranchDeleteMock = mock(async (_params: { repoPath: string; branchName: string; force: boolean }) => undefined);
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

const registerArchitectGitFlowMocks = () => {
  mock.restore();

  mock.module('../stores/useAppStore', () => ({
    useAppStore: {
      getState: () => ({
        selectedProjectId: 'web',
        getProjectById: (projectId: string) => projectPaths.get(projectId) ?? null,
      }),
    },
  }));

  mock.module('./tauriIpc', () => ({
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
    gitAdd: gitAddMock,
    gitCommit: gitCommitMock,
    fsWriteFile: fsWriteFileMock,
  }));

  mock.module('./architectPlanService', () => ({
    archiveArchitectPlan: archiveArchitectPlanMock,
    getArchitectPlan: getArchitectPlanMock,
    getArchitectPlanProjectIds: (plan: { projectId?: string; projectIds?: string[] }) =>
      Array.from(new Set([...(plan.projectIds || []), ...(plan.projectId ? [plan.projectId] : [])])),
    updateArchitectPlan: updateArchitectPlanMock,
    deleteArchitectPlan: deleteArchitectPlanMock,
    getGitFlowBaseBranch: () => 'develop',
    resolveTargetBranch: (value: unknown) => String(value || 'develop'),
    toPlanIntegrationBranch: (slug: string) => `plan/${slug}`,
    toPlanScopedFeatureBranch: (slug: string, branchName: string) => `feature/${slug}/${branchName.split('/').pop()}`,
  }));
};

let architectGitFlowImportCounter = 0;

const loadArchitectGitFlowService = async () => {
  registerArchitectGitFlowMocks();
  architectGitFlowImportCounter += 1;
  return import(`./architectGitFlowService.ts?test=${architectGitFlowImportCounter}`);
};

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

describe('architectGitFlowService', () => {
  beforeEach(() => {
    projectPaths.clear();
    projectPaths.set('web', { id: 'web', name: 'Web', path: '/repos/web' });
    projectPaths.set('api', { id: 'api', name: 'API', path: '/repos/api' });
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

    const { loadPlanReview } = await loadArchitectGitFlowService();
    const review = await loadPlanReview({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(review.tasks.map((task: { id: string }) => task.id)).toEqual(['task-web', 'task-api']);
    expect(review.repositories.map((repository: { repoPath: string }) => repository.repoPath)).toEqual(['/repos/web', '/repos/api']);
    expect(review.repositories[0]?.mergeable).toBe(true);
    expect(review.repositories[0]?.blockingReason).toBeNull();
    expect(review.repositories[1]?.mergeable).toBe(false);
    expect(review.repositories[1]?.blockingReason).toContain('uncommitted changes');
    expect(gitMergeCheckMock).toHaveBeenCalledTimes(1);
  });

  it('blocks finalization before any mutation when plan tasks are incomplete', async () => {
    currentPlan = {
      ...currentPlan,
      nodes: currentPlan.nodes.map((node: any, index: number) =>
        index === 0 ? { ...node, status: 'in-progress' } : node
      ),
    };

    const { finalizePlanIntoBaseBranch } = await loadArchitectGitFlowService();

    await expect(finalizePlanIntoBaseBranch({
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

    const { finalizePlanIntoBaseBranch } = await loadArchitectGitFlowService();

    await expect(finalizePlanIntoBaseBranch({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('uncommitted changes');

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

    const { finalizePlanIntoBaseBranch } = await loadArchitectGitFlowService();

    await expect(finalizePlanIntoBaseBranch({
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
    const { finalizePlanIntoBaseBranch } = await loadArchitectGitFlowService();

    const result = await finalizePlanIntoBaseBranch({
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

    const { cleanupPlanBranches } = await loadArchitectGitFlowService();
    const cleanup = await cleanupPlanBranches(currentPlan);

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

  it('refuses soft delete when cleanup preflight detects a dirty worktree', async () => {
    worktreeStatusByPath.set(
      getExpectedWorktreePath('web', '/repos/web', 'feature/checkout/checkout-web'),
      createGitStatus({
        branch: 'feature/checkout/checkout-web',
        is_clean: false,
        modified_files: ['README.md'],
      })
    );

    const { deletePlanAndCleanupBranches } = await loadArchitectGitFlowService();

    await expect(deletePlanAndCleanupBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('has uncommitted changes');

    expect(deleteArchitectPlanMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
  });

  it('soft deletes only after cleanup succeeds', async () => {
    const { deletePlanAndCleanupBranches } = await loadArchitectGitFlowService();

    const result = await deletePlanAndCleanupBranches({
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

  afterAll(() => {
    mock.restore();
  });
});
