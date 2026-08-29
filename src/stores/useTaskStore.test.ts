import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE,
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
} from '../services/serviceRuntime';
import type { GitMergeCheckDto, GitWorktreeInspectionDto } from '../services/tauriIpc';
import type {
  MergeWorkflowRepositoryResult,
  MergeWorkflowRuntimeState,
} from '../services/mergeWorkflow';
import {
  buildPlanFinalizationFailureState,
  toBlockedPlanFinalizationState,
} from '../services/planFinalization';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { getPlanActivationCandidateTask } from '../services/planActivationCandidate';
import type { ImplementTask } from './useTaskStore';

const { clearPlanRuntimeStateSnapshot } = await import('./planRuntimeState');
const actualTauriIpc = await import('../services/tauriIpc');
const { services } = await import('../services');

let isolatedTaskStoreImportCounter = 0;
let updateStandaloneTaskStatusImpl: ((params: { taskId: string; status: string }) => Promise<void>) | null = null;
const gitWorktreeRemoveMock = mock(async () => ({
  removed: true,
  removedPath: '/repos/web/.macro/worktrees/task-1',
}));
const gitWorktreeInspectMock = mock(async (params: { taskId: string; branchName?: string | null }): Promise<GitWorktreeInspectionDto> => ({
  taskId: params.taskId,
  worktreePath: `/repos/web/.macro/worktrees/${params.taskId}`,
  branchName: params.branchName ?? null,
  status: 'ready' as const,
  isDirty: false,
}));
const gitBranchWorktreeCreateMock = mock(async (params: { repoPath: string; worktreeKey: string; branchName: string }) => ({
  worktreeKey: params.worktreeKey,
  worktreePath: `${params.repoPath}/.macro/worktrees/integration-${params.worktreeKey}`,
  branchName: params.branchName,
  status: 'reused' as const,
}));
const gitWorktreeCreateMock = mock(async (params: { repoPath: string; taskId: string; branchName: string }) => ({
  taskId: params.taskId,
  worktreePath: `${params.repoPath}/.macro/worktrees/integration-${params.taskId}`,
  branchName: params.branchName,
  status: 'reused' as const,
}));
const gitStatusMock = mock(async () => ({
  branch: 'plan/review-actions',
  is_clean: true,
  conflicted_files: [],
  conflictedFiles: [],
  merge_in_progress: false,
  mergeInProgress: false,
}));
const gitDiffMock = mock(async () => 'diff --git a/src/main.ts b/src/main.ts');
const gitMergeCheckMock = mock(async (): Promise<GitMergeCheckDto> => ({
  mergeable: true,
  conflictFiles: [],
  hasChanges: true,
  ahead: 1,
  behind: 0,
}));
const gitStashMock = mock(async () => 'stash@{0}');
const gitCommitMock = mock(async () => 'commit-hash');
const gitAbortMergeMock = mock(async () => undefined);
const gitRestorePathsMock = mock(async () => undefined);
const gitFastForwardMock = mock(async () => 'Fast-forwarded plan/review-actions');
const gitRebaseCheckMock = mock(async () => ({
  rebaseable: true,
  conflictFiles: [],
  output: 'Successfully rebased',
}));
const gitRebaseBranchMock = mock(async () => 'Successfully rebased');
const gitStartMergeResolutionMock = mock(async () => ({
  status: 'conflicted',
  conflictFiles: ['src/conflict.ts'],
  output: 'Automatic merge failed',
}));
const gitCompleteMergeMock = mock(async () => 'Merge completed');
const gitBranchListMock = mock(async () => ({
  local: [{ name: 'feature/quick-export', is_head: false, commit: 'abc123' }],
  remote: [],
  current: 'develop',
}));
const gitBranchDeleteMock = mock(async () => undefined);
const directCheckpointResolveIdMock = mock(async () => 'task-checkpoint-0000000000000001');
const directCheckpointRemoveMock = mock(async () => true);
const workspaceDeleteManualFeatureDraftMock = mock(async () => undefined);
const workspaceDeleteManualFeatureMock = mock(async () => undefined);
const workspaceArchiveManualFeatureMock = mock(async () => undefined);
const dbAppSettings = new Map<string, string>();
const dbGetAppSettingMock = mock(async (key: string) => {
  const valueJson = dbAppSettings.get(key);
  return valueJson === undefined
    ? null
    : { key, value_json: valueJson, updated_at: '2026-08-12T00:00:00.000Z' };
});
const dbSetAppSettingMock = mock(async (params: { key: string; valueJson: string }) => {
  dbAppSettings.set(params.key, params.valueJson);
  return {
    key: params.key,
    value_json: params.valueJson,
    updated_at: '2026-08-12T00:00:00.000Z',
  };
});
const workspaceRevertManualFeatureToDraftMock = mock(async () => ({
  id: 'task-1',
  conversationId: 'conv-1',
  draft: true,
  title: 'New feature',
  description: '',
  status: 'Pending',
  featureSlug: null,
  branchName: null,
  archivedAt: null,
  archiveReason: null,
  mergedAt: null,
  baseBranch: 'develop',
  projectIds: ['project-1'],
  contextProjectIds: [],
  executionTargets: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
}));
const workspaceUpdateStandaloneTaskStatusMock = mock(
  async (params: { taskId: string; status: string }) => {
    if (!updateStandaloneTaskStatusImpl) {
      return;
    }
    await updateStandaloneTaskStatusImpl(params);
  }
);
const syncTerminalDisplayMetadataMock = mock(async () => undefined);
const startTaskCommandTabMock = mock(async () => ({
  id: 'terminal-tab-1',
  kind: 'task',
  taskId: 'task-1',
  projectId: 'project-1',
  projectName: 'Project One',
  mountName: 'project-one',
  workspacePath: '/repos/web/.macro/worktrees/task-1',
  cwd: '/repos/web/.macro/worktrees/task-1',
  title: 'Project One - Task 1',
  status: 'running',
  snapshot: 'npm test\r\n',
  lastCommand: 'npm test',
  lastExitCode: null,
  hasLiveSession: true,
  isRestored: false,
  outputSequence: 1,
  hasUnreadOutput: false,
  createdAt: '2026-06-03T10:00:00.000Z',
  updatedAt: '2026-06-03T10:00:00.000Z',
}));
const interruptTabMock = mock(async () => undefined);
const closeTabMock = mock(async () => undefined);
const runWorktreeSetupCommandMock = mock(async () => ({
  exitCode: 0,
  failed: false,
  tabId: 'setup-tab-1',
}));
let taskProjectCommandRegistryMock: {
  version: 3;
  commandsByProjectPath: Record<
    string,
    {
      projectId: string;
      projectName: string;
      projectPath: string;
      command: string;
      worktreeSetupCommand: string;
      openTerminalOnRun: boolean;
      updatedAt: string;
    }
  >;
} = {
  version: 3,
  commandsByProjectPath: {
    '/repos/web': {
      projectId: 'project-1',
      projectName: 'Project One',
      projectPath: '/repos/web',
      command: 'npm test',
      worktreeSetupCommand: '',
      openTerminalOnRun: true,
      updatedAt: '2026-06-03T10:00:00.000Z',
    },
  },
};
const syncManualFeatureMetadataFromTaskMock = mock(async () => undefined);
const commitManualFeatureMetadataMock = mock(async () => undefined);
const removeManualFeatureMetadataMock = mock(async () => undefined);
const persistArchitectPlanMergeWorkflowSessionMock = mock(async () => undefined);
const ensureConversationForCurrentModeMock = mock(async () => null as string | null);
const reapplySelectionForCurrentContextMock = mock(async () => undefined);
const createConversationMock = mock(async () => ({ id: 'conv-1' }));
const sendMessageMock = mock(async () => undefined);
const deleteConversationMock = mock(async () => undefined);
let completeLinkedTaskConversationDeletionImpl: ((conversationId: string) => Promise<boolean>) | null = null;
const completeLinkedTaskConversationDeletionMock = mock(async (conversationId: string) => {
  if (completeLinkedTaskConversationDeletionImpl) {
    return completeLinkedTaskConversationDeletionImpl(conversationId);
  }
  return true;
});
let chatStoreConversations: Array<{ id: string; task_id?: string | null }> = [];
let chatStoreRuntimeById: Record<string, { phase: string }> = {};
const appStoreState = {
  mode: 'Implement' as const,
  selectedTaskId: null as string | null,
  selectedGroupId: 'group-1' as string | null,
  selectedProjectId: null as string | null,
  projectGroups: [
    {
      id: 'group-1',
      name: 'Group One',
      isOpen: true,
      projects: [
        {
          id: 'project-1',
          name: 'Project One',
          path: '/repos/web',
          gitSetupState: 'ready' as 'ready' | 'unborn' | 'not_git' | 'unknown',
          directEdit: false,
        },
      ],
    },
  ],
  standaloneProjects: [] as Array<{
    id: string;
    name: string;
    path: string;
    directEdit?: boolean;
    gitSetupState?: 'ready' | 'unborn' | 'not_git' | 'unknown';
  }>,
  activeArchitectPlanId: null as string | null,
  activePlanContext: null as { targetBranch?: string | null } | null,
  getProjectById: (_projectId: string) => null as null | {
    id: string;
    name: string;
    path: string;
    directEdit?: boolean;
    gitSetupState?: 'ready' | 'unborn' | 'not_git' | 'unknown';
  },
  setMode: mock((_mode: 'Implement') => undefined),
  setSelectedTask: mock((_taskId: string | null) => undefined),
};

mock.module('../services/tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  workspaceUpdateStandaloneTaskStatus: workspaceUpdateStandaloneTaskStatusMock,
  gitStatus: gitStatusMock,
  gitDiff: gitDiffMock,
  gitMergeCheck: gitMergeCheckMock,
  gitStash: gitStashMock,
  gitCommit: gitCommitMock,
  gitAbortMerge: gitAbortMergeMock,
  gitRestorePaths: gitRestorePathsMock,
  gitFastForward: gitFastForwardMock,
  gitRebaseCheck: gitRebaseCheckMock,
  gitRebaseBranch: gitRebaseBranchMock,
  gitStartMergeResolution: gitStartMergeResolutionMock,
  gitCompleteMerge: gitCompleteMergeMock,
  gitBranchWorktreeCreate: gitBranchWorktreeCreateMock,
  gitWorktreeCreate: gitWorktreeCreateMock,
  gitWorktreeInspect: gitWorktreeInspectMock,
  gitWorktreeRemove: gitWorktreeRemoveMock,
  gitBranchList: gitBranchListMock,
  gitBranchDelete: gitBranchDeleteMock,
  directCheckpointResolveId: directCheckpointResolveIdMock,
  directCheckpointRemove: directCheckpointRemoveMock,
  dbGetAppSetting: dbGetAppSettingMock,
  dbSetAppSetting: dbSetAppSettingMock,
  workspaceDeleteManualFeatureDraft: workspaceDeleteManualFeatureDraftMock,
  workspaceDeleteManualFeature: workspaceDeleteManualFeatureMock,
  workspaceArchiveManualFeature: workspaceArchiveManualFeatureMock,
  workspaceRevertManualFeatureToDraft: workspaceRevertManualFeatureToDraftMock,
}));

mock.module('../services/tauriIpc.ts', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  workspaceUpdateStandaloneTaskStatus: workspaceUpdateStandaloneTaskStatusMock,
  gitStatus: gitStatusMock,
  gitDiff: gitDiffMock,
  gitMergeCheck: gitMergeCheckMock,
  gitStash: gitStashMock,
  gitCommit: gitCommitMock,
  gitAbortMerge: gitAbortMergeMock,
  gitRestorePaths: gitRestorePathsMock,
  gitFastForward: gitFastForwardMock,
  gitRebaseCheck: gitRebaseCheckMock,
  gitRebaseBranch: gitRebaseBranchMock,
  gitStartMergeResolution: gitStartMergeResolutionMock,
  gitCompleteMerge: gitCompleteMergeMock,
  gitBranchWorktreeCreate: gitBranchWorktreeCreateMock,
  gitWorktreeCreate: gitWorktreeCreateMock,
  gitWorktreeInspect: gitWorktreeInspectMock,
  gitWorktreeRemove: gitWorktreeRemoveMock,
  gitBranchList: gitBranchListMock,
  gitBranchDelete: gitBranchDeleteMock,
  directCheckpointResolveId: directCheckpointResolveIdMock,
  directCheckpointRemove: directCheckpointRemoveMock,
  dbGetAppSetting: dbGetAppSettingMock,
  dbSetAppSetting: dbSetAppSettingMock,
  workspaceDeleteManualFeatureDraft: workspaceDeleteManualFeatureDraftMock,
  workspaceDeleteManualFeature: workspaceDeleteManualFeatureMock,
  workspaceArchiveManualFeature: workspaceArchiveManualFeatureMock,
  workspaceRevertManualFeatureToDraft: workspaceRevertManualFeatureToDraftMock,
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
      startTaskCommandTab: startTaskCommandTabMock,
      interruptTab: interruptTabMock,
      closeTab: closeTabMock,
    }),
  },
}));

