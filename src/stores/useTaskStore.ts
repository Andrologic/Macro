import { create } from 'zustand';
import type { Task, TaskStatus } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import { useAppStore } from './useAppStore';
import { useGitStore } from './useGitStore';
import * as tauriIpc from '../services/tauriIpc';
import {
  deriveImplementTasksFromStrategy,
  mapTaskStatusToNodeStatus,
  toBranchWorktreeKey,
  type DerivedImplementTask,
} from '../services/implementTaskDerivation';
import { resolveTargetBranch, updateArchitectPlan } from '../services/architectPlanService';

type TaskSource = 'architect' | 'fallback' | 'empty';

let appSyncUnsubscribe: (() => void) | null = null;

const normalizeBranchName = (value?: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const computeFallbackDerivedTasks = (tasks: Task[]): DerivedImplementTask[] => {
  const initial = tasks.map((task, index) => {
    const raw = task as Task & {
      assigned_branch?: string;
      branch_name?: string;
      branch_id?: string;
      branch_task_index?: number;
      sequence_index?: number;
    };
    const assignedBranch = normalizeBranchName(raw.assigned_branch || raw.branch_name);

    return {
      ...task,
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

    if (nextState.selectedTaskId !== previousState.selectedTaskId && nextState.selectedTaskId) {
      void useTaskStore.getState().activateTask(nextState.selectedTaskId);
    }
  });
};

const syncWorkspaceRoot = async (path: string | null): Promise<void> => {
  if (!path || !tauriIpc.isTauriAvailable()) return;

  try {
    await tauriIpc.workspaceSetActiveRoot(path);
  } catch {
    // Keep UI responsive even if workspace root sync fails.
  }
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

  const strategy = deriveImplementTasksFromStrategy({
    planId,
    nodes: nextPlanNodes,
    predictedBranches: appState.predictedBranches,
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

      const selectedTaskId = useAppStore.getState().selectedTaskId;
      if (selectedTaskId) {
        void get().activateTask(selectedTaskId);
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
    const knownWorktree = get().branchWorktrees[branchName];
    if (knownWorktree) {
      set({
        activeBranchName: branchName,
        activeRepositoryPath: knownWorktree,
      });
      await syncWorkspaceRoot(knownWorktree);
      return;
    }

    const projectPath = task.project_id
      ? appState.getProjectById(task.project_id)?.path ?? null
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
      set({ lastError: `Unknown task: ${taskId}` });
      return;
    }

    if (task.is_blocked) {
      const reason = task.blocked_by.length > 0 ? task.blocked_by.join(', ') : 'dependency chain';
      set({ lastError: `Task is blocked by unresolved dependencies: ${reason}` });
      return;
    }

    const appState = useAppStore.getState();
    if (appState.selectedTaskId !== task.id) {
      appState.setSelectedTask(task.id);
    }

    const branchName = task.assigned_branch;
    const projectId = task.project_id || appState.selectedProjectId;
    if (!projectId) {
      set({ lastError: `Cannot resolve project for task ${task.id}` });
      return;
    }

    let worktreePath = get().branchWorktrees[branchName] || null;
    if (!worktreePath) {
      const technicalTaskId = toBranchWorktreeKey(branchName);
      worktreePath = await useGitStore.getState().createWorktree(projectId, technicalTaskId, branchName);
      if (!worktreePath) {
        set({ lastError: `Failed to create or reuse worktree for branch ${branchName}` });
        return;
      }
    }

    set((state) => ({
      branchWorktrees: {
        ...state.branchWorktrees,
        [branchName]: worktreePath!,
      },
      activeBranchName: branchName,
      activeRepositoryPath: worktreePath,
      lastError: null,
    }));

    await syncWorkspaceRoot(worktreePath);
    await get().setTaskStatus(task.id, 'InProgress');
  },

  completeTask: async (taskId) => {
    await get().setTaskStatus(taskId, 'Completed');
  },

  setTaskStatus: async (taskId, status) => {
    set({ lastError: null });

    const currentTask = get().tasks.find((task) => task.id === taskId);
    if (!currentTask) {
      set({ lastError: `Unknown task: ${taskId}` });
      return;
    }

    if (currentTask.status === status) {
      return;
    }

    if (status === 'InProgress' && currentTask.is_blocked) {
      const reason = currentTask.blocked_by.join(', ');
      set({ lastError: `Task is blocked by unresolved dependencies: ${reason}` });
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
