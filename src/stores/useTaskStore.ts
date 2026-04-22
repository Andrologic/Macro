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
  archiveArchitectPlan,
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
  isPlanFinalizationTask,
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
  buildInitialPlanFinalizationRuntimeState,
  buildPlanFinalizationTaskId,
  mergePlanFinalizationRuntimeState,
  type PlanFinalizationRuntimeState,
} from '../services/planFinalization';
import {
  buildInitialMergeWorkflowRuntimeState,
  buildMergeWorkflowFailureState,
  buildMergeWorkflowRepositoryBlockingState,
  createMergeWorkflowBlockedError,
  mergeMergeWorkflowRuntimeState,
  resolveMergeWorkflowTaskStatus,
  type MergeWorkflowKind,
  type MergeWorkflowRepositoryResult,
  type MergeWorkflowRuntimeState,
} from '../services/mergeWorkflow';
import {
  getTaskProjectCommand,
  loadTaskProjectCommandRegistry,
} from '../services/taskProjectCommands';
import { buildTerminalDisplayMetadata } from '../services/terminalDisplayMetadata';
import type { InternalAgentProfile } from '../services/internalAgentProfile';
import {
  loadPlanFinalizationMergeWorkflowRuntime,
  resolveMergeWorkflowActivationContext,
  sendMergeWorkflowConflictPrompt,
} from '../services/mergeWorkflowRuntime';

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
    executionKind: 'worktree',
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
  // Planned tasks integrate into the plan branch first; standalone work merges
  // directly into the configured project development branch.
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

const isPlanFinalizationRuntimeTask = (
  task: Pick<CatalogedImplementTask, 'task_source'> | null | undefined
): boolean => (task ? isPlanFinalizationTask(task) : false);

const createInitialMergeWorkflowStateForTask = (
  task: Pick<CatalogedImplementTask, 'id' | 'task_source'>
): MergeWorkflowRuntimeState =>
  buildInitialMergeWorkflowRuntimeState({
    taskId: task.id,
    kind: isPlanFinalizationRuntimeTask(task)
      ? 'plan_finalization'
      : 'task_completion',
  });

const createPlanFinalizationRuntimeState = (
  task: Pick<CatalogedImplementTask, 'plan_id' | 'plan_target_branch'>
): PlanFinalizationRuntimeState =>
  buildInitialPlanFinalizationRuntimeState({
    planId: task.plan_id,
    branchName: resolveTargetBranch(task.plan_target_branch || getGitFlowBaseBranch()),
  });

const toPlanFinalizationRepositoryResult = (
  repository: MergeWorkflowRepositoryResult
): PlanFinalizationRuntimeState['repositories'][number] => ({
  id: repository.id,
  projectId: repository.projectId,
  repoPath: repository.repoPath,
  planBranchName: repository.sourceBranchName,
  baseBranchName: repository.targetBranchName,
  isClean: repository.isClean,
  hasChanges: repository.hasChanges,
  mergeable: repository.mergeable,
  conflictFiles: repository.conflictFiles,
  mergeInProgress: repository.mergeInProgress,
  diff: repository.diff,
  checkStatus: repository.checkStatus,
  blockingKind: repository.blockingKind,
  nextAction: repository.nextAction,
  blockingReason: repository.blockingReason,
});

const toPlanFinalizationRuntimeFromMergeWorkflow = (
  task: Pick<CatalogedImplementTask, 'plan_id' | 'plan_target_branch' | 'plan_title' | 'title'>,
  runtime: MergeWorkflowRuntimeState | null | undefined
): PlanFinalizationRuntimeState => {
  const branchName = resolveTargetBranch(
    task.plan_target_branch || getGitFlowBaseBranch()
  );
  const fallback = buildInitialPlanFinalizationRuntimeState({
    planId: task.plan_id,
    branchName,
  });

  if (!runtime) {
    return fallback;
  }

  return {
    planId: task.plan_id,
    branchName,
    phase: runtime.phase,
    taskStatus: runtime.taskStatus,
    review: runtime.review
      ? {
          plan: {
            id: task.plan_id,
            title: runtime.review.planTitle || runtime.review.title || task.plan_title || task.title,
            targetBranch: runtime.review.targetBranch || branchName,
          } as NonNullable<PlanFinalizationRuntimeState['review']>['plan'],
          tasks: [],
          repositories: runtime.repositories.map(toPlanFinalizationRepositoryResult),
        }
      : null,
    repositories: runtime.repositories.map(toPlanFinalizationRepositoryResult),
    blockedRepositories: runtime.blockedRepositories.map(
      toPlanFinalizationRepositoryResult
    ),
    message: runtime.message,
    lastLoadedAt: runtime.lastLoadedAt,
  };
};

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

