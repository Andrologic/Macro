import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';

const actualArchitectPlanService = await import('../services/architectPlanService');
const actualArchitectGitFlowService = await import('../services/architectGitFlowService');
const actualArchitectGitNaming = await import('../services/architectGitNaming');
const actualServices = await import('../services');
const actualTauriIpc = await import('../services/tauriIpc');
type GitWorkflowRequest = Parameters<typeof actualTauriIpc.gitWorkflow>[0];
type GitWorkflowSession = Awaited<ReturnType<typeof actualTauriIpc.gitWorkflow>>;
type GitWorkflowCleanupRequest = Parameters<typeof actualTauriIpc.gitWorkflowCleanup>[0];
type GitWorktreeInspectRequest = Parameters<typeof actualTauriIpc.gitWorktreeInspect>[0];
type GitMergeCheckRequest = Parameters<typeof actualTauriIpc.gitMergeCheck>[0];
type GitDiffRequest = Parameters<typeof actualTauriIpc.gitDiff>[0];
type GitWorktreeRemoveRequest = Parameters<typeof actualTauriIpc.gitWorktreeRemove>[0];
type GitWorktreeCreateRequest = Parameters<typeof actualTauriIpc.gitWorktreeCreate>[0];
type GitBranchDeleteRequest = Parameters<typeof actualTauriIpc.gitBranchDelete>[0];
type GitBranchDeleteRemoteRequest = Parameters<typeof actualTauriIpc.gitBranchDeleteRemote>[0];
type GitBranches = Awaited<ReturnType<typeof actualTauriIpc.gitBranchList>>;

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
      artifactContracts: undefined as
        | Array<{ id: string; title: string; kind: string; required: boolean }>
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
const gitWorktreeInspectMock = mock(async (_params: GitWorktreeInspectRequest): Promise<Awaited<ReturnType<typeof actualTauriIpc.gitWorktreeInspect>>> => ({
  taskId: 'repo-1',
  worktreePath: '/worktrees/task-1',
  branchName: 'feature/task-1',
  status: 'ready',
  isDirty: false,
}));
const gitStatusMock = mock(async () => ({
  branch: 'feature/task-1',
  staged_files: [],
  unstaged_files: [],
  untracked_files: [],
  is_clean: true,
}));
const gitDiffMock = mock(async (_params?: GitDiffRequest) => 'diff --git a/src/task.ts b/src/task.ts');
const gitWorktreeRemoveMock = mock(async (_params?: GitWorktreeRemoveRequest) => ({
  removed: true,
  removedPath: '/worktrees/task-1',
}));
const gitWorktreeCreateMock = mock(async (params: GitWorktreeCreateRequest) => ({
  taskId: params.taskId,
  worktreePath: '/worktrees/task-1',
  branchName: params.branchName,
  createdByThisCall: false,
  status: 'reused' as const,
}));
const gitBranchWorktreeCreateMock = mock(async (params: { repoPath: string; worktreeKey: string; branchName: string }) => ({
  worktreeKey: params.worktreeKey,
  worktreePath: `${params.repoPath}/.macro/worktrees/integration-${params.worktreeKey}`,
  branchName: params.branchName,
  status: 'reused' as const,
}));
const gitBranchListMock = mock(async (_repoPath = '/repos/web'): Promise<GitBranches> => ({
  local: [{ name: 'feature/task-1', is_head: false, commit: 'abc123' }],
  remote: [],
  current: 'develop',
}));
const gitCheckoutMock = mock(async () => undefined);
const gitMergeCheckMock = mock(async (_params?: GitMergeCheckRequest) => ({
  mergeable: true,
  conflictFiles: [] as string[],
  hasChanges: true,
}));
const gitMergeMock = mock(async ({
  repoPath: _repoPath,
  branchName,
  intoBranch,
}: {
  repoPath: string;
  branchName: string;
  intoBranch: string;
}) => `Merged ${branchName} into ${intoBranch}`);
const gitFastForwardMock = mock(async (_params: {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
}) => 'Fast-forwarded plan/checkout');
const gitRebaseCheckMock = mock(async () => ({
  rebaseable: true,
  conflictFiles: [] as string[],
  output: 'Successfully rebased',
}));
const gitRebaseBranchMock = mock(async (_params: {
  repoPath: string;
  branchName: string;
  ontoBranch: string;
  confirm: boolean;
}) => 'Successfully rebased');
const gitBranchDeleteMock = mock(async (_params?: GitBranchDeleteRequest) => undefined);
const gitBranchDeleteRemoteMock = mock(async (_params?: GitBranchDeleteRemoteRequest) => undefined);
const gitWorkflowCleanupMock = mock(async (_params?: GitWorkflowCleanupRequest) => undefined);
const gitPullMock = mock(async () => undefined);
const gitWorkflowSessions = new Map<string, GitWorkflowSession>();
const worktreeInspectionOverrides = new Map<string, {
  status: 'ready' | 'absent';
  worktreePath?: string;
}>();
const runtimeFiles = new Map<string, { content: string; revision: string }>();
const runtimeSettings = new Map<string, string>();