mock.module('../services/taskProjectCommands', () => ({
  loadTaskProjectCommandRegistry: mock(async () => taskProjectCommandRegistryMock),
  normalizeTaskProjectCommandPath: (value: string): string =>
    value.trim().replace(/\\/g, '/').replace(/\/+$/, ''),
  getTaskProjectCommand: (registry: {
    commandsByProjectPath: Record<string, { command: string; openTerminalOnRun: boolean }>;
  }, projectPath: string | null | undefined) =>
    projectPath
      ? registry.commandsByProjectPath[
          projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
        ] ?? null
      : null,
}));

mock.module('../services/worktreeSetupCommands', () => ({
  runWorktreeSetupCommand: runWorktreeSetupCommandMock,
}));

mock.module('./useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      ensureConversationForCurrentMode: ensureConversationForCurrentModeMock,
      reapplySelectionForCurrentContext: reapplySelectionForCurrentContextMock,
      createConversation: createConversationMock,
      sendMessage: sendMessageMock,
      deleteConversation: deleteConversationMock,
      completeLinkedTaskConversationDeletion: completeLinkedTaskConversationDeletionMock,
      lastError: null,
      conversations: chatStoreConversations,
      conversationRuntimeById: chatStoreRuntimeById,
    }),
  },
}));

mock.module('../services/manualFeatureMetadataService', () => ({
  syncManualFeatureMetadataFromTask: syncManualFeatureMetadataFromTaskMock,
  commitManualFeatureMetadata: commitManualFeatureMetadataMock,
  removeManualFeatureMetadata: removeManualFeatureMetadataMock,
}));

mock.module('../services/architectPlanRuntimeService', () => ({
  persistArchitectPlanMergeWorkflowSession: persistArchitectPlanMergeWorkflowSessionMock,
}));

mock.module('../services/architectPlanRuntimeService.ts', () => ({
  persistArchitectPlanMergeWorkflowSession: persistArchitectPlanMergeWorkflowSessionMock,
}));

const loadIsolatedTaskStore = async () => {
  isolatedTaskStoreImportCounter += 1;
  return import(`./useTaskStore.ts?optimistic=${isolatedTaskStoreImportCounter}`);
};

const invokeDeferredResolver = (resolver: (() => void) | null) => {
  if (typeof resolver === 'function') {
    resolver();
  }
};

const flushPromises = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  installTauriRuntimeMock();
  appStoreState.selectedTaskId = null;
  appStoreState.selectedGroupId = 'group-1';
  appStoreState.selectedProjectId = null;
  appStoreState.projectGroups = [{
    id: 'group-1',
    name: 'Group One',
    isOpen: true,
    projects: [{
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      gitSetupState: 'ready' as const,
      directEdit: false,
    }],
  }];
  appStoreState.standaloneProjects = [];
  appStoreState.getProjectById = (projectId: string) => projectId === 'project-1'
    ? {
        id: 'project-1',
        name: 'Project One',
        path: '/repos/web',
        gitSetupState: 'ready' as const,
        directEdit: false,
      }
    : null;
  dbAppSettings.clear();
  chatStoreConversations = [];
  chatStoreRuntimeById = {};
  dbGetAppSettingMock.mockClear();
  dbSetAppSettingMock.mockClear();
  completeLinkedTaskConversationDeletionMock.mockClear();
  completeLinkedTaskConversationDeletionImpl = null;
  runWorktreeSetupCommandMock.mockClear();
  taskProjectCommandRegistryMock = {
    version: 3,
    commandsByProjectPath: {
      '/repos/web': {
        projectId: 'project-1',
        projectName: 'Project One',
        projectPath: '/repos/web',
        command: 'npm test',
        worktreeSetupCommand: '',
        openTerminalOnRun: true,
        updatedAt: '2026-06-03T10:00:00.000Z',
      },
    },
  };
});

afterEach(() => {
  removeTauriRuntimeMock();
});

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

describe('planFinalization helpers', () => {
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
      lastError: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
      runtimePatch: {
        phase: 'blocked',
        taskStatus: 'Blocked',
        repositories: [blockedRepository],
        blockedRepositories: [blockedRepository],
        message: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
        lastLoadedAt: expect.any(String),
      },
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
  archived_at: null,
  archive_reason: null,
  merged_at: null,
  needs_revalidation: false,
  ...overrides,
});

const buildStandaloneTask = (
  overrides: Partial<ImplementTask> = {},
): ImplementTask =>
  buildTask({
    task_source: 'standalone',
    plan_id: undefined,
    plan_title: undefined,
    plan_status: undefined,
    plan_target_branch: undefined,
    standalone_kind: 'legacy',
    ...overrides,
  });

describe('getPlanActivationCandidateTask', () => {
  it('returns the first eligible task for the plan using task queue ordering', () => {
    const candidate = getPlanActivationCandidateTask([
      buildTask({ id: 'completed', status: 'Completed', sequence_index: 0 }),
      buildTask({ id: 'failed', status: 'Failed', sequence_index: 1 }),
      buildTask({ id: 'in-progress', status: 'InProgress', sequence_index: 4 }),
      buildTask({ id: 'pending', status: 'Pending', sequence_index: 2 }),
    ], 'plan-1');

    expect(candidate?.id).toBe('in-progress');
  });

  it('prefers tasks inside the current scope and ignores in-review or draft tasks', () => {
    const candidate = getPlanActivationCandidateTask([
      buildTask({ id: 'other-project', project_id: 'project-2', project_ids: ['project-2'], sequence_index: 0 }),
      buildTask({ id: 'draft', draft: true, sequence_index: 1 }),
      buildTask({ id: 'review', status: 'InReview', sequence_index: 2 }),
      buildTask({ id: 'scoped', sequence_index: 3 }),
    ], 'plan-1', ['project-1']);

    expect(candidate?.id).toBe('scoped');
  });
});

describe('useTaskStore refreshFromPlan selection reconciliation', () => {
  it('keeps the newest refresh and selection when an older context resolves last', async () => {
    const originalListTasks = services.listTasks;
    const resolvers: Array<(catalog: Awaited<ReturnType<typeof services.listTasks>>) => void> = [];
    services.listTasks = mock(
      async () =>
        await new Promise<Awaited<ReturnType<typeof services.listTasks>>>((resolve) => {
          resolvers.push(resolve);
        })
    );
    appStoreState.selectedGroupId = 'group-a';
    appStoreState.selectedProjectId = 'project-a';
    appStoreState.selectedTaskId = 'task-a';
    appStoreState.setSelectedTask.mockImplementation((taskId: string | null) => {
      appStoreState.selectedTaskId = taskId;
    });

    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      const staleRefresh = useTaskStore.getState().refreshFromPlan({
        restoreSelection: true,
        activateSelectedTask: false,
      });
      await flushPromises();

      appStoreState.selectedGroupId = 'group-b';
      appStoreState.selectedProjectId = 'project-b';
      appStoreState.selectedTaskId = 'task-b';
      const freshRefresh = useTaskStore.getState().refreshFromPlan({
        restoreSelection: true,
        activateSelectedTask: false,
      });
      await flushPromises();

      resolvers[1]?.({
        tasks: [buildTask({ id: 'task-b', project_id: 'project-b', project_ids: ['project-b'] })],
        plans: [],
        hasStandaloneTasks: false,
        source: 'architect',
      });
      await freshRefresh;

      resolvers[0]?.({
        tasks: [buildTask({ id: 'task-a', project_id: 'project-a', project_ids: ['project-a'] })],
        plans: [],
        hasStandaloneTasks: false,
        source: 'architect',
      });
      await staleRefresh;

      expect(useTaskStore.getState().tasks.map((task: ImplementTask) => task.id)).toEqual(['task-b']);
      expect(appStoreState.selectedTaskId).toBe('task-b');
    } finally {
      services.listTasks = originalListTasks;
    }
  });

  it('does not restore a selection after the project context changes during refresh', async () => {
    const originalListTasks = services.listTasks;
    let resolveCatalog!: (catalog: Awaited<ReturnType<typeof services.listTasks>>) => void;
    services.listTasks = mock(
      async () =>
        await new Promise<Awaited<ReturnType<typeof services.listTasks>>>((resolve) => {
          resolveCatalog = resolve;
        })
    );
    appStoreState.selectedGroupId = 'group-a';
    appStoreState.selectedProjectId = 'project-a';
    appStoreState.selectedTaskId = 'task-a';

    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      const refresh = useTaskStore.getState().refreshFromPlan({
        restoreSelection: true,
        activateSelectedTask: false,
      });
      await flushPromises();

      appStoreState.selectedGroupId = 'group-b';
      appStoreState.selectedProjectId = 'project-b';
      appStoreState.selectedTaskId = 'task-b';
      resolveCatalog({
        tasks: [buildTask({ id: 'task-a', project_id: 'project-a', project_ids: ['project-a'] })],
        plans: [],
        hasStandaloneTasks: false,
        source: 'architect',
      });
      await refresh;

      expect(useTaskStore.getState().tasks).toEqual([]);
      expect(appStoreState.selectedTaskId).toBe('task-b');
    } finally {
      services.listTasks = originalListTasks;
    }
  });

  it('does not let a slow task activation restore its worktree after a newer selection', async () => {
    appStoreState.getProjectById = () => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      gitSetupState: 'ready' as const,
      directEdit: false,
    });
    let resolveSlow!: (value: GitWorktreeInspectionDto) => void;
    let resolveFast!: (value: GitWorktreeInspectionDto) => void;
    gitWorktreeInspectMock
      .mockImplementationOnce(async () => await new Promise<GitWorktreeInspectionDto>((resolve) => {
        resolveSlow = resolve;
      }))
      .mockImplementationOnce(async () => await new Promise<GitWorktreeInspectionDto>((resolve) => {
        resolveFast = resolve;
      }));
    const slowTask = buildTask({
      id: 'task-slow',
      assigned_branch: 'feature/slow',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'git',
        branchName: 'feature/slow',
        worktreeKey: 'project-1::feature/slow',
        executionKind: 'worktree',
        repoPath: '/repos/web',
      }],
    });
    const fastTask = buildTask({
      id: 'task-fast',
      assigned_branch: 'feature/fast',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'git',
        branchName: 'feature/fast',
        worktreeKey: 'project-1::feature/fast',
        executionKind: 'worktree',
        repoPath: '/repos/web',
      }],
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({ tasks: [slowTask, fastTask], branchWorktrees: {} });

    const slowActivation = useTaskStore.getState().activateTask(slowTask.id);
    const fastActivation = useTaskStore.getState().activateTask(fastTask.id);
    await flushPromises();

    resolveFast({
      taskId: 'project-1::feature/fast',
      worktreePath: '/repos/web/.macro/worktrees/fast',
      branchName: 'feature/fast',
      status: 'ready',
      isDirty: false,
    });
    await fastActivation;
    resolveSlow({
      taskId: 'project-1::feature/slow',
      worktreePath: '/repos/web/.macro/worktrees/slow',
      branchName: 'feature/slow',
      status: 'ready',
      isDirty: false,
    });
    await slowActivation;

    expect(useTaskStore.getState().activeBranchName).toBe('feature/fast');
    expect(useTaskStore.getState().activeRepositoryPath).toBe('/repos/web/.macro/worktrees/fast');
  });

  it('clears a missing selected task and reapplies chat selection when the catalog becomes empty', async () => {
    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [],
      plans: [],
      hasStandaloneTasks: false,
      source: 'empty' as const,
    }));
    ensureConversationForCurrentModeMock.mockClear();
    reapplySelectionForCurrentContextMock.mockClear();
    appStoreState.selectedTaskId = 'task-1';
    appStoreState.selectedGroupId = null;
    appStoreState.selectedProjectId = null;
    appStoreState.mode = 'Implement';
    appStoreState.setSelectedTask.mockClear();
    appStoreState.setSelectedTask.mockImplementation((taskId: string | null) => {
      appStoreState.selectedTaskId = taskId;
    });

    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      useTaskStore.setState({
        tasks: [buildTask({ id: 'task-1' })],
        source: 'architect',
        isLoading: false,
        lastError: null,
      });

      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: true,
        activateSelectedTask: true,
      });

      expect(appStoreState.selectedTaskId).toBeNull();
      expect(reapplySelectionForCurrentContextMock).toHaveBeenCalledTimes(1);
      expect(ensureConversationForCurrentModeMock).not.toHaveBeenCalled();
    } finally {
      services.listTasks = originalListTasks;
    }
  });
});

describe('useTaskStore manual feature creation ownership', () => {
  it('allows only the owner to release an active creation', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();

    expect(useTaskStore.getState().reserveManualFeatureCreation('creation-a')).toBe(true);
    expect(useTaskStore.getState().reserveManualFeatureCreation('creation-b')).toBe(false);

    useTaskStore.getState().releaseManualFeatureCreation('creation-b');
    expect(useTaskStore.getState().reserveManualFeatureCreation('creation-c')).toBe(false);

    useTaskStore.getState().releaseManualFeatureCreation('creation-a');
    expect(useTaskStore.getState().reserveManualFeatureCreation('creation-c')).toBe(true);
  });
});

