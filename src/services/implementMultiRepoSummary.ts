import type { TaskExecutionTarget, TaskStatus } from '../types';

export interface MultiRepoTaskLike {
  project_id?: string;
  project_ids?: string[];
  assigned_branch: string;
  execution_targets?: TaskExecutionTarget[];
  status: TaskStatus;
}

export interface TaskRepositoryDescriptor {
  id: string;
  projectId: string;
  branchName: string;
  repoPath: string | null;
  projectName: string | null;
  label: string;
}

const unique = (items: string[]): string[] => Array.from(new Set(items.filter((item) => item.trim().length > 0)));

export const getTaskRepositoryDescriptors = (
  task: MultiRepoTaskLike,
  resolveProject?: (projectId: string) => { name?: string | null; path?: string | null } | null | undefined
): TaskRepositoryDescriptor[] => {
  const executionTargets = task.execution_targets?.length
    ? task.execution_targets
    : unique([
      ...(Array.isArray(task.project_ids) ? task.project_ids : []),
      ...(task.project_id ? [task.project_id] : []),
    ]).map((projectId) => ({
      projectId,
      branchName: task.assigned_branch,
      worktreeKey: `${projectId}:${task.assigned_branch}`,
      repoPath: undefined,
    }));

  return executionTargets.map((target) => {
    const project = resolveProject?.(target.projectId) ?? null;
    const projectName = typeof project?.name === 'string' && project.name.trim().length > 0
      ? project.name.trim()
      : null;
    return {
      id: `${target.projectId}:${target.branchName}`,
      projectId: target.projectId,
      branchName: target.branchName,
      repoPath: target.repoPath ?? project?.path ?? null,
      projectName,
      label: projectName || target.projectId,
    };
  });
};
