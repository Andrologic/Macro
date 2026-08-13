import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
const actualTauriIpc = await import('./tauriIpc');

type MockAppState = {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: Array<{
    id: string;
    name: string;
    isOpen: boolean;
    projects: Array<{
      id: string;
      name: string;
      mountName: string;
      path: string;
    }>;
  }>;
};

const appState: MockAppState = {
  selectedGroupId: 'group-main',
  selectedProjectId: 'web',
  projectGroups: [
    {
      id: 'group-main',
      name: 'Main',
      isOpen: true,
      projects: [
        {
          id: 'web',
          name: 'Web',
          mountName: 'web',
          path: '/repos/web',
        },
      ],
    },
  ],
};

const workspaceFiles = new Map<string, Map<string, string>>();
let importCounter = 0;
let originalConsoleInfo: typeof console.info;
const gitWorktreeInspectMock = mock(
  async (params: { repoPath: string; taskId: string; branchName?: string | null }) => ({
    taskId: params.taskId,
    worktreePath: `${params.repoPath}/.macro/worktrees/task${params.taskId}`,
    branchName: params.branchName ?? 'develop',
    status: 'ready' as const,
    isDirty: false,
  })
);
const gitBranchWorktreeInspectMock = mock(
  async (params: { repoPath: string; worktreeKey: string; branchName?: string | null }) => ({
    worktreeKey: params.worktreeKey,
    worktreePath: `${params.repoPath}/.macro/worktrees/${params.worktreeKey}`,
    branchName: params.branchName ?? 'develop',
    status: 'ready' as const,
    isDirty: false,
  })
);

const normalizeFsPath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');

const ensureWorkspace = (workspacePath?: string | null): Map<string, string> => {
  const key = (workspacePath && workspacePath.trim() ? workspacePath : '__workspace__')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const workspace = workspaceFiles.get(key);
  if (workspace) {
    return workspace;
  }
  const next = new Map<string, string>();
  workspaceFiles.set(key, next);
  return next;
};

const writeWorkspaceFile = (workspacePath: string | null | undefined, path: string, content: string): void => {
  ensureWorkspace(workspacePath).set(normalizeFsPath(path), content);
};

const writeWorkspaceJson = (workspacePath: string | null | undefined, path: string, value: unknown): void => {
  writeWorkspaceFile(workspacePath, path, JSON.stringify(value, null, 2));
};

const readWorkspaceFile = (workspacePath: string | null | undefined, path: string): string | null =>
  ensureWorkspace(workspacePath).get(normalizeFsPath(path)) ?? null;

const deleteWorkspacePrefix = (workspacePath: string | null | undefined, path: string): void => {
  const prefix = normalizeFsPath(path);
  const workspace = ensureWorkspace(workspacePath);
  for (const key of workspace.keys()) {
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      workspace.delete(key);
    }
  }
};

const listWorkspaceFiles = (
  workspacePath: string | null | undefined,
  path: string
): Array<{ kind: 'file'; relative_path: string }> => {
  const prefix = normalizeFsPath(path);
  const normalizedPrefix = prefix.length > 0 ? `${prefix}/` : '';
  return Array.from(ensureWorkspace(workspacePath).keys())
    .filter((key) => key.startsWith(normalizedPrefix))
    .map((key) => ({
      kind: 'file' as const,
      relative_path: key.slice(normalizedPrefix.length),
    }));
};

const buildStoredPlan = () => ({
  id: 'plan-1',
  slug: 'checkout',
  title: 'Checkout',
  description: 'Stored with a stale session project id.',
  status: 'validated',
  targetBranch: 'develop',
  projectId: 'web',
  projectIds: ['web', 'session-project-ghost'],
  createdAt: '2026-03-15T00:00:00.000Z',
  updatedAt: '2026-03-16T00:00:00.000Z',
  nodes: [
    {
      id: 'task-web',
      title: 'Build checkout UI',
      type: 'task',
      status: 'completed',
      dependencies: [],
      assignedBranch: 'feature/checkout/checkout-web',
      projectId: 'web',
      projectIds: ['web', 'session-project-ghost'],
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
      id: 'branch-ghost',
      name: 'feature/ghost',
      color: '#000000',
      parentBranch: 'plan/checkout',
      projectId: 'session-project-ghost',
      taskIds: ['task-web'],
      status: 'planned',
    },
  ],
});

