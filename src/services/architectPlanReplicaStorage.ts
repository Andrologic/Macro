import { getArchitectPlanLocalStorage } from './architectPlanReadContext';
import * as tauriIpc from './tauriIpc';
import { isCanonicalArchitectPlan } from './architectPlanPresentation';
import { type ValidProjectRegistrySnapshot } from './validProjectRegistry';
import { normalizeArchitectPlanIdList } from './architectPlanScope';
import {
  areSerializedContentsEqual,
  buildPlanManifest,
  buildPlanMarkdown,
  buildTaskPlannedMarkdown,
  emptyIndex,
  getArchitectPlanActionableProjectIds,
  getIndexPath,
  getPlanChatPath,
  getPlanDir,
  getPlanJsonPath,
  getPlanManifestPath,
  getPlanMarkdownPath,
  getPlanTasksRoot,
  getTaskPlannedPath,
  localIndexKey,
  localPlanChatKey,
  localPlanKey,
  normalizeBranchName,
  normalizeContextProjectIds,
  normalizePlanLabel,
  normalizePlanNodes,
  normalizePlanPredictedBranches,
  normalizeTargetBranchesByProjectId,
  parseJsonLines,
  sanitizeArchitectPlanRecord,
  sanitizeArchitectPlanSummary,
  sanitizeId,
  slugifyPlanTitle,
  stripPlanReplicaMetadata,
  throwPlanMetadataMissing,
  toJsonLines,
  type ArchitectMetadataScope,
  type ArchitectPlanArtifactManifestSummary,
  type ArchitectPlanChatMessage,
  type ArchitectPlanIndex,
  type ArchitectPlanManifest,
  type ArchitectPlanRecord,
  type ArchitectPlanSummary,
  type SanitizedArchitectPlanResult,
} from './architectPlanReadModel';
import { getScopeWorkspaceScope } from './architectPlanReadContext';

export const syncPlanTaskMetadataAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  plan: ArchitectPlanRecord,
  beforeEffect?: () => Promise<void>,
  targetedTaskId?: string,
  onWrite?: (path: string) => void,
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return;
  if (beforeEffect && !targetedTaskId) throw new Error('content_unavailable');
  const normalizedBranch = normalizeBranchName(branchName);
  const normalizedPlan = {
    ...plan,
    nodes: normalizePlanNodes(plan.nodes),
    predictedBranches: normalizePlanPredictedBranches(plan.predictedBranches),
  };
  if (beforeEffect && targetedTaskId) {
    const node = normalizedPlan.nodes.find(candidate => candidate.id === targetedTaskId);
    if (!node) throw new Error('content_unavailable');
    await writeTextFileAtScope(scope, getTaskPlannedPath(normalizedBranch, normalizedPlan.id, node.id),
      buildTaskPlannedMarkdown(normalizedPlan, node), beforeEffect, onWrite);
    return;
  }
  const activeTaskIds = new Set(normalizedPlan.nodes.map((node) => node.id));

  try {
    const existingTaskEntries = await tauriIpc.fsListDir({
      path: getPlanTasksRoot(normalizedBranch, normalizedPlan.id),
      recursive: false,
      includeHidden: true,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });

    await Promise.all(
      existingTaskEntries
        .filter((entry) => entry.kind === 'dir' || entry.kind === 'directory')
        .filter((entry) => !activeTaskIds.has(entry.name))
        .map((entry) =>
          tauriIpc.fsDelete({
            path: getTaskPlannedPath(normalizedBranch, normalizedPlan.id, entry.name),
            workspaceScope: getScopeWorkspaceScope(scope),
            workspacePath: scope.workspacePath,
          }).catch(() => undefined)
        )
    );
  } catch {
    // Ignore missing task directories and keep planned metadata writes best-effort.
  }

  await Promise.all(
    normalizedPlan.nodes.map((node) =>
      writeTextFileAtScope(
        scope,
        getTaskPlannedPath(normalizedBranch, normalizedPlan.id, node.id),
        buildTaskPlannedMarkdown(normalizedPlan, node),
        beforeEffect, onWrite
      )
    )
  );
};

