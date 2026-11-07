import { isProjectGitActionable } from './globalProjects';
import type { MacroMetadataCoordinatorDeps } from './macroMetadataCoordinator';
import type { ProjectGitFlowSettings } from '../types';
import * as tauriIpc from './tauriIpc';
import {
  loadValidProjectRegistrySnapshot,
  normalizeProjectRegistryPath,
  type ValidProjectRegistryAppState,
  type ValidProjectRegistrySnapshot,
} from './validProjectRegistry';
import {
  getArchitectPlanIndexCacheKey,
  normalizeBranchName,
  sanitizeId,
  type ArchitectMetadataScope,
  type ArchitectPlanActivationPayload,
  type ArchitectPlanIndex,
} from './architectPlanReadModel';

export interface ArchitectPlanServiceAppState extends ValidProjectRegistryAppState {
  metadataAutoPush?: boolean;
}

export interface ArchitectPlanLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface ArchitectPlanServiceDependencies {
  tauri?: typeof tauriIpc;
  getAppState?: () => ArchitectPlanServiceAppState | Promise<ArchitectPlanServiceAppState>;
  loadRegistrySnapshot?: (options?: {
    getAppState?:
      | (() => ValidProjectRegistryAppState | Promise<ValidProjectRegistryAppState>)
      | undefined;
  }) => Promise<ValidProjectRegistrySnapshot>;
}

export interface ResolvedArchitectPlanServiceDependencies {
  tauri: typeof tauriIpc;
  getAppState: () => Promise<ArchitectPlanServiceAppState>;
  loadRegistrySnapshot: (options?: {
    getAppState?:
      | (() => ValidProjectRegistryAppState | Promise<ValidProjectRegistryAppState>)
      | undefined;
  }) => Promise<ValidProjectRegistrySnapshot>;
}

// Application composition owns these ports. Headless clients inject their registry.
export interface ArchitectPlanCompositionPorts extends ArchitectPlanServiceDependencies {
  localStorage?: ArchitectPlanLocalStorage;
}

let defaultPlanPorts: ArchitectPlanCompositionPorts = {};

export const installArchitectPlanPorts = (ports: ArchitectPlanCompositionPorts): (() => void) => {
  const previous = defaultPlanPorts;
  defaultPlanPorts = ports;
  clearArchitectPlanFrontendCaches();
  return () => {
    if (defaultPlanPorts !== ports) return;
    defaultPlanPorts = previous;
    clearArchitectPlanFrontendCaches();
  };
};

export const loadDefaultArchitectPlanAppState = async (): Promise<ArchitectPlanServiceAppState> => {
  throw new Error('Plans project ports have not been installed.');
};

export const resolveArchitectPlanServiceDependencies = (
  overrides: ArchitectPlanServiceDependencies = {}
): ResolvedArchitectPlanServiceDependencies => {
  overrides = { ...defaultPlanPorts, ...overrides };
  const getAppState = overrides.getAppState ?? loadDefaultArchitectPlanAppState;

  return {
    tauri: overrides.tauri ?? tauriIpc,
    getAppState: async () => await getAppState(),
    loadRegistrySnapshot:
      overrides.loadRegistrySnapshot ??
      ((options) =>
        loadValidProjectRegistrySnapshot({
          getAppState: options?.getAppState ?? getAppState,
        })),
  };
};

export const createGitFlowMetadataNormalizationContext = async (
  deps: ResolvedArchitectPlanServiceDependencies,
  fallbackBaseBranch: string
): Promise<{
  getProjectSettings: (projectId: string) => Partial<ProjectGitFlowSettings> | null;
  getDefaultBranches: (projectId: string) => { baseBranch: string; mainBranch: string };
}> => {
  try {
    const appState = await deps.getAppState();
    const projectById = new Map(
      (appState.projectGroups || [])
        .flatMap((group) => group.projects || [])
        .map((project) => [project.id, project])
    );

    return {
      getProjectSettings: (projectId) => projectById.get(projectId)?.gitFlowSettings ?? null,
      getDefaultBranches: (projectId) => {
        const settings = projectById.get(projectId)?.gitFlowSettings;
        return {
          baseBranch: settings?.baseBranch || fallbackBaseBranch,
          mainBranch: settings?.mainBranch || 'main',
        };
      },
    };
  } catch {
    return {
      getProjectSettings: () => null,
      getDefaultBranches: () => ({
        baseBranch: fallbackBaseBranch,
        mainBranch: 'main',
      }),
    };
  }
};