const updateMergeWorkflowRuntimeState = (
  current: Record<string, MergeWorkflowRuntimeState>,
  taskId: string,
  patch: Partial<MergeWorkflowRuntimeState> &
    Pick<MergeWorkflowRuntimeState, 'taskId' | 'kind'>
): Record<string, MergeWorkflowRuntimeState> => ({
  ...current,
  [taskId]: mergeMergeWorkflowRuntimeState(current[taskId], patch),
});

const applyTaskStatusLocallyById = (
  tasks: CatalogedImplementTask[],
  taskId: string,
  status: TaskStatus
): CatalogedImplementTask[] =>
  tasks.map((task) => (task.id === taskId ? { ...task, status } : task));

const applyMergeWorkflowRuntimePatch = (
  state: Pick<TaskStore, 'tasks' | 'mergeWorkflowRuntimeByTaskId'>,
  taskId: string,
  patch: Partial<MergeWorkflowRuntimeState> &
    Pick<MergeWorkflowRuntimeState, 'taskId' | 'kind'>
): Pick<TaskStore, 'tasks' | 'mergeWorkflowRuntimeByTaskId'> => {
  const mergeWorkflowRuntimeByTaskId = updateMergeWorkflowRuntimeState(
    state.mergeWorkflowRuntimeByTaskId,
    taskId,
    patch
  );
  const nextTaskStatus =
    mergeWorkflowRuntimeByTaskId[taskId]?.taskStatus ?? 'Pending';

  return {
    tasks: applyTaskStatusLocallyById(state.tasks, taskId, nextTaskStatus),
    mergeWorkflowRuntimeByTaskId,
  };
};

const updatePlanFinalizationRuntimeState = (
  current: Record<string, PlanFinalizationRuntimeState>,
  planId: string,
  patch: Partial<PlanFinalizationRuntimeState> & { branchName: string }
): Record<string, PlanFinalizationRuntimeState> => ({
  ...current,
  [planId]: mergePlanFinalizationRuntimeState(current[planId], {
    planId,
    ...patch,
  }),
});

const applyPlanFinalizationTaskStatusLocally = (
  tasks: CatalogedImplementTask[],
  planId: string,
  status: TaskStatus
): CatalogedImplementTask[] =>
  tasks.map((task) =>
    isPlanFinalizationRuntimeTask(task) && task.plan_id === planId
      ? { ...task, status }
      : task
  );

