import { synchronizeSanitizedArchitectPlanReplicas } from './architectPlanSyncReplicas';
import { getArchitectPlanCacheScope } from './architectPlanReadContext';
import { getArchitectPlanLocalStorage } from './architectPlanReadContext';
import type { ArchitectPlanServiceDependencies } from './architectPlanReadContext';
import type { PlanNode, PredictedBranch } from '../types';
import * as tauriIpc from './tauriIpc';
import { devLogger } from '../utils/devLogger';
import { type ValidProjectRegistrySnapshot } from './validProjectRegistry';
import { normalizeArchitectPlanIdList, normalizeArchitectPlanScope } from './architectPlanScope';
import {
  normalizeArchitectPlanGitFlowMetadata,
  normalizeArchitectPlanKind,
  type ArchitectPlanGitFlowMetadata,
  type ArchitectPlanKind,
} from './architectPlanKinds';
import {
  ARCHITECT_PLAN_ACTIVATION_CACHE_TTL_MS,
  ARCHITECT_PLAN_INDEX_CACHE_TTL_MS,
  LOCAL_INDEX_KEY_PREFIX,
  assertGitFlowTargetBranch,
  buildReplicaComparableSnapshot,
  canUseBlankActivationSummary,
  dedupeProjectIdDiagnostics,
  getArchitectPlanActionableProjectIds,
  getArchitectPlanActivationCacheKey,
  getArchitectPlanActivationScopeSignature,
  getArchitectPlanActivationSummarySignature,
  getArchitectPlanIndexCacheKey,
  getArchitectPlanVisibleProjectIds,
  getGitFlowBaseBranch,
  getPlanDir,
  logArchitectPlanActivationLoad,
  mergePlanSummaries,
  normalizeBranchName,
  normalizeContextProjectIds,
  normalizeProjectIds,
  normalizeTargetBranchesByProjectId,
  pickCanonicalReplica,
  planRecordFromActivationSummary,
  resolvePlanProjectIds,
  sanitizeArchitectPlanRecord,
  sanitizeArchitectPlanSummary,
  sanitizeId,
  slugifyPlanTitle,
  stableSerialize,
  throwPlanMetadataMissing,
  throwReplicaDivergence,
  toErrorMessage,
  toReplicaDescriptor,
  type ArchitectMetadataScope,
  type ArchitectPlanActivationOptions,
  type ArchitectPlanActivationPayload,
  type ArchitectPlanChatMessage,
  type ArchitectPlanIndex,
  type ArchitectPlanMetadataHealth,
  type ArchitectPlanMetadataHealthStatus,
  type ArchitectPlanRecord,
  type ArchitectPlanReplica,
  type ArchitectPlanReplicaSet,
  type ArchitectPlanReplicaSnapshotDiagnostics,
  type ArchitectPlanReplicationState,
  type ArchitectPlanStatus,
  type ArchitectPlanSummary,
} from './architectPlanReadModel';
import {
  architectPlanActivationCache,
  architectPlanIndexCache,
  dedupeScopes,
  existingMetadataScope,
  getProjectMetadataScopes,
  getScopeWorkspaceScope,
  loadArchitectPlanRegistrySnapshot,
  loadCachedArchitectPlanValue,
  resolveArchitectPlanServiceDependencies,
  resolveMetadataScopes,
  resolveScopeProjectId,
  type ResolvedArchitectPlanServiceDependencies,
} from './architectPlanReadContext';
import {
  readIndexAtScope,
  readPlanAtScopeWithDiagnostics,
  readPlanChatAtScope,
  readPlanManifestAtScope,
  readStoredPlanManifestAtScope,
} from './architectPlanReplicaStorage';
import {
  getPlanExecutionModes,
  recoverArchitectPlanReplicaMutations,
} from './architectPlanMutationPersistence';

export interface PersistedDirectPlanDiscovery {
  plan: ArchitectPlanRecord;
  scopes: ArchitectMetadataScope[];
}

export const discoverPersistedDirectPlan = async (params: {
  branchName: string;
  planId: string;
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
  deps: ResolvedArchitectPlanServiceDependencies;
}): Promise<PersistedDirectPlanDiscovery | null> => {
  const registrySnapshot = params.registrySnapshot;
  if (!registrySnapshot || !params.deps.tauri.isTauriAvailable()) {
    return null;
  }
  const directModes = Object.fromEntries(
    registrySnapshot.validProjectIds.map((projectId) => [projectId, 'direct' as const]),
  );
  const directScopes = getProjectMetadataScopes(
    registrySnapshot,
    registrySnapshot.validProjectIds,
    directModes,
  );
  const candidates = (
    await Promise.all(directScopes.map(async (scope) => ({
      scope,
      result: await readPlanAtScopeWithDiagnostics(
        scope,
        params.branchName,
        params.planId,
        registrySnapshot,
      ),
    })))
  ).filter(({ scope, result }) => {
    if (!scope.projectId || !result.plan) return false;
    return getPlanExecutionModes(result.plan, registrySnapshot)[scope.projectId] === 'direct';
  });
  if (candidates.length === 0) {
    return null;
  }
  const plan = candidates
    .map(({ result }) => result.plan as ArchitectPlanRecord)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!plan) {
    return null;
  }
  const executionModesByProjectId = getPlanExecutionModes(plan, registrySnapshot);
  const expectedProjectIds = normalizeArchitectPlanScope(plan, {
    useExpectedAsActionableFallback: true,
  }).expectedProjectIds;
  const scopes = await resolveMetadataScopes(
    expectedProjectIds,
    {
      includeWorkspaceFallback: false,
      executionModesByProjectId,
    },
    registrySnapshot,
    params.deps,
  );
  return { plan, scopes };
};

