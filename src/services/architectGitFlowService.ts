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
import { normalizeNodeProjectIds, normalizeStrategyDependencies } from './implementTaskDerivation';

const BRANCH_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

export interface ProvisionedPlanRepositoryResult {
  projectId: string;
  repoPath: string;
  planBranchName: string;
  createdPlanBranch: boolean;
  createdFeatureBranches: string[];
  existingFeatureBranches: string[];
}

export interface ProvisionPlanBranchesResult {
  planBranchName: string;
  repositories: ProvisionedPlanRepositoryResult[];
  createdPlanBranch: boolean;
  createdFeatureBranches: string[];
  existingFeatureBranches: string[];
}

export interface CleanupPlanRepositoryResult {
  projectId: string;
  repoPath: string;
  deletedBranches: string[];
}

export interface FinalizedPlanRepositoryResult {
  projectId: string;
  repoPath: string;
  planBranchName: string;
  baseBranchName: string;
  mergeOutput?: string;
}

export interface PlanReviewTaskSummary {
  id: string;
  title: string;
  status: PlanNode['status'];
  branchName: string;
  projectIds: string[];
}

export interface PlanReviewRepositoryResult {
  id: string;
  projectId: string;
  repoPath: string;
  planBranchName: string;
  baseBranchName: string;
  isClean: boolean;
  hasChanges: boolean;
  mergeable: boolean;
  conflictFiles: string[];
  diff: string;
  checkStatus: 'not_run' | 'passed' | 'failed';
  blockingReason: string | null;
}

export interface PlanReviewResult {
  plan: ArchitectPlanRecord;
  tasks: PlanReviewTaskSummary[];
  repositories: PlanReviewRepositoryResult[];
}

const resolveProjectRepoPaths = (projectIds: string[], explicitRepoPath?: string): Array<{ projectId: string; repoPath: string }> => {
  const appState = useAppStore.getState();
  const resolved: Array<{ projectId: string; repoPath: string }> = [];

  for (const projectId of projectIds) {
    const project = appState.getProjectById(projectId);
    if (project?.path?.trim()) {
      resolved.push({ projectId, repoPath: project.path });
    }
  }

  if (resolved.length === 0 && explicitRepoPath) {
    const fallbackProjectId = projectIds[0] || appState.selectedProjectId || 'default-project';
    resolved.push({ projectId: fallbackProjectId, repoPath: explicitRepoPath });
  }

  return resolved;
};

const getPlanProjectIds = (plan: ArchitectPlanRecord): string[] => {
  const nodeProjectIds = (plan.nodes || []).flatMap((node) => normalizeNodeProjectIds(node));
  const branchProjectIds = (plan.predictedBranches || []).map((branch) => branch.projectId).filter(Boolean);
  return Array.from(new Set([...(plan.projectIds || []), ...(plan.projectId ? [plan.projectId] : []), ...nodeProjectIds, ...branchProjectIds]));
};

const normalizePlanNodesForGitFlow = (plan: ArchitectPlanRecord): PlanNode[] => {
  const planSlug = plan.slug || plan.title;
  return (plan.nodes || []).map((node) => {
    const projectIds = normalizeNodeProjectIds(node);
    return {
      ...node,
      assignedBranch: toPlanScopedFeatureBranch(planSlug, node.assignedBranch || node.title || 'work'),
      projectId: projectIds[0],
      projectIds,
    };
  });
};

