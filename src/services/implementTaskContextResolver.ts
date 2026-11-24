import type { Project, ProjectGroup } from '../types';
import { resolveTaskReference } from './durableIdentity';
import type { CatalogedImplementTask as ImplementTask } from './implementTaskCatalog';
import { retargetTaskForProjectSelection } from './projectIdentityReconciliation';

interface ImplementTaskProjectSelection {
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
}

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
}: {
  selectedTaskId?: string | null;
  tasks: ImplementTask[];
}): ImplementTask | null =>
  selectedTaskId ? resolveTaskReference(tasks, selectedTaskId) ?? null : null;