export const readJsonFileAtScope = async <T>(
  scope: ArchitectMetadataScope,
  path: string
): Promise<T | null> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return null;
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });
    return JSON.parse(file.content) as T;
  } catch {
    return null;
  }
};

export const writeJsonFileAtScope = async (
  scope: ArchitectMetadataScope,
  path: string,
  value: unknown,
  beforeEffect?: () => Promise<void>,
  onWrite?: (path: string) => void,
): Promise<boolean> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return false;
  const content = JSON.stringify(value, null, 2);
  const existing = await readTextFileAtScope(scope, path);
  if (typeof existing === 'string' && areSerializedContentsEqual(existing, content)) {
    return false;
  }
  await beforeEffect?.();
  await tauriIpc.fsWriteFile({
    path,
    content,
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: getScopeWorkspaceScope(scope),
    workspacePath: scope.workspacePath,
  });
  onWrite?.(path);
  return true;
};

export const readTextFileAtScope = async (
  scope: ArchitectMetadataScope,
  path: string
): Promise<string | null> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return null;
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });
    return file.content;
  } catch {
    return null;
  }
};

export const writeTextFileAtScope = async (
  scope: ArchitectMetadataScope,
  path: string,
  content: string,
  beforeEffect?: () => Promise<void>,
  onWrite?: (path: string) => void,
): Promise<boolean> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return false;
  const existing = await readTextFileAtScope(scope, path);
  if (typeof existing === 'string' && areSerializedContentsEqual(existing, content)) {
    return false;
  }
  await beforeEffect?.();
  await tauriIpc.fsWriteFile({
    path,
    content,
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: getScopeWorkspaceScope(scope),
    workspacePath: scope.workspacePath,
  });
  onWrite?.(path);
  return true;
};

export const readLocalIndex = (branchName: string): ArchitectPlanIndex => {
  const storage = getArchitectPlanLocalStorage();
  if (!storage) return emptyIndex();
  try {
    const raw = storage.getItem(localIndexKey(branchName));
    if (!raw) return emptyIndex();
    const parsed = JSON.parse(raw) as Partial<ArchitectPlanIndex>;
    const reservedPlanSlugs = Array.isArray(parsed.reservedPlanSlugs)
      ? parsed.reservedPlanSlugs
          .filter((slug): slug is string => typeof slug === 'string')
          .map((slug) => slugifyPlanTitle(slug))
      : [];
    const planSlugsFromIndex = Array.isArray(parsed.plans)
      ? parsed.plans.map((plan) => slugifyPlanTitle((plan as Partial<ArchitectPlanSummary>).slug || plan.title || plan.id))
      : [];
    if (parsed && Array.isArray(parsed.plans)) {
      return {
        version: parsed.version === 2 ? 2 : 3,
        activePlanId: parsed.activePlanId || null,
        plans: parsed.plans,
        reservedPlanSlugs: Array.from(new Set([...reservedPlanSlugs, ...planSlugsFromIndex])),
      };
    }
    return emptyIndex();
  } catch {
    return emptyIndex();
  }
};

export const readLocalPlan = (branchName: string, planId: string): ArchitectPlanRecord | null => {
  const storage = getArchitectPlanLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(localPlanKey(branchName, planId));
    if (!raw) return null;
    return JSON.parse(raw) as ArchitectPlanRecord;
  } catch {
    return null;
  }
};

export const readLocalPlanChat = (branchName: string, planId: string): ArchitectPlanChatMessage[] => {
  const storage = getArchitectPlanLocalStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(localPlanChatKey(branchName, planId));
    if (!raw) return [];
    return parseJsonLines(raw);
  } catch {
    return [];
  }
};

export const writeLocalValueIfChanged = (key: string, value: string): boolean => {
  const storage = getArchitectPlanLocalStorage();
  if (!storage) return false;
  const existing = storage.getItem(key);
  if (existing === value) {
    return false;
  }
  storage.setItem(key, value);
  return true;
};

