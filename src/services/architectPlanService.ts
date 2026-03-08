import type { PlanNode, PredictedBranch } from '../types';
import type { Need } from '../types';
import { useAppStore } from '../stores/useAppStore';
import * as tauriIpc from './tauriIpc';
import {
  getArchitectGitNamingSettings,
  normalizeFeatureSlugInput,
  toPlanFeatureBranchName,
  toPlanIntegrationBranchName,
} from './architectGitNaming';

export type ArchitectPlanStatus =
  | 'draft'
  | 'validated'
  | 'in_progress'
  | 'completed'
  | 'archived'
  | 'deleted';

export interface ArchitectPlanRecord {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: ArchitectPlanStatus;
  targetBranch: string;
  conversationId?: string;
  projectId?: string;
  projectIds?: string[];
  createdAt: string;
  updatedAt: string;
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  replicas?: ArchitectPlanReplica[];
  hasReplicaDivergence?: boolean;
}

export interface ArchitectPlanSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: ArchitectPlanStatus;
  targetBranch: string;
  conversationId?: string;
  projectId?: string;
  projectIds?: string[];
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  replicas?: ArchitectPlanReplica[];
  hasReplicaDivergence?: boolean;
}

export interface ArchitectPlanReplica {
  scopeKey: string;
  projectId: string | null;
  repoPath: string | null;
  workspacePath: string | null;
  source: 'local' | 'project' | 'workspace';
  updatedAt?: string | null;
  missing?: boolean;
}

export interface ArchitectPlanReplicaDivergence {
  branchName: string;
  planId: string;
  reason: 'content_diverged' | 'missing_replica';
  replicas: ArchitectPlanReplica[];
}

export class ArchitectPlanReplicaDivergenceError extends Error {
  readonly code = 'ARCHITECT_PLAN_REPLICA_DIVERGENCE';
  readonly divergence: ArchitectPlanReplicaDivergence;

  constructor(divergence: ArchitectPlanReplicaDivergence) {
    super(
      divergence.reason === 'missing_replica'
        ? `Plan ${divergence.planId} is missing metadata replicas in one or more project repositories.`
        : `Plan ${divergence.planId} has diverged metadata replicas across repositories.`
    );
    this.name = 'ArchitectPlanReplicaDivergenceError';
    this.divergence = divergence;
  }
}

export const isArchitectPlanReplicaDivergenceError = (
  value: unknown
): value is ArchitectPlanReplicaDivergenceError =>
  value instanceof ArchitectPlanReplicaDivergenceError ||
  (value instanceof Error &&
    (value as { code?: string }).code === 'ARCHITECT_PLAN_REPLICA_DIVERGENCE' &&
    'divergence' in value);

export type ArchitectPlanReplicaRepairStrategy = 'newest' | 'oldest';

type ArchitectPlanProjectRef = Pick<ArchitectPlanSummary, 'projectId' | 'projectIds'>;

interface ArchitectPlanIndex {
  version: 2;
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
  reservedPlanSlugs: string[];
}

const LOCAL_INDEX_KEY_PREFIX = 'macro_architect_plan_index';
const LOCAL_PLAN_KEY_PREFIX = 'macro_architect_plan';
const LOCAL_PLAN_NEEDS_KEY_PREFIX = 'macro_architect_plan_needs';
const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';
const DEFAULT_GIT_FLOW_BASE_BRANCH = 'develop';
const GIT_FLOW_ALLOWED_TARGET_PATTERNS = [
  /^feature\/[a-z0-9._-]+$/i,
  /^release\/[a-z0-9._-]+$/i,
  /^hotfix\/[a-z0-9._-]+$/i,
  /^bugfix\/[a-z0-9._-]+$/i,
];

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getDynamicTargetPatterns = (): RegExp[] => {
  const baseBranch = getGitFlowBaseBranch();
  return [new RegExp(`^${escapeRegex(baseBranch)}$`, 'i'), ...GIT_FLOW_ALLOWED_TARGET_PATTERNS];
};

const normalizeBranchName = (value?: string, fallbackBranch = DEFAULT_GIT_FLOW_BASE_BRANCH): string => {
  const normalized = (value || fallbackBranch)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^refs\/heads\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalized || fallbackBranch;
};

const isGitFlowTargetBranch = (branchName: string): boolean =>
  getDynamicTargetPatterns().some((pattern) => pattern.test(branchName));

const assertGitFlowTargetBranch = (branchName: string): void => {
  if (!isGitFlowTargetBranch(branchName)) {
    throw new Error(
      `Invalid target branch "${branchName}". Use configured base branch "${getGitFlowBaseBranch()}" or Git Flow naming: feature/*, release/*, hotfix/*, bugfix/*.`
    );
  }
};

const sanitizeId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `plan-${Date.now()}`;

const slugifyPlanTitle = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `plan-${Date.now()}`;

const normalizeProjectIds = (projectIds?: string[], projectId?: string): string[] => Array.from(
  new Set(
    [ ...(Array.isArray(projectIds) ? projectIds : []), ...(projectId ? [projectId] : []) ]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  )
);

export const getArchitectPlanProjectIds = (plan: ArchitectPlanProjectRef): string[] =>
  normalizeProjectIds(plan.projectIds, plan.projectId);

export const planMatchesProjectId = (
  plan: ArchitectPlanProjectRef,
  selectedProjectId: string | null
): boolean => {
  if (!selectedProjectId) return true;
  const projectIds = getArchitectPlanProjectIds(plan);
  return projectIds.length === 0 || projectIds.includes(selectedProjectId);
};

export const resolvePlanProjectContextId = (
  plan: ArchitectPlanProjectRef,
  preferredProjectId?: string | null
): string | null => {
  const projectIds = getArchitectPlanProjectIds(plan);
  if (preferredProjectId && projectIds.includes(preferredProjectId)) {
    return preferredProjectId;
  }
  return projectIds[0] || null;
};

const normalizePlanNodes = (nodes: PlanNode[]): PlanNode[] =>
  (Array.isArray(nodes) ? nodes : []).map((node) => {
    const projectIds = normalizeProjectIds(node.projectIds, node.projectId);
    return {
      ...node,
      projectId: projectIds[0],
      projectIds,
    };
  });

