import type { PredictedBranch, TaskExecutionTarget, TaskStatus } from '../types';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import { getArchitectPlanTargetBranchesByProjectId } from './architectPlanService';
import { applyTaskStatusToPlanNodes, deriveImplementTasksFromStrategy } from './implementTaskDerivation';
import { getTaskBusinessId, resolveTaskReference } from './durableIdentity';

const branchName = (value: string | undefined) => value?.trim() || 'work';
export const projectTaskBranchStatus = (
  tasks: CatalogedImplementTask[], branches: PredictedBranch[], taskId: string, status: TaskStatus,
  targets: (task: CatalogedImplementTask) => TaskExecutionTarget[],
): PredictedBranch[] => {
  const task = resolveTaskReference(tasks, taskId);
  if (!task) return branches;
  const statuses = new Map(tasks.map((candidate) => [candidate.id, candidate.id === task.id ? status : candidate.status]));
  const keys = new Set(targets(task).map((target) => `${target.projectId}::${branchName(target.branchName)}`));
  return branches.map((branch) => {
    if (!keys.has(`${branch.projectId}::${branchName(branch.name)}`)) return branch;
    if (status === 'InProgress' || status === 'AwaitingResponse' || status === 'InReview') return { ...branch, status: 'active' };
    if (status !== 'Completed') return branch;
    const related = tasks.filter((candidate) => targets(candidate).some((target) =>
      target.projectId === branch.projectId && branchName(target.branchName) === branchName(branch.name)));
    return { ...branch, status: related.every((candidate) => statuses.get(candidate.id) === 'Completed') ? 'merged' : 'active' };
  });
};

/** Call only inside the plan mutation callback so every derived array uses the locked snapshot. */
export const deriveTaskPlanStatusUpdate = (
  plan: ArchitectPlanRecord, task: CatalogedImplementTask, status: TaskStatus,
  targets: (task: CatalogedImplementTask) => TaskExecutionTarget[],
): Pick<ArchitectPlanRecord, 'nodes' | 'predictedBranches' | 'status'> => {
  const taskId = getTaskBusinessId(task);
  const targetBranchesByProjectId = getArchitectPlanTargetBranchesByProjectId(plan);
  const currentTasks: CatalogedImplementTask[] = deriveImplementTasksFromStrategy({
    planId: plan.id, planSlug: plan.slug, nodes: plan.nodes, predictedBranches: plan.predictedBranches, targetBranchesByProjectId,
  }).tasks.map((current) => ({
    ...current, task_source: 'architect', plan_title: plan.title, plan_status: plan.status,
    plan_storage_branch: plan.targetBranch, plan_target_branch: task.plan_target_branch,
    plan_target_branches_by_project_id: targetBranchesByProjectId, draft: false, standalone_kind: 'legacy',
    base_branch: null, feature_slug: null, conversation_id: null, archived_at: null, archive_reason: null, merged_at: null,
  }));
  const branches = projectTaskBranchStatus(currentTasks, plan.predictedBranches, taskId, status, targets);
  const strategy = deriveImplementTasksFromStrategy({
    planId: plan.id, planSlug: plan.slug, nodes: applyTaskStatusToPlanNodes(plan.nodes, taskId, status),
    predictedBranches: branches, targetBranchesByProjectId,
  });
  return {
    nodes: strategy.nodes, predictedBranches: strategy.predictedBranches,
    status: plan.status === 'validated' && status !== 'Pending' ? 'in_progress' : plan.status,
  };
};
