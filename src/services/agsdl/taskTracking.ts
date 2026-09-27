import type { CatalogedImplementTask } from "../implementTaskCatalog";
import type { AgsdlTarget } from "../../stores/useAgsdlStore";
import { object, text } from "./document";
import type { ViewerCard } from "./viewer";
import { resolveTaskStatusIndicatorState, type TaskStatusIndicatorState } from "../taskStatusPresentation";
import { resolveTaskMergeWorkflowPresentationState } from "../taskMergeWorkflowPresentation";

export interface TrackedTask { taskId: string; title: string; state: TaskStatusIndicatorState }
export function trackCardTasks(cards: ViewerCard[], target: AgsdlTarget, tasks: CatalogedImplementTask[], running: Set<string>, runtime: Record<string, Parameters<typeof resolveTaskMergeWorkflowPresentationState>[0]>): Record<string, TrackedTask> {
  const scoped = tasks.filter(task => task.plan_id === target.planId && (task.plan_storage_branch || task.plan_target_branch) === target.branchName && !task.archived_at);
  const result: Record<string, TrackedTask> = {};
  for (const card of cards) {
    const taskId = text(object(card.details.displayAnnotations ?? card.details.annotations).macroTaskId);
    // Never infer identity from a display title or a graph step's position.
    const matches = taskId ? scoped.filter(task => task.id === taskId)
      : card.path.startsWith('/legacy/') ? scoped.filter(task => task.node_id === card.id) : [];
    if (matches.length !== 1) continue;
    const task = matches[0];
    const merge = resolveTaskMergeWorkflowPresentationState(runtime[task.id] ?? null, task.merge_workflow_summary ?? null, task.status);
    result[card.path] = { taskId: task.id, title: task.title, state: resolveTaskStatusIndicatorState(task.status, running.has(task.id), task.task_source, merge, task.is_blocked) };
  }
  return result;
}

/** Show the state needing most attention when several tracked cards are folded. */
export function groupTaskState(tasks: TrackedTask[], totalMembers = tasks.length): TrackedTask | undefined {
  const order: TaskStatusIndicatorState[] = ['awaiting_response', 'failed', 'merge_failed', 'blocked', 'merge_blocked', 'merge_partial', 'running', 'merging', 'in_review', 'plan_finalization', 'idle_prompt', 'completed'];
  const state = tasks.reduce<TrackedTask | undefined>((chosen, task) => !chosen || order.indexOf(task.state) < order.indexOf(chosen.state) ? task : chosen, undefined);
  return state?.state === "completed" && tasks.length < totalMembers ? undefined : state;
}
