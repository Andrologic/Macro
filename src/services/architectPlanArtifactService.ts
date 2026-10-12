import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  PlanNodeArtifactContract,
  PlanTaskArtifact,
  PlanTaskArtifactContentType,
  PlanTaskArtifactReview,
} from '../types';
import {
  normalizeArtifactContracts,
  sanitizeId,
} from '../domains/plans/artifactContracts';
import type { ProjectExecutionContext } from './projectExecutionContext';
import type { ArchitectPlanRecord } from './architectPlanService';
import {
  getArchitectPlan,
  getGitFlowBaseBranch,
  resolveTargetBranch,
} from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import { getTaskBusinessId, resolveTaskReference, toTaskRuntimeId } from './durableIdentity';
import { isPlanFinalizationTask } from './implementTaskCatalog';
import {
  enqueueArchitectPlanMutation,
  getPlanExecutionModes,
  recoverArchitectPlanReplicaMutationsUnlocked,
  resolveReplicaWorkspaceKey,
  withReplicaTransactionLock,
} from './architectPlanMutationPersistence';
import {
  resolveArchitectPlanServiceDependencies, getProjectMetadataScopes, getScopeWorkspaceScope, existingMetadataScope,
} from './architectPlanReadContext';
import {
  assertGitFlowTargetBranch, normalizeBranchName as normalizePlanBranchName, sanitizeId as sanitizePlanId,
  sanitizeArchitectPlanRecord, compareReplicaRecency, getPlanJsonPath,
  getPlanManifestPath as getPlanManifestPathFromModel, buildComparablePlanSnapshot,
  getArchitectPlanActionableProjectIds, normalizeContextProjectIds, toReplicaDescriptor,
  type ArchitectMetadataScope, type ArchitectPlanManifest,
} from './architectPlanReadModel';
import { normalizeArchitectPlanScope, normalizeArchitectPlanIdList } from './architectPlanScope';
import { normalizeArtifactManifestSummary } from './architectPlanReplicaStorage';
import { buildValidProjectRegistrySnapshot } from './validProjectRegistry';
import type { ArtifactFileMutation } from './architectPlanArtifactPersistence';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';
import { toServiceError } from './contracts/errors';
import {
  collectKnownProjectIds,
  getProjectSelectionScopedProjectIds,
  resolveExecutionProjectIds,
  retargetPlanForExecution,
} from './projectIdentityReconciliation';
import { filterNonWslProjectPaths } from './wslPaths';

const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';

type ArtifactWorkspaceTarget = {
  workspacePath: string;
  workspaceScope: 'metadata' | 'metadata_existing' | 'direct';
};

export class PlanTaskArtifactIndexReadError extends Error {
  constructor(planId: string, path: string, cause?: unknown) {
    super(`Unable to read artifact index ${path} for plan ${planId}: ${toServiceError(cause).message}`);
    this.name = 'PlanTaskArtifactIndexReadError';
  }
}

const serializeArtifactMutation = enqueueArchitectPlanMutation;

const withArtifactRecovery = async <T>(operation: (workspaceKey: string) => Promise<T>): Promise<T> => {
  if (!tauriIpc.isTauriAvailable()) return operation('');
  const deps = resolveArchitectPlanServiceDependencies({ getAppState: () => useAppStore.getState() });
  const registry = buildValidProjectRegistrySnapshot(useAppStore.getState());
  const workspaceKey = await resolveReplicaWorkspaceKey(deps, registry);
  return withReplicaTransactionLock(workspaceKey, async () => {
    await recoverArchitectPlanReplicaMutationsUnlocked(deps, registry, workspaceKey);
    return operation(workspaceKey);
  });
};

export interface PlanTaskArtifactIndex {
  schemaVersion: 1;
  planId: string;
  updatedAt: string;
  artifacts: PlanTaskArtifact[];
  reviews?: PlanTaskArtifactReview[];
}

export interface VisiblePlanTaskArtifact extends PlanTaskArtifact {
  visibility: 'own' | 'inherited';
}

export interface VisiblePlanTaskArtifactReviewEntry {
  artifact: VisiblePlanTaskArtifact;
  review: PlanTaskArtifactReview | null;
  hasValidatedReview: boolean;
  hasPendingReview: boolean;
}

export interface VisiblePlanTaskArtifactDiff {
  artifact: VisiblePlanTaskArtifact;
  content: string;
  previousArtifact: VisiblePlanTaskArtifact | null;
  previousContent: string;
  status: 'added' | 'modified';
}

export interface MissingRequiredPlanTaskArtifact {
  contract: PlanNodeArtifactContract;
  taskId: string;
}

export interface PlanArtifactExpectedOverviewItem {
  id: string;
  taskId: string;
  taskTitle: string;
  contract: PlanNodeArtifactContract;
}

export interface PlanArtifactOverview {
  entries: VisiblePlanTaskArtifactReviewEntry[];
  expected: PlanArtifactExpectedOverviewItem[];
}

export interface TaskArtifactToolTarget {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  currentTask: CatalogedImplementTask;
}

export interface ResolveTaskArtifactTargetParams {
  args: Record<string, unknown>;
  executionContext: ProjectExecutionContext;
  selectedTaskId?: string | null;
  tasks: CatalogedImplementTask[];
  mutating?: boolean;
  getArchitectPlan: (branchName: string, planId: string) => Promise<ArchitectPlanRecord | null>;
}

export interface PutTaskArtifactParams {
  target: TaskArtifactToolTarget;
  args: Record<string, unknown>;
  createdBy?: string;
}

const normalizeBranchName = (value?: string | null): string => {
  try {
    return resolveTargetBranch(value || getGitFlowBaseBranch());
  } catch {
    return getGitFlowBaseBranch();
  }
};

const slugify = (value: string): string =>
  sanitizeId(value).replace(/[._]+/g, '-').slice(0, 60) || `artifact-${Date.now()}`;

