import type { PlanNode, PredictedBranch, Project, ProjectGitFlowSettings, ProjectGroup } from '../types';
import { useAppStore } from '../stores/useAppStore';
import {
  collectRenderedPlanPredictedBranchDescriptors,
  getPredictedBranchLogicalIdentity,
} from './architectBranchIdentity';
import {
  getArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanRecord,
} from './architectPlanService';
import { provisionPlanBranches, type ProvisionPlanBranchesResult } from './architectGitFlowService';
import { renderArchitectPlanIntegrationBranchName } from './architectPlanKinds';
import { resolveProjectExecutionMode } from './projectExecutionMode';

interface ArchitectScopePromotionAppState {
  projectGroups: ProjectGroup[];
  getProjectById: (projectId: string) => Project | undefined;
}

export interface PromoteArchitectTaskContextProjectsParams {
  branchName: string;
  planId: string;
  taskId: string;
  projectIds: string[];
  triggerTool?: string | null;
}

export interface PromoteArchitectTaskContextProjectsResult {
  plan: ArchitectPlanRecord;
  promotedProjectIds: string[];
  provision: ProvisionPlanBranchesResult | null;
}

export interface ArchitectScopePromotionDependencies {
  getAppState: () => ArchitectScopePromotionAppState;
  getArchitectPlan: typeof getArchitectPlan;
  updateArchitectPlan: typeof updateArchitectPlan;
  provisionPlanBranches: typeof provisionPlanBranches;
}

const unique = (items: Array<string | null | undefined>): string[] =>
  Array.from(
    new Set(
      items
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
    )
  );

const getProjectGitFlowSettings = (
  getProjectById: (projectId: string) => Project | undefined,
  projectId: string,
): ProjectGitFlowSettings | undefined => getProjectById(projectId)?.gitFlowSettings;

const createStablePredictedBranchId = (projectId: string, branchKey: string): string =>
  `branch-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${branchKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')}`;

const buildPredictedBranchesForPromotedScope = (params: {
  plan: Pick<ArchitectPlanRecord, 'slug' | 'title' | 'planKind' | 'gitFlowPlan' | 'predictedBranches'>;
  nodes: PlanNode[];
  getProjectById: (projectId: string) => Project | undefined;
}): PredictedBranch[] => {
  const planSlug = params.plan.slug || params.plan.title;
  const renderedBranches = collectRenderedPlanPredictedBranchDescriptors({
    nodes: params.nodes,
    planSlug,
    getProjectGitFlowSettings: (projectId) =>
      getProjectGitFlowSettings(params.getProjectById, projectId),
    getPlanIntegrationBranchName: (projectId) =>
      renderArchitectPlanIntegrationBranchName({
        plan: params.plan,
        projectId,
        settings: getProjectGitFlowSettings(params.getProjectById, projectId),
      }),
  });
  const nodeById = new Map(params.nodes.map((node) => [node.id, node]));
  const resolveBranchStatus = (taskIds: string[]): PredictedBranch['status'] => {
    const branchNodes = taskIds
      .map((taskId) => nodeById.get(taskId))
      .filter((node): node is PlanNode => Boolean(node));
    if (branchNodes.length > 0 && branchNodes.every((node) => node.status === 'completed')) {
      return 'merged';
    }
    if (branchNodes.some((node) => node.status === 'in-progress')) {
      return 'active';
    }
    return 'pending';
  };
  const existingByKey = new Map(
    (params.plan.predictedBranches || []).map((branch) => [
      `${branch.projectId}::${getPredictedBranchLogicalIdentity({
        planSlug,
        branch,
        settings: getProjectGitFlowSettings(params.getProjectById, branch.projectId),
      }).key}`,
      branch,
    ])
  );

  return renderedBranches.map((branch, index) => {
    const existing = existingByKey.get(branch.key);
    return {
      id: existing?.id || createStablePredictedBranchId(branch.projectId, branch.key),
      name: branch.name,
      color: existing?.color || ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'][index % 7],
      parentBranch: branch.parentBranch,
      projectId: branch.projectId,
      taskIds: unique(branch.taskIds),
      status: resolveBranchStatus(branch.taskIds),
      branchType: branch.branchType,
      branchSlug: branch.branchSlug,
    };
  });
};

const findProjectInGroups = (
  projectGroups: ProjectGroup[],
  projectId: string,
): Project | undefined =>
  projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId);