const normalizePlanPredictedBranches = (predictedBranches: PredictedBranch[]): PredictedBranch[] =>
  (Array.isArray(predictedBranches) ? predictedBranches : []).filter(
    (branch) => typeof branch?.projectId === 'string' && branch.projectId.trim().length > 0
  );

const resolvePlanProjectIds = (params: {
  projectIds?: string[];
  projectId?: string;
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
}): string[] => {
  const fromNodes = normalizePlanNodes(params.nodes || []).flatMap((node) => normalizeProjectIds(node.projectIds, node.projectId));
  const fromBranches = normalizePlanPredictedBranches(params.predictedBranches || []).map((branch) => branch.projectId);
  return normalizeProjectIds([...(params.projectIds || []), ...fromNodes, ...fromBranches], params.projectId);
};

const getPlanRoot = (branchName: string): string => `branches/${normalizeBranchName(branchName)}/plans`;
const getIndexPath = (branchName: string): string => `${getPlanRoot(branchName)}/index.json`;
const getPlanDir = (branchName: string, planId: string): string => `${getPlanRoot(branchName)}/${sanitizeId(planId)}`;
const getPlanJsonPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/plan.json`;
const getPlanMarkdownPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/plan.md`;
const getPlanNeedsPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/needs.json`;
const getPlanTasksRoot = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/tasks`;
const getPlanTaskDir = (branchName: string, planId: string, taskId: string): string => `${getPlanTasksRoot(branchName, planId)}/${sanitizeId(taskId)}`;
const getTaskPlannedPath = (branchName: string, planId: string, taskId: string): string => `${getPlanTaskDir(branchName, planId, taskId)}/planned.md`;
const getTaskExecutedPath = (branchName: string, planId: string, taskId: string): string => `${getPlanTaskDir(branchName, planId, taskId)}/executed.md`;

const emptyIndex = (): ArchitectPlanIndex => ({ version: 2, activePlanId: null, plans: [], reservedPlanSlugs: [] });

const localIndexKey = (branchName: string): string => `${LOCAL_INDEX_KEY_PREFIX}:${normalizeBranchName(branchName)}`;
const localPlanKey = (branchName: string, planId: string): string =>
  `${LOCAL_PLAN_KEY_PREFIX}:${normalizeBranchName(branchName)}:${sanitizeId(planId)}`;
const localPlanNeedsKey = (branchName: string, planId: string): string =>
  `${LOCAL_PLAN_NEEDS_KEY_PREFIX}:${normalizeBranchName(branchName)}:${sanitizeId(planId)}`;

const buildPlanMarkdown = (plan: ArchitectPlanRecord): string => {
  const lines: string[] = [];
  lines.push(`# Plan: ${plan.title}`);
  lines.push('');
  lines.push('## Metadata');
  lines.push(`- Plan ID: ${plan.id}`);
  lines.push(`- Plan Slug: ${plan.slug}`);
  lines.push(`- Plan Integration Branch: ${toPlanIntegrationBranch(plan.slug)}`);
  lines.push(`- Target Code Branch: ${plan.targetBranch}`);
  lines.push(`- Base Code Branch: ${getGitFlowBaseBranch()}`);
  lines.push(`- Macro Branch: @macro`);
  lines.push(`- Status: ${plan.status}`);
  if (plan.conversationId) {
    lines.push(`- Conversation ID: ${plan.conversationId}`);
  }
  if (plan.projectId) {
    lines.push(`- Project ID: ${plan.projectId}`);
  }
  lines.push(`- Created At: ${plan.createdAt}`);
  lines.push(`- Updated At: ${plan.updatedAt}`);
  lines.push('');
  lines.push('## Description');
  lines.push(plan.description || 'No description provided.');
  lines.push('');
  lines.push('## Nodes');
  if (plan.nodes.length === 0) {
    lines.push('- No nodes.');
  } else {
    for (const node of plan.nodes) {
      lines.push(`- [${node.type}] ${node.title} (id: ${node.id}, status: ${node.status}, branch: ${node.assignedBranch || 'main'})`);
      if (node.description) {
        lines.push(`  - ${node.description}`);
      }
      if (node.dependencies.length > 0) {
        lines.push(`  - depends_on: ${node.dependencies.join(', ')}`);
      }
    }
  }
  lines.push('');
  lines.push('## Predicted Branches');
  if (plan.predictedBranches.length === 0) {
    lines.push('- None');
  } else {
    for (const branch of plan.predictedBranches) {
      lines.push(`- ${branch.name} (${branch.status}) tasks=${branch.taskIds.length}`);
    }
  }

  return lines.join('\n');
};

const buildTaskPlannedMarkdown = (plan: ArchitectPlanRecord, node: PlanNode): string => {
  const lines: string[] = [];
  const projectIds = normalizeProjectIds(node.projectIds, node.projectId);
  lines.push(`# Planned Task: ${node.title}`);
  lines.push('');
  lines.push(`- Plan ID: ${plan.id}`);
  lines.push(`- Plan Title: ${plan.title}`);
  lines.push(`- Task ID: ${node.id}`);
  lines.push(`- Branch: ${node.assignedBranch || 'work'}`);
  lines.push(`- Projects: ${projectIds.join(', ') || 'none'}`);
  lines.push(`- Status: ${node.status}`);
  if (node.dependencies.length > 0) {
    lines.push(`- Depends On: ${node.dependencies.join(', ')}`);
  }
  lines.push('');
  lines.push(node.description || 'No task description provided.');
  return lines.join('\n');
};

export interface ArchitectTaskExecutionRecord {
  taskId: string;
  title: string;
  completedAt: string;
  summary?: string;
  repositories: Array<{
    projectId: string;
    repoPath: string;
    branchName: string;
    planBranchName: string;
    mergeOutput?: string;
  }>;
}

