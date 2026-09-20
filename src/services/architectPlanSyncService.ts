import { getArchitectPlanMetadataCoordinatorDeps } from './architectPlanReadContext';
import type { ArchitectPlanServiceDependencies } from './architectPlanReadContext';
import { type ValidProjectRegistrySnapshot } from './validProjectRegistry';
import { flushMacroMetadata, recordMacroMetadataMutation } from './macroMetadataCoordinator';
import {
  dedupeScopes,
  getScopeWorkspaceScope,
  invalidateArchitectPlanRuntimeCaches,
  loadArchitectPlanRegistrySnapshot,
  resolveArchitectPlanServiceDependencies,
  resolveMetadataScopes,
  type ResolvedArchitectPlanServiceDependencies,
} from './architectPlanReadContext';
import {
  arePlanChatMessagesEquivalent,
  assertGitFlowTargetBranch,
  buildTaskExecutedMarkdown,
  getTaskExecutedPath,
  normalizeBranchName,
  parseJsonLines,
  pickCanonicalReplica,
  sanitizeId,
  stripPlanReplicaMetadata,
  throwPlanMetadataMissing,
  type ArchitectPlanChatMessage,
  type ArchitectPlanMetadataRepairResult,
  type ArchitectPlanRecord,
  type ArchitectPlanReplicaRepairStrategy,
  type ArchitectPlanReplicaSet,
  type ArchitectTaskExecutionRecord,
} from './architectPlanReadModel';
import {
  buildRemoveReplicaMutationTarget,
  buildUpsertReplicaMutationTarget,
  commitMetadataScopes,
  enqueueArchitectPlanMutation,
  getPlanExecutionModes,
  runArchitectPlanReplicaMutation,
} from './architectPlanMutationPersistence';
import {
  assertPlanReplicaSetWritable,
  getArchitectPlan,
  inspectArchitectPlanMetadataHealth,
  loadPlanReplicaSet,
} from './architectPlanReadService';
import { normalizePlanRecordForBranch, readPlanChatAtScope } from './architectPlanReplicaStorage';

export const commitArchitectPlanMetadata = async (input: {
  branchName: string;
  planId: string;
  commitMessage: string;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<void> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      allowDivergence: true,
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }

    const executionModesByProjectId = getPlanExecutionModes(
      replicaSet.canonical.plan,
      registrySnapshot,
    );
    const persistedModes = Object.values(executionModesByProjectId);
    const metadataScopes = dedupeScopes([
        ...replicaSet.expectedScopes,
        ...replicaSet.snapshots.map((snapshot) => snapshot.scope),
      ]).filter((scope) => {
        if (scope.projectId) {
          return executionModesByProjectId[scope.projectId] === 'git';
        }
        return persistedModes.some((mode) => mode === 'git');
      });

    await commitMetadataScopes(
      metadataScopes,
      input.commitMessage,
      { commit: true },
      deps
    );
  });
};

