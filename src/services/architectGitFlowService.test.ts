import { beforeEach, describe, expect, it, mock } from 'bun:test';

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

const gitStatusMock = mock(async (_repoPath: string) => createGitStatus());
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
  'checkout/checkout-web',
  'checkout/checkout-api',
]));
const gitBranchDeleteMock = mock(async (_params: { repoPath: string; branchName: string; force: boolean }) => undefined);
const gitCheckoutMock = mock(async (_params: { repoPath: string; branchOrCommit: string }) => undefined);
const gitBranchCreateMock = mock(async (_params: { repoPath: string; branchName: string; fromRef: string }) => undefined);
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
const deleteArchitectPlanMock = mock(async () => undefined);

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
  gitAdd: gitAddMock,
  gitCommit: gitCommitMock,
  fsWriteFile: fsWriteFileMock,
}));

mock.module('./architectPlanService', () => ({
  getArchitectPlan: getArchitectPlanMock,
  updateArchitectPlan: updateArchitectPlanMock,
  deleteArchitectPlan: deleteArchitectPlanMock,
  getGitFlowBaseBranch: () => 'develop',
  toPlanIntegrationBranch: (slug: string) => `plan/${slug}`,
  toPlanScopedFeatureBranch: (slug: string, branchName: string) => `${slug}/${branchName}`,
}));

const loadArchitectGitFlowService = () => import('./architectGitFlowService');

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
      assignedBranch: 'checkout-web',
      projectId: 'web',
      projectIds: ['web'],
    },
    {
      id: 'task-api',
      title: 'Add checkout endpoint',
      type: 'task',
      status: 'completed',
      dependencies: [],
      assignedBranch: 'checkout-api',
      projectId: 'api',
      projectIds: ['api'],
    },
  ],
  predictedBranches: [
    {
      id: 'branch-web',
      name: 'checkout-web',
      color: '#3b82f6',
      parentBranch: 'plan/checkout',
      projectId: 'web',
      taskIds: ['task-web'],
      status: 'completed',
    },
    {
      id: 'branch-api',
      name: 'checkout-api',
      color: '#10b981',
      parentBranch: 'plan/checkout',
      projectId: 'api',
      taskIds: ['task-api'],
      status: 'completed',
    },
  ],
});

describe('architectGitFlowService', () => {
  beforeEach(() => {
    projectPaths.clear();
    projectPaths.set('web', { id: 'web', name: 'Web', path: '/repos/web' });
    projectPaths.set('api', { id: 'api', name: 'API', path: '/repos/api' });
    currentPlan = buildPlan();

    gitStatusMock.mockReset();
    gitStatusMock.mockImplementation(async (_repoPath: string) => createGitStatus());

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
      repoPath === '/repos/web' ? 'checkout/checkout-web' : 'checkout/checkout-api',
    ]));

    gitBranchDeleteMock.mockReset();
    gitCheckoutMock.mockReset();
    gitBranchCreateMock.mockReset();
    gitAddMock.mockReset();
    gitCommitMock.mockReset();
    fsWriteFileMock.mockReset();
    getArchitectPlanMock.mockClear();
    updateArchitectPlanMock.mockClear();
    deleteArchitectPlanMock.mockClear();
  });

  it('surfaces repository blocking state in the plan review', async () => {
    gitStatusMock.mockImplementation(async (repoPath: string) =>
      createGitStatus({
        is_clean: repoPath !== '/repos/api',
        modified_files: repoPath === '/repos/api' ? ['dirty.ts'] : [],
      })
    );

    const { loadPlanReview } = await loadArchitectGitFlowService();
    const review = await loadPlanReview({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(review.tasks.map((task) => task.id)).toEqual(['task-web', 'task-api']);
    expect(review.repositories.map((repository) => repository.repoPath)).toEqual(['/repos/web', '/repos/api']);
    expect(review.repositories[0]?.mergeable).toBe(true);
    expect(review.repositories[0]?.blockingReason).toBeNull();
    expect(review.repositories[1]?.mergeable).toBe(false);
    expect(review.repositories[1]?.blockingReason).toContain('uncommitted changes');
    expect(gitMergeCheckMock).toHaveBeenCalledTimes(1);
  });

  it('blocks finalization before any mutation when preflight fails', async () => {
    gitStatusMock.mockImplementation(async (repoPath: string) =>
      createGitStatus({
        is_clean: repoPath !== '/repos/api',
        modified_files: repoPath === '/repos/api' ? ['dirty.ts'] : [],
      })
    );

    const { finalizePlanIntoBaseBranch } = await loadArchitectGitFlowService();

    await expect(finalizePlanIntoBaseBranch({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('uncommitted changes');

    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
  });

  it('finalizes mergeable repositories and cleans plan branches after preflight', async () => {
    const { finalizePlanIntoBaseBranch } = await loadArchitectGitFlowService();

    const result = await finalizePlanIntoBaseBranch({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(result.plan.status).toBe('completed');
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
    expect(gitMergeMock).toHaveBeenCalledTimes(1);
    expect(gitMergeMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchName: 'plan/checkout',
      intoBranch: 'develop',
    });
    expect(updateArchitectPlanMock).toHaveBeenCalledTimes(1);
    expect(gitBranchDeleteMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repos/web', branchName: 'checkout/checkout-web', force: false },
      { repoPath: '/repos/web', branchName: 'plan/checkout', force: false },
      { repoPath: '/repos/api', branchName: 'checkout/checkout-api', force: false },
      { repoPath: '/repos/api', branchName: 'plan/checkout', force: false },
    ]);
  });
});