const seedReplica = (plan = buildStoredPlan()): void => {
  writeWorkspaceJson('/repos/web', 'branches/develop/plans/index.json', {
    version: 2,
    activePlanId: plan.id,
    plans: [
      {
        id: plan.id,
        slug: plan.slug,
        title: plan.title,
        description: plan.description,
        status: plan.status,
        targetBranch: plan.targetBranch,
        projectId: plan.projectId,
        projectIds: plan.projectIds,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        nodeCount: plan.nodes.length,
      },
    ],
    reservedPlanSlugs: [plan.slug],
  });
  writeWorkspaceJson('/repos/web', `branches/develop/plans/${plan.id}/plan.json`, plan);
};

const gitStatusMock = mock(async () => ({
  branch: 'develop',
  head_commit: null,
  staged_files: [],
  unstaged_files: [],
  untracked_files: [],
  conflicted_files: [],
  conflictedFiles: [],
  merge_in_progress: false,
  mergeInProgress: false,
  modified_files: [],
  is_clean: true,
  ahead: 0,
  behind: 0,
}));
const gitDiffMock = mock(async () => 'diff --git a/file.ts b/file.ts');
const gitMergeCheckMock = mock(async () => ({
  mergeable: true,
  conflictFiles: [],
  hasChanges: true,
}));
const gitPullMock = mock(async () => ({
  branch: 'develop',
  remote: 'origin',
  output: 'Already up to date.',
}));
const gitMergeMock = mock(async () => 'merge-ok');
const gitBranchListMock = mock(async () => ({
  current: 'develop',
  local: [
    { name: 'develop', is_head: true, commit: 'develop-sha' },
    { name: 'plan/checkout', is_head: false, commit: 'plan-sha' },
    { name: 'feature/checkout/checkout-web', is_head: false, commit: 'feature-sha' },
  ],
  remote: [],
}));
const gitBranchDeleteMock = mock(async () => undefined);
const gitCheckoutMock = mock(async () => undefined);
const gitBranchCreateMock = mock(async () => undefined);
const dbAppSettings = new Map<string, string>();
const dbGetAppSettingMock = mock(async (key: string) => {
  const valueJson = dbAppSettings.get(key);
  return valueJson === undefined
    ? null
    : { key, value_json: valueJson, updated_at: '2026-08-13T00:00:00.000Z' };
});
const dbSetAppSettingMock = mock(async ({ key, valueJson }: { key: string; valueJson: string }) => {
  dbAppSettings.set(key, valueJson);
  return { key, value_json: valueJson, updated_at: '2026-08-13T00:00:00.000Z' };
});
const gitWorktreeRemoveMock = mock(async (params: { repoPath: string; taskId: string; branchName?: string | null }) => ({
  taskId: params.taskId,
  worktreePath: `${params.repoPath}/.macro/worktrees/task${params.taskId}`,
  removedPath: true,
  prunedRegistration: true,
  alreadyAbsent: false,
}));
const gitBranchWorktreeRemoveMock = mock(
  async (params: { repoPath: string; worktreeKey: string; branchName: string }) => ({
    worktreeKey: params.worktreeKey,
    worktreePath: `${params.repoPath}/.macro/worktrees/${params.worktreeKey}`,
    branchName: params.branchName,
    removedPath: true,
    prunedRegistration: true,
    alreadyAbsent: false,
  })
);