export const readPlanFilesAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<Record<string, string>> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return {};
  }

  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const planDir = getPlanDir(normalized, safeId);

  try {
    const entries = await tauriIpc.fsListDir({
      path: planDir,
      recursive: true,
      includeHidden: true,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });
    const files = entries.filter((entry) => entry.kind === 'file');
    const contents = await Promise.all(
      files.map(async (entry) => {
        const relativePath = entry.relative_path.replace(/\\/g, '/').replace(/^\/+/, '');
        const content = await tauriIpc.fsReadFileWithOptions({
          path: `${planDir}/${relativePath}`,
          allowOutsideWorkspace: false,
          workspaceScope: getScopeWorkspaceScope(scope),
          workspacePath: scope.workspacePath,
        });
        return [relativePath, content.content] as const;
      })
    );
    return Object.fromEntries(contents);
  } catch {
    return {};
  }
};

export const listLocalTargetBranches = (): string[] => {
  const storage = getArchitectPlanLocalStorage();
  if (!storage) return [];

  const branches: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(`${LOCAL_INDEX_KEY_PREFIX}:`)) {
      continue;
    }

    const branchName = key.slice(`${LOCAL_INDEX_KEY_PREFIX}:`.length).trim();
    if (branchName.length > 0) {
      branches.push(normalizeBranchName(branchName));
    }
  }

  return Array.from(new Set(branches));
};

export const listTargetBranchesAtScope = async (
  scope: ArchitectMetadataScope
): Promise<string[]> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return listLocalTargetBranches();
  }

  try {
    const entries = await tauriIpc.fsListDir({
      path: 'branches',
      recursive: true,
      includeHidden: true,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });

    const suffix = '/plans/index.json';
    return Array.from(new Set(
      entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.relative_path.replace(/\\/g, '/').replace(/^\/+/, ''))
        .filter((relativePath) => relativePath.endsWith(suffix))
        .map((relativePath) => normalizeBranchName(relativePath.slice(0, -suffix.length)))
        .filter((branchName) => branchName.length > 0)
    ));
  } catch {
    return [];
  }
};

export const readAggregatedIndex = async (
  branchName: string,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanIndex> => {
  const normalized = normalizeBranchName(branchName);
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  const resolvedRegistrySnapshot = resolvedDeps.tauri.isTauriAvailable()
    ? registrySnapshot ?? await resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState })
    : registrySnapshot;
  const cacheKey = `${getArchitectPlanIndexCacheKey(normalized)}::${getArchitectPlanCacheScope(resolvedDeps, resolvedRegistrySnapshot)}`;

  return await loadCachedArchitectPlanValue({
    cache: architectPlanIndexCache,
    cacheKey,
    ttlMs: ARCHITECT_PLAN_INDEX_CACHE_TTL_MS,
    loader: async () => {
      const scopes = await resolveMetadataScopes(
        undefined,
        { includeAllKnown: true },
        resolvedRegistrySnapshot,
        resolvedDeps
      );
      if (resolvedRegistrySnapshot) {
        const transitionedDirectScopes = getProjectMetadataScopes(
          resolvedRegistrySnapshot,
          resolvedRegistrySnapshot.validProjectIds.filter(
            (projectId) => resolvedRegistrySnapshot.executionModeByProjectId.get(projectId) !== 'direct',
          ),
          Object.fromEntries(
            resolvedRegistrySnapshot.validProjectIds.map((projectId) => [projectId, 'direct']),
          ),
        ).map((scope) => ({
          ...scope,
          scopeKey: `direct:${scope.workspacePath || scope.projectId || 'unknown'}`,
          repoPath: null,
          workspaceScope: 'direct' as const,
        }));
        scopes.push(...transitionedDirectScopes);
      }
      const dedupedScopes = dedupeScopes(scopes);
      const indexes = await Promise.all(
        dedupedScopes.map(async (scope) => ({
          scope,
          index: await readIndexAtScope(scope, normalized, resolvedRegistrySnapshot),
        }))
      );

      const plansById = new Map<
        string,
        Array<{ scope: ArchitectMetadataScope; summary: ArchitectPlanSummary }>
      >();
      for (const { scope, index } of indexes) {
        for (const summary of index.plans) {
          const existing = plansById.get(summary.id) || [];
          existing.push({ scope, summary });
          plansById.set(summary.id, existing);
        }
      }

      const activePlanIds = Array.from(
        new Set(
          indexes
            .map(({ index }) => index.activePlanId)
            .filter((planId): planId is string => Boolean(planId))
        )
      );

      return {
        version: 3,
        activePlanId: activePlanIds.length === 1 ? activePlanIds[0] : null,
        plans: Array.from(plansById.values()).map((entries) =>
          mergePlanSummaries(entries, resolvedRegistrySnapshot)
        ),
        reservedPlanSlugs: Array.from(
          new Set(
            indexes.flatMap(({ index }) =>
              index.reservedPlanSlugs.map((slug) => slugifyPlanTitle(slug))
            )
          )
        ),
      };
    },
  });
};

export const listArchitectPlanTargetBranchesImpl = async (
  deps: ResolvedArchitectPlanServiceDependencies
): Promise<string[]> => {
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const scopes = await resolveMetadataScopes(undefined, { includeAllKnown: true }, registrySnapshot, deps);
  const discoveredBranches = (
    await Promise.all(scopes.map((scope) => listTargetBranchesAtScope(scope)))
  ).flat();

  return Array.from(new Set([
    getGitFlowBaseBranch(),
    ...discoveredBranches,
  ])).sort((left, right) => left.localeCompare(right));
};