const gitWorkflowRepoKey = (repoPath: string): string =>
  repoPath.replace(/\/\.macro\/worktrees\/integration-[^/]+$/, '');
const gitWorkflowKey = (params: Pick<GitWorkflowRequest, 'repoPath' | 'taskId' | 'sourceBranch' | 'targetBranch'>): string =>
  [gitWorkflowRepoKey(params.repoPath), params.taskId, params.sourceBranch, params.targetBranch].join('::');

const gitWorkflowMock = mock(async (params: GitWorkflowRequest): Promise<GitWorkflowSession | null> => {
  const key = gitWorkflowKey(params);
  if (params.action === 'inspect') {
    return gitWorkflowSessions.get(key) ?? null;
  }

  let output = 'Merge integrated.';
  if (params.action === 'merge_commit') {
    output = await gitMergeMock({
      repoPath: params.repoPath,
      branchName: params.sourceBranch,
      intoBranch: params.targetBranch,
    });
  } else if (params.action === 'fast_forward') {
    output = await gitFastForwardMock({
      repoPath: params.repoPath,
      sourceBranch: params.sourceBranch,
      targetBranch: params.targetBranch,
    });
  } else if (params.action === 'rebase_then_continue') {
    await gitRebaseBranchMock({
      repoPath: params.repoPath,
      branchName: params.sourceBranch,
      ontoBranch: params.targetBranch,
      confirm: true,
    });
    output = await gitFastForwardMock({
      repoPath: params.repoPath,
      sourceBranch: params.sourceBranch,
      targetBranch: params.targetBranch,
    });
  } else if (params.action === 'no_changes') {
    output = 'No changes; source is already integrated.';
  }

  const sourceCommit = params.sourceBranch === 'feature/task-1-api' ? 'def456' : 'abc123';

  const session: GitWorkflowSession = {
    taskId: params.taskId,
    sessionId: `session-${params.taskId}-${params.sourceBranch}-${params.targetBranch}`,
    sourceBranch: params.sourceBranch,
    targetBranch: params.targetBranch,
    sourceCommit,
    targetCommit: params.targetBranch === 'plan/checkout-api' ? 'target456' : 'target123',
    integratedCommit: params.targetBranch === 'plan/checkout-api' ? 'integrated456' : 'integrated123',
    status: 'integrated',
    output,
  };
  gitWorkflowSessions.set(key, session);
  return session;
});

const worktreeInspectionKey = (params: Pick<GitWorktreeInspectRequest, 'repoPath' | 'taskId'>): string =>
  `${params.repoPath}::${params.taskId}`;

gitWorktreeInspectMock.mockImplementation(async (params: GitWorktreeInspectRequest) => ({
  taskId: params.taskId,
  status: worktreeInspectionOverrides.get(worktreeInspectionKey(params))?.status ?? 'ready',
  worktreePath: worktreeInspectionOverrides.get(worktreeInspectionKey(params))?.worktreePath ?? '/worktrees/task-1',
  branchName: params.branchName ?? 'feature/task-1',
  isDirty: false,
}));

const runtimeFileKey = (params: {
  path?: string;
  workspacePath?: string | null;
  workspaceScope?: string;
}): string => [params.workspaceScope, params.workspacePath, params.path].join('::');

