import type { PlanNode, PredictedBranch } from '../types';
import type { Need } from '../types';
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
}

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

const syncPlanTaskMetadata = async (branchName: string, plan: ArchitectPlanRecord): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return;
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
      })
    )
  );
};

const readJsonFile = async <T>(path: string): Promise<T | null> => {
  if (!tauriIpc.isTauriAvailable()) return null;
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: METADATA_WORKSPACE_SCOPE,
    });
    return JSON.parse(file.content) as T;
  } catch {
    return null;
  }
};

const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return;
  await tauriIpc.fsWriteFile({
    path,
    content: JSON.stringify(value, null, 2),
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: METADATA_WORKSPACE_SCOPE,
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

const readIndex = async (branchName: string): Promise<ArchitectPlanIndex> => {
  const normalized = normalizeBranchName(branchName);
  const normalizeSummaries = (summaries: ArchitectPlanSummary[]): ArchitectPlanSummary[] =>
    summaries.map((summary) => ({
      ...summary,
      id: sanitizeId(summary.id),
      slug: slugifyPlanTitle((summary as Partial<ArchitectPlanSummary>).slug || summary.title || summary.id),
      targetBranch: normalizeBranchName(summary.targetBranch || normalized),
      nodeCount: typeof summary.nodeCount === 'number' ? summary.nodeCount : 0,
    }));

  if (!tauriIpc.isTauriAvailable()) {
    const local = readLocalIndex(normalized);
    return {
      ...local,
      plans: normalizeSummaries(local.plans),
      reservedPlanSlugs: Array.from(new Set(local.reservedPlanSlugs.map((slug) => slugifyPlanTitle(slug)))),
    };
  }
  const parsed = await readJsonFile<Partial<ArchitectPlanIndex>>(getIndexPath(normalized));
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
      plans: normalizeSummaries(parsed.plans),
      reservedPlanSlugs: Array.from(new Set([...reservedPlanSlugs, ...planSlugsFromIndex])),
    };
  }
  return emptyIndex();
};

const writeIndex = async (branchName: string, index: ArchitectPlanIndex): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  if (!tauriIpc.isTauriAvailable()) {
    writeLocalIndex(normalized, index);
    return;
  }
  await writeJsonFile(getIndexPath(normalized), index);
};

const readPlan = async (branchName: string, planId: string): Promise<ArchitectPlanRecord | null> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const normalizePlanRecord = (plan: ArchitectPlanRecord | null): ArchitectPlanRecord | null => {
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

  if (!tauriIpc.isTauriAvailable()) {
    return normalizePlanRecord(readLocalPlan(normalized, safeId));
  }
  return normalizePlanRecord(await readJsonFile<ArchitectPlanRecord>(getPlanJsonPath(normalized, safeId)));
};

const readPlanNeeds = async (branchName: string, planId: string): Promise<Need[]> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable()) {
    return readLocalPlanNeeds(normalized, safeId);
  }
  const parsed = await readJsonFile<Need[]>(getPlanNeedsPath(normalized, safeId));
  return Array.isArray(parsed) ? parsed : [];
};

const writePlan = async (branchName: string, plan: ArchitectPlanRecord): Promise<void> => {
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
    ...plan,
    projectId: projectIds[0],
    projectIds,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  };

  if (!tauriIpc.isTauriAvailable()) {
    writeLocalPlan(normalized, normalizedPlan);
    return;
  }

  const safeId = sanitizeId(normalizedPlan.id);
  await writeJsonFile(getPlanJsonPath(normalized, safeId), normalizedPlan);
  await tauriIpc.fsWriteFile({
    path: getPlanMarkdownPath(normalized, safeId),
    content: buildPlanMarkdown(normalizedPlan),
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: METADATA_WORKSPACE_SCOPE,
  });
  await syncPlanTaskMetadata(normalized, normalizedPlan);
};