const unique = (items: Array<string | null | undefined>): string[] =>
  Array.from(
    new Set(
      items
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

export const taskArtifactContentHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const stableSortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableSortObject((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
};

const stableSerialize = (value: unknown): string => JSON.stringify(stableSortObject(value));

export const getPlanArtifactIndexPath = (branchName: string, planId: string): string =>
  `branches/${normalizeBranchName(branchName)}/plans/${sanitizeId(planId)}/artifacts/index.json`;

export const getPlanArtifactContentPath = (
  branchName: string,
  planId: string,
  taskId: string,
  artifactId: string,
  contentType: PlanTaskArtifactContentType,
): string => {
  const extension =
    contentType === 'json'
      ? 'json'
      : contentType === 'text'
        ? 'txt'
        : 'md';
  return `branches/${normalizeBranchName(branchName)}/plans/${sanitizeId(planId)}/artifacts/tasks/${sanitizeId(taskId)}/${sanitizeId(artifactId)}.${extension}`;
};

const getPlanManifestPath = (branchName: string, planId: string): string =>
  `branches/${normalizeBranchName(branchName)}/plans/${sanitizeId(planId)}/manifest.json`;

const emptyArtifactIndex = (planId: string): PlanTaskArtifactIndex => ({
  schemaVersion: 1,
  planId,
  updatedAt: new Date().toISOString(),
  artifacts: [],
  reviews: [],
});

const normalizeContentType = (raw: unknown): PlanTaskArtifactContentType => {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'json' || value === 'text' || value === 'markdown') {
    return value;
  }
  return 'markdown';
};

const normalizeArtifactContent = (
  content: unknown,
  contentType: PlanTaskArtifactContentType,
): string => {
  if (contentType === 'json' && typeof content !== 'string') {
    return `${JSON.stringify(content ?? {}, null, 2)}\n`;
  }
  const text = typeof content === 'string' ? content : String(content ?? '');
  if (contentType !== 'json') {
    return text;
  }
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return text;
  }
};

const normalizeArtifactIndex = (
  planId: string,
  parsed: Partial<PlanTaskArtifactIndex> | null,
): PlanTaskArtifactIndex => ({
  schemaVersion: 1,
  planId,
  updatedAt:
    typeof parsed?.updatedAt === 'string' && parsed.updatedAt.trim()
      ? parsed.updatedAt
      : new Date().toISOString(),
  artifacts: Array.isArray(parsed?.artifacts)
    ? parsed.artifacts
        .filter((artifact): artifact is PlanTaskArtifact =>
          Boolean(
            artifact &&
              typeof artifact.id === 'string' &&
              typeof artifact.planId === 'string' &&
              typeof artifact.taskId === 'string' &&
              typeof artifact.path === 'string',
          ),
        )
        .map((artifact) => ({
          ...artifact,
          id: sanitizeId(artifact.id),
          planId,
          taskId: artifact.taskId,
          kind: typeof artifact.kind === 'string' && artifact.kind.trim() ? artifact.kind.trim() : 'note',
          title: typeof artifact.title === 'string' && artifact.title.trim() ? artifact.title.trim() : artifact.id,
          summary: typeof artifact.summary === 'string' ? artifact.summary.trim() : '',
          contentType: normalizeContentType(artifact.contentType),
          createdAt: typeof artifact.createdAt === 'string' ? artifact.createdAt : new Date().toISOString(),
          updatedAt: typeof artifact.updatedAt === 'string' ? artifact.updatedAt : new Date().toISOString(),
          createdBy: typeof artifact.createdBy === 'string' && artifact.createdBy.trim() ? artifact.createdBy.trim() : 'agent',
          ...(typeof artifact.contractId === 'string' && artifact.contractId.trim()
            ? { contractId: sanitizeId(artifact.contractId) }
            : {}),
          ...(typeof artifact.supersedes === 'string' && artifact.supersedes.trim()
            ? { supersedes: sanitizeId(artifact.supersedes) }
            : {}),
        }))
    : [],
  reviews: Array.isArray(parsed?.reviews)
    ? parsed.reviews
        .filter((review): review is PlanTaskArtifactReview =>
          Boolean(
            review &&
              typeof review.artifactId === 'string' &&
              typeof review.taskId === 'string' &&
              typeof review.validatedAt === 'string',
          ),
        )
        .map((review) => ({
          artifactId: sanitizeId(review.artifactId),
          taskId: sanitizeId(review.taskId),
          validatedAt: review.validatedAt,
          validatedBy:
            typeof review.validatedBy === 'string' && review.validatedBy.trim()
              ? review.validatedBy.trim()
              : 'user',
        }))
    : [],
});

const getPlanWorkspaceHints = (
  plan: Pick<
    ArchitectPlanRecord,
    'projectId' | 'projectIds' | 'availableProjectIds' | 'replicas' | 'executionModesByProjectId'
  >,
  repoPaths: Array<string | null | undefined> = [],
) => ({
  projectIds: unique([...(plan.projectIds || []), plan.projectId]),
  availableProjectIds: plan.availableProjectIds,
  replicas: plan.replicas,
  executionModesByProjectId: plan.executionModesByProjectId,
  repoPaths: [
    ...repoPaths,
    ...(plan.replicas || []).map((replica) => replica.repoPath),
  ],
});

const resolveWorkspacePaths = async (params: {
  projectId?: string | null;
  projectIds?: string[] | null;
  availableProjectIds?: string[] | null;
  replicas?: ArchitectPlanRecord['replicas'];
  repoPaths?: Array<string | null | undefined>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  allowFallbackPaths?: boolean;
  existingMetadataOnly?: boolean;
}): Promise<ArtifactWorkspaceTarget[]> => {
  const appState = useAppStore.getState();
  const knownProjectIds = collectKnownProjectIds({
    standaloneProjects: appState.standaloneProjects,
    projectGroups: appState.projectGroups,
  });
  const scopedProjectIds = getProjectSelectionScopedProjectIds({
    standaloneProjects: appState.standaloneProjects,
    projectGroups: appState.projectGroups,
    selectedGroupId: appState.selectedGroupId,
    selectedProjectId: appState.selectedProjectId,
  });
  const projectIds = resolveExecutionProjectIds({
    persistedIds: [...(params.projectIds || []), params.projectId],
    availableProjectIds: params.availableProjectIds || [],
    replicas: params.replicas || [],
    scopedProjectIds,
    knownProjectIds,
  });
  const registeredTargets = projectIds.flatMap((projectId): ArtifactWorkspaceTarget[] => {
    const projectPath = typeof appState.getProjectById === 'function'
      ? appState.getProjectById(projectId)?.path ?? null
      : null;
    if (!projectPath || filterNonWslProjectPaths([projectPath]).length === 0) {
      return [];
    }
    return [{
      workspacePath: projectPath,
      workspaceScope: params.executionModesByProjectId?.[projectId] === 'direct'
        ? 'direct'
        : params.existingMetadataOnly ? 'metadata_existing' : METADATA_WORKSPACE_SCOPE,
    }];
  });
  if (registeredTargets.length > 0) {
    return Array.from(new Map(
      registeredTargets.map((target) => [`${target.workspaceScope}:${target.workspacePath}`, target])
    ).values());
  }
  if (params.allowFallbackPaths === false) {
    return [];
  }
  const replicaRepoPaths = (params.replicas || []).map((replica) => replica.repoPath);
  let activeRoot: string | null = null;
  if (tauriIpc.isTauriAvailable()) {
    try {
      activeRoot = await tauriIpc.workspaceGetActiveRoot();
    } catch {
      activeRoot = null;
    }
  }
  const fallbackScope = projectIds.length > 0 && projectIds.every(
    (projectId) => params.executionModesByProjectId?.[projectId] === 'direct'
  ) ? 'direct' : params.existingMetadataOnly ? 'metadata_existing' : METADATA_WORKSPACE_SCOPE;
  return filterNonWslProjectPaths(
    unique([...(params.repoPaths || []), ...replicaRepoPaths, activeRoot]),
  ).map((workspacePath) => ({ workspacePath, workspaceScope: fallbackScope }));
};

const readTextAtWorkspace = async (
  target: ArtifactWorkspaceTarget,
  path: string,
): Promise<string | null> => {
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: target.workspaceScope,
      workspacePath: target.workspacePath,
    });
    return file.content;
  } catch {
    return null;
  }
};

const buildArtifactManifestSummary = (index: PlanTaskArtifactIndex) => ({
  count: index.artifacts.length,
  indexHash: taskArtifactContentHash(stableSerialize(index.artifacts.map((artifact) => ({
    id: artifact.id,
    taskId: artifact.taskId,
    kind: artifact.kind,
    title: artifact.title,
    summary: artifact.summary,
    contentType: artifact.contentType,
    path: artifact.path,
    contentHash: artifact.contentHash,
    contractId: artifact.contractId,
    supersedes: artifact.supersedes,
    updatedAt: artifact.updatedAt,
  })))),
  contentHash: taskArtifactContentHash(index.artifacts.map((artifact) => artifact.contentHash).sort().join('\n')),
  reviewHash: taskArtifactContentHash(stableSerialize((index.reviews || []).map((review) => ({
    artifactId: review.artifactId,
    taskId: review.taskId,
    validatedAt: review.validatedAt,
    validatedBy: review.validatedBy,
  })))),
  updatedAt: index.updatedAt,
});

export const readPlanTaskArtifactIndex = async (params: {
  branchName: string;
  planId: string;
  projectId?: string | null;
  projectIds?: string[] | null;
  availableProjectIds?: string[] | null;
  replicas?: ArchitectPlanRecord['replicas'];
  repoPaths?: Array<string | null | undefined>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  existingMetadataOnly?: boolean;
}): Promise<PlanTaskArtifactIndex> => withArtifactRecovery(async () => {
  if (!tauriIpc.isTauriAvailable()) {
    return emptyArtifactIndex(params.planId);
  }
  const { readArtifactFileSnapshot } = await import('./architectPlanArtifactPersistence');
  const indexPath = getPlanArtifactIndexPath(params.branchName, params.planId);
  const workspaceTargets = await resolveWorkspacePaths(params);
  const validIndexes: PlanTaskArtifactIndex[] = [];
  for (const target of workspaceTargets) {
    let indexExists = false;
    try {
      indexExists = await tauriIpc.fsExists(indexPath, {
        workspaceScope: target.workspaceScope,
        workspacePath: target.workspacePath,
      });
    } catch (error) {
      throw new PlanTaskArtifactIndexReadError(params.planId, indexPath, error);
    }
    if (!indexExists) {
      const manifest = await readArtifactFileSnapshot({ ...target, path: getPlanManifestPath(params.branchName, params.planId) });
      if (manifest.content !== null && JSON.parse(manifest.content)?.artifacts) {
        throw new PlanTaskArtifactIndexReadError(params.planId, indexPath, new Error('Artifact index is missing from a manifested replica.'));
      }
      continue;
    }
    try {
      const file = await tauriIpc.fsReadFileWithOptions({
        path: indexPath,
        allowOutsideWorkspace: false,
        workspaceScope: target.workspaceScope,
        workspacePath: target.workspacePath,
      });
      const parsed: unknown = JSON.parse(file.content);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        !Array.isArray((parsed as Partial<PlanTaskArtifactIndex>).artifacts) ||
        ((parsed as Partial<PlanTaskArtifactIndex>).planId !== undefined &&
          (parsed as Partial<PlanTaskArtifactIndex>).planId !== params.planId)
      ) {
        throw new Error('Artifact index has an invalid schema.');
      }
      const raw = parsed as PlanTaskArtifactIndex;
      const index = normalizeArtifactIndex(params.planId, raw);
      if (raw.schemaVersion !== 1 || raw.planId !== params.planId || index.artifacts.length !== raw.artifacts.length ||
        raw.artifacts.some((artifact) => artifact.planId !== params.planId ||
          artifact.id !== sanitizeId(artifact.id) || !artifact.taskId.trim() ||
          !['markdown', 'json', 'text'].includes(artifact.contentType)) ||
        new Set(index.artifacts.map((artifact) => artifact.id)).size !== index.artifacts.length) {
        throw new Error('Invalid artifact entry or schema.');
      }
      for (const artifact of index.artifacts) {
        if (artifact.path.split('/').some((part) => part === '.' || part === '..') ||
          artifact.path !== getPlanArtifactContentPath(params.branchName, params.planId, artifact.taskId, artifact.id, artifact.contentType)) {
          throw new Error(`Invalid artifact content path: ${artifact.id}`);
        }
        const content = await readArtifactFileSnapshot({ ...target, path: artifact.path });
        if (content.content === null || taskArtifactContentHash(content.content) !== artifact.contentHash) {
          throw new Error(`Artifact content does not match its index: ${artifact.id}`);
        }
      }
      const manifest = await readArtifactFileSnapshot({ ...target, path: getPlanManifestPath(params.branchName, params.planId) });
      if (manifest.content !== null) {
        const summary = JSON.parse(manifest.content)?.artifacts;
        if (stableSerialize(summary) !== stableSerialize(buildArtifactManifestSummary(index))) {
          throw new Error('Artifact manifest does not match its index.');
        }
      }
      validIndexes.push(index);
    } catch (error) {
      throw new PlanTaskArtifactIndexReadError(params.planId, indexPath, error);
    }
  }
  if (validIndexes.length === 0) return emptyArtifactIndex(params.planId);
  if (validIndexes.length !== workspaceTargets.length) {
    throw new PlanTaskArtifactIndexReadError(params.planId, indexPath, new Error('Artifact index replica is missing.'));
  }
  const canonical = validIndexes[0]!;
  const canonicalSerialized = stableSerialize(canonical);
  if (validIndexes.some((index) => stableSerialize(index) !== canonicalSerialized)) {
    throw new PlanTaskArtifactIndexReadError(
      params.planId,
      indexPath,
      new Error('Artifact index replicas diverge.'),
    );
  }
  return canonical;
});

