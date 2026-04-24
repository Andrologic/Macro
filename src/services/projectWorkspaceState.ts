import type { ProjectGroup } from '../types';
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
  selectedGroupId: string | null | undefined;
  selectedProjectId: string | null | undefined;
}): ProjectWorkspaceState => {
  const hasProjects = params.projectGroups.some((group) => group.projects.length > 0);
  const knownProjectIds = new Set(
    params.projectGroups.flatMap((group) => group.projects.map((project) => project.id))
  );
  const scopedProjectIds = getScopedProjectIds(
    params.projectGroups,
    params.selectedGroupId,
    params.selectedProjectId
  ).filter((projectId) => knownProjectIds.has(projectId));
  const actionableProjectIds = getScopedActionableProjectIds(
    params.projectGroups,
    params.selectedGroupId,
    params.selectedProjectId
  ).filter((projectId) => knownProjectIds.has(projectId));
  const readOnlyProjectIds = getScopedReadOnlyProjectIds(
    params.projectGroups,
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
