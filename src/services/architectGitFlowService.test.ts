import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ProjectGitFlowSettings } from '../types';
import { toBranchWorktreeKey } from './implementTaskDerivation';
import {
  buildPlanIntegrationWorktreePath,
  toPlanIntegrationWorktreeKey,
} from './planIntegrationWorktreeService';
import {
  createArchitectGitFlowService,
  isPlanFinalizationBlockedError,
  type PlanFinalizationBlockedError,
} from './architectGitFlowService';
import type {
  GitBranchWorktreeEnsureDto,
  GitBranchWorktreeInspectionDto,
  GitBranchWorktreeRemoveDto,
} from './tauriIpc';

const projectPaths = new Map<string, {
  id: string;
  name: string;
  mountName: string;
  path: string;
  gitFlowSettings?: ProjectGitFlowSettings;
}>();
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
const gitRebaseCheckMock = mock(async (_params: { repoPath: string; branchName: string; ontoBranch: string }) => ({
  rebaseable: true,
  conflictFiles: [],
  output: '',
}));
const gitMergeMock = mock(async (_params: { repoPath: string; branchName?: string; intoBranch?: string }) => 'merge-ok');
const gitPullMock = mock(async (_params: { repoPath: string; branch?: string }) => ({
  branch: _params.branch || 'develop',
  remote: 'origin',
  output: 'up to date',
}));
const gitBranchListMock = mock(async (_repoPath: string) => createGitBranches([
  'develop',
  'plan/checkout',
  'feature/checkout/checkout-web',
  'feature/checkout/checkout-api',
]));
const gitBranchDeleteMock = mock(async (_params: { repoPath: string; branchName: string; force?: boolean }) => undefined);
const gitBranchDeleteRemoteMock = mock(async (_params: { repoPath: string; branchName: string }) => undefined);
const gitCheckoutMock = mock(async (_params: { repoPath: string; branchOrCommit: string }) => undefined);
const gitBranchCreateMock = mock(async (_params: { repoPath: string; branchName: string; fromRef: string }) => undefined);
const gitWorktreeInspectMock = mock(async (params: { repoPath: string; taskId: string; branchName?: string | null }) => {
  const worktreePath = `${params.repoPath}/.macro/worktrees/task${params.taskId}`;
  if (worktreeStatusByPath.has(worktreePath)) {
    const status = worktreeStatusByPath.get(worktreePath);
    if (!status) {
      return {
        taskId: params.taskId,
        worktreePath,
        branchName: null,
        status: 'absent' as const,
        isDirty: null,
      };
    }
    return {
      taskId: params.taskId,
      worktreePath,
      branchName: status.branch,
      status: 'ready' as const,
      isDirty: !status.is_clean,
    };
  }
  return {
    taskId: params.taskId,
    worktreePath,
    branchName: null,
    status: 'ready' as const,
    isDirty: false,
  };
});
const gitWorktreeRemoveMock = mock(async (params: { repoPath: string; taskId: string; branchName?: string | null }) => ({
  taskId: params.taskId,
  worktreePath: `${params.repoPath}/.macro/worktrees/task${params.taskId}`,
  removedPath: true,
  prunedRegistration: true,
  alreadyAbsent: false,
}));
const gitBranchWorktreeInspectMock = mock(
  async (params: {
    repoPath: string;
    worktreeKey: string;
    branchName: string;
  }): Promise<GitBranchWorktreeInspectionDto> =>
    buildBranchWorktreeInspection({
      ...params,
      branchName: params.branchName,
    }),
);
const gitBranchWorktreeCreateMock = mock(
  async (params: {
    repoPath: string;
    worktreeKey: string;
    branchName: string;
  }): Promise<GitBranchWorktreeEnsureDto> =>
    buildBranchWorktreeEnsure(params),
);
const gitBranchWorktreeRemoveMock = mock(
  async (params: {
    repoPath: string;
    worktreeKey: string;
    branchName: string;
  }): Promise<GitBranchWorktreeRemoveDto> =>
    buildBranchWorktreeRemove(params),
);
const gitAddMock = mock(async (_params: { repoPath: string; paths: string[] }) => undefined);
const gitCommitMock = mock(async (_params: { repoPath: string; message: string }) => 'commit-hash');
const fsWriteFileMock = mock(async (_params: { path: string; content: string }) => ({
  path: _params.path,
  bytes_written: _params.content.length,
  created: false,
}));