const writePlanTaskArtifactIndex = async (params: {
  branchName: string;
  planId: string;
  projectId?: string | null;
  projectIds?: string[] | null;
  availableProjectIds?: string[] | null;
  replicas?: ArchitectPlanRecord['replicas'];
  repoPaths?: Array<string | null | undefined>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  index: PlanTaskArtifactIndex;
  previousIndex: PlanTaskArtifactIndex;
  contentWrites?: Array<{ path: string; content: string }>;
}): Promise<void> => withArtifactRecovery(async (workspaceKey) => {
  if (!tauriIpc.isTauriAvailable()) return;
  const { persistArtifactMutation, readArtifactFileSnapshot } = await import('./architectPlanArtifactPersistence');
  const targets = await resolveWorkspacePaths({ ...params, allowFallbackPaths: false });
  if (targets.length === 0) throw new Error('No registered artifact workspace is available.');
  const files: ArtifactFileMutation[] = [];
  for (const target of targets) {
    if (target.workspaceScope === 'metadata_existing') throw new Error('Artifact writes require a writable metadata scope.');
    const manifestPath = getPlanManifestPath(params.branchName, params.planId);
    const manifest = await readArtifactFileSnapshot({ ...target, path: manifestPath });
    const unchangedContents = [];
    for (const artifact of params.previousIndex.artifacts) {
      if (params.contentWrites?.some((write) => write.path === artifact.path)) continue;
      const snapshot = await readArtifactFileSnapshot({ ...target, path: artifact.path });
      if (snapshot.content === null || taskArtifactContentHash(snapshot.content) !== artifact.contentHash) {
        throw new Error(`Artifact content changed during mutation: ${artifact.id}`);
      }
      unchangedContents.push({ path: artifact.path, content: snapshot.content });
    }
    const writes = [
      ...unchangedContents,
      ...(params.contentWrites || []),
      { path: getPlanArtifactIndexPath(params.branchName, params.planId), content: `${JSON.stringify(params.index, null, 2)}\n` },
    ];
    if (manifest.content !== null) {
      const parsed: unknown = JSON.parse(manifest.content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid artifact manifest.');
      writes.push({ path: manifestPath, content: `${JSON.stringify({
        ...parsed, artifacts: buildArtifactManifestSummary(params.index),
      }, null, 2)}\n` });
    }
    for (const write of writes) {
      const before = write.path === manifestPath ? manifest : await readArtifactFileSnapshot({ ...target, path: write.path });
      if (write.path === getPlanArtifactIndexPath(params.branchName, params.planId)) {
        if (before.content === null
          ? params.previousIndex.artifacts.length > 0 || (params.previousIndex.reviews || []).length > 0
          : stableSerialize(normalizeArtifactIndex(params.planId, JSON.parse(before.content))) !== stableSerialize(params.previousIndex)) {
          throw new Error('Artifact index changed during mutation.');
        }
      }
      const priorArtifact = params.previousIndex.artifacts.find((artifact) => artifact.path === write.path);
      if (priorArtifact && (before.content === null || taskArtifactContentHash(before.content) !== priorArtifact.contentHash)) {
        throw new Error(`Artifact content changed during mutation: ${priorArtifact.id}`);
      }
      if (before.content !== null && !before.revision) throw new Error(`Artifact revision unavailable: ${write.path}`);
      files.push({ workspacePath: target.workspacePath, workspaceScope: target.workspaceScope as 'metadata' | 'direct',
        path: write.path, before: before.content, after: write.content });
    }
  }
  await persistArtifactMutation({ branchName: normalizeBranchName(params.branchName), planId: sanitizeId(params.planId), workspaceKey, files });
});

const getRequestedTaskId = (
  args: Record<string, unknown>,
  executionContext: ProjectExecutionContext,
  selectedTaskId?: string | null,
): string => {
  const explicitTaskId =
    typeof args.task_id === 'string' && args.task_id.trim()
      ? args.task_id.trim()
      : typeof args.taskId === 'string' && args.taskId.trim()
        ? args.taskId.trim()
        : '';
  return explicitTaskId || executionContext.taskId || selectedTaskId || '';
};

const getCurrentTask = (
  params: Pick<ResolveTaskArtifactTargetParams, 'executionContext' | 'selectedTaskId' | 'tasks'>,
): CatalogedImplementTask | null => {
  const currentTaskId =
    params.executionContext.taskId || params.selectedTaskId || '';
  return currentTaskId
    ? resolveTaskReference(params.tasks, currentTaskId) || null
    : null;
};

const assertArtifactTaskContext = (params: {
  requestedTask: CatalogedImplementTask;
  currentTask: CatalogedImplementTask | null;
  mutating?: boolean;
}): void => {
  const { requestedTask, currentTask } = params;
  if (!currentTask) {
    throw toServiceError('task_artifact_* requires a current Implement task context.');
  }
  if (requestedTask.id !== currentTask.id) {
    throw toServiceError('task_artifact_* can only target the current Implement task context.');
  }
  if (currentTask.task_source !== 'architect' && !isPlanFinalizationTask(currentTask)) {
    throw toServiceError('Task artifacts are only available for planned Architect tasks.');
  }
  if (requestedTask.task_source !== 'architect' && !isPlanFinalizationTask(requestedTask)) {
    throw toServiceError('Task artifacts are only available for planned Architect tasks.');
  }
  if (!currentTask.plan_id || !requestedTask.plan_id || currentTask.plan_id !== requestedTask.plan_id) {
    throw toServiceError('task_artifact_* cannot target tasks outside the current Implement plan.');
  }
  if (params.mutating) {
    if (requestedTask.task_source !== 'architect') {
      throw toServiceError('Only Architect implementation tasks can produce artifacts.');
    }
    if (requestedTask.archived_at) {
      throw toServiceError('Archived Architect tasks cannot update artifacts.');
    }
  }
};

export const resolveTaskArtifactTarget = async (
  params: ResolveTaskArtifactTargetParams,
): Promise<TaskArtifactToolTarget> => {
  const requestedTaskId = getRequestedTaskId(
    params.args,
    params.executionContext,
    params.selectedTaskId,
  );
  if (!requestedTaskId) {
    throw toServiceError('task_artifact_* requires an Implement task context or task_id.');
  }
  const task = resolveTaskReference(params.tasks, requestedTaskId);
  if (!task) {
    throw toServiceError(`Unknown task: ${requestedTaskId}`);
  }
  const currentTask = getCurrentTask(params);
  assertArtifactTaskContext({
    requestedTask: task,
    currentTask,
    mutating: params.mutating,
  });
  const branchName = normalizeBranchName(
    task.plan_storage_branch || task.plan_target_branch || getGitFlowBaseBranch(),
  );
  const plan = await params.getArchitectPlan(branchName, task.plan_id);
  if (!plan || plan.status === 'deleted') {
    throw toServiceError(`Cannot load plan metadata for task ${task.id}.`);
  }
  const appState = useAppStore.getState();
  const retargetedPlan = retargetPlanForExecution(plan, {
    scopedProjectIds: unique([
      ...(task.project_ids || []),
      task.project_id,
      ...(task.execution_targets || []).map((target) => target.projectId),
      ...getProjectSelectionScopedProjectIds({
        standaloneProjects: appState.standaloneProjects,
        projectGroups: appState.projectGroups,
        selectedGroupId: appState.selectedGroupId,
        selectedProjectId: appState.selectedProjectId,
      }),
    ]),
    knownProjectIds: collectKnownProjectIds({
      standaloneProjects: appState.standaloneProjects,
      projectGroups: appState.projectGroups,
    }),
  });
  return { branchName, plan: retargetedPlan, task, currentTask: currentTask! };
};

// Legacy indexes may store a catalog runtime id, or its sanitized form. Resolve
// only exact aliases of nodes in this plan; keep the stored bytes for integrity checks.
const artifactTaskNodeId = (taskId: string, branchName: string, plan: ArchitectPlanRecord): string => {
  const matches = plan.nodes.filter((node) => {
    const runtimeId = toTaskRuntimeId({ branchName, planId: plan.id, nodeId: node.id });
    return taskId === node.id || taskId === runtimeId || taskId === sanitizeId(runtimeId);
  });
  return matches.length === 1 ? matches[0]!.id : taskId;
};

export const resolveVisiblePlanTaskIds = (params: {
  plan: Pick<ArchitectPlanRecord, 'nodes'>;
  task: Pick<CatalogedImplementTask, 'id' | 'node_id' | 'dependencies' | 'task_source'>;
  includeInherited?: boolean;
  includeOwn?: boolean;
}): Set<string> => {
  const includeInherited = params.includeInherited !== false;
  const includeOwn = params.includeOwn !== false && !isPlanFinalizationTask(params.task);
  const nodeById = new Map((params.plan.nodes || []).map((node) => [node.id, node]));
  const visible = new Set<string>();
  const visited = new Set<string>();

  if (params.task.task_source !== 'architect' && !isPlanFinalizationTask(params.task)) {
    return visible;
  }

  const addAncestors = (taskId: string): void => {
    if (visited.has(taskId)) {
      return;
    }
    visited.add(taskId);
    const node = nodeById.get(taskId);
    if (!node) {
      return;
    }
    visible.add(taskId);
    node.dependencies.forEach(addAncestors);
  };

  if (isPlanFinalizationTask(params.task)) {
    if (includeInherited) {
      (params.task.dependencies || []).forEach(addAncestors);
    }
    return visible;
  }

  const currentNode = nodeById.get(getTaskBusinessId(params.task));
  if (includeOwn && currentNode) {
    visible.add(getTaskBusinessId(params.task));
  }
  if (includeInherited && currentNode) {
    currentNode.dependencies.forEach(addAncestors);
  }
  return visible;
};

export const listVisibleTaskArtifacts = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  includeInherited?: boolean;
  includeOwn?: boolean;
  existingMetadataOnly?: boolean;
}): Promise<VisiblePlanTaskArtifact[]> => {
  const index = await readPlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(params.plan),
    existingMetadataOnly: params.existingMetadataOnly,
  });
  const visibleTaskIds = resolveVisiblePlanTaskIds({
    plan: params.plan,
    task: params.task,
    includeInherited: params.includeInherited,
    includeOwn: params.includeOwn,
  });
  return index.artifacts
    .filter((artifact) => visibleTaskIds.has(artifactTaskNodeId(artifact.taskId, params.branchName, params.plan)))
    .map((artifact) => ({
      ...artifact,
      visibility: (artifactTaskNodeId(artifact.taskId, params.branchName, params.plan) === getTaskBusinessId(params.task) ? 'own' : 'inherited') as VisiblePlanTaskArtifact['visibility'],
    }))
    .sort((left, right) => {
      if (left.visibility !== right.visibility) {
        return left.visibility === 'own' ? -1 : 1;
      }
      return left.updatedAt.localeCompare(right.updatedAt) * -1;
    });
};

