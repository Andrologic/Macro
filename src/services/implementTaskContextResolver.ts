import type { Project, ProjectGroup } from '../types';
import type { LocalProjectContextState } from './localProjectContext';
import { resolveTaskReference, taskReferenceMatches } from './durableIdentity';
import { getScopedProjectIds } from './globalProjects';
import {
  taskMatchesProjectId,
  type CatalogedImplementTask as ImplementTask,
} from './implementTaskCatalog';
import { retargetTaskForProjectSelection } from './projectIdentityReconciliation';

interface ResolveImplementTaskForContextInput {
  selectedTaskId?: string | null;
  tasks: ImplementTask[];
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  localContext?: LocalProjectContextState | null;
}

interface ImplementTaskProjectSelection {
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
}

const IMPLEMENT_CONTEXT_TASK_STATUS_ORDER: Record<string, number> = {
  InProgress: 0,
  AwaitingResponse: 1,
  Pending: 2,
};

const taskMatchesScopedProjectIds = (
  task: Pick<ImplementTask, 'project_id' | 'project_ids' | 'execution_targets'>,
  scopedProjectIds: string[],
): boolean =>
  scopedProjectIds.length === 0 ||
  scopedProjectIds.some((projectId) => taskMatchesProjectId(task, projectId));

export const retargetImplementTaskForSelection = (
  task: ImplementTask,
  params: ImplementTaskProjectSelection,
): ImplementTask => {
  const knownProjectIds = new Set([
    ...(params.standaloneProjects ?? []).map((project) => project.id),
    ...params.projectGroups.flatMap((group) => group.projects.map((project) => project.id)),
  ]);
  const taskProjectIds = [...(task.project_ids ?? []), task.project_id].filter(Boolean);
  if (taskProjectIds.some((projectId) => knownProjectIds.has(projectId))) {
    return task;
  }
  return retargetTaskForProjectSelection(task, {
    standaloneProjects: params.standaloneProjects ?? [],
    projectGroups: params.projectGroups,
    selectedGroupId: params.selectedGroupId,
    selectedProjectId: params.selectedProjectId,
  });
};

export const resolveImplementTaskForContext = ({
  selectedTaskId,
  tasks,
  standaloneProjects,
  projectGroups,
  selectedGroupId,
  selectedProjectId,
  localContext,
}: ResolveImplementTaskForContextInput): ImplementTask | null => {
  const selectedTask = selectedTaskId
    ? tasks.find((task) => task.id === selectedTaskId) ?? null
    : null;
  if (selectedTask) return selectedTask;
  const scopedProjectIds = getScopedProjectIds(
    {
      standaloneProjects: standaloneProjects ?? [],
      projectGroups,
    },
    selectedGroupId,
    selectedProjectId,
  );
  const eligibleTasks = tasks.filter((task) => {
    if (task.archived_at) return task.id === selectedTaskId;
    if (task.id === selectedTaskId) return true;
    if (taskMatchesScopedProjectIds(task, scopedProjectIds)) {
      return true;
    }
    if (task.task_source !== 'standalone' && !taskReferenceMatches(tasks, task, selectedTaskId)) {
      return false;
    }
    const executionTask = retargetImplementTaskForSelection(task, {
      standaloneProjects,
      projectGroups,
      selectedGroupId,
      selectedProjectId,
    });
    return taskMatchesScopedProjectIds(executionTask, scopedProjectIds);
  });
  const findEligibleTask = (taskId?: string | null): ImplementTask | null =>
    taskId
      ? resolveTaskReference(eligibleTasks, taskId) ?? null
      : null;

  return (
    findEligibleTask(selectedTaskId) ||
    findEligibleTask(localContext?.lastTaskId) ||
    [...eligibleTasks].sort((left, right) => {
      const leftOrder =
        IMPLEMENT_CONTEXT_TASK_STATUS_ORDER[left.status] ??
        Number.MAX_SAFE_INTEGER;
      const rightOrder =
        IMPLEMENT_CONTEXT_TASK_STATUS_ORDER[right.status] ??
        Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return (left.sequence_index ?? 0) - (right.sequence_index ?? 0);
    })[0] ||
    null
  );
};
