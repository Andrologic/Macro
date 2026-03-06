import { create } from 'zustand';
import type { Task, TaskExecutionTarget, TaskStatus } from '../types';
import i18n from '../i18n';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import { useAppStore } from './useAppStore';
import { useGitStore } from './useGitStore';
import { getLocalProjectContextState } from '../services/localProjectContext';
import * as tauriIpc from '../services/tauriIpc';
import {
  deriveImplementTasksFromStrategy,
  mapTaskStatusToNodeStatus,
  toBranchWorktreeKey,
  type DerivedImplementTask,
} from '../services/implementTaskDerivation';
import { mergeFeatureBranchIntoPlanBranch } from '../services/architectGitFlowService';
import {
  resolveTargetBranch,
  updateArchitectPlan,
  writeArchitectTaskExecution,
} from '../services/architectPlanService';

type TaskSource = 'architect' | 'fallback' | 'empty';

let appSyncUnsubscribe: (() => void) | null = null;

const normalizeBranchName = (value?: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const taskIncludesProjectId = (task: DerivedImplementTask, projectId: string | null | undefined): boolean => {
  if (!projectId) return false;
  return (
    task.project_id === projectId ||
    (task.project_ids || []).includes(projectId) ||
    (task.execution_targets || []).some((target) => target.projectId === projectId)
  );
};

const getExecutionTargets = (task: DerivedImplementTask): TaskExecutionTarget[] => {
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

const getPrimaryExecutionTarget = (task: DerivedImplementTask): TaskExecutionTarget | null => {
  return getExecutionTargets(task)[0] || null;
};

const ALLOWED_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  Pending: ['InProgress', 'Failed'],
  InProgress: ['AwaitingResponse', 'Failed', 'Completed'],
  AwaitingResponse: ['InProgress', 'Failed', 'Completed'],
  Completed: [],
  Failed: ['Pending', 'InProgress'],
  Blocked: ['Pending'],
};

const canTransitionTaskStatus = (from: TaskStatus, to: TaskStatus): boolean => {
  return ALLOWED_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
};

const tTask = (key: string, fallback: string, options?: Record<string, unknown>): string =>
  i18n.t(key, { defaultValue: fallback, ...(options || {}) });

const computeFallbackDerivedTasks = (tasks: Task[]): DerivedImplementTask[] => {
  const initial = tasks.map((task, index) => {
    const raw = task as Task & {
      assigned_branch?: string;
      branch_name?: string;
      branch_id?: string;
      branch_task_index?: number;
      sequence_index?: number;
      execution_targets?: TaskExecutionTarget[];
    };
    const assignedBranch = normalizeBranchName(raw.assigned_branch || raw.branch_name);
    const projectIds = Array.isArray(task.project_ids) && task.project_ids.length > 0
      ? task.project_ids
      : (task.project_id ? [task.project_id] : []);
    const executionTargets = raw.execution_targets && raw.execution_targets.length > 0
      ? raw.execution_targets
      : projectIds.map((projectId) => ({
          projectId,
          branchName: assignedBranch,
          worktreeKey: toBranchWorktreeKey(projectId, assignedBranch),
        }));

    return {
      ...task,
      project_ids: projectIds,
      assigned_branch: assignedBranch,
      branch_name: assignedBranch,
      branch_id: raw.branch_id || null,
      branch_task_index:
        typeof raw.branch_task_index === 'number' ? raw.branch_task_index : Number.MAX_SAFE_INTEGER,
      blocked_by_task_ids: [],
      blocked_by: [],
      is_blocked: false,
      is_ready: false,
      sequence_index: typeof raw.sequence_index === 'number' ? raw.sequence_index : index,
      execution_targets: executionTargets,
    } satisfies DerivedImplementTask;
  });

  const byId = new Map(initial.map((task) => [task.id, task]));
  return initial.map((task) => {
    const blockedByTaskIds = task.dependencies.filter((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency ? dependency.status !== 'Completed' : false;
    });
    const blockedBy = blockedByTaskIds
      .map((dependencyId) => byId.get(dependencyId)?.title)
      .filter((title): title is string => Boolean(title));

    let status = task.status;
    if (blockedByTaskIds.length > 0 && status === 'Pending') {
      status = 'Blocked';
    }
    if (blockedByTaskIds.length === 0 && status === 'Blocked') {
      status = 'Pending';
    }

    const isBlocked = blockedByTaskIds.length > 0;
    const isReady = !isBlocked && status !== 'Completed' && status !== 'Failed';
    return {
      ...task,
      status,
      blocked_by_task_ids: blockedByTaskIds,
      blocked_by: blockedBy,
      is_blocked: isBlocked,
      is_ready: isReady,
    };
  });
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
      const selectedTaskId = nextState.selectedTaskId;
      if (selectedTaskId) {
        const selectedTask = useTaskStore.getState().getTaskById(selectedTaskId);
        if (!selectedTask || !taskIncludesProjectId(selectedTask, nextState.selectedProjectId)) {
          useAppStore.getState().setSelectedTask(null);
          useTaskStore.setState({
            activeBranchName: null,
            activeRepositoryPath: nextState.selectedProjectId
              ? nextState.getProjectById(nextState.selectedProjectId)?.path ?? null
              : null,
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

const applyPredictedBranchLifecycle = (
  tasks: DerivedImplementTask[],
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

    if (nextStatus === 'InProgress' || nextStatus === 'AwaitingResponse') {
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
  tasks: DerivedImplementTask[];
  isLoading: boolean;
  lastError: string | null;
  source: TaskSource;
  branchWorktrees: Record<string, string>;
  activeBranchName: string | null;
  activeRepositoryPath: string | null;
  setTasks: (tasks: DerivedImplementTask[]) => void;
  initialize: () => Promise<void>;
  refreshFromPlan: () => Promise<void>;
  activateTask: (taskId: string) => Promise<void>;
  startTask: (taskId: string) => Promise<void>;
  completeTask: (taskId: string) => Promise<void>;
  markTaskAwaitingResponse: (taskId: string) => Promise<void>;
  markTaskFailed: (taskId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  setTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  getTaskById: (taskId: string) => DerivedImplementTask | undefined;
}

const persistTaskStatusToArchitectPlan = async (
  taskId: string,
  status: TaskStatus,
  setError: (message: string | null) => void
): Promise<void> => {
  const appState = useAppStore.getState();
  if (!appState.planNodes.some((node) => node.id === taskId)) {
    return;
  }

  const nextNodeStatus = mapTaskStatusToNodeStatus(status);
  const nextPlanNodes = appState.planNodes.map((node) =>
    node.id === taskId ? { ...node, status: nextNodeStatus } : node
  );

  const planId = appState.activeArchitectPlanId || appState.currentPlan?.id;
  if (!planId) {
    useAppStore.getState().setPlanNodes(nextPlanNodes);
    return;
  }

  const nextPredictedBranches = applyPredictedBranchLifecycle(useTaskStore.getState().tasks, appState.predictedBranches, taskId, status);
  const strategy = deriveImplementTasksFromStrategy({
    planId,
    nodes: nextPlanNodes,
    predictedBranches: nextPredictedBranches,
  });

  useAppStore.getState().setPlanNodes(strategy.nodes);
  useAppStore.getState().setPredictedBranches(strategy.predictedBranches);

  useTaskStore.setState({
    tasks: strategy.tasks,
    source: 'architect',
    lastError: null,
  });

  const activePlanContext = useAppStore.getState().activePlanContext;
  if (!activePlanContext?.targetBranch || !useAppStore.getState().activeArchitectPlanId) {
    return;
  }

  try {
    const targetBranch = resolveTargetBranch(activePlanContext.targetBranch);
    await updateArchitectPlan({
      branchName: targetBranch,
      planId: useAppStore.getState().activeArchitectPlanId!,
      nodes: strategy.nodes,
      predictedBranches: strategy.predictedBranches,
      setActive: false,
    });
  } catch (error) {
    const normalized = toServiceError(error);
    setError(normalized.message);
  }
};

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  isLoading: false,
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
    const appState = useAppStore.getState();
    const planId = appState.activeArchitectPlanId || appState.currentPlan?.id || 'active-plan';

    if (appState.planNodes.length > 0) {
      const strategy = deriveImplementTasksFromStrategy({
        planId,
        nodes: appState.planNodes,
        predictedBranches: appState.predictedBranches,
      });

      set({
        tasks: strategy.tasks,
        source: 'architect',
        isLoading: false,
        lastError: null,
      });

      const selectedProjectId = useAppStore.getState().selectedProjectId;
      const selectedTaskIdFromApp = useAppStore.getState().selectedTaskId;
      if (!selectedTaskIdFromApp && selectedProjectId) {
        try {
          const context = await getLocalProjectContextState(selectedProjectId);
          const candidateTaskId = context?.lastTaskId;
          if (candidateTaskId) {
            const candidateTask = strategy.tasks.find((task) => task.id === candidateTaskId);
            if (candidateTask && taskIncludesProjectId(candidateTask, selectedProjectId)) {
              useAppStore.getState().setSelectedTask(candidateTaskId);
            }
          }
        } catch {
          // Ignore context restore failures here and keep fallback behavior.
        }
      }

      if (
        JSON.stringify(strategy.nodes) !== JSON.stringify(appState.planNodes) ||
        JSON.stringify(strategy.predictedBranches) !== JSON.stringify(appState.predictedBranches)
      ) {
        useAppStore.getState().setPlanNodes(strategy.nodes);
        useAppStore.getState().setPredictedBranches(strategy.predictedBranches);

        const activePlanId = appState.activeArchitectPlanId;
        const targetBranchRaw = appState.activePlanContext?.targetBranch;
        if (activePlanId && targetBranchRaw) {
          try {
            const targetBranch = resolveTargetBranch(targetBranchRaw);
            await updateArchitectPlan({
              branchName: targetBranch,
              planId: activePlanId,
              nodes: strategy.nodes,
              predictedBranches: strategy.predictedBranches,
              setActive: false,
            });
          } catch (error) {
            const normalized = toServiceError(error);
            set({ lastError: normalized.message });
          }
        }
      }

      const selectedTaskAfterRestore = useAppStore.getState().selectedTaskId;
      if (selectedTaskAfterRestore) {
        void get().activateTask(selectedTaskAfterRestore);
      }
      return;
    }

    try {
      const { tasks } = await services.listTasks();
      const derived = computeFallbackDerivedTasks(tasks);
      set({
        tasks: derived,
        source: derived.length > 0 ? 'fallback' : 'empty',
        lastError: null,
        isLoading: false,
      });

      const selectedProjectId = useAppStore.getState().selectedProjectId;
      const selectedTaskIdFromApp = useAppStore.getState().selectedTaskId;
      if (!selectedTaskIdFromApp && selectedProjectId) {
        try {
          const context = await getLocalProjectContextState(selectedProjectId);
          const candidateTaskId = context?.lastTaskId;
          if (candidateTaskId) {
            const candidateTask = derived.find((task) => task.id === candidateTaskId);
            if (candidateTask && taskIncludesProjectId(candidateTask, selectedProjectId)) {
              useAppStore.getState().setSelectedTask(candidateTaskId);
            }
          }
        } catch {
          // Ignore context restore failures here and keep fallback behavior.
        }
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
    const primaryTarget = getPrimaryExecutionTarget(task);
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
      : null;

    set({
      activeBranchName: branchName,
      activeRepositoryPath: projectPath,
    });
    await syncWorkspaceRoot(projectPath);
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
    for (const target of executionTargets) {
      let worktreePath = get().branchWorktrees[target.worktreeKey] || null;
      if (!worktreePath) {
        worktreePath = await useGitStore.getState().createWorktree(target.projectId, target.worktreeKey, target.branchName);
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

    const primaryTarget = executionTargets[0];
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

  completeTask: async (taskId) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      set({ lastError: tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId }) });
      return;
    }

    if (task.status !== 'InProgress' && task.status !== 'AwaitingResponse') {
      set({
        lastError: tTask(
          'implement.errors.completeRequiresActiveStatus',
          'Task can only be completed from In Progress or Awaiting Response.'
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

    const repositories: Array<{
      projectId: string;
      repoPath: string;
      branchName: string;
      planBranchName: string;
      mergeOutput?: string;
    }> = [];

    if (tauriIpc.isTauriAvailable()) {
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

          const planBranchName = target.planBranchName || 'plan';
          const diff = await tauriIpc.gitDiff({
            repoPath,
            base: planBranchName,
            head: target.branchName,
            contextLines: 0,
          });
          if (!diff.trim()) {
            set({
              lastError: tTask(
                'implement.errors.noIntegratedChanges',
                'Cannot complete task because there are no branch changes to integrate into {{branchName}}.',
                { branchName: planBranchName }
              ),
            });
            return;
          }

          const mergeOutput = await mergeFeatureBranchIntoPlanBranch({
            projectId: target.projectId,
            branchName: target.branchName,
            planBranchName,
            repoPath,
          });
          repositories.push({
            projectId: target.projectId,
            repoPath,
            branchName: target.branchName,
            planBranchName,
            mergeOutput,
          });
        } catch (error) {
          const normalized = toServiceError(error);
          set({ lastError: normalized.message });
          return;
        }
      }
    }

    await get().setTaskStatus(taskId, 'Completed');

    const activePlanContext = appState.activePlanContext;
    const activePlanId = appState.activeArchitectPlanId || appState.currentPlan?.id;
    if (activePlanContext?.targetBranch && activePlanId) {
      try {
        await writeArchitectTaskExecution({
          branchName: resolveTargetBranch(activePlanContext.targetBranch),
          planId: activePlanId,
          execution: {
            taskId: task.id,
            title: task.title,
            completedAt: new Date().toISOString(),
            repositories,
          },
        });
      } catch (error) {
        const normalized = toServiceError(error);
        set({ lastError: normalized.message });
      }
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

    if (
      (status === 'InProgress' || status === 'AwaitingResponse' || status === 'Completed') &&
      currentTask.is_blocked
    ) {
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

    const fallbackTasks = get().source === 'fallback'
      ? computeFallbackDerivedTasks(
        get().tasks.map((task) =>
          task.id === taskId
            ? {
              ...task,
              status,
            }
            : task
        )
      )
      : null;

    if (fallbackTasks) {
      set({ tasks: fallbackTasks, lastError: null });
      return;
    }

    await persistTaskStatusToArchitectPlan(taskId, status, (message) => {
      set({ lastError: message });
    });
  },

  getTaskById: (taskId) => get().tasks.find((task) => task.id === taskId),
}));

export type { DerivedImplementTask as ImplementTask };
