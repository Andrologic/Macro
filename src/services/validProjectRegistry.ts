import type { Project, ProjectGroup } from '../types';
import {
  getScopedProjectIds,
} from './globalProjects';
import { getRegisteredAppState } from './appStateRuntime';
import { resolveProjectExecutionMode } from './projectExecutionMode';

export interface ValidProjectRegistryAppState {
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  selectedProjectId: string | null;
}

export interface ValidProjectRegistrySnapshot {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  scopedProjectIds: string[];
  actionableProjectIds: string[];
  readOnlyProjectIds: string[];
  actionableProjectIdSet: Set<string>;
  readOnlyProjectIdSet: Set<string>;
  manualReadOnlyProjectIdSet?: Set<string>;
  validProjectIds: string[];
  validProjectIdSet: Set<string>;
  repoPathByProjectId: Map<string, string>;
  workspacePathByProjectId: Map<string, string>;
  gitFlowSettingsByProjectId: Map<string, ProjectGroup['projects'][number]['gitFlowSettings']>;
  executionModeByProjectId: Map<string, 'git' | 'direct'>;
  hasRegisteredProjects: boolean;
}

const emptySnapshot = (): ValidProjectRegistrySnapshot => ({
  selectedGroupId: null,
  selectedProjectId: null,
  scopedProjectIds: [],
  actionableProjectIds: [],
  readOnlyProjectIds: [],
  actionableProjectIdSet: new Set<string>(),
  readOnlyProjectIdSet: new Set<string>(),
  manualReadOnlyProjectIdSet: new Set<string>(),
  validProjectIds: [],
  validProjectIdSet: new Set<string>(),
  repoPathByProjectId: new Map<string, string>(),
  workspacePathByProjectId: new Map<string, string>(),
  gitFlowSettingsByProjectId: new Map<string, ProjectGroup['projects'][number]['gitFlowSettings']>(),
  executionModeByProjectId: new Map<string, 'git' | 'direct'>(),
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
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
}): ValidProjectRegistrySnapshot => {
  const validProjectIds: string[] = [];
  const validProjectIdSet = new Set<string>();
  const actionableProjectIds: string[] = [];
  const actionableProjectIdSet = new Set<string>();
  const readOnlyProjectIds: string[] = [];
  const readOnlyProjectIdSet = new Set<string>();
  const manualReadOnlyProjectIdSet = new Set<string>();
  const repoPathByProjectId = new Map<string, string>();
  const workspacePathByProjectId = new Map<string, string>();
  const gitFlowSettingsByProjectId = new Map<string, ProjectGroup['projects'][number]['gitFlowSettings']>();
  const executionModeByProjectId = new Map<string, 'git' | 'direct'>();

  for (const project of [
    ...(params.standaloneProjects ?? []),
    ...params.projectGroups.flatMap((group) => group.projects),
  ]) {
    const projectId = typeof project.id === 'string' ? project.id.trim() : '';
    const repoPath = normalizeProjectRegistryPath(project.path);
    if (!projectId || isSyntheticProjectId(projectId) || !repoPath || validProjectIdSet.has(projectId)) {
      continue;
    }
    validProjectIds.push(projectId);
    validProjectIdSet.add(projectId);
    workspacePathByProjectId.set(projectId, repoPath);
    gitFlowSettingsByProjectId.set(projectId, project.gitFlowSettings);
    if (project.userReadOnly) {
      manualReadOnlyProjectIdSet.add(projectId);
    }
    const executionMode = resolveProjectExecutionMode({ project }).mode;
    if (executionMode !== 'git' && executionMode !== 'direct') {
      readOnlyProjectIds.push(projectId);
      readOnlyProjectIdSet.add(projectId);
      continue;
    }
    actionableProjectIds.push(projectId);
    actionableProjectIdSet.add(projectId);
    executionModeByProjectId.set(projectId, executionMode);
    if (executionMode === 'git') {
      repoPathByProjectId.set(projectId, repoPath);
    }
  }

  const scopedProjectIds = Array.from(
    new Set(
      getScopedProjectIds(
        {
          standaloneProjects: params.standaloneProjects ?? [],
          projectGroups: params.projectGroups,
        },
        params.selectedGroupId ?? null,
        params.selectedProjectId ?? null
      ).filter((projectId) => validProjectIdSet.has(projectId))
    )
  );
  const scopedActionableProjectIds = Array.from(
    new Set(
      getScopedProjectIds(
        {
          standaloneProjects: params.standaloneProjects ?? [],
          projectGroups: params.projectGroups,
        },
        params.selectedGroupId ?? null,
        params.selectedProjectId ?? null
      ).filter((projectId) => actionableProjectIdSet.has(projectId))
    )
  );
  const scopedReadOnlyProjectIds = Array.from(
    new Set(
      getScopedProjectIds(
        {
          standaloneProjects: params.standaloneProjects ?? [],
          projectGroups: params.projectGroups,
        },
        params.selectedGroupId ?? null,
        params.selectedProjectId ?? null
      ).filter((projectId) => readOnlyProjectIdSet.has(projectId))
    )
  );

  return {
    selectedGroupId: params.selectedGroupId ?? null,
    selectedProjectId: params.selectedProjectId ?? null,
    scopedProjectIds,
    actionableProjectIds: scopedActionableProjectIds,
    readOnlyProjectIds: scopedReadOnlyProjectIds,
    actionableProjectIdSet,
    readOnlyProjectIdSet,
    manualReadOnlyProjectIdSet,
    validProjectIds,
    validProjectIdSet,
    repoPathByProjectId,
    workspacePathByProjectId,
    gitFlowSettingsByProjectId,
    executionModeByProjectId,
    hasRegisteredProjects: validProjectIds.length > 0,
  };
};

const loadDefaultValidProjectRegistryAppState = async (): Promise<ValidProjectRegistryAppState> =>
  await getRegisteredAppState<ValidProjectRegistryAppState>();

export const loadValidProjectRegistrySnapshot = async (options?: {
  getAppState?:
    | (() => ValidProjectRegistryAppState | Promise<ValidProjectRegistryAppState>)
    | undefined;
}): Promise<ValidProjectRegistrySnapshot> => {
  try {
    const getAppState = options?.getAppState ?? loadDefaultValidProjectRegistryAppState;
    const state = await getAppState();
    return buildValidProjectRegistrySnapshot({
      standaloneProjects: state.standaloneProjects ?? [],
      projectGroups: state.projectGroups,
      selectedGroupId: state.selectedGroupId,
      selectedProjectId: state.selectedProjectId,
    });
  } catch {
    return emptySnapshot();
  }
};
