import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';

const actualArchitectPlanService = await import('../services/architectPlanService');
const actualArchitectGitFlowService = await import('../services/architectGitFlowService');
const actualArchitectGitNaming = await import('../services/architectGitNaming');
const actualServices = await import('../services');
const actualTauriIpc = await import('../services/tauriIpc');

let isolatedTaskStoreImportCounter = 0;

let planState = {
  id: 'plan-1',
  slug: 'plan-1',
  title: 'Plan 1',
  label: undefined,
  description: 'Plan description',
  status: 'in_progress' as const,
  targetBranch: 'develop',
  targetBranchesByProjectId: { 'project-1': 'develop' },
  projectId: 'project-1',
  projectIds: ['project-1'],
  contextProjectIds: [],
  createdAt: '2026-04-22T09:00:00.000Z',
  updatedAt: '2026-04-22T09:00:00.000Z',
  nodes: [
    {
      id: 'task-1',
      title: 'Task 1',
      description: 'Task description',
      type: 'task' as const,
      status: 'in-progress' as 'in-progress' | 'completed',
      dependencies: [],
      assignedBranch: 'feature/task-1',
      projectId: 'project-1',
      projectIds: ['project-1'],
      todos: undefined as
        | Array<{ id: string; title: string; status: 'pending' | 'in-progress' | 'done' }>
        | undefined,
      archivedAt: null as string | null,
      archiveReason: null as 'merged' | null,
      mergedAt: null as string | null,
    },
  ],
  predictedBranches: [],
};

const mergeFeatureBranchIntoPlanBranchMock = mock(async ({
  branchName,
  planBranchName,
}: {
  branchName: string;
  planBranchName: string;
}) => `merged ${branchName} into ${planBranchName}`);
const finalizePlanIntoBaseBranchMock = mock(async () => ({
  plan: planState,
  repositories: [],
  cleanup: [],
}));
const getArchitectPlanMock = mock(async () => planState);
const updateArchitectPlanMock = mock(async (input: { nodes?: typeof planState.nodes }) => {
  if (input.nodes) {
    planState = {
      ...planState,
      nodes: input.nodes,
      updatedAt: '2026-04-22T10:00:00.000Z',
    };
  }
  return planState;
});
const commitArchitectPlanMetadataMock = mock(async () => undefined);
const writeArchitectTaskExecutionMock = mock(async () => undefined);
const gitWorktreeInspectMock = mock(async () => ({
  status: 'ready' as const,
  worktreePath: '/worktrees/task-1',
}));
const gitStatusMock = mock(async () => ({
  branch: 'feature/task-1',
  staged_files: [],
  unstaged_files: [],
  untracked_files: [],
  is_clean: true,
}));
const gitDiffMock = mock(async () => 'diff --git a/src/task.ts b/src/task.ts');
const gitWorktreeRemoveMock = mock(async () => ({
  removed: true,
  removedPath: '/worktrees/task-1',
}));
const gitBranchWorktreeCreateMock = mock(async (params: { repoPath: string; worktreeKey: string; branchName: string }) => ({
  worktreeKey: params.worktreeKey,
  worktreePath: `${params.repoPath}/.macro/worktrees/integration-${params.worktreeKey}`,
  branchName: params.branchName,
  status: 'reused' as const,
}));
const gitBranchListMock = mock(async (): Promise<{
  local: Array<{ name: string; is_head: boolean; commit: string }>;
  remote: Array<{ name: string; is_head: boolean; commit: string }>;
  current: string;
}> => ({
  local: [{ name: 'feature/task-1', is_head: false, commit: 'abc123' }],
  remote: [],
  current: 'develop',
}));
const gitCheckoutMock = mock(async () => undefined);
const gitMergeCheckMock = mock(async () => ({
  mergeable: true,
  conflictFiles: [] as string[],
  hasChanges: true,
}));
const gitFastForwardMock = mock(async () => 'Fast-forwarded plan/checkout');
const gitRebaseCheckMock = mock(async () => ({
  rebaseable: true,
  conflictFiles: [] as string[],
  output: 'Successfully rebased',
}));
const gitRebaseBranchMock = mock(async () => 'Successfully rebased');
const gitBranchDeleteMock = mock(async () => undefined);
const gitBranchDeleteRemoteMock = mock(async () => undefined);
const gitPullMock = mock(async () => undefined);
const fsReadFileWithOptionsMock = mock(async () => {
  throw new Error('not found');
});
const fsWriteFileMock = mock(async () => ({ bytesWritten: 0 }));
const workspaceGetActiveRootMock = mock(async () => '/repos/web');
const workspaceArchiveManualFeatureMock = mock(async () => undefined);
const workspaceUpdateStandaloneTaskStatusMock = mock(async () => undefined);
const syncTerminalDisplayMetadataMock = mock(async () => undefined);
const syncManualFeatureMetadataFromTaskMock = mock(async () => undefined);
const commitManualFeatureMetadataMock = mock(async () => undefined);
const removeManualFeatureMetadataMock = mock(async () => undefined);

