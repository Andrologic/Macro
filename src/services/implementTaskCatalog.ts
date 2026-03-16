import type { Task, TaskExecutionTarget } from '../types';
import {
  deriveImplementTasksFromStrategy,
  toBranchWorktreeKey,
  type DerivedImplementTask,
} from './implementTaskDerivation';
import type { ArchitectPlanRecord, ArchitectPlanStatus } from './architectPlanService';

export type ImplementTaskSource = 'architect' | 'standalone';
export type ImplementTaskCatalogSource = 'architect' | 'mixed' | 'fallback' | 'empty';

export interface ImplementTaskPlanSummary {
  id: string;
  slug: string;
  title: string;
  label?: string;
  status: ArchitectPlanStatus;
  targetBranch: string;
  projectIds: string[];
  taskCount: number;
  completedTaskCount: number;
  activeTaskCount: number;
  inReviewTaskCount: number;
  readyForValidation: boolean;
}

export interface CatalogedImplementTask extends DerivedImplementTask {
  task_source: ImplementTaskSource;
  plan_title: string | null;
  plan_status: ArchitectPlanStatus | null;
  plan_target_branch: string | null;
}

export interface ImplementTaskCatalog {
  tasks: CatalogedImplementTask[];
  plans: ImplementTaskPlanSummary[];
  hasStandaloneTasks: boolean;
  source: ImplementTaskCatalogSource;
}