export const createArchitectScopePromotionService = (
  deps: ArchitectScopePromotionDependencies,
) => {
  const promoteTaskContextProjects = async (
    params: PromoteArchitectTaskContextProjectsParams,
  ): Promise<PromoteArchitectTaskContextProjectsResult> => {
    const requestedProjectIds = unique(params.projectIds);
    if (requestedProjectIds.length === 0) {
      const plan = await deps.getArchitectPlan(params.branchName, params.planId);
      if (!plan) {
        throw new Error(`Plan ${params.planId} is unavailable.`);
      }
      return { plan, promotedProjectIds: [], provision: null };
    }

    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || plan.status === 'deleted') {
      throw new Error(`Plan ${params.planId} is unavailable.`);
    }

    const appState = deps.getAppState();
    const actionableProjectIds = unique([...(plan.projectIds || []), plan.projectId]);
    const actionableProjectIdSet = new Set(actionableProjectIds);
    const contextProjectIds = unique(plan.contextProjectIds || []);
    const contextProjectIdSet = new Set(contextProjectIds);
    const promotedProjectIds = requestedProjectIds.filter((projectId) => !actionableProjectIdSet.has(projectId));
    const nonContextProjectIds = promotedProjectIds.filter((projectId) => !contextProjectIdSet.has(projectId));
    if (nonContextProjectIds.length > 0) {
      throw new Error(
        `Cannot promote project${nonContextProjectIds.length > 1 ? 's' : ''} ${nonContextProjectIds.join(', ')} because ${nonContextProjectIds.length > 1 ? 'they are' : 'it is'} outside this task context.`
      );
    }

    for (const projectId of promotedProjectIds) {
      const project = appState.getProjectById(projectId) || findProjectInGroups(appState.projectGroups, projectId);
      if (!project) {
        throw new Error(`Cannot promote project ${projectId}: project is not registered.`);
      }
      if (!project.path?.trim()) {
        throw new Error(`Cannot promote project ${project.name || projectId}: repository path is missing.`);
      }
      const mode = resolveProjectExecutionMode({ project }).mode;
      if (mode !== 'git' && mode !== 'direct') {
        throw new Error(`Cannot promote project ${project.name || projectId}: enable direct editing or prepare Git first.`);
      }
    }

    if (promotedProjectIds.length === 0) {
      const provision = await deps.provisionPlanBranches(plan);
      return { plan, promotedProjectIds: [], provision };
    }

    let updatedTaskFound = false;
    const nextNodes = (plan.nodes || []).map((node) => {
      if (node.id !== params.taskId) {
        return node;
      }
      updatedTaskFound = true;
      const nodeProjectIds = unique([...(node.projectIds || []), node.projectId, ...promotedProjectIds]);
      return {
        ...node,
        projectId: nodeProjectIds[0],
        projectIds: nodeProjectIds,
        executionModesByProjectId: {
          ...(node.executionModesByProjectId ?? {}),
          ...Object.fromEntries(promotedProjectIds.map((projectId) => {
            const project = appState.getProjectById(projectId) || findProjectInGroups(appState.projectGroups, projectId);
            const mode = resolveProjectExecutionMode({ project }).mode;
            if (mode !== 'git' && mode !== 'direct') {
              throw new Error(`Cannot persist execution mode for project ${projectId}.`);
            }
            return [projectId, mode];
          })),
        },
      };
    });

    if (!updatedTaskFound) {
      throw new Error(`Cannot promote context projects: task ${params.taskId} is not part of plan ${plan.id}.`);
    }

    const nextProjectIds = unique([...actionableProjectIds, ...promotedProjectIds]);
    const nextContextProjectIds = contextProjectIds.filter((projectId) => !promotedProjectIds.includes(projectId));
    const nextPredictedBranches = buildPredictedBranchesForPromotedScope({
      plan,
      nodes: nextNodes,
      getProjectById: appState.getProjectById,
    });

    const updatedPlan = await deps.updateArchitectPlan({
      branchName: params.branchName,
      planId: plan.id,
      projectId: nextProjectIds[0],
      projectIds: nextProjectIds,
      contextProjectIds: nextContextProjectIds,
      expectedProjectIds: unique([...nextProjectIds, ...nextContextProjectIds]),
      nodes: nextNodes,
      predictedBranches: nextPredictedBranches,
      setActive: true,
    });
    const provision = await deps.provisionPlanBranches(updatedPlan);

    return {
      plan: updatedPlan,
      promotedProjectIds,
      provision,
    };
  };

  return {
    promoteTaskContextProjects,
  };
};

export const promoteArchitectTaskContextProjects = (
  params: PromoteArchitectTaskContextProjectsParams,
): Promise<PromoteArchitectTaskContextProjectsResult> =>
  createArchitectScopePromotionService({
    getAppState: () => useAppStore.getState(),
    getArchitectPlan,
    updateArchitectPlan,
    provisionPlanBranches,
  }).promoteTaskContextProjects(params);
