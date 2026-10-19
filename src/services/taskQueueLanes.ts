import type { TaskQueueStatusGroup } from './taskStatusPresentation';

export const TASK_QUEUE_LANES = ['ready', 'waiting', 'in_progress', 'completed'] as const;
export type TaskQueueLane = typeof TASK_QUEUE_LANES[number];
interface QueueTask { id: string; status: unknown; draft?: boolean; archived_at?: string | null }

/** A single presentation lane, without changing the engine's detailed status. */
export function taskQueueLane(task: QueueTask, group: TaskQueueStatusGroup | undefined): TaskQueueLane {
  if (group === 'in_progress') return 'in_progress';
  if (group === 'blocked' || group === 'failed' || group === 'waiting') return 'waiting';
  if (task.status === 'Completed') return 'completed';
  return group === 'ready' ? 'ready' : 'waiting';
}

export function groupTaskQueueLanes<T extends QueueTask>(tasks: readonly T[], groups: ReadonlyMap<string, TaskQueueStatusGroup>, includeArchived = false) {
  const lanes: Record<TaskQueueLane, T[]> = { ready: [], in_progress: [], waiting: [], completed: [] };
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.draft || (!includeArchived && task.archived_at) || seen.has(task.id)) continue;
    seen.add(task.id);
    lanes[taskQueueLane(task, groups.get(task.id))].push(task);
  }
  return lanes;
}