describe('useTaskStore merge workflow review loading', () => {
  beforeEach(() => {
    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    gitMergeCheckMock.mockClear();
    gitStashMock.mockClear();
    gitCommitMock.mockClear();
    gitAbortMergeMock.mockClear();
    gitRestorePathsMock.mockClear();
    gitFastForwardMock.mockClear();
    gitRebaseCheckMock.mockClear();
    gitRebaseBranchMock.mockClear();
    gitStartMergeResolutionMock.mockClear();
    gitCompleteMergeMock.mockClear();
    gitBranchWorktreeCreateMock.mockClear();
    gitWorktreeCreateMock.mockClear();
    gitWorktreeInspectMock.mockClear();
    gitWorktreeInspectMock.mockImplementation(async (params: { taskId: string; branchName?: string | null }) => ({
      taskId: params.taskId,
      worktreePath: `/repos/web/.macro/worktrees/${params.taskId}`,
      branchName: params.branchName ?? null,
      status: 'ready' as const,
      isDirty: false,
    }));
    gitWorktreeRemoveMock.mockClear();
    gitBranchListMock.mockClear();
    gitBranchListMock.mockImplementation(async () => ({
      local: [{ name: 'feature/quick-export', is_head: false, commit: 'abc123' }],
      remote: [],
      current: 'develop',
    }));
    gitBranchDeleteMock.mockClear();
    directCheckpointResolveIdMock.mockClear();
    directCheckpointResolveIdMock.mockImplementation(async () => 'task-checkpoint-0000000000000001');
    directCheckpointRemoveMock.mockClear();
    directCheckpointRemoveMock.mockImplementation(async () => true);
    dbSetAppSettingMock.mockImplementation(async (params: { key: string; valueJson: string }) => {
      dbAppSettings.set(params.key, params.valueJson);
      return {
        key: params.key,
        value_json: params.valueJson,
        updated_at: '2026-08-12T00:00:00.000Z',
      };
    });
    workspaceDeleteManualFeatureDraftMock.mockClear();
    workspaceDeleteManualFeatureMock.mockClear();
    workspaceArchiveManualFeatureMock.mockClear();
    workspaceRevertManualFeatureToDraftMock.mockClear();
    workspaceUpdateStandaloneTaskStatusMock.mockClear();
    persistArchitectPlanMergeWorkflowSessionMock.mockClear();
    ensureConversationForCurrentModeMock.mockClear();
    reapplySelectionForCurrentContextMock.mockClear();
    createConversationMock.mockClear();
    sendMessageMock.mockClear();
    deleteConversationMock.mockClear();
    chatStoreConversations = [];
    appStoreState.mode = 'Implement';
    appStoreState.selectedTaskId = null;
    appStoreState.selectedGroupId = 'group-1';
    appStoreState.selectedProjectId = null;
    appStoreState.activeArchitectPlanId = null;
    appStoreState.activePlanContext = null;
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      gitSetupState: 'ready' as const,
      directEdit: false,
    });
    appStoreState.setMode.mockClear();
    appStoreState.setSelectedTask.mockClear();
    appStoreState.setSelectedTask.mockImplementation((taskId: string | null) => {
      appStoreState.selectedTaskId = taskId;
    });
    gitStatusMock.mockImplementation(async () => ({
      branch: 'plan/review-actions',
      is_clean: true,
      conflicted_files: [],
      conflictedFiles: [],
      merge_in_progress: false,
      mergeInProgress: false,
    }));
    gitDiffMock.mockImplementation(async () => 'diff --git a/src/main.ts b/src/main.ts');
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 1,
      behind: 0,
    }));
  });

  const buildMergeReviewTask = (overrides: Partial<ImplementTask> = {}) =>
    buildTask({
      status: 'Blocked',
      execution_targets: [
        {
          projectId: 'project-1',
          branchName: 'feature/review-actions',
          planBranchName: 'plan/review-actions',
          executionKind: 'worktree',
          executionMode: 'git',
          worktreeKey: 'project-1::feature/review-actions',
          repoPath: '/repos/web',
        },
      ],
      ...overrides,
    });

  const buildBlockedMergeRuntime = (): MergeWorkflowRuntimeState => {
    const repository: MergeWorkflowRepositoryResult = {
      id: 'project-1::/repos/web',
      projectId: 'project-1',
      repoPath: '/repos/web',
      repositoryRootPath: '/repos/web',
      integrationWorktreePath: null,
      sourceBranchName: 'feature/review-actions',
      targetBranchName: 'plan/review-actions',
      progressState: 'pending',
      hadChangesAtStart: true,
      mergeAppliedAt: null,
      isClean: true,
      hasChanges: true,
      ahead: 1,
      behind: 1,
      mergeable: false,
      conflictFiles: ['src/main.ts'],
      dirtyFiles: [],
      mergeInProgress: false,
      diff: 'diff --git a/src/main.ts b/src/main.ts',
      checkStatus: 'failed',
      blockingKind: 'merge_conflict',
      nextAction: 'resolve_conflicts',
      blockingReason: 'Cannot continue merge because /repos/web would conflict in: src/main.ts.',
      isSourcePublished: false,
      mergeStrategy: 'file_conflict',
      recommendedAction: 'assistant',
      availableActions: ['assistant', 'retry_check'],
    };

    return {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Task 1',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [repository],
      blockedRepositories: [repository],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };
  };

  it('deletes a standalone task when its linked implement conversation is already gone', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-1',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: true,
      conversation_id: 'missing-conv',
      branch_name: undefined,
      assigned_branch: '',
      execution_targets: [],
    });
    appStoreState.selectedTaskId = task.id;
    chatStoreConversations = [];

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [task],
      branchWorktrees: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      refreshFromPlan: mock(async () => {
        useTaskStore.setState({ tasks: [] });
      }),
      lastError: null,
    });

    await useTaskStore.getState().deleteTask(task.id);

    expect(workspaceDeleteManualFeatureDraftMock).toHaveBeenCalledWith(task.id);
    expect(deleteConversationMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(useTaskStore.getState().lastError).toBeNull();
    expect(appStoreState.setSelectedTask).toHaveBeenCalledWith(null);
  });

  it('deletes a direct-edit task through the durable cleanup journal without Git calls', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-direct',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      status: 'Completed',
      conversation_id: 'conv-direct',
      assigned_branch: 'direct',
      branch_name: 'direct',
      execution_targets: [{
        projectId: 'project-1',
        branchName: 'direct',
        executionMode: 'git',
        checkpointId: 'task-checkpoint-0000000000000001',
        executionKind: 'worktree',
        worktreeKey: 'project-1::direct',
        repoPath: '/repos/web',
      }],
    });
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      directEdit: false,
      gitSetupState: 'not_git',
    });
    chatStoreConversations = [{ id: 'conv-direct', task_id: task.id }];
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [task],
      branchWorktrees: { 'project-1::direct': '/repos/web' },
      refreshFromPlan: mock(async () => {
        useTaskStore.setState({ tasks: [] });
      }),
      lastError: null,
    });

    await useTaskStore.getState().deleteTask(task.id);

    expect(workspaceDeleteManualFeatureMock).toHaveBeenCalledWith(task.id);
    expect(directCheckpointRemoveMock).toHaveBeenCalledWith({
      taskId: task.id,
      checkpointId: 'task-checkpoint-0000000000000001',
      projectPath: '/repos/web',
    });
    expect(directCheckpointResolveIdMock).not.toHaveBeenCalled();
    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitBranchListMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
    expect(
      dbSetAppSettingMock.mock.calls.some(([params]) =>
        params.valueJson.includes('"cleanupKind":"direct"')
      )
    ).toBe(true);
  });

  it('archives a direct-edit task without Git cleanup and preserves its checkpoint', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-direct-archive',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      status: 'Completed',
      assigned_branch: 'direct',
      branch_name: 'direct',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'direct',
        branchName: 'direct',
        executionKind: 'worktree',
        worktreeKey: 'project-1::direct',
        repoPath: '/repos/web',
      }],
    });
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      directEdit: true,
      gitSetupState: 'not_git',
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [task],
      branchWorktrees: { 'project-1::direct': '/repos/web' },
      refreshFromPlan: mock(async () => undefined),
      lastError: null,
    });

    await useTaskStore.getState().archiveTask(task.id);

    expect(workspaceArchiveManualFeatureMock).toHaveBeenCalledWith({
      taskId: task.id,
      reason: null,
      mergedAt: null,
    });
    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitBranchListMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
    expect(directCheckpointRemoveMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().branchWorktrees).toEqual({});
  });

  it('blocks deletion while the linked conversation is still running', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-running-conversation',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: true,
      conversation_id: 'conversation-running',
      execution_targets: [],
    });
    chatStoreConversations = [{ id: 'conversation-running', task_id: task.id }];
    chatStoreRuntimeById = {
      'conversation-running': { phase: 'streaming' },
    };

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({ tasks: [task], lastError: null });

    await useTaskStore.getState().deleteTask(task.id);

    expect(workspaceDeleteManualFeatureDraftMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().lastError).toContain('active task operation');
  });

  it('does not start linked deletion when its complete preflight fails', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-preflight',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      conversation_id: 'conv-preflight',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'git',
        branchName: 'feature/preflight',
        executionKind: 'worktree',
        worktreeKey: 'project-1::feature/preflight',
        repoPath: '/repos/web',
      }],
    });
    gitBranchListMock.mockImplementation(async () => {
      throw new Error('repository unavailable');
    });

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({ tasks: [task], lastError: null });

    await expect(useTaskStore.getState().deleteTask(task.id)).rejects.toThrow('repository unavailable');

    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(workspaceDeleteManualFeatureDraftMock).not.toHaveBeenCalled();
    expect(completeLinkedTaskConversationDeletionMock).not.toHaveBeenCalled();
    expect(dbAppSettings.get('pendingLinkedTaskDeletions:v1')).toBeUndefined();
  });

  it('keeps a durable tombstone after task deletion when conversation cleanup fails, then converges idempotently', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-retry',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: true,
      conversation_id: 'conv-retry',
      branch_name: undefined,
      assigned_branch: '',
      execution_targets: [],
    });
    completeLinkedTaskConversationDeletionImpl = async () => false;

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [task],
      refreshFromPlan: mock(async () => {
        useTaskStore.setState({ tasks: [] });
      }),
      lastError: null,
    });

    await expect(useTaskStore.getState().deleteTask(task.id)).rejects.toThrow(
      'nettoyage de sa conversation reste en attente',
    );

    expect(workspaceDeleteManualFeatureDraftMock).toHaveBeenCalledWith(task.id);
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([
      expect.objectContaining({
        taskId: task.id,
        conversationId: task.conversation_id,
        phase: 'task_deleted',
      }),
    ]);

    completeLinkedTaskConversationDeletionImpl = async () => true;
    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [],
      plans: [],
      hasStandaloneTasks: false,
      source: 'empty' as const,
    }));
    try {
      const { useTaskStore: restartedStore } = await loadIsolatedTaskStore();
      await restartedStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(completeLinkedTaskConversationDeletionMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('resumes a pending task-deleted linked conversation cleanup after restart', async () => {
    dbAppSettings.set(
      'pendingLinkedTaskDeletions:v1',
      JSON.stringify([{
        taskId: 'manual-task-restarted',
        conversationId: 'conv-restarted',
        phase: 'task_deleted',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }]),
    );
    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [],
      plans: [],
      hasStandaloneTasks: false,
      source: 'empty' as const,
    }));
    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(completeLinkedTaskConversationDeletionMock).toHaveBeenCalledWith('conv-restarted');
    expect(workspaceDeleteManualFeatureDraftMock).not.toHaveBeenCalled();
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('deletes a surviving direct task before removing its checkpoint during recovery', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-direct-recovery',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      conversation_id: 'conv-direct-recovery',
      assigned_branch: 'direct',
      branch_name: 'direct',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'direct',
        branchName: 'direct',
        worktreeKey: 'project-1::direct',
        repoPath: '/project/that/may/move',
      }],
    });
    dbAppSettings.set(
      'pendingLinkedTaskDeletions:v1',
      JSON.stringify([{
        taskId: task.id,
        conversationId: task.conversation_id,
        phase: 'task_deleting',
        draft: false,
        executionTargets: [{
          worktreeKey: 'project-1::direct',
          repoPath: '/project/that/may/move',
          branchName: 'direct',
          branchExisted: false,
          worktreeRemoved: true,
          branchRemoved: true,
          cleanupKind: 'direct',
          checkpointRemoved: false,
          checkpointId: 'task-checkpoint-0000000000000001',
        }],
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }]),
    );
    const recoveryOrder: string[] = [];
    workspaceDeleteManualFeatureMock.mockImplementation(async () => {
      recoveryOrder.push('task');
    });
    directCheckpointRemoveMock.mockImplementation(async () => {
      recoveryOrder.push('checkpoint');
      return true;
    });
    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [task],
      plans: [],
      hasStandaloneTasks: true,
      source: 'mixed' as const,
    }));

    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(recoveryOrder).toEqual(['task', 'checkpoint']);
    expect(directCheckpointRemoveMock).toHaveBeenCalledWith({
      taskId: task.id,
      checkpointId: 'task-checkpoint-0000000000000001',
      projectPath: '/project/that/may/move',
    });
    expect(directCheckpointResolveIdMock).not.toHaveBeenCalled();
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('finishes an interrupted direct return to draft before removing its checkpoint', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-direct-revert-recovery',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      conversation_id: 'conv-direct-revert-recovery',
      assigned_branch: 'direct',
      branch_name: 'direct',
      execution_targets: [{
        projectId: 'project-1',
        branchName: 'direct',
        executionMode: 'direct',
        checkpointId: 'task-checkpoint-0000000000000001',
        worktreeKey: 'project-1::direct',
        repoPath: '/project/that/may/move',
      }],
    });
    dbAppSettings.set(
      'pendingLinkedTaskDeletions:v1',
      JSON.stringify([{
        taskId: task.id,
        conversationId: task.conversation_id,
        phase: 'draft_reverting',
        draft: false,
        targetBranch: '@direct-draft-revert',
        revertTitle: 'Draft title',
        revertDescription: 'Draft description',
        executionTargets: [{
          worktreeKey: 'project-1::direct',
          repoPath: '/project/that/may/move',
          branchName: 'direct',
          branchExisted: false,
          worktreeRemoved: true,
          branchRemoved: true,
          cleanupKind: 'direct',
          checkpointRemoved: false,
          checkpointId: 'task-checkpoint-0000000000000001',
        }],
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }]),
    );
    const recoveryOrder: string[] = [];
    workspaceRevertManualFeatureToDraftMock.mockImplementation(async () => {
      recoveryOrder.push('task');
      return {} as never;
    });
    directCheckpointRemoveMock.mockImplementation(async () => {
      recoveryOrder.push('checkpoint');
      return true;
    });
    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [task],
      plans: [],
      hasStandaloneTasks: true,
      source: 'mixed' as const,
    }));

    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(recoveryOrder).toEqual(['task', 'checkpoint']);
    expect(workspaceRevertManualFeatureToDraftMock).toHaveBeenCalledWith({
      taskId: task.id,
      conversationId: task.conversation_id,
      title: 'Draft title',
      description: 'Draft description',
    });
    expect(completeLinkedTaskConversationDeletionMock).not.toHaveBeenCalled();
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('keeps a legacy task-deleting tombstone blocked when execution targets are missing', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-interrupted',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: true,
      conversation_id: 'conv-interrupted',
      branch_name: undefined,
      assigned_branch: '',
      execution_targets: [],
    });
    dbAppSettings.set(
      'pendingLinkedTaskDeletions:v1',
      JSON.stringify([{
        taskId: task.id,
        conversationId: task.conversation_id,
        phase: 'task_deleting',
        draft: true,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }]),
    );
    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [task],
      plans: [],
      hasStandaloneTasks: true,
      source: 'fallback' as const,
    }));
    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(workspaceDeleteManualFeatureDraftMock).not.toHaveBeenCalled();
    expect(completeLinkedTaskConversationDeletionMock).not.toHaveBeenCalled();
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([
      expect.objectContaining({
        taskId: task.id,
        phase: 'task_deleting',
        lastError: expect.stringContaining('trop ancien'),
      }),
    ]);
  });

  it('resumes persisted Git cleanup before finalizing a task-deletion saga whose task is absent', async () => {
    const taskId = 'manual-task-missing-after-crash';
    const conversationId = 'conv-missing-after-crash';
    let worktreeExists = true;
    let branchExists = true;
    gitWorktreeInspectMock.mockImplementation(async (params: { taskId: string; branchName?: string | null }) => ({
      taskId: params.taskId,
      worktreePath: `/repos/web/.macro/worktrees/${params.taskId}`,
      branchName: params.branchName ?? null,
      status: worktreeExists ? 'ready' as const : 'absent' as const,
      isDirty: false,
    }));
    gitWorktreeRemoveMock.mockImplementation(async () => {
      worktreeExists = false;
      return { removed: true, removedPath: '/repos/web/.macro/worktrees/missing-after-crash' };
    });
    gitBranchListMock.mockImplementation(async () => ({
      local: branchExists
        ? [{ name: 'feature/missing-after-crash', is_head: false, commit: 'abc123' }]
        : [],
      remote: [],
      current: '',
    }));
    gitBranchDeleteMock.mockImplementation(async () => {
      branchExists = false;
    });
    dbAppSettings.set(
      'pendingLinkedTaskDeletions:v1',
      JSON.stringify([{
        taskId,
        conversationId,
        phase: 'task_deleting',
        draft: false,
        executionTargets: [{
          worktreeKey: 'project-1::feature/missing-after-crash',
          repoPath: '/repos/web',
          branchName: 'feature/missing-after-crash',
          branchExisted: true,
          worktreeRemoved: false,
          branchRemoved: false,
        }],
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }]),
    );
    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [],
      plans: [],
      hasStandaloneTasks: false,
      source: 'empty' as const,
    }));
    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(gitWorktreeRemoveMock).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/repos/web',
      taskId: 'project-1::feature/missing-after-crash',
    }));
    expect(gitBranchDeleteMock).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/repos/web',
      branchName: 'feature/missing-after-crash',
    }));
    expect(workspaceDeleteManualFeatureMock).not.toHaveBeenCalled();
    expect(completeLinkedTaskConversationDeletionMock).toHaveBeenCalledWith(conversationId);
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('resumes only the remaining Git cleanup targets after a partial worktree failure', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-git-retry',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      conversation_id: 'conv-git-retry',
      execution_targets: [
        {
          projectId: 'project-1',
          executionMode: 'git',
          branchName: 'feature/git-retry-one',
          executionKind: 'worktree',
          worktreeKey: 'project-1::feature/git-retry-one',
          repoPath: '/repos/web',
        },
        {
          projectId: 'project-1',
          executionMode: 'git',
          branchName: 'feature/git-retry-two',
          executionKind: 'worktree',
          worktreeKey: 'project-1::feature/git-retry-two',
          repoPath: '/repos/web',
        },
      ],
    });
    let worktreeAttempts = 0;
    gitWorktreeRemoveMock.mockImplementation(async () => {
      worktreeAttempts += 1;
      if (worktreeAttempts === 2) {
        throw new Error('second worktree failed');
      }
      return { removed: true, removedPath: '/repos/web/.macro/worktrees/task-1' };
    });

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({ tasks: [task], lastError: null });
    await expect(useTaskStore.getState().deleteTask(task.id)).rejects.toThrow('second worktree failed');

    const pending = JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')[0];
    expect(pending.phase).toBe('task_deleting');
    expect(pending.executionTargets.some((target: { worktreeRemoved: boolean }) => target.worktreeRemoved)).toBe(true);
    expect(pending.executionTargets.some((target: { worktreeRemoved: boolean }) => !target.worktreeRemoved)).toBe(true);

    gitWorktreeRemoveMock.mockImplementation(async () => ({
      removed: true,
      removedPath: '/repos/api/.macro/worktrees/task-2',
    }));
    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [task],
      plans: [],
      hasStandaloneTasks: true,
      source: 'fallback' as const,
    }));
    try {
      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(workspaceDeleteManualFeatureMock).toHaveBeenCalledWith(task.id);
    expect(completeLinkedTaskConversationDeletionMock).toHaveBeenCalledWith('conv-git-retry');
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('retries a branch already removed before its saga checkpoint was persisted', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-branch-checkpoint',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      conversation_id: 'conv-branch-checkpoint',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'git',
        branchName: 'feature/branch-checkpoint',
        executionKind: 'worktree',
        worktreeKey: 'project-1::feature/branch-checkpoint',
        repoPath: '/repos/web',
      }],
    });
    let worktreeExists = true;
    let branchExists = true;
    let rejectBranchCheckpoint = true;
    gitWorktreeInspectMock.mockImplementation(async (params: { taskId: string; branchName?: string | null }) => ({
      taskId: params.taskId,
      worktreePath: `/repos/web/.macro/worktrees/${params.taskId}`,
      branchName: params.branchName ?? null,
      status: worktreeExists ? 'ready' as const : 'absent' as const,
      isDirty: false,
    }));
    gitWorktreeRemoveMock.mockImplementation(async () => {
      worktreeExists = false;
      return { removed: true, removedPath: '/repos/web/.macro/worktrees/branch-checkpoint' };
    });
    gitBranchListMock.mockImplementation(async () => ({
      local: branchExists
        ? [{ name: 'feature/branch-checkpoint', is_head: false, commit: 'abc123' }]
        : [],
      remote: [],
      current: 'develop',
    }));
    gitBranchDeleteMock.mockImplementation(async () => {
      branchExists = false;
    });
    dbSetAppSettingMock.mockImplementation(async (params: { key: string; valueJson: string }) => {
      if (rejectBranchCheckpoint && params.valueJson.includes('"branchRemoved":true')) {
        rejectBranchCheckpoint = false;
        throw new Error('injected branch checkpoint failure');
      }
      dbAppSettings.set(params.key, params.valueJson);
      return { key: params.key, value_json: params.valueJson, updated_at: '2026-08-12T00:00:00.000Z' };
    });

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({ tasks: [task], lastError: null });
    await expect(useTaskStore.getState().deleteTask(task.id)).rejects.toThrow(
      'injected branch checkpoint failure',
    );
    expect(gitBranchDeleteMock).toHaveBeenCalledTimes(1);

    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [task], plans: [], hasStandaloneTasks: true, source: 'fallback' as const,
    }));
    try {
      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(gitBranchDeleteMock).toHaveBeenCalledTimes(1);
    expect(gitWorktreeRemoveMock).toHaveBeenCalledTimes(1);
    expect(workspaceDeleteManualFeatureMock).toHaveBeenCalledWith(task.id);
    expect(completeLinkedTaskConversationDeletionMock).toHaveBeenCalledWith(task.conversation_id);
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('retries a worktree already removed before its saga checkpoint was persisted', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-worktree-checkpoint',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      conversation_id: 'conv-worktree-checkpoint',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'git',
        branchName: 'feature/worktree-checkpoint',
        executionKind: 'worktree',
        worktreeKey: 'project-1::feature/worktree-checkpoint',
        repoPath: '/repos/web',
      }],
    });
    let worktreeExists = true;
    let rejectWorktreeCheckpoint = true;
    gitWorktreeInspectMock.mockImplementation(async (params: { taskId: string; branchName?: string | null }) => ({
      taskId: params.taskId,
      worktreePath: `/repos/web/.macro/worktrees/${params.taskId}`,
      branchName: params.branchName ?? null,
      status: worktreeExists ? 'ready' as const : 'absent' as const,
      isDirty: false,
    }));
    gitWorktreeRemoveMock.mockImplementation(async () => {
      worktreeExists = false;
      return { removed: true, removedPath: '/repos/web/.macro/worktrees/worktree-checkpoint' };
    });
    gitBranchListMock.mockImplementation(async () => ({
      local: [{ name: 'feature/worktree-checkpoint', is_head: false, commit: 'abc123' }],
      remote: [],
      current: 'develop',
    }));
    dbSetAppSettingMock.mockImplementation(async (params: { key: string; valueJson: string }) => {
      if (rejectWorktreeCheckpoint && params.valueJson.includes('"worktreeRemoved":true')) {
        rejectWorktreeCheckpoint = false;
        throw new Error('injected worktree checkpoint failure');
      }
      dbAppSettings.set(params.key, params.valueJson);
      return { key: params.key, value_json: params.valueJson, updated_at: '2026-08-12T00:00:00.000Z' };
    });

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({ tasks: [task], lastError: null });
    await expect(useTaskStore.getState().deleteTask(task.id)).rejects.toThrow(
      'injected worktree checkpoint failure',
    );

    const originalListTasks = services.listTasks;
    services.listTasks = mock(async () => ({
      tasks: [task], plans: [], hasStandaloneTasks: true, source: 'fallback' as const,
    }));
    try {
      await useTaskStore.getState().refreshFromPlan({
        restoreSelection: false,
        activateSelectedTask: false,
      });
    } finally {
      services.listTasks = originalListTasks;
    }

    expect(gitWorktreeRemoveMock).toHaveBeenCalledTimes(1);
    expect(workspaceDeleteManualFeatureMock).toHaveBeenCalledWith(task.id);
    expect(completeLinkedTaskConversationDeletionMock).toHaveBeenCalledWith(task.conversation_id);
    expect(JSON.parse(dbAppSettings.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('reuses an in-flight merge review load for repeated non-forced calls', async () => {
    let resolveDiff: (() => void) | null = null;
    gitDiffMock.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          resolveDiff = () => resolve('diff --git a/src/main.ts b/src/main.ts');
        })
    );
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      mergeWorkflowRuntimeByTaskId: {},
      lastError: null,
    });

    const firstLoad = useTaskStore.getState().loadMergeWorkflowReview('task-1');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondLoad = useTaskStore.getState().loadMergeWorkflowReview('task-1');

    expect(gitBranchWorktreeCreateMock).toHaveBeenCalledTimes(1);
    expect(gitStatusMock).toHaveBeenCalledTimes(1);
    expect(gitDiffMock).toHaveBeenCalledTimes(1);

    invokeDeferredResolver(resolveDiff);
    const [firstRuntime, secondRuntime] = await Promise.all([firstLoad, secondLoad]);

    expect(firstRuntime?.phase).toBe('ready');
    expect(secondRuntime?.phase).toBe('ready');
    expect(gitMergeCheckMock).toHaveBeenCalledTimes(1);
    expect(persistArchitectPlanMergeWorkflowSessionMock).toHaveBeenCalledTimes(1);
    expect(persistArchitectPlanMergeWorkflowSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          executionModesByProjectId: { 'project-1': 'git' },
        }),
      }),
    );
  });

  it('allows a forced merge review load to bypass an existing in-flight load', async () => {
    const diffResolvers: Array<(value: string) => void> = [];
    gitDiffMock.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          diffResolvers.push(resolve);
        })
    );
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      mergeWorkflowRuntimeByTaskId: {},
      lastError: null,
    });

    const firstLoad = useTaskStore.getState().loadMergeWorkflowReview('task-1');
    await flushPromises();
    const forcedLoad = useTaskStore
      .getState()
      .loadMergeWorkflowReview('task-1', { force: true });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gitBranchWorktreeCreateMock).toHaveBeenCalledTimes(2);
    expect(gitStatusMock).toHaveBeenCalledTimes(2);
    expect(gitDiffMock).toHaveBeenCalledTimes(2);

    diffResolvers[1]?.('forced diff');
    await forcedLoad;
    diffResolvers[0]?.('stale diff');
    await firstLoad;

    expect(gitMergeCheckMock).toHaveBeenCalledTimes(2);
    expect(persistArchitectPlanMergeWorkflowSessionMock).toHaveBeenCalledTimes(1);
    expect(
      useTaskStore.getState().mergeWorkflowRuntimeByTaskId['task-1']?.repositories[0]?.diff
    ).toBe('forced diff');
  });

  it('cleans the in-flight review registry after a failed load', async () => {
    let shouldFail = true;
    gitDiffMock.mockImplementation(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('diff failed');
      }
      return 'diff --git a/src/main.ts b/src/main.ts';
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      mergeWorkflowRuntimeByTaskId: {},
      lastError: null,
    });

    await expect(
      useTaskStore.getState().loadMergeWorkflowReview('task-1')
    ).rejects.toMatchObject({
      message: 'diff failed',
    });

    const recoveredRuntime = await useTaskStore
      .getState()
      .loadMergeWorkflowReview('task-1');

    expect(recoveredRuntime?.phase).toBe('ready');
    expect(gitDiffMock).toHaveBeenCalledTimes(2);
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it('activates merge workflows on the target repository root instead of the task worktree', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      branchWorktrees: {
        'project-1::feature/review-actions': '/repos/web/.macro/worktrees/task-1',
      },
      mergeWorkflowRuntimeByTaskId: {
        'task-1': buildBlockedMergeRuntime(),
      },
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    await useTaskStore.getState().activateTask('task-1');

    expect(useTaskStore.getState().activeRepositoryPath).toBe('/repos/web');
    expect(useTaskStore.getState().activeBranchName).toBe('plan/review-actions');
    expect(useTaskStore.getState().activeWorkspacePathOverridesByProjectId).toEqual({
      'project-1': '/repos/web',
    });
  });

  it('synchronizes the merge root workspace before starting automatic resolution', async () => {
    gitMergeCheckMock.mockImplementation(async () => ({
      mergeable: false,
      conflictFiles: ['src/main.ts'],
      hasChanges: true,
      ahead: 1,
      behind: 0,
    }));
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      branchWorktrees: {
        'project-1::feature/review-actions': '/repos/web/.macro/worktrees/task-1',
      },
      mergeWorkflowRuntimeByTaskId: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const resolution = await useTaskStore
      .getState()
      .resolveMergeWorkflowAutomatically('task-1', {
        blockerResolutionAction: 'stash_dirty',
      });

    expect(resolution).toEqual({
      conversationId: 'conv-1',
      autoResolvedRepositoryCount: 0,
      remainingBlockedRepositoryCount: 1,
    });
    expect(useTaskStore.getState().activeRepositoryPath).toEqual(
      expect.stringContaining('/repos/web/.macro/worktrees/integration-')
    );
    expect(useTaskStore.getState().activeBranchName).toBe('plan/review-actions');
    expect(useTaskStore.getState().activeWorkspacePathOverridesByProjectId).toEqual({
      'project-1': expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
    });
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        taskId: 'task-1',
        internalAgentProfile: 'default_executor',
        content: expect.stringContaining('Blocked repositories:'),
      })
    );
  });

  it('scopes assistant conflict prompts to the selected repository', async () => {
    const runtime = buildBlockedMergeRuntime();
    const secondRepository = {
      ...runtime.repositories[0],
      id: 'project-2::/repos/api',
      projectId: 'project-2',
      repoPath: '/repos/api',
      conflictFiles: ['src/api.ts'],
      blockingReason: 'Cannot continue merge because /repos/api would conflict in: src/api.ts.',
    };
    runtime.repositories = [runtime.repositories[0], secondRepository];
    runtime.blockedRepositories = runtime.repositories;
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      mergeWorkflowRuntimeByTaskId: {
        'task-1': runtime,
      },
      loadMergeWorkflowReview: mock(async () => runtime),
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const resolution = await useTaskStore
      .getState()
      .resolveMergeWorkflowAutomatically('task-1', {
        blockerResolutionAction: 'assistant',
        repositoryId: 'project-2::/repos/api',
      });

    expect(resolution.remainingBlockedRepositoryCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('/repos/api'),
      })
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.not.stringContaining('/repos/web'),
      })
    );
  });

  it('does not include dirty repositories in unscoped assistant conflict prompts', async () => {
    const runtime = buildBlockedMergeRuntime();
    const dirtyRepository: MergeWorkflowRepositoryResult = {
      ...runtime.repositories[0],
      id: 'project-2::/repos/api',
      projectId: 'project-2',
      repoPath: '/repos/api',
      isClean: false,
      conflictFiles: ['src/local-conflict.ts'],
      dirtyFiles: [{ path: 'src/local.ts', status: 'modified', area: 'unstaged' }],
      blockingKind: 'repository_dirty',
      nextAction: 'clean_repository',
      blockingReason: 'Cannot continue merge because /repos/api has uncommitted changes.',
      mergeStrategy: 'dirty',
      recommendedAction: 'stash_dirty',
      availableActions: ['stash_dirty', 'revert_dirty', 'assistant', 'retry_check'],
    };
    runtime.repositories = [runtime.repositories[0], dirtyRepository];
    runtime.blockedRepositories = runtime.repositories;
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      mergeWorkflowRuntimeByTaskId: {
        'task-1': runtime,
      },
      loadMergeWorkflowReview: mock(async () => runtime),
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const resolution = await useTaskStore
      .getState()
      .resolveMergeWorkflowAutomatically('task-1', {
        blockerResolutionAction: 'assistant',
      });

    expect(resolution.remainingBlockedRepositoryCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('/repos/web'),
      })
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.not.stringContaining('/repos/api'),
      })
    );
  });

  it('starts and completes manual merge conflict resolution for a repository', async () => {
    const runtime = buildBlockedMergeRuntime();
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      mergeWorkflowRuntimeByTaskId: {
        'task-1': runtime,
      },
      loadMergeWorkflowReview: mock(async () => runtime),
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const startResult = await useTaskStore
      .getState()
      .startMergeWorkflowManualResolution('task-1', 'project-1::/repos/web');
    const completeResult = await useTaskStore
      .getState()
      .completeMergeWorkflowManualResolution('task-1', 'project-1::/repos/web');

    expect(startResult?.status).toBe('conflicted');
    expect(gitStartMergeResolutionMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchName: 'feature/review-actions',
      intoBranch: 'plan/review-actions',
    });
    expect(completeResult).toBe('Merge completed');
    expect(gitCompleteMergeMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
    });
    expect(
      useTaskStore.getState().mergeWorkflowRuntimeByTaskId['task-1']?.repositories[0]?.progressState
    ).toBe('merged');
  });

  it('does not inspect Git publication for a blocked standalone target', async () => {
    const task = buildStandaloneTask({
      id: 'manual-task-blocked',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      draft: false,
      status: 'InProgress',
      assigned_branch: 'feature/blocked',
      branch_name: 'feature/blocked',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'git',
        branchName: 'feature/blocked',
        executionKind: 'worktree',
        worktreeKey: 'project-1::feature/blocked',
        repoPath: '/repos/web',
      }],
    });
    appStoreState.getProjectById = () => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      directEdit: false,
      gitSetupState: 'unborn',
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({ tasks: [task], lastError: null });

    await expect(useTaskStore.getState().deleteTask(task.id)).rejects.toThrow(
      'Create the initial commit',
    );

    expect(gitBranchListMock).not.toHaveBeenCalled();
    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(workspaceDeleteManualFeatureMock).not.toHaveBeenCalled();
  });

  it('loads merge review for only the Git target of a mixed task', async () => {
    appStoreState.projectGroups = [{
      id: 'group-1',
      name: 'Group One',
      isOpen: true,
      projects: [
        {
          id: 'project-1',
          name: 'Project One',
          path: '/repos/web',
          gitSetupState: 'ready',
          directEdit: false,
        },
        {
          id: 'direct-project',
          name: 'Direct Project',
          path: '/repos/direct',
          gitSetupState: 'not_git',
          directEdit: true,
        },
      ],
    }];
    appStoreState.getProjectById = (projectId: string) =>
      appStoreState.projectGroups[0]?.projects.find((project) => project.id === projectId) ?? null;
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask({
        project_ids: ['project-1', 'direct-project'],
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            executionMode: 'git',
            worktreeKey: 'project-1::feature/review-actions',
            repoPath: '/repos/web',
          },
          {
            projectId: 'direct-project',
            branchName: '',
            executionKind: 'repository_root',
            executionMode: 'direct',
            checkpointId: 'checkpoint-1',
            worktreeKey: 'direct:direct-project:task-1',
            repoPath: '/repos/direct',
          },
        ],
      })],
      branchWorktrees: {
        'project-1::feature/review-actions': '/repos/web/.macro/worktrees/task-1',
        'direct:direct-project:task-1': '/repos/direct',
      },
      mergeWorkflowRuntimeByTaskId: {},
    });

    const runtime = await useTaskStore.getState().loadMergeWorkflowReview('task-1', { force: true });

    expect(runtime?.repositories).toHaveLength(1);
    expect(runtime?.repositories[0]?.projectId).toBe('project-1');
    const gitArguments = [
      ...gitStatusMock.mock.calls,
      ...gitDiffMock.mock.calls,
      ...gitMergeCheckMock.mock.calls,
      ...gitBranchListMock.mock.calls,
    ].flat();
    expect(gitArguments.some((argument) => JSON.stringify(argument).includes('/repos/direct')))
      .toBe(false);
  });

  it('does not report a materialized merge complete when its plan metadata is missing', async () => {
    globalThis.localStorage?.clear();
    let statusCallCount = 0;
    gitStatusMock.mockImplementation(async () => {
      statusCallCount += 1;
      const isTaskWorktreePrecheck = statusCallCount === 1;
      return {
        branch: isTaskWorktreePrecheck
          ? 'feature/review-actions'
          : 'plan/review-actions',
        is_clean: isTaskWorktreePrecheck,
        staged_files: isTaskWorktreePrecheck
          ? []
          : [{ path: 'src/main.ts', status: 'modified' }],
        unstaged_files: [],
        untracked_files: [],
        conflicted_files: [],
        conflictedFiles: [],
        merge_in_progress: !isTaskWorktreePrecheck,
        mergeInProgress: !isTaskWorktreePrecheck,
      };
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask({ plan_id: 'missing-plan' })],
      branchWorktrees: {
        'project-1::feature/review-actions': '/repos/web/.macro/worktrees/task-1',
      },
      mergeWorkflowRuntimeByTaskId: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    await expect(useTaskStore.getState().runMergeWorkflow('task-1')).rejects.toThrow(
      'Cannot update plan metadata for task task-1.'
    );

    expect(gitCompleteMergeMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
    });
    expect(gitFastForwardMock).not.toHaveBeenCalled();
    expect(gitStartMergeResolutionMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().mergeWorkflowRuntimeByTaskId['task-1']).toBeDefined();
    expect(useTaskStore.getState().lastError).toContain(
      'Cannot update plan metadata for task task-1.'
    );
  });

  it('does not start a second manual merge resolution when conflicts are already materialized', async () => {
    const runtime = buildBlockedMergeRuntime();
    runtime.repositories = runtime.repositories.map((repository) => ({
      ...repository,
      mergeInProgress: true,
      conflictFiles: ['src/main.ts'],
    }));
    runtime.blockedRepositories = runtime.repositories;
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      mergeWorkflowRuntimeByTaskId: {
        'task-1': runtime,
      },
      loadMergeWorkflowReview: mock(async () => runtime),
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const startResult = await useTaskStore
      .getState()
      .startMergeWorkflowManualResolution('task-1', 'project-1::/repos/web');

    expect(startResult).toEqual({
      status: 'conflicted',
      conflictFiles: ['src/main.ts'],
      output: '',
    });
    expect(gitStartMergeResolutionMock).not.toHaveBeenCalled();
  });

  it('automatically stashes dirty merge blockers before opening the assistant', async () => {
    let hasStashedDirtyChanges = false;
    gitStashMock.mockImplementation(async () => {
      hasStashedDirtyChanges = true;
      return 'stash@{0}';
    });
    gitStatusMock.mockImplementation(async () => {
      return {
        branch: 'plan/review-actions',
        is_clean: hasStashedDirtyChanges,
        conflicted_files: [],
        conflictedFiles: [],
        merge_in_progress: false,
        mergeInProgress: false,
      };
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      branchWorktrees: {
        'project-1::feature/review-actions': '/repos/web/.macro/worktrees/task-1',
      },
      mergeWorkflowRuntimeByTaskId: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const resolution = await useTaskStore
      .getState()
      .resolveMergeWorkflowAutomatically('task-1', {
        blockerResolutionAction: 'stash_dirty',
      });

    expect(resolution).toEqual({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    });
    expect(gitStashMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      message: 'Macro merge blocker: Task 1',
    });
    expect(gitStatusMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().mergeWorkflowRuntimeByTaskId['task-1']?.phase).toBe('ready');
  });

  it('commits staged merge resolutions before continuing the workflow', async () => {
    const stagedRuntime = buildBlockedMergeRuntime();
    stagedRuntime.repositories = stagedRuntime.repositories.map((repository) => ({
      ...repository,
      isClean: false,
      mergeable: true,
      conflictFiles: [],
      dirtyFiles: [
        { path: 'lib/l10n/app_localizations.dart', status: 'modified', area: 'staged' },
        { path: 'lib/l10n/app_ar.arb', status: 'added', area: 'staged' },
      ],
      blockingKind: 'repository_dirty',
      nextAction: 'clean_repository',
      blockingReason: 'Cannot continue merge because /repos/web has uncommitted changes.',
      mergeStrategy: 'dirty',
      recommendedAction: 'commit_staged_resolution',
      availableActions: [
        'commit_staged_resolution',
        'revert_dirty',
        'assistant',
        'retry_check',
      ],
    }));
    stagedRuntime.blockedRepositories = stagedRuntime.repositories;
    const readyRuntime: MergeWorkflowRuntimeState = {
      ...stagedRuntime,
      phase: 'ready',
      taskStatus: 'InProgress',
      blockedRepositories: [],
      message: null,
      repositories: stagedRuntime.repositories.map((repository) => ({
        ...repository,
        isClean: true,
        dirtyFiles: [],
        blockingKind: null,
        nextAction: null,
        blockingReason: null,
      })),
    };
    const loadMergeWorkflowReviewMock = mock()
      .mockResolvedValueOnce(stagedRuntime)
      .mockResolvedValueOnce(readyRuntime);
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      mergeWorkflowRuntimeByTaskId: {
        'task-1': stagedRuntime,
      },
      loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const resolution = await useTaskStore
      .getState()
      .resolveMergeWorkflowAutomatically('task-1', {
        blockerResolutionAction: 'commit_staged_resolution',
      });

    expect(resolution).toEqual({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    });
    expect(gitCommitMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      message: 'chore: apply staged merge resolution',
      stageAll: false,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('automatically reverts dirty merge blockers before opening the assistant', async () => {
    let hasRevertedDirtyChanges = false;
    gitRestorePathsMock.mockImplementation(async () => {
      hasRevertedDirtyChanges = true;
    });
    gitStatusMock.mockImplementation(async () => {
      return {
        branch: 'plan/review-actions',
        is_clean: hasRevertedDirtyChanges,
        staged_files: hasRevertedDirtyChanges
          ? []
          : [{ path: 'src/staged.ts', status: 'modified' }],
        unstaged_files: hasRevertedDirtyChanges
          ? []
          : [{ path: 'src/unstaged.ts', status: 'modified' }],
        untracked_files: hasRevertedDirtyChanges
          ? []
          : [{ path: 'src/new.ts', status: 'added' }],
        conflicted_files: [],
        conflictedFiles: [],
        merge_in_progress: false,
        mergeInProgress: false,
      };
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      branchWorktrees: {
        'project-1::feature/review-actions': '/repos/web/.macro/worktrees/task-1',
      },
      mergeWorkflowRuntimeByTaskId: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const resolution = await useTaskStore
      .getState()
      .resolveMergeWorkflowAutomatically('task-1', {
        blockerResolutionAction: 'revert_dirty',
      });

    expect(resolution).toEqual({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    });
    expect(gitRestorePathsMock).toHaveBeenCalledWith({
      repoPath: expect.stringContaining('/repos/web/.macro/worktrees/integration-'),
      paths: ['src/staged.ts', 'src/unstaged.ts', 'src/new.ts'],
      target: 'staged_and_worktree',
    });
    expect(gitStatusMock).toHaveBeenCalledTimes(3);
    expect(gitStashMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().mergeWorkflowRuntimeByTaskId['task-1']?.phase).toBe('ready');
  });

  it('does not auto-abort a resolved merge that is ready to complete', async () => {
    let hasAbortedMerge = false;
    gitAbortMergeMock.mockImplementation(async () => {
      hasAbortedMerge = true;
    });
    gitStatusMock.mockImplementation(async () => {
      return {
        branch: 'plan/review-actions',
        is_clean: hasAbortedMerge,
        conflicted_files: [],
        conflictedFiles: [],
        merge_in_progress: !hasAbortedMerge,
        mergeInProgress: !hasAbortedMerge,
      };
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildMergeReviewTask()],
      branchWorktrees: {
        'project-1::feature/review-actions': '/repos/web/.macro/worktrees/task-1',
      },
      mergeWorkflowRuntimeByTaskId: {},
      activeBranchName: null,
      activeRepositoryPath: null,
      activeWorkspacePathOverridesByProjectId: {},
      lastError: null,
    });

    const resolution = await useTaskStore
      .getState()
      .resolveMergeWorkflowAutomatically('task-1', {
        blockerResolutionAction: 'abort_merge',
      });

    expect(resolution).toEqual({
      conversationId: null,
      autoResolvedRepositoryCount: 0,
      remainingBlockedRepositoryCount: 0,
    });
    expect(gitAbortMergeMock).not.toHaveBeenCalled();
    expect(gitStatusMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().mergeWorkflowRuntimeByTaskId['task-1']?.phase).toBe('ready');
  });
});

describe('useTaskStore optimistic AwaitingResponse transitions', () => {
  beforeEach(() => {
    workspaceUpdateStandaloneTaskStatusMock.mockClear();
    gitWorktreeRemoveMock.mockClear();
    gitBranchListMock.mockClear();
    gitBranchDeleteMock.mockClear();
    workspaceRevertManualFeatureToDraftMock.mockClear();
    syncTerminalDisplayMetadataMock.mockClear();
    syncManualFeatureMetadataFromTaskMock.mockClear();
    commitManualFeatureMetadataMock.mockClear();
    removeManualFeatureMetadataMock.mockClear();
    appStoreState.selectedTaskId = null;
    appStoreState.getProjectById = (projectId: string) => projectId === 'project-1'
      ? {
          id: 'project-1',
          name: 'Project One',
          path: '/repos/web',
          gitSetupState: 'ready',
          directEdit: false,
        }
      : null;
    appStoreState.setSelectedTask.mockClear();
    updateStandaloneTaskStatusImpl = null;
  });

  it('applies AwaitingResponse locally before standalone persistence completes', async () => {
    let resolvePersistence: (() => void) | null = null;
    updateStandaloneTaskStatusImpl = async () =>
      await new Promise<void>((resolve) => {
        resolvePersistence = resolve;
      });

    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => undefined);

    useTaskStore.setState({
      tasks: [buildStandaloneTask({ status: 'InProgress' })],
      refreshFromPlan: refreshFromPlanMock,
      lastError: null,
    });

    const transitionPromise = useTaskStore
      .getState()
      .markTaskAwaitingResponse('task-1');

    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe(
      'AwaitingResponse',
    );

    expect(resolvePersistence).toBeDefined();
    invokeDeferredResolver(resolvePersistence);
    await transitionPromise;

    expect(workspaceUpdateStandaloneTaskStatusMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'AwaitingResponse',
    });
    expect(refreshFromPlanMock).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it('rolls back AwaitingResponse locally when standalone persistence fails', async () => {
    updateStandaloneTaskStatusImpl = async () => {
      throw new Error('Persistence failed');
    };

    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => undefined);

    useTaskStore.setState({
      tasks: [buildStandaloneTask({ status: 'InProgress' })],
      refreshFromPlan: refreshFromPlanMock,
      lastError: null,
    });

    const transitionPromise = useTaskStore
      .getState()
      .markTaskAwaitingResponse('task-1');

    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe(
      'AwaitingResponse',
    );

    await transitionPromise;

    expect(refreshFromPlanMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe(
      'InProgress',
    );
    expect(useTaskStore.getState().lastError).toBe('Persistence failed');
  });

  it('allows an assistant follow-up while a task is in review', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => undefined);

    useTaskStore.setState({
      tasks: [buildStandaloneTask({ status: 'InReview' })],
      refreshFromPlan: refreshFromPlanMock,
      lastError: null,
    });

    await useTaskStore.getState().markTaskAwaitingResponse('task-1');

    expect(workspaceUpdateStandaloneTaskStatusMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'AwaitingResponse',
    });
    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe(
      'AwaitingResponse',
    );
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it('finishes a direct-edit task without entering the merge workflow', async () => {
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      directEdit: true,
      gitSetupState: 'not_git',
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => {
      useTaskStore.setState({
        tasks: [buildStandaloneTask({ status: 'Completed' })],
      });
    });
    const runMergeWorkflowMock = mock(async () => undefined);
    useTaskStore.setState({
      tasks: [buildStandaloneTask({
        status: 'InReview',
        execution_targets: [{
          projectId: 'project-1',
          executionMode: 'direct',
          branchName: 'direct',
          worktreeKey: 'project-1::direct',
          executionKind: 'worktree',
          repoPath: '/repos/web',
        }],
      })],
      refreshFromPlan: refreshFromPlanMock,
      runMergeWorkflow: runMergeWorkflowMock,
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1');
    appStoreState.getProjectById = (_projectId: string) => null;

    expect(workspaceUpdateStandaloneTaskStatusMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'Completed',
    });
    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe('Completed');
    expect(runMergeWorkflowMock).not.toHaveBeenCalled();
    expect(refreshFromPlanMock).toHaveBeenCalledTimes(1);
  });

  it('finishes a Direct Git task without merging or cleaning its current branch', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => {
      useTaskStore.setState({
        tasks: [buildStandaloneTask({ status: 'Completed', task_kind: 'direct' })],
      });
    });
    const runMergeWorkflowMock = mock(async () => undefined);
    useTaskStore.setState({
      tasks: [buildStandaloneTask({
        status: 'InReview',
        task_kind: 'direct',
        assigned_branch: 'develop',
        branch_name: 'develop',
        execution_targets: [{
          projectId: 'project-1',
          branchName: 'develop',
          targetBranchName: 'develop',
          executionMode: 'git',
          executionKind: 'repository_root',
          baseCommitHash: 'base-hash',
          worktreeKey: 'repository-root-project-1',
          repoPath: '/repos/web',
        }],
      })],
      refreshFromPlan: refreshFromPlanMock,
      runMergeWorkflow: runMergeWorkflowMock,
      lastError: null,
    });

    await useTaskStore.getState().finishTask('task-1');

    expect(workspaceUpdateStandaloneTaskStatusMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'Completed',
    });
    expect(runMergeWorkflowMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
  });

  it('rejects direct-edit completion when persistence refuses the transition', async () => {
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      directEdit: true,
      gitSetupState: 'not_git',
    });
    updateStandaloneTaskStatusImpl = async () => {
      throw new Error('Persistence failed');
    };
    const { useTaskStore } = await loadIsolatedTaskStore();
    const runMergeWorkflowMock = mock(async () => undefined);
    useTaskStore.setState({
      tasks: [buildStandaloneTask({
        status: 'InReview',
        execution_targets: [{
          projectId: 'project-1',
          executionMode: 'direct',
          branchName: 'direct',
          worktreeKey: 'project-1::direct',
          executionKind: 'worktree',
          repoPath: '/repos/web',
        }],
      })],
      runMergeWorkflow: runMergeWorkflowMock,
      lastError: null,
    });

    await expect(useTaskStore.getState().finishTask('task-1')).rejects.toThrow('Persistence failed');

    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe('InReview');
    expect(runMergeWorkflowMock).not.toHaveBeenCalled();
    appStoreState.getProjectById = (_projectId: string) => null;
  });
});