export const writeLocalPlan = (branchName: string, plan: ArchitectPlanRecord): boolean =>
  writeLocalValueIfChanged(localPlanKey(branchName, plan.id), JSON.stringify(plan));

export const writeLocalPlanChat = (
  branchName: string,
  planId: string,
  messages: ArchitectPlanChatMessage[]
): boolean =>
  writeLocalValueIfChanged(localPlanChatKey(branchName, planId), toJsonLines(messages));

export const writeLocalIndex = (branchName: string, value: ArchitectPlanIndex): boolean =>
  writeLocalValueIfChanged(localIndexKey(branchName), JSON.stringify(value));

export const deleteLocalPlan = (branchName: string, planId: string): void => {
  const storage = getArchitectPlanLocalStorage();
  if (!storage) return;
  storage.removeItem(localPlanKey(branchName, planId));
};

export const deleteLocalPlanChat = (branchName: string, planId: string): void => {
  const storage = getArchitectPlanLocalStorage();
  if (!storage) return;
  storage.removeItem(localPlanChatKey(branchName, planId));
};

export const normalizeSummariesForBranch = (
  branchName: string,
  summaries: ArchitectPlanSummary[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    logContext?: string;
    scopeKey?: string | null;
  }
): ArchitectPlanSummary[] =>
  summaries.map((summary) =>
    sanitizeArchitectPlanSummary(branchName, summary, registrySnapshot, options).summary
  );

export const readIndexAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): Promise<ArchitectPlanIndex> => {
  const normalized = normalizeBranchName(branchName);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    const local = readLocalIndex(normalized);
    return {
      ...local,
      plans: normalizeSummariesForBranch(normalized, local.plans, registrySnapshot, {
        logContext: 'index_read',
        scopeKey: scope.scopeKey,
      }),
      reservedPlanSlugs: Array.from(new Set(local.reservedPlanSlugs.map((slug) => slugifyPlanTitle(slug)))),
    };
  }

  const parsed = await readJsonFileAtScope<Partial<ArchitectPlanIndex>>(scope, getIndexPath(normalized));
  if (parsed && Array.isArray(parsed.plans)) {
    const reservedPlanSlugs = Array.isArray(parsed.reservedPlanSlugs)
      ? parsed.reservedPlanSlugs
          .filter((slug): slug is string => typeof slug === 'string')
          .map((slug) => slugifyPlanTitle(slug))
      : [];
    const planSlugsFromIndex = parsed.plans.map((plan) =>
      slugifyPlanTitle((plan as Partial<ArchitectPlanSummary>).slug || plan.title || plan.id)
    );
    return {
      version: parsed.version === 2 ? 2 : 3,
      activePlanId: parsed.activePlanId || null,
      plans: normalizeSummariesForBranch(normalized, parsed.plans, registrySnapshot, {
        logContext: 'index_read',
        scopeKey: scope.scopeKey,
      }),
      reservedPlanSlugs: Array.from(new Set([...reservedPlanSlugs, ...planSlugsFromIndex])),
    };
  }

  return emptyIndex();
};

export const writeIndexAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  index: ArchitectPlanIndex,
  beforeEffect?: () => Promise<void>,
  onWrite?: (path: string) => void,
  options?: { pilotOnly?: boolean; targetedPlanId?: string },
): Promise<boolean> => {
  const normalized = normalizeBranchName(branchName);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return writeLocalIndex(normalized, index);
  }

  if (options?.pilotOnly) {
    const rawIndex = await readJsonFileAtScope<Partial<ArchitectPlanIndex>>(scope, getIndexPath(normalized));
    if (!rawIndex || !Array.isArray(rawIndex.plans)) throw new Error('content_unavailable');
    const computed = new Map(index.plans.map(summary => [summary.id, summary]));
    const existingIds = new Set(rawIndex.plans.map(summary => summary.id));
    const plans = rawIndex.plans
      .filter(summary => summary.id !== options.targetedPlanId || computed.has(summary.id))
      .map(summary => summary.id === options.targetedPlanId
        ? { ...summary, ...computed.get(summary.id) } : summary);
    index.plans.forEach(summary => { if (!existingIds.has(summary.id)) plans.push(summary); });
    return writeJsonFileAtScope(scope, getIndexPath(normalized), {
      ...rawIndex, ...index, plans,
      reservedPlanSlugs: Array.from(new Set([
        ...(Array.isArray(rawIndex.reservedPlanSlugs) ? rawIndex.reservedPlanSlugs : []),
        ...index.reservedPlanSlugs,
      ])),
    }, beforeEffect, onWrite);
  }
  return writeJsonFileAtScope(scope, getIndexPath(normalized), index, beforeEffect, onWrite);
};