export const loadPlanReplicaSet = async (
  branchName: string,
  planId: string,
  options?: {
    allowDivergence?: boolean;
    disableAutoHeal?: boolean;
    metadataOnly?: boolean;
    existingMetadataOnly?: boolean;
    registrySnapshot?: ValidProjectRegistrySnapshot | null;
  },
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanReplicaSet | null> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  const normalizedBranch = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const resolvedRegistrySnapshot =
    resolvedDeps.tauri.isTauriAvailable()
      ? (options?.registrySnapshot ??
        await resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState }))
      : undefined;
  const persistedDirectPlan = await discoverPersistedDirectPlan({
    branchName: normalizedBranch,
    planId: safeId,
    registrySnapshot: resolvedRegistrySnapshot,
    deps: resolvedDeps,
  });
  const resolvedScopes = persistedDirectPlan?.scopes ?? await resolveMetadataScopes(
    undefined,
    { includeAllKnown: true },
    resolvedRegistrySnapshot,
    resolvedDeps
  );
  const scopes = resolvedScopes.map(scope => options?.metadataOnly || options?.existingMetadataOnly
    ? existingMetadataScope(scope) : scope);
  const snapshotDiagnosticsRaw: Array<ArchitectPlanReplicaSnapshotDiagnostics | null> = await Promise.all(
    scopes.map(async (scope) => {
      const planResult = await readPlanAtScopeWithDiagnostics(
        scope,
        normalizedBranch,
        safeId,
        resolvedRegistrySnapshot
      );
      if (!planResult.plan) {
        return null;
      }

      const chatMessages = options?.metadataOnly ? [] : await readPlanChatAtScope(scope, normalizedBranch, safeId);
      const manifest = await readPlanManifestAtScope({
        scope,
        branchName: normalizedBranch,
        plan: planResult.plan,
        chatMessages,
        registrySnapshot: resolvedRegistrySnapshot,
      });
      const files = options?.metadataOnly ? {} : await readPlanFilesAtScope(scope, normalizedBranch, safeId);

      return {
        scope,
        plan: {
          ...planResult.plan,
          contextProjectIds: manifest.contextProjectIds,
          expectedProjectIds: manifest.expectedProjectIds,
          revision: manifest.revision,
        },
        manifest,
        files,
        repairApplied: planResult.changed,
        removedInvalidProjectIds: planResult.removedInvalidProjectIds,
      };
    })
  );
  const snapshotDiagnostics = snapshotDiagnosticsRaw.filter(
    (snapshot): snapshot is ArchitectPlanReplicaSnapshotDiagnostics => snapshot !== null
  );

  if (snapshotDiagnostics.length === 0) {
    return null;
  }

  const snapshots = snapshotDiagnostics.map(({ repairApplied: _repairApplied, removedInvalidProjectIds: _removedInvalidProjectIds, ...snapshot }) => snapshot);
  const removedInvalidProjectIds = dedupeProjectIdDiagnostics(
    snapshotDiagnostics.flatMap((snapshot) => snapshot.removedInvalidProjectIds)
  );
  const hasSanitizedReplicaRepair = snapshotDiagnostics.some((snapshot) => snapshot.repairApplied);

  const canonical = pickCanonicalReplica(
    snapshots.map((snapshot) => ({
      ...snapshot,
      updatedAt: snapshot.plan.updatedAt,
      repoPath: snapshot.scope.repoPath,
    })),
    'newest'
  );
  const projectIds = getArchitectPlanActionableProjectIds(canonical.plan);
  const contextProjectIds = normalizeContextProjectIds(
    canonical.plan.contextProjectIds,
    projectIds,
    resolvedRegistrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(projectIds, contextProjectIds);
  const expectedScopes = dedupeScopes([
    ...(await resolveMetadataScopes(
      expectedProjectIds,
      {
        includeWorkspaceFallback: false,
        executionModesByProjectId: getPlanExecutionModes(canonical.plan, resolvedRegistrySnapshot),
      },
      resolvedRegistrySnapshot,
      resolvedDeps
    )),
    ...snapshots.map((snapshot) => snapshot.scope),
  ]);

  const availableProjectIds = Array.from(
    new Set(
      snapshots.flatMap((snapshot) => {
        if (
          snapshot.scope.source === 'local' &&
          expectedProjectIds.length > 0 &&
          !resolvedRegistrySnapshot?.hasRegisteredProjects
        ) {
          return expectedProjectIds;
        }

        const scopedProjectId = resolveScopeProjectId(snapshot.scope, resolvedRegistrySnapshot) || '';
        return scopedProjectId && expectedProjectIds.includes(scopedProjectId)
          ? [scopedProjectId]
          : [];
      })
    )
  );
  const missingProjectIds = expectedProjectIds.filter((projectId) => !availableProjectIds.includes(projectId));

  const missingReplicas = expectedScopes
    .filter((scope) => {
      const scopeProjectId = resolveScopeProjectId(scope, resolvedRegistrySnapshot);
      return Boolean(scopeProjectId) &&
        missingProjectIds.includes(scopeProjectId as string) &&
        !snapshots.some((snapshot) => snapshot.scope.scopeKey === scope.scopeKey);
    })
    .map((scope) => toReplicaDescriptor(scope, null, true));

  const hasContentDivergence =
    new Set(snapshots.map((snapshot) => stableSerialize(buildReplicaComparableSnapshot(snapshot)))).size > 1;
  const hasReplicaDivergence = hasContentDivergence;
  const replicas = [
    ...snapshots.map((snapshot) => toReplicaDescriptor(snapshot.scope, snapshot.plan.updatedAt)),
    ...missingReplicas,
  ];

  if (
    !options?.disableAutoHeal &&
    (removedInvalidProjectIds.length > 0 || hasSanitizedReplicaRepair) &&
    missingReplicas.length === 0 &&
    !hasContentDivergence
  ) {
    await synchronizeSanitizedArchitectPlanReplicas({
      branchName: normalizedBranch,
      snapshots,
      snapshotDiagnostics,
      removedInvalidProjectIds,
      registrySnapshot: resolvedRegistrySnapshot,
      deps: resolvedDeps,
    });

    return loadPlanReplicaSet(normalizedBranch, safeId, {
      ...options,
      disableAutoHeal: true,
      registrySnapshot: resolvedRegistrySnapshot,
    }, resolvedDeps);
  }

  if (!options?.allowDivergence) {
    if (hasContentDivergence) {
      throwReplicaDivergence({
        branchName: normalizedBranch,
        planId: safeId,
        reason: 'content_diverged',
        replicas,
      });
    }
  }

  const replicationState: ArchitectPlanReplicationState =
    canonical.plan.status === 'deleted'
      ? 'deleted'
      : hasContentDivergence
        ? 'diverged'
        : missingProjectIds.length > 0
          ? 'missing_projects'
          : 'healthy';

  return {
    canonical: {
      scope: canonical.scope,
      plan: {
        ...canonical.plan,
        projectId: projectIds[0],
        projectIds,
        contextProjectIds,
        expectedProjectIds,
        availableProjectIds,
        missingProjectIds,
        replicationState,
        revision: canonical.manifest.revision,
        replicas,
        hasReplicaDivergence,
      },
      manifest: canonical.manifest,
      files: canonical.files,
    },
    snapshots,
    expectedScopes,
    replicas,
    hasReplicaDivergence,
  };
};