const applyPlanFinalizationRuntimePatch = (
  state: Pick<TaskStore, 'tasks' | 'planFinalizationRuntimeByPlanId'>,
  planId: string,
  patch: Partial<PlanFinalizationRuntimeState> & { branchName: string }
): Pick<TaskStore, 'tasks' | 'planFinalizationRuntimeByPlanId'> => {
  const planFinalizationRuntimeByPlanId = updatePlanFinalizationRuntimeState(
    state.planFinalizationRuntimeByPlanId,
    planId,
    patch
  );
  const nextTaskStatus = planFinalizationRuntimeByPlanId[planId]?.taskStatus ?? 'Pending';

  return {
    tasks: applyPlanFinalizationTaskStatusLocally(state.tasks, planId, nextTaskStatus),
    planFinalizationRuntimeByPlanId,
  };
};

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
  if (isPlanFinalizationRuntimeTask(task)) {
    return {
      isPublished: false,
      canRename: false,
      canDelete: false,
      canArchive: false,
      canRestore: false,
      canReopen: false,
      deleteBlockReason: null,
    };
  }

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
  mergeWorkflowRuntimeByTaskId: Record<string, MergeWorkflowRuntimeState>;
  planFinalizationRuntimeByPlanId: Record<string, PlanFinalizationRuntimeState>;
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
  revertManualFeatureToDraft: (params: {
    taskId: string;
    conversationId?: string | null;
    title?: string | null;
    description?: string | null;
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
  loadMergeWorkflowReview: (taskId: string, options?: { force?: boolean }) => Promise<MergeWorkflowRuntimeState | null>;
  runMergeWorkflow: (taskId: string, options?: CompleteTaskOptions) => Promise<void>;
  resolveMergeWorkflowAutomatically: (
    taskId: string,
    options?: { internalAgentProfile?: InternalAgentProfile | null }
  ) => Promise<string | null>;
  finishTask: (taskId: string, options?: CompleteTaskOptions) => Promise<void>;
  completeTask: (taskId: string, options?: CompleteTaskOptions) => Promise<void>;
  loadPlanFinalizationReview: (planId: string, options?: { force?: boolean }) => Promise<PlanFinalizationRuntimeState | null>;
  finalizePlan: (planId: string) => Promise<void>;
  archivePlanFromTask: (planId: string) => Promise<void>;
  resolvePlanFinalizationAutomatically: (
    planId: string,
    options?: { internalAgentProfile?: InternalAgentProfile | null }
  ) => Promise<string | null>;
  markTaskAwaitingResponse: (taskId: string) => Promise<void>;
  markTaskFailed: (taskId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  setTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  clearPlanRuntimeState: (params: ClearPlanRuntimeStateParams) => void;
  getMergeWorkflowRuntime: (taskId: string) => MergeWorkflowRuntimeState | null;
  getPlanFinalizationRuntime: (planId: string) => PlanFinalizationRuntimeState | null;
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

type MergeWorkflowExecutionTarget = TaskExecutionTarget & {
  repoPath: string;
  worktreePath?: string;
};

const buildTaskCompletionMergeWorkflowRuntime = async (params: {
  task: CatalogedImplementTask;
  executionTargets: MergeWorkflowExecutionTarget[];
  prepareTargetBranches?: boolean;
  syncStandaloneTargets?: boolean;
}): Promise<MergeWorkflowRuntimeState> => {
  const repositories: MergeWorkflowRepositoryResult[] = [];

  for (const target of params.executionTargets) {
    const integrationBranchName = getTaskIntegrationBranch(params.task, target);
    if (!integrationBranchName) {
      throw new Error(
        tTask(
          'implement.errors.missingIntegrationBranch',
          'Cannot determine the integration branch for task {{taskId}}.',
          { taskId: params.task.id }
        )
      );
    }

    let status = await tauriIpc.gitStatus(target.repoPath);
    const hasRepoConflicts = Boolean(
      (status.conflicted_files?.length || 0) + (status.conflictedFiles?.length || 0)
    );
    const mergeInProgress = Boolean(
      status.mergeInProgress ?? status.merge_in_progress
    );

    if (
      params.prepareTargetBranches &&
      status.branch !== integrationBranchName &&
      !hasRepoConflicts &&
      !mergeInProgress &&
      status.is_clean
    ) {
      await tauriIpc.gitCheckout({
        repoPath: target.repoPath,
        branchOrCommit: integrationBranchName,
        create: false,
      });
      status = await tauriIpc.gitStatus(target.repoPath);
    }

    if (
      params.prepareTargetBranches &&
      params.syncStandaloneTargets &&
      params.task.task_source === 'standalone' &&
      status.branch === integrationBranchName &&
      status.is_clean &&
      !hasRepoConflicts &&
      !mergeInProgress
    ) {
      await syncIntegrationBranchIfConfigured(target.repoPath, integrationBranchName);
      status = await tauriIpc.gitStatus(target.repoPath);
    }

    const diff = await tauriIpc.gitDiff({
      repoPath: target.repoPath,
      base: integrationBranchName,
      head: target.branchName,
      contextLines: 3,
    });

    const mergeCheck = status.is_clean
      ? await tauriIpc.gitMergeCheck({
          repoPath: target.repoPath,
          branchName: target.branchName,
          intoBranch: integrationBranchName,
        })
      : {
          mergeable: false,
          conflictFiles: [],
          hasChanges: diff.trim().length > 0,
        };
    const blocking = buildMergeWorkflowRepositoryBlockingState({
      repositoryPath: target.repoPath,
      status,
      mergeCheck,
    });

    repositories.push({
      id: `${target.projectId}::${target.repoPath}`,
      projectId: target.projectId,
      repoPath: target.repoPath,
      sourceBranchName: target.branchName,
      targetBranchName: integrationBranchName,
      isClean: status.is_clean,
      hasChanges: mergeCheck.hasChanges,
      mergeable: mergeCheck.mergeable,
      conflictFiles: blocking.conflictFiles,
      mergeInProgress: blocking.mergeInProgress,
      diff,
      checkStatus: status.is_clean
        ? mergeCheck.mergeable
          ? 'passed'
          : 'failed'
        : 'not_run',
      blockingKind: blocking.blockingKind,
      nextAction: blocking.nextAction,
      blockingReason: blocking.blockingReason,
    });
  }

  const blockedRepositories = repositories.filter((repository) =>
    Boolean(repository.blockingReason)
  );
  const phase = blockedRepositories.length > 0 ? 'blocked' : 'ready';

  return {
    taskId: params.task.id,
    kind: 'task_completion',
    phase,
    taskStatus: resolveMergeWorkflowTaskStatus(phase, {
      kind: 'task_completion',
    }),
    review: {
      taskId: params.task.id,
      title: params.task.title,
      taskSource: params.task.task_source,
      planId: params.task.plan_id,
      planTitle: params.task.plan_title,
      targetBranch: params.task.plan_target_branch || params.task.base_branch,
    },
    repositories,
    blockedRepositories,
    message:
      blockedRepositories.length > 0
        ? 'Resolve the repository blockers before retrying the merge.'
        : null,
    lastLoadedAt: new Date().toISOString(),
  };
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
  mergeWorkflowRuntimeByTaskId: {},
  planFinalizationRuntimeByPlanId: {},
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
      const nextMergeWorkflowRuntimeByTaskId: Record<string, MergeWorkflowRuntimeState> =
        {};
      const nextPlanFinalizationRuntimeByPlanId: Record<string, PlanFinalizationRuntimeState> = {};
      const tasks = catalog.tasks.map((task) => {
        const existingMergeRuntime = get().mergeWorkflowRuntimeByTaskId[task.id];
        const shouldCarryMergeRuntime =
          Boolean(existingMergeRuntime) &&
          task.status !== 'Completed' &&
          !task.archived_at;

        if (shouldCarryMergeRuntime) {
          const runtimeState = mergeMergeWorkflowRuntimeState(
            existingMergeRuntime,
            createInitialMergeWorkflowStateForTask(task)
          );
          nextMergeWorkflowRuntimeByTaskId[task.id] = runtimeState;
          task = {
            ...task,
            status: runtimeState.taskStatus,
          };
        }

        if (!isPlanFinalizationRuntimeTask(task)) {
          return task;
        }

        const runtimeState = mergePlanFinalizationRuntimeState(
          get().planFinalizationRuntimeByPlanId[task.plan_id],
          createPlanFinalizationRuntimeState(task)
        );
        nextPlanFinalizationRuntimeByPlanId[task.plan_id] = runtimeState;
        const planTaskRuntime =
          nextMergeWorkflowRuntimeByTaskId[task.id] ||
          buildInitialMergeWorkflowRuntimeState({
            taskId: task.id,
            kind: 'plan_finalization',
          });
        nextMergeWorkflowRuntimeByTaskId[task.id] = mergeMergeWorkflowRuntimeState(
          planTaskRuntime,
          {
            taskId: task.id,
            kind: 'plan_finalization',
            taskStatus: runtimeState.taskStatus,
          }
        );
        return {
          ...task,
          status: nextMergeWorkflowRuntimeByTaskId[task.id]?.taskStatus || runtimeState.taskStatus,
        };
      });
      const publishedStandaloneTasks = await buildStandalonePublicationMap(tasks);
      set({
        tasks,
        planSummaries: catalog.plans,
        hasStandaloneTasks: catalog.hasStandaloneTasks,
        publishedStandaloneTasks,
        mergeWorkflowRuntimeByTaskId: nextMergeWorkflowRuntimeByTaskId,
        planFinalizationRuntimeByPlanId: nextPlanFinalizationRuntimeByPlanId,
        missingBaseBranchIssue: null,
        source: catalog.source,
        lastError: null,
        isLoading: false,
      });

      const { selectedGroupId, selectedProjectId, projectGroups } = useAppStore.getState();
      const scopedProjectIds = getScopedProjectIds(projectGroups, selectedGroupId, selectedProjectId);
      const selectedTaskIdFromApp = useAppStore.getState().selectedTaskId;
      if (selectedTaskIdFromApp && !tasks.some((task) => task.id === selectedTaskIdFromApp)) {
        useAppStore.getState().setSelectedTask(null);
      }

      const selectedTaskId = useAppStore.getState().selectedTaskId;
      if (!selectedTaskId && scopedProjectIds.length > 0) {
        try {
          const contextKey = selectedGroupId || selectedProjectId;
          const context = contextKey ? await getLocalProjectContextState(contextKey) : null;
          const candidateTaskId = context?.lastTaskId;
          if (candidateTaskId) {
            const candidateTask = tasks.find((task) => task.id === candidateTaskId);
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
    const mergeRuntime = task ? get().mergeWorkflowRuntimeByTaskId[task.id] ?? null : null;

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

    if (isPlanFinalizationRuntimeTask(task) || mergeRuntime) {
      const { repoPath, branchName } = resolveMergeWorkflowActivationContext({
        task,
        runtime: mergeRuntime,
        preferredProjectId: appState.selectedProjectId,
        resolveRepoPath: resolveTaskRepositoryPath,
      });

      set({
        activeBranchName: branchName,
        activeRepositoryPath: repoPath,
      });
      await syncWorkspaceRoot(repoPath);
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

  revertManualFeatureToDraft: async (params) => {
    set({ lastError: null });
    assertTaskMutationRuntime('revertManualFeatureToDraft');

    const existingTask = get().getTaskById(params.taskId);
    if (!existingTask) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId: params.taskId }) });
      return;
    }

    if (!isManualStandaloneTask(existingTask)) {
      set({
        lastError: tTask(
          'implement.errors.revertDraftUnsupportedTask',
          'Only standalone features can be reverted to draft.'
        ),
      });
      return;
    }

    if (existingTask.draft) {
      return;
    }

    try {
      if (!tauriIpc.isTauriAvailable()) {
        throw new Error('Manual features require the desktop runtime.');
      }

      const executionTargets = getExecutionTargetsWithRepoPaths(existingTask);
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

      const removedWorktreeKeys = getExecutionTargets(existingTask).map((target) => target.worktreeKey);
      set((state) => ({
        ...updateTaskRuntimeAfterCleanup(state, existingTask, removedWorktreeKeys),
        missingBaseBranchIssue: null,
      }));

      await tauriIpc.workspaceRevertManualFeatureToDraft({
        taskId: params.taskId,
        conversationId: params.conversationId ?? null,
        title: params.title ?? null,
        description: params.description ?? null,
      });

      await get().refreshFromPlan();
      await useTerminalStore.getState().syncTerminalDisplayMetadata({ taskId: params.taskId });
      await syncManualFeatureTaskMetadata(get().getTaskById(params.taskId), (message) => {
        set({ lastError: message });
      });

      if (useAppStore.getState().selectedTaskId === params.taskId) {
        await get().activateTask(params.taskId);
      } else if (get().activeBranchName === null && get().activeRepositoryPath === null) {
        await syncWorkspaceRoot(null);
      }
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

    const mergeRuntime = get().mergeWorkflowRuntimeByTaskId[task.id] ?? null;
    if (isPlanFinalizationRuntimeTask(task) || mergeRuntime) {
      try {
        const runtime = await get().loadMergeWorkflowReview(task.id, {
          force: task.status === 'Failed',
        });
        const { repoPath, branchName } = resolveMergeWorkflowActivationContext({
          task,
          runtime,
          preferredProjectId: appState.selectedProjectId,
          resolveRepoPath: resolveTaskRepositoryPath,
        });

        set({
          activeBranchName: branchName,
          activeRepositoryPath: repoPath,
          missingBaseBranchIssue: null,
          lastError: null,
        });

        await syncWorkspaceRoot(repoPath);
        return;
      } catch (error) {
        const failureState = buildMergeWorkflowFailureState(error, {
          taskId: task.id,
          kind: isPlanFinalizationRuntimeTask(task)
            ? 'plan_finalization'
            : 'task_completion',
        });
        set((state) => ({
          ...applyMergeWorkflowRuntimePatch(state, task.id, {
            taskId: task.id,
            kind: isPlanFinalizationRuntimeTask(task)
              ? 'plan_finalization'
              : 'task_completion',
            ...failureState.runtimePatch,
          }),
          lastError: failureState.lastError,
        }));
        return;
      }
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

  loadMergeWorkflowReview: async (taskId, options) => {
    const task = get().getTaskById(taskId);
    if (!task) {
      return null;
    }

    const kind: MergeWorkflowKind = isPlanFinalizationRuntimeTask(task)
      ? 'plan_finalization'
      : 'task_completion';
    const existingRuntime = get().mergeWorkflowRuntimeByTaskId[taskId];
    if (!options?.force && existingRuntime?.review) {
      return existingRuntime;
    }

    set((state) => ({
      ...applyMergeWorkflowRuntimePatch(state, taskId, {
        taskId,
        kind,
        phase: 'loading_review',
        taskStatus:
          task.status === 'AwaitingResponse'
            ? 'AwaitingResponse'
            : resolveMergeWorkflowTaskStatus('loading_review', { kind }),
        message: null,
      }),
      lastError: null,
    }));

    try {
      let nextRuntime: MergeWorkflowRuntimeState | null = null;
      if (kind === 'plan_finalization') {
        const summary = get().planSummaries.find((plan) => plan.id === task.plan_id);
        if (!summary) {
          return null;
        }
        nextRuntime = await loadPlanFinalizationMergeWorkflowRuntime({
          taskId,
          summary,
        });
      } else {
        const executionTargets = getExecutionTargetsWithRepoPaths(task);
        if (executionTargets.length === 0) {
          throw new Error(
            tTask(
              'implement.errors.cannotResolveTaskProject',
              'Cannot resolve project for task {{taskId}}',
              { taskId }
            )
          );
        }
        nextRuntime = await buildTaskCompletionMergeWorkflowRuntime({
          task,
          executionTargets,
        });
      }

      if (!nextRuntime) {
        return null;
      }

      const resolvedRuntime = {
        ...nextRuntime,
        taskStatus:
          task.status === 'AwaitingResponse'
            ? 'AwaitingResponse'
            : nextRuntime.taskStatus,
      };

      set((state) => ({
        ...applyMergeWorkflowRuntimePatch(state, taskId, resolvedRuntime),
        lastError: null,
      }));

      return resolvedRuntime;
    } catch (error) {
      const failureState = buildMergeWorkflowFailureState(error, {
        taskId,
        kind,
      });
      set((state) => ({
        ...applyMergeWorkflowRuntimePatch(state, taskId, {
          taskId,
          kind,
          ...failureState.runtimePatch,
        }),
        lastError: failureState.lastError,
      }));
      throw toServiceError(error);
    }
  },

  runMergeWorkflow: async (taskId, options) => {
    const task = get().getTaskById(taskId);
    if (!task) {
      const error = toServiceError(
        tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId })
      );
      set({ lastError: error.message });
      throw error;
    }

    const kind: MergeWorkflowKind = isPlanFinalizationRuntimeTask(task)
      ? 'plan_finalization'
      : 'task_completion';
    const allowWithoutCodeChanges = options?.allowWithoutCodeChanges === true;

    set((state) => ({
      ...applyMergeWorkflowRuntimePatch(state, task.id, {
        taskId: task.id,
        kind,
        phase: 'merging',
        taskStatus: 'InProgress',
        message: null,
      }),
      lastError: null,
    }));

    try {
      if (kind === 'plan_finalization') {
        const summary = get().planSummaries.find((plan) => plan.id === task.plan_id);
        if (!summary) {
          throw new Error(
            tTask(
              'implement.errors.unknownTaskPlan',
              'Cannot update plan metadata for task {{taskId}}.',
              { taskId: task.plan_id }
            )
          );
        }

        const branchName = resolveTargetBranch(summary.targetBranch);
        const result = await finalizePlanIntoBaseBranch({
          branchName,
          planId: task.plan_id,
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
            branchName,
            planId: task.plan_id,
            commitMessage: `chore(metadata): finalize architect plan ${task.plan_id}`,
          });
        } catch (error) {
          set({ lastError: toServiceError(error).message });
        }
        return;
      }

      if (
        task.status !== 'InReview' &&
        task.status !== 'InProgress' &&
        task.status !== 'Blocked' &&
        task.status !== 'Failed'
      ) {
        throw new Error(
          tTask(
            'implement.errors.completeRequiresActiveStatus',
            'Task can only be completed from Validation.'
          )
        );
      }

      const executionTargets = getExecutionTargets(task);
      if (executionTargets.length === 0) {
        throw new Error(
          tTask(
            'implement.errors.cannotResolveTaskProject',
            'Cannot resolve project for task {{taskId}}',
            { taskId }
          )
        );
      }

      const repositories: TaskCompletionRepositoryRecord[] = [
        ...(options?.repositories || []),
      ];
      let executionTargetsWithRepoPaths: Array<
        TaskExecutionTarget & { repoPath: string; worktreePath: string }
      > = [];
      try {
        const { createdWorktrees, preparedTargets } =
          await ensureTaskExecutionTargetsReady(task, get().branchWorktrees);
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
          throw error;
        }
        throw error;
      }

      for (const target of executionTargetsWithRepoPaths) {
        const status = await tauriIpc.gitStatus(target.worktreePath);
        if (!status.is_clean) {
          throw new Error(
            tTask(
              'implement.errors.repositoryNotCleanForComplete',
              'Cannot complete task while repository has uncommitted changes. Commit or stash changes first.'
            )
          );
        }
      }

      const mergeRuntime = await buildTaskCompletionMergeWorkflowRuntime({
        task,
        executionTargets: executionTargetsWithRepoPaths,
        prepareTargetBranches: true,
        syncStandaloneTargets: !allowWithoutCodeChanges,
      });
      set((state) => ({
        ...applyMergeWorkflowRuntimePatch(state, task.id, mergeRuntime),
        lastError: null,
      }));

      if (mergeRuntime.blockedRepositories.length > 0) {
        throw createMergeWorkflowBlockedError({
          taskId: task.id,
          kind: 'task_completion',
          repositories: mergeRuntime.repositories,
          message: mergeRuntime.message || undefined,
        });
      }

      let mergedRepositoryCount = 0;
      for (const repository of mergeRuntime.repositories) {
        if (allowWithoutCodeChanges && repository.diff.trim()) {
          throw new Error(
            tTask(
              'implement.errors.completeWithoutCodeChangesHasDiff',
              'Cannot complete without code changes because {{branchName}} still contains branch changes.',
              { branchName: repository.targetBranchName }
            )
          );
        }

        if (!allowWithoutCodeChanges && !repository.diff.trim()) {
          repositories.push({
            projectId: repository.projectId,
            repoPath: repository.repoPath,
            branchName: repository.sourceBranchName,
            planBranchName: repository.targetBranchName,
          });
          continue;
        }

        const mergeOutput = allowWithoutCodeChanges
          ? undefined
          : await mergeFeatureBranchIntoPlanBranch({
              projectId: repository.projectId,
              branchName: repository.sourceBranchName,
              planBranchName: repository.targetBranchName,
              repoPath: repository.repoPath,
            });
        if (mergeOutput) {
          mergedRepositoryCount += 1;
        }

        repositories.push({
          projectId: repository.projectId,
          repoPath: repository.repoPath,
          branchName: repository.sourceBranchName,
          planBranchName: repository.targetBranchName,
          mergeOutput,
        });
      }

      if (!allowWithoutCodeChanges && mergedRepositoryCount === 0) {
        throw new Error(
          tTask(
            'implement.errors.noIntegratedChanges',
            'Cannot complete task because there are no branch changes to integrate.'
          )
        );
      }

      const removedWorktreeKeys = tauriIpc.isTauriAvailable()
        ? await cleanupTaskExecutionTargets(executionTargetsWithRepoPaths)
        : [];

      set((state) => ({
        mergeWorkflowRuntimeByTaskId: Object.fromEntries(
          Object.entries(state.mergeWorkflowRuntimeByTaskId).filter(
            ([candidateTaskId]) => candidateTaskId !== taskId
          )
        ),
      }));
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
          const targetBranch = resolveTargetBranch(task.plan_target_branch);
          const plan = await getArchitectPlan(targetBranch, task.plan_id);
          if (!plan || plan.status === 'deleted') {
            set({
              lastError: tTask(
                'implement.errors.unknownTaskPlan',
                'Cannot update plan metadata for task {{taskId}}.',
                { taskId: task.id }
              ),
            });
          } else {
            const nextPlanNodes = (plan.nodes || []).map((node) =>
              node.id === task.id
                ? {
                    ...node,
                    status: 'completed' as const,
                    archivedAt: completedAt,
                    archiveReason: 'merged',
                    mergedAt: completedAt,
                  }
                : node
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
            if (useAppStore.getState().selectedTaskId === taskId) {
              useAppStore.getState().setSelectedTask(null);
            }
          }
        } catch (error) {
          const normalized = toServiceError(error);
          set({ lastError: normalized.message });
        }

        try {
          await writeArchitectTaskExecution({
            branchName: resolveTargetBranch(task.plan_target_branch),
            planId: task.plan_id,
            execution: {
              taskId: task.id,
              title: task.title,
              completedAt,
              summary: allowWithoutCodeChanges
                ? 'Completed without code changes.'
                : undefined,
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

      if (!(error instanceof MissingTaskBaseBranchError)) {
        let refreshedRuntime: MergeWorkflowRuntimeState | null = null;
        try {
          refreshedRuntime = await get().loadMergeWorkflowReview(task.id, { force: true });
        } catch {
          const failureState = buildMergeWorkflowFailureState(error, {
            taskId: task.id,
            kind,
          });
          set((state) => ({
            ...applyMergeWorkflowRuntimePatch(state, task.id, {
              taskId: task.id,
              kind,
              ...failureState.runtimePatch,
            }),
            lastError: failureState.lastError,
          }));
        }

        if (refreshedRuntime && refreshedRuntime.blockedRepositories.length > 0) {
          set({ lastError: normalized.message });
        }
      }

      set({ lastError: normalized.message });
      throw normalized;
    }
  },

  finishTask: async (taskId, options) => {
    await get().runMergeWorkflow(taskId, options);
  },

  completeTask: async (taskId, options) => {
    await get().runMergeWorkflow(taskId, options);
  },

  loadPlanFinalizationReview: async (planId, options) => {
    const task = get().getTaskById(buildPlanFinalizationTaskId(planId));
    if (!task) {
      return null;
    }

    const runtime = await get().loadMergeWorkflowReview(task.id, options);
    return toPlanFinalizationRuntimeFromMergeWorkflow(task, runtime);
  },

  finalizePlan: async (planId) => {
    await get().runMergeWorkflow(buildPlanFinalizationTaskId(planId));
  },

  archivePlanFromTask: async (planId) => {
    const summary = get().planSummaries.find((plan) => plan.id === planId);
    if (!summary) {
      return;
    }

    const branchName = resolveTargetBranch(summary.targetBranch);
    const taskId = buildPlanFinalizationTaskId(planId);
    set((state) => ({
      lastError: null,
      ...applyMergeWorkflowRuntimePatch(state, taskId, {
        taskId,
        kind: 'plan_finalization',
        phase: 'archiving',
        taskStatus: 'InProgress',
        message: null,
      }),
      ...applyPlanFinalizationRuntimePatch(state, planId, {
        branchName,
        phase: 'archiving',
        taskStatus: 'InProgress',
        message: null,
      }),
    }));

    try {
      await archiveArchitectPlan(branchName, planId);
      if (useAppStore.getState().selectedTaskId === buildPlanFinalizationTaskId(planId)) {
        useAppStore.getState().setSelectedTask(null);
      }
      await get().refreshFromPlan();
    } catch (error) {
      const normalized = toServiceError(error);
      set((state) => ({
        lastError: normalized.message,
        ...applyMergeWorkflowRuntimePatch(state, taskId, {
          taskId,
          kind: 'plan_finalization',
          phase: 'failed',
          taskStatus: 'Failed',
          message: normalized.message,
        }),
        ...applyPlanFinalizationRuntimePatch(state, planId, {
          branchName,
          phase: 'failed',
          taskStatus: 'Failed',
          message: normalized.message,
        }),
      }));
      throw normalized;
    }
  },

  resolveMergeWorkflowAutomatically: async (taskId, options) => {
    const task = get().getTaskById(taskId);
    if (!task) {
      return null;
    }

    const runtime =
      get().mergeWorkflowRuntimeByTaskId[taskId] ||
      (await get().loadMergeWorkflowReview(taskId, { force: true }));
    if (!runtime || runtime.blockedRepositories.length === 0) {
      return null;
    }

    const appState = useAppStore.getState();
    const chatStore = useChatStore.getState();
    return sendMergeWorkflowConflictPrompt({
      task,
      runtime,
      selectedGroupId: appState.selectedGroupId,
      selectedTaskId: appState.selectedTaskId,
      ensureConversationForCurrentMode: chatStore.ensureConversationForCurrentMode,
      createConversation: chatStore.createConversation,
      sendMessage: chatStore.sendMessage,
      activateTask: get().activateTask,
      setMode: appState.setMode,
      setSelectedTask: appState.setSelectedTask,
      internalAgentProfile: options?.internalAgentProfile ?? 'repo_auditor',
    });
  },

  resolvePlanFinalizationAutomatically: async (planId, options) => {
    return get().resolveMergeWorkflowAutomatically(
      buildPlanFinalizationTaskId(planId),
      options
    );
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

    const mergeRuntime = get().mergeWorkflowRuntimeByTaskId[currentTask.id] ?? null;
    if (isPlanFinalizationRuntimeTask(currentTask) || mergeRuntime) {
      const kind: MergeWorkflowKind = isPlanFinalizationRuntimeTask(currentTask)
        ? 'plan_finalization'
        : mergeRuntime?.kind || 'task_completion';
      set((state) => ({
        ...applyMergeWorkflowRuntimePatch(state, currentTask.id, {
          taskId: currentTask.id,
          kind,
          taskStatus: status,
          phase:
            status === 'Blocked'
              ? 'blocked'
              : status === 'Failed'
                ? 'failed'
                : state.mergeWorkflowRuntimeByTaskId[currentTask.id]?.phase ||
                  (kind === 'plan_finalization' ? 'ready' : 'idle'),
        }),
        lastError: null,
      }));
      return;
    }

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
      mergeWorkflowRuntimeByTaskId: Object.fromEntries(
        Object.entries(get().mergeWorkflowRuntimeByTaskId).filter(
          ([candidateTaskId]) =>
            !planId || candidateTaskId !== buildPlanFinalizationTaskId(planId)
        )
      ),
      planFinalizationRuntimeByPlanId: Object.fromEntries(
        Object.entries(get().planFinalizationRuntimeByPlanId).filter(([candidatePlanId]) => candidatePlanId !== planId)
      ),
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

  getMergeWorkflowRuntime: (taskId) => get().mergeWorkflowRuntimeByTaskId[taskId] ?? null,

  getPlanFinalizationRuntime: (planId) => {
    const task = get().getTaskById(buildPlanFinalizationTaskId(planId));
    if (!task) {
      return get().planFinalizationRuntimeByPlanId[planId] ?? null;
    }
    return toPlanFinalizationRuntimeFromMergeWorkflow(
      task,
      get().mergeWorkflowRuntimeByTaskId[task.id] ?? null
    );
  },

  getTaskById: (taskId) => get().tasks.find((task) => task.id === taskId),
  });
});

export type { CatalogedImplementTask as ImplementTask };