export const saveArchitectPlanChatMessagesWithReplicaSet = async (params: {
  normalizedBranch: string;
  safeId: string;
  messages: ArchitectPlanChatMessage[];
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
  replicaSet: ArchitectPlanReplicaSet;
  deps: ResolvedArchitectPlanServiceDependencies;
  action?: string;
}): Promise<void> => {
  const {
    normalizedBranch,
    safeId,
    messages,
    registrySnapshot,
    replicaSet,
    deps,
    action = 'save chat transcript',
  } = params;
  assertPlanReplicaSetWritable(replicaSet, action);
  const nextMessages = messages.map((message) => ({ ...message }));
  const persistedMessages =
    replicaSet.canonical.scope.source === 'local'
      ? await readPlanChatAtScope(replicaSet.canonical.scope, normalizedBranch, safeId)
      : parseJsonLines(replicaSet.canonical.files['chat.jsonl'] || '');
  if (arePlanChatMessagesEquivalent(persistedMessages, nextMessages)) {
    return;
  }
  const nextPlan = {
    ...replicaSet.canonical.plan,
    updatedAt: new Date().toISOString(),
    revision: (replicaSet.canonical.plan.revision || 1) + 1,
  };
  const targets = await Promise.all(dedupeScopes(replicaSet.expectedScopes).map((scope) =>
    buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: nextPlan,
      registrySnapshot,
      chatMessages: nextMessages,
      chatMessageCount: nextMessages.length,
    })
  ));
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: safeId,
    operation: 'chat',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): update architect plan chat ${safeId}`,
  });
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: safeId,
  });
};

export const saveArchitectPlanChatMessages = async (
  branchName: string,
  planId: string,
  messages: ArchitectPlanChatMessage[],
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<void> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    await saveArchitectPlanChatMessagesWithReplicaSet({
      normalizedBranch,
      safeId,
      messages,
      registrySnapshot,
      replicaSet,
      deps,
    });
  });
};

export const syncArchitectPlanChatFromConversation = async (params: {
  branchName: string;
  planId: string;
  conversationId?: string | null;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<void> => {
  if (!deps.tauri.isTauriAvailable()) {
    return;
  }

  const normalizedBranch = normalizeBranchName(params.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(params.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    assertPlanReplicaSetWritable(replicaSet, 'sync chat transcript');

    if (params.conversationId && replicaSet.canonical.plan.conversationId !== params.conversationId) {
      throw new Error('La conversation ne correspond plus au plan Architect.');
    }
    const conversationId = params.conversationId ?? replicaSet.canonical.plan.conversationId ?? null;
    if (!conversationId) {
      await saveArchitectPlanChatMessagesWithReplicaSet({
        normalizedBranch,
        safeId,
        messages: [],
        registrySnapshot,
        replicaSet,
        deps,
        action: 'sync chat transcript',
      });
      return;
    }

    const dbMessages = await deps.tauri.listMessages(conversationId);
    const transcript = dbMessages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        id: message.id,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        createdAt: message.created_at,
      }));

    await saveArchitectPlanChatMessagesWithReplicaSet({
      normalizedBranch,
      safeId,
      messages: transcript,
      registrySnapshot,
      replicaSet,
      deps,
      action: 'sync chat transcript',
    });
  });
};

export const repairArchitectPlanReplicas = async (input: {
  branchName: string;
  planId: string;
  strategy: ArchitectPlanReplicaRepairStrategy;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, input.planId, {
    allowDivergence: true,
    registrySnapshot,
  }, deps);
  if (!replicaSet) {
    throwPlanMetadataMissing(normalizedBranch, input.planId);
  }

  const canonicalSnapshot = pickCanonicalReplica(
    replicaSet.snapshots.map((snapshot) => ({
      ...snapshot,
      updatedAt: snapshot.plan.updatedAt,
      repoPath: snapshot.scope.repoPath,
    })),
    input.strategy
  );
  const canonicalPlan = normalizePlanRecordForBranch(
    normalizedBranch,
    canonicalSnapshot.plan.id,
    {
      ...stripPlanReplicaMetadata(canonicalSnapshot.plan),
      updatedAt: new Date().toISOString(),
      revision: (canonicalSnapshot.plan.revision || canonicalSnapshot.manifest.revision || 1) + 1,
    },
    registrySnapshot,
    {
      logContext: 'replica_repair',
    }
  );
  if (!canonicalPlan) {
    throwPlanMetadataMissing(normalizedBranch, input.planId);
  }

  const replicatedExtraFiles = Object.entries(canonicalSnapshot.files)
    .filter(([relativePath]) => relativePath.startsWith('artifacts/'));
  const canonicalMessages = parseJsonLines(canonicalSnapshot.files['chat.jsonl'] || '');
  const extraFiles = Object.fromEntries(replicatedExtraFiles);
  const targets = await Promise.all(dedupeScopes(replicaSet.expectedScopes).map((scope) =>
    buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: canonicalPlan,
      registrySnapshot,
      chatMessages: canonicalMessages,
      chatMessageCount: canonicalMessages.length,
      replacePlanDirectory: true,
      extraFiles,
    })
  ));
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: canonicalPlan.id,
    operation: 'repair',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): repair architect plan ${canonicalPlan.id}`,
  });

  const repairedReplicaSet = await loadPlanReplicaSet(normalizedBranch, canonicalPlan.id, {
    registrySnapshot,
  }, deps);
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: canonicalPlan.id,
  });
  const repaired = repairedReplicaSet?.canonical.plan || null;
  if (!repaired) {
    throwPlanMetadataMissing(normalizedBranch, input.planId);
  }
  return repaired;
  });
};

export const repairArchitectPlanMetadata = async (input: {
  branchName: string;
  planId: string;
  strategy?: ArchitectPlanReplicaRepairStrategy;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanMetadataRepairResult> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  const safeId = sanitizeId(input.planId);
  assertGitFlowTargetBranch(normalizedBranch);
  const health = await inspectArchitectPlanMetadataHealth({
    branchName: normalizedBranch,
    planId: safeId,
  }, deps);

  if (health.status === 'healthy') {
    return {
      branchName: normalizedBranch,
      planId: safeId,
      statusBeforeRepair: health.status,
      removedOrphanedReplicas: [],
      repairedPlan: await getArchitectPlan(normalizedBranch, safeId, deps),
    };
  }

  if (health.status === 'diverged' || health.status === 'missing_replica') {
    return {
      branchName: normalizedBranch,
      planId: safeId,
      statusBeforeRepair: health.status,
      removedOrphanedReplicas: [],
      repairedPlan: await repairArchitectPlanReplicas({
        branchName: normalizedBranch,
        planId: safeId,
        strategy: input.strategy ?? 'newest',
      }, deps),
    };
  }

  if (health.status !== 'runtime_orphan') {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }

  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const scopes = await resolveMetadataScopes(
      undefined,
      { includeAllKnown: true },
      registrySnapshot,
      deps
    );
    const orphanScopeKeys = new Set(health.orphanedReplicas.map((replica) => replica.scopeKey));
    const removedScopes = scopes.filter((scope) => orphanScopeKeys.has(scope.scopeKey));

    if (removedScopes.length > 0) {
      const targets = await Promise.all(removedScopes.map((scope) => buildRemoveReplicaMutationTarget({
        scope,
        branchName: normalizedBranch,
        planId: safeId,
        registrySnapshot,
      })));
      await runArchitectPlanReplicaMutation({
        branchName: normalizedBranch,
        planId: safeId,
        operation: 'orphan_cleanup',
        targets,
        registrySnapshot,
        deps,
        commitMessage: `chore(metadata): remove orphaned architect plan ${safeId}`,
      });
    }

    invalidateArchitectPlanRuntimeCaches({
      branchName: normalizedBranch,
      planId: safeId,
    });

    return {
      branchName: normalizedBranch,
      planId: safeId,
      statusBeforeRepair: health.status,
      removedOrphanedReplicas: health.orphanedReplicas,
      repairedPlan: null,
    };
  });
};