export interface ArchitectPlanActivationSnapshot {
  scope: ArchitectMetadataScope;
  plan: ArchitectPlanRecord;
  updatedAt: string;
  expectedProjectIds: string[];
  conversationId: string | null;
  chatMessageCount: number | null;
}

export const isWorkspaceArchitectRuntimeAvailable = (
  deps: ResolvedArchitectPlanServiceDependencies
): boolean =>
  (deps.tauri.isTauriAvailable() || deps.tauri.isRemoteBackendAvailable()) &&
  typeof deps.tauri.workspaceArchitectListPlans === 'function' &&
  typeof deps.tauri.workspaceArchitectActivatePlanHead === 'function' &&
  typeof deps.tauri.workspaceArchitectActivatePlanChat === 'function';

export const canUseWorkspaceArchitectRuntimeForScope = (
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
  scopedProjectIdsHint?: string[],
): boolean => {
  if (!registrySnapshot?.hasRegisteredProjects) return true;
  const projectIds = scopedProjectIdsHint?.length
    ? scopedProjectIdsHint
    : registrySnapshot.scopedProjectIds.length > 0
      ? registrySnapshot.scopedProjectIds
      : registrySnapshot.validProjectIds;
  return projectIds.length > 0 && projectIds.every(
    (projectId) => registrySnapshot.executionModeByProjectId.get(projectId) === 'git',
  );
};

export const mapRuntimeArchitectPlanSummary = (
  branchName: string,
  summary: tauriIpc.WorkspaceArchitectPlanSummaryDto
): ArchitectPlanSummary =>
  sanitizeArchitectPlanSummary(
    branchName,
    summary as unknown as ArchitectPlanSummary,
    null
  ).summary;

export const mapRuntimeArchitectPlanRecord = (
  branchName: string,
  plan: tauriIpc.WorkspaceArchitectPlanRecordDto
): ArchitectPlanRecord => {
  const sanitized = sanitizeArchitectPlanRecord(
    branchName,
    plan.id,
    plan as unknown as ArchitectPlanRecord,
    null
  ).plan;

  return sanitized ?? (plan as unknown as ArchitectPlanRecord);
};

export const mapRuntimeArchitectChatMessages = (
  messages: tauriIpc.WorkspaceArchitectChatMessageDto[]
): ArchitectPlanChatMessage[] =>
  messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.role as 'user' | 'assistant',
      content: message.content,
      createdAt: message.createdAt,
    }));