const appStoreState = {
  selectedTaskId: 'task-1' as string | null,
  selectedProjectId: null as string | null,
  selectedGroupId: null as string | null,
  projectGroups: [],
  activeArchitectPlanId: 'plan-1' as string | null,
  activePlanContext: {
    id: 'plan-1',
    status: 'in_progress',
  },
  getProjectById: (_projectId: string) => ({
    id: 'project-1',
    name: 'Project One',
    path: '/repos/web',
  }),
  setSelectedTask: mock((taskId: string | null) => {
    appStoreState.selectedTaskId = taskId;
  }),
  setPlanNodes: mock((_nodes: unknown[]) => undefined),
  setPredictedBranches: mock((_branches: unknown[]) => undefined),
  setActivePlanContext: mock((context: unknown) => {
    appStoreState.activePlanContext = context as typeof appStoreState.activePlanContext;
  }),
  setActiveArchitectPlanId: mock((_planId: string | null) => undefined),
};

mock.module('../services/architectPlanService', () => ({
  ...actualArchitectPlanService,
  commitArchitectPlanMetadata: commitArchitectPlanMetadataMock,
  getArchitectPlan: getArchitectPlanMock,
  getArchitectPlanTargetBranchesByProjectId: (plan: typeof planState) =>
    plan.targetBranchesByProjectId || {},
  getGitFlowBaseBranch: () => 'develop',
  resolveTargetBranch: (branchName: string) => branchName,
  updateArchitectPlan: updateArchitectPlanMock,
  writeArchitectTaskExecution: writeArchitectTaskExecutionMock,
}));

mock.module('../services/architectPlanService.ts', () => ({
  ...actualArchitectPlanService,
  commitArchitectPlanMetadata: commitArchitectPlanMetadataMock,
  getArchitectPlan: getArchitectPlanMock,
  getArchitectPlanTargetBranchesByProjectId: (plan: typeof planState) =>
    plan.targetBranchesByProjectId || {},
  getGitFlowBaseBranch: () => 'develop',
  resolveTargetBranch: (branchName: string) => branchName,
  updateArchitectPlan: updateArchitectPlanMock,
  writeArchitectTaskExecution: writeArchitectTaskExecutionMock,
}));

mock.module('../services/architectGitFlowService', () => ({
  ...actualArchitectGitFlowService,
  finalizePlanIntoBaseBranch: finalizePlanIntoBaseBranchMock,
  mergeFeatureBranchIntoPlanBranch: mergeFeatureBranchIntoPlanBranchMock,
}));

mock.module('../services/architectGitFlowService.ts', () => ({
  ...actualArchitectGitFlowService,
  finalizePlanIntoBaseBranch: finalizePlanIntoBaseBranchMock,
  mergeFeatureBranchIntoPlanBranch: mergeFeatureBranchIntoPlanBranchMock,
}));

