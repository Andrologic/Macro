import type { PlanNode, PredictedBranch } from '../types';
import type { Need } from '../types';
import * as tauriIpc from './tauriIpc';
import {
  getArchitectGitNamingSettings,
  normalizeFeatureSlugInput,
  toPlanFeatureBranchName,
  toPlanIntegrationBranchName,
} from './architectGitNaming';

export type ArchitectPlanStatus = 'draft' | 'validated' | 'in_progress' | 'archived' | 'deleted';

export interface ArchitectPlanRecord {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: ArchitectPlanStatus;
  targetBranch: string;
  conversationId?: string;
  projectId?: string;
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

const getPlanRoot = (branchName: string): string => `.macro/branches/${normalizeBranchName(branchName)}/plans`;
const getIndexPath = (branchName: string): string => `${getPlanRoot(branchName)}/index.json`;
const getPlanDir = (branchName: string, planId: string): string => `${getPlanRoot(branchName)}/${sanitizeId(planId)}`;
const getPlanJsonPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/plan.json`;
const getPlanMarkdownPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/plan.md`;
const getPlanNeedsPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/needs.json`;

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

const readJsonFile = async <T>(path: string): Promise<T | null> => {
  if (!tauriIpc.isTauriAvailable()) return null;
  try {
    const file = await tauriIpc.fsReadFileWithOptions({ path, allowOutsideWorkspace: false });
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
    return {
      ...plan,
      id: sanitizeId(plan.id || safeId),
      slug: slugifyPlanTitle((plan as Partial<ArchitectPlanRecord>).slug || plan.title || safeId),
      targetBranch: normalizeBranchName(plan.targetBranch || normalized),
      nodes: Array.isArray(plan.nodes) ? plan.nodes : [],
      predictedBranches: Array.isArray(plan.predictedBranches) ? plan.predictedBranches : [],
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
  if (!tauriIpc.isTauriAvailable()) {
    writeLocalPlan(normalized, plan);
    return;
  }

  const safeId = sanitizeId(plan.id);
  await writeJsonFile(getPlanJsonPath(normalized, safeId), plan);
  await tauriIpc.fsWriteFile({
    path: getPlanMarkdownPath(normalized, safeId),
    content: buildPlanMarkdown(plan),
    createDirs: true,
    allowOutsideWorkspace: false,
  });
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
    await tauriIpc.fsDelete({ path: getPlanDir(normalized, safeId), recursive: true });
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