export const loadArchitectPlanActivationPayloadFromRuntime = async (
  branchName: string,
  planId: string,
  options: ArchitectPlanActivationOptions,
  deps: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanActivationPayload | null> => {
  if (!isWorkspaceArchitectRuntimeAvailable(deps)) {
    return null;
  }

  const head = await deps.tauri.workspaceArchitectActivatePlanHead({
    branchName,
    planId,
    summaryHint: options.summaryHint
      ? (options.summaryHint as unknown as tauriIpc.WorkspaceArchitectPlanSummaryDto)
      : null,
    scopedProjectIdsHint: options.scopedProjectIdsHint,
  });
  if (!head) {
    return null;
  }

  const resolutionMode =
    head.resolutionMode === 'blank_fast_path' && head.chatMessageCount === 0
      ? 'blank_fast_path'
      : 'full';
  const replicaScopeKey = head.replicaScopeKey?.trim() || null;
  const replicaProjectId = head.replicaProjectId?.trim() || null;
  if (resolutionMode === 'full' && !replicaScopeKey) {
    throw new Error(
      `Architect runtime returned an incomplete transcript replica identity for branch ${branchName} and plan ${planId}.`,
    );
  }

  return {
    plan: mapRuntimeArchitectPlanRecord(branchName, head.plan),
    chatMessages: [],
    chatMessagesLoaded: resolutionMode === 'blank_fast_path',
    chatTranscriptRevision: head.chatTranscriptRevision,
    chatMessageCount: head.chatMessageCount,
    replicaScopeKey,
    replicaProjectId,
    conversationId: head.conversationId,
    sharedConversation: head.sharedConversation,
    targetBranch: normalizeBranchName(head.targetBranch || branchName),
    resolutionMode,
  };
};

export interface ArchitectPlanChatTranscriptOptions {
  replicaScopeKey?: string | null;
  replicaProjectId?: string | null;
  expectedTranscriptRevision?: string | null;
  expectedMessageCount?: number | null;
}

export const getArchitectPlanChatTranscript = async (
  branchName: string,
  planId: string,
  options: ArchitectPlanChatTranscriptOptions = {},
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<{
  messages: ArchitectPlanChatMessage[];
  transcriptRevision: string | null;
  messageCount: number;
} | null> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  const replicaScopeKey = options.replicaScopeKey?.trim() || null;
  const replicaProjectId = options.replicaProjectId?.trim() || null;
  const hasHeadIdentityWithoutScope = Boolean(
    replicaProjectId ||
    options.expectedTranscriptRevision ||
    typeof options.expectedMessageCount === 'number'
  );
  if (!replicaScopeKey && hasHeadIdentityWithoutScope) {
    throw new Error(
      `Architect transcript replica identity is incomplete for branch ${normalizedBranch} and plan ${safeId}.`,
    );
  }
  const exactReplicaRequested = Boolean(replicaScopeKey);
  const runtimeAvailable = isWorkspaceArchitectRuntimeAvailable(deps);
  if (exactReplicaRequested && !runtimeAvailable) {
    throw new Error(
      `Architect runtime is unavailable for exact transcript replica ${replicaScopeKey}.`,
    );
  }

  const registrySnapshot = exactReplicaRequested
    ? null
    : await loadArchitectPlanRegistrySnapshot(deps);
  const persistedDirectPlan = exactReplicaRequested
    ? null
    : await discoverPersistedDirectPlan({
        branchName: normalizedBranch,
        planId: safeId,
        registrySnapshot,
        deps,
      });

  if (runtimeAvailable && (
    exactReplicaRequested ||
    (!persistedDirectPlan && canUseWorkspaceArchitectRuntimeForScope(registrySnapshot))
  )) {
    const transcript = await deps.tauri.workspaceArchitectActivatePlanChat({
      branchName: normalizedBranch,
      planId: safeId,
      replicaScopeKey,
      replicaProjectId,
      expectedTranscriptRevision: options.expectedTranscriptRevision,
      expectedMessageCount: options.expectedMessageCount,
    });
    if (!transcript) {
      return null;
    }
    if (
      (replicaScopeKey && transcript.replicaScopeKey !== replicaScopeKey) ||
      (replicaProjectId && transcript.replicaProjectId !== replicaProjectId) ||
      (options.expectedTranscriptRevision &&
        transcript.transcriptRevision !== options.expectedTranscriptRevision) ||
      (typeof options.expectedMessageCount === 'number' &&
        transcript.messageCount !== options.expectedMessageCount)
    ) {
      throw new Error(
        `Architect transcript identity changed for branch ${normalizedBranch} and plan ${safeId}.`,
      );
    }
    return {
      messages: mapRuntimeArchitectChatMessages(transcript.messages),
      transcriptRevision: transcript.transcriptRevision,
      messageCount: transcript.messageCount,
    };
  }

  const messages = await getArchitectPlanChatMessages(normalizedBranch, safeId, deps);
  return {
    messages,
    transcriptRevision: null,
    messageCount: messages.length,
  };
};

export const buildArchitectPlanActivationSnapshot = async (params: {
  scope: ArchitectMetadataScope;
  branchName: string;
  planId: string;
  summary?: ArchitectPlanSummary | null;
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
}): Promise<ArchitectPlanActivationSnapshot | null> => {
  const planResult = await readPlanAtScopeWithDiagnostics(
    params.scope,
    params.branchName,
    params.planId,
    params.registrySnapshot
  );
  if (!planResult.plan || planResult.plan.status === 'deleted') {
    return null;
  }

  const storedManifest = await readStoredPlanManifestAtScope(
    params.scope,
    params.branchName,
    params.planId
  );
  const fallbackProjectIds = params.summary
    ? getArchitectPlanActionableProjectIds(params.summary)
    : resolvePlanProjectIds(planResult.plan);
  const actionableProjectIds = normalizeProjectIds(planResult.plan.projectIds, planResult.plan.projectId);
  const resolvedActionableProjectIds =
    actionableProjectIds.length > 0 ? actionableProjectIds : fallbackProjectIds;
  const contextProjectIds = normalizeContextProjectIds(
    Array.isArray(storedManifest?.contextProjectIds)
      ? storedManifest.contextProjectIds
      : planResult.plan.contextProjectIds,
    resolvedActionableProjectIds,
    params.registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(
    resolvedActionableProjectIds,
    contextProjectIds
  );
  const targetBranch = normalizeBranchName(
    typeof storedManifest?.targetBranch === 'string'
      ? storedManifest.targetBranch
      : planResult.plan.targetBranch
  );
  const targetBranchesByProjectId = normalizeTargetBranchesByProjectId(
    storedManifest?.targetBranchesByProjectId,
    resolvedActionableProjectIds,
    targetBranch
  );
  const planKind = normalizeArchitectPlanKind(
    planResult.plan.planKind ||
      storedManifest?.planKind ||
      storedManifest?.gitFlowPlan?.planKind
  );
  const gitFlowPlan = normalizeArchitectPlanGitFlowMetadata({
    planKind,
    gitFlowPlan: planResult.plan.gitFlowPlan || storedManifest?.gitFlowPlan,
    projectIds: resolvedActionableProjectIds,
    fallbackSlug: planResult.plan.slug,
  });
  const updatedAt =
    typeof storedManifest?.updatedAt === 'string' && storedManifest.updatedAt.trim().length > 0
      ? storedManifest.updatedAt
      : planResult.plan.updatedAt;
  const conversationId =
    storedManifest?.conversation &&
    typeof storedManifest.conversation === 'object' &&
    typeof storedManifest.conversation.conversationId === 'string'
      ? storedManifest.conversation.conversationId
      : params.summary?.conversationId ?? planResult.plan.conversationId ?? null;
  const chatMessageCount =
    typeof params.summary?.chatMessageCount === 'number'
      ? params.summary.chatMessageCount
      : storedManifest?.conversation &&
          typeof storedManifest.conversation === 'object' &&
          typeof storedManifest.conversation.messageCount === 'number' &&
          Number.isFinite(storedManifest.conversation.messageCount) &&
          storedManifest.conversation.messageCount >= 0
        ? Math.floor(storedManifest.conversation.messageCount)
        : null;

  return {
    scope: params.scope,
    updatedAt,
    expectedProjectIds,
    conversationId,
    chatMessageCount,
    plan: {
      ...planResult.plan,
      planKind,
      gitFlowPlan,
      targetBranch,
      targetBranchesByProjectId,
      expectedProjectIds,
      contextProjectIds,
      conversationId: conversationId ?? undefined,
      revision:
        typeof storedManifest?.revision === 'number' &&
        Number.isFinite(storedManifest.revision) &&
        storedManifest.revision > 0
          ? Math.floor(storedManifest.revision)
          : planResult.plan.revision,
      updatedAt,
    },
  };
};

export const loadArchitectPlanActivationPayloadImpl = async (
  branchName: string,
  planId: string,
  options: ArchitectPlanActivationOptions,
  deps: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanActivationPayload | null> => {
  const startedAt = Date.now();
  const normalizedBranch = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const hintedSummary =
    options.summaryHint && sanitizeId(options.summaryHint.id) === safeId
      ? options.summaryHint
      : null;
  const fastPathSummary =
    hintedSummary && canUseBlankActivationSummary(hintedSummary)
      ? hintedSummary
      : null;
  if (fastPathSummary) {
    const payload: ArchitectPlanActivationPayload = {
      plan: planRecordFromActivationSummary(fastPathSummary, normalizedBranch),
      chatMessages: [],
      chatMessagesLoaded: true,
      chatTranscriptRevision: null,
      chatMessageCount: 0,
      conversationId: null,
      sharedConversation: false,
      targetBranch: normalizedBranch,
      resolutionMode: 'blank_fast_path',
    };
    logArchitectPlanActivationLoad({
      branchName: normalizedBranch,
      planId: safeId,
      resolutionMode: payload.resolutionMode,
      sharedConversation: false,
      durationMs: Date.now() - startedAt,
    });
    return payload;
  }

  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const persistedDirectPlan = await discoverPersistedDirectPlan({
    branchName: normalizedBranch,
    planId: safeId,
    registrySnapshot,
    deps,
  });
  const persistedDirectSummary: ArchitectPlanSummary | null = persistedDirectPlan
    ? {
        ...persistedDirectPlan.plan,
        nodeCount: persistedDirectPlan.plan.nodes.length,
        predictedBranchCount: persistedDirectPlan.plan.predictedBranches.length,
      }
    : null;

  if (
    !persistedDirectPlan &&
    isWorkspaceArchitectRuntimeAvailable(deps) &&
    canUseWorkspaceArchitectRuntimeForScope(
      registrySnapshot,
      options.scopedProjectIdsHint,
    )
  ) {
    const runtimePayload = await loadArchitectPlanActivationPayloadFromRuntime(
      normalizedBranch,
      safeId,
      options,
      deps,
    );
    if (runtimePayload) {
      logArchitectPlanActivationLoad({
        branchName: normalizedBranch,
        planId: safeId,
        resolutionMode: runtimePayload.resolutionMode,
        sharedConversation: runtimePayload.sharedConversation,
        durationMs: Date.now() - startedAt,
      });
    }
    return runtimePayload;
  }

  let index: ArchitectPlanIndex | null = null;
  let summary: ArchitectPlanSummary | null = hintedSummary ?? persistedDirectSummary;

  if (!persistedDirectPlan && (!summary || options.allowIndexFallback !== false)) {
    index = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
    summary =
      summary ??
      index.plans.find((candidate) => candidate.id === safeId) ??
      null;
  }

  const blankSummary =
    summary && canUseBlankActivationSummary(summary) ? summary : null;
  if (blankSummary) {
    const payload: ArchitectPlanActivationPayload = {
      plan: planRecordFromActivationSummary(blankSummary, normalizedBranch),
      chatMessages: [],
      chatMessagesLoaded: true,
      chatTranscriptRevision: null,
      chatMessageCount: 0,
      conversationId: null,
      sharedConversation: false,
      targetBranch: normalizedBranch,
      resolutionMode: 'blank_fast_path',
    };
    logArchitectPlanActivationLoad({
      branchName: normalizedBranch,
      planId: safeId,
      resolutionMode: payload.resolutionMode,
      sharedConversation: false,
      durationMs: Date.now() - startedAt,
    });
    return payload;
  }
  const scopedProjectIds = Array.from(
    new Set(
      (
        options.scopedProjectIdsHint?.length
          ? options.scopedProjectIdsHint
          : summary
            ? getArchitectPlanVisibleProjectIds(summary)
            : []
      )
        .map((projectId) => projectId.trim())
        .filter((projectId) => projectId.length > 0)
    )
  );
  const scopes = persistedDirectPlan?.scopes ?? await resolveMetadataScopes(
    scopedProjectIds.length > 0 ? scopedProjectIds : undefined,
    {
      includeAllKnown: !summary && scopedProjectIds.length === 0,
      includeWorkspaceFallback: true,
    },
    registrySnapshot,
    deps
  );
  const snapshots = (
    await Promise.all(
      scopes.map((scope) =>
        buildArchitectPlanActivationSnapshot({
          scope,
          branchName: normalizedBranch,
          planId: safeId,
          summary,
          registrySnapshot,
        })
      )
    )
  ).filter((snapshot): snapshot is ArchitectPlanActivationSnapshot => snapshot !== null);

  if (snapshots.length === 0) {
    return null;
  }

  const canonicalSnapshot = pickCanonicalReplica(
    snapshots.map((snapshot) => ({
      ...snapshot,
      repoPath: snapshot.scope.repoPath,
    })),
    'newest'
  );
  const scope = normalizeArchitectPlanScope(canonicalSnapshot.plan, {
    useExpectedAsActionableFallback: true,
  });
  const expectedProjectIds = scope.expectedProjectIds;
  const availableProjectIds = Array.from(
    new Set(
      snapshots.flatMap((snapshot) => {
        if (
          snapshot.scope.source === 'local' &&
          expectedProjectIds.length > 0 &&
          !registrySnapshot?.hasRegisteredProjects
        ) {
          return expectedProjectIds;
        }

        const scopedProjectId = resolveScopeProjectId(snapshot.scope, registrySnapshot) || '';
        return scopedProjectId && expectedProjectIds.includes(scopedProjectId)
          ? [scopedProjectId]
          : [];
      })
    )
  );
  const missingProjectIds = expectedProjectIds.filter(
    (projectId) => !availableProjectIds.includes(projectId)
  );
  const plan = {
    ...canonicalSnapshot.plan,
    projectId: scope.actionableProjectIds[0] ?? canonicalSnapshot.plan.projectId,
    projectIds: scope.actionableProjectIds,
    contextProjectIds: scope.contextProjectIds,
    expectedProjectIds,
    availableProjectIds,
    missingProjectIds,
    replicationState:
      canonicalSnapshot.plan.status === 'deleted'
        ? 'deleted'
        : missingProjectIds.length > 0
          ? 'missing_projects'
          : 'healthy',
  } satisfies ArchitectPlanRecord;
  const chatMessageCountHint =
    typeof summary?.chatMessageCount === 'number'
      ? summary.chatMessageCount
      : canonicalSnapshot.chatMessageCount;
  const chatMessages = await (
    chatMessageCountHint === 0
      ? Promise.resolve([] as ArchitectPlanChatMessage[])
      : readPlanChatAtScope(canonicalSnapshot.scope, normalizedBranch, safeId)
  );
  const conversationId = canonicalSnapshot.conversationId ?? null;
  const payload: ArchitectPlanActivationPayload = {
    plan,
    chatMessages,
    chatMessagesLoaded: true,
    chatTranscriptRevision: null,
    chatMessageCount: chatMessages.length,
    conversationId,
    sharedConversation: Boolean(
      conversationId &&
        index?.plans.some(
          (candidate) =>
            candidate.id !== safeId &&
            candidate.status !== 'deleted' &&
            candidate.conversationId === conversationId
        )
    ),
    targetBranch: normalizedBranch,
    resolutionMode: 'full',
  };

  logArchitectPlanActivationLoad({
    branchName: normalizedBranch,
    planId: safeId,
    resolutionMode: payload.resolutionMode,
    sharedConversation: payload.sharedConversation,
    durationMs: Date.now() - startedAt,
  });

  return payload;
};

export const getArchitectPlanActivationPayload = async (
  branchName: string,
  planId: string,
  options: ArchitectPlanActivationOptions = {},
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanActivationPayload | null> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);

  if (isWorkspaceArchitectRuntimeAvailable(deps)) {
    return await loadArchitectPlanActivationPayloadImpl(
      normalizedBranch,
      planId,
      options,
      deps
    );
  }

  const cacheKey = `${getArchitectPlanActivationCacheKey(
    normalizedBranch,
    planId,
    getArchitectPlanActivationSummarySignature(options.summaryHint),
    getArchitectPlanActivationScopeSignature(options.scopedProjectIdsHint),
  )}::${getArchitectPlanCacheScope(deps)}`;

  return await loadCachedArchitectPlanValue({
    cache: architectPlanActivationCache,
    cacheKey,
    ttlMs: ARCHITECT_PLAN_ACTIVATION_CACHE_TTL_MS,
    loader: async () =>
      await loadArchitectPlanActivationPayloadImpl(
        normalizedBranch,
        planId,
        options,
        deps
      ),
  });
};

export const assertPlanReplicaSetWritable = (
  replicaSet: ArchitectPlanReplicaSet,
  action: string
): void => {
  if (replicaSet.canonical.plan.status === 'archived') {
    throw new Error(
      `Cannot ${action} archived plan ${replicaSet.canonical.plan.id}. Restore the plan before editing it.`
    );
  }

  const missingProjectIds = replicaSet.canonical.plan.missingProjectIds || [];
  if (missingProjectIds.length === 0) {
    return;
  }

  throw new Error(
    `Cannot ${action} plan ${replicaSet.canonical.plan.id} while expected project replicas are missing: ${missingProjectIds.join(', ')}.`
  );
};

export interface ListArchitectPlansOptions {
  scopedProjectIdsHint?: string[];
  requestId?: string;
}

export const listArchitectPlans = async (
  branchName: string,
  includeDeleted = false,
  includeArchived = false,
  options: ListArchitectPlansOptions = {},
): Promise<{
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
}> => {
  const deps = resolveArchitectPlanServiceDependencies();
  return listArchitectPlansWithDeps(branchName, includeDeleted, includeArchived, deps, options);
};

export const listArchitectPlansWithDeps = async (
  branchName: string,
  includeDeleted = false,
  includeArchived = false,
  deps: ResolvedArchitectPlanServiceDependencies,
  options: ListArchitectPlansOptions = {},
): Promise<{
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
}> => {
  await recoverArchitectPlanReplicaMutations(deps);
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const index = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
  const hasPersistedDirectPlan = index.plans.some((plan) =>
    Object.values(plan.executionModesByProjectId ?? {}).includes('direct')
  );

  if (isWorkspaceArchitectRuntimeAvailable(deps) &&
      canUseWorkspaceArchitectRuntimeForScope(registrySnapshot, options.scopedProjectIdsHint) &&
      !hasPersistedDirectPlan) {
    try {
      const runtimeList = await deps.tauri.workspaceArchitectListPlans({
        branchName: normalizedBranch,
        includeDeleted,
        includeArchived,
        scopedProjectIdsHint: options.scopedProjectIdsHint,
        requestId: options.requestId,
      });
      return {
        activePlanId: runtimeList.activePlanId,
        plans: runtimeList.plans.map((summary) =>
          mapRuntimeArchitectPlanSummary(normalizedBranch, summary)
        ),
      };
    } catch (error) {
      devLogger.warn(
        JSON.stringify({
          event: 'architect_plan_runtime_list_fallback',
          at: new Date().toISOString(),
          branchName: normalizedBranch,
          error: toErrorMessage(error),
        })
      );
    }
  }

  const plans = index.plans.filter((plan) => {
    if (!includeDeleted && plan.status === 'deleted') return false;
    if (!includeArchived && plan.status === 'archived') return false;
    return true;
  });
  return {
    activePlanId: index.activePlanId,
    plans,
  };
};

export const isArchitectPlanSlugAvailable = async (params: {
  branchName: string;
  slug: string;
  excludePlanId?: string | null;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<boolean> => {
  const normalizedBranch = normalizeBranchName(params.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const normalizedSlug = slugifyPlanTitle(params.slug);
  const normalizedExcludePlanId = params.excludePlanId ? sanitizeId(params.excludePlanId) : null;
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const index = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
  const currentSlugForExcludedPlan =
    index.plans.find((plan) => plan.id === normalizedExcludePlanId)?.slug || null;

  if (
    index.plans.some(
      (plan) =>
        plan.id !== normalizedExcludePlanId &&
        slugifyPlanTitle(plan.slug || plan.title || plan.id) === normalizedSlug
    )
  ) {
    return false;
  }

  return !index.reservedPlanSlugs.some(
    (slug) =>
      slugifyPlanTitle(slug) === normalizedSlug &&
      slugifyPlanTitle(currentSlugForExcludedPlan || '') !== normalizedSlug
  );
};

/** Read existing plan replicas without recovery or automatic metadata repair. */
export const readArchitectPlanSnapshot = async (
  branchName: string, planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies(),
): Promise<ArchitectPlanRecord | null> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, planId, {
    registrySnapshot, disableAutoHeal: true, metadataOnly: true,
  }, deps);
  return replicaSet?.canonical.plan || null;
};

export const getArchitectPlan = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanRecord | null> => {
  await recoverArchitectPlanReplicaMutations(deps);
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, planId, {
    registrySnapshot,
  }, deps);
  return replicaSet?.canonical.plan || null;
};

export type CreateArchitectPlanInput = {
  branchName: string;
  title?: string;
  label?: string;
  slug?: string;
  description?: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: Partial<ArchitectPlanGitFlowMetadata>;
  conversationId?: string;
  projectId?: string;
  projectIds?: string[];
  contextProjectIds?: string[];
  targetBranchesByProjectId?: Record<string, string>;
  status?: ArchitectPlanStatus;
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  planId?: string;
  setActive?: boolean;
};

export const getArchitectPlanChatMessages = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanChatMessage[]> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, planId, {
    registrySnapshot,
  }, deps);
  if (!replicaSet) {
    throwPlanMetadataMissing(normalizedBranch, planId);
  }
  return readPlanChatAtScope(replicaSet.canonical.scope, normalizedBranch, sanitizeId(planId));
};

