import type { PlanNode, PredictedBranch, ProjectGitFlowSettings } from '../types';
import { collectRenderedPlanPredictedBranchDescriptors } from './architectBranchIdentity';
import { getPredictedBranchIntentKey } from './gitFlowBranchIntents';

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

  const existingByKey = new Map(
    (params.existingBranches || []).map((branch) => [
      `${branch.projectId}::${getPredictedBranchIntentKey(branch)}`,
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
      status: existing?.status || 'pending',
      branchType: branch.branchType,
      branchSlug: branch.branchSlug,
    };
  });
};
