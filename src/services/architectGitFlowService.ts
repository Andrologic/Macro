import type { PlanNode, PredictedBranch } from '../types';
import { useAppStore } from '../stores/useAppStore';
import * as tauriIpc from './tauriIpc';
import {
  deleteArchitectPlan,
  getGitFlowBaseBranch,
  getArchitectPlan,
  toPlanIntegrationBranch,
  toPlanScopedFeatureBranch,
  updateArchitectPlan,
  type ArchitectPlanRecord,
} from './architectPlanService';

const BRANCH_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

export interface ProvisionPlanBranchesResult {
  planBranchName: string;
  createdPlanBranch: boolean;
  createdFeatureBranches: string[];
  existingFeatureBranches: string[];
}

const resolveRepoPathForPlan = (projectId?: string): string | null => {
  const appState = useAppStore.getState();
  const candidateIds = [
    projectId,
    appState.selectedProjectId,
    appState.projectGroups.flatMap((group) => group.projects)[0]?.id,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const id of candidateIds) {
    const project = appState.getProjectById(id);
    if (project?.path?.trim()) {
      return project.path;
    }
  }

  return null;
};

const normalizePlanNodesForGitFlow = (plan: ArchitectPlanRecord): PlanNode[] => {
  const planSlug = plan.slug || plan.title;
  return (plan.nodes || []).map((node) => ({
    ...node,
    assignedBranch: toPlanScopedFeatureBranch(planSlug, node.assignedBranch || node.title || 'work'),
  }));
};

const buildPredictedBranchesForPlan = (
  nodes: PlanNode[],
  existingBranches: PredictedBranch[],
  planBranchName: string,
  projectId?: string
): PredictedBranch[] => {
  const branchTaskMap = new Map<string, string[]>();
  nodes.forEach((node) => {
    const branchName = node.assignedBranch || 'work';
    if (!branchTaskMap.has(branchName)) {
      branchTaskMap.set(branchName, []);
    }
    branchTaskMap.get(branchName)!.push(node.id);
  });

  const existingByName = new Map((existingBranches || []).map((branch) => [branch.name, branch]));
  return Array.from(branchTaskMap.entries()).map(([name, taskIds], index) => {
    const existing = existingByName.get(name);
    return {
      id: existing?.id || `branch-${Date.now()}-${index}`,
      name,
      color: existing?.color || BRANCH_COLORS[index % BRANCH_COLORS.length],
      parentBranch: planBranchName,
      projectId: existing?.projectId || projectId || '',
      taskIds,
      status: existing?.status || 'pending',
    };
  });
};

const resolveDevelopBaseRef = (branches: tauriIpc.GitBranchesDto): string => {
  const baseBranch = getGitFlowBaseBranch();
  const local = new Set((branches.local || []).map((branch) => branch.name));
  const remote = new Set((branches.remote || []).map((branch) => branch.name));

  if (local.has(baseBranch)) return baseBranch;
  if (remote.has(`origin/${baseBranch}`)) return `origin/${baseBranch}`;
  throw new Error(
    `Missing base branch "${baseBranch}". Create/fetch ${baseBranch} before validating this plan.`
  );
};

const ensureSafeCheckoutBeforeDeletion = async (
  repoPath: string,
  branchesToDelete: Set<string>,
  branches: tauriIpc.GitBranchesDto
): Promise<void> => {
  const status = await tauriIpc.gitStatus(repoPath);
  const current = status.branch;
  if (!branchesToDelete.has(current)) return;

  if (!status.is_clean) {
    throw new Error(
      `Cannot delete plan branches while currently on "${current}" with local changes. Commit or stash changes first.`
    );
  }

  const localNames = (branches.local || []).map((branch) => branch.name);
  const localSet = new Set(localNames);
  const fallbackCandidates = [
    getGitFlowBaseBranch(),
    'main',
    'develop',
    ...localNames.filter((name) => !branchesToDelete.has(name)),
  ];
  const fallback = fallbackCandidates.find(
    (name, index) =>
      name.trim().length > 0 &&
      fallbackCandidates.indexOf(name) === index &&
      localSet.has(name) &&
      !branchesToDelete.has(name)
  );
  if (!fallback) {
    throw new Error(`Cannot delete active branch "${current}" because no safe fallback branch is available.`);
  }

  await tauriIpc.gitCheckout({
    repoPath,
    branchOrCommit: fallback,
    create: false,
  });
};

