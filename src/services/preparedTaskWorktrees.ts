import type { Project, TaskExecutionTarget } from '../types';
import type * as tauriIpc from './tauriIpc';
import { isReviewSuspendingError, toServiceError } from './contracts/errors';
import { resolveProjectExecutionMode } from './projectExecutionMode';

export interface PreparedTaskWorktreeProjectRef {
  path?: string | null;
  directEdit?: boolean;
  gitSetupState?: Project['gitSetupState'];
}

export interface PreparedTaskWorktreeTauri {
  isTauriAvailable: () => boolean;
  gitWorktreeInspect: typeof tauriIpc.gitWorktreeInspect;
  directCheckpointEnsure?: typeof tauriIpc.directCheckpointEnsure;
  directCheckpointResolveId?: typeof tauriIpc.directCheckpointResolveId;
  workspaceBindManualFeatureDirectCheckpoint?:
    typeof tauriIpc.workspaceBindManualFeatureDirectCheckpoint;
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
  taskId?: string;
  branchWorktrees: Record<string, string>;
  getProjectById: (projectId: string) => PreparedTaskWorktreeProjectRef | null | undefined;
  tauri: PreparedTaskWorktreeTauri;
}): Promise<string | null> => {
  const project = params.getProjectById(params.target.projectId);
  const repoPath = project?.path || params.target.repoPath || null;
  if (!repoPath || !params.tauri.isTauriAvailable()) {
    return null;
  }

  try {
    const resolution = resolveProjectExecutionMode({
      project: project
        ? {
            id: params.target.projectId,
            ...project,
            path: project.path ?? repoPath,
          }
        : null,
      target: params.target,
    });
    if (resolution.mode === 'direct') {
      if (params.target.checkpointId) {
        return repoPath;
      }
      if (
        !params.taskId ||
        !params.tauri.directCheckpointEnsure ||
        !params.tauri.directCheckpointResolveId ||
        !params.tauri.workspaceBindManualFeatureDirectCheckpoint
      ) {
        return null;
      }
      const checkpointId = await params.tauri.directCheckpointResolveId({
        taskId: params.taskId,
        projectPath: repoPath,
      });
      await params.tauri.directCheckpointEnsure({
        taskId: params.taskId,
        projectPath: repoPath,
        checkpointId,
      });
      await params.tauri.workspaceBindManualFeatureDirectCheckpoint({
        taskId: params.taskId,
        projectId: params.target.projectId,
        checkpointId,
      });
      params.target.executionMode = 'direct';
      params.target.checkpointId = checkpointId;
      return repoPath;
    }
    if (resolution.mode !== 'git') {
      return null;
    }

    if (params.target.executionKind === 'repository_root') {
      return repoPath;
    }

    const cached = resolveCachedPreparedTaskWorktreePath(
      params.target,
      params.branchWorktrees
    );
    if (cached) {
      return cached;
    }

    const inspection = await params.tauri.gitWorktreeInspect({
      repoPath,
      taskId: params.target.worktreeKey,
      branchName: params.target.branchName,
    });

    if (inspection.status === 'ready' && inspection.worktreePath.trim().length > 0) {
      return inspection.worktreePath;
    }
  } catch (error) {
    const normalized = toServiceError(error);
    if (isReviewSuspendingError(normalized)) {
      const details = normalized.details && typeof normalized.details === 'object' &&
        !Array.isArray(normalized.details)
        ? normalized.details as Record<string, unknown>
        : { cause: normalized.details ?? null };
      throw {
        ...normalized,
        details: {
          ...details,
          reviewProjectId: params.target.projectId,
        },
      };
    }
    return null;
  }

  return null;
};
