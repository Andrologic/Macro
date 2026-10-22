import type { TaskStatus } from '../types';
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
  workflow_execution?: { interactionRequired: boolean; stale?: boolean };
}
interface VisibilityOptions {
  showBlockedTasks: boolean;
  showWithoutInteraction: boolean;
  showArchived: boolean;
  runningTaskIds: ReadonlySet<string>;
  attentionByTaskId: ReadonlyMap<string, unknown>;
  mergeWorkflowRuntimeByTaskId: Readonly<Record<string, MergeWorkflowRuntimeState | undefined>>;
}

/** Display filters never change task execution state. Action requests take precedence. */
export function visibleTaskQueueTasks<T extends QueueTask>(tasks: readonly T[], options: VisibilityOptions): T[] {
  const uniqueTasks = [...new Map(tasks.map(task => [task.id, task])).values()];
  return uniqueTasks.filter(task => {
    if (task.archived_at) return options.showArchived;
    if (task.workflow_execution) {
      if (task.workflow_execution.stale || task.workflow_execution.interactionRequired) return true;
      if (task.is_blocked || task.status === 'Blocked') return options.showBlockedTasks;
      return options.showWithoutInteraction;
    }
    if (task.draft || task.needs_revalidation || task.status === 'Failed' || options.attentionByTaskId.has(task.id)) return true;
    const merge = resolveTaskMergeWorkflowPresentationState(options.mergeWorkflowRuntimeByTaskId[task.id], task.merge_workflow_summary, task.status);
    if (merge && ['blocked', 'failed', 'partial'].includes(merge.phase)) return true;
    if (!options.runningTaskIds.has(task.id) && (task.is_blocked || task.status === 'Blocked')) return options.showBlockedTasks;
    if (!options.runningTaskIds.has(task.id) && ['Pending', 'AwaitingResponse'].includes(task.status)) return true;
    return options.showWithoutInteraction;
  });
}
