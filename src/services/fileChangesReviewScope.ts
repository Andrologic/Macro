import type { TaskExecutionTarget } from '../types';
import { toBranchWorktreeKey } from './implementTaskDerivation';

export interface FileChangesTaskLike {
  project_id?: string | null;
  assigned_branch: string;
  task_source?: string | null;
  execution_targets?: TaskExecutionTarget[];
}

export interface FileChangesRepositoryLike {
  id: string;
  commitState: string;
}

export const buildFileChangesRepositoryId = (
  target: Pick<TaskExecutionTarget, 'projectId' | 'worktreeKey'>
): string => `${target.projectId}::${target.worktreeKey}`;

export const getFileChangesExecutionTargets = (
  task: FileChangesTaskLike,
  getGitFlowBaseBranch?: () => string
): TaskExecutionTarget[] => {
  if (task.execution_targets?.length) {
    return task.execution_targets;
  }

  if (!task.project_id) {
    return [];
  }

  return [{
    projectId: task.project_id,
    branchName: task.assigned_branch,
    worktreeKey: toBranchWorktreeKey(task.project_id, task.assigned_branch),
    planBranchName:
      task.task_source === 'standalone' ? getGitFlowBaseBranch?.() : undefined,
  }];
};

export const getFileChangesTaskRepositoryIds = (
  task: FileChangesTaskLike,
  options?: {
    fallbackRepositoryIds?: string[];
    getGitFlowBaseBranch?: () => string;
  }
): string[] => {
  const repositoryIds = getFileChangesExecutionTargets(
    task,
    options?.getGitFlowBaseBranch
  ).map((target) => buildFileChangesRepositoryId(target));

  if (repositoryIds.length > 0) {
    return Array.from(new Set(repositoryIds));
  }

  return Array.from(new Set(options?.fallbackRepositoryIds ?? []));
};

export const getResolvedFileChangesRepositoryIds = <T>(
  repositories: FileChangesRepositoryLike[],
  executionRecords: Record<string, T>
): Set<string> =>
  new Set([
    ...Object.keys(executionRecords),
    ...repositories
      .filter(
        (repository) =>
          repository.commitState === 'committed' ||
          repository.commitState === 'no_changes'
      )
      .map((repository) => repository.id),
  ]);

export const areAllFileChangesRepositoriesResolved = <T>(params: {
  task: FileChangesTaskLike;
  repositories: FileChangesRepositoryLike[];
  executionRecords: Record<string, T>;
  fallbackRepositoryIds?: string[];
  getGitFlowBaseBranch?: () => string;
}): boolean => {
  const targetRepositoryIds = getFileChangesTaskRepositoryIds(params.task, {
    fallbackRepositoryIds: params.fallbackRepositoryIds,
    getGitFlowBaseBranch: params.getGitFlowBaseBranch,
  });

  if (targetRepositoryIds.length === 0) {
    return false;
  }

  const resolvedRepositoryIds = getResolvedFileChangesRepositoryIds(
    params.repositories,
    params.executionRecords
  );

  return targetRepositoryIds.every((repositoryId) =>
    resolvedRepositoryIds.has(repositoryId)
  );
};