mock.module('../services/architectGitNaming', () => ({
  ...actualArchitectGitNaming,
  shouldSyncTargetBranchBeforeFinish: () => false,
}));

mock.module('../services/architectGitNaming.ts', () => ({
  ...actualArchitectGitNaming,
  shouldSyncTargetBranchBeforeFinish: () => false,
}));

mock.module('../services/tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  gitWorktreeInspect: gitWorktreeInspectMock,
  gitStatus: gitStatusMock,
  gitDiff: gitDiffMock,
  gitCheckout: gitCheckoutMock,
  gitMergeCheck: gitMergeCheckMock,
  gitFastForward: gitFastForwardMock,
  gitRebaseCheck: gitRebaseCheckMock,
  gitRebaseBranch: gitRebaseBranchMock,
  gitBranchWorktreeCreate: gitBranchWorktreeCreateMock,
  gitWorktreeRemove: gitWorktreeRemoveMock,
  gitBranchList: gitBranchListMock,
  gitBranchDelete: gitBranchDeleteMock,
  gitBranchDeleteRemote: gitBranchDeleteRemoteMock,
  gitPull: gitPullMock,
  fsReadFileWithOptions: fsReadFileWithOptionsMock,
  fsWriteFile: fsWriteFileMock,
  workspaceGetActiveRoot: workspaceGetActiveRootMock,
  workspaceArchiveManualFeature: workspaceArchiveManualFeatureMock,
  workspaceUpdateStandaloneTaskStatus: workspaceUpdateStandaloneTaskStatusMock,
}));

mock.module('../services/tauriIpc.ts', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  gitWorktreeInspect: gitWorktreeInspectMock,
  gitStatus: gitStatusMock,
  gitDiff: gitDiffMock,
  gitCheckout: gitCheckoutMock,
  gitMergeCheck: gitMergeCheckMock,
  gitFastForward: gitFastForwardMock,
  gitRebaseCheck: gitRebaseCheckMock,
  gitRebaseBranch: gitRebaseBranchMock,
  gitBranchWorktreeCreate: gitBranchWorktreeCreateMock,
  gitWorktreeRemove: gitWorktreeRemoveMock,
  gitBranchList: gitBranchListMock,
  gitBranchDelete: gitBranchDeleteMock,
  gitBranchDeleteRemote: gitBranchDeleteRemoteMock,
  gitPull: gitPullMock,
  fsReadFileWithOptions: fsReadFileWithOptionsMock,
  fsWriteFile: fsWriteFileMock,
  workspaceGetActiveRoot: workspaceGetActiveRootMock,
  workspaceArchiveManualFeature: workspaceArchiveManualFeatureMock,
  workspaceUpdateStandaloneTaskStatus: workspaceUpdateStandaloneTaskStatusMock,
}));

mock.module('./useAppStore', () => ({
  useAppStore: {
    getState: () => appStoreState,
    subscribe: () => () => undefined,
  },
}));

mock.module('./useTerminalStore', () => ({
  useTerminalStore: {
    getState: () => ({
      syncTerminalDisplayMetadata: syncTerminalDisplayMetadataMock,
    }),
  },
}));

mock.module('../services/manualFeatureMetadataService', () => ({
  syncManualFeatureMetadataFromTask: syncManualFeatureMetadataFromTaskMock,
  commitManualFeatureMetadata: commitManualFeatureMetadataMock,
  removeManualFeatureMetadata: removeManualFeatureMetadataMock,
}));

const loadIsolatedTaskStore = async () => {
  isolatedTaskStoreImportCounter += 1;
  return import(`./useTaskStore.ts?finish-task=${isolatedTaskStoreImportCounter}`);
};

const buildArchitectTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  plan_id: 'plan-1',
  project_id: 'project-1',
  project_ids: ['project-1'],
  title: 'Task 1',
  description: 'Task description',
  status: 'InReview',
  dependencies: [],
  estimated_changes: [],
  assigned_branch: 'feature/task-1',
  branch_name: 'feature/task-1',
  branch_id: null,
  branch_task_index: 0,
  blocked_by_task_ids: [],
  blocked_by: [],
  is_blocked: false,
  is_ready: false,
  sequence_index: 0,
  execution_targets: [
    {
      projectId: 'project-1',
      branchName: 'feature/task-1',
      worktreeKey: 'repo-1',
      repoPath: '/repos/web',
      planBranchName: 'plan/checkout',
      targetBranchName: 'develop',
    },
  ],
  task_source: 'architect',
  plan_title: 'Plan 1',
  plan_status: 'in_progress',
  plan_target_branch: 'develop',
  plan_target_branches_by_project_id: { 'project-1': 'develop' },
  has_mixed_target_branches: false,
  draft: false,
  standalone_kind: 'legacy',
  base_branch: null,
  feature_slug: null,
  conversation_id: null,
  archived_at: null,
  archive_reason: null,
  merged_at: null,
  needs_revalidation: false,
  ...overrides,
});

const listTasksMock = mock(async () => ({
  tasks: [
    buildArchitectTask({
      status: planState.nodes[0]?.status === 'completed' ? 'Completed' : 'InReview',
      archived_at: planState.nodes[0]?.archivedAt ?? null,
      archive_reason: planState.nodes[0]?.archiveReason ?? null,
      merged_at: planState.nodes[0]?.mergedAt ?? null,
    }),
  ],
  plans: [],
  hasStandaloneTasks: false,
  source: 'desktop',
}));

mock.module('../services', () => ({
  ...actualServices,
  services: {
    ...actualServices.services,
    listTasks: listTasksMock,
  },
}));

mock.module('../services/index', () => ({
  ...actualServices,
  services: {
    ...actualServices.services,
    listTasks: listTasksMock,
  },
}));

