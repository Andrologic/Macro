import type {
  PlanNode,
  PlanNodeArtifactContract,
  PlanTaskArtifact,
  PlanTaskArtifactContentType,
  PlanTaskArtifactReview,
} from '../types';
import type { ProjectExecutionContext } from './projectExecutionContext';
import type { ArchitectPlanRecord } from './architectPlanService';
import {
  getArchitectPlan,
  getGitFlowBaseBranch,
  resolveTargetBranch,
} from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import { isPlanFinalizationTask } from './implementTaskCatalog';
import { recordMacroMetadataMutation } from './macroMetadataCoordinator';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';
import { toServiceError } from './contracts/errors';

const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';

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

const sanitizeId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `artifact-${Date.now()}`;

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

const hashString = (value: string): string => {
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
          taskId: sanitizeId(artifact.taskId),
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

const resolveWorkspacePaths = async (params: {
  projectIds?: string[] | null;
  repoPaths?: Array<string | null | undefined>;
}): Promise<string[]> => {
  const appState = useAppStore.getState();
  const projectPaths = (params.projectIds || []).map((projectId) =>
    typeof appState.getProjectById === 'function'
      ? appState.getProjectById(projectId)?.path ?? null
      : null,
  );
  let activeRoot: string | null = null;
  if (tauriIpc.isTauriAvailable()) {
    try {
      activeRoot = await tauriIpc.workspaceGetActiveRoot();
    } catch {
      activeRoot = null;
    }
  }
  return unique([...(params.repoPaths || []), ...projectPaths, activeRoot]);
};

const readJsonAtWorkspace = async <T>(
  workspacePath: string,
  path: string,
): Promise<T | null> => {
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: METADATA_WORKSPACE_SCOPE,
      workspacePath,
    });
    return JSON.parse(file.content) as T;
  } catch {
    return null;
  }
};

const readTextAtWorkspace = async (
  workspacePath: string,
  path: string,
): Promise<string | null> => {
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: METADATA_WORKSPACE_SCOPE,
      workspacePath,
    });
    return file.content;
  } catch {
    return null;
  }
};

const writeTextAtWorkspace = async (
  workspacePath: string,
  path: string,
  content: string,
): Promise<void> => {
  await tauriIpc.fsWriteFile({
    path,
    content,
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: METADATA_WORKSPACE_SCOPE,
    workspacePath,
  });
};