export const PILOT_TASK_ARTIFACT_EXPORT_LIMITS = Object.freeze({
  metadataBytes: 1024 * 1024,
  artifacts: 2000,
  replicas: 32,
  nativeFileBytes: 10 * 1024 * 1024,
  nativeWorkingBytes: 20 * 1024 * 1024,
  exportedFileBytes: 2 * 1024 * 1024,
  aggregateBytes: 32 * 1024 * 1024,
});

/** A reservation must throw before allocation if it cannot be granted. */
export interface PilotTaskArtifactExportBudget {
  reserve(bytes: number): () => void;
}

export interface PilotTaskArtifactExportEntry {
  artifact: VisiblePlanTaskArtifact;
  sha256: string | null;
  totalBytes: number;
  contentState: 'available' | 'too_large';
}

export interface PilotTaskArtifactPlanSnapshotParams {
  branchName: string;
  planId: string;
  budget?: PilotTaskArtifactExportBudget;
  beforeRead?: () => Promise<void>;
  /** Optional native reader that enforces maxBytes before allocating content. */
  readFileLimited?: (params: {
    path: string;
    workspaceScope: tauriIpc.WorkspaceScope;
    workspacePath: string | null;
    allowOutsideWorkspace: false;
    maxBytes: number;
  }) => Promise<{ content: string }>;
}

/** Reads only registered plan metadata under the workflow lock. Never loads the
 * historical replica set, chat, recursive files, participants or recovery journal. */
export const readPilotTaskArtifactPlanSnapshot = async (
  params: PilotTaskArtifactPlanSnapshotParams,
): Promise<{ plan: ArchitectPlanRecord | null; release: () => void }> => {
  const branchName = normalizePlanBranchName(params.branchName);
  assertGitFlowTargetBranch(branchName);
  const planId = sanitizePlanId(params.planId);
  if (planId !== params.planId) throw new Error('Invalid Pilot artifact plan identifier.');
  const releaseWorking = reservePilotArtifactBytes(params.budget, PILOT_ARTIFACT_METADATA_WORKING_BYTES);
  let releaseRetained: (() => void) | undefined;
  let succeeded = false;
  try {
    if (!tauriIpc.isTauriAvailable()) throw new Error('Pilot artifact export requires the desktop runtime.');
    const registry = buildValidProjectRegistrySnapshot(useAppStore.getState());
    if (registry.validProjectIds.length === 0 || registry.validProjectIds.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.replicas) {
      throw new Error('Pilot artifact plan requires a bounded registered workspace.');
    }
    const deps = resolveArchitectPlanServiceDependencies({ getAppState: () => useAppStore.getState() });
    const workspaceKey = await resolveReplicaWorkspaceKey(deps, registry);
    const result = await withReplicaTransactionLock(workspaceKey, async () => {
      const readMetadata = async (scope: ArchitectMetadataScope, path: string): Promise<unknown | null> => {
        const target = { workspacePath: scope.workspacePath, workspaceScope: getScopeWorkspaceScope(scope) };
        await params.beforeRead?.();
        if (!await tauriIpc.fsExists(path, target)) return null;
        const release = reservePilotArtifactBytes(params.budget, params.readFileLimited
          ? PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes * 2 : PILOT_TASK_ARTIFACT_EXPORT_LIMITS.nativeWorkingBytes);
        try {
          await params.beforeRead?.();
          const file = params.readFileLimited
            ? await params.readFileLimited({ ...target, path, allowOutsideWorkspace: false,
              maxBytes: PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes })
            : await tauriIpc.fsReadFileWithOptions({ ...target, path, allowOutsideWorkspace: false });
          pilotArtifactUtf8Size(file.content, PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
          const parsed: unknown = JSON.parse(file.content);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Pilot plan metadata.');
          return parsed;
        } finally { release(); }
      };
      const readPlan = async (scope: ArchitectMetadataScope): Promise<ArchitectPlanRecord | null> => {
        const parsed = await readMetadata(scope, getPlanJsonPath(branchName, planId));
        if (!parsed) return null;
        const raw = parsed as ArchitectPlanRecord;
        if (raw.id !== planId || !Array.isArray(raw.nodes) || raw.nodes.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.artifacts ||
          (raw.predictedBranches !== undefined && (!Array.isArray(raw.predictedBranches) || raw.predictedBranches.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.artifacts))) {
          throw new Error('Invalid or oversized Pilot artifact plan.');
        }
        const plan = sanitizeArchitectPlanRecord(branchName, planId, raw, registry).plan;
        if (plan) pilotArtifactUtf8Size(stableSerialize(plan), PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
        return plan;
      };
      // Preserve persisted-direct discovery, but retain only its newest candidate.
      let directPlan: ArchitectPlanRecord | null = null;
      let directRepoPath: string | null = null;
      const directModes = Object.fromEntries(registry.validProjectIds.map((id) => [id, 'direct' as const]));
      for (const scope of getProjectMetadataScopes(registry, registry.validProjectIds, directModes)) {
        const plan = await readPlan(scope);
        if (!plan || !scope.projectId || getPlanExecutionModes(plan, registry)[scope.projectId] !== 'direct') continue;
        if (!directPlan || compareReplicaRecency({ updatedAt: directPlan.updatedAt, repoPath: directRepoPath },
          { updatedAt: plan.updatedAt, repoPath: scope.repoPath }) <= 0) {
          directPlan = plan; directRepoPath = scope.repoPath;
        }
      }
      const scopes = (directPlan
        ? getProjectMetadataScopes(registry, normalizeArchitectPlanScope(directPlan, { useExpectedAsActionableFallback: true }).expectedProjectIds,
          getPlanExecutionModes(directPlan, registry))
        : getProjectMetadataScopes(registry)).map(existingMetadataScope);
      directPlan = null;
      if (scopes.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.replicas) throw new Error('Pilot plan replica limit exceeded.');
      let canonical: ArchitectPlanRecord | null = null;
      let canonicalRepoPath: string | null = null;
      let canonicalDigest: string | null = null;
      const replicas: ArchitectPlanRecord['replicas'] = [];
      const availableIds = new Set<string>();
      for (const scope of scopes) {
        const plan = await readPlan(scope);
        if (!plan) continue;
        const parsed = await readMetadata(scope, getPlanManifestPathFromModel(branchName, planId)) as Partial<ArchitectPlanManifest> | null;
        const actionableIds = getArchitectPlanActionableProjectIds(plan);
        const contextIds = normalizeContextProjectIds(parsed?.contextProjectIds ?? plan.contextProjectIds, actionableIds, registry);
        const snapshot: ArchitectPlanRecord = { ...plan, contextProjectIds: contextIds,
          expectedProjectIds: normalizeArchitectPlanIdList(actionableIds, contextIds),
          revision: typeof parsed?.revision === 'number' && Number.isFinite(parsed.revision) && parsed.revision > 0
            ? Math.floor(parsed.revision) : plan.revision };
        const comparable = stableSerialize({ plan: buildComparablePlanSnapshot(snapshot),
          artifacts: normalizeArtifactManifestSummary(parsed?.artifacts) ?? null });
        pilotArtifactUtf8Size(comparable, PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
        const digest = bytesToHex(sha256(new TextEncoder().encode(comparable)));
        if (canonicalDigest !== null && digest !== canonicalDigest) throw new Error('Pilot artifact plan replicas diverge.');
        canonicalDigest = digest;
        replicas.push(toReplicaDescriptor(scope, snapshot.updatedAt));
        if (scope.projectId) availableIds.add(scope.projectId);
        if (!canonical || compareReplicaRecency({ updatedAt: canonical.updatedAt, repoPath: canonicalRepoPath },
          { updatedAt: snapshot.updatedAt, repoPath: scope.repoPath }) <= 0) {
          canonical = snapshot; canonicalRepoPath = scope.repoPath;
        }
      }
      if (!canonical) return null;
      const projectIds = getArchitectPlanActionableProjectIds(canonical);
      const expectedIds = normalizeArchitectPlanIdList(projectIds, canonical.contextProjectIds);
      const availableProjectIds = expectedIds.filter((id) => availableIds.has(id));
      const missingProjectIds = expectedIds.filter((id) => !availableIds.has(id));
      for (const scope of getProjectMetadataScopes(registry, expectedIds, getPlanExecutionModes(canonical, registry))) {
        if (scope.projectId && missingProjectIds.includes(scope.projectId)) replicas.push(toReplicaDescriptor(scope, null, true));
      }
      if (replicas.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.replicas) throw new Error('Pilot plan replica limit exceeded.');
      return { ...canonical, projectId: projectIds[0], projectIds, expectedProjectIds: expectedIds,
        availableProjectIds, missingProjectIds, replicas, hasReplicaDivergence: false,
        replicationState: canonical.status === 'deleted' ? 'deleted' as const
          : missingProjectIds.length ? 'missing_projects' as const : 'healthy' as const };
    });
    if (result) {
      const size = pilotArtifactUtf8Size(stableSerialize(result), PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
      releaseRetained = reservePilotArtifactBytes(params.budget, size * 2);
    }
    releaseWorking();
    succeeded = true;
    return { plan: result, release: () => releaseRetained?.() };
  } finally {
    if (!succeeded) { try { releaseRetained?.(); } finally { releaseWorking(); } }
  }
};

export interface PilotTaskArtifactExportParams {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  includeInherited?: boolean;
  includeOwn?: boolean;
  budget?: PilotTaskArtifactExportBudget;
  /** Called before each native access. The adapter owns authorization and deadline. */
  beforeRead?: () => Promise<void>;
}

/** Reservations cover simultaneous operations and retained results until release. */
export const createPilotTaskArtifactExportBudget = (
  maxBytes = PILOT_TASK_ARTIFACT_EXPORT_LIMITS.aggregateBytes,
): PilotTaskArtifactExportBudget => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.aggregateBytes) {
    throw new Error('Invalid Pilot artifact export budget.');
  }
  let retained = 0;
  return {
    reserve(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes - retained) {
        throw new Error('Pilot artifact export budget exceeded.');
      }
      retained += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained -= bytes;
      };
    },
  };
};