describe('useTaskStore.finishTask', () => {
  beforeEach(() => {
    installTauriRuntimeMock();

    planState = {
      id: 'plan-1',
      slug: 'plan-1',
      title: 'Plan 1',
      label: undefined,
      description: 'Plan description',
      status: 'in_progress',
      targetBranch: 'develop',
      targetBranchesByProjectId: { 'project-1': 'develop' },
      projectId: 'project-1',
      projectIds: ['project-1'],
      contextProjectIds: [],
      createdAt: '2026-04-22T09:00:00.000Z',
      updatedAt: '2026-04-22T09:00:00.000Z',
      nodes: [
        {
          id: 'task-1',
          title: 'Task 1',
          description: 'Task description',
          type: 'task',
          status: 'in-progress',
          dependencies: [],
          assignedBranch: 'feature/task-1',
          projectId: 'project-1',
          projectIds: ['project-1'],
          todos: undefined,
          archivedAt: null,
          archiveReason: null,
          mergedAt: null,
        },
      ],
      predictedBranches: [],
    };

    mergeFeatureBranchIntoPlanBranchMock.mockClear();
    finalizePlanIntoBaseBranchMock.mockClear();
    getArchitectPlanMock.mockClear();
    updateArchitectPlanMock.mockClear();
    commitArchitectPlanMetadataMock.mockClear();
    writeArchitectTaskExecutionMock.mockClear();
    gitWorktreeInspectMock.mockClear();
    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    gitBranchWorktreeCreateMock.mockClear();
    gitWorktreeRemoveMock.mockClear();
    gitWorktreeRemoveMock.mockImplementation(async () => ({
      removed: true,
      removedPath: '/worktrees/task-1',
    }));
    gitBranchListMock.mockClear();
    gitBranchListMock.mockImplementation(async () => ({
      local: [{ name: 'feature/task-1', is_head: false, commit: 'abc123' }],
      remote: [],
      current: 'develop',
    }));
    gitBranchDeleteMock.mockClear();
    gitBranchDeleteMock.mockImplementation(async () => undefined);
    gitBranchDeleteRemoteMock.mockClear();
    gitBranchDeleteRemoteMock.mockImplementation(async () => undefined);
    gitCheckoutMock.mockClear();
    gitMergeCheckMock.mockClear();
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 1,
    }));
    gitFastForwardMock.mockClear();
    gitRebaseCheckMock.mockClear();
    gitRebaseBranchMock.mockClear();
    gitPullMock.mockClear();
    workspaceArchiveManualFeatureMock.mockClear();
    workspaceUpdateStandaloneTaskStatusMock.mockClear();
    syncTerminalDisplayMetadataMock.mockClear();
    syncManualFeatureMetadataFromTaskMock.mockClear();
    commitManualFeatureMetadataMock.mockClear();
    removeManualFeatureMetadataMock.mockClear();
    listTasksMock.mockClear();
    appStoreState.selectedTaskId = 'task-1';
    appStoreState.activeArchitectPlanId = 'plan-1';
    appStoreState.activePlanContext = {
      id: 'plan-1',
      status: 'in_progress',
    };
    appStoreState.setSelectedTask.mockClear();
    appStoreState.setPlanNodes.mockClear();
    appStoreState.setPredictedBranches.mockClear();
    appStoreState.setActivePlanContext.mockClear();
    appStoreState.setActiveArchitectPlanId.mockClear();
  });

  afterEach(() => {
    removeTauriRuntimeMock();
  });

  it('archives architect tasks after merging them into the plan branch', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => {
      useTaskStore.setState({
        tasks: [
          buildArchitectTask({
            status: planState.nodes[0]?.status === 'completed' ? 'Completed' : 'InReview',
            archived_at: planState.nodes[0]?.archivedAt ?? null,
            archive_reason: planState.nodes[0]?.archiveReason ?? null,
            merged_at: planState.nodes[0]?.mergedAt ?? null,
          }),
        ] as never[],
      });
    });

    useTaskStore.setState({
      tasks: [buildArchitectTask()] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      refreshFromPlan: refreshFromPlanMock,
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1');

    expect(mergeFeatureBranchIntoPlanBranchMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      branchName: 'feature/task-1',
      planBranchName: 'plan/checkout',
      repoPath: '/repos/web',
    });
    expect(planState.nodes[0]?.status).toBe('completed');
    expect(planState.nodes[0]?.archiveReason).toBe('merged');
    expect(typeof planState.nodes[0]?.archivedAt).toBe('string');
    expect(typeof planState.nodes[0]?.mergedAt).toBe('string');
    expect(useTaskStore.getState().getTaskById('task-1')).toMatchObject({
      status: 'Completed',
      archived_at: planState.nodes[0]?.archivedAt,
      archive_reason: 'merged',
      merged_at: planState.nodes[0]?.mergedAt,
    });
    expect(writeArchitectTaskExecutionMock).toHaveBeenCalledTimes(1);
    expect(commitArchitectPlanMetadataMock).toHaveBeenCalledTimes(1);
    expect(appStoreState.setSelectedTask).toHaveBeenCalledWith(null);
  });

  it('blocks architect task completion while task todos remain open', async () => {
    planState = {
      ...planState,
      nodes: [
        {
          ...planState.nodes[0],
          todos: [
            { id: 'todo-1', title: 'Wire the checkout API', status: 'done' },
            { id: 'todo-2', title: 'Update the branch view', status: 'pending' },
          ],
        },
      ],
    };
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [
        buildArchitectTask({
          status: 'InReview',
          todos: [
            { id: 'todo-1', title: 'Wire the checkout API', status: 'done' },
            { id: 'todo-2', title: 'Update the branch view', status: 'pending' },
          ],
        }),
      ] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1')).rejects.toThrow(
      'Update the branch view',
    );

    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
    expect(gitMergeCheckMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().lastError).toContain('Update the branch view');
  });

  it('blocks architect task completion with fresh plan todos when the task snapshot is stale', async () => {
    planState = {
      ...planState,
      nodes: [
        {
          ...planState.nodes[0],
          todos: [{ id: 'todo-1', title: 'Fresh plan todo', status: 'pending' }],
        },
      ],
    };
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [
        buildArchitectTask({
          status: 'InReview',
          todos: [{ id: 'todo-1', title: 'Stale done todo', status: 'done' }],
        }),
      ] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1')).rejects.toThrow(
      'Fresh plan todo',
    );

    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().lastError).toContain('Fresh plan todo');
  });

  it('blocks direct completed status with fresh plan todos when the task snapshot is stale', async () => {
    planState = {
      ...planState,
      nodes: [
        {
          ...planState.nodes[0],
          todos: [{ id: 'todo-1', title: 'Direct status blocker', status: 'pending' }],
        },
      ],
    };
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [
        buildArchitectTask({
          status: 'InReview',
          todos: [{ id: 'todo-1', title: 'Stale done todo', status: 'done' }],
        }),
      ] as never[],
      lastError: null,
    });

    await useTaskStore.getState().setTaskStatus('task-1', 'Completed');

    expect(useTaskStore.getState().lastError).toContain('Direct status blocker');
    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe('InReview');
  });

  it('does not block legacy architect task completion when todos were never generated', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 0,
    }));
    planState = {
      ...planState,
      nodes: [
        {
          ...planState.nodes[0],
          todos: undefined,
        },
      ],
    };
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [
        buildArchitectTask({
          status: 'InReview',
          todos: undefined,
        }),
      ] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1', {
      mergeStrategyAction: 'fast_forward',
    });

    expect(useTaskStore.getState().lastError).toBeNull();
    expect(useTaskStore.getState().getTaskById('task-1')).toMatchObject({
      status: 'Completed',
    });
  });

  it('uses fast-forward when the merge workflow action requests it', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 0,
    }));
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask()] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1', {
      mergeStrategyAction: 'fast_forward',
    });

    expect(gitFastForwardMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      sourceBranch: 'feature/task-1',
      targetBranch: 'plan/checkout',
    });
    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchName: 'feature/task-1',
      force: true,
    });
  });

  it('completes an in-progress task after a successful merge workflow', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 0,
    }));
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask({ status: 'InProgress' })] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1', {
      mergeStrategyAction: 'fast_forward',
    });

    expect(useTaskStore.getState().lastError).toBeNull();
    expect(useTaskStore.getState().getTaskById('task-1')).toMatchObject({
      status: 'Completed',
    });
  });

  it('rebases a local branch then fast-forwards when requested', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 1,
    }));
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask()] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1', {
      mergeStrategyAction: 'rebase_then_continue',
    });

    expect(gitRebaseBranchMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      branchName: 'feature/task-1',
      ontoBranch: 'plan/checkout',
      confirm: true,
    });
    expect(gitFastForwardMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      sourceBranch: 'feature/task-1',
      targetBranch: 'plan/checkout',
    });
    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchName: 'feature/task-1',
      force: true,
    });
  });

  it('does not fail a completed merge when branch cleanup fails after integration', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 0,
    }));
    gitBranchListMock.mockImplementation(async () => ({
      local: [{ name: 'feature/task-1', is_head: false, commit: 'abc123' }],
      remote: [{ name: 'origin/feature/task-1', is_head: false, commit: 'abc123' }],
      current: 'develop',
    }));
    gitBranchDeleteMock.mockImplementationOnce(async () => {
      throw new Error('not merged into current HEAD');
    });
    gitBranchDeleteRemoteMock.mockImplementationOnce(async () => {
      throw new Error('remote delete failed');
    });

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask()] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1', {
      mergeStrategyAction: 'fast_forward',
    });

    expect(gitFastForwardMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      sourceBranch: 'feature/task-1',
      targetBranch: 'plan/checkout',
    });
    expect(gitBranchDeleteMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchName: 'feature/task-1',
      force: true,
    });
    expect(gitBranchDeleteRemoteMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchName: 'feature/task-1',
    });
    expect(useTaskStore.getState().getTaskById('task-1')).toMatchObject({
      status: 'Completed',
    });
  });

  it('keeps worktree removal failures blocking during post-merge cleanup', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 0,
    }));
    gitWorktreeRemoveMock.mockImplementationOnce(async () => {
      throw new Error('worktree still locked');
    });

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask()] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1', {
      mergeStrategyAction: 'fast_forward',
    })).rejects.toThrow('worktree still locked');

    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
  });

  it('keeps architect tasks open when the merge workflow is blocked', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: false,
      conflictFiles: ['src/task.ts'],
      hasChanges: true,
    }));

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask()] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1')).rejects.toMatchObject({
      message: expect.stringContaining('Resolve the repository blockers'),
    });

    const taskRuntime = useTaskStore.getState().getMergeWorkflowRuntime('task-1');
    expect(taskRuntime).not.toBeNull();
    expect(taskRuntime?.phase).toBe('blocked');
    expect(taskRuntime?.blockedRepositories).toHaveLength(1);
    expect(taskRuntime?.blockedRepositories[0]?.conflictFiles).toEqual(['src/task.ts']);
    expect(useTaskStore.getState().getTaskById('task-1')).toMatchObject({
      status: 'Blocked',
      archived_at: null,
    });
    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
    expect(planState.nodes[0]?.status).toBe('in-progress');
    expect(planState.nodes[0]?.archivedAt).toBeNull();
    expect(writeArchitectTaskExecutionMock).not.toHaveBeenCalled();
  });

  it('blocks completion when another active architect task still shares the branch', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [
        buildArchitectTask(),
        buildArchitectTask({
          id: 'task-2',
          title: 'Task 2',
          status: 'Pending',
          execution_targets: [
            {
              projectId: 'project-1',
              branchName: 'feature/task-1',
              worktreeKey: 'repo-2',
              repoPath: '/repos/web',
              planBranchName: 'plan/checkout',
              targetBranchName: 'develop',
            },
          ],
        }),
      ] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1')).rejects.toThrow(
      'still assigned to active task(s): Task 2',
    );

    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
  });

  it('refuses to run plan finalization while architect tasks are unfinished', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const finalizationTaskId = 'plan-finalization:plan-1';
    useTaskStore.setState({
      tasks: [
        buildArchitectTask({ status: 'Pending' }),
        buildArchitectTask({
          id: finalizationTaskId,
          title: 'Finalize plan: Plan 1',
          status: 'Blocked',
          task_source: 'plan_finalization',
          assigned_branch: 'develop',
          branch_name: 'develop',
          branch_task_index: Number.MAX_SAFE_INTEGER,
          dependencies: ['task-1'],
          blocked_by_task_ids: ['task-1'],
          blocked_by: ['Task 1'],
          is_blocked: true,
          is_ready: false,
          execution_targets: [
            {
              projectId: 'project-1',
              branchName: 'develop',
              targetBranchName: 'develop',
              executionKind: 'repository_root',
              worktreeKey: 'plan-finalization:project-1:project-1',
              repoPath: '/repos/web',
            },
          ],
        }),
      ] as never[],
      lastError: null,
    });

    await expect(useTaskStore.getState().runMergeWorkflow(finalizationTaskId)).rejects.toThrow(
      'Plan finalization is blocked by unfinished Architect tasks: Task 1',
    );

    expect(useTaskStore.getState().lastError).toBe(
      'Plan finalization is blocked by unfinished Architect tasks: Task 1',
    );
    expect(finalizePlanIntoBaseBranchMock).not.toHaveBeenCalled();
    expect(gitMergeCheckMock).not.toHaveBeenCalled();
  });
});