const registerModuleMocks = () => {
  mock.restore();

  mock.module('./tauriIpc', () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => true,
    dbGetAppSetting: dbGetAppSettingMock,
    dbSetAppSetting: dbSetAppSettingMock,
    workspaceGetActiveRoot: async () => '/repos/web',
    macroBranchCommitIfDirty: async () => ({
      branch: '@macro',
      state: 'clean',
      worktree_path: '/repos/web/.git/macro-metadata-worktree',
      is_dirty: false,
      has_origin: false,
      has_upstream: false,
      ahead: 0,
      behind: 0,
      conflicted_files: [],
      committed: false,
      commit_hash: null,
      reason: null,
      next_action: null,
      output: null,
      error: null,
    }),
    fsReadFileWithOptions: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => {
      const content = readWorkspaceFile(workspacePath, path);
      if (content === null) {
        throw new Error(`Missing file: ${workspacePath ?? 'local'}:${path}`);
      }
      return {
        content,
        language: path.endsWith('.json') ? 'json' : 'text',
        is_binary: false,
        size: content.length,
        encoding: 'utf-8',
      };
    },
    fsWriteFile: async ({
      path,
      content,
      workspacePath,
    }: {
      path: string;
      content: string;
      workspacePath?: string | null;
    }) => {
      writeWorkspaceFile(workspacePath, path, content);
      return {
        path,
        bytes_written: content.length,
        created: true,
      };
    },
    fsDelete: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => {
      deleteWorkspacePrefix(workspacePath, path);
    },
    fsListDir: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => listWorkspaceFiles(workspacePath, path),
    gitStatus: gitStatusMock,
    gitDiff: gitDiffMock,
    gitMergeCheck: gitMergeCheckMock,
    gitPull: gitPullMock,
    gitMerge: gitMergeMock,
    gitBranchList: gitBranchListMock,
    gitBranchDelete: gitBranchDeleteMock,
    gitCheckout: gitCheckoutMock,
    gitBranchCreate: gitBranchCreateMock,
    gitWorktreeInspect: gitWorktreeInspectMock,
    gitBranchWorktreeInspect: gitBranchWorktreeInspectMock,
    gitWorktreeRemove: gitWorktreeRemoveMock,
    gitBranchWorktreeRemove: gitBranchWorktreeRemoveMock,
  }));

  const appStoreState = {
    ...appState,
    getProjectById: (projectId: string) =>
      appState.projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId) || null,
  };

  mock.module('../stores/useAppStore', () => ({
    useAppStore: Object.assign(
      <TSelected = typeof appStoreState>(
        selector?: (state: typeof appStoreState) => TSelected
      ) =>
        selector
          ? selector(appStoreState)
          : (appStoreState as unknown as TSelected),
      {
        getState: () => appStoreState,
        setState: (
          patch:
            | Partial<typeof appStoreState>
            | ((state: typeof appStoreState) => Partial<typeof appStoreState>)
        ) => {
          Object.assign(
            appStoreState,
            typeof patch === 'function' ? patch(appStoreState) : patch
          );
        },
        subscribe: () => () => undefined,
      }
    ),
  }));
};

const loadIntegrationModules = async () => {
  registerModuleMocks();
  importCounter += 1;
  const planService = await import(`./architectPlanService.ts?gitflow-replica=${importCounter}`);
  const gitFlowService = await import(`./architectGitFlowService.ts?gitflow-replica=${importCounter}`);
  return {
    planService,
    gitFlowService,
  };
};

