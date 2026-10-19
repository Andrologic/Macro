import type { TaskStatus } from '../types';
import { resolveTaskReference } from './durableIdentity';
import type { MergeWorkflowRuntimeState } from './mergeWorkflow';
import type { MergeWorkflowSummary } from './mergeWorkflowPersistence';
import { resolveTaskMergeWorkflowPresentationState } from './taskMergeWorkflowPresentation';

interface QueueTask {
  id: string;
  node_id?: string | null;
  status: TaskStatus;
  is_blocked?: boolean;
  blocked_by_task_ids?: readonly string[];
  needs_revalidation?: boolean;
  draft?: boolean;
  archived_at?: string | null;
  merge_workflow_summary?: MergeWorkflowSummary | null;
}
interface VisibilityOptions {
  showAllTasks: boolean;
  showArchived: boolean;
  runningTaskIds: ReadonlySet<string>;
  attentionByTaskId: ReadonlyMap<string, unknown>;
  mergeWorkflowRuntimeByTaskId: Readonly<Record<string, MergeWorkflowRuntimeState | undefined>>;
}

/** Hide only passive dependency waits. Keep unresolved or actionable blockers visible. */
export function visibleTaskQueueTasks<T extends QueueTask>(tasks: readonly T[], options: VisibilityOptions): T[] {
  const uniqueTasks = [...new Map(tasks.map(task => [task.id, task])).values()];
  if (options.showAllTasks || options.showArchived) return uniqueTasks;
  return uniqueTasks.filter(task => {
    if (task.draft || task.archived_at || !task.is_blocked || task.needs_revalidation ||
      !['Pending', 'Blocked'].includes(task.status) || options.runningTaskIds.has(task.id) || options.attentionByTaskId.has(task.id)) return true;
    const merge = resolveTaskMergeWorkflowPresentationState(options.mergeWorkflowRuntimeByTaskId[task.id], task.merge_workflow_summary, task.status);
    if (merge && merge.phase !== 'ready') return true;
    const blockers = task.blocked_by_task_ids ?? [];
    // An unknown, stale or missing prerequisite needs inspection, not concealment.
    return !blockers.length || !blockers.every(reference => {
      const prerequisite = resolveTaskReference(uniqueTasks, reference);
      return prerequisite && prerequisite.id !== task.id && !prerequisite.archived_at && prerequisite.status !== 'Completed';
    });
  });
}
