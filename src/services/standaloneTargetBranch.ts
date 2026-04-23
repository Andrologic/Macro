import { getGitFlowBaseBranch, resolveTargetBranch } from './architectPlanService';

type StandaloneTaskTargetLike = {
  task_source?: string | null;
  base_branch?: string | null;
};

type StandaloneExecutionTargetLike = {
  targetBranchName?: string | null;
};

const normalizeBranchCandidate = (value?: string | null): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

export const resolveStandaloneTargetBranchName = (
  task: StandaloneTaskTargetLike,
  target?: StandaloneExecutionTargetLike | null,
  options?: { fallbackToGlobalBaseBranch?: boolean }
): string | null => {
  if (task.task_source !== 'standalone') {
    return null;
  }

  const rawBranchName =
    normalizeBranchCandidate(target?.targetBranchName) ||
    normalizeBranchCandidate(task.base_branch) ||
    (options?.fallbackToGlobalBaseBranch === false
      ? null
      : getGitFlowBaseBranch());

  return rawBranchName ? resolveTargetBranch(rawBranchName) : null;
};
