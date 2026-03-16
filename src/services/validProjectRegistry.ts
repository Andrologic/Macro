import type { ProjectGroup } from '../types';
import { getScopedProjectIds } from './globalProjects';

export interface ValidProjectRegistrySnapshot {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  scopedProjectIds: string[];
  validProjectIds: string[];
  validProjectIdSet: Set<string>;
  repoPathByProjectId: Map<string, string>;
  hasRegisteredProjects: boolean;
}

const emptySnapshot = (): ValidProjectRegistrySnapshot => ({
  selectedGroupId: null,
  selectedProjectId: null,
  scopedProjectIds: [],
  validProjectIds: [],
  validProjectIdSet: new Set<string>(),
  repoPathByProjectId: new Map<string, string>(),
  hasRegisteredProjects: false,
});

export const normalizeProjectRegistryPath = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
};

export const isSyntheticProjectId = (value?: string | null): boolean =>
  Boolean(value && value.startsWith('session-project-'));

export const buildValidProjectRegistrySnapshot = (params: {
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
}): ValidProjectRegistrySnapshot => {
  const validProjectIds: string[] = [];
  const validProjectIdSet = new Set<string>();
  const repoPathByProjectId = new Map<string, string>();

  for (const group of params.projectGroups) {
    for (const project of group.projects) {
      const projectId = typeof project.id === 'string' ? project.id.trim() : '';
      const repoPath = normalizeProjectRegistryPath(project.path);
      if (!projectId || isSyntheticProjectId(projectId) || !repoPath || validProjectIdSet.has(projectId)) {
        continue;
      }
      validProjectIds.push(projectId);
      validProjectIdSet.add(projectId);
      repoPathByProjectId.set(projectId, repoPath);
    }
  }

  const scopedProjectIds = Array.from(
    new Set(
      getScopedProjectIds(
        params.projectGroups,
        params.selectedGroupId ?? null,
        params.selectedProjectId ?? null
      ).filter((projectId) => validProjectIdSet.has(projectId))
    )
  );

  return {
    selectedGroupId: params.selectedGroupId ?? null,
    selectedProjectId: params.selectedProjectId ?? null,
    scopedProjectIds,
    validProjectIds,
    validProjectIdSet,
    repoPathByProjectId,
    hasRegisteredProjects: validProjectIds.length > 0,
  };
};

export const loadValidProjectRegistrySnapshot = async (): Promise<ValidProjectRegistrySnapshot> => {
  try {
    const { useAppStore } = await import('../stores/useAppStore');
    const state = useAppStore.getState();
    return buildValidProjectRegistrySnapshot({
      projectGroups: state.projectGroups,
      selectedGroupId: state.selectedGroupId,
      selectedProjectId: state.selectedProjectId,
    });
  } catch {
    return emptySnapshot();
  }
};
