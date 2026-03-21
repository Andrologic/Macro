import { create } from 'zustand';
import type { TaskExecutionTarget, TaskStatus } from '../types';
import i18n from '../i18n';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import { useAppStore } from './useAppStore';
import { useGitStore } from './useGitStore';
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
import {
  getArchitectPlan,
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
  removeManualFeatureMetadata,
  syncManualFeatureMetadataFromTask,
} from '../services/manualFeatureMetadataService';
import {
  buildPlanFinalizationFailureState,
  buildPlanFinalizationRefreshState,
  buildPlanFinalizationSuccessState,
  type BlockedPlanFinalizationState,
} from './taskStorePlanFinalizationState';

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

let appSyncUnsubscribe: (() => void) | null = null;

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

const ALLOWED_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  Pending: ['InProgress', 'Failed'],
  InProgress: ['AwaitingResponse', 'InReview', 'Failed'],
  AwaitingResponse: ['InProgress', 'InReview', 'Failed'],
  InReview: ['InProgress', 'Completed', 'Failed'],
  Completed: [],
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

const tTask = (key: string, fallback: string, options?: Record<string, unknown>): string =>
  i18n.t(key, { defaultValue: fallback, ...(options || {}) });

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

interface TaskStore {
  tasks: CatalogedImplementTask[];
  planSummaries: ImplementTaskPlanSummary[];
  hasStandaloneTasks: boolean;
  isLoading: boolean;
  finalizingPlanId: string | null;
  blockedPlanFinalization: BlockedPlanFinalizationState | null;
  lastError: string | null;
  source: TaskSource;
  branchWorktrees: Record<string, string>;
  activeBranchName: string | null;
  activeRepositoryPath: string | null;
  setTasks: (tasks: CatalogedImplementTask[]) => void;
  initialize: () => Promise<void>;
  refreshFromPlan: () => Promise<void>;
  activateTask: (taskId: string) => Promise<void>;
  createManualFeatureDraft: (params: {
    taskId: string;
    conversationId: string;
    groupId?: string | null;
    projectIds: string[];
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
  startTask: (taskId: string) => Promise<void>;
  startReview: (taskId: string) => Promise<void>;
  requestTaskChanges: (taskId: string) => Promise<void>;
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
): Promise<void> => {
  if (task.task_source !== 'architect' || !task.plan_id) {
    return;
  }

  const targetBranch = resolveTargetBranch(task.plan_target_branch || getGitFlowBaseBranch());
  const plan = await getArchitectPlan(targetBranch, task.plan_id);
  if (!plan || plan.status === 'deleted') {
    setError(
      tTask('implement.errors.unknownTaskPlan', 'Cannot update plan metadata for task {{taskId}}.', {
        taskId: task.id,
      })
    );
    return;
  }

  const nextNodeStatus = mapTaskStatusToNodeStatus(status);
  const nextPlanNodes = (plan.nodes || []).map((node) =>
    node.id === task.id ? { ...node, status: nextNodeStatus } : node
  );
  const currentPlanTasks = deriveImplementTasksFromStrategy({
    planId: plan.id,
    nodes: plan.nodes || [],
    predictedBranches: plan.predictedBranches || [],
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
    })),
    plan.predictedBranches || [],
    task.id,
    status
  );
  const strategy = deriveImplementTasksFromStrategy({
    planId: plan.id,
    nodes: nextPlanNodes,
    predictedBranches: nextPredictedBranches,
  });
  const nextPlanStatus = plan.status === 'validated' && status !== 'Pending'
    ? 'in_progress'
    : plan.status;