const writePlanNeeds = async (branchName: string, planId: string, needs: Need[]): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const normalizedNeeds = needs.map((need) => ({ ...need, planId: safeId }));
  if (!tauriIpc.isTauriAvailable()) {
    writeLocalPlanNeeds(normalized, safeId, normalizedNeeds);
    return;
  }
  await writeJsonFile(getPlanNeedsPath(normalized, safeId), normalizedNeeds);
};

const removePlan = async (branchName: string, planId: string): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable()) {
    deleteLocalPlan(normalized, safeId);
    deleteLocalPlanNeeds(normalized, safeId);
    return;
  }

  try {
    await tauriIpc.fsDelete({
      path: getPlanDir(normalized, safeId),
      recursive: true,
      workspaceScope: METADATA_WORKSPACE_SCOPE,
    });
  } catch {
    // Ignore missing path errors.
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

export const listArchitectPlans = async (branchName: string, includeDeleted = false, includeArchived = false): Promise<{
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
}> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const index = await readIndex(normalizedBranch);
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
  return readPlan(normalizedBranch, planId);
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
  const index = await readIndex(normalizedBranch);
  const nextSlug = slugifyPlanTitle(input.slug || input.title || String(Date.now()));

  // Reject duplicate slugs across all historical plans, including deleted ones.
  if (index.reservedPlanSlugs.includes(nextSlug)) {
    throw new Error(`A plan named "${input.title}" already exists or existed before. Choose a different name.`);
  }

  // ID is always a random numeric sequence — independent of the title
  const planId = input.planId ? sanitizeId(input.planId) : String(Date.now());
  const slug = nextSlug;

  const plan: ArchitectPlanRecord = {
    id: planId,
    slug,
    title: (input.title || 'Untitled plan').trim(),
    description: (input.description || '').trim(),
    status: input.status || 'draft',
    targetBranch: normalizedBranch,
    conversationId: input.conversationId,
    projectId: input.projectId,
    createdAt: now,
    updatedAt: now,
    nodes: input.nodes || [],
    predictedBranches: input.predictedBranches || [],
  };

  const summary = toSummary(plan);
  const nextIndex: ArchitectPlanIndex = {
    ...index,
    version: 2,
    plans: upsertSummary(index.plans, summary),
    activePlanId: input.setActive === false ? index.activePlanId : plan.id,
    reservedPlanSlugs: Array.from(new Set([...index.reservedPlanSlugs, slug])),
  };

  await writePlan(normalizedBranch, plan);
  await writeIndex(normalizedBranch, nextIndex);
  return plan;
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
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  setActive?: boolean;
}): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  const existing = await readPlan(normalizedBranch, safeId);
  if (!existing) {
    throw new Error(`Plan not found: ${safeId}`);
  }

  // Reject duplicate titles when the title is being changed (case-insensitive, excluding self and deleted plans)
  if (input.title && input.title.trim().toLowerCase() !== existing.title.trim().toLowerCase()) {
    const idx = await readIndex(normalizedBranch);
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

  const next: ArchitectPlanRecord = {
    ...existing,
    slug: existing.slug,
    title: input.title?.trim() || existing.title,
    description: input.description !== undefined ? input.description.trim() : existing.description,
    conversationId: input.conversationId !== undefined ? input.conversationId : existing.conversationId,
    status: input.status || existing.status,
    projectId: input.projectId !== undefined ? input.projectId : existing.projectId,
    nodes: input.nodes || existing.nodes,
    predictedBranches: input.predictedBranches || existing.predictedBranches,
    updatedAt: new Date().toISOString(),
  };

  const index = await readIndex(normalizedBranch);
  const nextIndex: ArchitectPlanIndex = {
    ...index,
    version: 2,
    plans: upsertSummary(index.plans, toSummary(next)),
    activePlanId: input.setActive ? next.id : index.activePlanId,
    reservedPlanSlugs: Array.from(new Set([...index.reservedPlanSlugs, existing.slug])),
  };

  await writePlan(normalizedBranch, next);
  await writeIndex(normalizedBranch, nextIndex);
  return next;
};