const buildTaskExecutedMarkdown = (plan: ArchitectPlanRecord, record: ArchitectTaskExecutionRecord): string => {
  const lines: string[] = [];
  lines.push(`# Executed Task: ${record.title}`);
  lines.push('');
  lines.push(`- Plan ID: ${plan.id}`);
  lines.push(`- Plan Title: ${plan.title}`);
  lines.push(`- Task ID: ${record.taskId}`);
  lines.push(`- Completed At: ${record.completedAt}`);
  if (record.summary) {
    lines.push(`- Summary: ${record.summary}`);
  }
  lines.push('');
  lines.push('## Repository Integrations');
  for (const repo of record.repositories) {
    lines.push(`- ${repo.projectId}: ${repo.branchName} -> ${repo.planBranchName}`);
    lines.push(`  - repo: ${repo.repoPath}`);
    if (repo.mergeOutput) {
      lines.push(`  - merge: ${repo.mergeOutput}`);
    }
  }
  return lines.join('\n');
};

interface ArchitectMetadataScope {
  scopeKey: string;
  projectId: string | null;
  repoPath: string | null;
  workspacePath: string | null;
  source: 'local' | 'project' | 'workspace';
}

interface ArchitectPlanReplicaSnapshot {
  scope: ArchitectMetadataScope;
  plan: ArchitectPlanRecord;
  needs: Need[];
  files: Record<string, string>;
}

interface ArchitectPlanReplicaSet {
  canonical: ArchitectPlanReplicaSnapshot;
  snapshots: ArchitectPlanReplicaSnapshot[];
  expectedScopes: ArchitectMetadataScope[];
  replicas: ArchitectPlanReplica[];
  hasReplicaDivergence: boolean;
}

const normalizeRepoPath = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
};

const buildScopeKey = (source: ArchitectMetadataScope['source'], repoPath: string | null, projectId: string | null): string => {
  if (repoPath) {
    return `repo:${repoPath}`;
  }
  return `${source}:${projectId || 'none'}`;
};

const dedupeScopes = (scopes: ArchitectMetadataScope[]): ArchitectMetadataScope[] =>
  Array.from(new Map(scopes.map((scope) => [scope.scopeKey, scope])).values());

const getProjectMetadataScopes = (projectIds?: string[]): ArchitectMetadataScope[] => {
  const appState = useAppStore.getState();
  const projects = appState.projectGroups.flatMap((group) => group.projects);
  const projectMap = new Map(
    projects.map((project) => [project.id, normalizeRepoPath(project.path)])
  );
  const targetProjectIds = projectIds && projectIds.length > 0
    ? Array.from(new Set(projectIds))
    : Array.from(new Set(projects.map((project) => project.id)));

  return targetProjectIds.map((projectId) => {
    const repoPath = projectMap.get(projectId) || null;
    return {
      scopeKey: buildScopeKey('project', repoPath, projectId),
      projectId,
      repoPath,
      workspacePath: repoPath,
      source: 'project' as const,
    };
  });
};

const getWorkspaceFallbackScope = async (): Promise<ArchitectMetadataScope | null> => {
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

const resolveMetadataScopes = async (projectIds?: string[], options?: {
  includeAllKnown?: boolean;
  includeWorkspaceFallback?: boolean;
}): Promise<ArchitectMetadataScope[]> => {
  if (!tauriIpc.isTauriAvailable()) {
    return [{
      scopeKey: 'local',
      projectId: projectIds?.[0] || null,
      repoPath: null,
      workspacePath: null,
      source: 'local',
    }];
  }

  const scopes: ArchitectMetadataScope[] = [];
  if (projectIds && projectIds.length > 0) {
    scopes.push(...getProjectMetadataScopes(projectIds));
  }
  if (options?.includeAllKnown || scopes.length === 0) {
    scopes.push(...getProjectMetadataScopes());
  }
  if (options?.includeWorkspaceFallback !== false) {
    const workspaceScope = await getWorkspaceFallbackScope();
    if (workspaceScope) {
      scopes.push(workspaceScope);
    }
  }
  return dedupeScopes(scopes);
};

const assertWritableScopes = (scopes: ArchitectMetadataScope[]): void => {
  const unresolvedProjectIds = scopes
    .filter((scope) => scope.source === 'project' && !scope.workspacePath)
    .map((scope) => scope.projectId)
    .filter((projectId): projectId is string => typeof projectId === 'string' && projectId.trim().length > 0);

  if (unresolvedProjectIds.length > 0) {
    throw new Error(
      `Unable to resolve repository path for project${unresolvedProjectIds.length > 1 ? 's' : ''} ${unresolvedProjectIds.join(', ')}.`
    );
  }
};

const toReplicaDescriptor = (
  scope: ArchitectMetadataScope,
  updatedAt?: string | null,
  missing = false
): ArchitectPlanReplica => ({
  scopeKey: scope.scopeKey,
  projectId: scope.projectId,
  repoPath: scope.repoPath,
  workspacePath: scope.workspacePath,
  source: scope.source,
  updatedAt,
  missing,
});

const stableSortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortObject(item));
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

const compareReplicaRecency = (
  left: Pick<ArchitectPlanReplica, 'updatedAt' | 'repoPath'>,
  right: Pick<ArchitectPlanReplica, 'updatedAt' | 'repoPath'>
): number => {
  const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
  const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return (left.repoPath || '').localeCompare(right.repoPath || '');
};

const pickCanonicalReplica = <T extends { updatedAt?: string | null; repoPath: string | null }>(
  items: T[],
  strategy: ArchitectPlanReplicaRepairStrategy = 'newest'
): T => {
  const sorted = [...items].sort(compareReplicaRecency);
  return strategy === 'oldest' ? sorted[0] : sorted[sorted.length - 1];
};

const stripPlanReplicaMetadata = (plan: ArchitectPlanRecord): ArchitectPlanRecord => ({
  ...plan,
  replicas: undefined,
  hasReplicaDivergence: undefined,
});

const buildReplicaComparableSnapshot = (snapshot: ArchitectPlanReplicaSnapshot): unknown => ({
  plan: stripPlanReplicaMetadata(snapshot.plan),
  needs: snapshot.needs,
  files: snapshot.files,
});