describe('useTaskStore task status transition guards', () => {
  beforeEach(() => {
    workspaceUpdateStandaloneTaskStatusMock.mockClear();
    updateStandaloneTaskStatusImpl = null;
  });

  const buildBlockedTaskCompletionRuntime = (
    taskStatus: 'Blocked' | 'Failed' | 'Completed' = 'Blocked',
  ): MergeWorkflowRuntimeState => ({
    taskId: 'task-1',
    kind: 'task_completion',
    phase: taskStatus === 'Failed' ? 'failed' : 'blocked',
    taskStatus,
    review: {
      taskId: 'task-1',
      title: 'Task 1',
      taskSource: 'standalone',
      planId: null,
      planTitle: null,
      targetBranch: 'develop',
    },
    repositories: [],
    blockedRepositories: [],
    message: 'Resolve the repository blockers before retrying the merge.',
    lastLoadedAt: '2026-04-22T10:00:00.000Z',
  });

  it('allows merge-workflow blocked tasks to complete after blockers are resolved', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const mergeRuntime = buildBlockedTaskCompletionRuntime();

    useTaskStore.setState({
      tasks: [buildStandaloneTask({ status: 'Blocked', is_blocked: false })],
      mergeWorkflowRuntimeByTaskId: {
        'task-1': mergeRuntime,
      },
      lastError: null,
    });

    await useTaskStore.getState().setTaskStatus('task-1', 'Completed');

    expect(workspaceUpdateStandaloneTaskStatusMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe(
      'Completed',
    );
    expect(
      useTaskStore.getState().mergeWorkflowRuntimeByTaskId['task-1']?.taskStatus,
    ).toBe('Completed');
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it('allows merge-workflow blocked tasks to fail when assistant resolution errors', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const mergeRuntime = buildBlockedTaskCompletionRuntime();

    useTaskStore.setState({
      tasks: [buildStandaloneTask({ status: 'Blocked', is_blocked: false })],
      mergeWorkflowRuntimeByTaskId: {
        'task-1': mergeRuntime,
      },
      lastError: null,
    });

    await useTaskStore.getState().markTaskFailed('task-1');

    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe(
      'Failed',
    );
    expect(
      useTaskStore.getState().mergeWorkflowRuntimeByTaskId['task-1']?.phase,
    ).toBe('failed');
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it('still blocks dependency-blocked tasks from completing', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();

    useTaskStore.setState({
      tasks: [
        buildStandaloneTask({
          status: 'Blocked',
          is_blocked: true,
          blocked_by: ['task-0'],
          blocked_by_task_ids: ['task-0'],
        }),
      ],
      lastError: null,
    });

    await useTaskStore.getState().setTaskStatus('task-1', 'Completed');

    expect(workspaceUpdateStandaloneTaskStatusMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe(
      'Blocked',
    );
    expect(useTaskStore.getState().lastError).toContain(
      'Task is blocked by unresolved dependencies',
    );
  });
});

describe('useTaskStore execution blocker messages', () => {
  it('requires the initial commit instead of suggesting direct editing for an unborn repository', async () => {
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      directEdit: false,
      gitSetupState: 'unborn',
    });
    const { useTaskStore } = await loadIsolatedTaskStore();

    await expect(useTaskStore.getState().createManualFeatureDraft({
      taskId: 'task-unborn',
      conversationId: 'conversation-unborn',
      groupId: 'group-1',
      projectIds: ['project-1'],
      contextProjectIds: [],
      taskKind: 'feature',
    })).rejects.toThrow('Create the initial commit');

    expect(useTaskStore.getState().lastError).toContain('Create the initial commit');
  });
});

describe('useTaskStore reopenTask and retryTask', () => {
  beforeEach(() => {
    workspaceUpdateStandaloneTaskStatusMock.mockClear();
    updateStandaloneTaskStatusImpl = null;
    appStoreState.selectedTaskId = 'task-1';
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
    });
  });

  it('clears a stale lastError when reopening a Completed task', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => undefined);

    useTaskStore.setState({
      tasks: [buildStandaloneTask({
        status: 'Completed',
        standalone_kind: 'manual_feature',
      })],
      lastError: 'Cannot complete task while repository has uncommitted changes.',
      refreshFromPlan: refreshFromPlanMock as never,
    });

    await useTaskStore.getState().reopenTask('task-1');

    expect(useTaskStore.getState().lastError).toBeNull();
    expect(refreshFromPlanMock).toHaveBeenCalled();
  });

  it('keeps the lastError when reopening an unknown task id', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();

    useTaskStore.setState({
      tasks: [],
      lastError: null,
    });

    await useTaskStore.getState().reopenTask('unknown-id');

    expect(useTaskStore.getState().lastError).toContain('Unknown task');
  });

  it('clears a stale lastError when retrying a Failed task', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const startTaskMock = mock(async () => undefined);

    useTaskStore.setState({
      tasks: [buildStandaloneTask({ status: 'Failed' })],
      lastError: 'Cannot continue merge: branches have diverged.',
      startTask: startTaskMock as never,
    });

    await useTaskStore.getState().retryTask('task-1');

    expect(startTaskMock).toHaveBeenCalledWith('task-1');
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it('clears a stale lastError when retrying an AwaitingResponse task', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => undefined);

    useTaskStore.setState({
      tasks: [buildStandaloneTask({ status: 'AwaitingResponse' })],
      lastError: 'Stale dependency block message.',
      refreshFromPlan: refreshFromPlanMock as never,
    });

    await useTaskStore.getState().retryTask('task-1');

    expect(useTaskStore.getState().lastError).toBeNull();
  });
});