export const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';

export const architectPlanIndexCache = new Map<
  string,
  {
    expiresAt: number;
    value?: ArchitectPlanIndex;
    promise?: Promise<ArchitectPlanIndex>;
  }
>();

export const architectPlanActivationCache = new Map<
  string,
  {
    expiresAt: number;
    value?: ArchitectPlanActivationPayload | null;
    promise?: Promise<ArchitectPlanActivationPayload | null>;
  }
>();

export const loadCachedArchitectPlanValue = async <T>(params: {
  cache: Map<
    string,
    {
      expiresAt: number;
      value?: T;
      promise?: Promise<T>;
    }
  >;
  cacheKey: string;
  ttlMs: number;
  loader: () => Promise<T>;
}): Promise<T> => {
  const now = Date.now();
  const cached = params.cache.get(params.cacheKey);
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const promise = params.loader().then(
    (value) => {
      if (params.cache.get(params.cacheKey)?.promise === promise) {
        params.cache.set(params.cacheKey, {
          value,
          expiresAt: Date.now() + params.ttlMs,
        });
      }
      return value;
    },
    (error) => {
      const inFlight = params.cache.get(params.cacheKey);
      if (inFlight?.promise === promise) {
        params.cache.delete(params.cacheKey);
      }
      throw error;
    }
  );

  params.cache.set(params.cacheKey, {
    expiresAt: now + params.ttlMs,
    promise,
  });
  return promise;
};

export const clearArchitectPlanFrontendCaches = (params?: {
  branchName?: string | null;
  planId?: string | null;
}): void => {
  const normalizedBranch = params?.branchName
    ? normalizeBranchName(params.branchName)
    : null;

  if (!normalizedBranch) {
    architectPlanIndexCache.clear();
    architectPlanActivationCache.clear();
    return;
  }

  const indexPrefix = `${getArchitectPlanIndexCacheKey(normalizedBranch)}::`;
  for (const cacheKey of architectPlanIndexCache.keys()) {
    if (cacheKey.startsWith(indexPrefix)) architectPlanIndexCache.delete(cacheKey);
  }
  if (params?.planId) {
    const activationPrefix = `${normalizedBranch}::${sanitizeId(params.planId)}::`;
    for (const cacheKey of architectPlanActivationCache.keys()) {
      if (cacheKey.startsWith(activationPrefix)) {
        architectPlanActivationCache.delete(cacheKey);
      }
    }
    return;
  }

  const activationPrefix = `${normalizedBranch}::`;
  for (const cacheKey of architectPlanActivationCache.keys()) {
    if (cacheKey.startsWith(activationPrefix)) {
      architectPlanActivationCache.delete(cacheKey);
    }
  }
};

export const invalidateArchitectPlanRuntimeCaches = (params?: {
  branchName?: string;
  planId?: string;
}): void => {
  const normalizedBranch = params?.branchName
    ? normalizeBranchName(params.branchName)
    : null;

  clearArchitectPlanFrontendCaches(params);
  if (tauriIpc.isTauriAvailable() && typeof tauriIpc.workspaceArchitectInvalidate === 'function') {
    void tauriIpc.workspaceArchitectInvalidate(
      normalizedBranch ? { branchName: normalizedBranch } : undefined,
    ).catch(() => undefined);
  }
};

export const normalizeRepoPath = (value: string | null | undefined): string | null =>
  normalizeProjectRegistryPath(value);

export const buildScopeKey = (source: ArchitectMetadataScope['source'], repoPath: string | null, projectId: string | null): string => {
  if (repoPath) {
    return `repo:${repoPath}`;
  }
  return `${source}:${projectId || 'none'}`;
};

export const dedupeScopes = (scopes: ArchitectMetadataScope[]): ArchitectMetadataScope[] => {
  const deduped = new Map<string, ArchitectMetadataScope>();
  for (const scope of scopes) {
    if (!deduped.has(scope.scopeKey)) {
      deduped.set(scope.scopeKey, scope);
    }
  }
  return Array.from(deduped.values());
};

