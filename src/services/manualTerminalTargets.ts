import type { Project, ProjectGroup, Task, TaskExecutionTarget } from '../types';
import { getProjectGroupByProjectId, getSubProjectsForGroup } from './globalProjects';
import { isManualDraftPendingInitialization } from './manualDraftInitialization';

export type LastManualProjectIdByTaskId = Record<string, string>;

export interface TerminalTaskScope {
  taskId: string;
  groupId: string | null;
  projectId: string;
  preferredProjectId: string;
  scopedProjectIds: string[];
  projects: Project[];
}

type TaskWithTargets = Task & { execution_targets?: TaskExecutionTarget[] };

interface ResolvePreferredManualProjectIdParams {
  taskId: string | null | undefined;
  selectedProjectId: string | null | undefined;
  projects: Project[];
  lastManualProjectIdByTaskId: LastManualProjectIdByTaskId | null | undefined;
}

interface ResolveTerminalGroupIdParams {
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null | undefined;
  selectedProjectId: string | null | undefined;
  selectedTask: TaskWithTargets | null | undefined;
}

interface ResolveSelectedTaskTerminalScopeParams extends ResolveTerminalGroupIdParams {
  lastManualProjectIdByTaskId: LastManualProjectIdByTaskId | null | undefined;
}

const uniqueProjectIds = (values: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    if (typeof value !== 'string') {
      return;
    }

    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    result.push(normalized);
  });

  return result;
};

export const getTaskProjectIds = (task: TaskWithTargets | null | undefined): string[] =>
  uniqueProjectIds([
    ...(task?.execution_targets?.map((target) => target.projectId) ?? []),
    ...(task?.project_ids ?? []),
    task?.project_id ?? null,
  ]);

export const resolvePreferredManualProjectId = (
  params: ResolvePreferredManualProjectIdParams
): string | null => {
  const actionableProjects = params.projects.filter((project) => !project.isReadOnly);
  const candidateProjects = actionableProjects.length > 0 ? actionableProjects : params.projects;

  if (candidateProjects.length === 0) {
    return null;
  }

  const projectIdSet = new Set(candidateProjects.map((project) => project.id));
  const rememberedProjectId =
    params.taskId && params.lastManualProjectIdByTaskId
      ? params.lastManualProjectIdByTaskId[params.taskId] ?? null
      : null;

  if (rememberedProjectId && projectIdSet.has(rememberedProjectId)) {
    return rememberedProjectId;
  }

  if (params.selectedProjectId && projectIdSet.has(params.selectedProjectId)) {
    return params.selectedProjectId;
  }

  return candidateProjects[0]?.id ?? null;
};

export const resolveTerminalGroupId = (
  params: ResolveTerminalGroupIdParams
): string | null => {
  const taskProjectIds = getTaskProjectIds(params.selectedTask);

  if (params.selectedGroupId) {
    const selectedGroupProjectIds = new Set(
      getSubProjectsForGroup(params.projectGroups, params.selectedGroupId).map((project) => project.id)
    );

    if (
      taskProjectIds.length === 0 ||
      taskProjectIds.some((projectId) => selectedGroupProjectIds.has(projectId))
    ) {
      return params.selectedGroupId;
    }
  }

  const candidateProjectId = params.selectedProjectId || taskProjectIds[0] || null;
  if (!candidateProjectId) {
    return null;
  }

  return getProjectGroupByProjectId(params.projectGroups, candidateProjectId)?.id ?? null;
};

export const resolveSelectedTaskTerminalScope = (
  params: ResolveSelectedTaskTerminalScopeParams
): TerminalTaskScope | null => {
  if (isManualDraftPendingInitialization(params.selectedTask)) {
    return null;
  }

  const taskId = params.selectedTask?.id?.trim();
  if (!taskId) {
    return null;
  }

  const taskProjectIds = getTaskProjectIds(params.selectedTask);
  if (taskProjectIds.length === 0) {
    return null;
  }

  const groupId = resolveTerminalGroupId(params);
  const groupProjects = getSubProjectsForGroup(params.projectGroups, groupId);
  const allowedProjectIds = new Set(taskProjectIds);
  const scopedProjects =
    groupProjects.length > 0
      ? groupProjects.filter((project) => allowedProjectIds.has(project.id))
      : params.projectGroups
          .flatMap((group) => group.projects)
          .filter((project) => allowedProjectIds.has(project.id));
  const actionableScopedProjects = scopedProjects.filter((project) => !project.isReadOnly);
  const terminalProjects =
    actionableScopedProjects.length > 0 ? actionableScopedProjects : scopedProjects;

  if (terminalProjects.length === 0) {
    return null;
  }

  const scopedProjectIds = terminalProjects.map((project) => project.id);
  const scopedProjectIdSet = new Set(scopedProjectIds);
  const preferredProjectId =
    resolvePreferredManualProjectId({
      taskId,
      selectedProjectId: params.selectedProjectId,
      projects: terminalProjects,
      lastManualProjectIdByTaskId: params.lastManualProjectIdByTaskId,
    }) ?? terminalProjects[0]?.id;

  const visibleProjectId =
    params.selectedProjectId && scopedProjectIdSet.has(params.selectedProjectId)
      ? params.selectedProjectId
      : terminalProjects[0]?.id;

  if (!preferredProjectId || !visibleProjectId) {
    return null;
  }

  return {
    taskId,
    groupId,
    projectId: visibleProjectId,
    preferredProjectId,
    scopedProjectIds,
    projects: terminalProjects,
  };
};

export const getTerminalScopeKey = (taskId: string, projectId: string): string =>
  `${taskId}::${projectId}`;