const buildArtifactManifestSummary = (index: PlanTaskArtifactIndex) => ({
  count: index.artifacts.length,
  indexHash: hashString(stableSerialize(index.artifacts.map((artifact) => ({
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
  contentHash: hashString(index.artifacts.map((artifact) => artifact.contentHash).sort().join('\n')),
  reviewHash: hashString(stableSerialize((index.reviews || []).map((review) => ({
    artifactId: review.artifactId,
    taskId: review.taskId,
    validatedAt: review.validatedAt,
    validatedBy: review.validatedBy,
  })))),
  updatedAt: index.updatedAt,
});

const updateArtifactManifestAtWorkspace = async (params: {
  workspacePath: string;
  branchName: string;
  planId: string;
  index: PlanTaskArtifactIndex;
}): Promise<void> => {
  const manifestPath = getPlanManifestPath(params.branchName, params.planId);
  const existing = await readJsonAtWorkspace<Record<string, unknown>>(
    params.workspacePath,
    manifestPath,
  );
  if (!existing) {
    return;
  }
  await writeTextAtWorkspace(
    params.workspacePath,
    manifestPath,
    `${JSON.stringify(
      {
        ...existing,
        artifacts: buildArtifactManifestSummary(params.index),
      },
      null,
      2,
    )}\n`,
  );
};

export const readPlanTaskArtifactIndex = async (params: {
  branchName: string;
  planId: string;
  projectIds?: string[] | null;
  repoPaths?: Array<string | null | undefined>;
}): Promise<PlanTaskArtifactIndex> => {
  if (!tauriIpc.isTauriAvailable()) {
    return emptyArtifactIndex(params.planId);
  }
  const indexPath = getPlanArtifactIndexPath(params.branchName, params.planId);
  const workspacePaths = await resolveWorkspacePaths(params);
  for (const workspacePath of workspacePaths) {
    const parsed = await readJsonAtWorkspace<Partial<PlanTaskArtifactIndex>>(
      workspacePath,
      indexPath,
    );
    if (parsed) {
      return normalizeArtifactIndex(params.planId, parsed);
    }
  }
  return emptyArtifactIndex(params.planId);
};

const writePlanTaskArtifactIndex = async (params: {
  branchName: string;
  planId: string;
  projectIds?: string[] | null;
  repoPaths?: Array<string | null | undefined>;
  index: PlanTaskArtifactIndex;
  contentWrites?: Array<{ path: string; content: string }>;
}): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) {
    return;
  }
  const workspacePaths = await resolveWorkspacePaths(params);
  if (workspacePaths.length === 0) {
    return;
  }
  const indexPath = getPlanArtifactIndexPath(params.branchName, params.planId);
  const indexContent = `${JSON.stringify(params.index, null, 2)}\n`;
  await Promise.all(
    workspacePaths.map(async (workspacePath) => {
      for (const write of params.contentWrites || []) {
        await writeTextAtWorkspace(workspacePath, write.path, write.content);
      }
      await writeTextAtWorkspace(workspacePath, indexPath, indexContent);
      await updateArtifactManifestAtWorkspace({
        workspacePath,
        branchName: params.branchName,
        planId: params.planId,
        index: params.index,
      });
      recordMacroMetadataMutation({
        workspacePath,
        kind: 'task_metadata',
        entityId: params.planId,
        label: 'task artifacts',
        importance: 'light',
      });
    }),
  );
};

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
    ? params.tasks.find((task) => task.id === currentTaskId) || null
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
  const task = params.tasks.find((candidate) => candidate.id === requestedTaskId);
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
  return { branchName, plan, task, currentTask: currentTask! };
};

export const resolveVisiblePlanTaskIds = (params: {
  plan: Pick<ArchitectPlanRecord, 'nodes'>;
  task: Pick<CatalogedImplementTask, 'id' | 'dependencies' | 'task_source'>;
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

  const currentNode = nodeById.get(params.task.id);
  if (includeOwn && currentNode) {
    visible.add(params.task.id);
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
}): Promise<VisiblePlanTaskArtifact[]> => {
  const index = await readPlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    projectIds: params.plan.projectIds,
  });
  const visibleTaskIds = resolveVisiblePlanTaskIds({
    plan: params.plan,
    task: params.task,
    includeInherited: params.includeInherited,
    includeOwn: params.includeOwn,
  });
  return index.artifacts
    .filter((artifact) => visibleTaskIds.has(artifact.taskId))
    .map((artifact) => ({
      ...artifact,
      visibility: (artifact.taskId === params.task.id ? 'own' : 'inherited') as VisiblePlanTaskArtifact['visibility'],
    }))
    .sort((left, right) => {
      if (left.visibility !== right.visibility) {
        return left.visibility === 'own' ? -1 : 1;
      }
      return left.updatedAt.localeCompare(right.updatedAt) * -1;
    });
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
    projectIds: params.plan.projectIds,
  });
  const artifacts = await listVisibleTaskArtifacts(params);
  const reviews = index.reviews || [];
  return artifacts.map((artifact) => {
    const review =
      reviews.find(
        (candidate) =>
          candidate.artifactId === artifact.id &&
          candidate.taskId === sanitizeId(params.task.id),
      ) || null;
    return {
      artifact,
      review,
      hasValidatedReview: Boolean(review),
      hasPendingReview: !review,
    };
  });
};