export const normalizePlanRecordForBranch = (
  branchName: string,
  planId: string,
  plan: ArchitectPlanRecord | null,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    logContext?: string;
    scopeKey?: string | null;
  }
): ArchitectPlanRecord | null =>
  sanitizeArchitectPlanRecord(branchName, planId, plan, registrySnapshot, options).plan;

export const readPlanAtScopeWithDiagnostics = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): Promise<SanitizedArchitectPlanResult> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return sanitizeArchitectPlanRecord(
      normalized,
      safeId,
      readLocalPlan(normalized, safeId),
      registrySnapshot,
      {
        logContext: 'plan_read',
        scopeKey: scope.scopeKey,
      }
    );
  }

  return sanitizeArchitectPlanRecord(
    normalized,
    safeId,
    await readJsonFileAtScope<ArchitectPlanRecord>(scope, getPlanJsonPath(normalized, safeId)),
    registrySnapshot,
    {
      logContext: 'plan_read',
      scopeKey: scope.scopeKey,
    }
  );
};

export const readPlanChatAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<ArchitectPlanChatMessage[]> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return readLocalPlanChat(normalized, safeId);
  }
  const raw = await readTextFileAtScope(scope, getPlanChatPath(normalized, safeId));
  return raw ? parseJsonLines(raw) : [];
};

export const readStoredPlanManifestAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<Partial<ArchitectPlanManifest> | null> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return null;
  }

  return await readJsonFileAtScope<Partial<ArchitectPlanManifest>>(
    scope,
    getPlanManifestPath(normalized, safeId)
  );
};

export const normalizeArtifactManifestSummary = (
  value: unknown
): ArchitectPlanArtifactManifestSummary | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const parsed = value as Partial<ArchitectPlanArtifactManifestSummary>;
  if (
    typeof parsed.count !== 'number' ||
    !Number.isFinite(parsed.count) ||
    typeof parsed.indexHash !== 'string' ||
    parsed.indexHash.trim().length === 0 ||
    typeof parsed.contentHash !== 'string' ||
    parsed.contentHash.trim().length === 0 ||
    typeof parsed.updatedAt !== 'string' ||
    parsed.updatedAt.trim().length === 0
  ) {
    return undefined;
  }
  return {
    count: Math.max(0, Math.floor(parsed.count)),
    indexHash: parsed.indexHash,
    contentHash: parsed.contentHash,
    ...(typeof parsed.reviewHash === 'string' && parsed.reviewHash.trim().length > 0
      ? { reviewHash: parsed.reviewHash }
      : {}),
    updatedAt: parsed.updatedAt,
  };
};

export const preservePlanArtifactManifestAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string,
  manifest: ArchitectPlanManifest
): Promise<ArchitectPlanManifest> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return manifest;
  }
  const existing = await readStoredPlanManifestAtScope(scope, branchName, planId);
  const artifacts = normalizeArtifactManifestSummary(existing?.artifacts);
  if (!existing) return manifest;
  return { ...existing, ...manifest, ...(artifacts ? { artifacts } : {}) } as ArchitectPlanManifest;
};