export const resolveScopeProjectId = (
  scope: ArchitectMetadataScope,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): string | null => {
  const explicitProjectId = typeof scope.projectId === 'string' ? scope.projectId.trim() : '';
  if (explicitProjectId) {
    return explicitProjectId;
  }

  const normalizedRepoPath = normalizeRepoPath(scope.repoPath);
  if (!normalizedRepoPath || !registrySnapshot?.repoPathByProjectId) {
    return null;
  }

  for (const [projectId, repoPath] of registrySnapshot.repoPathByProjectId.entries()) {
    if (normalizeRepoPath(repoPath) === normalizedRepoPath) {
      return projectId;
    }
  }

  return null;
};

export const getProjectMetadataScopes = (
  registrySnapshot: ValidProjectRegistrySnapshot,
  projectIds?: string[],
  executionModesByProjectId?: Record<string, 'git' | 'direct'>,
): ArchitectMetadataScope[] => {
  const targetProjectIds = projectIds && projectIds.length > 0
    ? Array.from(new Set(projectIds))
    : registrySnapshot.validProjectIds;

  return targetProjectIds.flatMap((projectId) => {
    const repoPath = registrySnapshot.repoPathByProjectId.get(projectId) || null;
    const workspacePath = registrySnapshot.workspacePathByProjectId.get(projectId) || null;
    if (!workspacePath) {
      return [];
    }
    const executionMode = executionModesByProjectId?.[projectId] ??
      registrySnapshot.executionModeByProjectId.get(projectId);
    return [{
      scopeKey: buildScopeKey(repoPath ? 'project' : 'workspace', workspacePath, projectId),
      projectId,
      repoPath,
      workspacePath,
      source: repoPath ? 'project' as const : 'workspace' as const,
      workspaceScope: executionMode === 'direct' ? 'direct' : METADATA_WORKSPACE_SCOPE,
    }];
  });
};

export const getScopeWorkspaceScope = (scope: ArchitectMetadataScope): tauriIpc.WorkspaceScope =>
  scope.workspaceScope ?? METADATA_WORKSPACE_SCOPE;

export const existingMetadataScope = (scope: ArchitectMetadataScope): ArchitectMetadataScope => ({
  ...scope,
  workspaceScope: getScopeWorkspaceScope(scope) === 'metadata' ? 'metadata_existing' : getScopeWorkspaceScope(scope),
});

export const getWorkspaceFallbackScope = async (): Promise<ArchitectMetadataScope | null> => {
  if (!tauriIpc.isTauriAvailable()) {
    return null;
  }

  try {
    const repoPath = normalizeRepoPath(await tauriIpc.workspaceGetActiveRoot());
    if (!repoPath) return null;
    return {
      scopeKey: buildScopeKey('workspace', repoPath, null),
      projectId: null,
      repoPath,
      workspacePath: repoPath,
      source: 'workspace',
    };
  } catch {
    return null;
  }
};

export const resolveMetadataScopes = async (projectIds?: string[], options?: {
  includeAllKnown?: boolean;
  includeWorkspaceFallback?: boolean;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
}, registrySnapshot?: ValidProjectRegistrySnapshot | null, deps?: ResolvedArchitectPlanServiceDependencies): Promise<ArchitectMetadataScope[]> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  if (!resolvedDeps.tauri.isTauriAvailable()) {
    return [{
      scopeKey: 'local',
      projectId: projectIds?.[0] || null,
      repoPath: null,
      workspacePath: null,
      source: 'local',
    }];
  }

  const resolvedRegistrySnapshot =
    registrySnapshot ??
    await resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState });
  const scopes: ArchitectMetadataScope[] = [];
  if (projectIds && projectIds.length > 0) {
    scopes.push(...getProjectMetadataScopes(
      resolvedRegistrySnapshot,
      projectIds,
      options?.executionModesByProjectId,
    ));
  }
  if (options?.includeAllKnown || ((!projectIds || projectIds.length === 0) && scopes.length === 0)) {
    scopes.push(...getProjectMetadataScopes(
      resolvedRegistrySnapshot,
      undefined,
      options?.executionModesByProjectId,
    ));
  }
  if (options?.includeWorkspaceFallback !== false) {
    const workspaceScope = await getWorkspaceFallbackScope();
    const duplicatesDirectWorkspace = workspaceScope && scopes.some((scope) =>
      scope.source === 'workspace' &&
      normalizeRepoPath(scope.workspacePath) === normalizeRepoPath(workspaceScope.workspacePath)
    );
    if (workspaceScope && !duplicatesDirectWorkspace) {
      scopes.push(workspaceScope);
    }
  }
  return dedupeScopes(scopes);
};