export const listPlanRelativeFilesAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<string[]> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return [];
  }

  try {
    const planDir = getPlanDir(branchName, planId);
    const entries = await tauriIpc.fsListDir({
      path: planDir,
      recursive: true,
      includeHidden: true,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });
    return entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.relative_path.replace(/\\/g, '/').replace(/^\/+/, ''));
  } catch {
    return [];
  }
};

export const inspectArchitectPlanMetadataHealth = async (input: {
  branchName: string;
  planId: string;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanMetadataHealth> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  const safeId = sanitizeId(input.planId);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
    allowDivergence: true,
    registrySnapshot,
  }, deps);

  if (replicaSet) {
    const hasMissingReplica = replicaSet.replicas.some((replica) => replica.missing);
    const status: ArchitectPlanMetadataHealthStatus = replicaSet.hasReplicaDivergence
      ? 'diverged'
      : hasMissingReplica
        ? 'missing_replica'
        : 'healthy';
    return {
      branchName: normalizedBranch,
      planId: safeId,
      status,
      replicas: replicaSet.replicas,
      orphanedReplicas: [],
      technicalMessage:
        status === 'healthy'
          ? null
          : `Plan ${safeId} metadata health is ${status}.`,
    };
  }

  const scopes = await resolveMetadataScopes(
    undefined,
    { includeAllKnown: true },
    registrySnapshot,
    deps
  );
  const orphanedReplicas = (
    await Promise.all(
      scopes.map(async (scope) => {
        const files = await listPlanRelativeFilesAtScope(scope, normalizedBranch, safeId);
        if (files.length === 0 || files.includes('plan.json')) {
          return null;
        }
        return toReplicaDescriptor(scope, null, true);
      })
    )
  ).filter((replica): replica is ArchitectPlanReplica => replica !== null);

  return {
    branchName: normalizedBranch,
    planId: safeId,
    status: orphanedReplicas.length > 0 ? 'runtime_orphan' : 'missing',
    replicas: orphanedReplicas,
    orphanedReplicas,
    technicalMessage:
      orphanedReplicas.length > 0
        ? `Plan ${safeId} has orphaned metadata files without plan.json.`
        : `Plan ${safeId} metadata was not found.`,
  };
};