export const setActiveArchitectPlan = async (branchName: string, planId: string): Promise<void> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const index = await readIndex(normalizedBranch);
  const exists = index.plans.some((plan) => plan.id === sanitizeId(planId) && plan.status !== 'deleted');
  if (!exists) {
    throw new Error(`Cannot activate missing or deleted plan: ${planId}`);
  }

  await writeIndex(normalizedBranch, {
    ...index,
    version: 2,
    activePlanId: sanitizeId(planId),
  });
};

export const deleteArchitectPlan = async (input: {
  branchName: string;
  planId: string;
  hardDelete?: boolean;
}): Promise<void> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  const index = await readIndex(normalizedBranch);

  if (input.hardDelete) {
    await removePlan(normalizedBranch, safeId);
    const nextPlans = index.plans.filter((plan) => plan.id !== safeId);
    await writeIndex(normalizedBranch, {
      ...index,
      version: 2,
      plans: nextPlans,
      activePlanId: index.activePlanId === safeId ? nextPlans[0]?.id || null : index.activePlanId,
    });
    return;
  }

  const existing = await readPlan(normalizedBranch, safeId);
  if (!existing) {
    throw new Error(`Plan not found: ${safeId}`);
  }

  const deleted = {
    ...existing,
    status: 'deleted' as ArchitectPlanStatus,
    updatedAt: new Date().toISOString(),
  };
  await writePlan(normalizedBranch, deleted);

  const nextPlans = index.plans.map((plan) =>
    plan.id === safeId
      ? {
          ...plan,
          status: 'deleted' as ArchitectPlanStatus,
          updatedAt: deleted.updatedAt,
        }
      : plan
  );

  await writeIndex(normalizedBranch, {
    ...index,
    version: 2,
    plans: nextPlans,
    activePlanId: index.activePlanId === safeId ? nextPlans.find((plan) => plan.status !== 'deleted')?.id || null : index.activePlanId,
  });
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
  const existing = await readPlan(normalizedBranch, safeId);
  if (!existing) throw new Error(`Plan not found: ${safeId}`);
  const now = new Date().toISOString();
  const archived: ArchitectPlanRecord = { ...existing, status: 'archived', updatedAt: now };
  await writePlan(normalizedBranch, archived);
  const idx = await readIndex(normalizedBranch);
  const nextPlans = idx.plans.map((p) =>
    p.id === safeId ? { ...p, status: 'archived' as ArchitectPlanStatus, updatedAt: now } : p
  );
  const nextActivePlanId =
    idx.activePlanId === safeId
      ? nextPlans.find((p) => p.status !== 'deleted' && p.status !== 'archived')?.id || null
      : idx.activePlanId;
  await writeIndex(normalizedBranch, { ...idx, plans: nextPlans, activePlanId: nextActivePlanId });
  return archived;
};

export const getArchitectPlanNeeds = async (branchName: string, planId: string): Promise<Need[]> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  return readPlanNeeds(normalizedBranch, planId);
};

export const saveArchitectPlanNeeds = async (branchName: string, planId: string, needs: Need[]): Promise<void> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  await writePlanNeeds(normalizedBranch, planId, needs);
};

export const writeArchitectTaskExecution = async (params: {
  branchName: string;
  planId: string;
  execution: ArchitectTaskExecutionRecord;
}): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return;
  const normalizedBranch = normalizeBranchName(params.branchName);
  const plan = await readPlan(normalizedBranch, params.planId);
  if (!plan) {
    throw new Error(`Plan not found: ${params.planId}`);
  }

  await tauriIpc.fsWriteFile({
    path: getTaskExecutedPath(normalizedBranch, plan.id, params.execution.taskId),
    content: buildTaskExecutedMarkdown(plan, params.execution),
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: METADATA_WORKSPACE_SCOPE,
  });
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