describe('architectGitFlowService replica integration', () => {
  beforeEach(() => {
    installTauriRuntimeMock();
    workspaceFiles.clear();
    dbAppSettings.clear();
    seedReplica();
    originalConsoleInfo = console.info;
    console.info = () => undefined;
    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    gitMergeCheckMock.mockClear();
    gitPullMock.mockClear();
    gitMergeMock.mockClear();
    gitBranchListMock.mockClear();
    gitBranchDeleteMock.mockClear();
    gitCheckoutMock.mockClear();
    gitBranchCreateMock.mockClear();
    dbGetAppSettingMock.mockClear();
    dbSetAppSettingMock.mockClear();
    gitWorktreeInspectMock.mockClear();
    gitBranchWorktreeInspectMock.mockClear();
    gitWorktreeRemoveMock.mockClear();
    gitBranchWorktreeRemoveMock.mockClear();
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
    removeTauriRuntimeMock();
    mock.restore();
  });

  it('does not fail closed during finalization when replica noise is only a stale session project id', async () => {
    const { planService, gitFlowService } = await loadIntegrationModules();
    const service = gitFlowService.createArchitectGitFlowService({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        gitMergeCheck: gitMergeCheckMock,
        gitPull: gitPullMock,
        gitMerge: gitMergeMock,
        gitBranchList: gitBranchListMock,
        gitBranchDelete: gitBranchDeleteMock,
        gitCheckout: gitCheckoutMock,
        gitBranchCreate: gitBranchCreateMock,
        gitWorktreeInspect: gitWorktreeInspectMock,
        gitBranchWorktreeInspect: gitBranchWorktreeInspectMock,
        gitWorktreeRemove: gitWorktreeRemoveMock,
        gitBranchWorktreeRemove: gitBranchWorktreeRemoveMock,
      },
      getAppState: () => ({
        selectedGroupId: 'group-main',
        selectedProjectId: 'web',
        projectGroups: appState.projectGroups,
        getProjectById: (projectId: string) =>
          appState.projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId) || null,
      }),
      getArchitectPlan: planService.getArchitectPlan,
      archiveArchitectPlan: async (branchName: string, planId: string) => {
        const plan = await planService.getArchitectPlan(branchName, planId);
        return {
          ...plan!,
          status: 'archived',
        };
      },
      updateArchitectPlan: async (params: { branchName: string; planId: string; status?: string }) => {
        const plan = await planService.getArchitectPlan(params.branchName, params.planId);
        return {
          ...plan!,
          status: params.status ?? plan?.status ?? 'validated',
        };
      },
      deleteArchitectPlan: async () => undefined,
      getGitFlowBaseBranch: () => 'develop',
    });

    const result = await service.finalizePlanIntoBaseBranch({
      branchName: 'develop',
      planId: 'plan-1',
    });

    expect(result.plan.projectIds).toEqual(['web']);
    expect(result.plan.predictedBranches).toHaveLength(1);
    expect(gitStatusMock).toHaveBeenCalled();
    expect(gitPullMock).toHaveBeenCalledTimes(1);
    expect(gitMergeCheckMock).toHaveBeenCalled();
    expect(gitMergeMock).toHaveBeenCalledTimes(1);
    expect(gitBranchDeleteMock).toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).toHaveBeenCalled();
    expect(gitBranchWorktreeRemoveMock).toHaveBeenCalled();

    const persistedPlan = JSON.parse(
      readWorkspaceFile('/repos/web', 'branches/develop/plans/plan-1/plan.json') || 'null'
    );
    expect(persistedPlan.projectIds).toEqual(['web']);
    expect(persistedPlan.predictedBranches).toHaveLength(1);
  });

  it('ignores stale expectedProjectIds when they are the only remaining metadata noise', async () => {
    const basePlan = buildStoredPlan();
    const noisyExpectedOnlyPlan = {
      ...basePlan,
      projectIds: ['web'],
      nodes: basePlan.nodes.map((node) => ({
        ...node,
        projectIds: ['web'],
      })),
      predictedBranches: basePlan.predictedBranches.filter((branch) => branch.projectId === 'web'),
      expectedProjectIds: ['web', 'session-project-ghost'],
    };
    seedReplica(noisyExpectedOnlyPlan);

    const { planService, gitFlowService } = await loadIntegrationModules();
    const service = gitFlowService.createArchitectGitFlowService({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        gitMergeCheck: gitMergeCheckMock,
        gitPull: gitPullMock,
        gitMerge: gitMergeMock,
        gitBranchList: gitBranchListMock,
        gitBranchDelete: gitBranchDeleteMock,
        gitCheckout: gitCheckoutMock,
        gitBranchCreate: gitBranchCreateMock,
        gitWorktreeInspect: gitWorktreeInspectMock,
        gitBranchWorktreeInspect: gitBranchWorktreeInspectMock,
        gitWorktreeRemove: gitWorktreeRemoveMock,
        gitBranchWorktreeRemove: gitBranchWorktreeRemoveMock,
      },
      getAppState: () => ({
        selectedGroupId: 'group-main',
        selectedProjectId: 'web',
        projectGroups: appState.projectGroups,
        getProjectById: (projectId: string) =>
          appState.projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId) || null,
      }),
      getArchitectPlan: planService.getArchitectPlan,
      archiveArchitectPlan: async (branchName: string, planId: string) => {
        const plan = await planService.getArchitectPlan(branchName, planId);
        return {
          ...plan!,
          status: 'archived',
        };
      },
      updateArchitectPlan: async (params: { branchName: string; planId: string; status?: string }) => {
        const plan = await planService.getArchitectPlan(params.branchName, params.planId);
        return {
          ...plan!,
          status: params.status ?? plan?.status ?? 'validated',
        };
      },
      deleteArchitectPlan: async () => undefined,
      getGitFlowBaseBranch: () => 'develop',
    });

    const review = await service.loadPlanReview({
      branchName: 'develop',
      planId: 'plan-1',
    });

    expect(review.repositories.map((repository: { projectId: string }) => repository.projectId)).toEqual(['web']);
    expect(gitStatusMock).toHaveBeenCalledWith('/repos/web');
  });
});