export const listArchitectPlanTargetBranches = async (): Promise<string[]> =>
  listArchitectPlanTargetBranchesImpl(resolveArchitectPlanServiceDependencies());

/** Queries and activation snapshots without a store or UI dependency. */
export interface ArchitectPlanReadService {
  listArchitectPlanTargetBranches: () => Promise<string[]>;
  listArchitectPlans: typeof listArchitectPlans;
  isArchitectPlanSlugAvailable: typeof isArchitectPlanSlugAvailable;
  getArchitectPlanActivationPayload: typeof getArchitectPlanActivationPayload;
  getArchitectPlan: typeof getArchitectPlan;
  getArchitectPlanChatMessages: typeof getArchitectPlanChatMessages;
  getArchitectPlanChatTranscript: typeof getArchitectPlanChatTranscript;
  inspectArchitectPlanMetadataHealth: typeof inspectArchitectPlanMetadataHealth;
}

export const createArchitectPlanReadService = (overrides: ArchitectPlanServiceDependencies = {}): ArchitectPlanReadService => {
  const deps = resolveArchitectPlanServiceDependencies(overrides);
  return {
    listArchitectPlanTargetBranches: () => listArchitectPlanTargetBranchesImpl(deps),
    listArchitectPlans: (branchName, includeDeleted, includeArchived, options) =>
      listArchitectPlansWithDeps(branchName, includeDeleted, includeArchived, deps, options),
    isArchitectPlanSlugAvailable: (params) => isArchitectPlanSlugAvailable(params, deps),
    getArchitectPlanActivationPayload: (branchName, planId, options) =>
      getArchitectPlanActivationPayload(branchName, planId, options, deps),
    getArchitectPlan: (branchName, planId) => getArchitectPlan(branchName, planId, deps),
    getArchitectPlanChatMessages: (branchName, planId) =>
      getArchitectPlanChatMessages(branchName, planId, deps),
    getArchitectPlanChatTranscript: (branchName, planId, options) =>
      getArchitectPlanChatTranscript(branchName, planId, options, deps),
    inspectArchitectPlanMetadataHealth: (input) => inspectArchitectPlanMetadataHealth(input, deps),
  };
};