const pilotArtifactExportBudget = createPilotTaskArtifactExportBudget();
// Covers canonical entries, one parsed replica, UTF-16 metadata strings and
// serialization scratch. Both raw and normalized metadata are capped at 1 MiB.
const PILOT_ARTIFACT_METADATA_WORKING_BYTES = 8 * 1024 * 1024;

const reservePilotArtifactBytes = (budget: PilotTaskArtifactExportBudget | undefined, bytes: number): (() => void) => {
  const releaseLocal = pilotArtifactExportBudget.reserve(bytes);
  try {
    const releaseParent = budget?.reserve(bytes);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { releaseParent?.(); } finally { releaseLocal(); }
    };
  } catch (error) {
    releaseLocal();
    throw error;
  }
};

// Count before encoding so even an oversized native response cannot cause a
// second unreserved allocation. Matches TextEncoder, including lone surrogates.
const pilotArtifactUtf8Size = (text: string, maxBytes: number): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maxBytes) throw new Error('Pilot artifact export size limit exceeded.');
  }
  return bytes;
};

const withPilotArtifactText = async <T>(
  target: ArtifactWorkspaceTarget,
  path: string,
  budget: PilotTaskArtifactExportBudget | undefined,
  consume: (text: string) => T,
  beforeRead?: () => Promise<void>,
): Promise<T> => {
  // Reserve the worst-case UTF-16 string before invoking the native 10 MiB read.
  const release = reservePilotArtifactBytes(budget, PILOT_TASK_ARTIFACT_EXPORT_LIMITS.nativeWorkingBytes);
  try {
    await beforeRead?.();
    const file = await tauriIpc.fsReadFileWithOptions({ ...target, path, allowOutsideWorkspace: false });
    return consume(file.content);
  } finally { release(); }
};

const readPilotArtifactReplicaMetadata = async (
  params: PilotTaskArtifactExportParams,
  target: ArtifactWorkspaceTarget,
  visibleTaskIds: Set<string>,
): Promise<{ entries: VisiblePlanTaskArtifact[]; indexSha256: string } | null> => {
  const indexPath = getPlanArtifactIndexPath(params.branchName, params.plan.id);
  const manifestPath = getPlanManifestPath(params.branchName, params.plan.id);
  await params.beforeRead?.();
  const exists = await tauriIpc.fsExists(indexPath, target);
  let index: PlanTaskArtifactIndex | null = null;
  let indexSha256 = '';
  let entries: VisiblePlanTaskArtifact[] = [];
  if (exists) {
    ({ index, indexSha256, entries } = await withPilotArtifactText(target, indexPath, params.budget, (text) => {
      pilotArtifactUtf8Size(text, PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid artifact index.');
      const raw = parsed as PlanTaskArtifactIndex;
      if (raw.schemaVersion !== 1 || raw.planId !== params.plan.id || !Array.isArray(raw.artifacts) ||
        raw.artifacts.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.artifacts ||
        (raw.reviews !== undefined && (!Array.isArray(raw.reviews) || raw.reviews.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.artifacts))) {
        throw new Error('Invalid or oversized artifact index.');
      }
      const normalized = normalizeArtifactIndex(params.plan.id, raw);
      if (normalized.artifacts.length !== raw.artifacts.length ||
        new Set(normalized.artifacts.map((artifact) => artifact.id)).size !== normalized.artifacts.length ||
        raw.artifacts.some((artifact) => artifact.planId !== params.plan.id || artifact.id !== sanitizeId(artifact.id) ||
          !artifact.taskId.trim() || !['markdown', 'json', 'text'].includes(artifact.contentType))) {
        throw new Error('Invalid artifact entry.');
      }
      for (const artifact of normalized.artifacts) {
        if (artifact.path.split('/').some((part) => part === '.' || part === '..') ||
          artifact.path !== getPlanArtifactContentPath(params.branchName, params.plan.id, artifact.taskId, artifact.id, artifact.contentType)) {
          throw new Error('Invalid artifact content path.');
        }
      }
      const serialized = stableSerialize(normalized);
      pilotArtifactUtf8Size(serialized, PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
      return {
        index: normalized,
        indexSha256: bytesToHex(sha256(new TextEncoder().encode(serialized))),
        entries: normalized.artifacts
          .filter((artifact) => visibleTaskIds.has(artifactTaskNodeId(artifact.taskId, params.branchName, params.plan)))
          .map((artifact) => ({ ...artifact,
            visibility: artifactTaskNodeId(artifact.taskId, params.branchName, params.plan) === getTaskBusinessId(params.task)
              ? 'own' as const : 'inherited' as const })),
      };
    }, params.beforeRead));
  }
  await params.beforeRead?.();
  if (await tauriIpc.fsExists(manifestPath, target)) {
    await withPilotArtifactText(target, manifestPath, params.budget, (text) => {
      pilotArtifactUtf8Size(text, PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid artifact manifest.');
      const summary = (parsed as { artifacts?: unknown }).artifacts;
      if (index ? stableSerialize(summary) !== stableSerialize(buildArtifactManifestSummary(index)) : summary !== undefined) {
        throw new Error('Artifact manifest does not match its index.');
      }
    }, params.beforeRead);
  }
  return index ? { entries, indexSha256 } : null;
};

const exportPilotTaskArtifacts = async (
  params: PilotTaskArtifactExportParams,
  requested?: { artifactId: string; expectedSha256: string; expectedTotalBytes: number },
): Promise<{ entries: PilotTaskArtifactExportEntry[]; bytes?: Uint8Array; release: () => void }> => {
  assertArtifactTaskContext({ requestedTask: params.task, currentTask: params.task });
  if (params.plan.id !== params.task.plan_id || params.plan.status === 'deleted') {
    throw new Error('Invalid Pilot artifact plan context.');
  }
  if (requested && (!/^[a-f0-9]{64}$/.test(requested.expectedSha256) ||
    !Number.isSafeInteger(requested.expectedTotalBytes) || requested.expectedTotalBytes < 0 ||
    requested.expectedTotalBytes > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.exportedFileBytes ||
    requested.artifactId !== sanitizeId(requested.artifactId))) {
    throw new Error('Invalid Pilot artifact attestation.');
  }
  const releaseMetadata = reservePilotArtifactBytes(params.budget, PILOT_ARTIFACT_METADATA_WORKING_BYTES);
  let releaseBytes: (() => void) | undefined;
  let releaseRetainedMetadata: (() => void) | undefined;
  let succeeded = false;
  try {
    if (!tauriIpc.isTauriAvailable()) throw new Error('Pilot artifact export requires the desktop runtime.');
    const registeredTargets = await resolveWorkspacePaths({ ...getPlanWorkspaceHints(params.plan),
      allowFallbackPaths: false, existingMetadataOnly: true });
    if (registeredTargets.length === 0 || registeredTargets.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.replicas) {
      throw new Error('Pilot artifact export requires a bounded registered workspace.');
    }
    const deps = resolveArchitectPlanServiceDependencies({ getAppState: () => useAppStore.getState() });
    const registry = buildValidProjectRegistrySnapshot(useAppStore.getState());
    const workspaceKey = await resolveReplicaWorkspaceKey(deps, registry);
    const result = await withReplicaTransactionLock(workspaceKey, async () => {
      // Use the workflow lock without replaying or modifying its recovery journal.
      const targets = await resolveWorkspacePaths({ ...getPlanWorkspaceHints(params.plan),
        allowFallbackPaths: false, existingMetadataOnly: true });
      if (targets.length === 0 || targets.length > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.replicas) {
        throw new Error('Pilot artifact export requires a bounded registered workspace.');
      }
      const visibleTaskIds = resolveVisiblePlanTaskIds(params);
      let canonical: PilotTaskArtifactExportEntry[] | null = null;
      let canonicalIndexSha256: string | null = null;
      let presentCount = 0;
      let bytes: Uint8Array | undefined;
      for (const [targetIndex, target] of targets.entries()) {
        const metadata = await readPilotArtifactReplicaMetadata(params, target, visibleTaskIds);
        if (!metadata) continue;
        presentCount += 1;
        if (canonicalIndexSha256 !== null && canonicalIndexSha256 !== metadata.indexSha256) {
          throw new Error('Artifact index replicas diverge.');
        }
        canonicalIndexSha256 = metadata.indexSha256;
        if (requested && !metadata.entries.some((entry) => entry.id === requested.artifactId)) {
          throw new Error('Artifact is not visible from the current task.');
        }
        const entries: PilotTaskArtifactExportEntry[] = [];
        let exportedMetadataBytes = 0;
        // Read the requested file last so retained bytes cannot overlap the next file allocation.
        const artifacts = requested
          ? [...metadata.entries.filter((entry) => entry.id !== requested.artifactId),
            ...metadata.entries.filter((entry) => entry.id === requested.artifactId)]
          : metadata.entries;
        for (const artifact of artifacts) {
          const retain = requested?.artifactId === artifact.id && targetIndex === targets.length - 1;
          await params.beforeRead?.();
          const stats = await tauriIpc.fsStat(artifact.path, target);
          if (stats.kind !== 'file' || !Number.isSafeInteger(stats.size) || stats.size < 0) {
            throw new Error('Invalid Pilot artifact file metadata.');
          }
          const oversized = stats.size > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.exportedFileBytes;
          if (oversized && requested?.artifactId === artifact.id) throw new Error('Pilot artifact is too large to export.');
          const entry = oversized
            ? { artifact, sha256: null, totalBytes: stats.size, contentState: 'too_large' as const }
            : await withPilotArtifactText(target, artifact.path, params.budget, (text) => {
            if (taskArtifactContentHash(text) !== artifact.contentHash) throw new Error('Artifact content does not match its index.');
            const totalBytes = pilotArtifactUtf8Size(text, PILOT_TASK_ARTIFACT_EXPORT_LIMITS.nativeFileBytes);
            if (totalBytes > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.exportedFileBytes) {
              if (requested?.artifactId === artifact.id) throw new Error('Pilot artifact is too large to export.');
              return { artifact, sha256: null, totalBytes, contentState: 'too_large' as const };
            }
            const release = reservePilotArtifactBytes(params.budget, totalBytes);
            try {
              const encoded = new TextEncoder().encode(text);
              const digest = bytesToHex(sha256(encoded));
              if (requested?.artifactId === artifact.id &&
                (digest !== requested.expectedSha256 || totalBytes !== requested.expectedTotalBytes)) {
                throw new Error('Pilot artifact attestation changed.');
              }
              if (retain) { bytes = encoded; releaseBytes = release; }
              return { artifact, sha256: digest, totalBytes, contentState: 'available' as const };
            } finally { if (!retain || !bytes) release(); }
          }, params.beforeRead);
          exportedMetadataBytes += pilotArtifactUtf8Size(stableSerialize(entry), PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
          if (exportedMetadataBytes > PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes) {
            throw new Error('Pilot artifact catalog metadata limit exceeded.');
          }
          entries.push(entry);
        }
        if (canonical && entries.some((entry, i) => entry.sha256 !== canonical![i]?.sha256 || entry.totalBytes !== canonical![i]?.totalBytes || entry.contentState !== canonical![i]?.contentState)) {
          throw new Error('Artifact content replicas diverge.');
        }
        if (!canonical) canonical = entries;
      }
      if (presentCount !== 0 && presentCount !== targets.length) throw new Error('Artifact index replica is missing.');
      if (requested && !bytes) throw new Error('Artifact is not available.');
      return { entries: (canonical || []).sort((left, right) =>
        left.artifact.visibility !== right.artifact.visibility ? left.artifact.visibility === 'own' ? -1 : 1
          : right.artifact.updatedAt.localeCompare(left.artifact.updatedAt)), bytes };
    });
    // Transfer only the returned metadata out of the temporary parse reservation.
    const metadataBytes = pilotArtifactUtf8Size(stableSerialize(result.entries), PILOT_TASK_ARTIFACT_EXPORT_LIMITS.metadataBytes);
    releaseRetainedMetadata = reservePilotArtifactBytes(params.budget, metadataBytes * 2 + result.entries.length * 128);
    releaseMetadata();
    succeeded = true;
    return { ...result, release: () => { try { releaseBytes?.(); } finally { releaseRetainedMetadata?.(); } } };
  } catch (error) {
    throw new PlanTaskArtifactIndexReadError(params.plan.id, getPlanArtifactIndexPath(params.branchName, params.plan.id), error);
  } finally {
    if (!succeeded) { try { releaseBytes?.(); } finally {
      try { releaseRetainedMetadata?.(); } finally { releaseMetadata(); }
    } }
  }
};

/** Local adapter API. Entries contain metadata paths; never forward them as wire
 * paths. Keep the reservation until the catalog is discarded or copied into a
 * separately reserved host record, then call release, including on rejection. */
export const listPilotTaskArtifactExports = async (params: PilotTaskArtifactExportParams): Promise<{
  entries: PilotTaskArtifactExportEntry[]; release: () => void;
}> => exportPilotTaskArtifacts(params);

/** Re-resolves registry and visibility, compares all replicas, and attests the
 * actual UTF-8 bytes returned. The legacy workflow contentHash stays unchanged.
 * Caller must release the result after use or transfer to its own reservation. */
export const readPilotTaskArtifactExport = async (
  params: PilotTaskArtifactExportParams & { artifactId: string; expectedSha256: string; expectedTotalBytes: number },
): Promise<{ artifact: VisiblePlanTaskArtifact; sha256: string; totalBytes: number; bytes: Uint8Array; release: () => void }> => {
  const result = await exportPilotTaskArtifacts(params, params);
  const entry = result.entries.find((candidate) => candidate.artifact.id === params.artifactId)!;
  return { ...entry, sha256: entry.sha256!, bytes: result.bytes!, release: result.release };
};

export const listVisibleTaskArtifactReviewEntries = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  includeInherited?: boolean;
  includeOwn?: boolean;
}): Promise<VisiblePlanTaskArtifactReviewEntry[]> => {
  const index = await readPlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(params.plan),
  });
  const artifacts = await listVisibleTaskArtifacts(params);
  const reviews = index.reviews || [];
  return artifacts.map((artifact) => {
    const review =
      reviews.find(
        (candidate) =>
          candidate.artifactId === artifact.id &&
          artifactTaskNodeId(candidate.taskId, params.branchName, params.plan) === getTaskBusinessId(params.task),
      ) || null;
    return {
      artifact,
      review,
      hasValidatedReview: Boolean(review),
      hasPendingReview: !review,
    };
  });
};