const buildPredictedBranchesForPlan = (
  nodes: PlanNode[],
  existingBranches: PredictedBranch[],
  planBranchName: string
): PredictedBranch[] => {
  const branchTaskMap = new Map<string, { projectId: string; taskIds: string[] }>();
  nodes.forEach((node) => {
    const branchName = node.assignedBranch || 'work';
    for (const projectId of normalizeNodeProjectIds(node)) {
      const key = `${projectId}::${branchName}`;
      if (!branchTaskMap.has(key)) {
        branchTaskMap.set(key, { projectId, taskIds: [] });
      }
      branchTaskMap.get(key)!.taskIds.push(node.id);
    }
  });

  const existingByKey = new Map((existingBranches || []).map((branch) => [`${branch.projectId}::${branch.name}`, branch]));
  return Array.from(branchTaskMap.entries()).map(([key, value], index) => {
    const branchName = key.split('::')[1] || 'work';
    const existing = existingByKey.get(key);
    return {
      id: existing?.id || `branch-${value.projectId}-${Date.now()}-${index}`,
      name: branchName,
      color: existing?.color || BRANCH_COLORS[index % BRANCH_COLORS.length],
      parentBranch: planBranchName,
      projectId: value.projectId,
      taskIds: Array.from(new Set(value.taskIds)),
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
  throw new Error(`Missing base branch "${baseBranch}". Create/fetch ${baseBranch} before validating this plan.`);
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
    throw new Error(`Cannot delete plan branches while currently on "${current}" with local changes. Commit or stash changes first.`);
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

const formatMergeConflictMessage = (repositoryPath: string, conflictFiles: string[]): string => {
  if (conflictFiles.length === 0) {
    return `Cannot finalize plan because ${repositoryPath} would conflict during merge.`;
  }
  return `Cannot finalize plan because ${repositoryPath} would conflict in: ${conflictFiles.join(', ')}.`;
};

const buildPlanReviewTasks = (plan: ArchitectPlanRecord): PlanReviewTaskSummary[] => {
  return (plan.nodes || []).map((node) => ({
    id: node.id,
    title: node.title,
    status: node.status,
    branchName: node.assignedBranch || 'work',
    projectIds: normalizeNodeProjectIds(node),
  }));
};

const preflightPlanRepositories = async (params: {
  plan: ArchitectPlanRecord;
  explicitRepoPath?: string;
}): Promise<PlanReviewRepositoryResult[]> => {
  const planBranchName = toPlanIntegrationBranch(params.plan.slug || params.plan.title);
  const baseBranchName = params.plan.targetBranch || getGitFlowBaseBranch();
  const repositories = resolveProjectRepoPaths(getPlanProjectIds(params.plan), params.explicitRepoPath);

  return Promise.all(
    repositories.map(async (repository) => {
      const status = await tauriIpc.gitStatus(repository.repoPath);
      const diff = await tauriIpc.gitDiff({
        repoPath: repository.repoPath,
        base: baseBranchName,
        head: planBranchName,
        contextLines: 3,
      });

      const mergeCheck = status.is_clean
        ? await tauriIpc.gitMergeCheck({
          repoPath: repository.repoPath,
          branchName: planBranchName,
          intoBranch: baseBranchName,
        })
        : {
          mergeable: false,
          conflictFiles: [],
          hasChanges: diff.trim().length > 0,
        };

      const blockingReason = !status.is_clean
        ? `Repository ${repository.repoPath} has uncommitted changes.`
        : !mergeCheck.mergeable
          ? formatMergeConflictMessage(repository.repoPath, mergeCheck.conflictFiles)
          : null;

      return {
        id: `${repository.projectId}::${repository.repoPath}`,
        projectId: repository.projectId,
        repoPath: repository.repoPath,
        planBranchName,
        baseBranchName,
        isClean: status.is_clean,
        hasChanges: mergeCheck.hasChanges,
        mergeable: mergeCheck.mergeable,
        conflictFiles: mergeCheck.conflictFiles,
        diff,
        checkStatus: 'not_run' as const,
        blockingReason,
      };
    })
  );
};

export const provisionPlanBranches = async (
  plan: ArchitectPlanRecord,
  explicitRepoPath?: string
): Promise<ProvisionPlanBranchesResult> => {
  const planBranchName = toPlanIntegrationBranch(plan.slug || plan.title);
  const featureBranchesByProject = new Map<string, string[]>();

  for (const node of plan.nodes || []) {
    const branchName = node.assignedBranch || 'work';
    for (const projectId of normalizeNodeProjectIds(node)) {
      const existing = featureBranchesByProject.get(projectId) || [];
      if (!existing.includes(branchName)) {
        existing.push(branchName);
      }
      featureBranchesByProject.set(projectId, existing);
    }
  }

  if (!tauriIpc.isTauriAvailable()) {
    const existingFeatureBranches = Array.from(featureBranchesByProject.values()).flat();
    return {
      planBranchName,
      repositories: [],
      createdPlanBranch: false,
      createdFeatureBranches: [],
      existingFeatureBranches,
    };
  }

  const repositories = resolveProjectRepoPaths(getPlanProjectIds(plan), explicitRepoPath);
  if (repositories.length === 0) {
    throw new Error('Unable to resolve repository path for this plan. Select at least one project before validating the plan.');
  }

  const results: ProvisionedPlanRepositoryResult[] = [];
  for (const repository of repositories) {
    const branches = await tauriIpc.gitBranchList(repository.repoPath);
    const localBranchNames = new Set((branches.local || []).map((branch) => branch.name));
    const createdFeatureBranches: string[] = [];
    const existingFeatureBranches: string[] = [];

    let createdPlanBranch = false;
    if (!localBranchNames.has(planBranchName)) {
      const fromRef = resolveDevelopBaseRef(branches);
      await tauriIpc.gitBranchCreate({
        repoPath: repository.repoPath,
        branchName: planBranchName,
        fromRef,
      });
      localBranchNames.add(planBranchName);
      createdPlanBranch = true;
    }

    for (const featureBranch of featureBranchesByProject.get(repository.projectId) || []) {
      if (localBranchNames.has(featureBranch)) {
        existingFeatureBranches.push(featureBranch);
        continue;
      }

      await tauriIpc.gitBranchCreate({
        repoPath: repository.repoPath,
        branchName: featureBranch,
        fromRef: planBranchName,
      });
      localBranchNames.add(featureBranch);
      createdFeatureBranches.push(featureBranch);
    }

    results.push({
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      planBranchName,
      createdPlanBranch,
      createdFeatureBranches,
      existingFeatureBranches,
    });
  }

  return {
    planBranchName,
    repositories: results,
    createdPlanBranch: results.some((result) => result.createdPlanBranch),
    createdFeatureBranches: results.flatMap((result) => result.createdFeatureBranches),
    existingFeatureBranches: results.flatMap((result) => result.existingFeatureBranches),
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
    planBranchName
  );
  const normalizedStrategy = normalizeStrategyDependencies(normalizedNodes, normalizedPredictedBranches);
  const projectIds = getPlanProjectIds({
    ...plan,
    nodes: normalizedStrategy.nodes,
    predictedBranches: normalizedStrategy.predictedBranches,
  });

  const normalizedPlan: ArchitectPlanRecord = {
    ...plan,
    projectId: projectIds[0],
    projectIds,
    nodes: normalizedStrategy.nodes,
    predictedBranches: normalizedStrategy.predictedBranches,
  };

  const provision = await provisionPlanBranches(normalizedPlan, params.repoPath);

  const validatedPlan = await updateArchitectPlan({
    branchName: params.branchName,
    planId: plan.id,
    status: 'validated',
    nodes: normalizedPlan.nodes,
    predictedBranches: normalizedPlan.predictedBranches,
    projectId: normalizedPlan.projectId,
    setActive: params.setActive !== false,
  });

  return {
    plan: {
      ...validatedPlan,
      projectId: normalizedPlan.projectId,
      projectIds,
      nodes: normalizedPlan.nodes,
      predictedBranches: normalizedPlan.predictedBranches,
    },
    provision,
  };
};

export const mergeFeatureBranchIntoPlanBranch = async (params: {
  projectId: string;
  branchName: string;
  planBranchName: string;
  repoPath?: string;
}): Promise<string> => {
  const repository = resolveProjectRepoPaths([params.projectId], params.repoPath)[0];
  if (!repository?.repoPath) {
    throw new Error(`Unable to resolve repository path for project ${params.projectId}.`);
  }

  return tauriIpc.gitMerge({
    repoPath: repository.repoPath,
    branchName: params.branchName,
    intoBranch: params.planBranchName,
  });
};

export const loadPlanReview = async (params: {
  branchName: string;
  planId: string;
  repoPath?: string;
}): Promise<PlanReviewResult> => {
  const plan = await getArchitectPlan(params.branchName, params.planId);
  if (!plan || plan.status === 'deleted') {
    throw new Error(`Plan ${params.planId} is unavailable.`);
  }

  return {
    plan,
    tasks: buildPlanReviewTasks(plan),
    repositories: await preflightPlanRepositories({
      plan,
      explicitRepoPath: params.repoPath,
    }),
  };
};

export const finalizePlanIntoBaseBranch = async (params: {
  branchName: string;
  planId: string;
  repoPath?: string;
}): Promise<{
  plan: ArchitectPlanRecord;
  repositories: FinalizedPlanRepositoryResult[];
  cleanup: CleanupPlanRepositoryResult[];
}> => {
  const plan = await getArchitectPlan(params.branchName, params.planId);
  if (!plan || plan.status === 'deleted') {
    throw new Error(`Plan ${params.planId} is unavailable.`);
  }

  const preflightRepositories = await preflightPlanRepositories({
    plan,
    explicitRepoPath: params.repoPath,
  });

  const blockedRepository = preflightRepositories.find((repository) => repository.blockingReason);
  if (blockedRepository?.blockingReason) {
    throw new Error(blockedRepository.blockingReason);
  }

  const finalizedRepositories: FinalizedPlanRepositoryResult[] = [];
  for (const repository of preflightRepositories) {
    const mergeOutput = repository.hasChanges
      ? await tauriIpc.gitMerge({
        repoPath: repository.repoPath,
        branchName: repository.planBranchName,
        intoBranch: repository.baseBranchName,
      })
      : undefined;

    finalizedRepositories.push({
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      planBranchName: repository.planBranchName,
      baseBranchName: repository.baseBranchName,
      mergeOutput,
    });
  }

  const completedPlan = await updateArchitectPlan({
    branchName: params.branchName,
    planId: plan.id,
    status: 'completed',
    setActive: false,
  });
  const cleanup = await cleanupPlanBranches(completedPlan, params.repoPath);

  return {
    plan: completedPlan,
    repositories: finalizedRepositories,
    cleanup,
  };
};

export const cleanupPlanBranches = async (
  plan: ArchitectPlanRecord,
  explicitRepoPath?: string
): Promise<CleanupPlanRepositoryResult[]> => {
  const planBranchName = toPlanIntegrationBranch(plan.slug || plan.title);
  const repositories = resolveProjectRepoPaths(getPlanProjectIds(plan), explicitRepoPath);

  if (!tauriIpc.isTauriAvailable()) {
    return repositories.map((repository) => ({
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      deletedBranches: [],
    }));
  }

  const results: CleanupPlanRepositoryResult[] = [];
  for (const repository of repositories) {
    const featureBranchNames = Array.from(
      new Set(
        [
          ...(plan.nodes || [])
            .filter((node) => normalizeNodeProjectIds(node).includes(repository.projectId))
            .map((node) => node.assignedBranch || ''),
          ...(plan.predictedBranches || [])
            .filter((branch) => branch.projectId === repository.projectId)
            .map((branch) => branch.name),
        ]
          .filter((name) => name.trim().length > 0)
          .map((name) => toPlanScopedFeatureBranch(plan.slug || plan.title, name))
      )
    );

    const branches = await tauriIpc.gitBranchList(repository.repoPath);
    const localBranchNames = new Set((branches.local || []).map((branch) => branch.name));
    const candidates = [...featureBranchNames, planBranchName].filter((name) => localBranchNames.has(name));
    if (candidates.length === 0) {
      results.push({ projectId: repository.projectId, repoPath: repository.repoPath, deletedBranches: [] });
      continue;
    }

    const toDelete = new Set(candidates);
    await ensureSafeCheckoutBeforeDeletion(repository.repoPath, toDelete, branches);

    for (const branchName of candidates) {
      await tauriIpc.gitBranchDelete({
        repoPath: repository.repoPath,
        branchName,
        force: false,
      });
    }

    results.push({
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      deletedBranches: candidates,
    });
  }

  return results;
};

export const deletePlanAndCleanupBranches = async (params: {
  branchName: string;
  planId: string;
  hardDelete?: boolean;
  repoPath?: string;
}): Promise<{ deletedBranches: string[]; repositories: CleanupPlanRepositoryResult[] }> => {
  const plan = await getArchitectPlan(params.branchName, params.planId);
  const repositories = plan ? await cleanupPlanBranches(plan, params.repoPath) : [];

  await deleteArchitectPlan({
    branchName: params.branchName,
    planId: params.planId,
    hardDelete: params.hardDelete,
  });

  return {
    deletedBranches: repositories.flatMap((repository) => repository.deletedBranches),
    repositories,
  };
};