const buildReplicaComparableSummary = (summary: ArchitectPlanSummary): unknown => ({
  ...summary,
  replicas: undefined,
  hasReplicaDivergence: undefined,
});

const throwReplicaDivergence = (params: {
  branchName: string;
  planId: string;
  reason: ArchitectPlanReplicaDivergence['reason'];
  replicas: ArchitectPlanReplica[];
}): never => {
  throw new ArchitectPlanReplicaDivergenceError({
    branchName: params.branchName,
    planId: params.planId,
    reason: params.reason,
    replicas: params.replicas,
  });
};

const syncPlanTaskMetadataAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  plan: ArchitectPlanRecord
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return;
  const normalizedBranch = normalizeBranchName(branchName);
  const normalizedPlan = {
    ...plan,
    nodes: normalizePlanNodes(plan.nodes),
    predictedBranches: normalizePlanPredictedBranches(plan.predictedBranches),
  };

  await Promise.all(
    normalizedPlan.nodes.map((node) =>
      tauriIpc.fsWriteFile({
        path: getTaskPlannedPath(normalizedBranch, normalizedPlan.id, node.id),
        content: buildTaskPlannedMarkdown(normalizedPlan, node),
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: METADATA_WORKSPACE_SCOPE,
        workspacePath: scope.workspacePath,
      })
    )
  );
};

const readJsonFileAtScope = async <T>(
  scope: ArchitectMetadataScope,
  path: string
): Promise<T | null> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return null;
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: METADATA_WORKSPACE_SCOPE,
      workspacePath: scope.workspacePath,
    });
    return JSON.parse(file.content) as T;
  } catch {
    return null;
  }
};

const writeJsonFileAtScope = async (
  scope: ArchitectMetadataScope,
  path: string,
  value: unknown
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return;
  await tauriIpc.fsWriteFile({
    path,
    content: JSON.stringify(value, null, 2),
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: METADATA_WORKSPACE_SCOPE,
    workspacePath: scope.workspacePath,
  });
};

const readLocalIndex = (branchName: string): ArchitectPlanIndex => {
  if (typeof window === 'undefined') return emptyIndex();
  try {
    const raw = window.localStorage.getItem(localIndexKey(branchName));
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
        version: 2,
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

const writeLocalIndex = (branchName: string, value: ArchitectPlanIndex): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(localIndexKey(branchName), JSON.stringify(value));
};

const readLocalPlan = (branchName: string, planId: string): ArchitectPlanRecord | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(localPlanKey(branchName, planId));
    if (!raw) return null;
    return JSON.parse(raw) as ArchitectPlanRecord;
  } catch {
    return null;
  }
};

const readLocalPlanNeeds = (branchName: string, planId: string): Need[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(localPlanNeedsKey(branchName, planId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Need[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeLocalPlan = (branchName: string, plan: ArchitectPlanRecord): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(localPlanKey(branchName, plan.id), JSON.stringify(plan));
};

const writeLocalPlanNeeds = (branchName: string, planId: string, needs: Need[]): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(localPlanNeedsKey(branchName, planId), JSON.stringify(needs));
};

const deleteLocalPlan = (branchName: string, planId: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(localPlanKey(branchName, planId));
};

const deleteLocalPlanNeeds = (branchName: string, planId: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(localPlanNeedsKey(branchName, planId));
};

const normalizeSummariesForBranch = (
  branchName: string,
  summaries: ArchitectPlanSummary[]
): ArchitectPlanSummary[] =>
  summaries.map((summary) => {
    const projectIds = resolvePlanProjectIds(summary);
    return {
      ...summary,
      id: sanitizeId(summary.id),
      slug: slugifyPlanTitle((summary as Partial<ArchitectPlanSummary>).slug || summary.title || summary.id),
      targetBranch: normalizeBranchName(summary.targetBranch || branchName),
      projectId: projectIds[0],
      projectIds,
      nodeCount: typeof summary.nodeCount === 'number' ? summary.nodeCount : 0,
    };
  });

const readIndexAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string
): Promise<ArchitectPlanIndex> => {
  const normalized = normalizeBranchName(branchName);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    const local = readLocalIndex(normalized);
    return {
      ...local,
      plans: normalizeSummariesForBranch(normalized, local.plans),
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
      version: 2,
      activePlanId: parsed.activePlanId || null,
      plans: normalizeSummariesForBranch(normalized, parsed.plans),
      reservedPlanSlugs: Array.from(new Set([...reservedPlanSlugs, ...planSlugsFromIndex])),
    };
  }

  return emptyIndex();
};

const writeIndexAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  index: ArchitectPlanIndex
): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    writeLocalIndex(normalized, index);
    return;
  }

  await writeJsonFileAtScope(scope, getIndexPath(normalized), index);
};

const normalizePlanRecordForBranch = (
  branchName: string,
  planId: string,
  plan: ArchitectPlanRecord | null
): ArchitectPlanRecord | null => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!plan) return null;

  const nodes = normalizePlanNodes(Array.isArray(plan.nodes) ? plan.nodes : []);
  const predictedBranches = normalizePlanPredictedBranches(Array.isArray(plan.predictedBranches) ? plan.predictedBranches : []);
  const projectIds = resolvePlanProjectIds({
    projectIds: plan.projectIds,
    projectId: plan.projectId,
    nodes,
    predictedBranches,
  });

  return {
    ...plan,
    id: sanitizeId(plan.id || safeId),
    slug: slugifyPlanTitle((plan as Partial<ArchitectPlanRecord>).slug || plan.title || safeId),
    targetBranch: normalizeBranchName(plan.targetBranch || normalized),
    projectId: projectIds[0],
    projectIds,
    nodes,
    predictedBranches,
  };
};

const readPlanAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<ArchitectPlanRecord | null> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return normalizePlanRecordForBranch(normalized, safeId, readLocalPlan(normalized, safeId));
  }

  return normalizePlanRecordForBranch(
    normalized,
    safeId,
    await readJsonFileAtScope<ArchitectPlanRecord>(scope, getPlanJsonPath(normalized, safeId))
  );
};

const readPlanNeedsAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<Need[]> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return readLocalPlanNeeds(normalized, safeId);
  }
  const parsed = await readJsonFileAtScope<Need[]>(scope, getPlanNeedsPath(normalized, safeId));
  return Array.isArray(parsed) ? parsed : [];
};

const writePlanAtScope = async (scope: ArchitectMetadataScope, branchName: string, plan: ArchitectPlanRecord): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const normalizedNodes = normalizePlanNodes(plan.nodes || []);
  const normalizedPredictedBranches = normalizePlanPredictedBranches(plan.predictedBranches || []);
  const projectIds = resolvePlanProjectIds({
    projectIds: plan.projectIds,
    projectId: plan.projectId,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  });
  const normalizedPlan: ArchitectPlanRecord = {
    ...stripPlanReplicaMetadata(plan),
    projectId: projectIds[0],
    projectIds,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  };

  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    writeLocalPlan(normalized, normalizedPlan);
    return;
  }

  const safeId = sanitizeId(normalizedPlan.id);
  await writeJsonFileAtScope(scope, getPlanJsonPath(normalized, safeId), normalizedPlan);
  await tauriIpc.fsWriteFile({
    path: getPlanMarkdownPath(normalized, safeId),
    content: buildPlanMarkdown(normalizedPlan),
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: METADATA_WORKSPACE_SCOPE,
    workspacePath: scope.workspacePath,
  });
  await syncPlanTaskMetadataAtScope(scope, normalized, normalizedPlan);
};

const writePlanNeedsAtScope = async (scope: ArchitectMetadataScope, branchName: string, planId: string, needs: Need[]): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const normalizedNeeds = needs.map((need) => ({ ...need, planId: safeId }));
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    writeLocalPlanNeeds(normalized, safeId, normalizedNeeds);
    return;
  }
  await writeJsonFileAtScope(scope, getPlanNeedsPath(normalized, safeId), normalizedNeeds);
};

const removePlanAtScope = async (scope: ArchitectMetadataScope, branchName: string, planId: string): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    deleteLocalPlan(normalized, safeId);
    deleteLocalPlanNeeds(normalized, safeId);
    return;
  }

  try {
    await tauriIpc.fsDelete({
      path: getPlanDir(normalized, safeId),
      recursive: true,
      workspaceScope: METADATA_WORKSPACE_SCOPE,
      workspacePath: scope.workspacePath,
    });
  } catch {
    // Ignore missing path errors.
  }
};

