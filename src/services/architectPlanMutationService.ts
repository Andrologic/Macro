import type { ArchitectPlanServiceDependencies } from './architectPlanReadContext';
import type { PlanNode, PredictedBranch } from '../types';
import { devLogger } from '../utils/devLogger';
import { isCanonicalArchitectPlan } from './architectPlanPresentation';
import { type ValidProjectRegistrySnapshot } from './validProjectRegistry';
import { normalizeArchitectPlanIdList } from './architectPlanScope';
import {
  normalizeArchitectPlanGitFlowMetadata,
  normalizeArchitectPlanKind,
  type ArchitectPlanGitFlowMetadata,
  type ArchitectPlanKind,
} from './architectPlanKinds';
import {
  assertPlanReplicaSetWritable,
  getArchitectPlan,
  loadPlanReplicaSet,
  readAggregatedIndex,
  type CreateArchitectPlanInput,
} from './architectPlanReadService';
import {
  createGitFlowMetadataNormalizationContext,
  dedupeScopes,
  ensurePlanScopes,
  invalidateArchitectPlanRuntimeCaches,
  loadArchitectPlanRegistrySnapshot,
  resolveArchitectPlanServiceDependencies,
  type ResolvedArchitectPlanServiceDependencies,
} from './architectPlanReadContext';
import {
  applyArchitectPlanLifecycleForStatus,
  areArchitectPlansSemanticallyEqual,
  assertGitFlowTargetBranch,
  createAvailablePlanSlug,
  getArchitectPlanCrudCapabilities,
  getArchitectPlanEffectiveTargetBranchesByProjectId,
  isArchitectPlanReplicaDivergenceError,
  isArchitectPlanRestorableStatus,
  isArchitectPlanSlugMutable,
  mergeGitFlowTargetBranchesByProjectId,
  normalizeBranchName,
  normalizeContextProjectIds,
  normalizePersistedExecutionModes,
  normalizePlanLabel,
  normalizePlanNodes,
  normalizePlanPredictedBranches,
  normalizeProjectIds,
  normalizeTargetBranchesByProjectId,
  resolveArchivedArchitectPlanRestoreStatus,
  resolvePlanProjectIds,
  sanitizeArchitectPlanRecord,
  sanitizeId,
  slugifyPlanTitle,
  stableSerialize,
  throwPlanMetadataMissing,
  type ArchitectPlanRecord,
  type ArchitectPlanReplicaSet,
  type ArchitectPlanStatus,
} from './architectPlanReadModel';
import {
  buildRemoveReplicaMutationTarget,
  buildUpsertReplicaMutationTarget,
  enqueueArchitectPlanCreation,
  enqueueArchitectPlanMutation,
  getPlanExecutionModes,
  runArchitectPlanReplicaMutation,
  type ArchitectPlanReplicaMutationTarget,
} from './architectPlanMutationPersistence';
import { readIndexAtScope, readPlanChatAtScope } from './architectPlanReplicaStorage';

