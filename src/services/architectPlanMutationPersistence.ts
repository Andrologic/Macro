import { getArchitectPlanMetadataCoordinatorDeps } from './architectPlanReadContext';
import * as tauriIpc from './tauriIpc';
import { normalizeProjectRegistryPath, type ValidProjectRegistrySnapshot } from './validProjectRegistry';
import {
  flushMacroMetadata,
  recordMacroMetadataMutation,
  type MacroMetadataMutationKind,
} from './macroMetadataCoordinator';
import { getPlanExecutionModesByProjectId } from './planExecutionModes';
import {
  createArchitectPlanMutationId,
  loadArchitectPlanMutationJournal,
  quarantineArchitectPlanMutationJournal,
  removeArchitectPlanMutationJournal,
  upsertArchitectPlanMutationJournal,
  type ArchitectPlanMutationJournalEntry,
} from './architectPlanMutationJournal';
import {
  getPlanDir,
  normalizeBranchName,
  sanitizeId,
  slugifyPlanTitle,
  toErrorMessage,
  toSummary,
  type ArchitectMetadataScope,
  type ArchitectPlanChatMessage,
  type ArchitectPlanIndex,
  type ArchitectPlanRecord,
  upsertSummary,
} from './architectPlanReadModel';
import {
  readIndexAtScope,
  removePlanAtScope,
  writeIndexAtScope,
  writePlanAtScope,
  writePlanChatAtScope,
} from './architectPlanReplicaStorage';
import {
  dedupeScopes,
  getScopeWorkspaceScope,
  loadArchitectPlanRegistrySnapshot,
  resolveArchitectPlanServiceDependencies,
  type ResolvedArchitectPlanServiceDependencies,
} from './architectPlanReadContext';

export const architectPlanMutationQueues = new Map<string, Promise<void>>();

export const getArchitectPlanMutationQueueKey = (branchName: string, _planId: string): string =>
  normalizeBranchName(branchName);

export const enqueueArchitectPlanMutation = async <T>(
  branchName: string,
  planId: string,
  mutation: () => Promise<T>
): Promise<T> => {
  const queueKey = getArchitectPlanMutationQueueKey(branchName, planId);
  const previous = architectPlanMutationQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(mutation);
  const stored = run.then(
    () => undefined,
    () => undefined
  );
  architectPlanMutationQueues.set(queueKey, stored);

  try {
    return await run;
  } finally {
    if (architectPlanMutationQueues.get(queueKey) === stored) {
      architectPlanMutationQueues.delete(queueKey);
    }
  }
};

export const enqueueArchitectPlanCreation = async <T>(
  branchName: string,
  creation: () => Promise<T>
): Promise<T> => {
  const queueKey = normalizeBranchName(branchName);
  const previous = architectPlanMutationQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(creation);
  const stored = run.then(
    () => undefined,
    () => undefined
  );
  architectPlanMutationQueues.set(queueKey, stored);

  try {
    return await run;
  } finally {
    if (architectPlanMutationQueues.get(queueKey) === stored) {
      architectPlanMutationQueues.delete(queueKey);
    }
  }
};

export interface ArchitectPlanReplicaMutationTarget {
  scope: ArchitectMetadataScope;
  action: 'upsert' | 'remove' | 'index';
  plan: ArchitectPlanRecord | null;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  index: ArchitectPlanIndex;
  chatMessages?: ArchitectPlanChatMessage[];
  replacePlanDirectory?: boolean;
  extraFiles?: Record<string, string>;
}

export interface ArchitectPlanReplicaMutationPayload {
  targets: ArchitectPlanReplicaMutationTarget[];
  commitMessage: string;
}

