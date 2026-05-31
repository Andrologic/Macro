import type { GlobalProject, Project, ProjectGroup, ProjectRegistry } from '../types';
import type { LocalProjectContextState } from './localProjectContext';

export const isProjectReadOnly = (project: Pick<Project, 'isReadOnly'> | null | undefined): boolean =>
  Boolean(project?.isReadOnly);

export const isProjectActionable = (project: Pick<Project, 'isReadOnly'> | null | undefined): boolean =>
  Boolean(project) && !project?.isReadOnly;

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

export const getAllProjects = (
  projectGroups: ProjectGroup[] | ProjectRegistry,
  standaloneProjects: Project[] = []
): Project[] => {
  if (Array.isArray(projectGroups)) {
    return [...standaloneProjects, ...projectGroups.flatMap((group) => group.projects)];
  }
  return [
    ...(projectGroups.standaloneProjects ?? []),
    ...(projectGroups.projectGroups ?? []).flatMap((group) => group.projects),
  ];
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

export const resolveExplicitProjectIdForGroup = (
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

  return null;
};

export const getFocusedProjectIdForGroup = (
  groups: ProjectGroup[],
  groupId: string | null | undefined,
  selectedProjectId?: string | null,
  localContext?: Pick<LocalProjectContextState, 'focusProjectId'> | null
): string | null => {
  const explicitProjectId = resolveExplicitProjectIdForGroup(
    groups,
    groupId,
    selectedProjectId,
    localContext
  );
  if (explicitProjectId) {
    return explicitProjectId;
  }

  return getSubProjectsForGroup(groups, groupId)[0]?.id ?? null;
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
  groups: ProjectGroup[] | ProjectRegistry,
  groupId: string | null | undefined,
  projectId: string | null | undefined
): string[] => {
  const projectGroups = Array.isArray(groups) ? groups : groups.projectGroups;
  const groupProjectIds = getSubProjectsForGroup(projectGroups, groupId).map((project) => project.id);
  if (groupProjectIds.length > 0) {
    return groupProjectIds;
  }

  if (projectId) {
    return [projectId];
  }

  return [];
};

export const getRepositoryScopedProjectIds = (
  groups: ProjectGroup[] | ProjectRegistry,
  groupId: string | null | undefined,
  projectId: string | null | undefined
): string[] => {
  const projectGroups = Array.isArray(groups) ? groups : groups.projectGroups;
  const groupProjects = getSubProjectsForGroup(projectGroups, groupId);
  if (groupProjects.length > 0) {
    const groupProjectIds = new Set(groupProjects.map((project) => project.id));
    if (projectId && groupProjectIds.has(projectId)) {
      return [projectId];
    }

    return groupProjects.map((project) => project.id);
  }

  if (projectId) {
    return [projectId];
  }

  return [];
};

export const getScopedActionableProjectIds = (
  groups: ProjectGroup[] | ProjectRegistry,
  groupId: string | null | undefined,
  projectId: string | null | undefined
): string[] =>
  getScopedProjectIds(groups, groupId, projectId).filter((scopedProjectId) =>
    getAllProjects(groups)
      .some((project) => project.id === scopedProjectId && isProjectActionable(project))
  );

export const getScopedReadOnlyProjectIds = (
  groups: ProjectGroup[] | ProjectRegistry,
  groupId: string | null | undefined,
  projectId: string | null | undefined
): string[] =>
  getScopedProjectIds(groups, groupId, projectId).filter((scopedProjectId) =>
    getAllProjects(groups)
      .some((project) => project.id === scopedProjectId && isProjectReadOnly(project))
  );