export const listPlanArtifactOverview = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
}): Promise<PlanArtifactOverview> => {
  const index = await readPlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(params.plan),
  });
  const reviews = index.reviews || [];
  const entries = index.artifacts
    .map((artifact) => {
      const review =
        reviews
          .filter((candidate) => candidate.artifactId === artifact.id)
          .sort((left, right) => right.validatedAt.localeCompare(left.validatedAt))[0] || null;
      return {
        artifact: {
          ...artifact,
          visibility: 'own' as const,
        },
        review,
        hasValidatedReview: Boolean(review),
        hasPendingReview: !review,
      };
    })
    .sort((left, right) =>
      right.artifact.updatedAt.localeCompare(left.artifact.updatedAt)
    );
  const expected = (params.plan.nodes || []).flatMap((node) =>
    normalizeArtifactContracts(node)
      .filter(
        (contract) =>
          !index.artifacts.some(
            (artifact) =>
              artifactTaskNodeId(artifact.taskId, params.branchName, params.plan) === node.id &&
              (artifact.contractId === contract.id || artifact.id === contract.id),
          ),
      )
      .map((contract) => ({
        id: `${sanitizeId(node.id)}:${contract.id}`,
        taskId: node.id,
        taskTitle: node.title || node.id,
        contract,
      })),
  );

  return { entries, expected };
};

export const readVisibleTaskArtifactContent = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  artifactId: string;
  existingMetadataOnly?: boolean;
}): Promise<{ artifact: VisiblePlanTaskArtifact; content: string }> => {
  const artifacts = await listVisibleTaskArtifacts({
    branchName: params.branchName,
    plan: params.plan,
    task: params.task,
    existingMetadataOnly: params.existingMetadataOnly,
  });
  const artifact = artifacts.find((candidate) => candidate.id === sanitizeId(params.artifactId));
  if (!artifact) {
    throw toServiceError(`Artifact is not visible from task ${params.task.id}: ${params.artifactId}`);
  }
  const content = await readArtifactContent({
    ...getPlanWorkspaceHints(params.plan),
    artifact,
    existingMetadataOnly: params.existingMetadataOnly,
  });
  return { artifact, content };
};

const readArtifactContent = async (params: {
  projectId?: string | null;
  projectIds?: string[] | null;
  availableProjectIds?: string[] | null;
  replicas?: ArchitectPlanRecord['replicas'];
  repoPaths?: Array<string | null | undefined>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  artifact: Pick<PlanTaskArtifact, 'id' | 'path' | 'contentHash'>;
  existingMetadataOnly?: boolean;
}): Promise<string> => {
  const workspaceTargets = await resolveWorkspacePaths({
    projectId: params.projectId,
    projectIds: params.projectIds,
    availableProjectIds: params.availableProjectIds,
    replicas: params.replicas,
    repoPaths: params.repoPaths,
    executionModesByProjectId: params.executionModesByProjectId,
    existingMetadataOnly: params.existingMetadataOnly,
  });
  for (const target of workspaceTargets) {
    const content = await readTextAtWorkspace(target, params.artifact.path);
    if (content !== null) {
      // Validate the exact string returned: the file may change after index validation.
      if (taskArtifactContentHash(content) !== params.artifact.contentHash) {
        throw toServiceError(`Artifact content does not match its index: ${params.artifact.id}`);
      }
      return content;
    }
  }
  throw toServiceError(`Artifact content not found: ${params.artifact.path}`);
};

export const readVisibleTaskArtifactDiff = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  artifactId: string;
}): Promise<VisiblePlanTaskArtifactDiff> => {
  const artifactId = sanitizeId(params.artifactId);
  const index = await readPlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(params.plan),
  });
  const visibleTaskIds = resolveVisiblePlanTaskIds({
    plan: params.plan,
    task: params.task,
    includeInherited: true,
    includeOwn: true,
  });
  const visibleArtifacts = index.artifacts
    .filter((artifact) => visibleTaskIds.has(artifactTaskNodeId(artifact.taskId, params.branchName, params.plan)))
    .map((artifact) => ({
      ...artifact,
      visibility: (artifactTaskNodeId(artifact.taskId, params.branchName, params.plan) === getTaskBusinessId(params.task) ? 'own' : 'inherited') as VisiblePlanTaskArtifact['visibility'],
    }));
  const artifact = visibleArtifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) {
    throw toServiceError(`Artifact is not visible from task ${params.task.id}: ${params.artifactId}`);
  }
  const content = await readArtifactContent({
    ...getPlanWorkspaceHints(params.plan),
    artifact,
  });
  const previousArtifact = artifact.supersedes
    ? visibleArtifacts.find((candidate) => candidate.id === artifact.supersedes) || null
    : null;
  const previousContent = previousArtifact
    ? await readArtifactContent({
        ...getPlanWorkspaceHints(params.plan),
        artifact: previousArtifact,
      })
    : '';
  return {
    artifact,
    content,
    previousArtifact,
    previousContent,
    status: previousArtifact ? 'modified' : 'added',
  };
};