export const createArchitectPlanId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const createArchitectPlanUnlocked = async (
  input: CreateArchitectPlanInput,
  deps: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const now = new Date().toISOString();
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);

  const initialLabel = normalizePlanLabel(input.label || input.title);
  const index = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
  const explicitPlanId = input.planId?.trim() ? sanitizeId(input.planId) : null;
  let planId = explicitPlanId || createArchitectPlanId();
  while (!explicitPlanId && index.plans.some((plan) => plan.id === planId)) {
    planId = createArchitectPlanId();
  }
  const canonicalSlug = createAvailablePlanSlug(
    input.slug || initialLabel || planId,
    index.reservedPlanSlugs,
  );

  if (explicitPlanId && index.plans.some((plan) => plan.id === planId)) {
    throw new Error(`A plan with id "${planId}" already exists. Choose a different identifier.`);
  }

  const normalizedNodes = normalizePlanNodes(input.nodes || []);
  const normalizedPredictedBranches = normalizePlanPredictedBranches(input.predictedBranches || []);
  const projectIds = resolvePlanProjectIds({
    projectIds: input.projectIds,
    projectId: input.projectId,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  });
  const contextProjectIds = normalizeContextProjectIds(
    input.contextProjectIds,
    projectIds,
    registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(projectIds, contextProjectIds);
  const planKind = normalizeArchitectPlanKind(input.planKind || input.gitFlowPlan?.planKind);
  const gitFlowNormalizationContext = await createGitFlowMetadataNormalizationContext(
    deps,
    normalizedBranch
  );
  const normalizedGitFlowPlan = normalizeArchitectPlanGitFlowMetadata({
    planKind,
    gitFlowPlan: input.gitFlowPlan,
    projectIds,
    fallbackSlug: canonicalSlug,
    ...gitFlowNormalizationContext,
  });
  const normalizedTargetBranchesByProjectId = getArchitectPlanEffectiveTargetBranchesByProjectId({
    projectId: projectIds[0],
    projectIds,
    targetBranch: normalizedBranch,
    targetBranchesByProjectId: mergeGitFlowTargetBranchesByProjectId(
      normalizeTargetBranchesByProjectId(
        input.targetBranchesByProjectId,
        projectIds,
        normalizedBranch
      ),
      normalizedGitFlowPlan,
      projectIds,
      { preferGitFlow: input.targetBranchesByProjectId === undefined }
    ),
    planKind,
    gitFlowPlan: normalizedGitFlowPlan,
  }, {
    getProjectGitFlowSettings: gitFlowNormalizationContext.getProjectSettings,
    fallbackTargetBranch: normalizedBranch,
  });

  const initialPlanRecord = applyArchitectPlanLifecycleForStatus({
    id: planId,
    slug: canonicalSlug,
    title: planId,
    label: initialLabel,
    description: (input.description || '').trim(),
    planKind,
    gitFlowPlan: normalizedGitFlowPlan,
    status: input.status || 'draft',
    targetBranch: normalizedBranch,
    targetBranchesByProjectId: normalizedTargetBranchesByProjectId,
    executionModesByProjectId: normalizePersistedExecutionModes(
      Object.fromEntries(
        projectIds.map((projectId) => [
          projectId,
          registrySnapshot?.executionModeByProjectId.get(projectId),
        ]),
      ) as Record<string, 'git' | 'direct'>,
      projectIds,
    ),
    conversationId: input.conversationId,
    projectId: projectIds[0],
    projectIds,
    contextProjectIds,
    expectedProjectIds,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  });
  const planResult = sanitizeArchitectPlanRecord(normalizedBranch, planId, initialPlanRecord, registrySnapshot, {
    logContext: 'plan_create',
  });
  if (!planResult.plan) {
    throwPlanMetadataMissing(normalizedBranch, planId);
  }
  const plan = planResult.plan;

  const scopes = await ensurePlanScopes(
    plan.expectedProjectIds || plan.projectIds || [],
    registrySnapshot,
    deps,
    getPlanExecutionModes(plan, registrySnapshot),
  );
  const targets = await Promise.all(scopes.map((scope) => buildUpsertReplicaMutationTarget({
    scope,
    branchName: normalizedBranch,
    plan,
    registrySnapshot,
    setActive: input.setActive !== false,
    chatMessageCount: 0,
  })));
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: plan.id,
    operation: 'create',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): create architect plan ${plan.id}`,
  });
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: plan.id,
  });

  return (await getArchitectPlan(normalizedBranch, plan.id, deps)) || plan;
};

export const createArchitectPlan = async (
  input: CreateArchitectPlanInput,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanRecord> =>
  enqueueArchitectPlanCreation(input.branchName, () => createArchitectPlanUnlocked(input, deps));

export interface UpdateArchitectPlanInput {
  branchName: string;
  planId: string;
  expectedRevision?: number;
  title?: string;
  label?: string;
  slug?: string;
  description?: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: Partial<ArchitectPlanGitFlowMetadata>;
  conversationId?: string;
  status?: ArchitectPlanStatus;
  projectId?: string;
  projectIds?: string[];
  contextProjectIds?: string[];
  targetBranchesByProjectId?: Record<string, string>;
  expectedProjectIds?: string[];
  directCheckpointBinding?: { taskId: string; projectId: string; checkpointId: string };
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  setActive?: boolean;
}

export type ArchitectPlanDerivedUpdate = Pick<UpdateArchitectPlanInput, 'nodes' | 'predictedBranches' | 'status'>;

/** Derive a mutation from the current replica while holding the branch queue. */
export const mutateArchitectPlan = (
  input: { branchName: string; planId: string; expectedRevision?: number },
  deriveUpdate: (plan: ArchitectPlanRecord) => ArchitectPlanDerivedUpdate,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies(),
): Promise<ArchitectPlanRecord> => updateArchitectPlanWithDerivedUpdate(
  { ...input, setActive: false }, deps, deriveUpdate,
);

/** Compatibility entry point for task status transitions. */
export const mutateArchitectPlanTaskStatus: typeof mutateArchitectPlan = (...args) => mutateArchitectPlan(...args);

export const updateArchitectPlan = (
  input: UpdateArchitectPlanInput,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies(),
): Promise<ArchitectPlanRecord> => updateArchitectPlanWithDerivedUpdate(input, deps);

export const updateArchitectPlanWithDerivedUpdate = async (
  input: UpdateArchitectPlanInput,
  deps: ResolvedArchitectPlanServiceDependencies,
  deriveUpdate?: (plan: ArchitectPlanRecord) => ArchitectPlanDerivedUpdate,
): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
    registrySnapshot,
  }, deps);
  if (!replicaSet) {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  const existing = replicaSet.canonical.plan;
  if (
    input.expectedRevision !== undefined &&
    (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
  ) {
    throw new Error('Expected architect plan revision must be a positive integer.');
  }
  if (
    input.expectedRevision !== undefined &&
    existing.revision !== input.expectedRevision
  ) {
    throw new Error(
      `Architect plan revision changed before mutation: expected ${input.expectedRevision}, found ${existing.revision ?? 'unavailable'}.`,
    );
  }
  if (deriveUpdate) {
    assertPlanReplicaSetWritable(replicaSet, 'update');
    input = { ...input, ...deriveUpdate(existing) };
  }
  const inputKeys = Object.keys(input).filter(
    (key) => key !== 'branchName' && key !== 'planId' && key !== 'expectedRevision',
  );
  const isRestoringArchivedPlan =
    existing.status === 'archived' &&
    isArchitectPlanRestorableStatus(input.status) &&
    inputKeys.every((key) => key === 'status' || key === 'setActive');
  if (!isRestoringArchivedPlan) {
    assertPlanReplicaSetWritable(replicaSet, 'update');
  }
  const isCanonicalPlan = isCanonicalArchitectPlan(existing);

  if (!isCanonicalPlan && input.title && input.title.trim().toLowerCase() !== existing.title.trim().toLowerCase()) {
    const idx = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
    const normalizedTitle = input.title.trim().toLowerCase();
    const titleConflict = idx.plans.find(
      (p) => p.id !== safeId && p.status !== 'deleted' && p.title.trim().toLowerCase() === normalizedTitle
    );
    if (titleConflict) {
      throw new Error(`A plan named "${titleConflict.title}" already exists. Choose a different name.`);
    }
  }

  const requestedSlug = input.slug ? slugifyPlanTitle(input.slug) : existing.slug;
  if (requestedSlug !== existing.slug && !isArchitectPlanSlugMutable(existing)) {
    throw new Error('Plan slug is immutable and cannot be changed after creation.');
  }
  if (requestedSlug !== existing.slug) {
    const idx = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
    const currentSlugForPlan = idx.plans.find((plan) => plan.id === safeId)?.slug || existing.slug;
    const hasSlugConflict =
      idx.plans.some(
        (plan) =>
          plan.id !== safeId &&
          slugifyPlanTitle(plan.slug || plan.title || plan.id) === requestedSlug
      ) ||
      idx.reservedPlanSlugs.some(
        (slug) =>
          slugifyPlanTitle(slug) === requestedSlug &&
          slugifyPlanTitle(currentSlugForPlan) !== requestedSlug
      );
    if (hasSlugConflict) {
      throw new Error(`A plan slug "${requestedSlug}" already exists. Choose a different slug.`);
    }
  }

  const requestedLabel = normalizePlanLabel(input.label ?? input.title);

  if (input.directCheckpointBinding) {
    const binding = input.directCheckpointBinding;
    const node = existing.nodes.find((candidate) => candidate.id === binding.taskId);
    if (!node || node.type !== 'task' || node.executionModesByProjectId?.[binding.projectId] !== 'direct' ||
        !normalizeProjectIds(node.projectIds, node.projectId).includes(binding.projectId)) {
      throw new Error('Direct checkpoint target does not belong to this Architect task.');
    }
    if (!binding.checkpointId.trim()) throw new Error('A direct checkpoint identity is required.');
    const previous = node.directCheckpointIdsByProjectId?.[binding.projectId];
    if (previous && previous !== binding.checkpointId) {
      throw new Error('Direct checkpoint identity is already bound to another value.');
    }
    input = { ...input, nodes: existing.nodes.map((candidate) => candidate.id === binding.taskId
      ? { ...candidate, directCheckpointIdsByProjectId: {
          ...candidate.directCheckpointIdsByProjectId, [binding.projectId]: binding.checkpointId,
        } }
      : candidate) };
  }
  const nextNodes = input.nodes !== undefined ? normalizePlanNodes(input.nodes).map((node) => {
    const previous = existing.nodes.find((candidate) => candidate.id === node.id);
    const binding = input.directCheckpointBinding?.taskId === node.id ? input.directCheckpointBinding : undefined;
    return { ...node, directCheckpointIdsByProjectId: binding
      ? { ...previous?.directCheckpointIdsByProjectId, [binding.projectId]: binding.checkpointId }
      : previous?.directCheckpointIdsByProjectId };
  }) : existing.nodes;
  const nextPredictedBranches =
    input.predictedBranches !== undefined
      ? normalizePlanPredictedBranches(input.predictedBranches)
      : existing.predictedBranches;
  const projectIds = resolvePlanProjectIds({
    projectIds: input.projectIds ?? existing.projectIds,
    projectId: input.projectId !== undefined ? input.projectId : existing.projectId,
    nodes: nextNodes,
    predictedBranches: nextPredictedBranches,
  });
  const contextProjectIds = normalizeContextProjectIds(
    input.contextProjectIds !== undefined ? input.contextProjectIds : existing.contextProjectIds,
    projectIds,
    registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(projectIds, contextProjectIds);
  const planKind = normalizeArchitectPlanKind(
    input.planKind || input.gitFlowPlan?.planKind || existing.planKind || existing.gitFlowPlan?.planKind
  );
  const gitFlowNormalizationContext = await createGitFlowMetadataNormalizationContext(
    deps,
    existing.targetBranch || normalizedBranch
  );
  const normalizedGitFlowPlan = normalizeArchitectPlanGitFlowMetadata({
    planKind,
    gitFlowPlan: input.gitFlowPlan !== undefined ? input.gitFlowPlan : existing.gitFlowPlan,
    projectIds,
    fallbackSlug: requestedSlug,
    ...gitFlowNormalizationContext,
  });
  const normalizedTargetBranchesByProjectId = getArchitectPlanEffectiveTargetBranchesByProjectId({
    ...existing,
    projectId: projectIds[0],
    projectIds,
    targetBranchesByProjectId: mergeGitFlowTargetBranchesByProjectId(
      normalizeTargetBranchesByProjectId(
        input.targetBranchesByProjectId !== undefined
          ? input.targetBranchesByProjectId
          : existing.targetBranchesByProjectId,
        projectIds,
        existing.targetBranch
      ),
      normalizedGitFlowPlan,
      projectIds,
      { preferGitFlow: input.targetBranchesByProjectId === undefined }
    ),
    planKind,
    gitFlowPlan: normalizedGitFlowPlan,
  }, {
    getProjectGitFlowSettings: gitFlowNormalizationContext.getProjectSettings,
    fallbackTargetBranch: existing.targetBranch || normalizedBranch,
  });
  if (!getArchitectPlanCrudCapabilities(existing).canEditScope) {
    const existingProjectIds = normalizeProjectIds(existing.projectIds, existing.projectId);
    const existingContextProjectIds = normalizeContextProjectIds(
      existing.contextProjectIds,
      existingProjectIds,
      registrySnapshot
    );
    const existingExpectedProjectIds = normalizeArchitectPlanIdList(
      existingProjectIds,
      existingContextProjectIds
    );
    const existingTargetBranchesByProjectId = normalizeTargetBranchesByProjectId(
      existing.targetBranchesByProjectId,
      existingProjectIds,
      existing.targetBranch
    );
    const existingPlanKind = normalizeArchitectPlanKind(
      existing.planKind || existing.gitFlowPlan?.planKind
    );
    const existingGitFlowPlan = normalizeArchitectPlanGitFlowMetadata({
      planKind: existingPlanKind,
      gitFlowPlan: existing.gitFlowPlan,
      projectIds: existingProjectIds,
      fallbackSlug: existing.slug,
      ...gitFlowNormalizationContext,
    });
    const scopeChanged =
      stableSerialize(projectIds) !== stableSerialize(existingProjectIds) ||
      stableSerialize(contextProjectIds) !== stableSerialize(existingContextProjectIds) ||
      stableSerialize(expectedProjectIds) !== stableSerialize(existingExpectedProjectIds);
    const branchMetadataChanged =
      input.targetBranchesByProjectId !== undefined &&
      stableSerialize(normalizedTargetBranchesByProjectId) !==
        stableSerialize(existingTargetBranchesByProjectId);
    const gitFlowMetadataChanged =
      (input.gitFlowPlan !== undefined || input.planKind !== undefined) &&
      (planKind !== existingPlanKind ||
        stableSerialize(normalizedGitFlowPlan) !== stableSerialize(existingGitFlowPlan));

    if (scopeChanged || branchMetadataChanged || gitFlowMetadataChanged) {
      throw new Error('Plan scope and Git workflow metadata are immutable after draft status.');
    }
  }

  const existingProjectIdSet = new Set(normalizeProjectIds(existing.projectIds, existing.projectId));
  const nextExecutionModesByProjectId = Object.fromEntries(
    Object.entries(existing.executionModesByProjectId ?? {}).filter(
      ([projectId, mode]) => projectIds.includes(projectId) && (mode === 'git' || mode === 'direct'),
    ),
  ) as Record<string, 'git' | 'direct'>;
  for (const projectId of projectIds) {
    if (existingProjectIdSet.has(projectId) || nextExecutionModesByProjectId[projectId]) continue;
    const observedMode = registrySnapshot?.executionModeByProjectId.get(projectId);
    if (observedMode === 'git' || observedMode === 'direct') {
      nextExecutionModesByProjectId[projectId] = observedMode;
    }
  }

  const candidateResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, {
    ...existing,
    slug: requestedSlug,
    title: isCanonicalPlan ? existing.title : input.title?.trim() || existing.title,
    label: isCanonicalPlan
      ? (input.label !== undefined || input.title !== undefined ? requestedLabel : existing.label)
      : normalizePlanLabel(input.label) ?? existing.label,
    description: input.description !== undefined ? input.description.trim() : existing.description,
    planKind,
    gitFlowPlan: normalizedGitFlowPlan,
    conversationId: input.conversationId !== undefined ? input.conversationId : existing.conversationId,
    status: input.status || existing.status,
    targetBranchesByProjectId: normalizedTargetBranchesByProjectId,
    executionModesByProjectId: nextExecutionModesByProjectId,
    projectId: projectIds[0],
    projectIds,
    contextProjectIds,
    expectedProjectIds,
    nodes: nextNodes,
    predictedBranches: nextPredictedBranches,
    updatedAt: existing.updatedAt,
    revision: existing.revision,
  }, registrySnapshot, {
    logContext: 'plan_update',
  });
  if (!candidateResult.plan) {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  const candidate = candidateResult.plan;

  const targetScopes = await ensurePlanScopes(
    candidate.expectedProjectIds || candidate.projectIds || [],
    registrySnapshot,
    deps,
    getPlanExecutionModes(candidate, registrySnapshot),
  );
  const existingScopes = dedupeScopes([
    ...replicaSet.expectedScopes,
    ...replicaSet.snapshots.map((snapshot) => snapshot.scope),
  ]);
  const targetScopeKeys = new Set(targetScopes.map((scope) => scope.scopeKey));
  const existingScopeKeys = new Set(existingScopes.map((scope) => scope.scopeKey));
  const removedScopes = existingScopes.filter((scope) => !targetScopeKeys.has(scope.scopeKey));
  const writeScopes = dedupeScopes([
    ...targetScopes,
    ...existingScopes.filter((scope) => targetScopeKeys.has(scope.scopeKey)),
  ]);
  const hasScopeChanges =
    targetScopes.length !== existingScopes.length ||
    targetScopes.some((scope) => !existingScopeKeys.has(scope.scopeKey));
  const hasSemanticChange = !areArchitectPlansSemanticallyEqual(existing, candidate);
  let shouldActivate = input.setActive === true;
  if (shouldActivate) {
    const activationStates = await Promise.all(
      targetScopes.map(async (scope) => {
        const index = await readIndexAtScope(scope, normalizedBranch, registrySnapshot);
        const exists = index.plans.some((plan) => plan.id === safeId && plan.status !== 'deleted');
        return exists && index.activePlanId !== safeId;
      })
    );
    shouldActivate = activationStates.some(Boolean);
  }
  if (!hasSemanticChange && !hasScopeChanges && !shouldActivate) {
    return existing;
  }

  if (!hasSemanticChange && !hasScopeChanges && shouldActivate) {
    const targets = await Promise.all(targetScopes.map(async (scope): Promise<ArchitectPlanReplicaMutationTarget> => {
      const index = await readIndexAtScope(scope, normalizedBranch, registrySnapshot);
      return {
        scope,
        action: 'index',
        plan: null,
        executionModesByProjectId: getPlanExecutionModes(existing, registrySnapshot),
        index: { ...index, version: 3, activePlanId: safeId },
      };
    }));
    await runArchitectPlanReplicaMutation({
      branchName: normalizedBranch,
      planId: safeId,
      operation: 'update',
      targets,
      registrySnapshot,
      deps,
      commitMessage: `chore(metadata): activate architect plan ${safeId}`,
    });
    return existing;
  }

  const nextCandidate = applyArchitectPlanLifecycleForStatus({
    ...candidate,
    updatedAt: new Date().toISOString(),
    revision: (existing.revision || 1) + 1,
  }, existing.status);
  const nextResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, nextCandidate, registrySnapshot, {
    logContext: 'plan_update',
  });
  if (!nextResult.plan) {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  const next = nextResult.plan;

  const targets = [
    ...await Promise.all(writeScopes.map((scope) => buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: next,
      registrySnapshot,
      setActive: shouldActivate,
      chatMessageCount: replicaSet.canonical.manifest.conversation.messageCount,
    }))),
    ...await Promise.all(removedScopes.map((scope) => buildRemoveReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      planId: next.id,
      plan: next,
      registrySnapshot,
    }))),
  ];
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: next.id,
    operation: existing.status === 'archived' && next.status !== 'archived' ? 'restore' : 'update',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): update architect plan ${next.id}`,
  });
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: next.id,
  });

  try {
    return (await getArchitectPlan(normalizedBranch, next.id, deps)) || next;
  } catch (error) {
    if (isArchitectPlanReplicaDivergenceError(error)) {
      devLogger.warn(
        JSON.stringify({
          event: 'architect_plan_post_update_replica_verification_failed',
          at: new Date().toISOString(),
          branchName: normalizedBranch,
          planId: next.id,
          reason: error.divergence.reason,
        })
      );
      return {
        ...next,
        hasReplicaDivergence: true,
        replicationState: 'diverged',
        replicas: error.divergence.replicas,
      };
    }
    throw error;
  }
  });
};

