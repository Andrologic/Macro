import type { TaskExecutionTarget } from '../types';
import { toBranchWorktreeKey } from './implementTaskDerivation';

export interface FileChangesTaskLike {
  project_id?: string | null;
  assigned_branch: string;
  task_source?: string | null;
  execution_targets?: TaskExecutionTarget[];
}

export const getFileChangesExecutionTargets = (
  task: FileChangesTaskLike,
  getGitFlowBaseBranch?: () => string
): TaskExecutionTarget[] => {
  if (task.task_source === 'agsdl') return [];
  if (task.execution_targets?.length) {
    return task.execution_targets;
  }

  if (!task.project_id) {
    return [];
  }

  return [{
    projectId: task.project_id,
    branchName: task.assigned_branch,
    executionKind: 'worktree',
    worktreeKey: toBranchWorktreeKey(task.project_id, task.assigned_branch),
    planBranchName:
      task.task_source === 'standalone' ? getGitFlowBaseBranch?.() : undefined,
  }];
};