export const writeArchitectTaskExecution = async (params: {
  branchName: string;
  planId: string;
  execution: ArchitectTaskExecutionRecord;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<void> => {
  const normalizedBranch = normalizeBranchName(params.branchName);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, params.planId, {
    registrySnapshot,
  }, deps);
  if (!replicaSet) {
    throwPlanMetadataMissing(normalizedBranch, params.planId);
  }
  if (!deps.tauri.isTauriAvailable()) return;

  await Promise.all(
    dedupeScopes(replicaSet.expectedScopes).map((scope) =>
      deps.tauri.fsWriteFile({
        path: getTaskExecutedPath(normalizedBranch, replicaSet.canonical.plan.id, params.execution.taskId),
        content: buildTaskExecutedMarkdown(replicaSet.canonical.plan, params.execution),
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: getScopeWorkspaceScope(scope),
        workspacePath: scope.workspacePath,
      })
    )
  );

  const executionModesByProjectId = getPlanExecutionModes(
    replicaSet.canonical.plan,
    registrySnapshot,
  );
  const persistedModes = Object.values(executionModesByProjectId);
  const taskExecutionWorkspacePaths: string[] = [];
  for (const scope of dedupeScopes(replicaSet.expectedScopes)) {
    if (scope.source === 'local' || !scope.workspacePath) continue;
    const shouldSyncGitMetadata = scope.projectId
      ? executionModesByProjectId[scope.projectId] === 'git'
      : persistedModes.includes('git');
    if (!shouldSyncGitMetadata) continue;
    taskExecutionWorkspacePaths.push(scope.workspacePath);
    recordMacroMetadataMutation({
      workspacePath: scope.workspacePath,
      kind: 'task_metadata',
      entityId: params.execution.taskId,
      label: params.execution.taskId,
      importance: 'light',
    }, getArchitectPlanMetadataCoordinatorDeps(deps));
  }
  if (taskExecutionWorkspacePaths.length > 0) {
    await flushMacroMetadata({
      trigger: 'explicit_checkpoint',
      workspacePaths: taskExecutionWorkspacePaths,
      message: `chore(@macro): update task metadata ${params.execution.taskId}`,
    }, getArchitectPlanMetadataCoordinatorDeps(deps));
  }
};

/** Transcript, replica repair and metadata synchronization without a store or UI dependency. */
export interface ArchitectPlanSyncService {
  commitArchitectPlanMetadata: typeof commitArchitectPlanMetadata;
  saveArchitectPlanChatMessages: typeof saveArchitectPlanChatMessages;
  syncArchitectPlanChatFromConversation: typeof syncArchitectPlanChatFromConversation;
  repairArchitectPlanReplicas: typeof repairArchitectPlanReplicas;
  repairArchitectPlanMetadata: typeof repairArchitectPlanMetadata;
  writeArchitectTaskExecution: typeof writeArchitectTaskExecution;
}

export const createArchitectPlanSyncService = (overrides: ArchitectPlanServiceDependencies = {}): ArchitectPlanSyncService => {
  const deps = resolveArchitectPlanServiceDependencies(overrides);
  return {
    commitArchitectPlanMetadata: (input) => commitArchitectPlanMetadata(input, deps),
    saveArchitectPlanChatMessages: (branchName, planId, messages) =>
      saveArchitectPlanChatMessages(branchName, planId, messages, deps),
    syncArchitectPlanChatFromConversation: (params) => syncArchitectPlanChatFromConversation(params, deps),
    repairArchitectPlanReplicas: (input) => repairArchitectPlanReplicas(input, deps),
    repairArchitectPlanMetadata: (input) => repairArchitectPlanMetadata(input, deps),
    writeArchitectTaskExecution: (params) => writeArchitectTaskExecution(params, deps),
  };
};