const readPlanFilesAtScope = async (
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
      workspaceScope: METADATA_WORKSPACE_SCOPE,
      workspacePath: scope.workspacePath,
    });
    const files = entries.filter((entry) => entry.kind === 'file');
    const contents = await Promise.all(
      files.map(async (entry) => {
        const relativePath = entry.relative_path.replace(/\\/g, '/').replace(/^\/+/, '');
        const content = await tauriIpc.fsReadFileWithOptions({
          path: `${planDir}/${relativePath}`,
          allowOutsideWorkspace: false,
          workspaceScope: METADATA_WORKSPACE_SCOPE,
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

const toSummary = (plan: ArchitectPlanRecord): ArchitectPlanSummary => ({
  id: plan.id,
  slug: plan.slug,
  title: plan.title,
  description: plan.description,
  status: plan.status,
  targetBranch: plan.targetBranch,
  conversationId: plan.conversationId,
  projectId: plan.projectId,
  projectIds: resolvePlanProjectIds(plan),
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
  nodeCount: plan.nodes.length,
});

const upsertSummary = (summaries: ArchitectPlanSummary[], summary: ArchitectPlanSummary): ArchitectPlanSummary[] => {
  const found = summaries.some((item) => item.id === summary.id);
  if (!found) return [...summaries, summary];
  return summaries.map((item) => (item.id === summary.id ? summary : item));
};

const mergePlanSummaries = (
  entries: Array<{ scope: ArchitectMetadataScope; summary: ArchitectPlanSummary }>
): ArchitectPlanSummary => {
  const canonicalEntry = pickCanonicalReplica(
    entries.map(({ scope, summary }) => ({
      summary,
      updatedAt: summary.updatedAt,
      repoPath: scope.repoPath,
    }))
  ).summary;
  const projectIds = Array.from(
    new Set(entries.flatMap(({ summary }) => resolvePlanProjectIds(summary)))
  );
  const hasReplicaDivergence =
    new Set(entries.map(({ summary }) => stableSerialize(buildReplicaComparableSummary(summary)))).size > 1;

  return {
    ...canonicalEntry,
    projectId: projectIds[0],
    projectIds,
    replicas: entries.map(({ scope, summary }) => toReplicaDescriptor(scope, summary.updatedAt)),
    hasReplicaDivergence,
  };
};

const readAggregatedIndex = async (branchName: string): Promise<ArchitectPlanIndex> => {
  const normalized = normalizeBranchName(branchName);
  const scopes = await resolveMetadataScopes(undefined, { includeAllKnown: true });
  const indexes = await Promise.all(
    scopes.map(async (scope) => ({ scope, index: await readIndexAtScope(scope, normalized) }))
  );

  const plansById = new Map<string, Array<{ scope: ArchitectMetadataScope; summary: ArchitectPlanSummary }>>();
  for (const { scope, index } of indexes) {
    for (const summary of index.plans) {
      const existing = plansById.get(summary.id) || [];
      existing.push({ scope, summary });
      plansById.set(summary.id, existing);
    }
  }

  return {
    version: 2,
    activePlanId: indexes.map(({ index }) => index.activePlanId).find((planId) => Boolean(planId)) || null,
    plans: Array.from(plansById.values()).map((entries) => mergePlanSummaries(entries)),
    reservedPlanSlugs: Array.from(
      new Set(indexes.flatMap(({ index }) => index.reservedPlanSlugs.map((slug) => slugifyPlanTitle(slug))))
    ),
  };
};

const loadPlanReplicaSet = async (
  branchName: string,
  planId: string,
  options?: {
    allowDivergence?: boolean;
  }
): Promise<ArchitectPlanReplicaSet | null> => {
  const normalizedBranch = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const scopes = await resolveMetadataScopes(undefined, { includeAllKnown: true });
  const snapshots = (
    await Promise.all(
      scopes.map(async (scope) => {
        const plan = await readPlanAtScope(scope, normalizedBranch, safeId);
        if (!plan) return null;
        const needs = await readPlanNeedsAtScope(scope, normalizedBranch, safeId);
        const files = await readPlanFilesAtScope(scope, normalizedBranch, safeId);
        return { scope, plan, needs, files } satisfies ArchitectPlanReplicaSnapshot;
      })
    )
  ).filter((snapshot): snapshot is ArchitectPlanReplicaSnapshot => Boolean(snapshot));

  if (snapshots.length === 0) {
    return null;
  }

  const projectIds = Array.from(new Set(snapshots.flatMap((snapshot) => resolvePlanProjectIds(snapshot.plan))));
  const expectedScopes = dedupeScopes([
    ...(await resolveMetadataScopes(projectIds, { includeWorkspaceFallback: false })),
    ...snapshots.map((snapshot) => snapshot.scope),
  ]);

  const missingReplicas = expectedScopes
    .filter((scope) =>
      Boolean(scope.projectId) &&
      projectIds.includes(scope.projectId as string) &&
      !snapshots.some((snapshot) => snapshot.scope.scopeKey === scope.scopeKey)
    )
    .map((scope) => toReplicaDescriptor(scope, null, true));

  const hasContentDivergence =
    new Set(snapshots.map((snapshot) => stableSerialize(buildReplicaComparableSnapshot(snapshot)))).size > 1;
  const hasReplicaDivergence = hasContentDivergence || missingReplicas.length > 0;
  const replicas = [
    ...snapshots.map((snapshot) => toReplicaDescriptor(snapshot.scope, snapshot.plan.updatedAt)),
    ...missingReplicas,
  ];

  if (!options?.allowDivergence) {
    if (missingReplicas.length > 0) {
      throwReplicaDivergence({
        branchName: normalizedBranch,
        planId: safeId,
        reason: 'missing_replica',
        replicas,
      });
    }
    if (hasContentDivergence) {
      throwReplicaDivergence({
        branchName: normalizedBranch,
        planId: safeId,
        reason: 'content_diverged',
        replicas,
      });
    }
  }

  const canonical = pickCanonicalReplica(
    snapshots.map((snapshot) => ({
      ...snapshot,
      updatedAt: snapshot.plan.updatedAt,
      repoPath: snapshot.scope.repoPath,
    })),
    'newest'
  );

  return {
    canonical: {
      scope: canonical.scope,
      plan: {
        ...canonical.plan,
        projectId: projectIds[0],
        projectIds,
        replicas,
        hasReplicaDivergence,
      },
      needs: canonical.needs,
      files: canonical.files,
    },
    snapshots,
    expectedScopes,
    replicas,
    hasReplicaDivergence,
  };
};

const upsertPlanInScopeIndex = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  plan: ArchitectPlanRecord,
  options?: {
    setActive?: boolean;
  }
): Promise<void> => {
  const index = await readIndexAtScope(scope, branchName);
  await writeIndexAtScope(scope, branchName, {
    ...index,
    version: 2,
    plans: upsertSummary(index.plans, toSummary(plan)),
    activePlanId: options?.setActive ? plan.id : index.activePlanId,
    reservedPlanSlugs: Array.from(new Set([...index.reservedPlanSlugs, plan.slug])),
  });
};

const removePlanFromScopeIndex = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<void> => {
  const safeId = sanitizeId(planId);
  const index = await readIndexAtScope(scope, branchName);
  const nextPlans = index.plans.filter((plan) => plan.id !== safeId);
  await writeIndexAtScope(scope, branchName, {
    ...index,
    version: 2,
    plans: nextPlans,
    activePlanId: index.activePlanId === safeId ? nextPlans[0]?.id || null : index.activePlanId,
  });
};

const ensurePlanScopes = async (projectIds: string[]): Promise<ArchitectMetadataScope[]> => {
  if (!tauriIpc.isTauriAvailable()) {
    return [{
      scopeKey: 'local',
      projectId: projectIds[0] || null,
      repoPath: null,
      workspacePath: null,
      source: 'local',
    }];
  }

  if (projectIds.length > 0) {
    const scopes = dedupeScopes(getProjectMetadataScopes(projectIds));
    assertWritableScopes(scopes);
    if (scopes.length > 0) {
      return scopes;
    }
  }

  const selectedProjectId = useAppStore.getState().selectedProjectId;
  if (selectedProjectId) {
    const selectedScopes = dedupeScopes(getProjectMetadataScopes([selectedProjectId]));
    assertWritableScopes(selectedScopes);
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

export const listArchitectPlans = async (branchName: string, includeDeleted = false, includeArchived = false): Promise<{
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
}> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const index = await readAggregatedIndex(normalizedBranch);
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

export const getArchitectPlan = async (branchName: string, planId: string): Promise<ArchitectPlanRecord | null> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, planId);
  return replicaSet?.canonical.plan || null;
};

export const createArchitectPlan = async (input: {
  branchName: string;
  title: string;
  slug?: string;
  description?: string;
  conversationId?: string;
  projectId?: string;
  projectIds?: string[];
  status?: ArchitectPlanStatus;
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  planId?: string;
  setActive?: boolean;
}): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const now = new Date().toISOString();

  // Read index early for uniqueness checks
  const index = await readAggregatedIndex(normalizedBranch);
  const nextSlug = slugifyPlanTitle(input.slug || input.title || String(Date.now()));

  // Reject duplicate slugs across all historical plans, including deleted ones.
  if (index.reservedPlanSlugs.includes(nextSlug)) {
    throw new Error(`A plan named "${input.title}" already exists or existed before. Choose a different name.`);
  }

  // ID is always a random numeric sequence — independent of the title
  const planId = input.planId ? sanitizeId(input.planId) : String(Date.now());
  const normalizedNodes = normalizePlanNodes(input.nodes || []);
  const normalizedPredictedBranches = normalizePlanPredictedBranches(input.predictedBranches || []);
  const projectIds = resolvePlanProjectIds({
    projectIds: input.projectIds,
    projectId: input.projectId,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  });

  const plan: ArchitectPlanRecord = {
    id: planId,
    slug: nextSlug,
    title: (input.title || 'Untitled plan').trim(),
    description: (input.description || '').trim(),
    status: input.status || 'draft',
    targetBranch: normalizedBranch,
    conversationId: input.conversationId,
    projectId: projectIds[0],
    projectIds,
    createdAt: now,
    updatedAt: now,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  };

  const scopes = await ensurePlanScopes(projectIds);
  await Promise.all(
    scopes.map(async (scope) => {
      await writePlanAtScope(scope, normalizedBranch, plan);
      await upsertPlanInScopeIndex(scope, normalizedBranch, plan, {
        setActive: input.setActive !== false,
      });
    })
  );

  return (await getArchitectPlan(normalizedBranch, plan.id)) || plan;
};

export const updateArchitectPlan = async (input: {
  branchName: string;
  planId: string;
  title?: string;
  slug?: string;
  description?: string;
  conversationId?: string;
  status?: ArchitectPlanStatus;
  projectId?: string;
  projectIds?: string[];
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  setActive?: boolean;
}): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId);
  if (!replicaSet) {
    throw new Error(`Plan not found: ${safeId}`);
  }
  const existing = replicaSet.canonical.plan;

  // Reject duplicate titles when the title is being changed (case-insensitive, excluding self and deleted plans)
  if (input.title && input.title.trim().toLowerCase() !== existing.title.trim().toLowerCase()) {
    const idx = await readAggregatedIndex(normalizedBranch);
    const normalizedTitle = input.title.trim().toLowerCase();
    const titleConflict = idx.plans.find(
      (p) => p.id !== safeId && p.status !== 'deleted' && p.title.trim().toLowerCase() === normalizedTitle
    );
    if (titleConflict) {
      throw new Error(`A plan named "${titleConflict.title}" already exists. Choose a different name.`);
    }
  }

  const requestedSlug = input.slug ? slugifyPlanTitle(input.slug) : existing.slug;
  if (requestedSlug !== existing.slug) {
    throw new Error('Plan slug is immutable and cannot be changed after creation.');
  }

  const nextNodes = input.nodes !== undefined ? normalizePlanNodes(input.nodes) : existing.nodes;
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

  const next: ArchitectPlanRecord = {
    ...existing,
    slug: existing.slug,
    title: input.title?.trim() || existing.title,
    description: input.description !== undefined ? input.description.trim() : existing.description,
    conversationId: input.conversationId !== undefined ? input.conversationId : existing.conversationId,
    status: input.status || existing.status,
    projectId: projectIds[0],
    projectIds,
    nodes: nextNodes,
    predictedBranches: nextPredictedBranches,
    updatedAt: new Date().toISOString(),
  };

  const targetScopes = await ensurePlanScopes(projectIds);
  const existingScopes = dedupeScopes([
    ...replicaSet.expectedScopes,
    ...replicaSet.snapshots.map((snapshot) => snapshot.scope),
  ]);
  const targetScopeKeys = new Set(targetScopes.map((scope) => scope.scopeKey));
  const removedScopes = existingScopes.filter((scope) => !targetScopeKeys.has(scope.scopeKey));
  const writeScopes = dedupeScopes([
    ...targetScopes,
    ...existingScopes.filter((scope) => targetScopeKeys.has(scope.scopeKey)),
  ]);

  await Promise.all(
    writeScopes.map(async (scope) => {
      await writePlanAtScope(scope, normalizedBranch, next);
      await writePlanNeedsAtScope(scope, normalizedBranch, next.id, replicaSet.canonical.needs);
      await upsertPlanInScopeIndex(scope, normalizedBranch, next, {
        setActive: input.setActive === true,
      });
    })
  );

  await Promise.all(
    removedScopes.map(async (scope) => {
      await removePlanAtScope(scope, normalizedBranch, next.id);
      await removePlanFromScopeIndex(scope, normalizedBranch, next.id);
    })
  );

  return (await getArchitectPlan(normalizedBranch, next.id)) || next;
};

export const setActiveArchitectPlan = async (branchName: string, planId: string): Promise<void> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId);
  if (!replicaSet || replicaSet.canonical.plan.status === 'deleted') {
    throw new Error(`Cannot activate missing or deleted plan: ${planId}`);
  }

  await Promise.all(
    dedupeScopes(replicaSet.expectedScopes).map(async (scope) => {
      const index = await readIndexAtScope(scope, normalizedBranch);
      const exists = index.plans.some((plan) => plan.id === safeId && plan.status !== 'deleted');
      if (!exists) {
        return;
      }
      await writeIndexAtScope(scope, normalizedBranch, {
        ...index,
        version: 2,
        activePlanId: safeId,
      });
    })
  );
};