export const provisionPlanBranches = async (
  plan: ArchitectPlanRecord,
  explicitRepoPath?: string
): Promise<ProvisionPlanBranchesResult> => {
  const planBranchName = toPlanIntegrationBranch(plan.slug || plan.title);
  const featureBranches = Array.from(
    new Set(
      (plan.nodes || [])
        .map((node) => node.assignedBranch || '')
        .filter((name) => typeof name === 'string' && name.trim().length > 0)
    )
  );

  if (!tauriIpc.isTauriAvailable()) {
    return {
      planBranchName,
      createdPlanBranch: false,
      createdFeatureBranches: [],
      existingFeatureBranches: featureBranches,
    };
  }

  const repoPath = explicitRepoPath || resolveRepoPathForPlan(plan.projectId);
  if (!repoPath) {
    throw new Error('Unable to resolve repository path for this plan. Select a project before validating the plan.');
  }

  const branches = await tauriIpc.gitBranchList(repoPath);
  const localBranchNames = new Set((branches.local || []).map((branch) => branch.name));
  const createdFeatureBranches: string[] = [];
  const existingFeatureBranches: string[] = [];

  let createdPlanBranch = false;
  if (!localBranchNames.has(planBranchName)) {
    const fromRef = resolveDevelopBaseRef(branches);
    await tauriIpc.gitBranchCreate({
      repoPath,
      branchName: planBranchName,
      fromRef,
    });
    localBranchNames.add(planBranchName);
    createdPlanBranch = true;
  }

  for (const featureBranch of featureBranches) {
    if (localBranchNames.has(featureBranch)) {
      existingFeatureBranches.push(featureBranch);
      continue;
    }

    await tauriIpc.gitBranchCreate({
      repoPath,
      branchName: featureBranch,
      fromRef: planBranchName,
    });
    localBranchNames.add(featureBranch);
    createdFeatureBranches.push(featureBranch);
  }

  return {
    planBranchName,
    createdPlanBranch,
    createdFeatureBranches,
    existingFeatureBranches,
  };
};

export const validatePlanAndProvisionBranches = async (params: {
  branchName: string;
  planId: string;
  repoPath?: string;
  setActive?: boolean;
}): Promise<{ plan: ArchitectPlanRecord; provision: ProvisionPlanBranchesResult }> => {
  const plan = await getArchitectPlan(params.branchName, params.planId);
  if (!plan || plan.status === 'deleted') {
    throw new Error(`Plan ${params.planId} is unavailable.`);
  }

  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    throw new Error('Cannot validate a plan without strategy nodes. Generate strategy first.');
  }

  const normalizedNodes = normalizePlanNodesForGitFlow(plan);
  const planBranchName = toPlanIntegrationBranch(plan.slug || plan.title);
  const normalizedPredictedBranches = buildPredictedBranchesForPlan(
    normalizedNodes,
    plan.predictedBranches || [],
    planBranchName,
    plan.projectId
  );

  const normalizedPlan: ArchitectPlanRecord = {
    ...plan,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  };

  const provision = await provisionPlanBranches(normalizedPlan, params.repoPath);

  const validatedPlan = await updateArchitectPlan({
    branchName: params.branchName,
    planId: plan.id,
    status: 'validated',
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
    setActive: params.setActive !== false,
  });

  return {
    plan: validatedPlan,
    provision,
  };
};

export const cleanupPlanBranches = async (plan: ArchitectPlanRecord, explicitRepoPath?: string): Promise<string[]> => {
  const planBranchName = toPlanIntegrationBranch(plan.slug || plan.title);
  const featureBranchNames = Array.from(
    new Set(
      [
        ...(plan.nodes || []).map((node) => node.assignedBranch || ''),
        ...(plan.predictedBranches || []).map((branch) => branch.name),
      ]
        .filter((name) => name.trim().length > 0)
        .map((name) => toPlanScopedFeatureBranch(plan.slug || plan.title, name))
    )
  );

  if (!tauriIpc.isTauriAvailable()) {
    return [...featureBranchNames, planBranchName];
  }

  const repoPath = explicitRepoPath || resolveRepoPathForPlan(plan.projectId);
  if (!repoPath) {
    throw new Error('Unable to resolve repository path for this plan. Select a project before deleting the plan.');
  }

  const branches = await tauriIpc.gitBranchList(repoPath);
  const localBranchNames = new Set((branches.local || []).map((branch) => branch.name));
  const candidates = [...featureBranchNames, planBranchName].filter((name) => localBranchNames.has(name));
  if (candidates.length === 0) {
    return [];
  }

  const toDelete = new Set(candidates);
  await ensureSafeCheckoutBeforeDeletion(repoPath, toDelete, branches);

  for (const branchName of candidates) {
    await tauriIpc.gitBranchDelete({
      repoPath,
      branchName,
      force: true,
    });
  }

  return candidates;
};

export const deletePlanAndCleanupBranches = async (params: {
  branchName: string;
  planId: string;
  hardDelete?: boolean;
  repoPath?: string;
}): Promise<{ deletedBranches: string[] }> => {
  const plan = await getArchitectPlan(params.branchName, params.planId);
  const deletedBranches = plan ? await cleanupPlanBranches(plan, params.repoPath) : [];

  await deleteArchitectPlan({
    branchName: params.branchName,
    planId: params.planId,
    hardDelete: params.hardDelete,
  });

  return { deletedBranches };
};