export const readPlanArtifactDiff = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  artifactId: string;
}): Promise<VisiblePlanTaskArtifactDiff> => {
  const artifactId = sanitizeId(params.artifactId);
  const index = await readPlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(params.plan),
  });
  const artifact = index.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) {
    throw toServiceError(`Artifact not found: ${params.artifactId}`);
  }
  const visibleArtifact: VisiblePlanTaskArtifact = {
    ...artifact,
    visibility: 'own',
  };
  const content = await readArtifactContent({
    ...getPlanWorkspaceHints(params.plan),
    artifact,
  });
  const previousArtifact = artifact.supersedes
    ? index.artifacts.find((candidate) => candidate.id === artifact.supersedes) || null
    : null;
  const visiblePreviousArtifact: VisiblePlanTaskArtifact | null = previousArtifact
    ? {
        ...previousArtifact,
        visibility: 'inherited',
      }
    : null;
  const previousContent = previousArtifact
    ? await readArtifactContent({
        ...getPlanWorkspaceHints(params.plan),
        artifact: previousArtifact,
      })
    : '';
  return {
    artifact: visibleArtifact,
    content,
    previousArtifact: visiblePreviousArtifact,
    previousContent,
    status: previousArtifact ? 'modified' : 'added',
  };
};

const validateVisibleTaskArtifactInternal = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  artifactId: string;
  validatedBy?: string;
}): Promise<PlanTaskArtifactReview> => {
  const artifactId = sanitizeId(params.artifactId);
  const artifacts = await listVisibleTaskArtifacts({
    branchName: params.branchName,
    plan: params.plan,
    task: params.task,
    includeInherited: true,
    includeOwn: true,
  });
  if (!artifacts.some((artifact) => artifact.id === artifactId)) {
    throw toServiceError(`Artifact is not visible from task ${params.task.id}: ${params.artifactId}`);
  }
  const index = await readPlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(params.plan),
  });
  const now = new Date().toISOString();
  const review: PlanTaskArtifactReview = {
    artifactId,
    taskId: sanitizeId(getTaskBusinessId(params.task)),
    validatedAt: now,
    validatedBy:
      typeof params.validatedBy === 'string' && params.validatedBy.trim()
        ? params.validatedBy.trim()
        : 'user',
  };
  const nextIndex: PlanTaskArtifactIndex = {
    ...index,
    updatedAt: now,
    reviews: [
      ...(index.reviews || []).filter(
        (candidate) =>
          candidate.artifactId !== review.artifactId ||
          artifactTaskNodeId(candidate.taskId, params.branchName, params.plan) !== review.taskId,
      ),
      review,
    ].sort((left, right) => `${left.taskId}:${left.artifactId}`.localeCompare(`${right.taskId}:${right.artifactId}`)),
  };
  await writePlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(
      params.plan,
      (params.task.execution_targets || []).map((executionTarget) => executionTarget.repoPath),
    ),
    index: nextIndex,
    previousIndex: index,
  });
  return review;
};

const unvalidateVisibleTaskArtifactInternal = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  artifactId: string;
}): Promise<void> => {
  const artifactId = sanitizeId(params.artifactId);
  const artifacts = await listVisibleTaskArtifacts({
    branchName: params.branchName,
    plan: params.plan,
    task: params.task,
    includeInherited: true,
    includeOwn: true,
  });
  if (!artifacts.some((artifact) => artifact.id === artifactId)) {
    throw toServiceError(`Artifact is not visible from task ${params.task.id}: ${params.artifactId}`);
  }
  const index = await readPlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(params.plan),
  });
  const now = new Date().toISOString();
  const nextIndex: PlanTaskArtifactIndex = {
    ...index,
    updatedAt: now,
    reviews: (index.reviews || []).filter(
      (review) =>
        review.artifactId !== artifactId ||
        artifactTaskNodeId(review.taskId, params.branchName, params.plan) !== getTaskBusinessId(params.task),
    ),
  };
  await writePlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    ...getPlanWorkspaceHints(
      params.plan,
      (params.task.execution_targets || []).map((executionTarget) => executionTarget.repoPath),
    ),
    index: nextIndex,
    previousIndex: index,
  });
};

export { normalizeArtifactContracts, sanitizeId } from '../domains/plans/artifactContracts';

const putTaskArtifactInternal = async ({
  target,
  args,
  createdBy = 'agent',
}: PutTaskArtifactParams): Promise<PlanTaskArtifact> => {
  if (target.task.task_source !== 'architect') {
    throw toServiceError('Only Architect implementation tasks can produce artifacts.');
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) {
    throw toServiceError('task_artifact_put requires a title.');
  }
  const content =
    Object.prototype.hasOwnProperty.call(args, 'content')
      ? args.content
      : undefined;
  if (content === undefined || content === null || String(content).trim().length === 0) {
    throw toServiceError('task_artifact_put requires non-empty content.');
  }
  const kind = typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'note';
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  const contentType = normalizeContentType(args.content_type ?? args.contentType);
  const normalizedContent = normalizeArtifactContent(content, contentType);
  const contractId =
    typeof args.contract_id === 'string' && args.contract_id.trim()
      ? sanitizeId(args.contract_id)
      : typeof args.contractId === 'string' && args.contractId.trim()
        ? sanitizeId(args.contractId)
        : undefined;
  const requestedSupersedesArtifactId =
    typeof args.supersedes_artifact_id === 'string' && args.supersedes_artifact_id.trim()
      ? sanitizeId(args.supersedes_artifact_id)
      : typeof args.supersedesArtifactId === 'string' && args.supersedesArtifactId.trim()
        ? sanitizeId(args.supersedesArtifactId)
        : typeof args.supersedes === 'string' && args.supersedes.trim()
          ? sanitizeId(args.supersedes)
          : undefined;
  const node = target.plan.nodes.find((candidate) => candidate.id === getTaskBusinessId(target.task));
  if (!node) {
    throw toServiceError(`Cannot find Architect node for task ${target.task.id}.`);
  }
  if (contractId) {
    const contractExists = normalizeArtifactContracts(node).some((contract) => contract.id === contractId);
    if (!contractExists) {
      throw toServiceError(`Unknown artifact contract for task ${target.task.id}: ${contractId}`);
    }
  }

  const index = await readPlanTaskArtifactIndex({
    branchName: target.branchName,
    planId: target.plan.id,
    ...getPlanWorkspaceHints(target.plan),
  });
  const explicitArtifactId =
    typeof args.artifact_id === 'string' && args.artifact_id.trim()
      ? sanitizeId(args.artifact_id)
      : typeof args.artifactId === 'string' && args.artifactId.trim()
        ? sanitizeId(args.artifactId)
        : undefined;
  const existingByContract =
    contractId
      ? index.artifacts.find(
          (artifact) => artifactTaskNodeId(artifact.taskId, target.branchName, target.plan) === getTaskBusinessId(target.task) && artifact.contractId === contractId,
        )
      : undefined;
  const visibleTaskIds = resolveVisiblePlanTaskIds({
    plan: target.plan,
    task: target.task,
    includeInherited: true,
    includeOwn: true,
  });
  const supersededArtifact = requestedSupersedesArtifactId
    ? index.artifacts.find(
        (artifact) =>
          artifact.id === requestedSupersedesArtifactId &&
          visibleTaskIds.has(artifactTaskNodeId(artifact.taskId, target.branchName, target.plan)),
      )
    : undefined;
  if (requestedSupersedesArtifactId && !supersededArtifact) {
    throw toServiceError(`Cannot supersede an artifact that is not visible from task ${target.task.id}: ${requestedSupersedesArtifactId}`);
  }
  const artifactId =
    explicitArtifactId ||
    existingByContract?.id ||
    (supersededArtifact
      ? slugify(`${supersededArtifact.id}-${getTaskBusinessId(target.task)}`)
      : slugify(`${getTaskBusinessId(target.task)}-${contractId || title}`));
  const previous = index.artifacts.find((artifact) => artifact.id === artifactId);
  const supersededArtifactId =
    requestedSupersedesArtifactId ||
    (existingByContract && existingByContract.id !== artifactId
      ? existingByContract.id
      : undefined);
  if (previous && artifactTaskNodeId(previous.taskId, target.branchName, target.plan) !== getTaskBusinessId(target.task)) {
    throw toServiceError(`Artifact id ${artifactId} already belongs to another task.`);
  }
  const now = new Date().toISOString();
  const artifactTaskId = previous?.taskId ?? getTaskBusinessId(target.task);
  const path = getPlanArtifactContentPath(
    target.branchName,
    target.plan.id,
    artifactTaskId,
    artifactId,
    contentType,
  );
  const artifact: PlanTaskArtifact = {
    id: artifactId,
    planId: target.plan.id,
    taskId: artifactTaskId,
    kind,
    title,
    summary,
    contentType,
    path,
    contentHash: taskArtifactContentHash(normalizedContent),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    createdBy,
    ...(contractId ? { contractId } : {}),
    ...(supersededArtifactId ? { supersedes: supersededArtifactId } : previous?.supersedes ? { supersedes: previous.supersedes } : {}),
  };
  const nextIndex: PlanTaskArtifactIndex = {
    schemaVersion: 1,
    planId: target.plan.id,
    updatedAt: now,
    artifacts: [
      ...index.artifacts.filter(
        (candidate) => candidate.id !== artifact.id,
      ),
      artifact,
    ].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
    reviews: (index.reviews || []).filter((review) => review.artifactId !== artifact.id),
  };

  await writePlanTaskArtifactIndex({
    branchName: target.branchName,
    planId: target.plan.id,
    ...getPlanWorkspaceHints(
      target.plan,
      (target.task.execution_targets || []).map((executionTarget) => executionTarget.repoPath),
    ),
    index: nextIndex,
    previousIndex: index,
    contentWrites: [{ path, content: normalizedContent }],
  });

  return artifact;
};