export const deleteArchitectPlan = async (input: {
  branchName: string;
  planId: string;
  hardDelete?: boolean;
}): Promise<void> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId);
  if (!replicaSet) {
    throw new Error(`Plan not found: ${safeId}`);
  }
  const scopes = dedupeScopes(replicaSet.expectedScopes);

  if (input.hardDelete) {
    await Promise.all(
      scopes.map(async (scope) => {
        await removePlanAtScope(scope, normalizedBranch, safeId);
        await removePlanFromScopeIndex(scope, normalizedBranch, safeId);
      })
    );
    return;
  }

  const deleted = {
    ...replicaSet.canonical.plan,
    status: 'deleted' as ArchitectPlanStatus,
    updatedAt: new Date().toISOString(),
  };
  await Promise.all(
    scopes.map(async (scope) => {
      await writePlanAtScope(scope, normalizedBranch, deleted);
      const index = await readIndexAtScope(scope, normalizedBranch);
      const nextPlans = index.plans.map((plan) =>
        plan.id === safeId
          ? {
              ...plan,
              status: 'deleted' as ArchitectPlanStatus,
              updatedAt: deleted.updatedAt,
            }
          : plan
      );

      await writeIndexAtScope(scope, normalizedBranch, {
        ...index,
        version: 2,
        plans: nextPlans,
        activePlanId: index.activePlanId === safeId
          ? nextPlans.find((plan) => plan.status !== 'deleted')?.id || null
          : index.activePlanId,
      });
    })
  );
};