export const bindArchitectPlanConversationWithReplicaSet = async (params: {
  normalizedBranch: string;
  safeId: string;
  conversationId: string;
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
  replicaSet: ArchitectPlanReplicaSet;
  deps: ResolvedArchitectPlanServiceDependencies;
}): Promise<ArchitectPlanRecord> => {
  const {
    normalizedBranch,
    safeId,
    conversationId,
    registrySnapshot,
    replicaSet,
    deps,
  } = params;
  const existing = replicaSet.canonical.plan;
  if (existing.status === 'deleted') {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  if (existing.conversationId === conversationId) {
    return existing;
  }
  assertPlanReplicaSetWritable(replicaSet, 'bind conversation');

  const nextResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, {
    ...existing,
    conversationId,
    updatedAt: new Date().toISOString(),
    revision: (existing.revision || 1) + 1,
  }, registrySnapshot, {
    logContext: 'plan_bind_conversation',
  });
  if (!nextResult.plan) {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  const nextPlan = nextResult.plan;
  const scopes = dedupeScopes(replicaSet.expectedScopes);

  const targets = await Promise.all(scopes.map(async (scope) => {
    const chatMessages = await readPlanChatAtScope(scope, normalizedBranch, nextPlan.id);
    return buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: nextPlan,
      registrySnapshot,
      chatMessages,
      chatMessageCount: chatMessages.length,
    });
  }));
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: safeId,
    operation: 'bind',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): bind architect plan conversation ${safeId}`,
  });
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: safeId,
  });

  try {
    return (await getArchitectPlan(normalizedBranch, safeId, deps)) || nextPlan;
  } catch (error) {
    if (isArchitectPlanReplicaDivergenceError(error)) {
      devLogger.warn(
        JSON.stringify({
          event: 'architect_plan_post_update_replica_verification_failed',
          at: new Date().toISOString(),
          branchName: normalizedBranch,
          planId: safeId,
          reason: error.divergence.reason,
        })
      );
      return {
        ...nextPlan,
        hasReplicaDivergence: true,
        replicationState: 'diverged',
        replicas: error.divergence.replicas,
      };
    }
    throw error;
  }
};

export const bindArchitectPlanConversation = async (params: {
  branchName: string;
  planId: string;
  conversationId: string;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(params.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(params.planId);
  const conversationId = params.conversationId.trim();
  if (!conversationId) {
    throw new Error('Conversation id is required to bind an architect plan conversation.');
  }

  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    return bindArchitectPlanConversationWithReplicaSet({
      normalizedBranch,
      safeId,
      conversationId,
      registrySnapshot,
      replicaSet,
      deps,
    });
  });
};

export const setActiveArchitectPlan = async (
  branchName: string,
  planId: string,
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
    if (
      !replicaSet ||
      replicaSet.canonical.plan.status === 'deleted' ||
      replicaSet.canonical.plan.status === 'archived'
    ) {
      throw new Error(`Cannot activate missing, deleted, or archived plan: ${planId}`);
    }

    const targets = (await Promise.all(
      dedupeScopes(replicaSet.expectedScopes).map(async (scope): Promise<ArchitectPlanReplicaMutationTarget | null> => {
        const index = await readIndexAtScope(scope, normalizedBranch, registrySnapshot);
        const exists = index.plans.some((plan) => plan.id === safeId && plan.status !== 'deleted');
        if (!exists || index.activePlanId === safeId) {
          return null;
        }
        return {
          scope,
          action: 'index',
          plan: null,
          executionModesByProjectId: getPlanExecutionModes(replicaSet.canonical.plan, registrySnapshot),
          index: {
            ...index,
            version: 3,
            activePlanId: safeId,
          },
        };
      })
    )).filter((target): target is ArchitectPlanReplicaMutationTarget => target !== null);
    if (targets.length > 0) {
      await runArchitectPlanReplicaMutation({
        branchName: normalizedBranch,
        planId: safeId,
        operation: 'activate',
        targets,
        registrySnapshot,
        deps,
        commitMessage: `chore(metadata): activate architect plan ${safeId}`,
      });
    }
    invalidateArchitectPlanRuntimeCaches({ branchName: normalizedBranch });
  });
};

export const deleteArchitectPlan = async (input: {
  branchName: string;
  planId: string;
  hardDelete?: boolean;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<void> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    const scopes = dedupeScopes(replicaSet.expectedScopes);

    if (input.hardDelete) {
      const targets = await Promise.all(scopes.map((scope) => buildRemoveReplicaMutationTarget({
        scope,
        branchName: normalizedBranch,
        planId: safeId,
        plan: replicaSet.canonical.plan,
        registrySnapshot,
      })));
      await runArchitectPlanReplicaMutation({
        branchName: normalizedBranch, planId: safeId, operation: 'delete', targets, registrySnapshot, deps,
        commitMessage: `chore(metadata): hard delete architect plan ${safeId}`,
      });
      invalidateArchitectPlanRuntimeCaches({
        branchName: normalizedBranch,
        planId: safeId,
      });
      return;
    }

    const deletedRecord = applyArchitectPlanLifecycleForStatus({
      ...replicaSet.canonical.plan,
      status: 'deleted' as ArchitectPlanStatus,
      updatedAt: new Date().toISOString(),
      revision: (replicaSet.canonical.plan.revision || 1) + 1,
    }, replicaSet.canonical.plan.status);
    const deletedResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, deletedRecord, registrySnapshot, {
      logContext: 'plan_delete',
    });
    if (!deletedResult.plan) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    const deleted = deletedResult.plan;
    const targets = await Promise.all(scopes.map((scope) => buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: deleted,
      registrySnapshot,
      setActive: false,
      chatMessageCount: replicaSet.canonical.manifest.conversation.messageCount,
    }).then((target) => ({
      ...target,
      index: {
        ...target.index,
        activePlanId: target.index.activePlanId === safeId
          ? target.index.plans.find((plan) => plan.status !== 'deleted' && plan.status !== 'archived')?.id || null
          : target.index.activePlanId,
      },
    }))));
    await runArchitectPlanReplicaMutation({
      branchName: normalizedBranch, planId: safeId, operation: 'delete', targets, registrySnapshot, deps,
      commitMessage: `chore(metadata): delete architect plan ${safeId}`,
    });
    invalidateArchitectPlanRuntimeCaches({
      branchName: normalizedBranch,
      planId: safeId,
    });
  });
};

export const restoreArchitectPlan = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const existing = await getArchitectPlan(normalizedBranch, planId, deps);
  if (!existing || existing.status === 'deleted') {
    throwPlanMetadataMissing(normalizedBranch, planId);
  }
  const restoredStatus =
    existing.status === 'archived'
      ? resolveArchivedArchitectPlanRestoreStatus(existing)
      : existing.status;
  return updateArchitectPlan({ branchName: normalizedBranch, planId, status: restoredStatus }, deps);
};

export const archiveArchitectPlan = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) throwPlanMetadataMissing(normalizedBranch, safeId);
    assertPlanReplicaSetWritable(replicaSet, 'archive');
    const now = new Date().toISOString();
    const archivedRecord = applyArchitectPlanLifecycleForStatus({
      ...replicaSet.canonical.plan,
      status: 'archived',
      updatedAt: now,
      revision: (replicaSet.canonical.plan.revision || 1) + 1,
    }, replicaSet.canonical.plan.status);
    const archivedResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, archivedRecord, registrySnapshot, {
      logContext: 'plan_archive',
    });
    if (!archivedResult.plan) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    const archived = archivedResult.plan;
    const targets = await Promise.all(dedupeScopes(replicaSet.expectedScopes).map((scope) =>
      buildUpsertReplicaMutationTarget({
        scope,
        branchName: normalizedBranch,
        plan: archived,
        registrySnapshot,
        chatMessageCount: replicaSet.canonical.manifest.conversation.messageCount,
      }).then((target) => ({
        ...target,
        index: {
          ...target.index,
          activePlanId: target.index.activePlanId === safeId
            ? target.index.plans.find((plan) => plan.status !== 'deleted' && plan.status !== 'archived')?.id || null
            : target.index.activePlanId,
        },
      }))
    ));
    await runArchitectPlanReplicaMutation({
      branchName: normalizedBranch, planId: safeId, operation: 'archive', targets, registrySnapshot, deps,
      commitMessage: `chore(metadata): archive architect plan ${safeId}`,
    });
    invalidateArchitectPlanRuntimeCaches({
      branchName: normalizedBranch,
      planId: safeId,
    });
    return (await getArchitectPlan(normalizedBranch, safeId, deps)) || archived;
  });
};

/** Serialized plan commands, including task status derivation under the branch queue without a store or UI dependency. */
export interface ArchitectPlanMutationService {
  createArchitectPlan: typeof createArchitectPlan;
  updateArchitectPlan: typeof updateArchitectPlan;
  mutateArchitectPlan: typeof mutateArchitectPlan;
  mutateArchitectPlanTaskStatus: typeof mutateArchitectPlanTaskStatus;
  bindArchitectPlanConversation: typeof bindArchitectPlanConversation;
  setActiveArchitectPlan: typeof setActiveArchitectPlan;
  deleteArchitectPlan: typeof deleteArchitectPlan;
  restoreArchitectPlan: typeof restoreArchitectPlan;
  archiveArchitectPlan: typeof archiveArchitectPlan;
}

export const createArchitectPlanMutationService = (overrides: ArchitectPlanServiceDependencies = {}): ArchitectPlanMutationService => {
  const deps = resolveArchitectPlanServiceDependencies(overrides);
  return {
    createArchitectPlan: (input) => createArchitectPlan(input, deps),
    updateArchitectPlan: (input) => updateArchitectPlan(input, deps),
    mutateArchitectPlan: (input, deriveUpdate) => mutateArchitectPlan(input, deriveUpdate, deps),
    mutateArchitectPlanTaskStatus: (input, deriveUpdate) => mutateArchitectPlanTaskStatus(input, deriveUpdate, deps),
    bindArchitectPlanConversation: (params) => bindArchitectPlanConversation(params, deps),
    setActiveArchitectPlan: (branchName, planId) => setActiveArchitectPlan(branchName, planId, deps),
    deleteArchitectPlan: (input) => deleteArchitectPlan(input, deps),
    restoreArchitectPlan: (branchName, planId) => restoreArchitectPlan(branchName, planId, deps),
    archiveArchitectPlan: (branchName, planId) => archiveArchitectPlan(branchName, planId, deps),
  };
};