describe('useTaskStore revertManualFeatureToDraft', () => {
  beforeEach(() => {
    gitStatusMock.mockClear();
    gitStatusMock.mockImplementation(async () => ({
      branch: 'feature/quick-export',
      is_clean: true,
      conflicted_files: [],
      conflictedFiles: [],
      merge_in_progress: false,
      mergeInProgress: false,
    }));
    gitWorktreeRemoveMock.mockClear();
    gitBranchListMock.mockClear();
    gitBranchDeleteMock.mockClear();
    directCheckpointResolveIdMock.mockClear();
    directCheckpointRemoveMock.mockClear();
    workspaceRevertManualFeatureToDraftMock.mockClear();
    syncTerminalDisplayMetadataMock.mockClear();
    syncManualFeatureMetadataFromTaskMock.mockClear();
    appStoreState.selectedTaskId = null;
    appStoreState.getProjectById = (projectId: string) => projectId === 'project-1'
      ? {
          id: 'project-1',
          name: 'Project One',
          path: '/repos/web',
          gitSetupState: 'ready',
          directEdit: false,
        }
      : null;
  });

  it('cleans standalone execution state and reverts the task to draft metadata', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();

    const refreshFromPlanMock = mock(async () => {
      useTaskStore.setState({
        tasks: [
          buildStandaloneTask({
            standalone_kind: 'manual_feature',
            title: 'New feature',
            description: '',
            status: 'Pending',
            draft: true,
            feature_slug: null,
            assigned_branch: '',
            branch_name: '',
            execution_targets: [],
            conversation_id: 'conv-1',
            base_branch: 'develop',
          }),
        ],
      });
    });

    useTaskStore.setState({
      tasks: [
        buildStandaloneTask({
          standalone_kind: 'manual_feature',
          title: 'Quick export',
          description: 'Add a quick CSV export from the table.',
          status: 'InProgress',
          draft: false,
          feature_slug: 'quick-export',
          assigned_branch: 'feature/quick-export',
          branch_name: 'feature/quick-export',
          conversation_id: 'conv-1',
          base_branch: 'develop',
          execution_targets: [
            {
              projectId: 'project-1',
              branchName: 'feature/quick-export',
              worktreeKey: 'project-1::feature/quick-export',
              repoPath: '/repos/web',
              executionMode: 'git',
            },
          ],
        }),
      ],
      branchWorktrees: {
        'project-1::feature/quick-export':
          '/repos/web/.macro/worktrees/task-1',
      },
      activeBranchName: 'feature/quick-export',
      activeRepositoryPath: '/repos/web/.macro/worktrees/task-1',
      refreshFromPlan: refreshFromPlanMock,
      lastError: null,
    });

    await useTaskStore.getState().revertManualFeatureToDraft({
      taskId: 'task-1',
      conversationId: 'conv-1',
      title: 'New feature',
      description: '',
    });

    expect(gitWorktreeRemoveMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      taskId: 'project-1::feature/quick-export',
      force: false,
      branchName: 'feature/quick-export',
    });
    expect(gitBranchListMock).toHaveBeenCalledWith('/repos/web');
    expect(gitBranchDeleteMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchName: 'feature/quick-export',
      force: false,
    });
    expect(workspaceRevertManualFeatureToDraftMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      conversationId: 'conv-1',
      title: 'New feature',
      description: '',
    });
    expect(syncTerminalDisplayMetadataMock).toHaveBeenCalledWith({
      taskId: 'task-1',
    });
    expect(syncManualFeatureMetadataFromTaskMock).toHaveBeenCalled();
    expect(useTaskStore.getState().branchWorktrees).toEqual({});
    expect(useTaskStore.getState().activeBranchName).toBeNull();
    expect(useTaskStore.getState().activeRepositoryPath).toBeNull();
    expect(useTaskStore.getState().getTaskById('task-1')).toMatchObject({
      draft: true,
      title: 'New feature',
      description: '',
      status: 'Pending',
      feature_slug: null,
      branch_name: '',
      assigned_branch: '',
    });
  });

  it('keeps a task in direct mode when Git is initialized without a commit before it returns to draft', async () => {
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      directEdit: false,
      gitSetupState: 'unborn',
    });
    const { useTaskStore } = await loadIsolatedTaskStore();
    const refreshFromPlanMock = mock(async () => {
      useTaskStore.setState({
        tasks: [buildStandaloneTask({
          standalone_kind: 'manual_feature',
          status: 'Pending',
          draft: true,
          assigned_branch: '',
          branch_name: '',
          execution_targets: [],
        })],
      });
    });
    useTaskStore.setState({
      tasks: [buildStandaloneTask({
        standalone_kind: 'manual_feature',
        status: 'InProgress',
        draft: false,
        assigned_branch: 'direct',
        branch_name: 'direct',
        execution_targets: [{
          projectId: 'project-1',
          branchName: 'direct',
          executionMode: 'direct',
          checkpointId: 'task-checkpoint-0000000000000001',
          worktreeKey: 'project-1::direct',
          repoPath: '/repos/web',
        }],
      })],
      branchWorktrees: { 'project-1::direct': '/repos/web' },
      activeBranchName: 'direct',
      activeRepositoryPath: '/repos/web',
      refreshFromPlan: refreshFromPlanMock,
      lastError: null,
    });

    await useTaskStore.getState().revertManualFeatureToDraft({ taskId: 'task-1' });

    expect(directCheckpointRemoveMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      checkpointId: 'task-checkpoint-0000000000000001',
      projectPath: '/repos/web',
    });
    expect(directCheckpointResolveIdMock).not.toHaveBeenCalled();
    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitBranchListMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(gitBranchDeleteMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().branchWorktrees).toEqual({});
  });
});