export const readPlanManifestAtScope = async (params: {
  scope: ArchitectMetadataScope;
  branchName: string;
  plan: ArchitectPlanRecord;
  chatMessages: ArchitectPlanChatMessage[];
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
}): Promise<ArchitectPlanManifest> => {
  const normalized = normalizeBranchName(params.branchName);
  const safeId = sanitizeId(params.plan.id);
  const fallbackManifest = await buildPlanManifest({
    plan: params.plan,
    chatMessages: params.chatMessages,
    registrySnapshot: params.registrySnapshot,
  });

  if (!tauriIpc.isTauriAvailable() || params.scope.source === 'local') {
    return fallbackManifest;
  }

  const parsed = await readJsonFileAtScope<Partial<ArchitectPlanManifest>>(
    params.scope,
    getPlanManifestPath(normalized, safeId)
  );
  if (!parsed) {
    return fallbackManifest;
  }

  const actionableProjectIds = getArchitectPlanActionableProjectIds(params.plan);
  const contextProjectIds = normalizeContextProjectIds(
    parsed.contextProjectIds ?? fallbackManifest.contextProjectIds,
    actionableProjectIds,
    params.registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(actionableProjectIds, contextProjectIds);

  return {
    ...fallbackManifest,
    ...parsed,
    schemaVersion: 3,
    planId: safeId,
    targetBranch: normalized,
    targetBranchesByProjectId: normalizeTargetBranchesByProjectId(
      parsed.targetBranchesByProjectId,
      actionableProjectIds,
      normalized
    ),
    status: params.plan.status,
    expectedProjectIds,
    contextProjectIds,
    participants: Array.isArray(parsed.participants) ? parsed.participants : fallbackManifest.participants,
    revision:
      typeof parsed.revision === 'number' && Number.isFinite(parsed.revision) && parsed.revision > 0
        ? Math.floor(parsed.revision)
        : fallbackManifest.revision,
    updatedAt:
      typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim().length > 0
        ? parsed.updatedAt
        : fallbackManifest.updatedAt,
    contentHashes: parsed.contentHashes && typeof parsed.contentHashes === 'object'
      ? {
          plan:
            typeof parsed.contentHashes.plan === 'string'
              ? parsed.contentHashes.plan
              : fallbackManifest.contentHashes.plan,
          chat:
            typeof parsed.contentHashes.chat === 'string'
              ? parsed.contentHashes.chat
              : fallbackManifest.contentHashes.chat,
        }
      : fallbackManifest.contentHashes,
    artifacts: normalizeArtifactManifestSummary(parsed.artifacts),
    conversation: parsed.conversation && typeof parsed.conversation === 'object'
      ? {
          conversationId:
            typeof parsed.conversation.conversationId === 'string' ? parsed.conversation.conversationId : fallbackManifest.conversation.conversationId,
          title: typeof parsed.conversation.title === 'string' ? parsed.conversation.title : fallbackManifest.conversation.title,
          messageCount:
            typeof parsed.conversation.messageCount === 'number' ? parsed.conversation.messageCount : fallbackManifest.conversation.messageCount,
          lastMessageAt:
            typeof parsed.conversation.lastMessageAt === 'string' ? parsed.conversation.lastMessageAt : fallbackManifest.conversation.lastMessageAt,
        }
      : fallbackManifest.conversation,
    deletion:
      parsed.deletion && typeof parsed.deletion === 'object' && typeof parsed.deletion.deletedAt === 'string'
        ? { deletedAt: parsed.deletion.deletedAt }
        : fallbackManifest.deletion,
  };
};

export const writePlanAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  plan: ArchitectPlanRecord,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    chatMessages?: ArchitectPlanChatMessage[];
    skipManifest?: boolean;
    beforeEffect?: () => Promise<void>;
    targetedTaskId?: string;
    onWrite?: (path: string) => void;
  }
): Promise<void> => {
  if (options?.beforeEffect && !options.targetedTaskId) throw new Error('content_unavailable');
  const normalized = normalizeBranchName(branchName);
  const sanitizedPlanResult = sanitizeArchitectPlanRecord(
    normalized,
    plan.id,
    {
      ...stripPlanReplicaMetadata(plan),
      title: isCanonicalArchitectPlan(plan) ? plan.id : (plan.title || plan.id).trim() || plan.id,
    },
    registrySnapshot,
    {
      logContext: 'plan_write',
      scopeKey: scope.scopeKey,
    }
  );
  if (!sanitizedPlanResult.plan) {
    throwPlanMetadataMissing(normalized, plan.id);
  }
  const normalizedPlan: ArchitectPlanRecord = {
    ...sanitizedPlanResult.plan,
    label: normalizePlanLabel(sanitizedPlanResult.plan.label),
  };

  let planToWrite = normalizedPlan;
  if (options?.beforeEffect && options.targetedTaskId) {
    const rawPlan = await readJsonFileAtScope<ArchitectPlanRecord>(
      scope, getPlanJsonPath(normalized, sanitizeId(normalizedPlan.id)));
    const rawNodes = rawPlan && Array.isArray(rawPlan.nodes) ? rawPlan.nodes : null;
    const targetedNode = normalizedPlan.nodes.find(node => node.id === options.targetedTaskId);
    if (!rawPlan || !rawNodes || !targetedNode || !rawNodes.some(node => node.id === options.targetedTaskId)) {
      throw new Error('content_unavailable');
    }
    planToWrite = {
      ...rawPlan, updatedAt: normalizedPlan.updatedAt, revision: normalizedPlan.revision,
      nodes: rawNodes.map(node => node.id === options.targetedTaskId
        ? { ...node, title: targetedNode.title } : node),
    };
  }
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    await options?.beforeEffect?.();
    writeLocalPlan(normalized, normalizedPlan);
    return;
  }

  const safeId = sanitizeId(normalizedPlan.id);
  await writeJsonFileAtScope(scope, getPlanJsonPath(normalized, safeId), planToWrite, options?.beforeEffect, options?.onWrite);
  await writeTextFileAtScope(scope, getPlanMarkdownPath(normalized, safeId), buildPlanMarkdown(planToWrite, registrySnapshot), options?.beforeEffect, options?.onWrite);
  await syncPlanTaskMetadataAtScope(scope, normalized, planToWrite, options?.beforeEffect, options?.targetedTaskId, options?.onWrite);
  if (!options?.skipManifest) {
    const chatMessages = options?.chatMessages ?? await readPlanChatAtScope(scope, normalized, safeId);
    const manifest = await preservePlanArtifactManifestAtScope(scope, normalized, safeId, await buildPlanManifest({
      plan: planToWrite,
      chatMessages,
      registrySnapshot,
    }));
    await writeJsonFileAtScope(scope, getPlanManifestPath(normalized, safeId), manifest, options?.beforeEffect, options?.onWrite);
  }
};

