import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE,
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
} from '../services/serviceRuntime';
import {
  buildPlanFinalizationFailureState,
  toBlockedPlanFinalizationState,
} from '../services/planFinalization';
import { getPlanActivationCandidateTask, type ImplementTask } from './useTaskStore';

const { clearPlanRuntimeStateSnapshot } = await import('./planRuntimeState');
const actualTauriIpc = await import('../services/tauriIpc');

let isolatedTaskStoreImportCounter = 0;
let updateStandaloneTaskStatusImpl: ((params: { taskId: string; status: string }) => Promise<void>) | null = null;
const gitWorktreeRemoveMock = mock(async () => ({
  removed: true,
  removedPath: '/repos/web/.macro/worktrees/task-1',
}));
const gitBranchListMock = mock(async () => ({
  local: [{ name: 'feature/quick-export', is_head: false, commit: 'abc123' }],
  remote: [],
  current: 'develop',
}));
const gitBranchDeleteMock = mock(async () => undefined);
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
const syncManualFeatureMetadataFromTaskMock = mock(async () => undefined);
const commitManualFeatureMetadataMock = mock(async () => undefined);
const removeManualFeatureMetadataMock = mock(async () => undefined);
const appStoreState = {
  selectedTaskId: null as string | null,
  getProjectById: (_projectId: string) => null,
  setSelectedTask: mock((_taskId: string | null) => undefined),
};

mock.module('../services/tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  workspaceUpdateStandaloneTaskStatus: workspaceUpdateStandaloneTaskStatusMock,
  gitWorktreeRemove: gitWorktreeRemoveMock,
  gitBranchList: gitBranchListMock,
  gitBranchDelete: gitBranchDeleteMock,
  workspaceRevertManualFeatureToDraft: workspaceRevertManualFeatureToDraftMock,
}));

mock.module('../services/tauriIpc.ts', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  workspaceUpdateStandaloneTaskStatus: workspaceUpdateStandaloneTaskStatusMock,
  gitWorktreeRemove: gitWorktreeRemoveMock,
  gitBranchList: gitBranchListMock,
  gitBranchDelete: gitBranchDeleteMock,
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
  return import(`./useTaskStore.ts?optimistic=${isolatedTaskStoreImportCounter}`);
};

const invokeDeferredResolver = (resolver: (() => void) | null) => {
  if (typeof resolver === 'function') {
    resolver();
  }
};

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
});

describe('useTaskStore revertManualFeatureToDraft', () => {
  beforeEach(() => {
    gitWorktreeRemoveMock.mockClear();
    gitBranchListMock.mockClear();
    gitBranchDeleteMock.mockClear();
    workspaceRevertManualFeatureToDraftMock.mockClear();
    syncTerminalDisplayMetadataMock.mockClear();
    syncManualFeatureMetadataFromTaskMock.mockClear();
    appStoreState.selectedTaskId = null;
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
      force: true,
      branchName: 'feature/quick-export',
    });
    expect(gitBranchListMock).toHaveBeenCalledWith('/repos/web');
    expect(gitBranchDeleteMock).toHaveBeenCalledWith({
      repoPath: '/repos/web',
      branchName: 'feature/quick-export',
      force: true,
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
});

describe('useTaskStore remote runtime guards', () => {
  it('rejects task status mutations with the stable remote unsupported error', async () => {
    const previousTransport = process.env.VITE_BACKEND_TRANSPORT;
    const previousProvider = process.env.VITE_DATA_PROVIDER;
    process.env.VITE_BACKEND_TRANSPORT = 'remote';
    delete process.env.VITE_DATA_PROVIDER;

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

      if (previousProvider === undefined) {
        delete process.env.VITE_DATA_PROVIDER;
      } else {
        process.env.VITE_DATA_PROVIDER = previousProvider;
      }
    }
  });
});