export const readVisibleTaskArtifactContent = async (params: {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  artifactId: string;
}): Promise<{ artifact: VisiblePlanTaskArtifact; content: string }> => {
  const artifacts = await listVisibleTaskArtifacts({
    branchName: params.branchName,
    plan: params.plan,
    task: params.task,
  });
  const artifact = artifacts.find((candidate) => candidate.id === sanitizeId(params.artifactId));
  if (!artifact) {
    throw toServiceError(`Artifact is not visible from task ${params.task.id}: ${params.artifactId}`);
  }
  const workspacePaths = await resolveWorkspacePaths({
    projectIds: params.plan.projectIds,
  });
  for (const workspacePath of workspacePaths) {
    const content = await readTextAtWorkspace(workspacePath, artifact.path);
    if (content !== null) {
      return { artifact, content };
    }
  }
  throw toServiceError(`Artifact content not found: ${artifact.id}`);
};

const readArtifactContentByPath = async (params: {
  projectIds?: string[] | null;
  path: string;
}): Promise<string> => {
  const workspacePaths = await resolveWorkspacePaths({
    projectIds: params.projectIds,
  });
  for (const workspacePath of workspacePaths) {
    const content = await readTextAtWorkspace(workspacePath, params.path);
    if (content !== null) {
      return content;
    }
  }
  throw toServiceError(`Artifact content not found: ${params.path}`);
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
    projectIds: params.plan.projectIds,
  });
  const visibleTaskIds = resolveVisiblePlanTaskIds({
    plan: params.plan,
    task: params.task,
    includeInherited: true,
    includeOwn: true,
  });
  const visibleArtifacts = index.artifacts
    .filter((artifact) => visibleTaskIds.has(artifact.taskId))
    .map((artifact) => ({
      ...artifact,
      visibility: (artifact.taskId === params.task.id ? 'own' : 'inherited') as VisiblePlanTaskArtifact['visibility'],
    }));
  const artifact = visibleArtifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) {
    throw toServiceError(`Artifact is not visible from task ${params.task.id}: ${params.artifactId}`);
  }
  const content = await readArtifactContentByPath({
    projectIds: params.plan.projectIds,
    path: artifact.path,
  });
  const previousArtifact = artifact.supersedes
    ? visibleArtifacts.find((candidate) => candidate.id === artifact.supersedes) || null
    : null;
  const previousContent = previousArtifact
    ? await readArtifactContentByPath({
        projectIds: params.plan.projectIds,
        path: previousArtifact.path,
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

export const validateVisibleTaskArtifact = async (params: {
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
    projectIds: params.plan.projectIds,
  });
  const now = new Date().toISOString();
  const review: PlanTaskArtifactReview = {
    artifactId,
    taskId: sanitizeId(params.task.id),
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
          candidate.taskId !== review.taskId,
      ),
      review,
    ].sort((left, right) => `${left.taskId}:${left.artifactId}`.localeCompare(`${right.taskId}:${right.artifactId}`)),
  };
  await writePlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    projectIds: params.plan.projectIds,
    repoPaths: (params.task.execution_targets || []).map((executionTarget) => executionTarget.repoPath),
    index: nextIndex,
  });
  return review;
};

export const unvalidateVisibleTaskArtifact = async (params: {
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
    projectIds: params.plan.projectIds,
  });
  const now = new Date().toISOString();
  const nextIndex: PlanTaskArtifactIndex = {
    ...index,
    updatedAt: now,
    reviews: (index.reviews || []).filter(
      (review) =>
        review.artifactId !== artifactId ||
        review.taskId !== sanitizeId(params.task.id),
    ),
  };
  await writePlanTaskArtifactIndex({
    branchName: params.branchName,
    planId: params.plan.id,
    projectIds: params.plan.projectIds,
    repoPaths: (params.task.execution_targets || []).map((executionTarget) => executionTarget.repoPath),
    index: nextIndex,
  });
};

