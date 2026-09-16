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
  it.each(['absent', 'stale_registration'] as const)('rejects a cached worktree when inspection is %s', async (status) => {
    const gitWorktreeInspect = mock(async () => ({
      status, taskId: 'worktree-a', worktreePath: '/repo/missing', branchName: 'feature/a', isDirty: null,
    }));
    const result = await resolvePreparedTaskWorktreePath({
      target: { projectId: 'git', executionMode: 'git', executionKind: 'worktree',
        worktreeKey: 'worktree-a', branchName: 'feature/a' },
      branchWorktrees: { 'worktree-a': '/repo/missing' },
      getProjectById: () => ({ path: '/repo', gitSetupState: 'ready' }),
      tauri: { isTauriAvailable: () => true, gitWorktreeInspect },
    });
    expect(result).toBeNull();
    expect(gitWorktreeInspect).toHaveBeenCalledTimes(1);
  });

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

  it('resolves a legacy direct target without creating or binding its checkpoint', async () => {
    const directCheckpointEnsure = mock(async () => 'head');
    const directCheckpointResolveId = mock(async () => 'checkpoint');
    const workspaceBindManualFeatureDirectCheckpoint = mock(async () => ({} as never));
    const target = { ...directTarget, checkpointId: undefined };
    const result = await resolvePreparedTaskWorktreePath({
      taskId: 'task-direct', target, branchWorktrees: {},
      getProjectById: () => ({ path: '/direct', directEdit: true, gitSetupState: 'not_git' }),
      tauri: { isTauriAvailable: () => true, gitWorktreeInspect: mock(async () => ({} as never)),
        directCheckpointEnsure, directCheckpointResolveId, workspaceBindManualFeatureDirectCheckpoint },
    });
    expect(result).toBe('/direct');
    expect(directCheckpointEnsure).not.toHaveBeenCalled();
    expect(directCheckpointResolveId).not.toHaveBeenCalled();
    expect(workspaceBindManualFeatureDirectCheckpoint).not.toHaveBeenCalled();
    expect(target.checkpointId).toBeUndefined();
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

});
