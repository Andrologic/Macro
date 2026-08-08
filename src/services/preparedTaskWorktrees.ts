import type { TaskExecutionTarget } from '../types';
import type * as tauriIpc from './tauriIpc';

export interface PreparedTaskWorktreeProjectRef {
  path?: string | null;
}

export interface PreparedTaskWorktreeTauri {
  isTauriAvailable: () => boolean;
  gitWorktreeInspect: typeof tauriIpc.gitWorktreeInspect;
}

export const resolveTaskRepositoryPath = (
  target: TaskExecutionTarget,
  getProjectById: (projectId: string) => PreparedTaskWorktreeProjectRef | null | undefined
): string | null => {
  const projectPath = getProjectById(target.projectId)?.path;
  return projectPath || target.repoPath || null;
};

export const resolveCachedPreparedTaskWorktreePath = (
  target: TaskExecutionTarget,
  branchWorktrees: Record<string, string>
): string | null =>
  branchWorktrees[target.worktreeKey] ||
  branchWorktrees[`${target.projectId}::${target.branchName}`] ||
  branchWorktrees[target.branchName] ||
  null;

export const resolvePreparedTaskWorktreePath = async (params: {
  target: TaskExecutionTarget;
  branchWorktrees: Record<string, string>;
  getProjectById: (projectId: string) => PreparedTaskWorktreeProjectRef | null | undefined;
  tauri: PreparedTaskWorktreeTauri;
}): Promise<string | null> => {
  const cached = resolveCachedPreparedTaskWorktreePath(
    params.target,
    params.branchWorktrees
  );
  if (cached) {
    return cached;
  }

  const repoPath = resolveTaskRepositoryPath(params.target, params.getProjectById);
  if (!repoPath || !params.tauri.isTauriAvailable()) {
    return null;
  }

  try {
    const inspection = await params.tauri.gitWorktreeInspect({
      repoPath,
      taskId: params.target.worktreeKey,
      branchName: params.target.branchName,
    });

    if (inspection.status === 'ready' && inspection.worktreePath.trim().length > 0) {
      return inspection.worktreePath;
    }
  } catch {
    return null;
  }

  return null;
};
