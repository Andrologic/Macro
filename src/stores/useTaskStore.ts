import { create } from 'zustand';
import type { TaskExecutionTarget, TaskStatus } from '../types';
import i18n from '../i18n';
import {
  createRemoteUnsupportedInRemoteModeError,
  getServiceRuntimeCapabilities,
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
  services,
} from '../services';
import { toServiceError } from '../services/contracts/errors';
import { useAppStore } from './useAppStore';
import { useChatStore } from './useChatStore';
import { useGitStore } from './useGitStore';
import { useTerminalStore } from './useTerminalStore';
import {
  clearPlanRuntimeStateSnapshot,
  type ClearPlanRuntimeStateParams,
} from './planRuntimeState';
import { getLocalProjectContextState } from '../services/localProjectContext';
import * as tauriIpc from '../services/tauriIpc';
import {
  deriveImplementTasksFromStrategy,
  mapTaskStatusToNodeStatus,
  toBranchWorktreeKey,
} from '../services/implementTaskDerivation';
import {
  finalizePlanIntoBaseBranch,
  mergeFeatureBranchIntoPlanBranch,
} from '../services/architectGitFlowService';
import { shouldSyncTargetBranchBeforeFinish } from '../services/architectGitNaming';
import {
  commitArchitectPlanMetadata,
  getArchitectPlan,
  getArchitectPlanTargetBranchesByProjectId,
  getGitFlowBaseBranch,
  resolveTargetBranch,
  updateArchitectPlan,
  writeArchitectTaskExecution,
} from '../services/architectPlanService';
import {
  deriveFallbackImplementTasks,
  taskMatchesProjectId,
  type CatalogedImplementTask,
  type ImplementTaskPlanSummary,
} from '../services/implementTaskCatalog';
import { getScopedProjectIds } from '../services/globalProjects';
import {
  commitManualFeatureMetadata,
  removeManualFeatureMetadata,
  syncManualFeatureMetadataFromTask,
} from '../services/manualFeatureMetadataService';
import { isManualDraftPendingInitialization } from '../services/manualDraftInitialization';
import {
  buildPlanFinalizationFailureState,
  buildPlanFinalizationRefreshState,
  buildPlanFinalizationSuccessState,
  type BlockedPlanFinalizationState,
} from './taskStorePlanFinalizationState';
import {
  getTaskProjectCommand,
  loadTaskProjectCommandRegistry,
} from '../services/taskProjectCommands';
import { buildTerminalDisplayMetadata } from '../services/terminalDisplayMetadata';

type TaskSource = 'architect' | 'mixed' | 'fallback' | 'empty';

export interface TaskCompletionRepositoryRecord {
  projectId: string;
  repoPath: string;
  branchName: string;
  planBranchName: string;
  mergeOutput?: string;
}

interface CompleteTaskOptions {
  allowWithoutCodeChanges?: boolean;
  skipIntegration?: boolean;
  repositories?: TaskCompletionRepositoryRecord[];
}

export interface TaskMissingBaseBranchIssue {
  kind: 'missing_base_branch';
  taskId: string;
  projectId: string;
  repoPath: string;
  targetBranchName: string;
  missingRef: string;
  message: string;
}

let appSyncUnsubscribe: (() => void) | null = null;
const REMOTE_TASK_ACTION_UNAVAILABLE_MESSAGE = REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE;

const canUseTaskMutationRuntime = (): boolean => getServiceRuntimeCapabilities().taskMutation;
const canUseImplementExecutionRuntime = (): boolean =>
  getServiceRuntimeCapabilities().implementExecution;
const canUseTaskCommandRuntime = (): boolean =>
  getServiceRuntimeCapabilities().taskProjectCommands;

const normalizeBranchName = (value?: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const getExecutionTargets = (task: CatalogedImplementTask): TaskExecutionTarget[] => {
  if (task.draft) {
    return [];
  }

  if (task.execution_targets?.length) {
    return task.execution_targets;
  }

  if (!task.project_id) {
    return [];
  }

  return [{
    projectId: task.project_id,
    branchName: task.assigned_branch,
    worktreeKey: toBranchWorktreeKey(task.project_id, task.assigned_branch),
  }];
};

const getPrimaryExecutionTarget = (task: CatalogedImplementTask): TaskExecutionTarget | null => {
  return getExecutionTargets(task)[0] || null;
};

const getTaskIntegrationBranch = (
  task: CatalogedImplementTask,
  target: TaskExecutionTarget
): string | null => {
  if (target.planBranchName) {
    return target.planBranchName;
  }
  if (task.task_source === 'architect') {
    return null;
  }
  return resolveTargetBranch(target.targetBranchName || task.base_branch || getGitFlowBaseBranch());
};

const getPreferredExecutionTarget = (
  task: CatalogedImplementTask,
  preferredProjectId?: string | null
): TaskExecutionTarget | null => {
  const executionTargets = getExecutionTargets(task);
  if (executionTargets.length === 0) {
    return null;
  }

  if (preferredProjectId) {
    const matchingTarget = executionTargets.find((target) => target.projectId === preferredProjectId);
    if (matchingTarget) {
      return matchingTarget;
    }
  }

  return executionTargets[0] || null;
};

const isManualStandaloneTask = (task: CatalogedImplementTask): boolean =>
  task.task_source === 'standalone' && task.standalone_kind === 'manual_feature';

const isTaskArchived = (task: Pick<CatalogedImplementTask, 'archived_at'>): boolean =>
  Boolean(task.archived_at);

export interface TaskLifecycleCapabilities {
  isPublished: boolean;
  canRename: boolean;
  canDelete: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canReopen: boolean;
  deleteBlockReason: string | null;
}

const resolveTaskRepositoryPath = (
  projectId: string,
  explicitRepoPath?: string | null
): string | null =>
  explicitRepoPath || useAppStore.getState().getProjectById(projectId)?.path || null;

const getExecutionTargetsWithRepoPaths = (
  task: CatalogedImplementTask
): Array<TaskExecutionTarget & { repoPath: string }> =>
  getExecutionTargets(task)
    .map((target) => {
      const repoPath = resolveTaskRepositoryPath(target.projectId, target.repoPath);
      return repoPath ? { ...target, repoPath } : null;
    })
    .filter((target): target is TaskExecutionTarget & { repoPath: string } => Boolean(target));

const hasPublishedStandaloneBranch = async (task: CatalogedImplementTask): Promise<boolean> => {
  if (!tauriIpc.isTauriAvailable() || !isManualStandaloneTask(task) || task.draft || !task.branch_name) {
    return false;
  }

  const executionTargets = getExecutionTargetsWithRepoPaths(task);
  for (const target of executionTargets) {
    try {
      const branches = await tauriIpc.gitBranchList(target.repoPath);
      const branchName = normalizeBranchName(target.branchName);
      if ((branches.remote || []).some((branch) => branch.name === `origin/${branchName}`)) {
        return true;
      }
    } catch {
      // Ignore publication checks for missing or unavailable repositories.
    }
  }

  return false;
};

const resolveStandaloneStartRef = async (
  task: CatalogedImplementTask,
  repoPath: string,
  preferredBaseBranch?: string | null,
  preferredBranchName?: string | null
): Promise<string | null> => {
  if (!isManualStandaloneTask(task) || task.draft) {
    return null;
  }

  const branchName = preferredBranchName
    ? normalizeBranchName(preferredBranchName)
    : task.branch_name
      ? normalizeBranchName(task.branch_name)
      : '';
  if (tauriIpc.isTauriAvailable() && branchName) {
    try {
      const branches = await tauriIpc.gitBranchList(repoPath);
      if ((branches.remote || []).some((branch) => branch.name === `origin/${branchName}`)) {
        return `origin/${branchName}`;
      }
    } catch {
      // Fall back to the configured base branch if the repository is unavailable.
    }
  }

  return preferredBaseBranch || task.base_branch || getGitFlowBaseBranch();
};

const resolveTaskStartRef = async (
  task: CatalogedImplementTask,
  target: TaskExecutionTarget,
  repoPath: string
): Promise<string | null> => {
  if (task.task_source === 'architect') {
    return target.planBranchName || null;
  }
  return resolveStandaloneStartRef(task, repoPath, target.targetBranchName, target.branchName);
};

const inspectTargetWorktreePath = async (
  target: TaskExecutionTarget,
  branchWorktrees: Record<string, string>
): Promise<string | null> => {
  const repoPath = resolveTaskRepositoryPath(target.projectId, target.repoPath);
  if (repoPath && tauriIpc.isTauriAvailable()) {
    try {
      const inspection = await tauriIpc.gitWorktreeInspect({
        repoPath,
        taskId: target.worktreeKey,
        branchName: target.branchName,
      });
      if (inspection.status === 'ready' && inspection.worktreePath.trim().length > 0) {
        return inspection.worktreePath;
      }
      return null;
    } catch {
      return null;
    }
  }

  return branchWorktrees[target.worktreeKey] || null;
};

const ensureTargetWorktreePath = async (
  task: CatalogedImplementTask,
  target: TaskExecutionTarget,
  branchWorktrees: Record<string, string>
): Promise<string> => {
  const inspectedPath = await inspectTargetWorktreePath(target, branchWorktrees);
  if (inspectedPath) {
    return inspectedPath;
  }

  const repoPath = resolveTaskRepositoryPath(target.projectId, target.repoPath);
  const fromRef = repoPath ? await resolveTaskStartRef(task, target, repoPath) : null;
  const preferredCommitBranch = target.targetBranchName || task.base_branch || null;
  const ensured = await useGitStore
    .getState()
    .createWorktree(
      target.projectId,
      target.worktreeKey,
      target.branchName,
      fromRef,
      preferredCommitBranch
    );
  if (!ensured?.worktreePath) {
    const createError = useGitStore.getState().lastError?.trim();
    const expectedBaseRef = normalizeBranchName(target.targetBranchName || task.base_branch || getGitFlowBaseBranch());
    const parsedMissingRef = createError ? parseMissingStartRefError(createError) : null;
    if (
      parsedMissingRef &&
      repoPath &&
      isManualStandaloneTask(task) &&
      parsedMissingRef.missingRef.toLowerCase() === expectedBaseRef.toLowerCase()
    ) {
      throw new MissingTaskBaseBranchError({
        kind: 'missing_base_branch',
        taskId: task.id,
        projectId: target.projectId,
        repoPath,
        targetBranchName: parsedMissingRef.targetBranchName,
        missingRef: parsedMissingRef.missingRef,
        message: tTask(
          'implement.errors.missingBaseBranchForWorktree',
          'Base branch {{baseBranch}} does not exist in this repository. Create it or update the task base branch.',
          { baseBranch: parsedMissingRef.missingRef }
        ),
      });
    }
    throw toServiceError(
      createError || tTask(
        'implement.errors.worktreeCreateFailed',
        'Failed to create or reuse worktree for branch {{branchName}}',
        { branchName: target.branchName }
      )
    );
  }

  return ensured.worktreePath;
};

const updateTaskRuntimeAfterCleanup = (
  state: Pick<TaskStore, 'branchWorktrees' | 'activeBranchName' | 'activeRepositoryPath'>,
  task: CatalogedImplementTask,
  removedWorktreeKeys: string[]
) => {
  const removedKeySet = new Set(removedWorktreeKeys);
  const removedPaths = new Set(
    removedWorktreeKeys
      .map((key) => state.branchWorktrees[key])
      .filter((value): value is string => Boolean(value))
  );

  return {
    branchWorktrees: Object.fromEntries(
      Object.entries(state.branchWorktrees).filter(([key]) => !removedKeySet.has(key))
    ),
    activeBranchName:
      state.activeBranchName === task.assigned_branch ? null : state.activeBranchName,
    activeRepositoryPath:
      state.activeRepositoryPath && removedPaths.has(state.activeRepositoryPath)
        ? null
        : state.activeRepositoryPath,
  };
};

const buildStandalonePublicationMap = async (
  tasks: CatalogedImplementTask[]
): Promise<Record<string, boolean>> => {
  const standaloneTasks = tasks.filter((task) => isManualStandaloneTask(task));
  const entries = await Promise.all(
    standaloneTasks.map(async (task) => [task.id, await hasPublishedStandaloneBranch(task)] as const)
  );
  return Object.fromEntries(entries);
};

export const getTaskLifecycleCapabilities = (
  task: CatalogedImplementTask,
  published = false
): TaskLifecycleCapabilities => {
  if (isManualStandaloneTask(task)) {
    const archived = isTaskArchived(task);
    return {
      isPublished: published,
      canRename: true,
      canDelete: !published,
      canArchive: !task.draft && !archived,
      canRestore: archived,
      canReopen: !archived && task.status === 'Completed',
      deleteBlockReason: published
        ? tTask(
          'implement.actions.deleteBlockedPublished',
          'This feature branch has already been pushed. Archive it instead.'
        )
        : null,
    };
  }

  return {
    isPublished: false,
    canRename: true,
    canDelete: false,
    canArchive: false,
    canRestore: false,
    canReopen:
      task.task_source === 'architect' &&
      !isTaskArchived(task) &&
      task.status === 'Completed' &&
      (task.plan_status === 'validated' || task.plan_status === 'in_progress'),
    deleteBlockReason: null,
  };
};

const ALLOWED_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  Pending: ['InProgress', 'Failed'],
  InProgress: ['AwaitingResponse', 'InReview', 'Failed'],
  AwaitingResponse: ['InProgress', 'InReview', 'Failed'],
  InReview: ['InProgress', 'Completed', 'Failed'],
  Completed: ['Pending'],
  Failed: ['Pending', 'InProgress'],
  Blocked: ['Pending'],
};

