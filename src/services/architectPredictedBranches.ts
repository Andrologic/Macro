import type { PlanNode, PredictedBranch, ProjectGitFlowSettings } from '../types';
import {
  collectRenderedPlanPredictedBranchDescriptors,
  getPredictedBranchLogicalIdentity,
} from './architectBranchIdentity';

const BRANCH_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

export const buildArchitectPredictedBranches = (params: {
  nodes: PlanNode[];
  planSlug: string;
  existingBranches?: PredictedBranch[];
  getProjectGitFlowSettings: (projectId: string) => ProjectGitFlowSettings | undefined;
}): PredictedBranch[] => {
  const renderedBranches = collectRenderedPlanPredictedBranchDescriptors({
    nodes: params.nodes,
    planSlug: params.planSlug,
    getProjectGitFlowSettings: params.getProjectGitFlowSettings,
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
    (params.existingBranches || []).map((branch) => [
      `${branch.projectId}::${getPredictedBranchLogicalIdentity({
        planSlug: params.planSlug,
        branch,
        settings: params.getProjectGitFlowSettings(branch.projectId),
      }).key}`,
      branch,
    ])
  );

  return renderedBranches.map((branch, index) => {
    const existing = existingByKey.get(branch.key);
    return {
      id: existing?.id || `branch-${branch.projectId}-${Date.now()}-${index}`,
      name: branch.name,
      color: existing?.color || BRANCH_COLORS[index % BRANCH_COLORS.length],
      parentBranch: branch.parentBranch,
      projectId: branch.projectId,
      taskIds: Array.from(new Set(branch.taskIds)),
      status: resolveBranchStatus(branch.taskIds),
      branchType: branch.branchType,
      branchSlug: branch.branchSlug,
    };
  });
};