export const isReplicaMutationPayload = (
  entry: ArchitectPlanMutationJournalEntry,
): entry is ArchitectPlanMutationJournalEntry<ArchitectPlanReplicaMutationPayload> => {
  const payload = entry.payload;
  const candidate = payload as Partial<ArchitectPlanReplicaMutationPayload>;
  const scopeKeys = new Set<string>();
  return entry.branchName === normalizeBranchName(entry.branchName) && entry.planId === sanitizeId(entry.planId) &&
    typeof candidate.commitMessage === 'string' && candidate.commitMessage.trim().length > 0 &&
    Array.isArray(candidate?.targets) && candidate.targets.length > 0 && candidate.targets.every((target) => {
    const scope = target?.scope;
    const validScope = !!scope && typeof scope.scopeKey === 'string' && scope.scopeKey.length > 0 &&
      !scopeKeys.has(scope.scopeKey) && (scope.source === 'local' || scope.source === 'project' || scope.source === 'workspace') &&
      (scope.projectId === null || typeof scope.projectId === 'string') &&
      (scope.repoPath === null || typeof scope.repoPath === 'string') &&
      (scope.workspacePath === null || typeof scope.workspacePath === 'string');
    if (validScope) scopeKeys.add(scope.scopeKey);
    return validScope &&
    !!target && (target.action === 'upsert' || target.action === 'remove' || target.action === 'index') &&
    !!target.index && (target.index.version === 2 || target.index.version === 3) &&
    Array.isArray(target.index.plans) && target.index.plans.every((summary) =>
      !!summary && typeof summary.id === 'string' && typeof summary.targetBranch === 'string'
    ) && Array.isArray(target.index.reservedPlanSlugs) &&
    (target.action === 'remove'
      ? target.plan === null && !target.index.plans.some((summary) => summary.id === entry.planId)
      : target.action === 'index'
        ? target.plan === null
        : !!target.plan && target.plan.id === entry.planId && target.plan.targetBranch === entry.branchName &&
          target.index.plans.some((summary) => summary.id === entry.planId)) &&
    (target.executionModesByProjectId === undefined || (
      target.executionModesByProjectId !== null &&
      typeof target.executionModesByProjectId === 'object' &&
      Object.entries(target.executionModesByProjectId).every(([projectId, mode]) =>
        projectId.length > 0 && (mode === 'git' || mode === 'direct')
      )
    )) && (target.chatMessages === undefined || (Array.isArray(target.chatMessages) && target.chatMessages.every((message) =>
      !!message && typeof message.id === 'string' && (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' && typeof message.createdAt === 'string'
    ))) && (target.replacePlanDirectory === undefined || typeof target.replacePlanDirectory === 'boolean') &&
    (target.extraFiles === undefined || (target.extraFiles !== null && typeof target.extraFiles === 'object' &&
      Object.entries(target.extraFiles).every(([path, content]) =>
        path.startsWith('artifacts/') && !path.includes('..') && !path.includes('\\') &&
        typeof content === 'string'
      )));
  });
};

export const getMutationTargetExecutionModes = (
  target: ArchitectPlanReplicaMutationTarget,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
): Record<string, 'git' | 'direct'> =>
  target.executionModesByProjectId ??
  (target.plan ? getPlanExecutionModes(target.plan, registrySnapshot) : {});

export const shouldCommitMutationTarget = (
  target: ArchitectPlanReplicaMutationTarget,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
): boolean => {
  const modesByProjectId = getMutationTargetExecutionModes(target, registrySnapshot);
  if (target.scope.projectId) {
    return modesByProjectId[target.scope.projectId] === 'git';
  }
  return Object.values(modesByProjectId).some((mode) => mode === 'git');
};

export const getPlanExecutionModes = (
  plan: ArchitectPlanRecord,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
): Record<string, 'git' | 'direct'> => {
  const projectIds = new Set(plan.projectIds ?? []);
  const modes = Object.fromEntries(
    Object.entries(plan.executionModesByProjectId ?? {}).filter(
      ([projectId, mode]) => projectIds.has(projectId) && (mode === 'git' || mode === 'direct'),
    ),
  ) as Record<string, 'git' | 'direct'>;
  const nodeModes = getPlanExecutionModesByProjectId(plan.nodes);
  for (const [projectId, mode] of Object.entries(nodeModes)) {
    if (!modes[projectId]) modes[projectId] = mode;
  }
  for (const projectId of plan.projectIds ?? []) {
    if (modes[projectId]) continue;
    const observedMode = registrySnapshot?.executionModeByProjectId.get(projectId);
    if (observedMode === 'git' || observedMode === 'direct') {
      modes[projectId] = observedMode;
    }
  }
  return modes;
};

export const getReplicaMutationWorkspaceKey = (targets: ArchitectPlanReplicaMutationTarget[]): string => {
  const roots = Array.from(new Set(targets.map((target) =>
    normalizeProjectRegistryPath(target.scope.workspacePath || target.scope.repoPath) || `local:${target.scope.scopeKey}`
  ))).sort();
  return roots.join('|');
};

export const getRegistryWorkspaceKey = (
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
  targets: ArchitectPlanReplicaMutationTarget[],
): string => {
  const roots = Array.from(new Set([
    ...Array.from(registrySnapshot?.workspacePathByProjectId.values() || []),
    ...Array.from(registrySnapshot?.repoPathByProjectId.values() || []),
  ]))
    .map(normalizeProjectRegistryPath).filter((value): value is string => !!value).sort();
  return roots.length > 0 ? roots.join('|') : getReplicaMutationWorkspaceKey(targets);
};

export const applyArchitectPlanReplicaMutation = async (
  entry: ArchitectPlanMutationJournalEntry<ArchitectPlanReplicaMutationPayload>,
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
): Promise<void> => {
  for (const target of entry.payload.targets) {
    if (target.action === 'upsert' && target.plan) {
      if (target.replacePlanDirectory) {
        await removePlanAtScope(target.scope, entry.branchName, entry.planId);
      }
      await writePlanAtScope(target.scope, entry.branchName, target.plan, registrySnapshot, {
        chatMessages: target.chatMessages,
        skipManifest: target.chatMessages !== undefined,
      });
      if (target.chatMessages) {
        await writePlanChatAtScope(
          target.scope,
          entry.branchName,
          entry.planId,
          target.chatMessages,
          registrySnapshot,
        );
      }
      if (target.extraFiles && target.scope.source !== 'local') {
        for (const [relativePath, content] of Object.entries(target.extraFiles)) {
          await tauriIpc.fsWriteFile({
            path: `${getPlanDir(entry.branchName, entry.planId)}/${relativePath}`,
            content,
            createDirs: true,
            allowOutsideWorkspace: false,
            workspaceScope: getScopeWorkspaceScope(target.scope),
            workspacePath: target.scope.workspacePath,
          });
        }
      }
    } else if (target.action === 'remove') {
      await removePlanAtScope(target.scope, entry.branchName, entry.planId);
    }
    await writeIndexAtScope(target.scope, entry.branchName, target.index);
  }
};

export const replicaTransactionQueues = new Map<string, Promise<void>>();

export const withReplicaTransactionLock = async <T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> => {
  const previous = replicaTransactionQueues.get(workspaceKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const stored = run.then(() => undefined, () => undefined);
  replicaTransactionQueues.set(workspaceKey, stored);
  try { return await run; } finally {
    if (replicaTransactionQueues.get(workspaceKey) === stored) replicaTransactionQueues.delete(workspaceKey);
  }
};

export const resolveReplicaWorkspaceKey = async (
  deps: ResolvedArchitectPlanServiceDependencies,
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
  targets: ArchitectPlanReplicaMutationTarget[] = [],
): Promise<string> => {
  let workspaceKey = getRegistryWorkspaceKey(registrySnapshot, targets);
  if (!workspaceKey && typeof deps.tauri.workspaceGetActiveRoot === 'function') {
    workspaceKey = normalizeProjectRegistryPath(await deps.tauri.workspaceGetActiveRoot()) || '';
  }
  return workspaceKey;
};

export const recoverArchitectPlanReplicaMutationsUnlocked = async (
  deps: ResolvedArchitectPlanServiceDependencies,
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
  currentWorkspaceKey: string,
): Promise<void> => {
  const entries = await loadArchitectPlanMutationJournal(deps.tauri);
  if (entries.length === 0) return;
  const allowedWorkspaceRoots = new Set(currentWorkspaceKey.split('|').filter(Boolean));
  for (const entry of entries.filter((candidate) => candidate.workspaceKey === currentWorkspaceKey)) {
      if (!isReplicaMutationPayload(entry)) {
        await quarantineArchitectPlanMutationJournal(
          entry,
          'Payload ou scopes invalides ; aucune écriture de reprise n’a été exécutée.',
          deps.tauri,
        );
        continue;
      }
      const scopesBelongToWorkspace = entry.payload.targets.every((target) => {
        if (target.scope.source === 'local') return true;
        const root = normalizeProjectRegistryPath(target.scope.workspacePath || target.scope.repoPath);
        return !!root && allowedWorkspaceRoots.has(root);
      });
      if (!scopesBelongToWorkspace) {
        await quarantineArchitectPlanMutationJournal(
          entry,
          'Un scope ne correspond pas au workspace propriétaire ; aucune écriture de reprise n’a été exécutée.',
          deps.tauri,
        );
        continue;
      }
      let currentEntry = entry;
      try {
        if (currentEntry.phase === 'prepared' || currentEntry.phase === 'applying') {
          await applyArchitectPlanReplicaMutation(currentEntry, registrySnapshot);
          currentEntry = { ...currentEntry, phase: 'files_applied', updatedAt: new Date().toISOString() };
          await upsertArchitectPlanMutationJournal(currentEntry, deps.tauri);
        }
        currentEntry = { ...currentEntry, phase: 'committing', updatedAt: new Date().toISOString() };
        await upsertArchitectPlanMutationJournal(currentEntry, deps.tauri);
        await commitMetadataScopes(
          currentEntry.payload.targets
            .filter((target) => shouldCommitMutationTarget(target, registrySnapshot))
            .map((target) => target.scope),
          currentEntry.payload.commitMessage,
          { commit: true },
          deps,
        );
        await removeArchitectPlanMutationJournal(currentEntry.id, deps.tauri);
      } catch (error) {
        await upsertArchitectPlanMutationJournal({
          ...currentEntry,
          updatedAt: new Date().toISOString(),
          lastError: toErrorMessage(error),
        }, deps.tauri);
        throw error;
      }
  }
};

export const recoverArchitectPlanReplicaMutations = async (
  deps: ResolvedArchitectPlanServiceDependencies,
): Promise<void> => {
  if (!deps.tauri.isTauriAvailable()) return;
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const workspaceKey = await resolveReplicaWorkspaceKey(deps, registrySnapshot);
  await withReplicaTransactionLock(workspaceKey, () =>
    recoverArchitectPlanReplicaMutationsUnlocked(deps, registrySnapshot, workspaceKey)
  );
};

export const runArchitectPlanReplicaMutation = async (params: {
  branchName: string;
  planId: string;
  operation: ArchitectPlanMutationJournalEntry['operation'];
  targets: ArchitectPlanReplicaMutationTarget[];
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined;
  deps: ResolvedArchitectPlanServiceDependencies;
  commitMessage: string;
}): Promise<void> => {
  const workspaceKey = await resolveReplicaWorkspaceKey(params.deps, params.registrySnapshot, params.targets);
  await withReplicaTransactionLock(workspaceKey, async () => {
    await recoverArchitectPlanReplicaMutationsUnlocked(params.deps, params.registrySnapshot, workspaceKey);
    const now = new Date().toISOString();
    const entry: ArchitectPlanMutationJournalEntry<ArchitectPlanReplicaMutationPayload> = {
    id: createArchitectPlanMutationId(params),
    workspaceKey,
    branchName: params.branchName,
    planId: params.planId,
    operation: params.operation,
    phase: 'prepared',
    payload: { targets: params.targets, commitMessage: params.commitMessage },
    createdAt: now,
    updatedAt: now,
  };
    let currentEntry = entry;
    await upsertArchitectPlanMutationJournal(currentEntry, params.deps.tauri);
    try {
    currentEntry = { ...currentEntry, phase: 'applying', updatedAt: new Date().toISOString() };
    await upsertArchitectPlanMutationJournal(currentEntry, params.deps.tauri);
    await applyArchitectPlanReplicaMutation(currentEntry, params.registrySnapshot);
    currentEntry = { ...currentEntry, phase: 'files_applied', updatedAt: new Date().toISOString() };
    await upsertArchitectPlanMutationJournal(currentEntry, params.deps.tauri);
    currentEntry = { ...currentEntry, phase: 'committing', updatedAt: new Date().toISOString() };
    await upsertArchitectPlanMutationJournal(currentEntry, params.deps.tauri);
    await commitMetadataScopes(
      params.targets
        .filter((target) => shouldCommitMutationTarget(target, params.registrySnapshot))
        .map((target) => target.scope),
      params.commitMessage,
      { commit: true },
      params.deps,
    );
    await removeArchitectPlanMutationJournal(currentEntry.id, params.deps.tauri);
    } catch (error) {
      await upsertArchitectPlanMutationJournal({
        ...currentEntry,
        updatedAt: new Date().toISOString(),
        lastError: toErrorMessage(error),
      }, params.deps.tauri);
      throw error;
    }
  });
};

export const buildUpsertReplicaMutationTarget = async (params: {
  scope: ArchitectMetadataScope;
  branchName: string;
  plan: ArchitectPlanRecord;
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined;
  setActive?: boolean;
  chatMessageCount?: number;
  chatMessages?: ArchitectPlanChatMessage[];
  replacePlanDirectory?: boolean;
  extraFiles?: Record<string, string>;
}): Promise<ArchitectPlanReplicaMutationTarget> => {
  const index = await readIndexAtScope(params.scope, params.branchName, params.registrySnapshot);
  const previousSummary = index.plans.find((candidate) => candidate.id === params.plan.id);
  const plans = upsertSummary(index.plans, toSummary(params.plan, {
    chatMessageCount: params.chatMessageCount ?? previousSummary?.chatMessageCount,
  }));
  const nextPlanSlugs = plans.map((candidate) => slugifyPlanTitle(candidate.slug || candidate.title || candidate.id));
  const releasedSlug = previousSummary?.status === 'draft' && params.plan.status === 'draft' &&
    slugifyPlanTitle(previousSummary.slug || previousSummary.title || previousSummary.id) !== slugifyPlanTitle(params.plan.slug)
    ? slugifyPlanTitle(previousSummary.slug || previousSummary.title || previousSummary.id) : null;
  return {
    scope: params.scope,
    action: 'upsert',
    plan: params.plan,
    executionModesByProjectId: getPlanExecutionModes(params.plan, params.registrySnapshot),
    chatMessages: params.chatMessages,
    replacePlanDirectory: params.replacePlanDirectory,
    extraFiles: params.extraFiles,
    index: {
      ...index,
      version: 3,
      plans,
      activePlanId: params.setActive ? params.plan.id : index.activePlanId,
      reservedPlanSlugs: Array.from(new Set([
        ...index.reservedPlanSlugs.map(slugifyPlanTitle).filter((slug) => slug !== releasedSlug || nextPlanSlugs.includes(slug)),
        ...nextPlanSlugs,
      ])),
    },
  };
};

export const buildRemoveReplicaMutationTarget = async (params: {
  scope: ArchitectMetadataScope;
  branchName: string;
  planId: string;
  plan?: ArchitectPlanRecord;
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined;
}): Promise<ArchitectPlanReplicaMutationTarget> => {
  const index = await readIndexAtScope(params.scope, params.branchName, params.registrySnapshot);
  const removed = index.plans.find((plan) => plan.id === params.planId);
  const plans = index.plans.filter((plan) => plan.id !== params.planId);
  const remainingSlugs = new Set(plans.map((plan) => slugifyPlanTitle(plan.slug || plan.title || plan.id)));
  const releasedSlug = removed?.status === 'draft' ? slugifyPlanTitle(removed.slug || removed.title || removed.id) : null;
  return {
    scope: params.scope,
    action: 'remove',
    plan: null,
    executionModesByProjectId: params.plan
      ? getPlanExecutionModes(params.plan, params.registrySnapshot)
      : {},
    index: {
      ...index,
      version: 3,
      plans,
      activePlanId: index.activePlanId === params.planId
        ? plans.find((plan) => plan.status !== 'deleted' && plan.status !== 'archived')?.id || null
        : index.activePlanId,
      reservedPlanSlugs: index.reservedPlanSlugs.filter((slug) => {
        const normalized = slugifyPlanTitle(slug);
        return normalized !== releasedSlug || remainingSlugs.has(normalized);
      }),
    },
  };
};

export const extractMacroMutationLabel = (message: string): string | null => {
  const normalized = message.trim();
  const match = normalized.match(/(?:plan|metadata)\s+([a-zA-Z0-9._/-]+)$/);
  return match?.[1] ?? null;
};

export const inferMacroMutationKind = (message: string): MacroMetadataMutationKind => {
  const lower = message.toLowerCase();
  if (lower.includes('create architect plan')) return 'plan_created';
  if (lower.includes('archive architect plan')) return 'plan_archived';
  if (lower.includes('delete architect plan')) return 'plan_deleted';
  if (lower.includes('repair architect plan')) return 'plan_repaired';
  if (lower.includes('task')) return 'task_metadata';
  if (lower.includes('chat')) return 'chat_synced';
  if (lower.includes('plan')) return 'plan_updated';
  return 'project_state';
};

export const isStructuralMacroMutation = (kind: MacroMetadataMutationKind): boolean =>
  kind === 'plan_created' ||
  kind === 'plan_archived' ||
  kind === 'plan_deleted' ||
  kind === 'plan_repaired' ||
  kind === 'task_metadata' ||
  kind === 'manual_feature';

export const commitMetadataScopes = async (
  scopes: ArchitectMetadataScope[],
  commitMessage: string,
  options?: {
    commit?: boolean;
    mutationKind?: MacroMetadataMutationKind;
    mutationLabel?: string | null;
    structural?: boolean;
  },
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<void> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();

  if (
    !resolvedDeps.tauri.isTauriAvailable() ||
    typeof resolvedDeps.tauri.macroBranchCommitIfDirty !== 'function'
  ) {
    return;
  }

  const repoScopes = dedupeScopes(
    scopes.filter(
      (scope): scope is ArchitectMetadataScope & { workspacePath: string } =>
        scope.source !== 'local' && typeof scope.workspacePath === 'string' && scope.workspacePath.trim().length > 0
    )
  );

  if (repoScopes.length === 0) {
    return;
  }

  if (options?.commit) {
    await flushMacroMetadata({
      trigger: 'explicit_checkpoint',
      workspacePaths: repoScopes.map((scope) => scope.workspacePath as string),
      message: commitMessage,
    }, getArchitectPlanMetadataCoordinatorDeps(resolvedDeps));
    return;
  }

  const inferredKind = options?.mutationKind ?? inferMacroMutationKind(commitMessage);
  const structural = options?.structural ?? isStructuralMacroMutation(inferredKind);
  if (structural) {
    await flushMacroMetadata({
      trigger: 'explicit_checkpoint',
      workspacePaths: repoScopes.map((scope) => scope.workspacePath as string),
      message: commitMessage,
    }, getArchitectPlanMetadataCoordinatorDeps(resolvedDeps));
    return;
  }

  for (const scope of repoScopes) {
    recordMacroMetadataMutation({
      workspacePath: scope.workspacePath as string,
      kind: inferredKind,
      entityId: options?.mutationLabel ?? extractMacroMutationLabel(commitMessage),
      label: options?.mutationLabel ?? extractMacroMutationLabel(commitMessage),
      importance: structural ? 'structural' : 'light',
    }, getArchitectPlanMetadataCoordinatorDeps(resolvedDeps));
  }
};