const getArchitectPlanMock = mock(async (_branchName: string, _planId: string) => currentPlan);
const updateArchitectPlanMock = mock(async (params: {
  status?: string;
  nodes?: any[];
  predictedBranches?: any[];
  projectId?: string;
  projectIds?: string[];
}) => {
  currentPlan = {
    ...currentPlan,
    status: params.status ?? currentPlan?.status ?? 'validated',
    nodes: params.nodes ?? currentPlan?.nodes ?? [],
    predictedBranches: params.predictedBranches ?? currentPlan?.predictedBranches ?? [],
    projectId: params.projectId ?? currentPlan?.projectId,
    projectIds: params.projectIds ?? currentPlan?.projectIds ?? [],
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

const createGitFlowSettings = (
  overrides: Partial<ProjectGitFlowSettings> = {}
): ProjectGitFlowSettings => ({
  baseBranch: 'develop',
  mainBranch: 'main',
  planBranchTemplate: 'plan/{planSlug}',
  featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
  standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
  releaseBranchTemplate: 'release/{branchSlug}',
  hotfixBranchTemplate: 'hotfix/{branchSlug}',
  bugfixBranchTemplate: 'bugfix/{branchSlug}',
  ...overrides,
});

const getExpectedWorktreePath = (projectId: string, repoPath: string, branchName: string) =>
  `${repoPath}/.macro/worktrees/task${toBranchWorktreeKey(projectId, branchName)}`;

const getExpectedIntegrationWorktreePath = (projectId: string, repoPath: string, branchName: string) =>
  buildPlanIntegrationWorktreePath(repoPath, toPlanIntegrationWorktreeKey(projectId, branchName));

const buildBranchWorktreeInspection = (params: {
  repoPath: string;
  worktreeKey: string;
  branchName?: string | null;
  status?: GitBranchWorktreeInspectionDto['status'];
  isDirty?: boolean | null;
}): GitBranchWorktreeInspectionDto => ({
  worktreeKey: params.worktreeKey,
  worktreePath: buildPlanIntegrationWorktreePath(params.repoPath, params.worktreeKey),
  branchName: params.branchName ?? null,
  status: params.status ?? 'ready',
  isDirty: params.isDirty ?? false,
});

const buildBranchWorktreeEnsure = (params: {
  repoPath: string;
  worktreeKey: string;
  branchName: string;
  status?: GitBranchWorktreeEnsureDto['status'];
}): GitBranchWorktreeEnsureDto => ({
  worktreeKey: params.worktreeKey,
  worktreePath: buildPlanIntegrationWorktreePath(params.repoPath, params.worktreeKey),
  branchName: params.branchName,
  status: params.status ?? 'reused',
});

const buildBranchWorktreeRemove = (params: {
  repoPath: string;
  worktreeKey: string;
}): GitBranchWorktreeRemoveDto => ({
  worktreeKey: params.worktreeKey,
  worktreePath: buildPlanIntegrationWorktreePath(params.repoPath, params.worktreeKey),
  removedPath: true,
  prunedRegistration: true,
  alreadyAbsent: false,
});

const getProjectGroups = () => [
  {
    id: 'group-main',
    name: 'Main',
    isOpen: true,
    projects: Array.from(projectPaths.values()),
  },
];

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
    gitRebaseCheckMock.mockReset();
    gitRebaseCheckMock.mockImplementation(async () => ({
      rebaseable: true,
      conflictFiles: [],
      output: '',
    }));

    gitMergeMock.mockReset();
    gitMergeMock.mockImplementation(async ({ repoPath }: { repoPath: string }) => `merged:${repoPath}`);
    gitPullMock.mockReset();

    gitBranchListMock.mockReset();
    gitBranchListMock.mockImplementation(async (repoPath: string) => createGitBranches([
      'develop',
      'plan/checkout',
      repoPath === '/repos/web' ? 'feature/checkout/checkout-web' : 'feature/checkout/checkout-api',
    ]));

    gitBranchDeleteMock.mockReset();
    gitBranchDeleteRemoteMock.mockReset();
    gitCheckoutMock.mockReset();
    gitBranchCreateMock.mockReset();
    gitWorktreeInspectMock.mockReset();
    gitWorktreeRemoveMock.mockReset();
    gitBranchWorktreeInspectMock.mockReset();
    gitBranchWorktreeCreateMock.mockReset();
    gitBranchWorktreeRemoveMock.mockReset();
    gitWorktreeInspectMock.mockImplementation(async (params: { repoPath: string; taskId: string; branchName?: string | null }) => {
      const worktreePath = `${params.repoPath}/.macro/worktrees/task${params.taskId}`;
      if (worktreeStatusByPath.has(worktreePath)) {
        const status = worktreeStatusByPath.get(worktreePath);
        if (!status) {
          return {
            taskId: params.taskId,
            worktreePath,
            branchName: null,
            status: 'absent' as const,
            isDirty: null,
          };
        }
        return {
          taskId: params.taskId,
          worktreePath,
          branchName: status.branch,
          status: 'ready' as const,
          isDirty: !status.is_clean,
        };
      }
      return {
        taskId: params.taskId,
        worktreePath,
        branchName: null,
        status: 'ready' as const,
        isDirty: false,
      };
    });
    gitWorktreeRemoveMock.mockImplementation(async (params: { repoPath: string; taskId: string; branchName?: string | null }) => ({
      taskId: params.taskId,
      worktreePath: `${params.repoPath}/.macro/worktrees/task${params.taskId}`,
      removedPath: true,
      prunedRegistration: true,
      alreadyAbsent: false,
    }));
    gitBranchWorktreeInspectMock.mockImplementation(
      async (params: { repoPath: string; worktreeKey: string; branchName: string }) =>
        buildBranchWorktreeInspection({
          ...params,
          branchName: params.branchName,
        }),
    );
    gitBranchWorktreeCreateMock.mockImplementation(
      async (params: { repoPath: string; worktreeKey: string; branchName: string }) =>
        buildBranchWorktreeEnsure(params),
    );
    gitBranchWorktreeRemoveMock.mockImplementation(
      async (params: { repoPath: string; worktreeKey: string; branchName: string }) =>
        buildBranchWorktreeRemove(params),
    );
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
        gitRebaseCheck: gitRebaseCheckMock,
        gitMerge: gitMergeMock,
        gitPull: gitPullMock,
        gitBranchList: gitBranchListMock,
        gitBranchDelete: gitBranchDeleteMock,
        gitBranchDeleteRemote: gitBranchDeleteRemoteMock,
        gitCheckout: gitCheckoutMock,
        gitBranchCreate: gitBranchCreateMock,
        gitWorktreeInspect: gitWorktreeInspectMock,
        gitWorktreeRemove: gitWorktreeRemoveMock,
        gitBranchWorktreeInspect: gitBranchWorktreeInspectMock,
        gitBranchWorktreeCreate: gitBranchWorktreeCreateMock,
        gitBranchWorktreeRemove: gitBranchWorktreeRemoveMock,
      },
      getAppState: () => ({
        selectedGroupId: 'group-main',
        selectedProjectId: 'web',
        projectGroups: getProjectGroups(),
        getProjectById: (projectId: string) => projectPaths.get(projectId),
      }),
      getArchitectPlan: getArchitectPlanMock,
      updateArchitectPlan: updateArchitectPlanMock,
      archiveArchitectPlan: archiveArchitectPlanMock,
      deleteArchitectPlan: deleteArchitectPlanMock,
      getGitFlowBaseBranch: () => 'develop',
    });
  });

  it('renders and provisions repo-specific branch names when projects use different Git workflow templates', async () => {
    projectPaths.set('web', {
      ...projectPaths.get('web')!,
      gitFlowSettings: createGitFlowSettings(),
    });
    projectPaths.set('api', {
      ...projectPaths.get('api')!,
      gitFlowSettings: createGitFlowSettings({
        planBranchTemplate: 'roadmap/{planSlug}',
        featureBranchTemplate: 'work/{planSlug}/{featureSlug}',
      }),
    });
    currentPlan = buildPlan();
    gitBranchCreateMock.mockReset();
    gitBranchListMock.mockImplementation(async () => createGitBranches(['develop']));

    const result = await architectGitFlowService.validatePlanAndProvisionBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(gitBranchCreateMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repos/web', branchName: 'plan/checkout', fromRef: 'develop' },
      { repoPath: '/repos/web', branchName: 'feature/checkout/checkout-web', fromRef: 'plan/checkout' },
      { repoPath: '/repos/api', branchName: 'roadmap/checkout', fromRef: 'develop' },
      { repoPath: '/repos/api', branchName: 'work/checkout/checkout-api', fromRef: 'roadmap/checkout' },
    ]);

    expect(result.provision).toEqual({
      planBranchName: 'plan/checkout',
      repositories: [
        {
          projectId: 'web',
          repoPath: '/repos/web',
          planBranchName: 'plan/checkout',
          createdPlanBranch: true,
          createdFeatureBranches: ['feature/checkout/checkout-web'],
          existingFeatureBranches: [],
        },
        {
          projectId: 'api',
          repoPath: '/repos/api',
          planBranchName: 'roadmap/checkout',
          createdPlanBranch: true,
          createdFeatureBranches: ['work/checkout/checkout-api'],
          existingFeatureBranches: [],
        },
      ],
      createdPlanBranch: true,
      createdFeatureBranches: [
        'feature/checkout/checkout-web',
        'work/checkout/checkout-api',
      ],
      existingFeatureBranches: [],
    });

    const persistedPredictedBranches =
      updateArchitectPlanMock.mock.calls.at(-1)?.[0]?.predictedBranches ?? [];

    expect(result.plan.predictedBranches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId: 'web',
        name: 'feature/checkout/checkout-web',
        parentBranch: 'plan/checkout',
      }),
      expect.objectContaining({
        projectId: 'api',
        name: 'work/checkout/checkout-api',
        parentBranch: 'roadmap/checkout',
      }),
    ]));
    expect(persistedPredictedBranches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId: 'web',
        name: 'feature/checkout/checkout-web',
        parentBranch: 'plan/checkout',
      }),
      expect.objectContaining({
        projectId: 'api',
        name: 'work/checkout/checkout-api',
        parentBranch: 'roadmap/checkout',
      }),
    ]));
    expect(
      persistedPredictedBranches.some((branch: { name: string; parentBranch: string | null; projectId: string }) =>
        branch.projectId === 'api'
        && (branch.name.includes('feature/checkout/') || branch.parentBranch === 'plan/checkout')
      )
    ).toBe(false);
  });

  it('validates legacy shared feature slugs into one provisioned branch per task', async () => {
    projectPaths.set('web', {
      ...projectPaths.get('web')!,
      gitFlowSettings: createGitFlowSettings(),
    });
    currentPlan = {
      ...buildPlan(),
      projectId: 'web',
      projectIds: ['web'],
      targetBranchesByProjectId: { web: 'develop' },
      nodes: [
        {
          id: 'task-a',
          title: 'Build foundation',
          type: 'task',
          status: 'pending',
          dependencies: [],
          branchType: 'feature',
          branchSlug: 'shared-work',
          assignedBranch: 'feature/shared-work',
          projectId: 'web',
          projectIds: ['web'],
        },
        {
          id: 'task-b',
          title: 'Continue foundation',
          type: 'task',
          status: 'pending',
          dependencies: [],
          branchType: 'feature',
          branchSlug: 'shared-work',
          assignedBranch: 'feature/shared-work',
          projectId: 'web',
          projectIds: ['web'],
        },
      ],
      predictedBranches: [
        {
          id: 'branch-shared',
          name: 'feature/checkout/shared-work',
          color: '#3b82f6',
          parentBranch: 'plan/checkout',
          projectId: 'web',
          taskIds: ['task-a', 'task-b'],
          status: 'pending',
          branchType: 'feature',
          branchSlug: 'shared-work',
        },
      ],
    };
    gitBranchCreateMock.mockReset();
    gitBranchListMock.mockImplementation(async () => createGitBranches(['develop']));

    const result = await architectGitFlowService.validatePlanAndProvisionBranches({
      branchName: 'develop',
      planId: 'plan-1',
    });

    const createdBranchNames = gitBranchCreateMock.mock.calls.map(
      ([params]) => params.branchName,
    );
    expect(createdBranchNames).toHaveLength(3);
    expect(createdBranchNames[0]).toBe('plan/checkout');
    expect(createdBranchNames[1]).toBe('feature/checkout/shared-work');
    expect(createdBranchNames[2]).toMatch(/^feature\/checkout\/shared-work-[0-9a-f]{6}$/);

    expect(result.plan.predictedBranches).toHaveLength(2);
    expect(result.plan.predictedBranches.every((branch) => branch.taskIds.length === 1)).toBe(true);
    expect(new Set(result.plan.predictedBranches.map((branch) => branch.name)).size).toBe(2);
    expect(result.plan.nodes.find((node) => node.id === 'task-b')?.dependencies).toEqual(['task-a']);
  });

  it('uses typed release branches as plan integration branches and creates them from develop', async () => {
    projectPaths.set('web', {
      ...projectPaths.get('web')!,
      gitFlowSettings: createGitFlowSettings({ releaseBranchTemplate: 'release/v{releaseSlug}' }),
    });
    currentPlan = {
      ...buildPlan(),
      planKind: 'release',
      targetBranchesByProjectId: { web: 'main', api: 'main' },
      gitFlowPlan: {
        version: 1,
        planKind: 'release',
        slug: '0.2.0',
        projects: {
          web: {
            projectId: 'web',
            sourceBranch: 'develop',
            integrationBranch: '',
            targetBranch: 'main',
            backmergeBranch: 'develop',
            proposedVersion: '0.2.0',
            confirmedVersion: '0.2.0',
            proposedSlug: '0.2.0',
            confirmedSlug: '0.2.0',
          },
          api: {
            projectId: 'api',
            sourceBranch: 'develop',
            integrationBranch: '',
            targetBranch: 'main',
            backmergeBranch: 'develop',
            proposedVersion: '0.2.0',
            confirmedVersion: '0.2.0',
            proposedSlug: '0.2.0',
            confirmedSlug: '0.2.0',
          },
        },
      },
    };
    gitBranchCreateMock.mockReset();
    gitBranchListMock.mockImplementation(async () => createGitBranches(['develop', 'main']));

    const result = await architectGitFlowService.validatePlanAndProvisionBranches({
      branchName: 'develop',
      planId: 'plan-1',
    });

    expect(gitBranchCreateMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repos/web', branchName: 'release/v0.2.0', fromRef: 'develop' },
      { repoPath: '/repos/web', branchName: 'feature/checkout/checkout-web', fromRef: 'release/v0.2.0' },
      { repoPath: '/repos/api', branchName: 'release/v0.2.0', fromRef: 'develop' },
      { repoPath: '/repos/api', branchName: 'feature/checkout/checkout-api', fromRef: 'release/v0.2.0' },
    ]);
    expect(result.plan.predictedBranches).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'web', parentBranch: 'release/v0.2.0' }),
      expect.objectContaining({ projectId: 'api', parentBranch: 'release/v0.2.0' }),
    ]));
  });

  it('does not provision Git workflow branches for context-only repositories', async () => {
    projectPaths.set('docs', {
      id: 'docs',
      name: 'Docs',
      mountName: 'docs',
      path: '/repos/docs',
    });
    currentPlan = {
      ...buildPlan(),
      contextProjectIds: ['docs'],
      expectedProjectIds: ['web', 'api', 'docs'],
    };
    gitBranchCreateMock.mockReset();
    gitBranchListMock.mockImplementation(async () => createGitBranches(['develop']));

    const result = await architectGitFlowService.validatePlanAndProvisionBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(gitBranchCreateMock.mock.calls.map(([params]) => params.repoPath)).toEqual([
      '/repos/web',
      '/repos/web',
      '/repos/api',
      '/repos/api',
    ]);
    expect(result.provision.repositories.map((repository) => repository.projectId)).toEqual(['web', 'api']);
    expect(updateArchitectPlanMock.mock.calls.at(-1)?.[0].projectIds).toEqual(['web', 'api']);
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

  it('can sync base branches before loading the plan review', async () => {
    await architectGitFlowService.loadPlanReview({
      branchName: 'feature/implement',
      planId: 'plan-1',
      syncBaseBranches: true,
    });

    expect(gitCheckoutMock).toHaveBeenCalledTimes(2);
    expect(gitCheckoutMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchOrCommit: 'develop',
      create: false,
    });
    expect(gitCheckoutMock).toHaveBeenCalledWith({
      repoPath: '/repos/api',
      branchOrCommit: 'develop',
      create: false,
    });
    expect(gitPullMock).toHaveBeenCalledTimes(2);
    expect(gitPullMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branch: 'develop',
    });
    expect(gitPullMock).toHaveBeenCalledWith({
      repoPath: '/repos/api',
      branch: 'develop',
    });
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

  it('surfaces merge-in-progress repositories without conflicts as ready to complete', async () => {
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
      blockingKind: null,
      nextAction: 'complete_merge',
      conflictFiles: [],
      mergeStrategy: 'merge_ready_to_complete',
      recommendedAction: 'complete_merge',
      availableActions: ['complete_merge', 'abort_merge', 'retry_check'],
    });
    expect(review.repositories[1]?.blockingReason).toBeNull();
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
        branchName: 'feature/checkout/checkout-web',
      },
      {
        repoPath: '/repos/api',
        taskId: toBranchWorktreeKey('api', 'feature/checkout/checkout-api'),
        branchName: 'feature/checkout/checkout-api',
      },
    ]);
    expect(gitBranchWorktreeRemoveMock.mock.calls.map(([params]) => params)).toEqual([
      {
        repoPath: '/repos/web',
        worktreeKey: toPlanIntegrationWorktreeKey('web', 'plan/checkout'),
        branchName: 'plan/checkout',
      },
      {
        repoPath: '/repos/api',
        worktreeKey: toPlanIntegrationWorktreeKey('api', 'plan/checkout'),
        branchName: 'plan/checkout',
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
        }, {
          worktreeKey: toPlanIntegrationWorktreeKey('web', 'plan/checkout'),
          branchName: 'plan/checkout',
          worktreePath: getExpectedIntegrationWorktreePath('web', '/repos/web', 'plan/checkout'),
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
        }, {
          worktreeKey: toPlanIntegrationWorktreeKey('api', 'plan/checkout'),
          branchName: 'plan/checkout',
          worktreePath: getExpectedIntegrationWorktreePath('api', '/repos/api', 'plan/checkout'),
        }],
        retainedBranches: [],
        retainedWorktrees: [],
        cleanupError: null,
      },
    ]);
  });

  it('finalizes release plans into main and backmerges main into develop', async () => {
    currentPlan = {
      ...buildPlan(),
      planKind: 'release',
      targetBranchesByProjectId: { web: 'main', api: 'main' },
      gitFlowPlan: {
        version: 1,
        planKind: 'release',
        slug: '0.2.0',
        projects: {
          web: {
            projectId: 'web',
            sourceBranch: 'develop',
            integrationBranch: '',
            targetBranch: 'main',
            backmergeBranch: 'develop',
            confirmedVersion: '0.2.0',
            confirmedSlug: '0.2.0',
          },
          api: {
            projectId: 'api',
            sourceBranch: 'develop',
            integrationBranch: '',
            targetBranch: 'main',
            backmergeBranch: 'develop',
            confirmedVersion: '0.2.0',
            confirmedSlug: '0.2.0',
          },
        },
      },
    };
    gitBranchListMock.mockImplementation(async (repoPath: string) => createGitBranches([
      'develop',
      'main',
      'release/v0.2.0',
      repoPath === '/repos/web' ? 'feature/checkout/checkout-web' : 'feature/checkout/checkout-api',
    ]));

    const result = await architectGitFlowService.finalizePlanIntoBaseBranch({
      branchName: 'develop',
      planId: 'plan-1',
    });

    expect(result.repositories).toEqual([
      {
        projectId: 'web',
        repoPath: '/repos/web',
        planBranchName: 'release/v0.2.0',
        baseBranchName: 'main',
        backmergeBranchName: 'develop',
        mergeOutput: 'merged:/repos/web',
        backmergeOutput: 'merged:/repos/web',
      },
      {
        projectId: 'api',
        repoPath: '/repos/api',
        planBranchName: 'release/v0.2.0',
        baseBranchName: 'main',
        backmergeBranchName: 'develop',
        mergeOutput: undefined,
        backmergeOutput: 'merged:/repos/api',
      },
    ]);
    expect(gitCheckoutMock.mock.calls.map(([params]) => params)).toEqual(expect.arrayContaining([
      { repoPath: '/repos/web', branchOrCommit: 'main', create: false },
      { repoPath: '/repos/web', branchOrCommit: 'develop', create: false },
      { repoPath: '/repos/api', branchOrCommit: 'main', create: false },
      { repoPath: '/repos/api', branchOrCommit: 'develop', create: false },
    ]));
    expect(gitMergeMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repos/web', branchName: 'release/v0.2.0', intoBranch: 'main' },
      { repoPath: '/repos/web', branchName: 'main', intoBranch: 'develop' },
      { repoPath: '/repos/api', branchName: 'main', intoBranch: 'develop' },
    ]);
  });

  it('keeps cleanup idempotent when branches and worktrees are already gone', async () => {
    worktreeStatusByPath.set(getExpectedWorktreePath('web', '/repos/web', 'feature/checkout/checkout-web'), null);
    worktreeStatusByPath.set(getExpectedWorktreePath('api', '/repos/api', 'feature/checkout/checkout-api'), null);
    gitBranchListMock.mockImplementation(async () => createGitBranches(['develop']));
    gitBranchWorktreeInspectMock.mockImplementation(
      async (params: { repoPath: string; worktreeKey: string }) =>
        buildBranchWorktreeInspection({
          ...params,
          branchName: null,
          status: 'absent',
          isDirty: null,
        }),
    );

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
    gitBranchWorktreeInspectMock.mockImplementation(
      async (params: { repoPath: string; worktreeKey: string }) =>
        buildBranchWorktreeInspection({
          ...params,
          branchName: null,
          status: 'absent',
          isDirty: null,
        }),
    );

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

  it('ignores stale expected project ids during delete cleanup when a real repository remains', async () => {
    currentPlan = {
      ...buildPlan(),
      status: 'archived',
      projectId: 'web',
      projectIds: ['web'],
      expectedProjectIds: ['web', 'session-project-ghost'],
      nodes: [buildPlan().nodes[0]],
      predictedBranches: [buildPlan().predictedBranches[0]],
    };
    worktreeStatusByPath.clear();
    worktreeStatusByPath.set(
      getExpectedWorktreePath('web', '/repos/web', 'feature/checkout/checkout-web'),
      createGitStatus({ branch: 'feature/checkout/checkout-web' })
    );
    gitBranchListMock.mockImplementation(async () =>
      createGitBranches(['develop', 'plan/checkout', 'feature/checkout/checkout-web'])
    );

    const result = await architectGitFlowService.deletePlanAndCleanupBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(deleteArchitectPlanMock).toHaveBeenCalledWith({
      branchName: 'feature/implement',
      planId: 'plan-1',
      hardDelete: true,
    });
    expect(result.repositories.map((repository) => repository.projectId)).toEqual(['web']);
    expect(result.deletedWorktreeKeys).toEqual([
      toBranchWorktreeKey('web', 'feature/checkout/checkout-web'),
      toPlanIntegrationWorktreeKey('web', 'plan/checkout'),
    ]);
  });

  it('keeps plan review blocked when a registered project has no repository path', async () => {
    projectPaths.set('api', {
      id: 'api',
      name: 'API',
      mountName: 'api',
      path: '   ',
    });
    currentPlan = {
      ...buildPlan(),
      expectedProjectIds: ['web', 'api'],
    };

    await expect(architectGitFlowService.loadPlanReview({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('Unable to resolve repository path for project api.');
  });

  it('falls back to getProjectById when projectGroups are temporarily stale', async () => {
    const staleGroupsService = createArchitectGitFlowService({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        gitMergeCheck: gitMergeCheckMock,
        gitRebaseCheck: gitRebaseCheckMock,
        gitMerge: gitMergeMock,
        gitPull: gitPullMock,
        gitBranchList: gitBranchListMock,
        gitBranchDelete: gitBranchDeleteMock,
        gitBranchDeleteRemote: gitBranchDeleteRemoteMock,
        gitCheckout: gitCheckoutMock,
        gitBranchCreate: gitBranchCreateMock,
        gitWorktreeInspect: gitWorktreeInspectMock,
        gitWorktreeRemove: gitWorktreeRemoveMock,
        gitBranchWorktreeInspect: gitBranchWorktreeInspectMock,
        gitBranchWorktreeCreate: gitBranchWorktreeCreateMock,
        gitBranchWorktreeRemove: gitBranchWorktreeRemoveMock,
      },
      getAppState: () => ({
        selectedGroupId: 'group-main',
        selectedProjectId: 'web',
        projectGroups: [],
        getProjectById: (projectId: string) => projectPaths.get(projectId),
      }),
      getArchitectPlan: getArchitectPlanMock,
      updateArchitectPlan: updateArchitectPlanMock,
      archiveArchitectPlan: archiveArchitectPlanMock,
      deleteArchitectPlan: deleteArchitectPlanMock,
      getGitFlowBaseBranch: () => 'develop',
    });

    const review = await staleGroupsService.loadPlanReview({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(review.repositories.map((repository) => repository.repoPath)).toEqual(['/repos/web', '/repos/api']);
  });

  it('keeps explicit single-project git operations strict for unknown project ids', async () => {
    await expect(architectGitFlowService.mergeFeatureBranchIntoPlanBranch({
      projectId: 'session-project-ghost',
      branchName: 'feature/ghost',
      planBranchName: 'plan/checkout',
    })).rejects.toThrow('Unable to resolve repository path for project session-project-ghost.');
  });

  it('merges feature branches into the plan inside the integration worktree', async () => {
    await architectGitFlowService.mergeFeatureBranchIntoPlanBranch({
      projectId: 'web',
      branchName: 'feature/checkout/checkout-web',
      planBranchName: 'plan/checkout',
    });

    expect(gitBranchWorktreeCreateMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      worktreeKey: toPlanIntegrationWorktreeKey('web', 'plan/checkout'),
      branchName: 'plan/checkout',
      fromRef: 'develop',
      fallbackBranches: ['develop', 'main'],
    });
    expect(gitMergeMock).toHaveBeenCalledWith({
      repoPath: getExpectedIntegrationWorktreePath('web', '/repos/web', 'plan/checkout'),
      branchName: 'feature/checkout/checkout-web',
      intoBranch: 'plan/checkout',
    });
    expect(gitCheckoutMock).not.toHaveBeenCalled();
  });

  it('requires the plan to be archived before deleting it', async () => {
    currentPlan = {
      ...buildPlan(),
      status: 'draft',
    };

    await expect(architectGitFlowService.deletePlanAndCleanupBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
    })).rejects.toThrow('Archive the plan before deleting it.');

    expect(deleteArchitectPlanMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
  });

  it('refuses archived delete when cleanup preflight detects a dirty worktree', async () => {
    currentPlan = {
      ...buildPlan(),
      status: 'archived',
    };

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

  it('deletes an archived plan only after local cleanup succeeds', async () => {
    currentPlan = {
      ...buildPlan(),
      status: 'archived',
    };
    gitBranchListMock.mockImplementation(async (repoPath: string) => ({
      ...createGitBranches([
        'develop',
        'plan/checkout',
        repoPath === '/repos/web' ? 'feature/checkout/checkout-web' : 'feature/checkout/checkout-api',
      ]),
      remote: [
        { name: 'origin/plan/checkout', is_head: false, commit: 'remote-plan-sha' },
        {
          name: repoPath === '/repos/web'
            ? 'origin/feature/checkout/checkout-web'
            : 'origin/feature/checkout/checkout-api',
          is_head: false,
          commit: 'remote-feature-sha',
        },
      ],
    }));

    const result = await architectGitFlowService.deletePlanAndCleanupBranches({
      branchName: 'feature/implement',
      planId: 'plan-1',
    });

    expect(deleteArchitectPlanMock).toHaveBeenCalledWith({
      branchName: 'feature/implement',
      planId: 'plan-1',
      hardDelete: true,
    });
    expect(result.deletedBranches).toEqual([
      'feature/checkout/checkout-web',
      'plan/checkout',
      'feature/checkout/checkout-api',
      'plan/checkout',
    ]);
    expect(result.deletedWorktreeKeys).toEqual([
      toBranchWorktreeKey('web', 'feature/checkout/checkout-web'),
      toPlanIntegrationWorktreeKey('web', 'plan/checkout'),
      toBranchWorktreeKey('api', 'feature/checkout/checkout-api'),
      toPlanIntegrationWorktreeKey('api', 'plan/checkout'),
    ]);
    expect(gitBranchDeleteRemoteMock).not.toHaveBeenCalled();
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