export const loadArchitectPlanRegistrySnapshot = async (
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<ValidProjectRegistrySnapshot | undefined> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  return resolvedDeps.tauri.isTauriAvailable()
    ? resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState })
    : undefined;
};

export const ensurePlanScopes = async (
  projectIds: string[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  deps?: ResolvedArchitectPlanServiceDependencies,
  executionModesByProjectId?: Record<string, 'git' | 'direct'>,
): Promise<ArchitectMetadataScope[]> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  if (!resolvedDeps.tauri.isTauriAvailable()) {
    return [{
      scopeKey: 'local',
      projectId: projectIds[0] || null,
      repoPath: null,
      workspacePath: null,
      source: 'local',
    }];
  }

  const resolvedRegistrySnapshot =
    registrySnapshot ??
    await resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState });

  if (projectIds.length > 0) {
    const scopes = dedupeScopes(getProjectMetadataScopes(
      resolvedRegistrySnapshot,
      projectIds,
      executionModesByProjectId,
    ));
    if (scopes.length > 0) {
      return scopes;
    }
  }

  const scopedProjectIds = resolvedRegistrySnapshot.scopedProjectIds;
  if (scopedProjectIds.length > 0) {
    const selectedScopes = dedupeScopes(getProjectMetadataScopes(
      resolvedRegistrySnapshot,
      scopedProjectIds,
      executionModesByProjectId,
    ));
    if (selectedScopes.length > 0) {
      return selectedScopes;
    }
  }

  const workspaceScope = await getWorkspaceFallbackScope();
  if (workspaceScope) {
    return [workspaceScope];
  }

  throw new Error('Unable to resolve a repository scope for this plan.');
};

/** Carry project policy into the metadata coordinator instead of its app-state fallback. */
export const getArchitectPlanMetadataCoordinatorDeps = (
  deps: ResolvedArchitectPlanServiceDependencies,
): MacroMetadataCoordinatorDeps => ({
  tauri: deps.tauri,
  isWorkspaceGitActionable: async (workspacePath) => {
    const state = await deps.getAppState();
    const path = normalizeProjectRegistryPath(workspacePath);
    const projects = [...(state.standaloneProjects ?? []), ...state.projectGroups.flatMap((group) => group.projects)];
    const project = projects.find((candidate) => normalizeProjectRegistryPath(candidate.path) === path);
    return isProjectGitActionable(project);
  },
});

/** Browser preview storage is optional; native persistence uses metadata scopes. */
export const getArchitectPlanLocalStorage = (): ArchitectPlanLocalStorage | undefined =>
  defaultPlanPorts.localStorage ?? globalThis.localStorage;

const localStorageCacheIds = new WeakMap<ArchitectPlanLocalStorage, number>();
let nextLocalStorageCacheId = 0;

/** A branch name alone is not the identity of a project registry or preview store. */
export const getArchitectPlanCacheScope = (
  deps: ResolvedArchitectPlanServiceDependencies,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
): string => {
  if (!deps.tauri.isTauriAvailable()) {
    const storage = getArchitectPlanLocalStorage();
    if (!storage) return 'local:absent';
    let id = localStorageCacheIds.get(storage);
    if (id === undefined) {
      id = ++nextLocalStorageCacheId;
      localStorageCacheIds.set(storage, id);
    }
    return `local:${id}`;
  }
  return `registry:${JSON.stringify([
    registrySnapshot?.selectedGroupId,
    registrySnapshot?.selectedProjectId,
    [...(registrySnapshot?.workspacePathByProjectId ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    [...(registrySnapshot?.executionModeByProjectId ?? [])].sort(([left], [right]) => left.localeCompare(right)),
  ])}`;
};