describe('useTaskStore remote runtime guards', () => {
  it('rejects task status mutations with the stable remote unsupported error', async () => {
    const previousTransport = process.env.VITE_BACKEND_TRANSPORT;
    process.env.VITE_BACKEND_TRANSPORT = 'remote';

    try {
      const { useTaskStore } = await loadIsolatedTaskStore();
      useTaskStore.setState({
        tasks: [buildStandaloneTask({ status: 'InProgress' })],
        lastError: null,
      });

      await expect(
        useTaskStore.getState().setTaskStatus('task-1', 'InReview'),
      ).rejects.toMatchObject({
        code: REMOTE_UNSUPPORTED_IN_REMOTE_MODE,
        message: REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
      });

      expect(useTaskStore.getState().getTaskById('task-1')?.status).toBe(
        'InProgress',
      );
      expect(useTaskStore.getState().lastError).toBe(
        REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
      );
    } finally {
      if (previousTransport === undefined) {
        delete process.env.VITE_BACKEND_TRANSPORT;
      } else {
        process.env.VITE_BACKEND_TRANSPORT = previousTransport;
      }
    }
  });
});

describe('useTaskStore task command terminal lifecycle', () => {
  beforeEach(() => {
    startTaskCommandTabMock.mockClear();
    runWorktreeSetupCommandMock.mockClear();
    appStoreState.selectedTaskId = null;
    appStoreState.selectedGroupId = 'group-1';
    appStoreState.selectedProjectId = null;
    appStoreState.projectGroups = [
      {
        id: 'group-1',
        name: 'Group One',
        isOpen: true,
        projects: [
          {
            id: 'project-1',
            name: 'Project One',
            path: '/repos/web',
            gitSetupState: 'ready' as const,
            directEdit: false,
          },
        ],
      },
    ];
    appStoreState.standaloneProjects = [];
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-1',
      name: 'Project One',
      path: '/repos/web',
      gitSetupState: 'ready' as const,
      directEdit: false,
    });
    taskProjectCommandRegistryMock = {
      version: 3,
      commandsByProjectPath: {
        '/repos/web': {
          projectId: 'project-1',
          projectName: 'Project One',
          projectPath: '/repos/web',
          command: 'npm test',
          worktreeSetupCommand: '',
          openTerminalOnRun: true,
          updatedAt: '2026-06-03T10:00:00.000Z',
        },
      },
    };
  });

  it('keeps the command run visible after launching a task terminal', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();

    useTaskStore.setState({
      tasks: [
        buildStandaloneTask({
          id: 'task-1',
          title: 'Run app',
          status: 'InProgress',
          draft: false,
          project_id: 'project-1',
          project_ids: ['project-1'],
          execution_targets: [
            {
              projectId: 'project-1',
              executionMode: 'git',
              branchName: 'feature/run-app',
              worktreeKey: 'project-1::feature/run-app',
              repoPath: '/repos/web',
            },
          ],
        }),
      ],
      branchWorktrees: {
        'project-1::feature/run-app': '/repos/web/.macro/worktrees/task-1',
      },
      taskCommandRuns: {},
      lastError: null,
    });

    const result = await useTaskStore.getState().runTaskCommands('task-1');

    expect(result).toMatchObject({
      status: 'completed',
      completedCount: 1,
      totalCount: 1,
    });
    expect(startTaskCommandTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        projectId: 'project-1',
        cwd: '/repos/web/.macro/worktrees/task-1',
        command: 'npm test',
      })
    );
    expect(runWorktreeSetupCommandMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().taskCommandRuns['task-1']).toMatchObject({
      status: 'running',
      activeTabIds: ['terminal-tab-1'],
      currentProjectId: 'project-1',
    });
  });

  it('uses the current registry repo path instead of stale task target snapshots when launching commands', async () => {
    appStoreState.selectedGroupId = null;
    appStoreState.selectedProjectId = 'project-lplr-app-1780329499166';
    appStoreState.projectGroups = [];
    appStoreState.standaloneProjects = [
      {
        id: 'project-lplr-app-1780329499166',
        name: 'octan_sales',
        path: '/repos/octan_sales',
        gitSetupState: 'ready',
        directEdit: false,
      },
    ];
    appStoreState.getProjectById = (_projectId: string) => ({
      id: 'project-lplr-app-1780329499166',
      name: 'octan_sales',
      path: '/repos/octan_sales',
      gitSetupState: 'ready',
      directEdit: false,
    });
    taskProjectCommandRegistryMock = {
      version: 3,
      commandsByProjectPath: {
        '/repos/octan_sales': {
          projectId: 'project-lplr-app-1780329499166',
          projectName: 'octan_sales',
          projectPath: '/repos/octan_sales',
          command: 'npm test',
          worktreeSetupCommand: 'bun install',
          openTerminalOnRun: true,
          updatedAt: '2026-06-03T10:00:00.000Z',
        },
      },
    };
    const { useTaskStore } = await loadIsolatedTaskStore();

    useTaskStore.setState({
      tasks: [
        buildStandaloneTask({
          id: 'task-1',
          title: 'Run renamed app',
          status: 'InProgress',
          draft: false,
          project_id: 'project-lplr-app-1780329499166',
          project_ids: ['project-lplr-app-1780329499166'],
          execution_targets: [
            {
              projectId: 'project-lplr-app-1780329499166',
              branchName: 'feature/run-app',
              worktreeKey: 'branch-project-lplr-app-feature-run-app',
              repoPath: '/repos/lplr-app',
              executionMode: 'git',
            },
          ],
        }),
      ],
      branchWorktrees: {
        'project-lplr-app-1780329499166::feature/run-app':
          '/repos/octan_sales/.macro/worktrees/task-1',
      },
      taskCommandRuns: {},
      lastError: null,
    });

    const result = await useTaskStore.getState().runTaskCommands('task-1');

    expect(result).toMatchObject({
      status: 'completed',
      completedCount: 1,
      totalCount: 1,
    });
    expect(runWorktreeSetupCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-lplr-app-1780329499166',
        repoPath: '/repos/octan_sales',
        worktreePath: expect.stringContaining('/repos/octan_sales/.macro/worktrees/'),
        command: 'bun install',
      })
    );
    expect(startTaskCommandTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        projectId: 'project-lplr-app-1780329499166',
        cwd: expect.stringContaining('/repos/octan_sales/.macro/worktrees/'),
        command: 'npm test',
      })
    );
  });

  it('runs the configured worktree setup command before launching task commands', async () => {
    taskProjectCommandRegistryMock = {
      version: 3,
      commandsByProjectPath: {
        '/repos/web': {
          projectId: 'project-1',
          projectName: 'Project One',
          projectPath: '/repos/web',
          command: 'npm test',
          worktreeSetupCommand: 'bun install',
          openTerminalOnRun: true,
          updatedAt: '2026-06-03T10:00:00.000Z',
        },
      },
    };
    const { useTaskStore } = await loadIsolatedTaskStore();

    useTaskStore.setState({
      tasks: [
        buildStandaloneTask({
          id: 'task-1',
          title: 'Run app',
          status: 'InProgress',
          draft: false,
          project_id: 'project-1',
          project_ids: ['project-1'],
          execution_targets: [
            {
              projectId: 'project-1',
              executionMode: 'git',
              branchName: 'feature/run-app',
              worktreeKey: 'project-1::feature/run-app',
              repoPath: '/repos/web',
            },
          ],
        }),
      ],
      branchWorktrees: {
        'project-1::feature/run-app': '/repos/web/.macro/worktrees/task-1',
      },
      taskCommandRuns: {},
      lastError: null,
    });

    await useTaskStore.getState().runTaskCommands('task-1');

    expect(runWorktreeSetupCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        taskTitle: 'Run app',
        projectId: 'project-1',
        projectName: 'Project One',
        repoPath: '/repos/web',
        worktreePath: '/repos/web/.macro/worktrees/task-1',
        command: 'bun install',
      })
    );
    expect(startTaskCommandTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm test',
      })
    );
  });

  it('clears the active command run when its terminal tab is closed', async () => {
    const { useTaskStore } = await loadIsolatedTaskStore();

    useTaskStore.setState({
      taskCommandRuns: {
        'task-1': {
          taskId: 'task-1',
          status: 'running',
          currentProjectId: 'project-1',
          currentProjectName: 'Web',
          activeTabIds: ['terminal-tab-1'],
          startedAt: '2026-06-03T10:00:00.000Z',
        },
        'task-2': {
          taskId: 'task-2',
          status: 'running',
          currentProjectId: 'project-2',
          currentProjectName: 'API',
          activeTabIds: ['terminal-tab-2'],
          startedAt: '2026-06-03T10:01:00.000Z',
        },
      },
    });

    useTaskStore.getState().handleTaskCommandTerminalClosed('terminal-tab-1');

    expect(useTaskStore.getState().taskCommandRuns['task-1']).toBeUndefined();
    expect(useTaskStore.getState().taskCommandRuns['task-2']).toMatchObject({
      activeTabIds: ['terminal-tab-2'],
      currentProjectId: 'project-2',
    });
  });

  it('closes the associated terminal tab when cancelling a task command run', async () => {
    closeTabMock.mockClear();
    interruptTabMock.mockClear();
    const { useTaskStore } = await loadIsolatedTaskStore();

    useTaskStore.setState({
      taskCommandRuns: {
        'task-1': {
          taskId: 'task-1',
          status: 'running',
          currentProjectId: 'project-1',
          currentProjectName: 'Web',
          activeTabIds: ['terminal-tab-1'],
          startedAt: '2026-06-03T10:00:00.000Z',
        },
      },
      lastError: null,
    });

    await useTaskStore.getState().cancelTaskCommands('task-1');

    expect(closeTabMock).toHaveBeenCalledWith('terminal-tab-1');
    expect(interruptTabMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().taskCommandRuns['task-1']).toBeUndefined();
  });

  it('tracks and closes every terminal opened by a multi-project command batch', async () => {
    closeTabMock.mockClear();
    appStoreState.projectGroups = [
      {
        id: 'group-1',
        name: 'Group One',
        isOpen: true,
        projects: [
          {
            id: 'project-1',
            name: 'Project One',
            path: '/repos/web',
            gitSetupState: 'ready' as const,
            directEdit: false,
          },
          {
            id: 'project-2',
            name: 'Project Two',
            path: '/repos/api',
            gitSetupState: 'ready' as const,
            directEdit: false,
          },
        ],
      },
    ];
    appStoreState.getProjectById = (projectId: string) => projectId === 'project-2'
      ? {
          id: 'project-2',
          name: 'Project Two',
          path: '/repos/api',
          gitSetupState: 'ready' as const,
          directEdit: false,
        }
      : {
          id: 'project-1',
          name: 'Project One',
          path: '/repos/web',
          gitSetupState: 'ready' as const,
          directEdit: false,
        };
    taskProjectCommandRegistryMock = {
      version: 3,
      commandsByProjectPath: {
        '/repos/web': {
          projectId: 'project-1',
          projectName: 'Project One',
          projectPath: '/repos/web',
          command: 'npm test',
          worktreeSetupCommand: '',
          openTerminalOnRun: true,
          updatedAt: '2026-06-03T10:00:00.000Z',
        },
        '/repos/api': {
          projectId: 'project-2',
          projectName: 'Project Two',
          projectPath: '/repos/api',
          command: 'npm test',
          worktreeSetupCommand: '',
          openTerminalOnRun: true,
          updatedAt: '2026-06-03T10:00:00.000Z',
        },
      },
    };
    startTaskCommandTabMock
      .mockImplementationOnce(async () => ({
        id: 'terminal-tab-1',
        kind: 'task' as const,
        projectId: 'project-1',
        taskId: 'task-1',
        projectName: 'Project One',
        mountName: 'project-one',
        workspacePath: '/repos/web/.macro/worktrees/task-1-web',
        cwd: '/repos/web/.macro/worktrees/task-1-web',
        title: 'Project One - Task 1',
        status: 'running' as const,
        snapshot: 'npm test\r\n',
        lastCommand: 'npm test',
        lastExitCode: null,
        hasLiveSession: true,
        isRestored: false,
        outputSequence: 1,
        hasUnreadOutput: false,
        createdAt: '2026-06-03T10:00:00.000Z',
        updatedAt: '2026-06-03T10:00:00.000Z',
      }))
      .mockImplementationOnce(async () => ({
        id: 'terminal-tab-2',
        kind: 'task' as const,
        projectId: 'project-2',
        taskId: 'task-1',
        projectName: 'Project Two',
        mountName: 'project-two',
        workspacePath: '/repos/api/.macro/worktrees/task-1-api',
        cwd: '/repos/api/.macro/worktrees/task-1-api',
        title: 'Project Two - Task 1',
        status: 'running' as const,
        snapshot: 'npm test\r\n',
        lastCommand: 'npm test',
        lastExitCode: null,
        hasLiveSession: true,
        isRestored: false,
        outputSequence: 1,
        hasUnreadOutput: false,
        createdAt: '2026-06-03T10:00:00.000Z',
        updatedAt: '2026-06-03T10:00:00.000Z',
      }));

    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildStandaloneTask({
        id: 'task-1',
        status: 'InProgress',
        draft: false,
        project_id: 'project-1',
        project_ids: ['project-1', 'project-2'],
        execution_targets: [
          {
            projectId: 'project-1',
            executionMode: 'git',
            branchName: 'feature/run-app',
            worktreeKey: 'project-1::feature/run-app',
            repoPath: '/repos/web',
          },
          {
            projectId: 'project-2',
            executionMode: 'git',
            branchName: 'feature/run-app',
            worktreeKey: 'project-2::feature/run-app',
            repoPath: '/repos/api',
          },
        ],
      })],
      branchWorktrees: {
        'project-1::feature/run-app': '/repos/web/.macro/worktrees/task-1-web',
        'project-2::feature/run-app': '/repos/api/.macro/worktrees/task-1-api',
      },
      taskCommandRuns: {},
      lastError: null,
    });

    const result = await useTaskStore.getState().runTaskCommands('task-1');

    expect(result).toMatchObject({ status: 'completed', completedCount: 2, totalCount: 2 });
    expect(useTaskStore.getState().taskCommandRuns['task-1']?.activeTabIds).toEqual([
      'terminal-tab-1',
      'terminal-tab-2',
    ]);

    await useTaskStore.getState().cancelTaskCommands('task-1');

    expect(closeTabMock).toHaveBeenCalledWith('terminal-tab-1');
    expect(closeTabMock).toHaveBeenCalledWith('terminal-tab-2');
    expect(closeTabMock).toHaveBeenCalledTimes(2);
    expect(useTaskStore.getState().taskCommandRuns['task-1']).toBeUndefined();
  });
});