const createFilesystemNotFoundError = (): Error & { code: string } => {
  const error = new Error('not found') as Error & { code: string };
  error.code = 'FilesystemNotFound';
  return error;
};

const fsReadFileWithOptionsMock = mock(async (params?: {
  path?: string;
  workspacePath?: string | null;
  workspaceScope?: string;
}): Promise<{ content: string; revision?: string }> => {
  if (params?.path?.endsWith('/runtime.json')) {
    const file = runtimeFiles.get(runtimeFileKey(params));
    if (!file) throw createFilesystemNotFoundError();
    return file;
  }
  throw createFilesystemNotFoundError();
});
const fsExistsMock = mock(async (_path?: string): Promise<boolean> => false);
const fsWriteFileMock = mock(async (params?: {
  path?: string;
  content?: string;
  workspacePath?: string | null;
  workspaceScope?: string;
}) => {
  if (params?.path?.endsWith('/runtime.json') && typeof params.content === 'string') {
    const key = runtimeFileKey(params);
    const previousRevision = runtimeFiles.get(key)?.revision;
    const nextRevision = previousRevision ? `${previousRevision}-next` : 'runtime-revision-1';
    runtimeFiles.set(key, { content: params.content, revision: nextRevision });
  }
  return { bytesWritten: params?.content?.length ?? 0 };
});
const dbGetAppSettingMock = mock(async (key: string) => {
  const value = runtimeSettings.get(key);
  return value === undefined ? null : { key, value_json: value, updated_at: '' };
});
const dbCompareAndSwapAppSettingMock = mock(async (params: {
  key: string;
  expectedValueJson: string | null;
  valueJson: string;
}) => {
  if ((runtimeSettings.get(params.key) ?? null) !== params.expectedValueJson) {
    return { applied: false };
  }
  runtimeSettings.set(params.key, params.valueJson);
  return { applied: true };
});
const workspaceGetActiveRootMock = mock(async () => '/repos/web');
const workspaceArchiveManualFeatureMock = mock(async () => ({
  archivedAt: '2026-08-30T10:00:00.000Z',
} as Awaited<ReturnType<typeof actualTauriIpc.workspaceArchiveManualFeature>>));
const workspaceUpdateStandaloneTaskStatusMock = mock(async () => undefined);
const syncTerminalDisplayMetadataMock = mock(async () => undefined);
const syncManualFeatureMetadataFromTaskMock = mock(async () => undefined);
const commitManualFeatureMetadataMock = mock(async () => undefined);
const removeManualFeatureMetadataMock = mock(async () => undefined);
const configGetSnapshotMock = mock(async (projectIds: string[] = []) => ({
  projectEffective: Object.fromEntries(
    projectIds.map((projectId) => [projectId, { tools: { projectCommands: {} } }]),
  ),
}));

let projectCompletionMergePolicy: 'merge_commit' | 'fast_forward' = 'merge_commit';

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
  getProjectById: (projectId: string) => ({
    id: projectId,
    name: projectId === 'project-2' ? 'Project Two' : 'Project One',
    path: projectId === 'project-2' ? '/repos/api' : '/repos/web',
    gitSetupState: 'ready' as const,
    directEdit: false,
    gitFlowSettings: {
      baseBranch: 'develop',
      planBranchTemplate: 'plan/{slug}',
      taskBranchTemplate: 'feature/{slug}',
      defaultTaskBranchPrefix: 'feature/',
      completionMergePolicy: projectCompletionMergePolicy,
    },
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
  gitMerge: gitMergeMock,
  gitFastForward: gitFastForwardMock,
  gitRebaseCheck: gitRebaseCheckMock,
  gitRebaseBranch: gitRebaseBranchMock,
  gitWorkflow: gitWorkflowMock,
  gitBranchWorktreeCreate: gitBranchWorktreeCreateMock,
  gitWorktreeCreate: gitWorktreeCreateMock,
  gitWorktreeRemove: gitWorktreeRemoveMock,
  gitBranchList: gitBranchListMock,
  gitBranchDelete: gitBranchDeleteMock,
  gitBranchDeleteRemote: gitBranchDeleteRemoteMock,
  gitWorkflowCleanup: gitWorkflowCleanupMock,
  gitPull: gitPullMock,
  fsExists: fsExistsMock,
  fsReadFileWithOptions: fsReadFileWithOptionsMock,
  fsWriteFile: fsWriteFileMock,
  dbGetAppSetting: dbGetAppSettingMock,
  dbCompareAndSwapAppSetting: dbCompareAndSwapAppSettingMock,
  workspaceGetActiveRoot: workspaceGetActiveRootMock,
  workspaceArchiveManualFeature: workspaceArchiveManualFeatureMock,
  workspaceUpdateStandaloneTaskStatus: workspaceUpdateStandaloneTaskStatusMock,
  configGetSnapshot: configGetSnapshotMock,
}));