export const validateVisibleTaskArtifact = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  artifactId: string;
  validatedBy?: string;
}): Promise<PlanTaskArtifactReview> =>
  serializeArtifactMutation(params.branchName, params.plan.id, () =>
    validateVisibleTaskArtifactInternal(params),
  );

export const unvalidateVisibleTaskArtifact = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  artifactId: string;
}): Promise<void> =>
  serializeArtifactMutation(params.branchName, params.plan.id, () =>
    unvalidateVisibleTaskArtifactInternal(params),
  );

export const putTaskArtifact = async (params: PutTaskArtifactParams): Promise<PlanTaskArtifact> =>
  serializeArtifactMutation(params.target.branchName, params.target.plan.id, () =>
    putTaskArtifactInternal(params),
  );

export const formatTaskArtifactListResult = async (
  target: TaskArtifactToolTarget,
  args: Record<string, unknown>,
): Promise<string> => {
  const includeInherited = args.include_inherited !== false && args.includeInherited !== false;
  const includeOwn = args.include_own !== false && args.includeOwn !== false;
  const artifacts = await listVisibleTaskArtifacts({
    branchName: target.branchName,
    plan: target.plan,
    task: target.task,
    includeInherited,
    includeOwn,
  });
  const node = target.plan.nodes.find((candidate) => candidate.id === getTaskBusinessId(target.task));
  return [
    `task_artifact_list: ${artifacts.length} visible artifact(s) for ${target.task.title}.`,
    '',
    'Structured context:',
    JSON.stringify(
      {
        action: 'task_artifact_list',
        task_id: target.task.id,
        plan_id: target.plan.id,
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          task_id: artifact.taskId,
          visibility: artifact.visibility,
          kind: artifact.kind,
          title: artifact.title,
          summary: artifact.summary,
          content_type: artifact.contentType,
          contract_id: artifact.contractId ?? null,
          supersedes: artifact.supersedes ?? null,
          updated_at: artifact.updatedAt,
        })),
        artifact_contracts: normalizeArtifactContracts(node || {}).map((contract) => ({
          id: contract.id,
          title: contract.title,
          kind: contract.kind,
          required: contract.required,
          satisfied: artifacts.some(
            (artifact) =>
              artifactTaskNodeId(artifact.taskId, target.branchName, target.plan) === getTaskBusinessId(target.task) &&
              (artifact.contractId === contract.id || artifact.id === contract.id),
          ),
        })),
      },
      null,
      2,
    ),
  ].join('\n');
};

export const formatTaskArtifactGetResult = async (
  target: TaskArtifactToolTarget,
  args: Record<string, unknown>,
): Promise<string> => {
  const artifactId =
    typeof args.artifact_id === 'string' && args.artifact_id.trim()
      ? args.artifact_id.trim()
      : typeof args.artifactId === 'string' && args.artifactId.trim()
        ? args.artifactId.trim()
        : '';
  if (!artifactId) {
    throw toServiceError('task_artifact_get requires artifact_id.');
  }
  const { artifact, content } = await readVisibleTaskArtifactContent({
    branchName: target.branchName,
    plan: target.plan,
    task: target.task,
    artifactId,
  });
  return [
    `task_artifact_get: ${artifact.title} (${artifact.id}).`,
    '',
    'Structured context:',
    JSON.stringify({ artifact }, null, 2),
    '',
    'Artifact content:',
    content,
  ].join('\n');
};

export const formatTaskArtifactPutResult = (artifact: PlanTaskArtifact): string =>
  [
    `task_artifact_put: stored ${artifact.title} (${artifact.id}).`,
    '',
    'Structured context:',
    JSON.stringify({ artifact }, null, 2),
  ].join('\n');

export const loadMissingRequiredArtifactsForCompletion = async (
  task: Pick<
    CatalogedImplementTask,
    | 'id'
    | 'task_source'
    | 'plan_id'
    | 'plan_storage_branch'
    | 'plan_target_branch'
    | 'project_id'
    | 'project_ids'
    | 'execution_targets'
  >,
  getPlan: (branchName: string, planId: string) => Promise<ArchitectPlanRecord | null> = getArchitectPlan,
): Promise<MissingRequiredPlanTaskArtifact[]> => {
  if (task.task_source !== 'architect' || !task.plan_id) {
    return [];
  }
  const branchName = normalizeBranchName(
    task.plan_storage_branch || task.plan_target_branch || getGitFlowBaseBranch(),
  );
  const plan = await getPlan(branchName, task.plan_id);
  const node = plan?.nodes?.find((candidate) => candidate.id === getTaskBusinessId(task));
  if (!plan || !node) {
    return [];
  }
  const requiredContracts = normalizeArtifactContracts(node).filter((contract) => contract.required);
  if (requiredContracts.length === 0) {
    return [];
  }
  const index = await readPlanTaskArtifactIndex({
    branchName,
    planId: plan.id,
    ...getPlanWorkspaceHints(
      plan,
      (task.execution_targets || []).map((target) => target.repoPath),
    ),
  });
  return requiredContracts
    .filter(
      (contract) =>
        !index.artifacts.some(
          (artifact) =>
            artifactTaskNodeId(artifact.taskId, branchName, plan) === getTaskBusinessId(task) &&
            (artifact.contractId === contract.id || artifact.id === contract.id),
        ),
    )
    .map((contract) => ({
      contract,
      taskId: task.id,
    }));
};

export const loadUnvalidatedCurrentTaskArtifactsForCompletion = async (
  task: Pick<
    CatalogedImplementTask,
    | 'id'
    | 'task_source'
    | 'plan_id'
    | 'plan_storage_branch'
    | 'plan_target_branch'
    | 'project_id'
    | 'project_ids'
    | 'execution_targets'
  >,
  getPlan: (branchName: string, planId: string) => Promise<ArchitectPlanRecord | null> = getArchitectPlan,
): Promise<PlanTaskArtifact[]> => {
  if (task.task_source !== 'architect' || !task.plan_id) {
    return [];
  }
  const branchName = normalizeBranchName(
    task.plan_storage_branch || task.plan_target_branch || getGitFlowBaseBranch(),
  );
  const plan = await getPlan(branchName, task.plan_id);
  const node = plan?.nodes?.find((candidate) => candidate.id === getTaskBusinessId(task));
  if (!plan || !node) {
    return [];
  }
  const index = await readPlanTaskArtifactIndex({
    branchName,
    planId: plan.id,
    ...getPlanWorkspaceHints(
      plan,
      (task.execution_targets || []).map((target) => target.repoPath),
    ),
  });
  const reviews = index.reviews || [];
  return index.artifacts
    .filter((artifact) => artifactTaskNodeId(artifact.taskId, branchName, plan) === getTaskBusinessId(task))
    .filter(
      (artifact) =>
        !reviews.some(
          (review) =>
            review.artifactId === artifact.id &&
            artifactTaskNodeId(review.taskId, branchName, plan) === getTaskBusinessId(task),
        ),
    );
};

export const buildTaskArtifactContextBlock = async (params: {
  task: CatalogedImplementTask;
  getPlan?: (branchName: string, planId: string) => Promise<ArchitectPlanRecord | null>;
  allowWrites?: boolean;
}): Promise<string | null> => {
  if ((params.task.task_source !== 'architect' && !isPlanFinalizationTask(params.task)) || !params.task.plan_id) {
    return null;
  }
  const branchName = normalizeBranchName(
    params.task.plan_storage_branch || params.task.plan_target_branch || getGitFlowBaseBranch(),
  );
  const plan = await (params.getPlan || getArchitectPlan)(branchName, params.task.plan_id);
  if (!plan || plan.status === 'deleted') {
    return null;
  }
  const artifacts = await listVisibleTaskArtifacts({
    branchName,
    plan,
    task: params.task,
    includeInherited: true,
    includeOwn: true,
  });
  const node = plan.nodes.find((candidate) => candidate.id === getTaskBusinessId(params.task));
  const contracts = normalizeArtifactContracts(node || {});
  const inheritedArtifacts = artifacts.filter((artifact) => artifact.visibility === 'inherited');
  const ownArtifacts = artifacts.filter((artifact) => artifact.visibility === 'own');
  const writeInstruction = params.allowWrites
    ? 'Use task_artifact_put to store durable handoff information for dependent tasks.'
    : 'This turn can read artifacts but cannot write new artifacts.';
  if (artifacts.length === 0 && contracts.length === 0) {
    return `[Task Artifacts] task_id="${params.task.id}". No visible artifacts yet. ${writeInstruction}`;
  }
  return `[Task Artifacts] task_id="${params.task.id}". Use task_artifact_list for the current index and task_artifact_get to read full content. ${writeInstruction} inherited=${JSON.stringify(inheritedArtifacts.map((artifact) => ({
    id: artifact.id,
    task_id: artifact.taskId,
    kind: artifact.kind,
    title: artifact.title,
    summary: artifact.summary,
    content_type: artifact.contentType,
    supersedes: artifact.supersedes ?? null,
    updated_at: artifact.updatedAt,
  })))} own=${JSON.stringify(ownArtifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    summary: artifact.summary,
    contract_id: artifact.contractId ?? null,
    supersedes: artifact.supersedes ?? null,
    updated_at: artifact.updatedAt,
  })))} contracts=${JSON.stringify(contracts.map((contract) => ({
    id: contract.id,
    title: contract.title,
    kind: contract.kind,
    required: contract.required,
    satisfied: ownArtifacts.some(
      (artifact) => artifact.contractId === contract.id || artifact.id === contract.id,
    ),
  })))}`;
};