describe('useTaskStore task preparation safety', () => {
  it('rejects every target before preparing the Git part of a mixed blocked task', async () => {
    gitWorktreeInspectMock.mockClear();
    gitWorktreeCreateMock.mockClear();
    gitWorktreeRemoveMock.mockClear();
    appStoreState.selectedTaskId = null;
    appStoreState.selectedGroupId = 'group-1';
    appStoreState.selectedProjectId = 'project-git';
    appStoreState.projectGroups = [];
    appStoreState.standaloneProjects = [];
    appStoreState.getProjectById = (projectId: string) => projectId === 'project-git'
      ? {
          id: 'project-git',
          name: 'Git project',
          path: '/repos/git',
          gitSetupState: 'ready' as const,
          directEdit: false,
        }
      : {
          id: 'project-blocked',
          name: 'Blocked project',
          path: '/repos/blocked',
          gitSetupState: 'not_git' as const,
          directEdit: false,
          isReadOnly: true,
        };
    const { useTaskStore } = await loadIsolatedTaskStore();
    useTaskStore.setState({
      tasks: [buildStandaloneTask({
        id: 'mixed-blocked-task',
        status: 'Pending',
        draft: false,
        project_id: 'project-git',
        project_ids: ['project-git', 'project-blocked'],
        execution_targets: [
          {
            projectId: 'project-git',
            executionMode: 'git',
            branchName: 'feature/mixed-blocked',
            worktreeKey: 'project-git::feature/mixed-blocked',
            repoPath: '/repos/git',
          },
          {
            projectId: 'project-blocked',
            branchName: '',
            worktreeKey: 'project-blocked::blocked',
            repoPath: '/repos/blocked',
          },
        ],
      })],
      branchWorktrees: {},
      lastError: null,
    });

    await useTaskStore.getState().startTask('mixed-blocked-task');

    expect(gitWorktreeInspectMock).not.toHaveBeenCalled();
    expect(gitWorktreeCreateMock).not.toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().lastError).toContain('Initialize Git or enable direct editing');
  });

});
