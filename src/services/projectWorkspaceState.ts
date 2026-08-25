import type { Project, ProjectGroup, ProjectRegistry } from '../types';
import {
  getScopedActionableProjectIds,
  getScopedProjectIds,
  getScopedReadOnlyProjectIds,
} from './globalProjects';

export type ProjectWorkspaceStateKind =
  | 'noProjectAvailable'
  | 'noProjectSelected'
  | 'readOnlyOnly'
  | 'ready';

export type MissingProjectWorkspaceStateKind = Extract<
  ProjectWorkspaceStateKind,
  'noProjectAvailable' | 'noProjectSelected'
>;

export interface ProjectWorkspaceState {
  kind: ProjectWorkspaceStateKind;
  hasProjects: boolean;
  scopedProjectIds: string[];
  actionableProjectIds: string[];
  readOnlyProjectIds: string[];
}

export const resolveProjectWorkspaceState = (params: {
  projectGroups: ProjectGroup[];
  standaloneProjects?: Project[];
  selectedGroupId: string | null | undefined;
  selectedProjectId: string | null | undefined;
}): ProjectWorkspaceState => {
  const registry: ProjectRegistry = {
    standaloneProjects: params.standaloneProjects ?? [],
    projectGroups: params.projectGroups,
  };
  const hasProjects =
    registry.standaloneProjects.length > 0 ||
    registry.projectGroups.some((group) => group.projects.length > 0);
  const knownProjectIds = new Set([
    ...registry.standaloneProjects.map((project) => project.id),
    ...registry.projectGroups.flatMap((group) => group.projects.map((project) => project.id)),
  ]);
  const scopedProjectIds = getScopedProjectIds(
    registry,
    params.selectedGroupId,
    params.selectedProjectId
  ).filter((projectId) => knownProjectIds.has(projectId));
  const actionableProjectIds = getScopedActionableProjectIds(
    registry,
    params.selectedGroupId,
    params.selectedProjectId
  ).filter((projectId) => knownProjectIds.has(projectId));
  const readOnlyProjectIds = getScopedReadOnlyProjectIds(
    registry,
    params.selectedGroupId,
    params.selectedProjectId
  ).filter((projectId) => knownProjectIds.has(projectId));

  if (!hasProjects) {
    return {
      kind: 'noProjectAvailable',
      hasProjects,
      scopedProjectIds,
      actionableProjectIds,
      readOnlyProjectIds,
    };
  }

  if (scopedProjectIds.length === 0) {
    return {
      kind: 'noProjectSelected',
      hasProjects,
      scopedProjectIds,
      actionableProjectIds,
      readOnlyProjectIds,
    };
  }

  if (actionableProjectIds.length === 0) {
    return {
      kind: 'readOnlyOnly',
      hasProjects,
      scopedProjectIds,
      actionableProjectIds,
      readOnlyProjectIds,
    };
  }

  return {
    kind: 'ready',
    hasProjects,
    scopedProjectIds,
    actionableProjectIds,
    readOnlyProjectIds,
  };
};

export const isProjectWorkspaceMissing = (
  state: ProjectWorkspaceState
): state is ProjectWorkspaceState & { kind: MissingProjectWorkspaceStateKind } =>
  state.kind === 'noProjectAvailable' || state.kind === 'noProjectSelected';