  try {
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
    await useTaskStore.getState().refreshFromPlan();
  } catch (error) {
    const normalized = toServiceError(error);
    setError(normalized.message);
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

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  planSummaries: [],
  hasStandaloneTasks: false,
  isLoading: false,
  finalizingPlanId: null,
  blockedPlanFinalization: null,
  lastError: null,
  source: 'empty',
  branchWorktrees: {},
  activeBranchName: null,
  activeRepositoryPath: null,

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
      set({
        tasks: catalog.tasks,
        planSummaries: catalog.plans,
        hasStandaloneTasks: catalog.hasStandaloneTasks,
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
      set({ isLoading: false, lastError: normalized.message });
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

    const branchName = task.assigned_branch;
    const preferredTarget = getPreferredExecutionTarget(task, appState.selectedProjectId);
    const primaryTarget = preferredTarget || getPrimaryExecutionTarget(task);
    const knownWorktree = primaryTarget ? get().branchWorktrees[primaryTarget.worktreeKey] : null;
    if (knownWorktree) {
      set({
        activeBranchName: branchName,
        activeRepositoryPath: knownWorktree,
      });
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
    try {
      if (!tauriIpc.isTauriAvailable()) {
        throw new Error('Manual features require the desktop runtime.');
      }

      await tauriIpc.workspaceCreateManualFeatureDraft({
        taskId: params.taskId,
        conversationId: params.conversationId,
        groupId: params.groupId ?? null,
        projectIds: params.projectIds,
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

  startTask: async (taskId) => {
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

    const executionTargets = getExecutionTargets(task);
    if (executionTargets.length === 0) {
      set({
        lastError: tTask(
          'implement.errors.cannotResolveTaskProject',
          'Cannot resolve project for task {{taskId}}',
          { taskId: task.id }
        ),
      });
      return;
    }

    const createdWorktrees: Record<string, string> = {};
    const fromRef =
      isManualStandaloneTask(task) && !task.draft
        ? (task.base_branch || getGitFlowBaseBranch())
        : null;
    for (const target of executionTargets) {
      let worktreePath = get().branchWorktrees[target.worktreeKey] || null;
      if (!worktreePath) {
        worktreePath = await useGitStore
          .getState()
          .createWorktree(target.projectId, target.worktreeKey, target.branchName, fromRef);
        if (!worktreePath) {
          set({
            lastError: tTask(
              'implement.errors.worktreeCreateFailed',
              'Failed to create or reuse worktree for branch {{branchName}}',
              { branchName: target.branchName }
            ),
          });
          return;
        }
      }
      createdWorktrees[target.worktreeKey] = worktreePath;
    }

    const primaryTarget =
      executionTargets.find((target) => target.projectId === appState.selectedProjectId) ||
      executionTargets[0];
    const primaryWorktree = createdWorktrees[primaryTarget.worktreeKey] || get().branchWorktrees[primaryTarget.worktreeKey] || null;

    set((state) => ({
      branchWorktrees: {
        ...state.branchWorktrees,
        ...createdWorktrees,
      },
      activeBranchName: task.assigned_branch,
      activeRepositoryPath: primaryWorktree,
      lastError: null,
    }));

    await syncWorkspaceRoot(primaryWorktree);
    await get().setTaskStatus(task.id, 'InProgress');
  },

  startReview: async (taskId) => {
    await get().setTaskStatus(taskId, 'InReview');
  },

  requestTaskChanges: async (taskId) => {
    await get().setTaskStatus(taskId, 'InProgress');
  },

  completeTask: async (taskId, options) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }

    const allowWithoutCodeChanges = options?.allowWithoutCodeChanges === true;
    const skipIntegration = options?.skipIntegration === true;

    if (task.status !== 'InReview') {
      set({
        lastError: tTask(
          'implement.errors.completeRequiresActiveStatus',
          'Task can only be completed from Validation.'
        ),
      });
      return;
    }

    const appState = useAppStore.getState();
    const executionTargets = getExecutionTargets(task);
    if (executionTargets.length === 0) {
      set({ lastError: tTask('implement.errors.cannotResolveTaskProject', 'Cannot resolve project for task {{taskId}}', { taskId }) });
      return;
    }

    const repositories: TaskCompletionRepositoryRecord[] = [...(options?.repositories || [])];
    const mergeTargetBranch = task.task_source === 'architect'
      ? null
      : getGitFlowBaseBranch();

    let mergedRepositoryCount = repositories.filter((repository) => Boolean(repository.mergeOutput)).length;

    if (!skipIntegration && tauriIpc.isTauriAvailable()) {
      for (const target of executionTargets) {
        const worktreePath = get().branchWorktrees[target.worktreeKey];
        if (!worktreePath) {
          set({
            lastError: tTask(
              'implement.errors.worktreeCreateFailed',
              'Missing worktree for branch {{branchName}}',
              { branchName: target.branchName }
            ),
          });
          return;
        }

        const project = appState.getProjectById(target.projectId);
        const repoPath = project?.path ?? null;
        if (!repoPath) {
          set({
            lastError: tTask(
              'implement.errors.cannotResolveTaskProject',
              'Cannot resolve project for task {{taskId}}',
              { taskId: task.id }
            ),
          });
          return;
        }

        try {
          const integrationBranchName = target.planBranchName || mergeTargetBranch;
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

          const status = await tauriIpc.gitStatus(worktreePath);
          if (!status.is_clean) {
            set({
              lastError: tTask(
                'implement.errors.repositoryNotCleanForComplete',
                'Cannot complete task while repository has uncommitted changes. Commit or stash changes first.'
              ),
            });
            return;
          }

          const diff = await tauriIpc.gitDiff({
            repoPath,
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
              repoPath,
              branchName: target.branchName,
              planBranchName: integrationBranchName,
            });
            continue;
          }

          const mergeOutput = allowWithoutCodeChanges || !diff.trim()
            ? undefined
            : await mergeFeatureBranchIntoPlanBranch({
              projectId: target.projectId,
              branchName: target.branchName,
              planBranchName: integrationBranchName,
              repoPath,
            });
          if (mergeOutput) {
            mergedRepositoryCount += 1;
          }
          repositories.push({
            projectId: target.projectId,
            repoPath,
            branchName: target.branchName,
            planBranchName: integrationBranchName,
            mergeOutput,
          });
        } catch (error) {
          const normalized = toServiceError(error);
          set({ lastError: normalized.message });
          return;
        }
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
    }

    await get().setTaskStatus(taskId, 'Completed');

    if (task.task_source === 'architect' && task.plan_target_branch) {
      try {
        await writeArchitectTaskExecution({
          branchName: resolveTargetBranch(task.plan_target_branch),
          planId: task.plan_id,
          execution: {
            taskId: task.id,
            title: task.title,
            completedAt: new Date().toISOString(),
            summary: allowWithoutCodeChanges ? 'Completed without code changes.' : undefined,
            repositories,
          },
        });
      } catch (error) {
        const normalized = toServiceError(error);
        set({ lastError: normalized.message });
      }
    }
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

    if (currentTask.task_source === 'standalone') {
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
        await get().refreshFromPlan();
        await syncManualFeatureTaskMetadata(get().getTaskById(taskId), (message) => {
          set({ lastError: message });
        });
      } catch (error) {
        const normalized = toServiceError(error);
        set({ lastError: normalized.message });
      }
      return;
    }

    await persistTaskStatusToArchitectPlan(currentTask, status, (message) => {
      set({ lastError: message });
    });
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
}));

export type { CatalogedImplementTask as ImplementTask };
