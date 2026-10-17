import type { TaskStatus } from '../types';

interface HierarchyTask { id: string; parent_task_id?: string | null; }
export function taskHierarchy<T extends HierarchyTask>(tasks: readonly T[]) {
  const unique = [...new Map(tasks.map(task => [task.id, task])).values()];
  const byId = new Map(unique.map(task => [task.id, task]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const task of unique) {
    const visited = new Set([task.id]);
    let parent = byId.get(task.parent_task_id ?? '');
    let cyclic = false;
    while (parent) {
      if (visited.has(parent.id)) { cyclic = true; break; }
      visited.add(parent.id);
      parent = byId.get(parent.parent_task_id ?? '');
    }
    if (!cyclic && task.parent_task_id && byId.has(task.parent_task_id)) {
      children.set(task.parent_task_id, [...(children.get(task.parent_task_id) ?? []), task]);
    } else roots.push(task);
  }
  return { roots, children };
}

export function workflowStatus(tasks: readonly { status: TaskStatus }[]): TaskStatus {
  if (tasks.length && tasks.every(task => task.status === 'Completed')) return 'Completed';
  if (tasks.some(task => task.status === 'InProgress' || task.status === 'InReview')) return 'InProgress';
  if (tasks.some(task => task.status === 'AwaitingResponse')) return 'AwaitingResponse';
  if (tasks.some(task => task.status === 'Failed')) return 'Failed';
  if (tasks.some(task => task.status === 'Blocked')) return 'Blocked';
  return 'Pending';
}
