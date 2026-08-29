import { describe, expect, it, mock } from 'bun:test';
import type { TaskExecutionTarget } from '../types';
import { resolvePreparedTaskWorktreePath } from './preparedTaskWorktrees';

const directTarget: TaskExecutionTarget = {
  projectId: 'project-direct',
  branchName: 'direct',
  executionMode: 'direct',
  checkpointId: 'task-direct-0000000000000001',
  worktreeKey: 'project-direct::direct',
  executionKind: 'worktree',
  repoPath: 'C:/projects/direct',
};

describe('resolvePreparedTaskWorktreePath', () => {
  it('uses a persisted direct checkpoint without revalidating it before every snapshot', async () => {
    const directCheckpointEnsure = mock(async () => 'checkpoint-head');
    const gitWorktreeInspect = mock(async () => ({
      status: 'absent' as const,
      taskId: 'project-direct::direct',
      worktreePath: '',
      branchName: 'direct',
      isDirty: null,
    }));

    const resolved = await resolvePreparedTaskWorktreePath({
      taskId: 'task-direct',
      target: directTarget,
      branchWorktrees: {},
      getProjectById: () => ({
        path: 'C:/projects/direct',
        directEdit: false,
        gitSetupState: 'ready',
      }),
      tauri: { isTauriAvailable: () => true, gitWorktreeInspect, directCheckpointEnsure },
    });

    expect(resolved).toBe('C:/projects/direct');
    expect(directCheckpointEnsure).not.toHaveBeenCalled();
    expect(gitWorktreeInspect).not.toHaveBeenCalled();
  });

  it('uses the repository root for a Direct Git target without inspecting a worktree', async () => {
    const gitWorktreeInspect = mock(async () => ({
      status: 'absent' as const,
      taskId: 'root-target',
      worktreePath: '',
      branchName: 'develop',
      isDirty: null,
    }));
    const directCheckpointEnsure = mock(async () => 'checkpoint-head');

    const resolved = await resolvePreparedTaskWorktreePath({
      taskId: 'task-direct-git',
      target: {
        projectId: 'project-git',
        branchName: 'develop',
        executionMode: 'git',
        executionKind: 'repository_root',
        baseCommitHash: 'abc123',
        worktreeKey: 'root-target',
      },
      branchWorktrees: {},
      getProjectById: () => ({
        path: 'C:/projects/git',
        directEdit: false,
        gitSetupState: 'ready',
      }),
      tauri: { isTauriAvailable: () => true, gitWorktreeInspect, directCheckpointEnsure },
    });

    expect(resolved).toBe('C:/projects/git');
    expect(gitWorktreeInspect).not.toHaveBeenCalled();
    expect(directCheckpointEnsure).not.toHaveBeenCalled();
  });

  it('derives a missing checkpoint id for a legacy direct target without using Git', async () => {
    const directCheckpointEnsure = mock(async () => 'checkpoint-head');
    const directCheckpointResolveId = mock(async () => 'task-direct-0000000000000001');
    const workspaceBindManualFeatureDirectCheckpoint = mock(async () => ({} as never));
    const gitWorktreeInspect = mock(async () => ({
      status: 'absent' as const,
      taskId: 'project-direct::direct',
      worktreePath: '',
      branchName: 'direct',
      isDirty: null,
    }));

    const legacyTarget: TaskExecutionTarget = {
      ...directTarget,
      executionMode: undefined,
      checkpointId: undefined,
    };
    const resolved = await resolvePreparedTaskWorktreePath({
      taskId: 'task-direct',
      target: legacyTarget,
      branchWorktrees: {},
      getProjectById: () => ({
        path: 'C:/projects/direct',
        directEdit: true,
        gitSetupState: 'not_git',
      }),
      tauri: {
        isTauriAvailable: () => true,
        gitWorktreeInspect,
        directCheckpointEnsure,
        directCheckpointResolveId,
        workspaceBindManualFeatureDirectCheckpoint,
      },
    });

    expect(resolved).toBe('C:/projects/direct');
    expect(directCheckpointEnsure).toHaveBeenCalledWith({
      taskId: 'task-direct',
      projectPath: 'C:/projects/direct',
      checkpointId: 'task-direct-0000000000000001',
    });
    expect(workspaceBindManualFeatureDirectCheckpoint).toHaveBeenCalledWith({
      taskId: 'task-direct',
      projectId: 'project-direct',
      checkpointId: 'task-direct-0000000000000001',
    });
    expect(legacyTarget.checkpointId).toBe('task-direct-0000000000000001');
    expect(legacyTarget.executionMode).toBe('direct');
    await resolvePreparedTaskWorktreePath({
      taskId: 'task-direct',
      target: legacyTarget,
      branchWorktrees: {},
      getProjectById: () => ({
        path: 'C:/projects/direct',
        directEdit: true,
        gitSetupState: 'not_git',
      }),
      tauri: {
        isTauriAvailable: () => true,
        gitWorktreeInspect,
        directCheckpointEnsure,
        directCheckpointResolveId,
        workspaceBindManualFeatureDirectCheckpoint,
      },
    });
    expect(directCheckpointResolveId).toHaveBeenCalledTimes(1);
    expect(directCheckpointEnsure).toHaveBeenCalledTimes(1);
    expect(workspaceBindManualFeatureDirectCheckpoint).toHaveBeenCalledTimes(1);
    expect(gitWorktreeInspect).not.toHaveBeenCalled();
  });

  it('does not create a checkpoint for a direct target whose project is unavailable', async () => {
    const directCheckpointResolveId = mock(async () => 'task-direct-0000000000000001');
    const directCheckpointEnsure = mock(async () => 'checkpoint-head');
    const bindCheckpoint = mock(async () => ({} as never));

    const resolved = await resolvePreparedTaskWorktreePath({
      taskId: 'task-direct',
      target: { ...directTarget, checkpointId: undefined },
      branchWorktrees: {},
      getProjectById: () => undefined,
      tauri: {
        isTauriAvailable: () => true,
        gitWorktreeInspect: mock(async () => ({
          status: 'absent' as const,
          taskId: 'project-direct::direct',
          worktreePath: '',
          branchName: 'direct',
          isDirty: null,
        })),
        directCheckpointResolveId,
        directCheckpointEnsure,
        workspaceBindManualFeatureDirectCheckpoint: bindCheckpoint,
      },
    });

    expect(resolved).toBeNull();
    expect(directCheckpointResolveId).not.toHaveBeenCalled();
    expect(directCheckpointEnsure).not.toHaveBeenCalled();
    expect(bindCheckpoint).not.toHaveBeenCalled();
  });

  it('does not inspect Git for a confirmed non-Git project with stale target metadata', async () => {
    const directCheckpointEnsure = mock(async () => 'checkpoint-head');
    const gitWorktreeInspect = mock(async () => ({
      status: 'absent' as const,
      taskId: 'project-direct::direct',
      worktreePath: '',
      branchName: 'direct',
      isDirty: null,
    }));

    const resolved = await resolvePreparedTaskWorktreePath({
      taskId: 'task-direct',
      target: { ...directTarget, executionMode: 'git', checkpointId: undefined },
      branchWorktrees: {
        'project-direct::direct': 'C:/projects/direct/.git-worktrees/stale',
      },
      getProjectById: () => ({
        path: 'C:/projects/direct',
        directEdit: false,
        gitSetupState: 'not_git',
      }),
      tauri: {
        isTauriAvailable: () => true,
        gitWorktreeInspect,
        directCheckpointEnsure,
      },
    });

    expect(resolved).toBeNull();
    expect(directCheckpointEnsure).not.toHaveBeenCalled();
    expect(gitWorktreeInspect).not.toHaveBeenCalled();
  });

  it('preserves a structured checkpoint failure while resolving a legacy target', async () => {
    const directCheckpointResolveId = mock(async () => {
      throw {
        code: 'DIRECT_CHECKPOINT_CORRUPT',
        message: "Macro's internal review checkpoint is incomplete.",
        details: { checkpointId: 'task-direct-0000000000000001' },
      };
    });
    const gitWorktreeInspect = mock(async () => ({
      status: 'absent' as const,
      taskId: 'project-direct::direct',
      worktreePath: '',
      branchName: 'direct',
      isDirty: null,
    }));

    await expect(resolvePreparedTaskWorktreePath({
      taskId: 'task-direct',
      target: { ...directTarget, checkpointId: undefined },
      branchWorktrees: {},
      getProjectById: () => ({
        path: 'C:/projects/direct',
        directEdit: true,
        gitSetupState: 'not_git',
      }),
      tauri: {
        isTauriAvailable: () => true,
        gitWorktreeInspect,
        directCheckpointEnsure: mock(async () => 'checkpoint-head'),
        directCheckpointResolveId,
        workspaceBindManualFeatureDirectCheckpoint: mock(async () => ({} as never)),
      },
    })).rejects.toMatchObject({
      code: 'DIRECT_CHECKPOINT_CORRUPT',
      details: {
        checkpointId: 'task-direct-0000000000000001',
        reviewProjectId: 'project-direct',
      },
    });
    expect(gitWorktreeInspect).not.toHaveBeenCalled();
  });

  it('does not bind a legacy identity when checkpoint initialization fails', async () => {
    const initializationError = {
      code: 'DIRECT_CHECKPOINT_CORRUPT',
      message: 'Macro could not initialize its internal review checkpoint.',
      details: {
        checkpointId: 'task-direct-0000000000000001',
        operation: 'direct_checkpoint_init_tree_write',
        acceptedHistoryAtRisk: false,
      },
    };
    const bindCheckpoint = mock(async () => ({} as never));
    const target: TaskExecutionTarget = { ...directTarget, checkpointId: undefined };

    await expect(resolvePreparedTaskWorktreePath({
      taskId: 'task-direct',
      target,
      branchWorktrees: {},
      getProjectById: () => ({
        path: 'C:/projects/direct',
        directEdit: true,
        gitSetupState: 'not_git',
      }),
      tauri: {
        isTauriAvailable: () => true,
        gitWorktreeInspect: mock(async () => ({
          status: 'absent' as const,
          taskId: 'project-direct::direct',
          worktreePath: '',
          branchName: 'direct',
          isDirty: null,
        })),
        directCheckpointResolveId: mock(async () => 'task-direct-0000000000000001'),
        directCheckpointEnsure: mock(async () => { throw initializationError; }),
        workspaceBindManualFeatureDirectCheckpoint: bindCheckpoint,
      },
    })).rejects.toMatchObject({
      ...initializationError,
      details: {
        ...initializationError.details,
        reviewProjectId: 'project-direct',
      },
    });

    expect(bindCheckpoint).not.toHaveBeenCalled();
    expect(target.checkpointId).toBeUndefined();
  });
});