const normalizeBranchName = (value?: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const unique = (items: string[]): string[] => Array.from(new Set(items.filter((item) => item.trim().length > 0)));

const compareOptionalText = (left: string | null | undefined, right: string | null | undefined): number =>
  (left || '').localeCompare(right || '');

const normalizeProjectIds = (projectIds?: string[], projectId?: string): string[] =>
  unique([
    ...(Array.isArray(projectIds) ? projectIds : []).filter((value): value is string => typeof value === 'string'),
    ...(projectId ? [projectId] : []),
  ]);

const buildFallbackExecutionTargets = (
  projectIds: string[],
  branchName: string
): TaskExecutionTarget[] => {
  return projectIds.map((projectId) => ({
    projectId,
    branchName,
    worktreeKey: toBranchWorktreeKey(projectId, branchName),
  }));
};

export const isExecutableImplementPlanStatus = (
  status: ArchitectPlanStatus | string | null | undefined
): status is ArchitectPlanStatus => {
  return status === 'validated' || status === 'in_progress';
};

export const taskMatchesProjectId = (
  task: Pick<CatalogedImplementTask, 'project_id' | 'project_ids' | 'execution_targets'>,
  projectId: string | null | undefined
): boolean => {
  if (!projectId) return false;
  return (
    task.project_id === projectId ||
    (task.project_ids || []).includes(projectId) ||
    (task.execution_targets || []).some((target) => target.projectId === projectId)
  );
};

export const deriveFallbackImplementTasks = (tasks: Task[]): CatalogedImplementTask[] => {
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
    const projectIds = normalizeProjectIds(task.project_ids, task.project_id);
    const executionTargets = raw.execution_targets && raw.execution_targets.length > 0
      ? raw.execution_targets
      : buildFallbackExecutionTargets(projectIds, assignedBranch);

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
      task_source: 'standalone' as const,
      plan_title: null,
      plan_status: null,
      plan_target_branch: null,
    } satisfies CatalogedImplementTask;
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

export const deriveImplementTasksFromArchitectPlan = (
  plan: ArchitectPlanRecord
): CatalogedImplementTask[] => {
  const strategy = deriveImplementTasksFromStrategy({
    planId: plan.id,
    nodes: plan.nodes || [],
    predictedBranches: plan.predictedBranches || [],
  });

  return strategy.tasks.map((task) => ({
    ...task,
    task_source: 'architect' as const,
    plan_title: plan.title,
    plan_status: plan.status,
    plan_target_branch: plan.targetBranch,
  }));
};

const sortCatalogTasks = (tasks: CatalogedImplementTask[]): CatalogedImplementTask[] => {
  return [...tasks].sort((left, right) => {
    if (left.task_source !== right.task_source) {
      return left.task_source === 'architect' ? -1 : 1;
    }

    if (left.plan_id !== right.plan_id) {
      const planTitleDelta = compareOptionalText(left.plan_title, right.plan_title);
      if (planTitleDelta !== 0) {
        return planTitleDelta;
      }

      const planTargetBranchDelta = compareOptionalText(left.plan_target_branch, right.plan_target_branch);
      if (planTargetBranchDelta !== 0) {
        return planTargetBranchDelta;
      }

      const planIdDelta = compareOptionalText(left.plan_id, right.plan_id);
      if (planIdDelta !== 0) {
        return planIdDelta;
      }
    }

    const sequenceDelta = left.sequence_index - right.sequence_index;
    if (sequenceDelta !== 0) return sequenceDelta;

    const branchDelta = left.branch_task_index - right.branch_task_index;
    if (branchDelta !== 0) return branchDelta;

    return left.title.localeCompare(right.title);
  });
};

export const buildImplementTaskCatalog = (params: {
  plans: ArchitectPlanRecord[];
  fallbackTasks: Task[];
}): ImplementTaskCatalog => {
  const executablePlans = params.plans.filter((plan) => isExecutableImplementPlanStatus(plan.status));
  const architectTasks = executablePlans.flatMap((plan) => deriveImplementTasksFromArchitectPlan(plan));
  const architectTaskIds = new Set(architectTasks.map((task) => task.id));
  const allKnownPlanIds = new Set(params.plans.map((plan) => plan.id));

  const standaloneFallbackTasks = params.fallbackTasks.filter((task) => {
    if (architectTaskIds.has(task.id)) return false;
    const planId = typeof task.plan_id === 'string' ? task.plan_id.trim() : '';
    if (!planId) return true;
    return !allKnownPlanIds.has(planId);
  });
  const standaloneTasks = deriveFallbackImplementTasks(standaloneFallbackTasks);

  const planTaskCounts = new Map<string, number>();
  architectTasks.forEach((task) => {
    planTaskCounts.set(task.plan_id, (planTaskCounts.get(task.plan_id) || 0) + 1);
  });

  const plans = executablePlans
    .map((plan) => {
      const planTasks = architectTasks.filter((task) => task.plan_id === plan.id);
      const taskCount = planTaskCounts.get(plan.id) || 0;
      const completedTaskCount = planTasks.filter((task) => task.status === 'Completed').length;
      const activeTaskCount = planTasks.filter(
        (task) => task.status === 'InProgress' || task.status === 'AwaitingResponse'
      ).length;
      const inReviewTaskCount = planTasks.filter((task) => task.status === 'InReview').length;

      return {
        id: plan.id,
        slug: plan.slug,
        title: plan.title,
        label: plan.label,
        status: plan.status,
        targetBranch: plan.targetBranch,
        projectIds: unique(
          [
            ...(Array.isArray(plan.projectIds) ? plan.projectIds : []),
            ...(plan.projectId ? [plan.projectId] : []),
          ].filter((value): value is string => typeof value === 'string')
        ),
        taskCount,
        completedTaskCount,
        activeTaskCount,
        inReviewTaskCount,
        readyForValidation: taskCount > 0 && completedTaskCount === taskCount,
      };
    })
    .filter((plan) => plan.taskCount > 0)
    .sort((left, right) => {
      const titleDelta = left.title.localeCompare(right.title);
      if (titleDelta !== 0) return titleDelta;

      const targetBranchDelta = left.targetBranch.localeCompare(right.targetBranch);
      if (targetBranchDelta !== 0) return targetBranchDelta;

      return left.id.localeCompare(right.id);
    });

  const tasks = sortCatalogTasks([...architectTasks, ...standaloneTasks]);
  let source: ImplementTaskCatalogSource = 'empty';
  if (architectTasks.length > 0 && standaloneTasks.length > 0) {
    source = 'mixed';
  } else if (architectTasks.length > 0) {
    source = 'architect';
  } else if (standaloneTasks.length > 0) {
    source = 'fallback';
  }

  return {
    tasks,
    plans,
    hasStandaloneTasks: standaloneTasks.length > 0,
    source,
  };
};