const canTransitionTaskStatus = (from: TaskStatus, to: TaskStatus): boolean => {
  return ALLOWED_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
};

const taskMatchesAnyProjectId = (
  task: CatalogedImplementTask,
  projectIds: string[]
): boolean => projectIds.some((projectId) => taskMatchesProjectId(task, projectId));

const PLAN_ACTIVATION_TASK_STATUS_ORDER: Record<TaskStatus, number> = {
  InProgress: 0,
  AwaitingResponse: 1,
  InReview: 2,
  Pending: 3,
  Blocked: 4,
  Failed: 5,
  Completed: 6,
};

const tTask = (key: string, fallback: string, options?: Record<string, unknown>): string =>
  i18n.t(key, { defaultValue: fallback, ...(options || {}) });

const MISSING_START_REF_ERROR_PATTERN =
  /^Cannot create branch '([^']+)' from reference '([^']+)'$/i;

class MissingTaskBaseBranchError extends Error {
  issue: TaskMissingBaseBranchIssue;

  constructor(issue: TaskMissingBaseBranchIssue) {
    super(issue.message);
    this.name = 'MissingTaskBaseBranchError';
    this.issue = issue;
  }
}

const parseMissingStartRefError = (
  message: string
): { targetBranchName: string; missingRef: string } | null => {
  const match = message.trim().match(MISSING_START_REF_ERROR_PATTERN);
  if (!match) {
    return null;
  }

  return {
    targetBranchName: match[1] || '',
    missingRef: match[2] || '',
  };
};

export const getPlanActivationCandidateTask = (
  tasks: CatalogedImplementTask[],
  planId: string,
  scopedProjectIds: string[] = []
): CatalogedImplementTask | null => {
  const matchesScope = (task: CatalogedImplementTask): boolean =>
    scopedProjectIds.length === 0 || taskMatchesAnyProjectId(task, scopedProjectIds);
  const isPlanActivationEligible = (task: CatalogedImplementTask): boolean =>
    task.plan_id === planId &&
    !task.draft &&
    !task.is_blocked &&
    task.status !== 'Completed' &&
    task.status !== 'InReview';
  const compareTasks = (left: CatalogedImplementTask, right: CatalogedImplementTask): number => {
    const byStatus = PLAN_ACTIVATION_TASK_STATUS_ORDER[left.status] - PLAN_ACTIVATION_TASK_STATUS_ORDER[right.status];
    if (byStatus !== 0) return byStatus;
    return left.sequence_index - right.sequence_index;
  };

  const scopedCandidates = tasks
    .filter((task) => isPlanActivationEligible(task) && matchesScope(task))
    .sort(compareTasks);
  if (scopedCandidates.length > 0) {
    return scopedCandidates[0] || null;
  }

  return (
    tasks
      .filter(isPlanActivationEligible)
      .sort(compareTasks)[0] || null
  );
};

const ensureAppSync = () => {
  if (appSyncUnsubscribe) return;

  appSyncUnsubscribe = useAppStore.subscribe((nextState, previousState) => {
    const strategyChanged =
      nextState.activeArchitectPlanId !== previousState.activeArchitectPlanId ||
      nextState.planNodes !== previousState.planNodes ||
      nextState.predictedBranches !== previousState.predictedBranches;

    if (strategyChanged) {
      void useTaskStore.getState().refreshFromPlan();
      return;
    }

    if (nextState.selectedProjectId !== previousState.selectedProjectId) {
      const scopedProjectIds = getScopedProjectIds(
        nextState.projectGroups,
        nextState.selectedGroupId,
        nextState.selectedProjectId
      );
      const selectedTaskId = nextState.selectedTaskId;
      if (selectedTaskId) {
        const selectedTask = useTaskStore.getState().getTaskById(selectedTaskId);
        if (
          scopedProjectIds.length > 0 &&
          (!selectedTask || !taskMatchesAnyProjectId(selectedTask, scopedProjectIds))
        ) {
          useAppStore.getState().setSelectedTask(null);
          useTaskStore.setState({
            activeBranchName: null,
            activeRepositoryPath: nextState.selectedProjectId
              ? nextState.getProjectById(nextState.selectedProjectId)?.path ?? null
              : null,
          });
        } else if (!nextState.selectedProjectId) {
          useTaskStore.setState({
            activeBranchName: null,
            activeRepositoryPath: useTaskStore.getState().activeRepositoryPath,
          });
        }
      } else {
        useTaskStore.setState({
          activeBranchName: null,
          activeRepositoryPath: nextState.selectedProjectId
            ? nextState.getProjectById(nextState.selectedProjectId)?.path ?? null
            : null,
        });
      }
    }

    if (nextState.selectedTaskId !== previousState.selectedTaskId && nextState.selectedTaskId) {
      void useTaskStore.getState().activateTask(nextState.selectedTaskId);
    }
  });
};

const syncWorkspaceRoot = async (_path: string | null): Promise<void> => {
  // Runtime workspace is resolved per conversation/tool request.
};

const updateStandaloneTaskStatuses = (
  tasks: CatalogedImplementTask[],
  taskId: string,
  status: TaskStatus
): CatalogedImplementTask[] => {
  const standaloneTasks = tasks
    .filter((task) => task.task_source === 'standalone')
    .map((task) => (task.id === taskId ? { ...task, status } : task));
  const recomputedStandalone = deriveFallbackImplementTasks(standaloneTasks);
  const standaloneById = new Map(recomputedStandalone.map((task) => [task.id, task]));

  return tasks.map((task) => {
    if (task.task_source !== 'standalone') {
      return task;
    }
    return standaloneById.get(task.id) || task;
  });
};

const applyTaskStatusLocally = (
  tasks: CatalogedImplementTask[],
  task: CatalogedImplementTask,
  status: TaskStatus
): CatalogedImplementTask[] => {
  if (task.task_source === 'standalone') {
    return updateStandaloneTaskStatuses(tasks, task.id, status);
  }

  return tasks.map((candidate) =>
    candidate.id === task.id
      ? {
          ...candidate,
          status,
        }
      : candidate
  );
};

const applyPredictedBranchLifecycle = (
  tasks: CatalogedImplementTask[],
  predictedBranches: ReturnType<typeof useAppStore.getState>['predictedBranches'],
  taskId: string,
  nextStatus: TaskStatus
) => {
  const targetTask = tasks.find((task) => task.id === taskId);
  if (!targetTask) return predictedBranches;

  const taskStatuses = new Map(tasks.map((task) => [task.id, task.id === taskId ? nextStatus : task.status]));
  const targetKeys = new Set(getExecutionTargets(targetTask).map((target) => `${target.projectId}::${normalizeBranchName(target.branchName)}`));

  return predictedBranches.map((branch) => {
    const branchKey = `${branch.projectId}::${normalizeBranchName(branch.name)}`;
    if (!targetKeys.has(branchKey)) {
      return branch;
    }

    if (nextStatus === 'InProgress' || nextStatus === 'AwaitingResponse' || nextStatus === 'InReview') {
      return { ...branch, status: 'active' as const };
    }

    if (nextStatus !== 'Completed') {
      return branch;
    }

    const branchTasks = tasks.filter((task) =>
      getExecutionTargets(task).some(
        (target) => target.projectId === branch.projectId && normalizeBranchName(target.branchName) === normalizeBranchName(branch.name)
      )
    );
    const allCompleted = branchTasks.every((task) => taskStatuses.get(task.id) === 'Completed');
    return { ...branch, status: allCompleted ? 'merged' as const : 'active' as const };
  });
};

interface TaskCommandRunState {
  taskId: string;
  status: 'running' | 'cancelling';
  currentProjectId: string | null;
  currentProjectName: string | null;
  activeTabId: string | null;
  startedAt: string;
}

interface TaskCommandRunResult {
  status: 'completed' | 'cancelled';
  completedCount: number;
  totalCount: number;
  currentProjectName: string | null;
}

interface PreparedTaskExecutionTarget extends TaskExecutionTarget {
  projectName: string;
  repoPath: string;
  worktreePath: string;
}

interface OptimisticTaskStatusSnapshot {
  task: CatalogedImplementTask;
  previousPredictedBranches: ReturnType<typeof useAppStore.getState>['predictedBranches'] | null;
}

const ensureTaskExecutionTargetsReady = async (
  task: CatalogedImplementTask,
  branchWorktrees: Record<string, string>
): Promise<{
  createdWorktrees: Record<string, string>;
  preparedTargets: PreparedTaskExecutionTarget[];
}> => {
  const appState = useAppStore.getState();
  const executionTargets = getExecutionTargets(task);
  if (executionTargets.length === 0) {
    throw toServiceError(
      tTask('implement.errors.cannotResolveTaskProject', 'Cannot resolve project for task {{taskId}}', {
        taskId: task.id,
      })
    );
  }

  const createdWorktrees: Record<string, string> = {};
  const preparedTargets: PreparedTaskExecutionTarget[] = [];

  for (const target of executionTargets) {
    const worktreePath = await ensureTargetWorktreePath(task, target, branchWorktrees);

    createdWorktrees[target.worktreeKey] = worktreePath;

    const project = appState.getProjectById(target.projectId);
    const repoPath = project?.path ?? target.repoPath ?? null;
    if (!repoPath) {
      throw toServiceError(
        tTask('implement.errors.cannotResolveTaskProject', 'Cannot resolve project for task {{taskId}}', {
          taskId: task.id,
        })
      );
    }

    preparedTargets.push({
      ...target,
      projectName: project?.name ?? target.projectId,
      repoPath,
      worktreePath,
    });
  }

  return {
    createdWorktrees,
    preparedTargets,
  };
};

const shouldApplyOptimisticTaskStatus = (
  task: CatalogedImplementTask,
  nextStatus: TaskStatus
): boolean => {
  if (nextStatus !== 'AwaitingResponse') {
    return false;
  }

  if (task.task_source !== 'standalone') {
    return true;
  }

  return tauriIpc.isTauriAvailable();
};

interface TaskStore {
  tasks: CatalogedImplementTask[];
  planSummaries: ImplementTaskPlanSummary[];
  hasStandaloneTasks: boolean;
  publishedStandaloneTasks: Record<string, boolean>;
  isLoading: boolean;
  finalizingPlanId: string | null;
  blockedPlanFinalization: BlockedPlanFinalizationState | null;
  lastError: string | null;
  missingBaseBranchIssue: TaskMissingBaseBranchIssue | null;
  source: TaskSource;
  branchWorktrees: Record<string, string>;
  activeBranchName: string | null;
  activeRepositoryPath: string | null;
  taskCommandRuns: Record<string, TaskCommandRunState>;
  setTasks: (tasks: CatalogedImplementTask[]) => void;
  initialize: () => Promise<void>;
  refreshFromPlan: () => Promise<void>;
  activateTask: (taskId: string) => Promise<void>;
  createManualFeatureDraft: (params: {
    taskId: string;
    conversationId: string;
    groupId?: string | null;
    projectIds: string[];
    contextProjectIds?: string[];
    baseBranch?: string | null;
    title?: string | null;
    description?: string | null;
  }) => Promise<void>;
  finalizeManualFeatureDraft: (params: {
    taskId: string;
    conversationId?: string | null;
    title: string;
    description: string;
    featureSlug: string;
  }) => Promise<void>;
  deleteManualFeatureDraft: (taskId: string) => Promise<void>;
  createMissingBaseBranch: (issue: TaskMissingBaseBranchIssue) => Promise<void>;
  clearMissingBaseBranchIssue: () => void;
  renameTask: (taskId: string, title: string) => Promise<void>;
  archiveTask: (taskId: string, options?: { reason?: string | null; mergedAt?: string | null }) => Promise<void>;
  restoreTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  reopenTask: (taskId: string) => Promise<void>;
  startTask: (taskId: string) => Promise<void>;
  startReview: (taskId: string) => Promise<void>;
  requestTaskChanges: (taskId: string) => Promise<void>;
  runTaskCommands: (taskId: string) => Promise<TaskCommandRunResult | null>;
  cancelTaskCommands: (taskId: string) => Promise<void>;
  finishTask: (taskId: string, options?: CompleteTaskOptions) => Promise<void>;
  completeTask: (taskId: string, options?: CompleteTaskOptions) => Promise<void>;
  finalizePlan: (planId: string) => Promise<void>;
  markTaskAwaitingResponse: (taskId: string) => Promise<void>;
  markTaskFailed: (taskId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  setTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  clearPlanFinalizationBlock: () => void;
  clearPlanRuntimeState: (params: ClearPlanRuntimeStateParams) => void;
  getTaskById: (taskId: string) => CatalogedImplementTask | undefined;
}

const persistTaskStatusToArchitectPlan = async (
  task: CatalogedImplementTask,
  status: TaskStatus,
  setError: (message: string | null) => void
): Promise<boolean> => {
  try {
    if (task.task_source !== 'architect' || !task.plan_id) {
      return false;
    }

    const targetBranch = resolveTargetBranch(task.plan_target_branch || getGitFlowBaseBranch());
    const plan = await getArchitectPlan(targetBranch, task.plan_id);
    if (!plan || plan.status === 'deleted') {
      setError(
        tTask('implement.errors.unknownTaskPlan', 'Cannot update plan metadata for task {{taskId}}.', {
          taskId: task.id,
        })
      );
      return false;
    }

    const nextNodeStatus = mapTaskStatusToNodeStatus(status);
    const nextPlanNodes = (plan.nodes || []).map((node) =>
      node.id === task.id ? { ...node, status: nextNodeStatus } : node
    );
    const currentPlanTasks = deriveImplementTasksFromStrategy({
      planId: plan.id,
      planSlug: plan.slug,
      nodes: plan.nodes || [],
      predictedBranches: plan.predictedBranches || [],
      targetBranchesByProjectId: getArchitectPlanTargetBranchesByProjectId(plan),
    }).tasks;
    const nextPredictedBranches = applyPredictedBranchLifecycle(
      currentPlanTasks.map((currentTask) => ({
        ...currentTask,
        task_source: 'architect',
        plan_title: plan.title,
        plan_status: plan.status,
        plan_target_branch: plan.targetBranch,
        draft: false,
        standalone_kind: 'legacy',
        base_branch: null,
        feature_slug: null,
        conversation_id: null,
        archived_at: null,
        archive_reason: null,
        merged_at: null,
      })),
      plan.predictedBranches || [],
      task.id,
      status
    );
    const strategy = deriveImplementTasksFromStrategy({
      planId: plan.id,
      planSlug: plan.slug,
      nodes: nextPlanNodes,
      predictedBranches: nextPredictedBranches,
      targetBranchesByProjectId: getArchitectPlanTargetBranchesByProjectId(plan),
    });
    const nextPlanStatus = plan.status === 'validated' && status !== 'Pending'
      ? 'in_progress'
      : plan.status;

    await updateArchitectPlan({
      branchName: targetBranch,
      planId: plan.id,
      nodes: strategy.nodes,
      predictedBranches: strategy.predictedBranches,
      status: nextPlanStatus,
      setActive: false,
    });
    const appState = useAppStore.getState();
    if (appState.activeArchitectPlanId === plan.id) {
      appState.setPlanNodes(strategy.nodes);
      appState.setPredictedBranches(strategy.predictedBranches);
      if (appState.activePlanContext?.id === plan.id) {
        appState.setActivePlanContext({
          ...appState.activePlanContext,
          status: nextPlanStatus,
        });
      }
    }
    try {
      await useTaskStore.getState().refreshFromPlan();
    } catch (error) {
      const normalized = toServiceError(error);
      setError(normalized.message);
    }
    return true;
  } catch (error) {
    const normalized = toServiceError(error);
    setError(normalized.message);
    return false;
  }
};

const syncManualFeatureTaskMetadata = async (
  task: CatalogedImplementTask | undefined,
  setError?: (message: string | null) => void
): Promise<void> => {
  if (!task || !isManualStandaloneTask(task)) {
    return;
  }
  try {
    await syncManualFeatureMetadataFromTask(task);
  } catch (error) {
    const normalized = toServiceError(error);
    setError?.(normalized.message);
  }
};

const commitManualFeatureTaskMetadata = async (
  task: CatalogedImplementTask | undefined,
  message: string,
  setError?: (message: string | null) => void
): Promise<void> => {
  if (!task || !isManualStandaloneTask(task)) {
    return;
  }

  try {
    await commitManualFeatureMetadata(task, message);
  } catch (error) {
    const normalized = toServiceError(error);
    setError?.(normalized.message);
  }
};

const commitArchitectPlanMetadataForTask = async (
  task: CatalogedImplementTask,
  message: string,
  setError?: (message: string | null) => void
): Promise<void> => {
  if (task.task_source !== 'architect' || !task.plan_id || !task.plan_target_branch) {
    return;
  }

  try {
    await commitArchitectPlanMetadata({
      branchName: resolveTargetBranch(task.plan_target_branch),
      planId: task.plan_id,
      commitMessage: message,
    });
  } catch (error) {
    const normalized = toServiceError(error);
    setError?.(normalized.message);
  }
};

const syncIntegrationBranchIfConfigured = async (
  repoPath: string,
  branchName: string
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || !shouldSyncTargetBranchBeforeFinish()) {
    return;
  }

  await tauriIpc.gitPull({
    repoPath,
    branch: branchName,
  });
};

const resolveMissingBaseBranchSourceRef = async (
  repoPath: string,
  missingRef: string
): Promise<string> => {
  const branches = await tauriIpc.gitBranchList(repoPath);
  const currentBranch = branches.current?.trim();
  if (currentBranch && currentBranch.length > 0 && currentBranch !== missingRef) {
    return currentBranch;
  }

  return 'HEAD';
};

const cleanupTaskExecutionTargets = async (
  executionTargets: Array<TaskExecutionTarget & { repoPath: string }>
): Promise<string[]> => {
  const removedWorktreeKeys: string[] = [];

  for (const target of executionTargets) {
    const branches = await tauriIpc.gitBranchList(target.repoPath);
    const localBranchNames = new Set((branches.local || []).map((branch) => branch.name));
    const remoteBranchNames = new Set((branches.remote || []).map((branch) => branch.name));

    await tauriIpc.gitWorktreeRemove({
      repoPath: target.repoPath,
      taskId: target.worktreeKey,
      force: false,
      branchName: target.branchName,
    });
    removedWorktreeKeys.push(target.worktreeKey);

    if (localBranchNames.has(target.branchName)) {
      await tauriIpc.gitBranchDelete({
        repoPath: target.repoPath,
        branchName: target.branchName,
        force: false,
      });
    }

    if (remoteBranchNames.has(`origin/${target.branchName}`)) {
      await tauriIpc.gitBranchDeleteRemote({
        repoPath: target.repoPath,
        branchName: target.branchName,
      });
    }
  }

  return removedWorktreeKeys;
};

export const useTaskStore = create<TaskStore>((set, get) => {
  const throwRemoteTaskActionUnavailable = (feature: string): never => {
    const serviceError = createRemoteUnsupportedInRemoteModeError(feature);
    const error = Object.assign(new Error(serviceError.message), serviceError);
    set({ lastError: error.message });
    throw error;
  };

  const assertTaskMutationRuntime = (feature: string): void => {
    if (!canUseTaskMutationRuntime()) {
      throwRemoteTaskActionUnavailable(feature);
    }
  };

  const assertImplementExecutionRuntime = (feature: string): void => {
    if (!canUseImplementExecutionRuntime()) {
      throwRemoteTaskActionUnavailable(feature);
    }
  };

  return ({
  tasks: [],
  planSummaries: [],
  hasStandaloneTasks: false,
  publishedStandaloneTasks: {},
  isLoading: false,
  finalizingPlanId: null,
  blockedPlanFinalization: null,
  lastError: null,
  missingBaseBranchIssue: null,
  source: 'empty',
  branchWorktrees: {},
  activeBranchName: null,
  activeRepositoryPath: null,
  taskCommandRuns: {},

  setTasks: (tasks) => set({ tasks }),

  initialize: async () => {
    ensureAppSync();
    set({ isLoading: true, lastError: null });
    await get().refreshFromPlan();
    set({ isLoading: false });
  },

  refreshFromPlan: async () => {
    try {
      const catalog = await services.listTasks();
      const publishedStandaloneTasks = await buildStandalonePublicationMap(catalog.tasks);
      set({
        tasks: catalog.tasks,
        planSummaries: catalog.plans,
        hasStandaloneTasks: catalog.hasStandaloneTasks,
        publishedStandaloneTasks,
        missingBaseBranchIssue: null,
        source: catalog.source,
        ...buildPlanFinalizationRefreshState(),
        isLoading: false,
      });

      const { selectedGroupId, selectedProjectId, projectGroups } = useAppStore.getState();
      const scopedProjectIds = getScopedProjectIds(projectGroups, selectedGroupId, selectedProjectId);
      const selectedTaskIdFromApp = useAppStore.getState().selectedTaskId;
      if (selectedTaskIdFromApp && !catalog.tasks.some((task) => task.id === selectedTaskIdFromApp)) {
        useAppStore.getState().setSelectedTask(null);
      }

      const selectedTaskId = useAppStore.getState().selectedTaskId;
      if (!selectedTaskId && scopedProjectIds.length > 0) {
        try {
          const contextKey = selectedGroupId || selectedProjectId;
          const context = contextKey ? await getLocalProjectContextState(contextKey) : null;
          const candidateTaskId = context?.lastTaskId;
          if (candidateTaskId) {
            const candidateTask = catalog.tasks.find((task) => task.id === candidateTaskId);
            if (candidateTask && taskMatchesAnyProjectId(candidateTask, scopedProjectIds)) {
              useAppStore.getState().setSelectedTask(candidateTaskId);
            }
          }
        } catch {
          // Ignore context restore failures here and keep fallback behavior.
        }
      }

      const selectedTaskAfterRestore = useAppStore.getState().selectedTaskId;
      if (selectedTaskAfterRestore) {
        void get().activateTask(selectedTaskAfterRestore);
      }
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message, publishedStandaloneTasks: {} });
    }
  },

  activateTask: async (taskId) => {
    const appState = useAppStore.getState();
    const task = get().tasks.find((candidate) => candidate.id === taskId);

    if (appState.selectedTaskId !== taskId) {
      appState.setSelectedTask(taskId);
    }

    if (!task) {
      return;
    }

    if (isManualDraftPendingInitialization(task)) {
      const draftProjectIds = [
        appState.selectedProjectId,
        ...(task.project_ids ?? []),
        task.project_id,
      ].filter((value, index, values): value is string =>
        typeof value === 'string' && value.trim().length > 0 && values.indexOf(value) === index
      );
      const projectPath =
        draftProjectIds
          .map((projectId) => appState.getProjectById(projectId)?.path ?? null)
          .find((path): path is string => typeof path === 'string' && path.trim().length > 0) ?? null;

      set({
        activeBranchName: null,
        activeRepositoryPath: projectPath,
      });
      await syncWorkspaceRoot(projectPath);
      return;
    }

    const preferredTarget = getPreferredExecutionTarget(task, appState.selectedProjectId);
    const primaryTarget = preferredTarget || getPrimaryExecutionTarget(task);
    const branchName = primaryTarget?.branchName || task.assigned_branch;
    const knownWorktree = primaryTarget
      ? await inspectTargetWorktreePath(primaryTarget, get().branchWorktrees)
      : null;
    if (knownWorktree) {
      if (primaryTarget) {
        set((state) => ({
          branchWorktrees: {
            ...state.branchWorktrees,
            [primaryTarget.worktreeKey]: knownWorktree,
          },
          activeBranchName: branchName,
          activeRepositoryPath: knownWorktree,
        }));
      } else {
        set({
          activeBranchName: branchName,
          activeRepositoryPath: knownWorktree,
        });
      }
      await syncWorkspaceRoot(knownWorktree);
      return;
    }

    const projectPath = primaryTarget?.projectId
      ? appState.getProjectById(primaryTarget.projectId)?.path ?? null
      : task.project_id
        ? appState.getProjectById(task.project_id)?.path ?? null
      : null;

    set({
      activeBranchName: branchName,
      activeRepositoryPath: projectPath,
    });
    await syncWorkspaceRoot(projectPath);
  },

  createManualFeatureDraft: async (params) => {
    set({ lastError: null });
    assertTaskMutationRuntime('createManualFeatureDraft');

    try {
      if (!tauriIpc.isTauriAvailable()) {
        throw new Error('Manual features require the desktop runtime.');
      }

      await tauriIpc.workspaceCreateManualFeatureDraft({
        taskId: params.taskId,
        conversationId: params.conversationId,
        groupId: params.groupId ?? null,
        projectIds: params.projectIds,
        contextProjectIds: params.contextProjectIds ?? [],
        baseBranch: params.baseBranch ?? null,
        title: params.title ?? null,
        description: params.description ?? null,
      });

      await get().refreshFromPlan();
      await syncManualFeatureTaskMetadata(get().getTaskById(params.taskId), (message) => {
        set({ lastError: message });
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  finalizeManualFeatureDraft: async (params) => {
    set({ lastError: null });
    assertTaskMutationRuntime('finalizeManualFeatureDraft');

    try {
      if (!tauriIpc.isTauriAvailable()) {
        throw new Error('Manual features require the desktop runtime.');
      }

      await tauriIpc.workspaceFinalizeManualFeature({
        taskId: params.taskId,
        conversationId: params.conversationId ?? null,
        title: params.title,
        description: params.description,
        featureSlug: params.featureSlug,
      });

      await get().refreshFromPlan();
      await useTerminalStore.getState().syncTerminalDisplayMetadata({ taskId: params.taskId });
      await syncManualFeatureTaskMetadata(get().getTaskById(params.taskId), (message) => {
        set({ lastError: message });
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  deleteManualFeatureDraft: async (taskId) => {
    set({ lastError: null });
    assertTaskMutationRuntime('deleteManualFeatureDraft');

    const existingTask = get().getTaskById(taskId);

    try {
      if (!tauriIpc.isTauriAvailable()) {
        throw new Error('Manual features require the desktop runtime.');
      }

      await tauriIpc.workspaceDeleteManualFeatureDraft(taskId);
      if (existingTask && isManualStandaloneTask(existingTask)) {
        try {
          await removeManualFeatureMetadata(existingTask);
        } catch (error) {
          const normalized = toServiceError(error);
          set({ lastError: normalized.message });
        }
      }
      await get().refreshFromPlan();
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  createMissingBaseBranch: async (issue) => {
    set({ lastError: null });
    assertImplementExecutionRuntime('createMissingBaseBranch');

    try {
      const fromRef = await resolveMissingBaseBranchSourceRef(issue.repoPath, issue.missingRef);
      await tauriIpc.gitBranchCreate({
        repoPath: issue.repoPath,
        branchName: issue.missingRef,
        fromRef,
      });
      set({ missingBaseBranchIssue: null, lastError: null });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  clearMissingBaseBranchIssue: () => {
    set({ missingBaseBranchIssue: null });
  },

  renameTask: async (taskId, title) => {
    set({ lastError: null });
    assertTaskMutationRuntime('renameTask');

    const task = get().getTaskById(taskId);
    const nextTitle = title.trim();
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }
    if (!nextTitle) {
      set({ lastError: tTask('implement.errors.renameTaskEmpty', 'Task title cannot be empty.') });
      return;
    }

    try {
      if (isManualStandaloneTask(task)) {
        if (!tauriIpc.isTauriAvailable()) {
          set({
            tasks: get().tasks.map((candidate) =>
              candidate.id === taskId ? { ...candidate, title: nextTitle } : candidate
            ),
          });
          return;
        }

        await tauriIpc.workspaceRenameManualFeature({ taskId, title: nextTitle });
        await get().refreshFromPlan();
        await useTerminalStore.getState().syncTerminalDisplayMetadata({ taskId });
        await syncManualFeatureTaskMetadata(get().getTaskById(taskId), (message) => {
          set({ lastError: message });
        });
        return;
      }

      const targetBranch = resolveTargetBranch(task.plan_target_branch || getGitFlowBaseBranch());
      const plan = await getArchitectPlan(targetBranch, task.plan_id);
      if (!plan || plan.status === 'deleted') {
        set({
          lastError: tTask('implement.errors.unknownTaskPlan', 'Cannot update plan metadata for task {{taskId}}.', {
            taskId,
          }),
        });
        return;
      }

      const nextPlanNodes = (plan.nodes || []).map((node) =>
        node.id === taskId ? { ...node, title: nextTitle } : node
      );
      await updateArchitectPlan({
        branchName: targetBranch,
        planId: plan.id,
        nodes: nextPlanNodes,
        setActive: false,
      });

      const appState = useAppStore.getState();
      if (appState.activeArchitectPlanId === plan.id) {
        appState.setPlanNodes(nextPlanNodes);
      }

      await get().refreshFromPlan();
      await useTerminalStore.getState().syncTerminalDisplayMetadata({ taskId });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  archiveTask: async (taskId, options) => {
    set({ lastError: null });
    assertTaskMutationRuntime('archiveTask');

    const task = get().getTaskById(taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }
    if (!isManualStandaloneTask(task) || task.draft) {
      set({
        lastError: tTask(
          'implement.errors.archiveUnsupportedTask',
          'Only standalone features can be archived from Implement.'
        ),
      });
      return;
    }

    try {
      const executionTargets = getExecutionTargetsWithRepoPaths(task);
      for (const target of executionTargets) {
        await tauriIpc.gitWorktreeRemove({
          repoPath: target.repoPath,
          taskId: target.worktreeKey,
          force: true,
          branchName: target.branchName,
        });

        const branches = await tauriIpc.gitBranchList(target.repoPath);
        if ((branches.local || []).some((branch) => branch.name === target.branchName)) {
          await tauriIpc.gitBranchDelete({
            repoPath: target.repoPath,
            branchName: target.branchName,
            force: true,
          });
        }
      }

      const removedKeys = new Set(getExecutionTargets(task).map((target) => target.worktreeKey));
      const removedPaths = new Set(
        Array.from(removedKeys)
          .map((key) => get().branchWorktrees[key])
          .filter((value): value is string => Boolean(value))
      );
      set((state) => ({
        branchWorktrees: Object.fromEntries(
          Object.entries(state.branchWorktrees).filter(([key]) => !removedKeys.has(key))
        ),
        activeBranchName:
          state.activeBranchName === task.assigned_branch ? null : state.activeBranchName,
        activeRepositoryPath:
          state.activeRepositoryPath && removedPaths.has(state.activeRepositoryPath)
            ? null
            : state.activeRepositoryPath,
      }));

      if (
        get().activeBranchName === null &&
        get().activeRepositoryPath === null
      ) {
        await syncWorkspaceRoot(null);
      }

      if (useAppStore.getState().selectedTaskId === task.id) {
        useAppStore.getState().setSelectedTask(null);
      }

      await tauriIpc.workspaceArchiveManualFeature({
        taskId,
        reason: options?.reason ?? null,
        mergedAt: options?.mergedAt ?? null,
      });
      await get().refreshFromPlan();
      await syncManualFeatureTaskMetadata(get().getTaskById(taskId), (message) => {
        set({ lastError: message });
      });
      await commitManualFeatureTaskMetadata(
        get().getTaskById(taskId) ?? task,
        `chore(metadata): archive manual feature ${taskId}`,
        (message) => {
          set({ lastError: message });
        }
      );
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  restoreTask: async (taskId) => {
    set({ lastError: null });
    assertTaskMutationRuntime('restoreTask');

    const task = get().getTaskById(taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }
    if (!isManualStandaloneTask(task) || !isTaskArchived(task)) {
      set({
        lastError: tTask(
          'implement.errors.restoreUnsupportedTask',
          'Only archived standalone features can be restored.'
        ),
      });
      return;
    }

    try {
      await tauriIpc.workspaceRestoreManualFeature(taskId);
      await get().refreshFromPlan();
      await syncManualFeatureTaskMetadata(get().getTaskById(taskId), (message) => {
        set({ lastError: message });
      });
      useAppStore.getState().setSelectedTask(taskId);
      await get().activateTask(taskId);
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  deleteTask: async (taskId) => {
    set({ lastError: null });
    assertTaskMutationRuntime('deleteTask');

    const task = get().getTaskById(taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }
    if (!isManualStandaloneTask(task)) {
      set({
        lastError: tTask(
          'implement.errors.deleteUnsupportedTask',
          'Only standalone features can be deleted from Implement.'
        ),
      });
      return;
    }

    try {
      if (!task.draft) {
        const published = await hasPublishedStandaloneBranch(task);
        set((state) => ({
          publishedStandaloneTasks: {
            ...state.publishedStandaloneTasks,
            [task.id]: published,
          },
        }));
        if (published) {
          set({
            lastError: tTask(
              'implement.actions.deleteBlockedPublished',
              'This feature branch has already been pushed. Archive it instead.'
            ),
          });
          return;
        }
      }

      const executionTargets = getExecutionTargetsWithRepoPaths(task);
      for (const target of executionTargets) {
        await tauriIpc.gitWorktreeRemove({
          repoPath: target.repoPath,
          taskId: target.worktreeKey,
          force: true,
          branchName: target.branchName,
        });

        const branches = await tauriIpc.gitBranchList(target.repoPath);
        if ((branches.local || []).some((branch) => branch.name === target.branchName)) {
          await tauriIpc.gitBranchDelete({
            repoPath: target.repoPath,
            branchName: target.branchName,
            force: true,
          });
        }
      }

      const removedKeys = new Set(getExecutionTargets(task).map((target) => target.worktreeKey));
      const removedPaths = new Set(
        Array.from(removedKeys)
          .map((key) => get().branchWorktrees[key])
          .filter((value): value is string => Boolean(value))
      );
      set((state) => ({
        branchWorktrees: Object.fromEntries(
          Object.entries(state.branchWorktrees).filter(([key]) => !removedKeys.has(key))
        ),
        activeBranchName:
          state.activeBranchName === task.assigned_branch ? null : state.activeBranchName,
        activeRepositoryPath:
          state.activeRepositoryPath && removedPaths.has(state.activeRepositoryPath)
            ? null
            : state.activeRepositoryPath,
      }));
      if (get().activeBranchName === null && get().activeRepositoryPath === null) {
        await syncWorkspaceRoot(null);
      }

      if (task.draft) {
        await tauriIpc.workspaceDeleteManualFeatureDraft(taskId);
      } else {
        await tauriIpc.workspaceDeleteManualFeature(taskId);
      }

      try {
        await removeManualFeatureMetadata(task);
      } catch (error) {
        const normalized = toServiceError(error);
        set({ lastError: normalized.message });
      }

      await get().refreshFromPlan();
      if (useAppStore.getState().selectedTaskId === task.id) {
        useAppStore.getState().setSelectedTask(null);
      }

      if (task.conversation_id) {
        await useChatStore.getState().deleteConversation(task.conversation_id, { mode: 'implement' });
      }
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  reopenTask: async (taskId) => {
    assertTaskMutationRuntime('reopenTask');

    const task = get().getTaskById(taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }

    const capabilities = getTaskLifecycleCapabilities(
      task,
      get().publishedStandaloneTasks[task.id] ?? false
    );
    if (!capabilities.canReopen) {
      set({
        lastError: tTask(
          'implement.errors.reopenUnsupportedTask',
          'This task cannot be reopened.'
        ),
      });
      return;
    }

    await get().setTaskStatus(taskId, 'Pending');
  },

  startTask: async (taskId) => {
    if (!canUseImplementExecutionRuntime()) {
      set({ lastError: REMOTE_TASK_ACTION_UNAVAILABLE_MESSAGE });
      return;
    }

    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }

    if (task.status === 'Completed') {
      set({ lastError: tTask('implement.errors.taskAlreadyCompleted', 'Task is already completed.') });
      return;
    }

    if (task.status === 'InProgress') {
      return;
    }

    if (task.status === 'AwaitingResponse') {
      await get().setTaskStatus(task.id, 'InProgress');
      return;
    }

    if (task.is_blocked) {
      const reason = task.blocked_by.length > 0 ? task.blocked_by.join(', ') : 'dependency chain';
      set({
        lastError: tTask(
          'implement.errors.taskBlockedByDependencies',
          'Task is blocked by unresolved dependencies: {{reason}}',
          { reason }
        ),
      });
      return;
    }

    const appState = useAppStore.getState();
    if (appState.selectedTaskId !== task.id) {
      appState.setSelectedTask(task.id);
    }

    try {
      const { createdWorktrees, preparedTargets } = await ensureTaskExecutionTargetsReady(
        task,
        get().branchWorktrees
      );
      const primaryTarget =
        preparedTargets.find((target) => target.projectId === appState.selectedProjectId) ||
        preparedTargets[0];
      const primaryWorktree = primaryTarget?.worktreePath || null;

      set((state) => ({
        branchWorktrees: {
          ...state.branchWorktrees,
          ...createdWorktrees,
        },
        activeBranchName: task.assigned_branch,
        activeRepositoryPath: primaryWorktree,
        missingBaseBranchIssue: null,
        lastError: null,
      }));

      await syncWorkspaceRoot(primaryWorktree);
      await get().setTaskStatus(task.id, 'InProgress');
    } catch (error) {
      if (error instanceof MissingTaskBaseBranchError) {
        set({
          missingBaseBranchIssue: error.issue,
          lastError: error.issue.message,
        });
        return;
      }
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
    }
  },

  startReview: async (taskId) => {
    await get().setTaskStatus(taskId, 'InReview');
  },

  requestTaskChanges: async (taskId) => {
    await get().setTaskStatus(taskId, 'InProgress');
  },

  runTaskCommands: async (taskId) => {
    if (!canUseTaskCommandRuntime()) {
      set({ lastError: REMOTE_TASK_ACTION_UNAVAILABLE_MESSAGE });
      return null;
    }

    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return null;
    }

    if (isManualDraftPendingInitialization(task)) {
      set({
        lastError: tTask(
          'implement.taskCommandsDraftUnsupported',
          'No worktree is available until this feature is initialized from the first message.'
        ),
      });
      return null;
    }

    if (task.draft) {
      set({
        lastError: tTask(
          'implement.taskCommandsDraftUnsupported',
          'Commands are unavailable while this task is still a draft.'
        ),
      });
      return null;
    }

    if (task.archived_at) {
      set({
        lastError: tTask(
          'implement.taskCommandsArchivedUnsupported',
          'Commands are unavailable for archived tasks.'
        ),
      });
      return null;
    }

    if (get().taskCommandRuns[taskId]) {
      return null;
    }

    set({ lastError: null });

    try {
      const registry = await loadTaskProjectCommandRegistry();
      const { createdWorktrees, preparedTargets } = await ensureTaskExecutionTargetsReady(
        task,
        get().branchWorktrees
      );

      set((state) => ({
        branchWorktrees: {
          ...state.branchWorktrees,
          ...createdWorktrees,
        },
        missingBaseBranchIssue: null,
      }));

      const missingProject = preparedTargets.find(
        (target) => !getTaskProjectCommand(registry, target.repoPath)?.command
      );
      if (missingProject) {
        set({
          lastError: tTask(
            'implement.taskCommandMissingForProject',
            'Missing run command for {{project}}.',
            { project: missingProject.projectName }
          ),
        });
        return null;
      }

      const terminalStore = useTerminalStore.getState();
      const totalCount = preparedTargets.length;
      let completedCount = 0;

      set((state) => ({
        taskCommandRuns: {
          ...state.taskCommandRuns,
          [taskId]: {
            taskId,
            status: 'running',
            currentProjectId: null,
            currentProjectName: null,
            activeTabId: null,
            startedAt: new Date().toISOString(),
          },
        },
      }));

      for (const target of preparedTargets) {
        const currentRun = get().taskCommandRuns[taskId];
        if (!currentRun || currentRun.status === 'cancelling') {
          return {
            status: 'cancelled',
            completedCount,
            totalCount,
            currentProjectName: target.projectName,
          };
        }

        const commandEntry = getTaskProjectCommand(registry, target.repoPath);
        if (!commandEntry?.command) {
          set({
            lastError: tTask(
              'implement.taskCommandMissingForProject',
              'Missing run command for {{project}}.',
              { project: target.projectName }
            ),
          });
          return null;
        }

        const tab = await terminalStore.ensureTaskTab({
          taskId,
          projectId: target.projectId,
          cwd: target.worktreePath,
          title: buildTerminalDisplayMetadata({
            projectLabel:
              useAppStore.getState().getProjectById(target.projectId)?.mountName ||
              target.projectName,
            taskLabel: task.title,
          }).title,
          reveal: commandEntry.openTerminalOnRun,
          promptContext: buildTerminalDisplayMetadata({
            projectLabel:
              useAppStore.getState().getProjectById(target.projectId)?.mountName ||
              target.projectName,
            taskLabel: task.title,
          }).promptContext,
        });

        set((state) => ({
          taskCommandRuns: {
            ...state.taskCommandRuns,
            [taskId]: {
              ...(state.taskCommandRuns[taskId] || {
                taskId,
                status: 'running',
                currentProjectId: null,
                currentProjectName: null,
                activeTabId: null,
                startedAt: new Date().toISOString(),
              }),
              currentProjectId: target.projectId,
              currentProjectName: target.projectName,
              activeTabId: tab.id,
            },
          },
        }));

        const result = await terminalStore.executeCommand({
          tabId: tab.id,
          command: commandEntry.command,
          reveal: commandEntry.openTerminalOnRun,
        });

        const nextRun = get().taskCommandRuns[taskId];
        if (nextRun?.status === 'cancelling') {
          return {
            status: 'cancelled',
            completedCount,
            totalCount,
            currentProjectName: target.projectName,
          };
        }

        if (result.lastExitCode !== 0) {
          const summary = (result.snapshot || '')
            .trim()
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(-1)[0];
          set({
            lastError: summary
              ? tTask(
                  'implement.taskCommandRunFailedWithOutput',
                  'Command failed for {{project}}: {{summary}}',
                  { project: target.projectName, summary }
                )
              : tTask(
                  'implement.taskCommandRunFailed',
                  'Command failed for {{project}}.',
                  { project: target.projectName }
                ),
          });
          return null;
        }

        completedCount += 1;
      }

      return {
        status: 'completed',
        completedCount,
        totalCount,
        currentProjectName: null,
      };
    } catch (error) {
      if (error instanceof MissingTaskBaseBranchError) {
        set({
          missingBaseBranchIssue: error.issue,
          lastError: error.issue.message,
        });
        return null;
      }
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      return null;
    } finally {
      set((state) => {
        if (!state.taskCommandRuns[taskId]) {
          return state;
        }

        const nextRuns = { ...state.taskCommandRuns };
        delete nextRuns[taskId];
        return { taskCommandRuns: nextRuns };
      });
    }
  },

  cancelTaskCommands: async (taskId) => {
    const runState = get().taskCommandRuns[taskId];
    if (!runState) {
      return;
    }

    set((state) => ({
      taskCommandRuns: {
        ...state.taskCommandRuns,
        [taskId]: {
          ...state.taskCommandRuns[taskId],
          status: 'cancelling',
        },
      },
    }));

    if (!runState.activeTabId) {
      return;
    }

    try {
      await useTerminalStore.getState().interruptTab(runState.activeTabId);
    } catch {
      // Ignore interrupt failures here; the pending command will still settle or the tab stays interactive.
    }
  },

  finishTask: async (taskId, options) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }

    const allowWithoutCodeChanges = options?.allowWithoutCodeChanges === true;

    if (task.status !== 'InReview' && task.status !== 'InProgress') {
      set({
        lastError: tTask(
          'implement.errors.completeRequiresActiveStatus',
          'Task can only be completed from Validation.'
        ),
      });
      return;
    }

    const executionTargets = getExecutionTargets(task);
    if (executionTargets.length === 0) {
      set({ lastError: tTask('implement.errors.cannotResolveTaskProject', 'Cannot resolve project for task {{taskId}}', { taskId }) });
      return;
    }

    const repositories: TaskCompletionRepositoryRecord[] = [...(options?.repositories || [])];
    let executionTargetsWithRepoPaths: Array<TaskExecutionTarget & { repoPath: string; worktreePath: string }> = [];
    try {
      const { createdWorktrees, preparedTargets } = await ensureTaskExecutionTargetsReady(
        task,
        get().branchWorktrees
      );
      set((state) => ({
        branchWorktrees: {
          ...state.branchWorktrees,
          ...createdWorktrees,
        },
        missingBaseBranchIssue: null,
      }));
      executionTargetsWithRepoPaths = preparedTargets;
    } catch (error) {
      if (error instanceof MissingTaskBaseBranchError) {
        set({
          missingBaseBranchIssue: error.issue,
          lastError: error.issue.message,
        });
        return;
      }
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      return;
    }

    let mergedRepositoryCount = 0;

    try {
      for (const target of executionTargetsWithRepoPaths) {
        const integrationBranchName = getTaskIntegrationBranch(task, target);
        if (!integrationBranchName) {
          set({
            lastError: tTask(
              'implement.errors.missingIntegrationBranch',
              'Cannot determine the integration branch for task {{taskId}}.',
              { taskId: task.id }
            ),
          });
          return;
        }

        const status = await tauriIpc.gitStatus(target.worktreePath);
        if (!status.is_clean) {
          set({
            lastError: tTask(
              'implement.errors.repositoryNotCleanForComplete',
              'Cannot complete task while repository has uncommitted changes. Commit or stash changes first.'
            ),
          });
          return;
        }

        if (!allowWithoutCodeChanges) {
          await syncIntegrationBranchIfConfigured(target.repoPath, integrationBranchName);
        }

        const diff = await tauriIpc.gitDiff({
          repoPath: target.repoPath,
          base: integrationBranchName,
          head: target.branchName,
          contextLines: 0,
        });

        if (allowWithoutCodeChanges && diff.trim()) {
          set({
            lastError: tTask(
              'implement.errors.completeWithoutCodeChangesHasDiff',
              'Cannot complete without code changes because {{branchName}} still contains branch changes.',
              { branchName: integrationBranchName }
            ),
          });
          return;
        }

        if (!allowWithoutCodeChanges && !diff.trim()) {
          repositories.push({
            projectId: target.projectId,
            repoPath: target.repoPath,
            branchName: target.branchName,
            planBranchName: integrationBranchName,
          });
          continue;
        }

        const mergeOutput = allowWithoutCodeChanges
          ? undefined
          : await mergeFeatureBranchIntoPlanBranch({
            projectId: target.projectId,
            branchName: target.branchName,
            planBranchName: integrationBranchName,
            repoPath: target.repoPath,
          });
        if (mergeOutput) {
          mergedRepositoryCount += 1;
        }

        repositories.push({
          projectId: target.projectId,
          repoPath: target.repoPath,
          branchName: target.branchName,
          planBranchName: integrationBranchName,
          mergeOutput,
        });
      }

      if (!allowWithoutCodeChanges && mergedRepositoryCount === 0) {
        set({
          lastError: tTask(
            'implement.errors.noIntegratedChanges',
            'Cannot complete task because there are no branch changes to integrate.'
          ),
        });
        return;
      }

      const removedWorktreeKeys = tauriIpc.isTauriAvailable()
        ? await cleanupTaskExecutionTargets(executionTargetsWithRepoPaths)
        : [];

      await get().setTaskStatus(taskId, 'Completed');

      set((state) => ({
        ...updateTaskRuntimeAfterCleanup(state, task, removedWorktreeKeys),
      }));

      if (get().activeBranchName === null && get().activeRepositoryPath === null) {
        await syncWorkspaceRoot(null);
      }

      const completedAt = new Date().toISOString();
      if (isManualStandaloneTask(task) && !task.draft) {
        await tauriIpc.workspaceArchiveManualFeature({
          taskId,
          reason: 'merged',
          mergedAt: completedAt,
        });
        await get().refreshFromPlan();
        await syncManualFeatureTaskMetadata(get().getTaskById(taskId), (message) => {
          set({ lastError: message });
        });
        await commitManualFeatureTaskMetadata(
          get().getTaskById(taskId) ?? task,
          `chore(metadata): complete manual feature ${taskId}`,
          (message) => {
            set({ lastError: message });
          }
        );
        if (useAppStore.getState().selectedTaskId === taskId) {
          useAppStore.getState().setSelectedTask(null);
        }
        return;
      }

      if (task.task_source === 'architect' && task.plan_target_branch) {
        try {
          await writeArchitectTaskExecution({
            branchName: resolveTargetBranch(task.plan_target_branch),
            planId: task.plan_id,
            execution: {
              taskId: task.id,
              title: task.title,
              completedAt,
              summary: allowWithoutCodeChanges ? 'Completed without code changes.' : undefined,
              repositories,
            },
          });
        } catch (error) {
          const normalized = toServiceError(error);
          set({ lastError: normalized.message });
        }

        await commitArchitectPlanMetadataForTask(
          task,
          `chore(metadata): complete architect task ${task.id}`,
          (message) => {
            set({ lastError: message });
          }
        );
      }
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  completeTask: async (taskId, options) => {
    await get().finishTask(taskId, options);
  },

  finalizePlan: async (planId) => {
    const summary = get().planSummaries.find((plan) => plan.id === planId);
    if (!summary) {
      set({
        lastError: tTask(
          'implement.errors.unknownTaskPlan',
          'Cannot update plan metadata for task {{taskId}}.',
          { taskId: planId }
        ),
      });
      return;
    }

    set({ finalizingPlanId: planId, lastError: null });

    try {
      const result = await finalizePlanIntoBaseBranch({
        branchName: resolveTargetBranch(summary.targetBranch),
        planId,
      });
      get().clearPlanRuntimeState({
        planId: result.plan.id,
        deletedWorktreeKeys: result.cleanup.flatMap((repository) =>
          repository.deletedWorktrees.map((worktree) => worktree.worktreeKey)
        ),
      });
      await get().refreshFromPlan();
      try {
        await commitArchitectPlanMetadata({
          branchName: resolveTargetBranch(summary.targetBranch),
          planId,
          commitMessage: `chore(metadata): finalize architect plan ${planId}`,
        });
      } catch (error) {
        set({ lastError: toServiceError(error).message });
      }
      set(buildPlanFinalizationSuccessState());
    } catch (error) {
      set(buildPlanFinalizationFailureState(error));
      throw error;
    }
  },

  markTaskAwaitingResponse: async (taskId) => {
    await get().setTaskStatus(taskId, 'AwaitingResponse');
  },

  markTaskFailed: async (taskId) => {
    await get().setTaskStatus(taskId, 'Failed');
  },

  retryTask: async (taskId) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }

    if (task.status === 'Failed') {
      await get().startTask(taskId);
      return;
    }

    if (task.status === 'AwaitingResponse') {
      await get().setTaskStatus(taskId, 'InProgress');
      return;
    }

    set({
      lastError: tTask(
        'implement.errors.retryRequiresFailedOrAwaiting',
        'Retry is only available for failed or awaiting-response tasks.'
      ),
    });
  },

  setTaskStatus: async (taskId, status) => {
    set({ lastError: null });
    assertTaskMutationRuntime('setTaskStatus');

    const currentTask = get().tasks.find((task) => task.id === taskId);
    if (!currentTask) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }

    if (currentTask.status === status) {
      return;
    }

    if (!canTransitionTaskStatus(currentTask.status, status)) {
      set({
        lastError: tTask(
          'implement.errors.invalidTaskTransition',
          'Invalid task status transition: {{from}} -> {{to}}.',
          { from: currentTask.status, to: status }
        ),
      });
      return;
    }

    if ((status === 'InProgress' || status === 'AwaitingResponse' || status === 'InReview' || status === 'Completed') && currentTask.is_blocked) {
      const reason = currentTask.blocked_by.join(', ');
      set({
        lastError: tTask(
          'implement.errors.taskBlockedByDependencies',
          'Task is blocked by unresolved dependencies: {{reason}}',
          { reason }
        ),
      });
      return;
    }

    const applyOptimisticTaskStatus = (): OptimisticTaskStatusSnapshot | null => {
      if (!shouldApplyOptimisticTaskStatus(currentTask, status)) {
        return null;
      }

      const appState = useAppStore.getState();
      const previousPredictedBranches =
        currentTask.task_source === 'architect' &&
        currentTask.plan_id &&
        appState.activeArchitectPlanId === currentTask.plan_id
          ? appState.predictedBranches
          : null;
      const nextTasks = applyTaskStatusLocally(get().tasks, currentTask, status);

      set({
        tasks: nextTasks,
        lastError: null,
      });

      if (previousPredictedBranches) {
        appState.setPredictedBranches(
          applyPredictedBranchLifecycle(
            nextTasks,
            previousPredictedBranches,
            currentTask.id,
            status
          )
        );
      }

      return {
        task: currentTask,
        previousPredictedBranches,
      };
    };

    const rollbackOptimisticTaskStatus = (
      snapshot: OptimisticTaskStatusSnapshot | null,
      errorMessage: string
    ) => {
      if (!snapshot) {
        set({ lastError: errorMessage });
        return;
      }

      set((state) => ({
        tasks: applyTaskStatusLocally(
          state.tasks,
          snapshot.task,
          snapshot.task.status
        ),
        lastError: errorMessage,
      }));

      if (
        snapshot.previousPredictedBranches &&
        snapshot.task.plan_id &&
        useAppStore.getState().activeArchitectPlanId === snapshot.task.plan_id
      ) {
        useAppStore
          .getState()
          .setPredictedBranches(snapshot.previousPredictedBranches);
      }
    };

    const optimisticTaskStatus = applyOptimisticTaskStatus();

    if (currentTask.task_source === 'standalone') {
      let persisted = false;
      try {
        if (!tauriIpc.isTauriAvailable()) {
          set({
            tasks: updateStandaloneTaskStatuses(get().tasks, taskId, status),
            lastError: null,
          });
          return;
        }

        await tauriIpc.workspaceUpdateStandaloneTaskStatus({
          taskId,
          status,
        });
        persisted = true;
        await get().refreshFromPlan();
        await syncManualFeatureTaskMetadata(get().getTaskById(taskId), (message) => {
          set({ lastError: message });
        });
      } catch (error) {
        const normalized = toServiceError(error);
        if (!persisted) {
          rollbackOptimisticTaskStatus(optimisticTaskStatus, normalized.message);
        } else {
          set({ lastError: normalized.message });
        }
      }
      return;
    }

    const persisted = await persistTaskStatusToArchitectPlan(currentTask, status, (message) => {
      set({ lastError: message });
    });

    if (!persisted) {
      rollbackOptimisticTaskStatus(
        optimisticTaskStatus,
        get().lastError ||
          tTask('implement.errors.unknownTaskPlan', 'Cannot update task {{taskId}}.', {
            taskId,
          })
      );
    }
  },

  clearPlanRuntimeState: ({ planId, deletedWorktreeKeys }) => {
    const appState = useAppStore.getState();
    const nextRuntimeState = clearPlanRuntimeStateSnapshot({
      currentState: get(),
      activePlanId: appState.activeArchitectPlanId,
      planId,
      deletedWorktreeKeys,
    });

    set({
      branchWorktrees: nextRuntimeState.branchWorktrees,
      activeBranchName: nextRuntimeState.activeBranchName,
      activeRepositoryPath: nextRuntimeState.activeRepositoryPath,
    });

    if (nextRuntimeState.shouldClearActivePlan) {
      const appState = useAppStore.getState();
      appState.setActiveArchitectPlanId(null);
      appState.setActivePlanContext(null);
      appState.setPlanNodes([]);
      appState.setPredictedBranches([]);
    }

    if (nextRuntimeState.shouldSyncWorkspaceRoot) {
      void syncWorkspaceRoot(null);
    }
  },

  clearPlanFinalizationBlock: () => {
    set({ blockedPlanFinalization: null });
  },

  getTaskById: (taskId) => get().tasks.find((task) => task.id === taskId),
  });
});

export type { CatalogedImplementTask as ImplementTask };