mock.module('../services/tauriIpc.ts', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  gitWorktreeInspect: gitWorktreeInspectMock,
  gitStatus: gitStatusMock,
  gitDiff: gitDiffMock,
  gitCheckout: gitCheckoutMock,
  gitMergeCheck: gitMergeCheckMock,
  gitMerge: gitMergeMock,
  gitFastForward: gitFastForwardMock,
  gitRebaseCheck: gitRebaseCheckMock,
  gitRebaseBranch: gitRebaseBranchMock,
  gitWorkflow: gitWorkflowMock,
  gitBranchWorktreeCreate: gitBranchWorktreeCreateMock,
  gitWorktreeCreate: gitWorktreeCreateMock,
  gitWorktreeRemove: gitWorktreeRemoveMock,
  gitBranchList: gitBranchListMock,
  gitBranchDelete: gitBranchDeleteMock,
  gitBranchDeleteRemote: gitBranchDeleteRemoteMock,
  gitWorkflowCleanup: gitWorkflowCleanupMock,
  gitPull: gitPullMock,
  fsExists: fsExistsMock,
  fsReadFileWithOptions: fsReadFileWithOptionsMock,
  fsWriteFile: fsWriteFileMock,
  dbGetAppSetting: dbGetAppSettingMock,
  dbCompareAndSwapAppSetting: dbCompareAndSwapAppSettingMock,
  workspaceGetActiveRoot: workspaceGetActiveRootMock,
  workspaceArchiveManualFeature: workspaceArchiveManualFeatureMock,
  workspaceUpdateStandaloneTaskStatus: workspaceUpdateStandaloneTaskStatusMock,
  configGetSnapshot: configGetSnapshotMock,
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

const flushPromises = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

const waitForMergeCall = async () => {
  for (let index = 0; index < 20 && gitMergeMock.mock.calls.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
      executionMode: 'git',
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
          artifactContracts: undefined,
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
    worktreeInspectionOverrides.clear();
    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    gitBranchWorktreeCreateMock.mockClear();
    gitWorktreeCreateMock.mockClear();
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
    gitWorkflowCleanupMock.mockClear();
    gitWorkflowCleanupMock.mockImplementation(async () => undefined);
    gitCheckoutMock.mockClear();
    gitMergeCheckMock.mockClear();
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 1,
    }));
    gitMergeMock.mockClear();
    gitFastForwardMock.mockClear();
    gitWorkflowMock.mockClear();
    gitWorkflowSessions.clear();
    projectCompletionMergePolicy = 'merge_commit';
    gitRebaseCheckMock.mockClear();
    gitRebaseBranchMock.mockClear();
    gitPullMock.mockClear();
    fsReadFileWithOptionsMock.mockClear();
    fsReadFileWithOptionsMock.mockImplementation(async (params?: {
      path?: string;
      workspacePath?: string | null;
      workspaceScope?: string;
    }) => {
      if (params?.path?.endsWith('/runtime.json')) {
        const file = runtimeFiles.get(runtimeFileKey(params));
        if (!file) throw createFilesystemNotFoundError();
        return file;
      }
      throw createFilesystemNotFoundError();
    });
    fsExistsMock.mockClear();
    fsExistsMock.mockImplementation(async () => false);
    fsWriteFileMock.mockClear();
    runtimeFiles.clear();
    runtimeSettings.clear();
    dbGetAppSettingMock.mockClear();
    dbCompareAndSwapAppSettingMock.mockClear();
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

    expect(gitMergeMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      branchName: 'feature/task-1',
      intoBranch: 'plan/checkout',
    });
    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
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

  it('coalesces concurrent finish requests into one merge workflow', async () => {
    let resolveMerge: (output: string) => void = () => undefined;
    gitMergeMock.mockImplementationOnce(
      async () => await new Promise<string>((resolve) => {
        resolveMerge = resolve;
      })
    );

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

    const firstFinish = useTaskStore.getState().finishTask('task-1');
    await waitForMergeCall();
    expect(gitMergeMock).toHaveBeenCalledTimes(1);

    const secondFinish = useTaskStore.getState().finishTask('task-1');
    await flushPromises();
    expect(gitMergeMock).toHaveBeenCalledTimes(1);

    resolveMerge('Merged feature/task-1 into plan/checkout');
    await Promise.all([firstFinish, secondFinish]);

    expect(gitMergeMock).toHaveBeenCalledTimes(1);
    expect(gitWorkflowCleanupMock).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().getTaskById('task-1')).toMatchObject({
      status: 'Completed',
    });
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

  it('blocks architect task completion while required artifacts are missing', async () => {
    planState = {
      ...planState,
      nodes: [
        {
          ...planState.nodes[0],
          todos: undefined,
          artifactContracts: [
            {
              id: 'audit-findings',
              title: 'Audit findings',
              kind: 'audit',
              required: true,
            },
          ],
        },
      ],
    };
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask({ status: 'InReview', todos: undefined })] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1')).rejects.toThrow(
      'Audit findings',
    );

    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
    expect(gitMergeCheckMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().lastError).toContain('Audit findings');
  });

  it('blocks architect task completion while produced artifacts remain unvalidated', async () => {
    fsExistsMock.mockImplementation(async (path?: string) =>
      path?.endsWith('/artifacts/index.json') === true
    );
    fsReadFileWithOptionsMock.mockImplementation(async (params?: { path?: string }) => {
      if (params?.path?.endsWith('/artifacts/index.json')) {
        return {
          content: JSON.stringify({
            schemaVersion: 1,
            planId: 'plan-1',
            updatedAt: '2026-05-26T00:00:00.000Z',
            artifacts: [
              {
                id: 'handoff-note',
                planId: 'plan-1',
                taskId: 'task-1',
                kind: 'note',
                title: 'Handoff note',
                summary: 'Important handoff',
                contentType: 'markdown',
                path: 'branches/develop/plans/plan-1/artifacts/tasks/task-1/handoff-note.md',
                contentHash: 'hash',
                createdAt: '2026-05-26T00:00:00.000Z',
                updatedAt: '2026-05-26T00:00:00.000Z',
                createdBy: 'agent',
              },
            ],
            reviews: [],
          }),
        };
      }
      throw new Error('not found');
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask({ status: 'InReview', todos: undefined })] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
      },
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1')).rejects.toThrow(
      'Handoff note',
    );

    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
    expect(gitMergeCheckMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().lastError).toContain('Handoff note');
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

  it('does not treat sibling direct plan tasks as sharing a Git branch', async () => {
    const directTarget = {
      projectId: 'project-1',
      branchName: '',
      worktreeKey: 'project-1::direct',
      repoPath: '/repos/web',
      targetBranchName: '',
      checkpointId: 'checkpoint-legacy-direct',
    };
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [
        buildArchitectTask({
          execution_targets: [directTarget],
          assigned_branch: '',
          branch_name: '',
        }),
        buildArchitectTask({
          id: 'task-2',
          title: 'Task 2',
          status: 'Pending',
          execution_targets: [{ ...directTarget, worktreeKey: 'project-1::direct:task-2' }],
          assigned_branch: '',
          branch_name: '',
        }),
      ] as never[],
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1');

    expect(useTaskStore.getState().lastError).toBeNull();
    expect(mergeFeatureBranchIntoPlanBranchMock).not.toHaveBeenCalled();
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
    expect(gitWorkflowCleanupMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      identity: {
        taskId: 'task-1',
        sessionId: 'session-task-1-feature/task-1-plan/checkout',
        sourceBranch: 'feature/task-1',
        targetBranch: 'plan/checkout',
      },
      worktreeKey: 'repo-1',
      removeRemote: false,
      expectedWorktreePath: '/worktrees/task-1',
    });
  });

  it('uses merge commit by default when fast-forward is available', async () => {
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

    await useTaskStore.getState().finishTask('task-1');

    expect(gitMergeMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      branchName: 'feature/task-1',
      intoBranch: 'plan/checkout',
    });
    expect(gitFastForwardMock).not.toHaveBeenCalled();
  });

  it('uses fast-forward by default when the project policy requests it', async () => {
    projectCompletionMergePolicy = 'fast_forward';
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

    await useTaskStore.getState().finishTask('task-1');

    expect(gitFastForwardMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      sourceBranch: 'feature/task-1',
      targetBranch: 'plan/checkout',
    });
    expect(gitMergeMock).not.toHaveBeenCalled();
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
    expect(gitWorkflowCleanupMock).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/repos/web',
      worktreeKey: 'repo-1',
      removeRemote: false,
    }));
  });

  it('keeps a completed merge blocked when branch cleanup fails after integration', async () => {
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
    gitWorkflowCleanupMock.mockImplementationOnce(async () => {
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

    await expect(useTaskStore.getState().finishTask('task-1', {
      mergeStrategyAction: 'fast_forward',
    })).rejects.toThrow('remote delete failed');

    expect(gitFastForwardMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      sourceBranch: 'feature/task-1',
      targetBranch: 'plan/checkout',
    });
    expect(gitWorkflowCleanupMock).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/repos/web',
      worktreeKey: 'repo-1',
      removeRemote: true,
    }));
    expect(useTaskStore.getState().getTaskById('task-1')).not.toMatchObject({
      status: 'Completed',
    });

    const persistedTask = useTaskStore.getState().getTaskById('task-1');
    expect(persistedTask?.merge_workflow).toBeTruthy();
    const worktreeCreateCallsAfterFailure = gitWorktreeCreateMock.mock.calls.length;
    gitWorkflowCleanupMock.mockReset();
    gitWorkflowCleanupMock.mockImplementation(async () => undefined);
    worktreeInspectionOverrides.set('/repos/web::repo-1', {
      status: 'absent',
      worktreePath: '/worktrees/task-1',
    });

    const { useTaskStore: reloadedTaskStore } = await loadIsolatedTaskStore();
    reloadedTaskStore.setState({
      tasks: [persistedTask!] as never[],
      branchWorktrees: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      lastError: null,
    });

    await reloadedTaskStore.getState().finishTask('task-1', {
      mergeStrategyAction: 'fast_forward',
    });

    expect(gitWorktreeCreateMock).toHaveBeenCalledTimes(worktreeCreateCallsAfterFailure);
    expect(gitWorkflowCleanupMock).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/repos/web',
      worktreeKey: 'repo-1',
      removeRemote: true,
    }));
    expect(reloadedTaskStore.getState().getTaskById('task-1')).toMatchObject({
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
    gitWorkflowCleanupMock.mockImplementationOnce(async () => {
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

    expect(gitWorkflowCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('resumes a no-changes completion after cleanup failure and an absent source worktree', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: false,
      ahead: 0,
      behind: 0,
    }));
    gitDiffMock.mockImplementation(async () => '');
    gitWorkflowCleanupMock.mockImplementationOnce(async () => {
      throw new Error('branch cleanup failed');
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
      allowWithoutCodeChanges: true,
    })).rejects.toThrow('branch cleanup failed');

    const persistedTask = useTaskStore.getState().getTaskById('task-1');
    expect(persistedTask?.merge_workflow).toBeTruthy();
    expect(gitWorkflowMock.mock.calls.filter(([params]) => params.action === 'no_changes')).toHaveLength(1);
    const worktreeCreateCallsAfterFailure = gitWorktreeCreateMock.mock.calls.length;

    worktreeInspectionOverrides.set('/repos/web::repo-1', {
      status: 'absent',
      worktreePath: '/worktrees/task-1',
    });

    const { useTaskStore: reloadedTaskStore } = await loadIsolatedTaskStore();
    reloadedTaskStore.setState({
      tasks: [persistedTask!] as never[],
      branchWorktrees: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      lastError: null,
    });

    await reloadedTaskStore.getState().finishTask('task-1', {
      allowWithoutCodeChanges: true,
    });

    expect(gitWorktreeCreateMock).toHaveBeenCalledTimes(worktreeCreateCallsAfterFailure);
    expect(gitWorkflowCleanupMock).toHaveBeenLastCalledWith(expect.objectContaining({
      repoPath: '/repos/web',
      worktreeKey: 'repo-1',
    }));
    expect(reloadedTaskStore.getState().getTaskById('task-1')).toMatchObject({
      status: 'Completed',
    });
  });

  it('keeps partial multi-repository cleanup resumable by repository after reload', async () => {
    const apiTarget = {
      projectId: 'project-2',
      executionMode: 'git',
      branchName: 'feature/task-1-api',
      worktreeKey: 'repo-2',
      repoPath: '/repos/api',
      planBranchName: 'plan/checkout-api',
      targetBranchName: 'develop',
    };
    let cleanupCalls = 0;

    gitMergeCheckMock.mockImplementation(async (params) => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: !params?.repoPath.includes('/repos/api/'),
      ahead: params?.repoPath.includes('/repos/api/') ? 0 : 1,
      behind: params?.repoPath.includes('/repos/api/') ? 0 : 1,
    }));
    gitDiffMock.mockImplementation(async (params) =>
      params?.repoPath.includes('/repos/api/') ? '' : 'diff --git a/src/task.ts b/src/task.ts'
    );
    gitBranchListMock.mockImplementation(async (repoPath) => {
      const isApi = repoPath === '/repos/api';
      const branchName = isApi ? 'feature/task-1-api' : 'feature/task-1';
      return {
        local: [{ name: branchName, is_head: false, commit: isApi ? 'def456' : 'abc123' }],
        remote: [],
        current: 'develop',
      };
    });
    gitWorkflowCleanupMock.mockImplementation(async (params) => {
      cleanupCalls += 1;
      if (cleanupCalls === 2) {
        throw new Error('api cleanup failed');
      }
      if (params?.repoPath === '/repos/web') {
        worktreeInspectionOverrides.set('/repos/web::repo-1', {
          status: 'absent',
          worktreePath: '/worktrees/task-1',
        });
      }
    });

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildArchitectTask({
        project_ids: ['project-1', 'project-2'],
        execution_targets: [buildArchitectTask().execution_targets[0], apiTarget],
      })] as never[],
      branchWorktrees: {
        'repo-1': '/worktrees/task-1',
        'repo-2': '/worktrees/task-1-api',
      },
      activeBranchName: 'feature/task-1',
      activeRepositoryPath: '/worktrees/task-1',
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1')).rejects.toThrow(
      'api cleanup failed',
    );

    const persistedTask = useTaskStore.getState().getTaskById('task-1');
    expect(persistedTask?.merge_workflow).toBeTruthy();
    const worktreeCreateCallsAfterFailure = gitWorktreeCreateMock.mock.calls.length;

    expect(gitWorkflowCleanupMock).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/repos/web',
      worktreeKey: 'repo-1',
      removeRemote: false,
    }));
    expect(gitWorkflowCleanupMock).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/repos/api',
      worktreeKey: 'repo-2',
      removeRemote: false,
    }));

    const { useTaskStore: reloadedTaskStore } = await loadIsolatedTaskStore();
    reloadedTaskStore.setState({
      tasks: [persistedTask!] as never[],
      branchWorktrees: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      lastError: null,
    });

    await reloadedTaskStore.getState().finishTask('task-1');

    expect(gitWorktreeCreateMock).toHaveBeenCalledTimes(worktreeCreateCallsAfterFailure);
    expect(gitWorkflowCleanupMock).toHaveBeenCalledTimes(4);
    expect(gitWorkflowCleanupMock.mock.calls.map(([params]) => params?.repoPath)).toEqual([
      '/repos/web',
      '/repos/api',
      '/repos/web',
      '/repos/api',
    ]);
    expect(reloadedTaskStore.getState().getTaskById('task-1')).toMatchObject({
      status: 'Completed',
    });
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