export const writePlanChatAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string,
  messages: ArchitectPlanChatMessage[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    writeLocalPlanChat(normalized, safeId, messages);
    return;
  }

  await writeTextFileAtScope(scope, getPlanChatPath(normalized, safeId), toJsonLines(messages));
  const planResult = await readPlanAtScopeWithDiagnostics(scope, normalized, safeId, registrySnapshot);
  if (planResult.plan) {
    const manifest = await preservePlanArtifactManifestAtScope(scope, normalized, safeId, await buildPlanManifest({
      plan: planResult.plan,
      chatMessages: messages,
      registrySnapshot,
    }));
    await writeJsonFileAtScope(scope, getPlanManifestPath(normalized, safeId), manifest);
  }
};

export const removePlanAtScope = async (scope: ArchitectMetadataScope, branchName: string, planId: string): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    deleteLocalPlan(normalized, safeId);
    deleteLocalPlanChat(normalized, safeId);
    return;
  }

  const path = getPlanDir(normalized, safeId);
  if (!await tauriIpc.fsExists(path, {
    workspaceScope: getScopeWorkspaceScope(scope),
    workspacePath: scope.workspacePath,
  })) return;
  await tauriIpc.fsDelete({
    path,
    recursive: true,
    workspaceScope: getScopeWorkspaceScope(scope),
    workspacePath: scope.workspacePath,
  });
};