export const restoreArchitectPlan = async (branchName: string, planId: string): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  return updateArchitectPlan({ branchName: normalizedBranch, planId, status: 'draft' });
};

export const archiveArchitectPlan = async (branchName: string, planId: string): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId);
  if (!replicaSet) throw new Error(`Plan not found: ${safeId}`);
  const now = new Date().toISOString();
  const archived: ArchitectPlanRecord = { ...replicaSet.canonical.plan, status: 'archived', updatedAt: now };
  await Promise.all(
    dedupeScopes(replicaSet.expectedScopes).map(async (scope) => {
      await writePlanAtScope(scope, normalizedBranch, archived);
      const index = await readIndexAtScope(scope, normalizedBranch);
      const nextPlans = index.plans.map((plan) =>
        plan.id === safeId ? { ...plan, status: 'archived' as ArchitectPlanStatus, updatedAt: now } : plan
      );
      const nextActivePlanId =
        index.activePlanId === safeId
          ? nextPlans.find((plan) => plan.status !== 'deleted' && plan.status !== 'archived')?.id || null
          : index.activePlanId;
      await writeIndexAtScope(scope, normalizedBranch, {
        ...index,
        version: 2,
        plans: nextPlans,
        activePlanId: nextActivePlanId,
      });
    })
  );
  return (await getArchitectPlan(normalizedBranch, safeId)) || archived;
};

export const getArchitectPlanNeeds = async (branchName: string, planId: string): Promise<Need[]> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, planId);
  if (!replicaSet) {
    throw new Error(`Plan not found: ${sanitizeId(planId)}`);
  }
  return replicaSet.canonical.needs;
};

export const saveArchitectPlanNeeds = async (branchName: string, planId: string, needs: Need[]): Promise<void> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, planId);
  if (!replicaSet) {
    throw new Error(`Plan not found: ${sanitizeId(planId)}`);
  }
  await Promise.all(
    dedupeScopes(replicaSet.expectedScopes).map((scope) =>
      writePlanNeedsAtScope(scope, normalizedBranch, planId, needs)
    )
  );
};

export const repairArchitectPlanReplicas = async (input: {
  branchName: string;
  planId: string;
  strategy: ArchitectPlanReplicaRepairStrategy;
}): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, input.planId, {
    allowDivergence: true,
  });
  if (!replicaSet) {
    throw new Error(`Plan not found: ${sanitizeId(input.planId)}`);
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
    stripPlanReplicaMetadata(canonicalSnapshot.plan)
  );
  if (!canonicalPlan) {
    throw new Error(`Plan not found: ${sanitizeId(input.planId)}`);
  }

  const skippedFiles = new Set(['plan.json', 'plan.md', 'needs.json']);
  await Promise.all(
    dedupeScopes(replicaSet.expectedScopes).map(async (scope) => {
      await removePlanAtScope(scope, normalizedBranch, canonicalPlan.id);
      await writePlanAtScope(scope, normalizedBranch, canonicalPlan);
      await writePlanNeedsAtScope(scope, normalizedBranch, canonicalPlan.id, canonicalSnapshot.needs);
      await upsertPlanInScopeIndex(scope, normalizedBranch, canonicalPlan);

      if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
        return;
      }

      await Promise.all(
        Object.entries(canonicalSnapshot.files)
          .filter(([relativePath]) => !skippedFiles.has(relativePath))
          .filter(([relativePath]) => !relativePath.endsWith('/planned.md'))
          .map(([relativePath, content]) =>
            tauriIpc.fsWriteFile({
              path: `${getPlanDir(normalizedBranch, canonicalPlan.id)}/${relativePath}`,
              content,
              createDirs: true,
              allowOutsideWorkspace: false,
              workspaceScope: METADATA_WORKSPACE_SCOPE,
              workspacePath: scope.workspacePath,
            })
          )
      );
    })
  );

  const repaired = await getArchitectPlan(normalizedBranch, canonicalPlan.id);
  if (!repaired) {
    throw new Error(`Plan not found: ${sanitizeId(input.planId)}`);
  }
  return repaired;
};

export const writeArchitectTaskExecution = async (params: {
  branchName: string;
  planId: string;
  execution: ArchitectTaskExecutionRecord;
}): Promise<void> => {
  const normalizedBranch = normalizeBranchName(params.branchName);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, params.planId);
  if (!replicaSet) {
    throw new Error(`Plan not found: ${params.planId}`);
  }
  if (!tauriIpc.isTauriAvailable()) return;

  await Promise.all(
    dedupeScopes(replicaSet.expectedScopes).map((scope) =>
      tauriIpc.fsWriteFile({
        path: getTaskExecutedPath(normalizedBranch, replicaSet.canonical.plan.id, params.execution.taskId),
        content: buildTaskExecutedMarkdown(replicaSet.canonical.plan, params.execution),
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: METADATA_WORKSPACE_SCOPE,
        workspacePath: scope.workspacePath,
      })
    )
  );
};

export const toPlanScopedFeatureBranch = (planSlug: string, rawBranchName: string): string => {
  const normalizedPlanSlug = slugifyPlanTitle(planSlug);
  const featureSlug = normalizeFeatureSlugInput(rawBranchName);
  return toPlanFeatureBranchName(normalizedPlanSlug, featureSlug);
};

export const toPlanIntegrationBranch = (planSlug: string): string =>
  toPlanIntegrationBranchName(slugifyPlanTitle(planSlug));

export const resolveTargetBranch = (argsValue: unknown): string => {
  const normalized = normalizeBranchName(typeof argsValue === 'string' ? argsValue : getGitFlowBaseBranch(), getGitFlowBaseBranch());
  assertGitFlowTargetBranch(normalized);
  return normalized;
};

export const getGitFlowBaseBranch = (): string =>
  normalizeBranchName(getArchitectGitNamingSettings().baseBranch, DEFAULT_GIT_FLOW_BASE_BRANCH);