export const normalizeArtifactContracts = (
  node: Pick<PlanNode, 'artifactContracts'>,
): PlanNodeArtifactContract[] =>
  (node.artifactContracts || [])
    .filter((contract) =>
      Boolean(
        contract &&
          typeof contract.id === 'string' &&
          contract.id.trim().length > 0 &&
          typeof contract.title === 'string' &&
          contract.title.trim().length > 0,
      ),
    )
    .map((contract) => ({
      id: sanitizeId(contract.id),
      title: contract.title.trim(),
      kind: typeof contract.kind === 'string' && contract.kind.trim() ? contract.kind.trim() : 'note',
      ...(typeof contract.description === 'string' && contract.description.trim()
        ? { description: contract.description.trim() }
        : {}),
      required: true,
    }));

export const putTaskArtifact = async ({
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
  const node = target.plan.nodes.find((candidate) => candidate.id === target.task.id);
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
    projectIds: target.plan.projectIds,
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
          (artifact) => artifact.taskId === target.task.id && artifact.contractId === contractId,
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
          visibleTaskIds.has(artifact.taskId),
      )
    : undefined;
  if (requestedSupersedesArtifactId && !supersededArtifact) {
    throw toServiceError(`Cannot supersede an artifact that is not visible from task ${target.task.id}: ${requestedSupersedesArtifactId}`);
  }
  const artifactId =
    explicitArtifactId ||
    existingByContract?.id ||
    (supersededArtifact
      ? slugify(`${supersededArtifact.id}-${target.task.id}`)
      : slugify(contractId || title));
  const previous = index.artifacts.find((artifact) => artifact.id === artifactId);
  const supersededArtifactId =
    requestedSupersedesArtifactId ||
    (existingByContract && existingByContract.id !== artifactId
      ? existingByContract.id
      : undefined);
  if (previous && previous.taskId !== target.task.id) {
    throw toServiceError(`Artifact id ${artifactId} already belongs to another task.`);
  }
  const now = new Date().toISOString();
  const path = getPlanArtifactContentPath(
    target.branchName,
    target.plan.id,
    target.task.id,
    artifactId,
    contentType,
  );
  const artifact: PlanTaskArtifact = {
    id: artifactId,
    planId: target.plan.id,
    taskId: target.task.id,
    kind,
    title,
    summary,
    contentType,
    path,
    contentHash: hashString(normalizedContent),
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
    projectIds: target.plan.projectIds,
    repoPaths: (target.task.execution_targets || []).map((executionTarget) => executionTarget.repoPath),
    index: nextIndex,
    contentWrites: [{ path, content: normalizedContent }],
  });

  return artifact;
};

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
  const node = target.plan.nodes.find((candidate) => candidate.id === target.task.id);
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
              artifact.taskId === target.task.id &&
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
  const node = plan?.nodes?.find((candidate) => candidate.id === task.id);
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
    projectIds: plan.projectIds,
    repoPaths: (task.execution_targets || []).map((target) => target.repoPath),
  });
  return requiredContracts
    .filter(
      (contract) =>
        !index.artifacts.some(
          (artifact) =>
            artifact.taskId === task.id &&
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
  const node = plan?.nodes?.find((candidate) => candidate.id === task.id);
  if (!plan || !node) {
    return [];
  }
  const index = await readPlanTaskArtifactIndex({
    branchName,
    planId: plan.id,
    projectIds: plan.projectIds,
    repoPaths: (task.execution_targets || []).map((target) => target.repoPath),
  });
  const reviews = index.reviews || [];
  return index.artifacts
    .filter((artifact) => artifact.taskId === task.id)
    .filter(
      (artifact) =>
        !reviews.some(
          (review) =>
            review.artifactId === artifact.id &&
            review.taskId === task.id,
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
  const node = plan.nodes.find((candidate) => candidate.id === params.task.id);
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
