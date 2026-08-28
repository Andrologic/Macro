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
  it('reopens a direct checkpoint when the persisted worktree mapping is empty', async () => {
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
      tauri: {
        isTauriAvailable: () => true,
        gitWorktreeInspect,
        directCheckpointEnsure,
      },
    });

    expect(resolved).toBe('C:/projects/direct');
    expect(directCheckpointEnsure).toHaveBeenCalledWith({
      taskId: 'task-direct',
      projectPath: 'C:/projects/direct',
      checkpointId: 'task-direct-0000000000000001',
    });
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
      tauri: {
        isTauriAvailable: () => true,
        gitWorktreeInspect,
        directCheckpointEnsure,
      },
    });

    expect(resolved).toBe('C:/projects/git');
    expect(gitWorktreeInspect).not.toHaveBeenCalled();
    expect(directCheckpointEnsure).not.toHaveBeenCalled();
  });
});
