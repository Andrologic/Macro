import type { GlobalProject, Project, ProjectGroup } from '../types';
import type { LocalProjectContextState } from './localProjectContext';

export const toGlobalProject = (group: ProjectGroup): GlobalProject => ({
  groupId: group.id,
  name: group.name,
  subProjects: group.projects,
  subProjectIds: group.projects.map((project) => project.id),
  primarySubProjectId: group.projects[0]?.id ?? null,
});

export const getGlobalProjectById = (
  groups: ProjectGroup[],
  groupId: string | null | undefined
): GlobalProject | null => {
  if (!groupId) return null;
  const group = groups.find((candidate) => candidate.id === groupId);
  return group ? toGlobalProject(group) : null;
};

export const getProjectGroupByProjectId = (
  groups: ProjectGroup[],
  projectId: string | null | undefined
): ProjectGroup | null => {
  if (!projectId) return null;
  return groups.find((group) => group.projects.some((project) => project.id === projectId)) ?? null;
};

export const getSubProjectsForGroup = (groups: ProjectGroup[], groupId: string | null | undefined): Project[] => {
  return getGlobalProjectById(groups, groupId)?.subProjects ?? [];
};

export const getPrimarySubProjectForGroup = (
  groups: ProjectGroup[],
  groupId: string | null | undefined
): Project | null => {
  return getSubProjectsForGroup(groups, groupId)[0] ?? null;
};

export const getFocusedProjectIdForGroup = (
  groups: ProjectGroup[],
  groupId: string | null | undefined,
  selectedProjectId?: string | null,
  localContext?: Pick<LocalProjectContextState, 'focusProjectId'> | null
): string | null => {
  const subProjects = getSubProjectsForGroup(groups, groupId);
  if (subProjects.length === 0) {
    return selectedProjectId ?? localContext?.focusProjectId ?? null;
  }

  const subProjectIds = new Set(subProjects.map((project) => project.id));
  if (selectedProjectId && subProjectIds.has(selectedProjectId)) {
    return selectedProjectId;
  }

  const focusedProjectId = localContext?.focusProjectId ?? null;
  if (focusedProjectId && subProjectIds.has(focusedProjectId)) {
    return focusedProjectId;
  }

  return subProjects[0]?.id ?? null;
};

export const getFocusedProjectForGroup = (
  groups: ProjectGroup[],
  groupId: string | null | undefined,
  selectedProjectId?: string | null,
  localContext?: Pick<LocalProjectContextState, 'focusProjectId'> | null
): Project | null => {
  const focusedProjectId = getFocusedProjectIdForGroup(
    groups,
    groupId,
    selectedProjectId,
    localContext
  );
  if (!focusedProjectId) return null;

  return (
    getSubProjectsForGroup(groups, groupId).find((project) => project.id === focusedProjectId) ??
    null
  );
};

export const getScopedProjectIds = (
  groups: ProjectGroup[],
  groupId: string | null | undefined,
  projectId: string | null | undefined
): string[] => {
  const groupProjectIds = getSubProjectsForGroup(groups, groupId).map((project) => project.id);
  if (groupProjectIds.length > 0) {
    return groupProjectIds;
  }

  if (projectId) {
    return [projectId];
  }

  return [];
};
