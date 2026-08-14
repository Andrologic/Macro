import type { TaskStatus } from '../types';
import {
  taskMatchesProjectId,
  type CatalogedImplementTask,
} from './implementTaskCatalog';

const PLAN_ACTIVATION_TASK_STATUS_ORDER: Record<TaskStatus, number> = {
  InProgress: 0,
  AwaitingResponse: 1,
  InReview: 2,
  Pending: 3,
  Blocked: 4,
  Failed: 5,
  Completed: 6,
};

export const getPlanActivationCandidateTask = (
  tasks: CatalogedImplementTask[],
  planId: string,
  scopedProjectIds: string[] = [],
): CatalogedImplementTask | null => {
  const matchesScope = (task: CatalogedImplementTask): boolean =>
    scopedProjectIds.length === 0 ||
    scopedProjectIds.some((projectId) => taskMatchesProjectId(task, projectId));
  const isPlanActivationEligible = (task: CatalogedImplementTask): boolean =>
    task.plan_id === planId &&
    !task.draft &&
    !task.is_blocked &&
    task.status !== 'Completed' &&
    task.status !== 'InReview';
  const compareTasks = (left: CatalogedImplementTask, right: CatalogedImplementTask): number => {
    const byStatus =
      PLAN_ACTIVATION_TASK_STATUS_ORDER[left.status] -
      PLAN_ACTIVATION_TASK_STATUS_ORDER[right.status];
    if (byStatus !== 0) return byStatus;
    return left.sequence_index - right.sequence_index;
  };

  const scopedCandidates = tasks
    .filter((task) => isPlanActivationEligible(task) && matchesScope(task))
    .sort(compareTasks);
  if (scopedCandidates.length > 0) {
    return scopedCandidates[0] || null;
  }

  return tasks.filter(isPlanActivationEligible).sort(compareTasks)[0] || null;
};
